//  MapCoordinator.swift
//  Vermittelt zwischen der TomTom-Karte und dem TripViewModel.
//
//  Die Klasse ist @MainActor: SwiftUI ruft makeCoordinator() und makeUIView()
//  ohnehin auf dem Main Actor auf, und das TripViewModel ist dort isoliert.

import Combine
import CoreLocation
import SwiftUI
import TomTomSDKLocationProvider
import TomTomSDKMapDisplay
import TomTomSDKRoute

@MainActor
final class MapCoordinator: NSObject {
    // MARK: Lifecycle

    init(trip: TripViewModel) {
        self.trip = trip
        super.init()
        observeTrip()
    }

    // MARK: Internal

    func attach(mapView: TomTomSDKMapDisplay.MapView) {
        self.mapView = mapView
    }

    // MARK: Private

    private let trip: TripViewModel
    private var mapView: TomTomSDKMapDisplay.MapView?
    private var map: TomTomMap?
    private var routeOnMap: TomTomSDKMapDisplay.Route?
    private var didCenterOnUser = false
    private var cancellables = Set<AnyCancellable>()

    /// Koordinaten der gesetzten Nadeln, in derselben Reihenfolge wie
    /// `trip.stations`. Ein angetippter Marker wird darüber wieder seiner
    /// Station zugeordnet.
    private var markerCoordinates: [(id: String, coordinate: CLLocationCoordinate2D)] = []
}

// MARK: - MapViewDelegate

extension MapCoordinator: TomTomSDKMapDisplay.MapViewDelegate {
    func mapView(_: MapView, onMapReady map: TomTomMap) {
        self.map = map
        map.delegate = self
        map.locationProvider.addObserver(self)
        map.locationIndicatorType = .navigationChevron(scale: 1)
        map.activateLocationProvider()

        // Startausschnitt: Deutschland, bis die erste GPS-Position da ist.
        map.applyCamera(CameraUpdate(
            position: CLLocationCoordinate2D(latitude: 51.3, longitude: 9.5),
            zoom: 5.0,
            tilt: 0,
            rotation: 0,
            positionMarkerVerticalOffset: 0
        ))

        trip.mapIsReady = true
        redrawRoute(trip.route)
        redrawMarkers()
    }

    func mapView(_: MapView, onLoadFailed error: Error) {
        trip.reportError("Karte konnte nicht geladen werden: \(error.localizedDescription)")
    }

    func mapView(_: MapView, onStyleLoad _: Result<StyleContainer, Error>) {}
}

// MARK: - MapDelegate

extension MapCoordinator: TomTomSDKMapDisplay.MapDelegate {
    func map(_: TomTomMap, onInteraction interaction: MapInteraction) {
        switch interaction {
        case let .longPressed(coordinate):
            trip.setDestination(coordinate)
        case let .markerClicked(marker):
            selectStation(nearest: marker.coordinate)
        default:
            break
        }
    }

    func map(_: TomTomMap, onCameraEvent _: CameraEvent) {}

    /// Zuordnung über die Koordinate statt über die Marker-Identität. Das
    /// funktioniert unabhängig davon, ob Marker ein Wert- oder Referenztyp ist.
    private func selectStation(nearest coordinate: CLLocationCoordinate2D) {
        let hit = markerCoordinates
            .map { ($0.id, GeoUtils.distance($0.coordinate, coordinate)) }
            .min { $0.1 < $1.1 }

        // Ein Meter Toleranz reicht: die Koordinate stammt aus derselben Quelle.
        if let hit, hit.1 < 1 {
            trip.selectStation(id: hit.0)
        }
    }
}

// MARK: - Standort

extension MapCoordinator: TomTomSDKLocationProvider.LocationUpdateObserver {
    func didUpdateLocation(location: GeoLocation) {
        trip.currentLocation = location.location.coordinate

        // Nur einmal zentrieren, sonst reißt es dem Nutzer die Karte weg.
        guard !didCenterOnUser else { return }
        didCenterOnUser = true

        map?.applyCamera(
            CameraUpdate(
                position: location.location.coordinate,
                zoom: 11,
                tilt: 0,
                rotation: 0,
                positionMarkerVerticalOffset: 0
            ),
            animationDuration: 1.2
        )
    }

    func onAuthorizationStatusChanged(isGranted: Bool) {
        if !isGranted {
            trip.reportError("Ohne Standortfreigabe kennt die App keinen Startpunkt.")
        }
    }
}

// MARK: - Zeichnen

private extension MapCoordinator {
    func observeTrip() {
        trip.$route
            .receive(on: DispatchQueue.main)
            .sink { [weak self] route in
                MainActor.assumeIsolated { self?.redrawRoute(route) }
            }
            .store(in: &cancellables)

        trip.$stations
            .combineLatest(trip.$selectedStationID)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _, _ in
                MainActor.assumeIsolated { self?.redrawMarkers() }
            }
            .store(in: &cancellables)
    }

    func redrawRoute(_ route: TomTomSDKRoute.Route?) {
        guard let map else { return }

        map.removeRoutes()
        routeOnMap = nil

        guard let route else { return }

        var options = RouteOptions(coordinates: route.geometry)
        options.routeWidth = 6
        options.outlineWidth = 1
        // Signalrot aus dem punktlive-CI. Sollte der Compiler hier einen
        // anderen Typ erwarten, tut es auch die SDK-Vorgabe `.activeRoute`.
        options.color = UIColor(hex: 0xB8361F)

        routeOnMap = try? map.addRoute(options)
        map.zoomToRoutes(padding: 48)
    }

    /// Setzt alle Nadeln neu. Für die Größenordnung dieses Prototyps (bis etwa
    /// 100 Stationen) ist das schnell genug; bei mehr müsste man die Änderungen
    /// einzeln anwenden, statt alles zu löschen.
    func redrawMarkers() {
        guard let map else { return }

        map.removeMarkers()
        markerCoordinates.removeAll()

        for (index, annotated) in trip.stations.enumerated() {
            let image = MarkerImages.stationPin(
                index: index + 1,
                hasEditorial: annotated.hasEditorialContent,
                isSelected: annotated.id == trip.selectedStationID
            )
            // Das Tag ist der vom SDK vorgesehene Weg, einen Marker
            // wiederzuerkennen: MarkerOptions führt es als let, und
            // zoomToMarkers(tag:) adressiert darüber.
            let options = MarkerOptions(
                coordinate: annotated.station.coordinate,
                pinImage: image,
                tag: annotated.id
            )

            if (try? map.addMarker(options: options)) != nil {
                markerCoordinates.append((annotated.id, annotated.station.coordinate))
            }
        }
    }
}
