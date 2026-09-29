//  CalculateRouteDTO.swift
//  Das Nötigste aus der Antwort von /routing/1/calculateRoute.
//
//  Für die Umwegrechnung braucht es nur die Fahrzeit. Die Route selbst zeichnet
//  das SDK; hier geht es um Zahlen, nicht um Geometrie.

import Foundation

struct CalculateRouteResponse: Decodable {
    let routes: [Route]

    struct Route: Decodable {
        let summary: Summary
    }

    struct Summary: Decodable {
        let lengthInMeters: Double?
        let travelTimeInSeconds: Double
        let trafficDelayInSeconds: Double?
    }
}
