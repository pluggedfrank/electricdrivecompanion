//  Place.swift
//  Ein Suchergebnis der Zielsuche: Ort, Adresse oder Betrieb.

import CoreLocation
import Foundation

struct Place: Identifiable, Hashable, Sendable {
    let id: String
    /// Was groß in der Liste steht. Bei einem Betrieb sein Name, bei einer
    /// Adresse der Ort.
    let title: String
    /// Die Zeile darunter, meist die vollständige Anschrift.
    let subtitle: String?
    let latitude: Double
    let longitude: Double
    /// Luftlinie vom Suchmittelpunkt, wenn die Antwort sie mitliefert.
    let distanceMeters: Double?

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    /// Baut ein Ergebnis aus der Antwort der Search-API.
    ///
    /// Die Freitextsuche liefert dieselbe Satzform wie die POI-Suche, nur sind
    /// je nach Treffer andere Felder gefüllt: Eine Adresse hat keinen Namen,
    /// ein Betrieb hat einen. Ohne beides taugt der Treffer nicht als Ziel.
    init?(result: AlongRouteSearchResponse.Result) {
        let name = result.poi?.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let address = result.address?.freeformAddress?.trimmingCharacters(in: .whitespacesAndNewlines)

        let heading = [name, result.address?.municipality, address]
            .compactMap { $0 }
            .first { !$0.isEmpty }
        guard let heading else { return nil }

        id = result.id
        title = heading
        subtitle = (address == heading || address?.isEmpty == true) ? nil : address
        latitude = result.position.lat
        longitude = result.position.lon
        distanceMeters = result.dist
    }
}
