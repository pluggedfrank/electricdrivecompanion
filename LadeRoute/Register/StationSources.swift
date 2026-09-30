//  StationSources.swift
//  Register und TomTom auf einer Route, die über die Grenze geht.
//
//  Das Ladesäulenregister kennt nur Deutschland. Bis zum 30.09.2026 galt:
//  Hat das Register etwas auf der Route, wird TomTom nicht gefragt. Auf dem
//  Weg nach Amsterdam hieß das: deutscher Teil voll, niederländischer leer,
//  auch mit Fastned als Favorit. Jetzt sucht TomTom die Abschnitte außerhalb
//  Deutschlands ab, und beides wird zusammengelegt.
//
//  Gegenstück zu tools/lib/quellen.mjs; die Tests dort sind der Maßstab.

import CoreLocation
import Foundation

enum StationSources {
    /// Ein Stück der Route in einem Land, in Punktindizes der Geometrie.
    struct CountryRange: Equatable {
        let from: Int
        let to: Int
        /// ISO 3166 alpha-3, etwa "DEU", "NLD".
        let country: String
    }

    /// Die Stücke der Route außerhalb Deutschlands. Jedes reicht `margin`
    /// Meter in den deutschen Teil hinein, damit Grenzstationen nicht
    /// zwischen beiden Quellen verloren gehen. Benachbarte Auslandsstücke
    /// werden eins.
    static func foreignPieces(
        geometry: [CLLocationCoordinate2D],
        ranges: [CountryRange],
        margin: Double = 2000
    ) -> [[CLLocationCoordinate2D]] {
        guard geometry.count >= 2 else { return [] }
        var cumulative = [Double](repeating: 0, count: geometry.count)
        for i in 1 ..< geometry.count {
            cumulative[i] = cumulative[i - 1] + GeoUtils.distance(geometry[i - 1], geometry[i])
        }

        var merged: [(from: Int, to: Int)] = []
        for range in ranges.sorted(by: { $0.from < $1.from }) where range.country != "DEU" {
            if let last = merged.last, range.from <= last.to + 1 {
                merged[merged.count - 1].to = max(last.to, range.to)
            } else {
                merged.append((range.from, range.to))
            }
        }

        let lastIndex = geometry.count - 1
        return merged.map { piece in
            let from = min(max(0, piece.from), lastIndex)
            let to = min(max(from, piece.to), lastIndex)
            var start = from
            while start > 0, cumulative[from] - cumulative[start - 1] <= margin { start -= 1 }
            var end = to
            while end < lastIndex, cumulative[end + 1] - cumulative[to] <= margin { end += 1 }
            return Array(geometry[start ... end])
        }
    }

    /// Register und TomTom zusammen. Ein TomTom-Treffer in 150 m Nähe eines
    /// Registerstandorts ist derselbe Standort und fällt weg.
    static func merge(register: [ChargingStation], tomtom: [ChargingStation], radius: Double = 150) -> [ChargingStation] {
        let fresh = tomtom.filter { t in
            !register.contains { GeoUtils.distance($0.coordinate, t.coordinate) <= radius }
        }
        return register + fresh
    }

    /// Ersatz, wenn die Route keine Länderabschnitte mitbringt: Wo im Umkreis
    /// von `radius` keine Registerstation steht, gilt die Route als Ausland.
    /// Grob, aber auf der sicheren Seite: Ein deutsches Stück ohne
    /// Schnelllader kostet ein paar Suchanfragen, mehr nicht.
    static func coverageRanges(
        geometry: [CLLocationCoordinate2D],
        register: [ChargingStation],
        radius: Double = 25_000
    ) -> [CountryRange] {
        guard !geometry.isEmpty else { return [] }
        // Raster aus Viertelgrad-Zellen, damit nicht jeder Punkt gegen
        // neuntausend Standorte rechnet.
        let cell = 0.25
        var grid: [String: [CLLocationCoordinate2D]] = [:]
        for station in register {
            let key = "\(Int(floor(station.latitude / cell))),\(Int(floor(station.longitude / cell)))"
            grid[key, default: []].append(station.coordinate)
        }
        func covered(_ p: CLLocationCoordinate2D) -> Bool {
            let row = Int(floor(p.latitude / cell)), col = Int(floor(p.longitude / cell))
            for dr in -1 ... 1 {
                for dc in -1 ... 1 {
                    for s in grid["\(row + dr),\(col + dc)"] ?? [] where GeoUtils.distance(s, p) <= radius {
                        return true
                    }
                }
            }
            return false
        }

        var ranges: [CountryRange] = []
        var start = 0
        var current = covered(geometry[0])
        // Jeder zwanzigste Punkt genügt; die Grenze verschiebt sich dadurch
        // um ein paar hundert Meter, der Rand fängt das auf.
        var i = 20
        while i < geometry.count {
            let now = covered(geometry[i])
            if now != current {
                ranges.append(CountryRange(from: start, to: i - 1, country: current ? "DEU" : "XXX"))
                start = i
                current = now
            }
            i += 20
        }
        ranges.append(CountryRange(from: start, to: geometry.count - 1, country: current ? "DEU" : "XXX"))
        return ranges
    }
}
