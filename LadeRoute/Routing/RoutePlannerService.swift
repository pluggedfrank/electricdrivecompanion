//  RoutePlannerService.swift
//  Dünne async/await-Hülle um den Online-Routenplaner des SDK.

import CoreLocation
import Foundation
import TomTomSDKRoute
import TomTomSDKRoutePlanner
import TomTomSDKRoutePlannerOnline
import TomTomSDKRoutingCommon

enum RoutePlanningError: LocalizedError {
    case noRouteFound
    case planner(underlying: Error)

    var errorDescription: String? {
        switch self {
        case .noRouteFound:
            return "TomTom hat für diese Punkte keine Route gefunden."
        case let .planner(underlying):
            if let routingError = underlying as? RoutingError {
                return "Routing-Fehler \(routingError.code): \(routingError.errorDescription ?? "")"
            }
            return underlying.localizedDescription
        }
    }
}

final class RoutePlannerService {
    // MARK: Lifecycle

    init(apiKey: String) {
        planner = OnlineRoutePlanner(apiKey: apiKey)
    }

    // MARK: Internal

    func planRoute(
        from origin: CLLocationCoordinate2D,
        to destination: CLLocationCoordinate2D
    ) async throws -> TomTomSDKRoute.Route {
        let itinerary = Itinerary(
            origin: ItineraryPoint(coordinate: origin),
            destination: ItineraryPoint(coordinate: destination)
        )

        // Ohne GuidanceOptions: der Prototyp zeichnet die Route und sucht an ihr
        // entlang, er sagt nicht an. Das spart Antwortgröße und Kontingent.
        // Für Turn-by-Turn kämen hier GuidanceOptions dazu, dann aber auch das
        // Navigation SDK, das separat lizenziert wird.
        let options = try RoutePlanningOptions(
            itinerary: itinerary,
            costModel: CostModel(routeType: .fast)
        )

        return try await withCheckedThrowingContinuation { continuation in
            planner.planRoute(options: options, onRouteReady: nil) { result in
                switch result {
                case let .success(response):
                    guard let route = response.routes?.first else {
                        continuation.resume(throwing: RoutePlanningError.noRouteFound)
                        return
                    }
                    continuation.resume(returning: route)
                case let .failure(error):
                    continuation.resume(throwing: RoutePlanningError.planner(underlying: error))
                }
            }
        }
    }

    // MARK: Private

    private let planner: OnlineRoutePlanner
}
