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
    let verdict: String
    let testedAt: Date?
    let pricePerKWh: Double?
    let tags: [String]
    let author: String?

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

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
