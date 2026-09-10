//  DetourCalculator.swift
//  Holt die Umwege für Stationen ohne einen, in drei Matrizen.
//
//  Gegenstück zu berechneUmwege() in tools/tomtom-probe.mjs. Die Rechnung
//  selbst steht in DetourMatrix; hier ist nur der Ablauf: aufteilen, anfragen,
//  zurückschreiben.

import CoreLocation
import Foundation

struct DetourCalculator {
    let api: TomTomAPIClient
    /// Pause zwischen zwei Anfragen, wie bei der Suche. TomTom deckelt die
    /// Anfragen pro Sekunde und meldet das als 401.
    var requestInterval: Duration = .milliseconds(300)

    struct Outcome {
        /// Umweg in Sekunden je Stations-ID. Fehlt eine Station, hat die
        /// Matrix für sie keine Route gefunden.
        let detourSeconds: [String: Double]
        let requestCount: Int
        let cellCount: Int
    }

    /// Rechnet den Umweg für jede Station, deren Lage entlang der Route
    /// bekannt ist.
    ///
    /// `routeDurationSeconds` ist nur der Notnagel für Abschnitte, für die die
    /// Matrix nichts liefert: Die anteilige Zeit ist ungenau, aber besser als
    /// kein Wert.
    func detours(
        for stations: [ChargingStation],
        routeGeometry: [CLLocationCoordinate2D],
        routeDurationSeconds: Double?
    ) async throws -> Outcome {
        let supports = DetourMatrix.supportPoints(along: routeGeometry)
        guard supports.count >= 2 else {
            return Outcome(detourSeconds: [:], requestCount: 0, cellCount: 0)
        }

        let work = stations.filter { $0.progressAlongRouteMeters != nil }
        guard !work.isEmpty else {
            return Outcome(detourSeconds: [:], requestCount: 0, cellCount: 0)
        }
        let brackets = work.map {
            DetourMatrix.bracket(supports, progressMeters: $0.progressAlongRouteMeters ?? 0)
        }

        var requestCount = 0
        var cellCount = 0

        /// Eine Richtung: Stützpunkte gegen Ziele, oder Ziele gegen Stützpunkte.
        ///
        /// Liefert je Eintrag die Sekunden, in derselben Reihenfolge wie
        /// `supportOf` und `targets`. Über Indizes, nicht über Objekte: Die
        /// JS-Fassung hat einmal in Kopien geschrieben, und nichts kam an.
        func direction(
            supportOf: [Int],
            targets: [CLLocationCoordinate2D],
            supportIsOrigin: Bool
        ) async throws -> [Double?] {
            var seconds = [Double?](repeating: nil, count: targets.count)

            for block in DetourMatrix.blocks(supportOf: supportOf) {
                let supportCoordinates = block.supports.map { supports[$0].coordinate }
                let targetCoordinates = block.entries.map { targets[$0] }

                if requestCount > 0 {
                    try? await Task.sleep(for: requestInterval)
                }
                try Task.checkCancellation()
                requestCount += 1
                cellCount += supportCoordinates.count * targetCoordinates.count

                let table: [[Double?]]
                if supportIsOrigin {
                    table = try await api.travelTimeMatrix(
                        origins: supportCoordinates, destinations: targetCoordinates
                    )
                } else {
                    table = try await api.travelTimeMatrix(
                        origins: targetCoordinates, destinations: supportCoordinates
                    )
                }

                for (j, entry) in block.entries.enumerated() {
                    guard let i = block.supports.firstIndex(of: supportOf[entry]) else { continue }
                    seconds[entry] = supportIsOrigin ? table[i][j] : table[j][i]
                }
            }
            return seconds
        }

        let stationCoordinates = work.map(\.coordinate)
        let outbound = try await direction(
            supportOf: brackets.map(\.before),
            targets: stationCoordinates,
            supportIsOrigin: true
        )
        let inbound = try await direction(
            supportOf: brackets.map(\.after),
            targets: stationCoordinates,
            supportIsOrigin: false
        )

        // Die Zeit, die man ohnehin gefahren wäre, aus derselben Matrix.
        let segments = DetourMatrix.segments(brackets)
        let segmentSeconds = try await direction(
            supportOf: segments.map(\.before),
            targets: segments.map { supports[$0.after].coordinate },
            supportIsOrigin: true
        )
        var alongBySegment: [DetourMatrix.Bracket: Double] = [:]
        for (segment, seconds) in zip(segments, segmentSeconds) {
            if let seconds { alongBySegment[segment] = seconds }
        }

        var result: [String: Double] = [:]
        for (index, station) in work.enumerated() {
            let bracket = brackets[index]
            let along = alongBySegment[bracket] ?? proportional(
                supports, bracket: bracket, routeDurationSeconds: routeDurationSeconds
            )
            if let detour = DetourMatrix.detourSeconds(
                outbound: outbound[index], inbound: inbound[index], along: along
            ) {
                result[station.id] = detour
            }
        }

        return Outcome(detourSeconds: result, requestCount: requestCount, cellCount: cellCount)
    }

    /// Der Notnagel: Abschnittszeit anteilig nach Strecke.
    private func proportional(
        _ supports: [DetourMatrix.SupportPoint],
        bracket: DetourMatrix.Bracket,
        routeDurationSeconds: Double?
    ) -> Double? {
        guard let routeDurationSeconds, let total = supports.last?.progressMeters, total > 0 else {
            return nil
        }
        let meters = supports[bracket.after].progressMeters - supports[bracket.before].progressMeters
        return meters / total * routeDurationSeconds
    }
}
