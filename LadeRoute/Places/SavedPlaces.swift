//  SavedPlaces.swift
//  Gespeicherte Ziele: Zuhause und Arbeit oben, der Rest nach Kategorien.
//
//  Keine Kategoriesuche. Wer ein Ziel speichert, bekommt eine Kategorie
//  vorgeschlagen, aus der Einordnung der Search-API zum Treffer, und kann sie
//  ändern. Eigene Kategorien sind die nächste Ausbaustufe.
//
//  Gegenstück zur Regel: tools/lib/ziele.mjs, die Tests dort sind der Maßstab.

import CoreLocation
import Foundation

enum PlaceCategory: String, Codable, CaseIterable, Identifiable, Sendable {
    case home = "zuhause"
    case work = "arbeit"
    case charging = "laden"
    case shopping = "einkaufen"
    case food = "essen"
    case other = "sonstiges"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home: return "Zuhause"
        case .work: return "Arbeit"
        case .charging: return "Ladestationen"
        case .shopping: return "Einkaufen"
        case .food: return "Essen & Trinken"
        case .other: return "Sonstiges"
        }
    }

    var symbolName: String {
        switch self {
        case .home: return "house.fill"
        case .work: return "briefcase.fill"
        case .charging: return "bolt.car.fill"
        case .shopping: return "cart.fill"
        case .food: return "fork.knife"
        case .other: return "star.fill"
        }
    }

    /// Zuhause und Arbeit gibt es je nur einmal.
    var isSingle: Bool { self == .home || self == .work }

    /// Vorschlag aus den POI-Kategorien der Suche. Gegenstück zu
    /// kategorieFuer() in tools/lib/ziele.mjs.
    static func suggested(for poiCategories: [String]) -> PlaceCategory {
        let text = poiCategories.joined(separator: " | ").lowercased()
        func matches(_ pattern: String) -> Bool {
            text.range(of: pattern, options: .regularExpression) != nil
        }
        if matches("electric vehicle|charging") { return .charging }
        if matches("supermarket|hypermarket|market|shop|store|mall|bakery|pharmacy|drugstore") { return .shopping }
        if matches("restaurant|caf[eé]|coffee|bar\\b|pub|fast food|bistro|food") { return .food }
        return .other
    }
}

struct SavedPlace: Codable, Identifiable, Equatable, Sendable {
    var id = UUID()
    var name: String
    var address: String?
    var latitude: Double
    var longitude: Double
    var category: PlaceCategory

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }
}

/// Hält die gespeicherten Ziele in den Nutzereinstellungen.
@MainActor
final class SavedPlacesStore: ObservableObject {
    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.key),
           let decoded = try? JSONDecoder().decode([SavedPlace].self, from: data) {
            places = decoded
        }
        if let data = defaults.data(forKey: Self.recentsKey),
           let decoded = try? JSONDecoder().decode([SavedPlace].self, from: data) {
            recents = decoded
        }
    }

    /// Merkt ein Ziel als letztes. Dasselbe Ziel (innerhalb von 30 m) rückt
    /// nach vorn statt doppelt zu stehen.
    func remember(name: String, address: String?, coordinate: CLLocationCoordinate2D) {
        recents.removeAll { GeoUtils.distance($0.coordinate, coordinate) <= 30 }
        recents.insert(
            SavedPlace(name: name, address: address, latitude: coordinate.latitude, longitude: coordinate.longitude, category: .other),
            at: 0
        )
        if recents.count > 10 { recents.removeLast(recents.count - 10) }
        if let data = try? JSONEncoder().encode(recents) {
            defaults.set(data, forKey: Self.recentsKey)
        }
    }

    func clearRecents() {
        recents = []
        defaults.removeObject(forKey: Self.recentsKey)
    }

    @Published private(set) var places: [SavedPlace] = []
    /// Die letzten Ziele, neueste zuerst, höchstens zehn. Automatisch, bei
    /// jedem neuen Ziel; "Route verwerfen" löscht sie nicht.
    @Published private(set) var recents: [SavedPlace] = []

    func place(for category: PlaceCategory) -> SavedPlace? {
        places.first { $0.category == category }
    }

    func places(in category: PlaceCategory) -> [SavedPlace] {
        places.filter { $0.category == category }.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    /// Das Ziel an dieser Stelle, innerhalb von 30 m. Gegenstück zu
    /// gespeichertBei() in tools/lib/ziele.mjs.
    func saved(at coordinate: CLLocationCoordinate2D) -> SavedPlace? {
        places.first { GeoUtils.distance($0.coordinate, coordinate) <= 30 }
    }

    /// Speichert oder ändert. Zuhause und Arbeit ersetzen das bisherige.
    func save(_ place: SavedPlace) {
        if place.category.isSingle {
            places.removeAll { $0.category == place.category && $0.id != place.id }
        }
        if let index = places.firstIndex(where: { $0.id == place.id }) {
            places[index] = place
        } else {
            places.append(place)
        }
        persist()
    }

    func remove(_ place: SavedPlace) {
        places.removeAll { $0.id == place.id }
        persist()
    }

    /// Gespeicherte Ziele, deren Name oder Adresse den Suchtext enthält.
    func matching(_ query: String) -> [SavedPlace] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard q.count >= 2 else { return [] }
        return places.filter {
            $0.name.lowercased().contains(q) || ($0.address?.lowercased().contains(q) ?? false)
                || $0.category.title.lowercased().hasPrefix(q)
        }
    }

    private static let key = "savedPlaces"
    private static let recentsKey = "recentPlaces"
    private let defaults: UserDefaults

    private func persist() {
        if let data = try? JSONEncoder().encode(places) {
            defaults.set(data, forKey: Self.key)
        }
    }
}
