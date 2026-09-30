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
    /// Der Standortgeber, den die Karte von Haus aus hat, solange eine
    /// Simulation ihn ersetzt.
    /// Jede Nadel, die gerade auf der Karte steht.
    ///
    /// Das SDK hat ein pauschales `removeAnnotations()`, und das hat nicht
    /// alles entfernt: Am 30.09. standen während der Fahrt die neunzig
    /// Nadeln der Liste unter den drei der Fahransicht, und zwei trugen die
    /// Nummer 3. Deshalb werden die Nadeln hier gemerkt und einzeln entfernt.
    private var placedMarkers: [TomTomSDKMapDisplay.Marker] = []
    private var realLocationProvider: (any TomTomSDKLocationProvider.LocationProvider)?
    private var simulatedLocationProvider: TomTomSDKLocationProvider.SimulatedLocationProvider?
}

// MARK: - MapViewDelegate

extension MapCoordinator: TomTomSDKMapDisplay.MapViewDelegate {
    func mapView(_: MapView, onMapReady map: TomTomMap) {
        self.map = map
        map.delegate = self
        map.locationProvider.addObserver(self)
        map.locationIndicatorType = .navigationChevron(scale: 1)
        map.activateLocationProvider()
        // Verkehr auf der Karte: Fluss als farbige Straßen, Meldungen als
        // Symbole. Die Route selbst ist ohnehin mit Verkehrslage geplant;
        // hier sieht man, warum sie so verläuft.
        map.showTraffic()
        map.showTrafficIncidents()

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
        // In der Simulation ist dieser Geber die Quelle der Position: Er fährt
        // die Route ab. Beim echten Fahren kommt sie aus UserLocationSource,
        // die auch im Hintergrund ortet; die Karte zeichnet dann nur.
        if trip.isDriving {
            if trip.isSimulatingDrive { trip.updateDrivePosition(location.location.coordinate) }
            return
        }

        // Sonst nur die Kamera. Die Position zum Planen kommt aus
        // UserLocationSource über CoreLocation.
        //
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

        trip.mapCommands
            .receive(on: DispatchQueue.main)
            .sink { [weak self] command in
                MainActor.assumeIsolated { self?.perform(command) }
            }
            .store(in: &cancellables)

        trip.driveCommands
            .receive(on: DispatchQueue.main)
            .sink { [weak self] command in
                MainActor.assumeIsolated { self?.perform(command) }
            }
            .store(in: &cancellables)

        trip.$drivingOverview
            .dropFirst()
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.trip.isDriving else { return }
                    self.applyDrivingCamera()
                }
            }
            .store(in: &cancellables)

        trip.$cameraNorthUp
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.trip.isDriving else { return }
                    self.applyDrivingCamera()
                }
            }
            .store(in: &cancellables)

        trip.$stations
            .combineLatest(trip.$selectedStationID)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _, _ in
                MainActor.assumeIsolated { self?.redrawMarkers() }
            }
            .store(in: &cancellables)

        // Während der Fahrt zeigt die Karte nur, was in den Kacheln steht.
        // Neu gezeichnet wird, wenn sich die Auswahl ändert, also beim
        // Vorbeifahren, nicht bei jeder Position.
        trip.$drivingTiles
            .map { $0.map(\.id) }
            .removeDuplicates()
            .combineLatest(
                trip.$isDriving.removeDuplicates(),
                trip.$drivingFallback.map { $0?.id }.removeDuplicates()
            )
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _, _, _ in
                MainActor.assumeIsolated { self?.redrawMarkers() }
            }
            .store(in: &cancellables)

        // Der Schalter "nur Favoriten" in der Liste gilt auch für die Karte.
        trip.$listOnlyFavorites
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                MainActor.assumeIsolated { self?.redrawMarkers() }
            }
            .store(in: &cancellables)
    }

    /// Führt einen Kartenbefehl der Oberfläche aus.
    ///
    /// `CameraUpdate` hat zwei Bauformen: eine mit fester Position, Zoomstufe
    /// und Neigung, und eine mit relativen Änderungen. Für die Knöpfe ist die
    /// zweite die richtige, sonst müsste die Oberfläche die aktuelle Zoomstufe
    /// kennen und mitzählen.
    func perform(_ command: TripViewModel.MapCommand) {
        guard let map else { return }

        switch command {
        case .zoomIn:
            map.applyCamera(CameraUpdate(zoomIn: true), animationDuration: 0.25)
        case .zoomOut:
            map.applyCamera(CameraUpdate(zoomOut: true), animationDuration: 0.25)
        case .fitRoute:
            map.zoomToRoutes(padding: 48)
        case .centerOnUser:
            guard let position = trip.currentLocation else { return }
            map.applyCamera(
                CameraUpdate(
                    position: position,
                    zoom: 12,
                    tilt: 0,
                    rotation: 0,
                    positionMarkerVerticalOffset: 0
                ),
                animationDuration: 0.6
            )
        }
    }

    /// Fahrt starten oder beenden.
    ///
    /// Die Kamera führt das SDK selbst nach, in Fahrtrichtung: Das ist der
    /// Modus, den auch die TomTom-Navigation benutzt. Für die Simulation
    /// bekommt die Karte einen simulierten Standortgeber untergeschoben, der
    /// die Route in gleichmäßigen Schritten abfährt; nach dem Ende bekommt
    /// sie ihren eigenen zurück.
    func perform(_ command: TripViewModel.DriveCommand) {
        guard let map else { return }

        switch command {
        case let .start(simulatedPath):
            if let simulatedPath, !simulatedPath.isEmpty {
                let simulated = TomTomSDKLocationProvider.SimulatedLocationProvider(
                    delay: Measurement(value: TripViewModel.simulationTickSeconds, unit: UnitDuration.seconds)
                )
                simulated.updateCoordinates(simulatedPath, interpolate: false)
                // Vom echten Geber abmelden: Er meldet weiter, im Simulator
                // den gesetzten Standort, und die beiden Positionen würden
                // sich abwechseln.
                let real = map.locationProvider
                real.removeObserver(self)
                realLocationProvider = real
                map.locationProvider = simulated
                simulated.addObserver(self)
                simulated.enable()
                simulatedLocationProvider = simulated
            }
            // Der Standortknopf des SDK blinkte während der Fahrt: Die Kamera
            // folgt, ist aber nie ganz zentriert, und "hiddenWhenCentered"
            // schaltete ihn im Takt der Positionen an und aus. Während der
            // Fahrt übernehmen "Zur Fahrt" und der Kameraknopf seine Aufgabe.
            mapView?.currentLocationButtonVisibilityPolicy = .hidden
            applyDrivingCamera()

        case let .updateSimulatedPath(path):
            simulatedLocationProvider?.updateCoordinates(path, interpolate: false)

        case .stop:
            mapView?.currentLocationButtonVisibilityPolicy = .hiddenWhenCentered
            map.cameraTrackingMode = .none
            if let simulated = simulatedLocationProvider {
                simulated.removeObserver(self)
                simulated.disable()
                simulatedLocationProvider = nil
            }
            if let real = realLocationProvider {
                map.locationProvider = real
                real.addObserver(self)
                realLocationProvider = nil
            }
            map.zoomToRoutes(padding: 48)
        }
    }

    /// Die Kamera während der Fahrt.
    ///
    /// Zuerst lief .followDirection(): Richtung aus der GPS-Position, flach
    /// von oben. Bei jeder kleinen Kurve drehte sich die Karte mit, und aus
    /// der Vogelperspektive war nicht zu erkennen, was vorn kommt. Der
    /// Routenmodus ist der, den die TomTom-Navigation benutzt: Die Richtung
    /// kommt aus der Route, Neigung und Zoom richten sich nach der Straßenart.
    /// Norden oben ist die Wahl für alle, die die Karte lieber stehen lassen.
    func applyDrivingCamera() {
        guard let map else { return }
        // In der Übersicht folgt die Kamera nicht; sie zeigt die ganze Route,
        // und Plus und Minus zoomen frei.
        if trip.drivingOverview {
            map.cameraTrackingMode = .none
            map.zoomToRoutes(padding: 48)
            return
        }
        map.cameraTrackingMode = trip.cameraNorthUp ? .followRouteNorthUp() : .followRouteDirection()
    }

    func redrawRoute(_ route: TomTomSDKRoute.Route?) {
        guard let map else { return }

        // Erst die eigene Linie gezielt, dann alles: removeRoutes() allein hat
        // nach "Route verwerfen" die Linie stehen lassen (30.09.2026), wie
        // vorher removeAnnotations() die Nadeln.
        if let routeOnMap { map.removeRoute(routeOnMap) }
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
        // Während der Fahrt ist es eine Umleitung: Die Kamera folgt weiter
        // dem Auto, auf der neuen Linie, statt auf die ganze Strecke zu zoomen.
        if trip.isDriving {
            applyDrivingCamera()
        } else {
            map.zoomToRoutes(padding: 48)
        }
    }

    /// Setzt alle Nadeln neu. Für die Größenordnung dieses Prototyps (bis etwa
    /// 100 Stationen) ist das schnell genug; bei mehr müsste man die Änderungen
    /// einzeln anwenden, statt alles zu löschen.
    func redrawMarkers() {
        guard let map else { return }

        clearMarkers(on: map)

        if trip.isDriving {
            redrawDrivingMarkers(on: map)
            return
        }

        for (index, annotated) in trip.stationsForList.enumerated() {
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

            place(options, on: map)
        }
    }

    /// Setzt eine Nadel und merkt sie sich.
    func place(_ options: MarkerOptions, on map: TomTomMap) {
        if let marker = try? map.addMarker(options: options) {
            placedMarkers.append(marker)
        }
    }

    /// Entfernt jede gemerkte Nadel einzeln, dann zur Sicherheit pauschal.
    func clearMarkers(on map: TomTomMap) {
        for marker in placedMarkers {
            map.remove(annotation: marker)
        }
        placedMarkers.removeAll()
        map.removeAnnotations()
    }

    /// Während der Fahrt: die Stationen der Kacheln, nummeriert wie die
    /// Kacheln, und die geplanten Ladestopps. Sonst nichts; neunzig Nadeln
    /// entlang der Strecke erzählen etwas anderes als drei Kacheln.
    func redrawDrivingMarkers(on map: TomTomMap) {
        var shown = Set<String>()

        for (index, tile) in trip.drivingTiles.enumerated() {
            shown.insert(tile.id)
            let options = MarkerOptions(
                coordinate: tile.station.station.coordinate,
                pinImage: MarkerImages.drivingPin(
                    order: index + 1,
                    isPlannedStop: tile.isPlannedStop,
                    isSelected: tile.id == trip.selectedStationID
                ),
                tag: tile.id
            )
            place(options, on: map)
        }

        if let fallback = trip.drivingFallback {
            shown.insert(fallback.id)
            place(MarkerOptions(
                coordinate: fallback.station.station.coordinate,
                pinImage: MarkerImages.fallbackPin(isSelected: fallback.id == trip.selectedStationID),
                tag: fallback.id
            ), on: map)
        }

        let progress = trip.driveFix?.progressMeters ?? 0
        for item in trip.stations
        where trip.plannedStopIDs.contains(item.id) && !shown.contains(item.id)
            && (item.station.progressAlongRouteMeters ?? 0) > progress {
            let options = MarkerOptions(
                coordinate: item.station.coordinate,
                pinImage: MarkerImages.drivingPin(
                    order: nil,
                    isPlannedStop: true,
                    isSelected: item.id == trip.selectedStationID
                ),
                tag: item.id
            )
            place(options, on: map)
        }
    }
}
