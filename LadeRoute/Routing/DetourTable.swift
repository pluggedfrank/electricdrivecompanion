//  DetourTable.swift
//  Umwege einmal rechnen, dann nachschlagen.
//
//  Gegenstück zu tools/lib/umwegtabelle.mjs, Schlüssel und Rundung müssen
//  dort dieselben sein, sonst findet die App nichts. Der Umweg zu einer
//  Station hängt nur davon ab, auf welcher Straße man an ihr vorbeifährt und
//  in welcher Richtung, nicht von der Fahrt. Zwei Quellen, in dieser
//  Reihenfolge:
//
//    1. Die Tabelle im Bundle (daten/umwege.json), gefüllt von den
//       Probeläufen und Korridorfahrten. Werte ohne Verkehrslage.
//    2. Der Gerätecache mit allem, was die App selbst gerechnet hat. Wer
//       eine Strecke zum zweiten Mal fährt, kostet nichts mehr.
//
//  Der Schlüssel: Station, Fahrtrichtung in acht Sektoren, und der nächste
//  Routenpunkt auf zwei Nachkommastellen, also grob ein Kilometer.

import CoreLocation
import Foundation

struct DetourTableFile: Codable {
    var quelle: String?
    var hinweis: String?
    var eintraege: [String: Entry]

    struct Entry: Codable {
        let sekunden: Double
        /// Umweg in Metern. Ältere Einträge haben ihn nicht.
        let meter: Double?
        let verkehr: Bool?
        let datum: String?
    }
}

/// Wo und wie die Route an einer Station vorbeiführt, mit Schlüsselbildung.
enum DetourKey {
    static let sectors = 8

    /// Weg bis zu jedem Routenpunkt, einmal vorab.
    struct RouteLayout {
        let points: [CLLocationCoordinate2D]
        let cumulative: [Double]

        init(_ points: [CLLocationCoordinate2D]) {
            self.points = points
            var cumulative = [Double](repeating: 0, count: points.count)
            for i in 1 ..< max(1, points.count) {
                cumulative[i] = cumulative[i - 1] + GeoUtils.distance(points[i - 1], points[i])
            }
            self.cumulative = cumulative
        }

        /// Der Index des Routenpunkts bei diesem Weg. Binäre Suche.
        func index(atProgress progress: Double) -> Int {
            var lo = 0
            var hi = cumulative.count - 1
            while lo < hi {
                let mid = (lo + hi) >> 1
                if cumulative[mid] < progress { lo = mid + 1 } else { hi = mid }
            }
            return lo
        }
    }

    /// Kurs in Grad, 0 = Nord, 90 = Ost.
    static func bearing(from a: CLLocationCoordinate2D, to b: CLLocationCoordinate2D) -> Double {
        let phi1 = a.latitude * .pi / 180
        let phi2 = b.latitude * .pi / 180
        let dLambda = (b.longitude - a.longitude) * .pi / 180
        let y = sin(dLambda) * cos(phi2)
        let x = cos(phi1) * sin(phi2) - sin(phi1) * cos(phi2) * cos(dLambda)
        let degrees = atan2(y, x) * 180 / .pi
        return (degrees + 360).truncatingRemainder(dividingBy: 360)
    }

    /// 0 = Nord, 1 = Nordost, ..., 7 = Nordwest. Nord in der Mitte des ersten.
    static func sector(_ bearing: Double) -> Int {
        let shifted = ((bearing + 22.5).truncatingRemainder(dividingBy: 360) + 360)
            .truncatingRemainder(dividingBy: 360)
        return Int(floor(shifted / 45)) % sectors
    }

    /// Zwei Nachkommastellen, in beiden Sprachen gleich gerechnet: erst
    /// kaufmännisch auf Hundertstel runden, dann formatieren.
    static func rounded(_ value: Double) -> String {
        String(format: "%.2f", (value * 100).rounded() / 100)
    }

