//  ChargingStation.swift
//  Das Modell, mit dem die App arbeitet. Bewusst getrennt von den DTOs:
//  die TomTom-Antwort ist eine Datenquelle, nicht das Domänenmodell.

import CoreLocation
import Foundation

struct ChargingStation: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let address: String
    let latitude: Double
    let longitude: Double
    let connectors: [Connector]
    /// Kategorieangaben des POI, wie TomTom sie liefert.
    let categories: [String]
    /// ID für die Live-Belegungsabfrage. Fehlt bei Stationen ohne Live-Anbindung.
    let availabilityID: String?
    let detourSeconds: Double?
    let detourMeters: Double?
    let distanceFromRouteMeters: Double?
    let operatorName: String?

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    /// Höchste Ladeleistung der Station in kW.
    var maxPowerKW: Double? {
        connectors.compactMap(\.ratedPowerKW).max()
    }

    var hasDCCharging: Bool {
        connectors.contains { $0.type?.isDC == true || ($0.ratedPowerKW ?? 0) >= 50 }
    }

    /// Ist das wirklich eine Ladestation?
    ///
    /// Der Kategoriefilter der Search API ist unbrauchbar: `categorySet=7309`
    /// liefert null Treffer, dieselbe Anfrage ohne den Parameter liefert 20.
    /// Deshalb entscheidet der Datensatz selbst. Ein Ladepark bringt seine
    /// Anschlüsse mit, das ist ein harter Beleg. Fehlen sie, entscheidet
    /// ersatzweise die Kategorieangabe.
    var isChargingStation: Bool {
        if !connectors.isEmpty { return true }

        let hints = ["electric vehicle", "charging", "ladestation", "ladesäule", "ladesaeule"]
        return categories.contains { category in
            let lowered = category.lowercased()
            return hints.contains { lowered.contains($0) }
        }
    }

    /// Steckertypen ohne Dubletten, in stabiler Reihenfolge.
    var distinctConnectorTypes: [ConnectorType] {
        var seen = Set<ConnectorType>()
        return connectors.compactMap(\.type).filter { seen.insert($0).inserted }
    }

    struct Connector: Hashable, Sendable {
        let type: ConnectorType?
        let ratedPowerKW: Double?
        let currentType: String?
    }
}

// MARK: - Aufbereitung aus der Search-Antwort

extension ChargingStation {
    init(searchResult result: AlongRouteSearchResponse.Result) {
        id = result.id
        name = result.poi?.name
            ?? result.poi?.brands?.compactMap(\.name).first
            ?? "Ladestation"
        address = result.address?.freeformAddress
            ?? [result.address?.streetName, result.address?.municipality]
            .compactMap { $0 }
            .joined(separator: ", ")
        latitude = result.position.lat
        longitude = result.position.lon
        connectors = (result.chargingPark?.connectors ?? []).map {
            Connector(
                type: $0.connectorType,
                ratedPowerKW: $0.ratedPowerKW,
                currentType: $0.currentType
            )
        }
        categories = result.poi?.categories ?? []
        availabilityID = result.dataSources?.chargingAvailability?.id
        detourSeconds = result.detourTime
        detourMeters = result.detourDistance
        distanceFromRouteMeters = result.dist
        operatorName = result.poi?.brands?.compactMap(\.name).first
    }
}

// MARK: - Live-Belegung

struct StationAvailability: Hashable, Sendable {
    let available: Int
    let occupied: Int
    let outOfService: Int
    let unknown: Int
    let total: Int
    let fetchedAt: Date

    /// Nur Ladepunkte, über deren Zustand tatsächlich etwas bekannt ist.
    var known: Int { available + occupied + outOfService }

    var isUsable: Bool { available > 0 }

    init(response: ChargingAvailabilityResponse, fetchedAt: Date = Date()) {
        var available = 0, occupied = 0, outOfService = 0, unknown = 0, total = 0
        for connector in response.connectors {
            let counts = connector.availability?.current
            available += counts?.available ?? 0
            occupied += counts?.occupied ?? 0
            outOfService += counts?.outOfService ?? 0
            unknown += (counts?.unknown ?? 0) + (counts?.reserved ?? 0)
            total += connector.total ?? 0
        }
        self.available = available
        self.occupied = occupied
        self.outOfService = outOfService
        self.unknown = unknown
        // `total` kann fehlen; dann aus den Zählern rekonstruieren.
        self.total = total > 0 ? total : available + occupied + outOfService + unknown
        self.fetchedAt = fetchedAt
    }
}
