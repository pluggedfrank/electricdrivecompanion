//  CarPlayMapController.swift
//  Die Karte im Auto-Display.
//
//  Eine eigene TomTom-Karte, aber kein eigener Standortgeber: Die Position
//  kommt aus dem Fahrtmodell, echt oder simuliert, dieselbe wie auf dem
//  iPhone. Ein zweiter simulierter Geber, den diese Karte nur als Anzeige
//  nutzt, bekommt jede neue Position hineingereicht; so zeichnet das SDK den
//  Pfeil, und die Kamera folgt ihm wie auf dem iPhone.

import Combine
import CoreLocation
import TomTomSDKLocationProvider
import TomTomSDKMapDisplay
import TomTomSDKRoute
import UIKit

final class CarPlayMapController: UIViewController, TomTomSDKMapDisplay.MapViewDelegate {
    init(trip: TripViewModel) {
        self.trip = trip
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError("nicht aus einem Storyboard") }

    override func loadView() {
        let mapView = MapView()
        mapView.delegate = self
        mapView.currentLocationButtonVisibilityPolicy = .hidden
        mapView.compassButtonVisibilityPolicy = .hidden
        self.mapView = mapView
        view = mapView
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        // CarPlay legt Leisten und Abbiegehinweis über die Karte und meldet
        // das über den sicheren Bereich. Die Mitte der Karte rückt mit.
        let insets = view.safeAreaInsets
        mapView?.contentInsets = NSDirectionalEdgeInsets(
            top: insets.top, leading: insets.left, bottom: insets.bottom, trailing: insets.right
        )
    }

    // MARK: MapViewDelegate

    func mapView(_: MapView, onMapReady map: TomTomMap) {
        self.map = map
        map.locationProvider = positionFeed
        positionFeed.enable()
        map.locationIndicatorType = .navigationChevron(scale: 1)
        map.showTraffic()
        observeTrip()
        redrawRoute(trip.route)
        applyCamera()
    }

    func mapView(_: MapView, onLoadFailed error: Error) {
        print("CarPlay-Karte nicht geladen: \(error.localizedDescription)")
    }

    func mapView(_: MapView, onStyleLoad _: Result<StyleContainer, Error>) {}

    // MARK: Bedienung aus der Szene

    func zoom(in zoomIn: Bool) {
        map?.applyCamera(zoomIn ? CameraUpdate(zoomIn: true) : CameraUpdate(zoomOut: true), animationDuration: 0.25)
    }

    func applyCamera() {
        guard let map else { return }
        if trip.isDriving, !trip.drivingOverview {
            map.cameraTrackingMode = trip.cameraNorthUp ? .followRouteNorthUp() : .followRouteDirection()
        } else {
            map.cameraTrackingMode = .none
            if trip.route != nil {
                map.zoomToRoutes(padding: 40)
            } else if let here = trip.currentLocation {
                map.applyCamera(CameraUpdate(position: here, zoom: 12, tilt: 0, rotation: 0, positionMarkerVerticalOffset: 0))
            }
        }
    }

    // MARK: Private

    private let trip: TripViewModel
    private var mapView: MapView?
    private var map: TomTomMap?
    private var routeOnMap: TomTomSDKMapDisplay.Route?
    private var markers: [TomTomSDKMapDisplay.Marker] = []
    private var cancellables = Set<AnyCancellable>()
    private let positionFeed = SimulatedLocationProvider(delay: Measurement(value: 0.1, unit: UnitDuration.seconds))

    private func observeTrip() {
        trip.$route
            .receive(on: DispatchQueue.main)
            .sink { [weak self] route in MainActor.assumeIsolated { self?.redrawRoute(route) } }
            .store(in: &cancellables)

        // Die Position: während der Fahrt die auf der Route, sonst die eigene.
        trip.$driveFix
            .receive(on: DispatchQueue.main)
            .compactMap { $0?.snapped }
            .sink { [weak self] coordinate in MainActor.assumeIsolated { self?.positionFeed.updateCoordinates([coordinate], interpolate: false) } }
            .store(in: &cancellables)
        trip.$currentLocation
            .receive(on: DispatchQueue.main)
            .compactMap { $0 }
            .sink { [weak self] coordinate in
                MainActor.assumeIsolated {
                    guard let self, !self.trip.isDriving else { return }
                    self.positionFeed.updateCoordinates([coordinate], interpolate: false)
                }
            }
            .store(in: &cancellables)

        trip.$isDriving.removeDuplicates()
            .combineLatest(trip.$drivingOverview.removeDuplicates(), trip.$cameraNorthUp.removeDuplicates())
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _, _, _ in MainActor.assumeIsolated { self?.applyCamera() } }
            .store(in: &cancellables)

        trip.$drivingTiles
            .combineLatest(trip.$chargingPlan)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _, _ in MainActor.assumeIsolated { self?.redrawMarkers() } }
            .store(in: &cancellables)
    }

    private func redrawRoute(_ route: TomTomSDKRoute.Route?) {
        guard let map else { return }
        if let routeOnMap { map.removeRoute(routeOnMap) }
        map.removeRoutes()
        routeOnMap = nil
        if let route {
            var options = RouteOptions(coordinates: route.geometry)
            options.routeWidth = 6
            options.outlineWidth = 1
            options.color = UIColor(hex: 0xB8361F)
            routeOnMap = try? map.addRoute(options)
        }
        applyCamera()
    }

    /// Die Stationen der Kacheln, nummeriert wie auf dem iPhone, und die
    /// geplanten Stopps. Mehr nicht: Im Auto zählt, was als Nächstes kommt.
    private func redrawMarkers() {
        guard let map else { return }
        for marker in markers { map.remove(annotation: marker) }
        markers = []
        var shown = Set<String>()
        for (index, tile) in trip.drivingTiles.enumerated() {
            shown.insert(tile.id)
            add(MarkerOptions(
                coordinate: tile.station.station.coordinate,
                pinImage: MarkerImages.drivingPin(order: index + 1, isPlannedStop: tile.isPlannedStop, isSelected: false),
                tag: tile.id
            ), on: map)
        }
        for stop in trip.chargingPlan?.stops ?? [] where !shown.contains(stop.id) {
            add(MarkerOptions(
                coordinate: stop.station.coordinate,
                pinImage: MarkerImages.drivingPin(order: nil, isPlannedStop: true, isSelected: false),
                tag: stop.id
            ), on: map)
        }
    }

    private func add(_ options: MarkerOptions, on map: TomTomMap) {
        if let marker = try? map.addMarker(options: options) { markers.append(marker) }
    }
}