    /// Der Schlüssel für eine Station auf dieser Route, oder nil ohne Lage.
    ///
    /// Die Richtung kommt aus dem Punkt drei davor und drei dahinter, nicht
    /// aus zwei Nachbarn: Die liegen manchmal zehn Meter auseinander und
    /// zeigen dann in jede Richtung.
    static func key(for station: ChargingStation, on layout: RouteLayout) -> String? {
        guard let progress = station.progressAlongRouteMeters, !layout.points.isEmpty else { return nil }
        let i = layout.index(atProgress: progress)
        let n = layout.points.count
        let before = layout.points[max(0, i - 3)]
        let after = layout.points[min(n - 1, i + 3)]
        let point = layout.points[i]
        let heading = (max(0, i - 3) == min(n - 1, i + 3)) ? 0 : bearing(from: before, to: after)
        return "\(station.id)|\(sector(heading))|\(rounded(point.latitude)),\(rounded(point.longitude))"
    }
}

/// Die Tabelle aus dem Bundle plus der Gerätecache, hinter einer Abfrage.
final class DetourTable: @unchecked Sendable {
    // MARK: Lifecycle

    init(bundled: [String: DetourTableFile.Entry], cacheURL: URL?) {
        self.bundled = bundled
        self.cacheURL = cacheURL
        cached = Self.readCache(at: cacheURL)
    }

    static func loadBundled(bundle: Bundle = .main) -> DetourTable {
        var entries: [String: DetourTableFile.Entry] = [:]
        if let url = bundle.url(forResource: "umwege", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let file = try? JSONDecoder().decode(DetourTableFile.self, from: data) {
            entries = file.eintraege
        }
        let cacheURL = try? FileManager.default
            .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("umwege-cache.json")
        return DetourTable(bundled: entries, cacheURL: cacheURL)
    }

    // MARK: Internal

    var bundledCount: Int { bundled.count }
    var cachedCount: Int { lock.withLock { cached.count } }

    /// Der bekannte Umweg, aus dem Bundle oder dem Gerätecache.
    func lookup(_ station: ChargingStation, on layout: DetourKey.RouteLayout) -> DetourTableFile.Entry? {
        guard let key = DetourKey.key(for: station, on: layout) else { return nil }
        if let entry = bundled[key] { return entry }
        return lock.withLock { cached[key] }
    }

    /// Merkt sich einen gerechneten Umweg im Gerätecache.
    ///
    /// Die App rechnet mit Verkehrslage, und das steht auch so im Eintrag.
    /// Für die Wiederholung derselben Strecke ist das gut genug; die Tabelle
    /// im Bundle bleibt die Quelle der Werte ohne Verkehr.
    func remember(
        _ seconds: Double,
        meters: Double?,
        for station: ChargingStation,
        on layout: DetourKey.RouteLayout
    ) {
        guard let key = DetourKey.key(for: station, on: layout), bundled[key] == nil else { return }
        let entry = DetourTableFile.Entry(
            sekunden: seconds.rounded(),
            meter: meters?.rounded(),
            verkehr: true,
            datum: ISO8601DateFormatter().string(from: Date()).prefix(10).description
        )
        lock.withLock { cached[key] = entry }
    }

    /// Schreibt den Gerätecache weg. Einmal am Ende eines Laufs, nicht je Wert.
    func persist() {
        guard let cacheURL else { return }
        let snapshot = lock.withLock { cached }
        let file = DetourTableFile(quelle: "Gerätecache", hinweis: nil, eintraege: snapshot)
        if let data = try? JSONEncoder().encode(file) {
            try? data.write(to: cacheURL, options: .atomic)
        }
    }

    // MARK: Private

    private let bundled: [String: DetourTableFile.Entry]
    private let cacheURL: URL?
    private var cached: [String: DetourTableFile.Entry]
    private let lock = NSLock()

    private static func readCache(at url: URL?) -> [String: DetourTableFile.Entry] {
        guard let url, let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(DetourTableFile.self, from: data)
        else { return [:] }
        return file.eintraege
    }
}
