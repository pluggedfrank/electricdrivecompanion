//  ForeignStationCache.swift
//  Die Auslandstreffer der TomTom-Suche, 24 Stunden lang je Streckenstück.
//
//  Eine Rom-Planung kostet im Ausland 19 Suchanfragen, und jede neue Planung
//  derselben Strecke fragte alles noch einmal ab. Das Kontingent war am
//  30.09.2026 leer. Jetzt gilt: Dasselbe Stück mit derselben Leistungsstufe
//  kommt einen Tag lang aus dem Speicher. Nur vollständige Antworten werden
//  gespeichert; ein Stück mit gescheiterten Abschnitten wird beim nächsten
//  Mal wieder gefragt.

import CoreLocation
import Foundation

final class ForeignStationCache {
    init(fileURL: URL? = nil, lifetime: TimeInterval = 24 * 3600) {
        self.fileURL = fileURL ?? FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("auslandsstationen.json")
        self.lifetime = lifetime
        load()
    }

    /// Dasselbe Stück: Anfang und Ende auf etwa 2 km genau, Länge auf 10 km,
    /// dieselbe Leistungsstufe. Kleine Abweichungen der Linie, etwa ein
    /// anderer Startpunkt in derselben Straße, treffen denselben Eintrag.
    static func key(for piece: [CLLocationCoordinate2D], minPowerKW: Double?) -> String? {
        guard let first = piece.first, let last = piece.last, piece.count >= 2 else { return nil }
        func r(_ v: Double) -> String { String(format: "%.2f", (v / 0.02).rounded() * 0.02) }
        var length = 0.0
        for i in 1 ..< piece.count { length += GeoUtils.distance(piece[i - 1], piece[i]) }
        let km = Int((length / 10_000).rounded()) * 10
        return "\(r(first.latitude)),\(r(first.longitude))-\(r(last.latitude)),\(r(last.longitude))|\(km)km|\(Int(minPowerKW ?? 0))kW"
    }

    func stations(for piece: [CLLocationCoordinate2D], minPowerKW: Double?, now: Date = Date()) -> [ChargingStation]? {
        guard let key = Self.key(for: piece, minPowerKW: minPowerKW),
              let entry = entries[key], now.timeIntervalSince(entry.fetchedAt) < lifetime
        else { return nil }
        return entry.stations
    }

    func store(_ stations: [ChargingStation], for piece: [CLLocationCoordinate2D], minPowerKW: Double?, now: Date = Date()) {
        guard let key = Self.key(for: piece, minPowerKW: minPowerKW) else { return }
        entries[key] = Entry(fetchedAt: now, stations: stations)
        entries = entries.filter { now.timeIntervalSince($0.value.fetchedAt) < lifetime }
        save()
    }

    // MARK: Private

    private struct Entry: Codable {
        let fetchedAt: Date
        let stations: [ChargingStation]
    }

    private let fileURL: URL
    private let lifetime: TimeInterval
    private var entries: [String: Entry] = [:]

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode([String: Entry].self, from: data)
        else { return }
        entries = decoded
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}
