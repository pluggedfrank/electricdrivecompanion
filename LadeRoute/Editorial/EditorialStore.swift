//  EditorialStore.swift
//  Lädt die eigenen Ladestations-Daten und ordnet sie den TomTom-Treffern zu.
//
//  Für den Prototypen kommt der Bestand aus einer mitgelieferten JSON-Datei.
//  Produktiv träte hier ein Backend an die Stelle von `loadBundled()`; der Rest
//  der Klasse bliebe unverändert.

import CoreLocation
import Foundation

final class EditorialStore: @unchecked Sendable {
    // MARK: Lifecycle

    init(entries: [EditorialEntry]) {
        self.entries = entries
        byPoiID = Dictionary(
            entries.compactMap { entry in entry.tomtomPoiID.map { ($0, entry) } },
            uniquingKeysWith: { first, _ in first }
        )
    }

    // MARK: Internal

    /// Höchster Abstand, bei dem zwei Datensätze noch dieselbe Station sein können.
    static let maxMatchDistanceMeters: Double = 150

    /// Mindest-Score, ab dem eine Zuordnung als sicher gilt.
    static let minMatchScore: Double = 0.45

    let entries: [EditorialEntry]

    static func loadBundled(
        named name: String = "editorial-stations",
        bundle: Bundle = .main
    ) -> EditorialStore {
        guard let url = bundle.url(forResource: name, withExtension: "json") else {
            assertionFailure("\(name).json fehlt im Bundle. Ist die Datei im Target?")
            return EditorialStore(entries: [])
        }
        do {
            let data = try Data(contentsOf: url)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return EditorialStore(entries: try decoder.decode([EditorialEntry].self, from: data))
        } catch {
            assertionFailure("editorial-stations.json nicht lesbar: \(error)")
            return EditorialStore(entries: [])
        }
    }

    /// Sucht den passenden Redaktionsdatensatz zu einer TomTom-Station.
    ///
    /// Erst über die POI-ID, weil das eindeutig ist. Sonst über Entfernung und
    /// Namensähnlichkeit zusammen: Entfernung allein verwechselt benachbarte
    /// Ladeparks auf demselben Rastplatz, Name allein trifft Ketten wie "EnBW"
    /// bundesweit.
    func match(_ station: ChargingStation) -> EditorialEntry? {
        if let id = byPoiID[station.id] { return id }

        var best: (entry: EditorialEntry, score: Double)?
        for entry in entries {
            let distance = GeoUtils.distance(entry.coordinate, station.coordinate)
            guard distance <= Self.maxMatchDistanceMeters else { continue }

            let score = Self.matchScore(
                distance: distance,
                stationName: station.name,
                stationOperator: station.operatorName,
                entry: entry
            )
            if score >= Self.minMatchScore, score > (best?.score ?? 0) {
                best = (entry, score)
            }
        }
        return best?.entry
    }

    /// Reichert eine Liste von Stationen mit den eigenen Daten an.
    func annotate(_ stations: [ChargingStation]) -> [AnnotatedStation] {
        stations.map { AnnotatedStation(station: $0, editorial: match($0)) }
    }

    // MARK: Private

    private let byPoiID: [String: EditorialEntry]
}

// MARK: - Bewertungslogik

extension EditorialStore {
    /// Gewichteter Score aus Nähe (60 %) und Namensähnlichkeit (40 %).
    static func matchScore(
        distance: Double,
        stationName: String,
        stationOperator: String?,
        entry: EditorialEntry
    ) -> Double {
        let proximity = max(0, 1 - distance / maxMatchDistanceMeters)

        let nameSimilarity = similarity(stationName, entry.name)
        let operatorSimilarity: Double = {
            guard let stationOperator, let entryOperator = entry.operatorName else { return 0 }
            return similarity(stationOperator, entryOperator)
        }()
        let textual = max(nameSimilarity, operatorSimilarity)

        return proximity * 0.6 + textual * 0.4
    }

    /// Jaccard-Ähnlichkeit über normalisierte Wortmengen.
    ///
    /// Bewusst kein Levenshtein: Betreibernamen unterscheiden sich in ganzen
    /// Wörtern ("EnBW Ladepark Meppen" vs. "EnBW mobility+ Meppen"), nicht in
    /// einzelnen Zeichen.
    static func similarity(_ a: String, _ b: String) -> Double {
        let tokensA = tokenize(a)
        let tokensB = tokenize(b)
        guard !tokensA.isEmpty, !tokensB.isEmpty else { return 0 }

        let intersection = tokensA.intersection(tokensB).count
        let union = tokensA.union(tokensB).count
        return union == 0 ? 0 : Double(intersection) / Double(union)
    }

    /// Kleinschreibung, Umlaute aufgelöst, Füllwörter raus.
    static func tokenize(_ text: String) -> Set<String> {
        let stopWords: Set<String> = [
            "ladestation", "ladesaeule", "ladepark", "ladepunkt", "charging",
            "station", "charge", "point", "ev", "gmbh", "ag", "co", "kg",
            "der", "die", "das", "und", "am", "an", "im", "in", "zur", "zum",
        ]

        let folded = text
            .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "de_DE"))
            .replacingOccurrences(of: "ß", with: "ss")
            .lowercased()

        let tokens = folded
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .map(String.init)
            .filter { $0.count > 1 && !stopWords.contains($0) }

        return Set(tokens)
    }
}

// MARK: - Zusammengeführter Datensatz

struct AnnotatedStation: Identifiable, Hashable, Sendable {
    let station: ChargingStation
    var editorial: EditorialEntry? = nil
    var availability: StationAvailability? = nil


    var id: String { station.id }

    /// Stationen mit eigener Bewertung sollen in der Liste nach oben.
    var hasEditorialContent: Bool { editorial != nil }
}
