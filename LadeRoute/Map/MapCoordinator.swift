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
        case let .tappedOnAnnotation(annotation, _):
            // Es gibt keinen eigenen Marker-Fall. Getippt wurde auf eine
            // Annotation, und das Protokoll führt das Tag, das beim Anlegen
            // die Stations-ID bekommen hat. Die Koordinate im Ereignis ist die
            // Tap-Stelle, nicht die Nadel; über sie zu suchen wäre umständlich
            // und ungenau.
            if let id = annotation.tag {
                trip.selectStation(id: id)
            }
        default:
            break
        }
    }

    func map(_: TomTomMap, onCameraEvent _: CameraEvent) {}
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
        // Signalrot aus dem Haus-CI. Der Typ ist geprüft, RouteOptions.color
        // nimmt eine UIColor.
        options.color = UIColor(hex: 0xB8361F)

        routeOnMap = try? map.addRoute(options)
        map.zoomToRoutes(padding: 48)
    }

    /// Setzt alle Nadeln neu. Für die Größenordnung dieses Prototyps (bis etwa
    /// 100 Stationen) ist das schnell genug; bei mehr müsste man die Änderungen
    /// einzeln anwenden, statt alles zu löschen.
    func redrawMarkers() {
        guard let map else { return }

        // Marker sind im SDK Annotationen, es gibt kein removeMarkers.
        map.removeAnnotations()

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

            // Der Rückgabewert wird nicht gebraucht: Adressiert wird über
            // das Tag, entfernt wird über removeAnnotations().
            _ = try? map.addMarker(options: options)
        }
    }
}
