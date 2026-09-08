//  ChargingAvailabilityDTO.swift
//  Antwort von /search/2/chargingAvailability.
//
//  Zur Verschachtelung von `availability`: dokumentiert ist ein Wrapper-Objekt
//  `current`. Es gibt aber Antworten, in denen die Zähler direkt auf der Ebene
//  darüber liegen. Der Decoder unten akzeptiert beide Formen, damit ein
//  Schema-Detail den Prototypen nicht blockiert.

import Foundation

struct ChargingAvailabilityResponse: Decodable {
    let chargingAvailability: String?
    let connectors: [Connector]

    struct Connector: Decodable {
        let type: ConnectorType?
        let total: Int?
        let availability: Availability?
        let perPowerLevel: [PowerLevel]?
    }

    struct PowerLevel: Decodable {
        let powerKW: Double?
        let total: Int?
        let availability: Availability?
    }

    /// Akzeptiert `{"current": {...}}` und `{...}` gleichermaßen.
    struct Availability: Decodable {
        let current: Counts

        private enum CodingKeys: String, CodingKey {
            case current
        }

        init(from decoder: Decoder) throws {
            if let keyed = try? decoder.container(keyedBy: CodingKeys.self),
               let nested = try? keyed.decode(Counts.self, forKey: .current) {
                current = nested
            } else {
                current = try Counts(from: decoder)
            }
        }
    }

    struct Counts: Decodable {
        let available: Int?
        let occupied: Int?
        let reserved: Int?
        let unknown: Int?
        let outOfService: Int?
    }
}
