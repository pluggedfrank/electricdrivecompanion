//  TripViewModel.swift
//  Der gesamte Ablauf: Ziel setzen, Route planen, Ladestationen suchen,
//  eigene Daten dazulegen, Live-Belegung nachladen.

import Combine
import CoreLocation
import Foundation
import TomTomSDKRoute

@MainActor
final class TripViewModel: ObservableObject {
    // MARK: Lifecycle

    init(
        apiKey: String,
        editorialStore: EditorialStore = .loadBundled()
    ) {
        self.apiKey = apiKey
        self.editorialStore = editorialStore
        api = TomTomAPIClient(apiKey: apiKey)
        routePlanner = RoutePlannerService(apiKey: apiKey)
    }

    // MARK: Zustand

    enum Phase: Equatable {
        case idle
        case planningRoute
        case searchingStations
        case ready
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var route: TomTomSDKRoute.Route?
    @Published private(set) var stations: [AnnotatedStation] = []
    @Published var selectedStationID: String?
    @Published var currentLocation: CLLocationCoordinate2D?
    @Published var destination: CLLocationCoordinate2D?
    @Published var mapIsReady = false
    @Published var mapBottomInset: CGFloat = 0

    /// Filter, die direkt in die Suchanfrage wandern.
    @Published var onlyFastCharging = false
    @Published var maxDetourMinutes: Double = 10

    var selectedStation: AnnotatedStation? {
        stations.first { $0.id == selectedStationID }
    }

    var routeSummary: (distanceKm: Double, durationMinutes: Double)? {
        guard let summary = route?.summary else { return nil }
        return (
            summary.length.converted(to: .kilometers).value,
            summary.travelTime.converted(to: .minutes).value
        )
    }

    /// Stationen mit eigener Bewertung zuerst, ansonsten Reihenfolge entlang der Route.
    var stationsForList: [AnnotatedStation] { stations }

    var editorialCount: Int { stations.filter(\.hasEditorialContent).count }

    // MARK: Aktionen

    func setDestination(_ coordinate: CLLocationCoordinate2D) {
        destination = coordinate
        Task { await planAndSearch() }
    }

    func selectStation(id: String) {
        selectedStationID = id
        Task { await loadAvailability(for: id) }
    }

    func reportError(_ message: String) {
        phase = .failed(message)
    }

    func clearTrip() {
        route = nil
        stations = []
        selectedStationID = nil
        destination = nil
        phase = .idle
    }

    /// Nach einer Filteränderung nur die Suche wiederholen, die Route bleibt.
    func reapplyFilters() {
        guard route != nil else { return }
        Task { await searchStations() }
    }

    // MARK: Ablauf

    private func planAndSearch() async {
        guard let destination else { return }
        guard let origin = currentLocation else {
            phase = .failed("Noch keine GPS-Position. Standortfreigabe prüfen.")
            return
        }

        phase = .planningRoute
        stations = []
        selectedStationID = nil

        do {
            route = try await routePlanner.planRoute(from: origin, to: destination)
        } catch {
            route = nil
            phase = .failed(error.localizedDescription)
            return
        }

        await searchStations()
    }

    private func searchStations() async {
        guard let route else { return }

        phase = .searchingStations
        var options = AlongRouteSearchOptions()
        options.maxDetourSeconds = Int(maxDetourMinutes * 60)
        if onlyFastCharging {
            options.minPowerKW = 100
            options.connectorTypes = [.ccs2, .chademo, .tesla]
        }

        do {
            let found = try await api.chargingStationsAlongRoute(
                routeGeometry: route.geometry,
                options: options
            )
            stations = editorialStore.annotate(found)
            phase = .ready
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Live-Belegung erst beim Antippen holen, nicht für alle Treffer auf einmal.
    /// Das spart im Freemium-Kontingent den Löwenanteil der Anfragen.
    private func loadAvailability(for stationID: String) async {
        guard let index = stations.firstIndex(where: { $0.id == stationID }) else { return }
        guard stations[index].availability == nil else { return }
        guard let availabilityID = stations[index].station.availabilityID else { return }

        do {
            let availability = try await api.availability(for: availabilityID)
            // Der Index kann sich zwischenzeitlich verschoben haben.
            if let current = stations.firstIndex(where: { $0.id == stationID }) {
                stations[current].availability = availability
            }
        } catch {
            // Live-Daten sind eine Zugabe. Fehlen sie, bleibt der Rest nutzbar.
            print("Belegung für \(stationID) nicht abrufbar: \(error.localizedDescription)")
        }
    }

    // MARK: Private

    private let apiKey: String
    private let api: TomTomAPIClient
    private let routePlanner: RoutePlannerService
    private let editorialStore: EditorialStore
}
