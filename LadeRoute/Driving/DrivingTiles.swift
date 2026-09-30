//  DrivingTiles.swift
//  Welche Ladestationen in den drei Kacheln der Fahransicht stehen.
//
//  Gegenstück zu kacheln() in tools/lib/fahrt.mjs, die Tests dort sind der
//  Maßstab. Regeln aus dem Konzept: höchstens drei, nur was vor dem Auto
//  liegt, Stationen innerhalb von 2 km zu einer Kachel gebündelt (es zählt die
//  mit dem kleinsten Umweg, ein geplanter Stopp geht vor), und eine Linie der
//  Reichweite dort, wo die Reserve erreicht ist.

import Foundation

struct DrivingTile: Identifiable, Equatable {
    let station: AnnotatedStation
    /// Strecke bis zur Säule: auf der Route bis zur Abfahrt plus Zugang.
    let meters: Double
    /// Ladestand bei Ankunft, Prozent.
    let arrivalPercent: Double
    let isReachable: Bool
    let isPlannedStop: Bool
    /// Weitere Stationen an derselben Stelle, in dieser Kachel zusammengefasst.
    let moreHere: Int

    var id: String { station.id }
}

/// Warum die Ausweichzeile diese Station vorschlägt.
enum FallbackReason: Equatable {
    /// Ein anderer Anbieter mit der gewünschten Leistung.
    case otherProvider
    /// Ein Favorit, aber mit weniger Leistung.
    case lowerPower
    /// Ein anderer Anbieter mit weniger Leistung.
    case otherProviderLowerPower
}

/// Kacheln und, wenn es knapp wird, eine Ausweichstation.
struct DrivingTileSet: Equatable {
    var tiles: [DrivingTile] = []
    var fallback: DrivingTile?
    var fallbackReason: FallbackReason?
}

enum DrivingTiles {
    /// Kacheln mit Favoriten, und eine Ausweichzeile, wenn es knapp wird.
    ///
    /// Gegenstück zu kachelnMitFavoriten() in tools/lib/fahrt.mjs, die Tests
    /// dort sind der Maßstab. Knapp wird es, wenn die nächste Kachel hinter
    /// der Reserve liegt oder gar keine mehr kommt. Dann sucht die Zeile in
    /// dieser Reihenfolge, und die erste Stufe mit einem Treffer gewinnt:
    ///
    ///   1. andere Anbieter mit der gewünschten Leistung
    ///   2. Favoriten mit weniger Leistung (lowerPower, ab 150 kW)
    ///   3. irgendein Anbieter mit weniger Leistung
    ///
    /// Ohne Favoriten entfällt Stufe 1, und 2 und 3 fallen zusammen. In jeder
    /// Stufe die fernste noch erreichbare Station, weil sie am weitesten bringt.
    static func tilesWithFavorites(
        stations: [AnnotatedStation],
        lowerPower: [AnnotatedStation],
        isFavorite: (AnnotatedStation) -> Bool,
        favoritesActive: Bool,
        progressMeters: Double,
        chargePercentNow: Double,
        percentPerKm: Double,
        reservePercent: Double,
        plannedStopIDs: Set<String>,
        passedMeters: Double = 100
    ) -> DrivingTileSet {
        let shown = tiles(
            stations: favoritesActive ? stations.filter(isFavorite) : stations,
            progressMeters: progressMeters,
            chargePercentNow: chargePercentNow,
            percentPerKm: percentPerKm,
            reservePercent: reservePercent,
            plannedStopIDs: plannedStopIDs
        )
        let tight = shown.first.map { !$0.isReachable } ?? true
        guard tight, percentPerKm > 0 else { return DrivingTileSet(tiles: shown) }

        let rangeMeters = max(0, (chargePercentNow - reservePercent) / percentPerKm * 1000)
        func farthestReachable(_ pool: [AnnotatedStation]) -> (AnnotatedStation, Double)? {
            pool
                .compactMap { item -> (AnnotatedStation, Double)? in
                    guard let position = item.station.progressAlongRouteMeters,
                          position > progressMeters + passedMeters else { return nil }
                    let meters = position - progressMeters + accessMeters(item.station)
                    return meters <= rangeMeters ? (item, meters) : nil
                }
                .max { $0.1 < $1.1 }
        }

        let stages: [(FallbackReason, [AnnotatedStation])] = favoritesActive
            ? [
                (.otherProvider, stations.filter { !isFavorite($0) }),
                (.lowerPower, lowerPower.filter(isFavorite)),
                (.otherProviderLowerPower, lowerPower.filter { !isFavorite($0) }),
            ]
            : [(.lowerPower, lowerPower)]

        for (reason, pool) in stages {
            guard let hit = farthestReachable(pool) else { continue }
            let (item, meters) = hit
            let fallback = DrivingTile(
                station: item,
                meters: meters,
                arrivalPercent: chargePercentNow - meters / 1000 * percentPerKm,
                isReachable: true,
                isPlannedStop: plannedStopIDs.contains(item.id),
                moreHere: 0
            )
            return DrivingTileSet(tiles: shown, fallback: fallback, fallbackReason: reason)
        }
        return DrivingTileSet(tiles: shown)
    }

    /// Weg von der Route bis zur Säule, einfach.
    ///
    /// Am genauesten ist die halbe Umwegstrecke. Kennt man nur die Umwegzeit,
    /// wird sie mit Stadttempo, 50 km/h, in Meter umgerechnet. Ohne beides
    /// bleibt der Abstand zur Route.
    static func accessMeters(_ station: ChargingStation) -> Double {
        if let meters = station.detourMeters { return meters / 2 }
        if let seconds = station.detourSeconds { return seconds * (50 / 3.6) / 2 }
        return station.distanceFromRouteMeters ?? 0
    }

    static func tiles(
        stations: [AnnotatedStation],
        progressMeters: Double,
        chargePercentNow: Double,
        percentPerKm: Double,
        reservePercent: Double,
        plannedStopIDs: Set<String>,
        count: Int = 3,
        bundleMeters: Double = 2_000,
        passedMeters: Double = 100
    ) -> [DrivingTile] {
        let ahead = stations
            .filter { ($0.station.progressAlongRouteMeters ?? -1) > progressMeters + passedMeters }
            .sorted { ($0.station.progressAlongRouteMeters ?? 0) < ($1.station.progressAlongRouteMeters ?? 0) }

        var groups: [[AnnotatedStation]] = []
        for item in ahead {
            let position = item.station.progressAlongRouteMeters ?? 0
            if let first = groups.last?.first,
               position - (first.station.progressAlongRouteMeters ?? 0) <= bundleMeters {
                groups[groups.count - 1].append(item)
            } else {
                if groups.count == count { break }
                groups.append([item])
            }
        }

        let rangeMeters = max(0, (chargePercentNow - reservePercent) / percentPerKm * 1000)
        func detour(_ item: AnnotatedStation) -> Double { item.station.detourSeconds ?? .infinity }

        return groups.map { group in
            let best = group.first { plannedStopIDs.contains($0.id) }
                ?? group.min { detour($0) < detour($1) }!
            let meters = (best.station.progressAlongRouteMeters ?? 0) - progressMeters
                + accessMeters(best.station)
            return DrivingTile(
                station: best,
                meters: meters,
                arrivalPercent: chargePercentNow - meters / 1000 * percentPerKm,
                isReachable: meters <= rangeMeters,
                isPlannedStop: plannedStopIDs.contains(best.id),
                moreHere: group.count - 1
            )
        }
    }
}
