//  DetourCalculator.swift
//  Holt die Umwege je Station als Route mit Zwischenziel.
//
//  Gegenstück zu tools/lib/umwege.mjs. Der Nachfolger der Matrix-Rechnung,
//  und der Grund ist das Kontingent: Die Matrix hat im Freemium 2.500 Zellen
//  im Monat, die Routing API 20.000 Anfragen. Eine Route mit Zwischenziel
//  rechnet außerdem exakt, was ein Navi beim Umrouten über die Station
//  ansagen würde. Am 29.09.2026 gegen TomToms eigene Umwege geprüft: In der
//  Stadt gleichauf, an Raststätten und bei Anlagen auf der Gegenfahrbahn
//  besser, weil die Route weiß, auf welcher Seite der Autobahn man fährt.
//
//  Das Verfahren:
//    1. Auf der Route alle 50 km einen Stützpunkt setzen (DetourMatrix).
//    2. Für jede Station den Stützpunkt davor und den dahinter.
//    3. Eine Route davor, Station, dahinter, und je Abschnitt einmal die
//       Route davor, dahinter.
//    4. Umweg = Fahrzeit über die Station minus Fahrzeit des Abschnitts.
//
//  Kosten: eine Anfrage je Station plus eine je Abschnitt. 67 Standorte auf
//  320 km sind 74 Anfragen, gut dreißig Sekunden bei 300 ms Abstand.

import CoreLocation
import Foundation

struct DetourCalculator {
    let api: TomTomAPIClient
    /// Pause zwischen zwei Anfragen. TomTom deckelt die Anfragen pro Sekunde
    /// und meldet das als 401.
    var requestInterval: Duration = .milliseconds(300)

    struct Outcome {
        /// Umweg in Sekunden je Stations-ID. Fehlt eine Station, hat die
        /// Anfrage für sie nichts geliefert.
        let detourSeconds: [String: Double]
        let requestCount: Int
        let failureCount: Int
    }

    /// Rechnet den Umweg für jede Station, deren Lage entlang der Route
    /// bekannt ist, in Fahrtrichtung.
    ///
    /// Die Grundstrecken zuerst: Scheitert eine, sind alle Stationen des
    /// Abschnitts ohne Wert, das soll früh auffallen. `progress` meldet nach
    /// jeder Station, damit die Liste zeigen kann, wie weit es ist.
    func detours(
        for stations: [ChargingStation],
        routeGeometry: [CLLocationCoordinate2D],
        progress: (@MainActor @Sendable (Int, Int) -> Void)? = nil
    ) async throws -> Outcome {
        let supports = DetourMatrix.supportPoints(along: routeGeometry)
        let work = stations.filter { $0.progressAlongRouteMeters != nil }
        guard supports.count >= 2, !work.isEmpty else {
            return Outcome(detourSeconds: [:], requestCount: 0, failureCount: 0)
        }

        let brackets = work.map {
            DetourMatrix.bracket(supports, progressMeters: $0.progressAlongRouteMeters ?? 0)
        }

        var requestCount = 0
        var failureCount = 0

        func travelTime(_ points: [CLLocationCoordinate2D]) async throws -> Double {
            if requestCount > 0 {
                try? await Task.sleep(for: requestInterval)
            }
            try Task.checkCancellation()
            requestCount += 1
            return try await api.travelTimeSeconds(via: points)
        }

        // Die Zeit, die man ohnehin gefahren wäre, je Abschnitt einmal.
        var baseline: [DetourMatrix.Bracket: Double] = [:]
        for segment in DetourMatrix.segments(brackets) {
            do {
                baseline[segment] = try await travelTime(
                    [supports[segment.before].coordinate, supports[segment.after].coordinate]
                )
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                failureCount += 1
            }
        }

        var result: [String: Double] = [:]
        for (index, station) in work.enumerated() {
            let bracket = brackets[index]
            guard let base = baseline[bracket] else { continue }

            do {
                let viaStation = try await travelTime([
                    supports[bracket.before].coordinate,
                    station.coordinate,
                    supports[bracket.after].coordinate,
                ])
                // Negatives ist Rauschen: Die Route über die Station kann
                // nicht kürzer sein als die ohne. Wird auf null gesetzt.
                result[station.id] = max(0, viaStation - base)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                failureCount += 1
            }
            await progress?(index + 1, work.count)
        }

        return Outcome(detourSeconds: result, requestCount: requestCount, failureCount: failureCount)
    }
}
