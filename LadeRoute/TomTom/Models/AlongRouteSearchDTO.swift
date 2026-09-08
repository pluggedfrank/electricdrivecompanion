//  AlongRouteSearchDTO.swift
//  1:1-Abbild der Antwort von /search/2/searchAlongRoute.
//  Bewusst alles optional außer id und position: die Search-API liefert je nach
//  Datenlage sehr unterschiedlich vollständige Datensätze.

import Foundation

struct AlongRouteSearchResponse: Decodable {
    let summary: Summary?
    let results: [Result]

    struct Summary: Decodable {
        let numResults: Int?
        let totalResults: Int?
    }

    struct Result: Decodable {
        let id: String
        let position: Position
        let poi: POI?
        let address: Address?
        let chargingPark: ChargingPark?
        let dataSources: DataSources?
        /// Umweg in Sekunden gegenüber der Originalroute.
        let detourTime: Double?
        /// Zusätzlich zurückzulegende Strecke in Metern.
        let detourDistance: Double?
        /// Luftlinie vom Routenverlauf zum POI in Metern.
        let dist: Double?
    }

    struct Position: Decodable {
        let lat: Double
        let lon: Double
    }

    struct POI: Decodable {
        let name: String?
        let phone: String?
        let url: String?
        let brands: [Brand]?
        let categories: [String]?

        struct Brand: Decodable {
            let name: String?
        }
    }

    struct Address: Decodable {
        let freeformAddress: String?
        let streetName: String?
        let streetNumber: String?
        let municipality: String?
        let postalCode: String?
        let countryCode: String?
    }

    struct ChargingPark: Decodable {
        let connectors: [Connector]?

        struct Connector: Decodable {
            let connectorType: ConnectorType?
            let ratedPowerKW: Double?
            let voltageV: Double?
            let currentA: Double?
            let currentType: String?
        }
    }

    struct DataSources: Decodable {
        let chargingAvailability: Reference?

        struct Reference: Decodable {
            let id: String?
        }
    }
}
