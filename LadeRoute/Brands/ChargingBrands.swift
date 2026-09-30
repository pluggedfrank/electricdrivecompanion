//  ChargingBrands.swift
//  Welche Marke hinter einem Ladebetreiber steckt, und welche man bevorzugt.
//
//  Das Register führt Firmennamen ("BP Europa SE"), TomTom Markennamen
//  ("Aral pulse"), und wer Favoriten wählt, denkt in Marken. Die Tabelle liegt
//  in daten/marken.json und wird von den Werkzeugen genauso gelesen
//  (tools/lib/marken.mjs); ein Test dort prüft sie gegen das Register: keine
//  Doppeltreffer, mindestens 70 Prozent der Standorte ab 150 kW abgedeckt.

import Foundation

struct ChargingBrand: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let muster: [String]
}

struct ChargingBrands: Sendable {
    let all: [ChargingBrand]

    static func loadBundled(bundle: Bundle = .main) -> ChargingBrands {
        struct File: Decodable { let marken: [ChargingBrand] }
        guard let url = bundle.url(forResource: "marken", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let file = try? JSONDecoder().decode(File.self, from: data)
        else {
            assertionFailure("marken.json fehlt im Bundle")
            return ChargingBrands(all: [])
        }
        return ChargingBrands(all: file.marken)
    }

    /// Die Marke einer Station, oder nil. Die erste passende gewinnt.
    func brand(for station: ChargingStation) -> ChargingBrand? {
        let text = [station.operatorName, station.name]
            .compactMap { $0 }
            .joined(separator: " | ")
            .lowercased()
        guard !text.isEmpty else { return nil }
        return all.first { brand in brand.muster.contains { text.contains($0) } }
    }

    func brand(id: String) -> ChargingBrand? {
        all.first { $0.id == id }
    }
}

/// Die bevorzugten Anbieter, in den Nutzereinstellungen.
@MainActor
final class BrandPreferences: ObservableObject {
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        favorites = Set(defaults.stringArray(forKey: Self.key) ?? [])
    }

    @Published var favorites: Set<String> {
        didSet { defaults.set(Array(favorites).sorted(), forKey: Self.key) }
    }

    var isActive: Bool { !favorites.isEmpty }

    func toggle(_ brandID: String) {
        if favorites.contains(brandID) { favorites.remove(brandID) } else { favorites.insert(brandID) }
    }

    private static let key = "favoriteBrands"
    private let defaults: UserDefaults
}
