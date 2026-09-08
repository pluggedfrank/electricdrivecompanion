//  EditorialEntry.swift
//  Der eigene Datenbestand: was die Redaktion über eine Ladestation weiß und
//  TomTom nicht liefert.

import CoreLocation
import Foundation

struct EditorialEntry: Identifiable, Hashable, Codable, Sendable {
    let id: String
    /// Wenn bekannt, die TomTom-POI-ID. Dann ist die Zuordnung eindeutig und
    /// die Geo-Heuristik entfällt.
    let tomtomPoiID: String?
    let name: String
    let operatorName: String?
    let latitude: Double
    let longitude: Double
    /// Redaktionsnote von 1 (sehr gut) bis 5, analog Schulnote.
    let rating: Double?
    /// Unser Urteil. Fehlt, solange die Station nur erfasst und noch nicht
    /// gefahren ist. Der Bestand entsteht aus einem Export der Suchtreffer,
    /// der Test kommt später.
    let verdict: String?
    let testedAt: Date?
    let pricePerKWh: Double?
    let tags: [String]
    let author: String?

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    /// Das Urteil, sofern es eins gibt. Leerzeichen zählen nicht als Text,
    /// sonst entstünde aus einer versehentlich leeren Zeile ein Test.
    var verdictText: String? {
        guard let verdict else { return nil }
        let trimmed = verdict.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Getestet ist, wozu ein Urteil vorliegt. Alles andere ist Bestandsführung:
    /// die Station steht auf unserer Liste, gefahren ist sie noch niemand.
    ///
    /// Die Unterscheidung hängt an der Anzeige. Ein leerer Eintrag darf nicht
    /// als eigener Test auftreten, das wäre eine Behauptung ohne Deckung.
    var isTested: Bool { verdictText != nil }

    /// Farbe und Wortlaut für das Badge in der Liste.
    var ratingLabel: String? {
        guard let rating else { return nil }
        switch rating {
        case ..<1.6: return "sehr gut"
        case ..<2.6: return "gut"
        case ..<3.6: return "befriedigend"
        case ..<4.6: return "ausreichend"
        default: return "mangelhaft"
        }
    }
}
