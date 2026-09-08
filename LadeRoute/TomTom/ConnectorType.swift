//  ConnectorType.swift
//  Steckertypen als String-Wrapper statt als Enum: TomTom ergänzt die Liste
//  gelegentlich, und ein unbekannter Wert darf das Decoding nie sprengen.

import Foundation

struct ConnectorType: RawRepresentable, Hashable, Codable, Sendable {
    let rawValue: String

    init(rawValue: String) { self.rawValue = rawValue }
    init(_ rawValue: String) { self.rawValue = rawValue }

    init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

extension ConnectorType {
    static let type2Outlet = ConnectorType("IEC62196Type2Outlet")
    static let type2CableAttached = ConnectorType("IEC62196Type2CableAttached")
    static let ccs2 = ConnectorType("IEC62196Type2CCS")
    static let type1 = ConnectorType("IEC62196Type1")
    static let ccs1 = ConnectorType("IEC62196Type1CCS")
    static let type3 = ConnectorType("IEC62196Type3")
    static let chademo = ConnectorType("Chademo")
    static let tesla = ConnectorType("Tesla")
    static let householdSocket = ConnectorType("StandardHouseholdCountrySpecific")
    static let gbtPart2 = ConnectorType("GBT20234Part2")
    static let gbtPart3 = ConnectorType("GBT20234Part3")
    static let iec60309AC1Phase = ConnectorType("IEC60309AC1PhaseBlue")
    static let iec60309DC = ConnectorType("IEC60309DCWhite")

    /// Was in Deutschland tatsächlich relevant ist.
    static let commonInGermany: [ConnectorType] = [
        .type2Outlet, .type2CableAttached, .ccs2, .chademo, .tesla,
    ]

    /// Nur Gleichstrom-Stecker. Für den Schnelllade-Filter.
    var isDC: Bool {
        [Self.ccs1, .ccs2, .chademo, .gbtPart3, .iec60309DC, .tesla].contains(self)
    }

    var displayName: String {
        switch self {
        case .type2Outlet: return "Typ 2 (Dose)"
        case .type2CableAttached: return "Typ 2 (Kabel)"
        case .ccs2: return "CCS"
        case .ccs1: return "CCS Typ 1"
        case .type1: return "Typ 1"
        case .type3: return "Typ 3"
        case .chademo: return "CHAdeMO"
        case .tesla: return "Tesla"
        case .householdSocket: return "Schuko"
        case .gbtPart2: return "GB/T AC"
        case .gbtPart3: return "GB/T DC"
        case .iec60309AC1Phase: return "CEE blau"
        case .iec60309DC: return "CEE DC"
        default: return rawValue
        }
    }

    /// Kurzform für enge Badges in der Liste.
    var shortName: String {
        switch self {
        case .type2Outlet, .type2CableAttached: return "Typ 2"
        case .ccs2, .ccs1: return "CCS"
        case .chademo: return "CHAdeMO"
        case .tesla: return "Tesla"
        case .householdSocket: return "Schuko"
        default: return displayName
        }
    }
}
