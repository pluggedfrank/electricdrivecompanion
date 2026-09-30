//  CalculateRouteDTO.swift
//  Das Nötigste aus der Antwort von /routing/1/calculateRoute.
//
//  Für die Umwegrechnung braucht es nur die Fahrzeit. Für die Zielführung die
//  Anweisungen mit ihren deutschen Texten (instructionsType=text). Die Route
//  selbst zeichnet das SDK.

import Foundation

struct CalculateRouteResponse: Decodable {
    let routes: [Route]

    struct Route: Decodable {
        let summary: Summary
        /// Nur, wenn Anweisungen angefragt sind.
        let guidance: Guidance?
    }

    struct Summary: Decodable {
        let lengthInMeters: Double?
        let travelTimeInSeconds: Double
        let trafficDelayInSeconds: Double?
    }

    struct Guidance: Decodable {
        let instructions: [Instruction]
    }

    /// Eine Fahranweisung. Felder wie im Probelauf vom 30.09.2026 gesehen;
    /// alles, was nicht jede Anweisung hat, ist optional.
    struct Instruction: Decodable {
        let routeOffsetInMeters: Double
        let travelTimeInSeconds: Double?
        let point: Point
        let maneuver: String
        let message: String
        let combinedMessage: String?
        let street: String?
        let roadNumbers: [String]?
        let signpostText: String?
        let exitNumber: String?
        let roundaboutExitNumber: Int?
    }

    struct Point: Decodable {
        let latitude: Double
        let longitude: Double
    }
}
