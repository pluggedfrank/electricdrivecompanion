//  CarPlaySceneDelegate.swift
//  Die App im Auto: Karte, Abbiegehinweis, Ziele und die nächsten Lader.
//
//  CarPlay erlaubt nur Apples Vorlagen und eine eigene Karte darunter. Was
//  hier steht, ist deshalb schmaler als auf dem iPhone:
//  - Karte mit Route, Pfeil und den Stationen der Kacheln
//    (CarPlayMapController)
//  - vor der Fahrt: "Ziele" (Zuhause, Arbeit, Gespeichert, Zuletzt) und
//    "Losfahren"; Tippen auf ein Ziel plant die Route
//  - während der Fahrt: der Abbiegehinweis mit Strecke, den viele Autos auch
//    im Kombiinstrument zeigen, Ankunft und Restkilometer, "Lader" mit den
//    nächsten Stationen (Antippen führt über die Station) und "Beenden"
//
//  Eine Fahrt, die am iPhone beginnt, läuft im Auto weiter und umgekehrt:
//  Beide Oberflächen hängen am selben Modell (AppModel).
//
//  Ins Auto kommt die App erst mit Apples Freischaltung für Navigation
//  (com.apple.developer.carplay-maps). Bis dahin nur im Simulator:
//  I/O, External Displays, CarPlay.

import CarPlay
import Combine
import MapKit
import UIKit

final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate, CPMapTemplateDelegate {
    // MARK: CPTemplateApplicationSceneDelegate

    func templateApplicationScene(
        _: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController,
        to window: CPWindow
    ) {
        self.interfaceController = interfaceController
        trip.startLocating()

        let controller = CarPlayMapController(trip: trip)
        window.rootViewController = controller
        mapController = controller

        let template = CPMapTemplate()
        template.mapDelegate = self
        template.automaticallyHidesNavigationBar = false
        mapTemplate = template
        interfaceController.setRootTemplate(template, animated: false, completion: nil)

        observeTrip()
        updateButtons()
        if trip.isDriving { startSession() }
    }

    func templateApplicationScene(
        _: CPTemplateApplicationScene,
        didDisconnect _: CPInterfaceController,
        from _: CPWindow
    ) {
        cancellables.removeAll()
        session = nil
        cpTrip = nil
        mapTemplate = nil
        mapController = nil
        interfaceController = nil
    }

    // MARK: Private

    private var trip: TripViewModel { AppModel.shared.trip }
    private var interfaceController: CPInterfaceController?
    private var mapTemplate: CPMapTemplate?
    private var mapController: CarPlayMapController?
    private var session: CPNavigationSession?
    private var cpTrip: CPTrip?
    private var currentManeuverID: Int?
    private var currentManeuver: CPManeuver?
    private var lastEstimateUpdate = Date.distantPast
    private var cancellables = Set<AnyCancellable>()

    private func observeTrip() {
        trip.$isDriving.removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] driving in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if driving { self.startSession() } else { self.finishSession() }
                    self.updateButtons()
                }
            }
            .store(in: &cancellables)

        trip.$route
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.updateButtons() } }
            .store(in: &cancellables)

        trip.$nextManeuver
            .receive(on: DispatchQueue.main)
            .sink { [weak self] maneuver in MainActor.assumeIsolated { self?.showManeuver(maneuver) } }
            .store(in: &cancellables)

        trip.$drivingOverview.removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.updateMapButtons() } }
            .store(in: &cancellables)
    }

    // MARK: Leisten

    private func updateButtons() {
        guard let mapTemplate else { return }
        if trip.isDriving {
            mapTemplate.leadingNavigationBarButtons = [barButton("Lader") { [weak self] in self?.showChargers() }]
            mapTemplate.trailingNavigationBarButtons = [barButton("Beenden") { [weak self] in self?.trip.stopDriving() }]
        } else {
            mapTemplate.leadingNavigationBarButtons = [barButton("Ziele") { [weak self] in self?.showDestinations() }]
            var trailing: [CPBarButton] = []
            if trip.route != nil {
                trailing.append(barButton("Losfahren") { [weak self] in self?.trip.startDriving(simulated: false) })
                #if DEBUG
                // Zum Ausprobieren im Simulator, wo sich sonst nichts bewegt.
                trailing.append(barButton("Simulieren") { [weak self] in self?.trip.startDriving(simulated: true) })
                #endif
            }
            mapTemplate.trailingNavigationBarButtons = trailing
        }
        updateMapButtons()
    }

    /// Rechts auf der Karte: Ansicht wechseln, in der Gesamtroute zoomen.
    private func updateMapButtons() {
        guard let mapTemplate else { return }
        var buttons: [CPMapButton] = []
        if trip.isDriving {
            let view = CPMapButton { [weak self] _ in
                guard let self else { return }
                // Reihum: Fahrtrichtung, Norden oben, Gesamtroute.
                let all = TripViewModel.CameraMode.allCases
                let next = all[((all.firstIndex(of: self.trip.cameraMode) ?? 0) + 1) % all.count]
                self.trip.cameraMode = next
                self.mapController?.applyCamera()
            }
            view.image = UIImage(systemName: trip.cameraMode.symbolName)
            buttons.append(view)
        }
        if !trip.isDriving || trip.drivingOverview {
            let plus = CPMapButton { [weak self] _ in self?.mapController?.zoom(in: true) }
            plus.image = UIImage(systemName: "plus")
            let minus = CPMapButton { [weak self] _ in self?.mapController?.zoom(in: false) }
            minus.image = UIImage(systemName: "minus")
            buttons += [plus, minus]
        }
        mapTemplate.mapButtons = buttons
    }

    private func barButton(_ title: String, action: @escaping () -> Void) -> CPBarButton {
        CPBarButton(title: title) { _ in action() }
    }

    // MARK: Listen

    private func showDestinations() {
        let store = trip.savedPlaces
        var sections: [CPListSection] = []

        let top = [PlaceCategory.home, .work].compactMap { store.place(for: $0) }
        if !top.isEmpty { sections.append(CPListSection(items: top.map(placeItem))) }
        let saved = store.places.filter { !$0.category.isSingle }
        if !saved.isEmpty {
            sections.append(CPListSection(items: saved.map(placeItem), header: "Gespeichert", sectionIndexTitle: nil))
        }
        if !store.recents.isEmpty {
            sections.append(CPListSection(items: store.recents.map(placeItem), header: "Zuletzt", sectionIndexTitle: nil))
        }
        if sections.isEmpty {
            let hint = CPListItem(text: "Noch keine Ziele", detailText: "Auf dem iPhone ein Ziel suchen oder speichern")
            sections.append(CPListSection(items: [hint]))
        }
        let list = CPListTemplate(title: "Ziele", sections: sections)
        interfaceController?.pushTemplate(list, animated: true, completion: nil)
    }

    private func placeItem(_ place: SavedPlace) -> CPListItem {
        let item = CPListItem(text: place.name, detailText: place.address, image: UIImage(systemName: place.category.symbolName))
        item.handler = { [weak self] _, completion in
            self?.trip.chooseSaved(place)
            self?.interfaceController?.popToRootTemplate(animated: true, completion: nil)
            completion()
        }
        return item
    }

    /// Die nächsten Lader: während der Fahrt die Kacheln und die
    /// Ausweichzeile, vorher die ersten Stationen entlang der Route.
    private func showChargers() {
        var items: [CPListItem] = []
        let tiles = trip.drivingTiles
        for tile in tiles {
            items.append(chargerItem(
                id: tile.id,
                title: "\(kmText(tile.meters)) · \(tile.station.station.name)",
                detail: chargerDetail(tile.station, arrival: tile.arrivalPercent, planned: tile.isPlannedStop)
            ))
        }
        if let fallback = trip.drivingFallback {
            items.append(chargerItem(
                id: fallback.id,
                title: "Ausweichen: \(kmText(fallback.meters)) · \(fallback.station.station.name)",
                detail: chargerDetail(fallback.station, arrival: fallback.arrivalPercent, planned: false)
            ))
        }
        if items.isEmpty {
            items = [CPListItem(text: "Keine passenden Lader voraus", detailText: nil)]
        }
        let list = CPListTemplate(title: "Nächste Lader", sections: [CPListSection(items: items)])
        interfaceController?.pushTemplate(list, animated: true, completion: nil)
    }

    private func chargerItem(id: String, title: String, detail: String) -> CPListItem {
        let item = CPListItem(text: title, detailText: detail, image: UIImage(systemName: "bolt.car.fill"))
        item.handler = { [weak self] _, completion in
            self?.trip.routeVia(stationID: id)
            self?.interfaceController?.popToRootTemplate(animated: true, completion: nil)
            completion()
        }
        return item
    }

    private func chargerDetail(_ item: AnnotatedStation, arrival: Double, planned: Bool) -> String {
        var parts: [String] = []
        if planned { parts.append("geplant") }
        if let kw = item.station.maxPowerKW { parts.append("\(Int(kw)) kW") }
        if let free = item.availabilityText { parts.append(free) } else if let size = item.sizeText { parts.append(size) }
        parts.append("\(max(0, Int(arrival.rounded()))) % bei Ankunft")
        return parts.joined(separator: " · ")
    }

    private func kmText(_ meters: Double) -> String {
        let km = max(0, meters / 1000)
        return km < 10 ? String(format: "%.1f km", km).replacingOccurrences(of: ".", with: ",") : "\(Int(km.rounded())) km"
    }

    // MARK: Zielführung

    private func startSession() {
        guard let mapTemplate, session == nil, let destination = trip.destination else { return }
        let origin = trip.driveFix?.snapped ?? trip.currentLocation ?? trip.route?.geometry.first ?? destination
        let destinationItem = MKMapItem(placemark: MKPlacemark(coordinate: destination))
        destinationItem.name = trip.chosenPlaceName ?? "Ziel"
        let choice = CPRouteChoice(
            summaryVariants: [trip.chosenPlaceName ?? "Ziel"],
            additionalInformationVariants: [],
            selectionSummaryVariants: []
        )
        let newTrip = CPTrip(
            origin: MKMapItem(placemark: MKPlacemark(coordinate: origin)),
            destination: destinationItem,
            routeChoices: [choice]
        )
        cpTrip = newTrip
        session = mapTemplate.startNavigationSession(for: newTrip)
        currentManeuverID = nil
        showManeuver(trip.nextManeuver)
    }

    private func finishSession() {
        session?.finishTrip()
        session = nil
        cpTrip = nil
        currentManeuverID = nil
        currentManeuver = nil
    }

    /// Der Abbiegehinweis: neu, wenn die Anweisung wechselt, sonst nur die
    /// Strecke bis dahin. Dazu Ankunft und Rest für die Fahrt, höchstens alle
    /// fünf Sekunden, das genügt der Anzeige.
    private func showManeuver(_ maneuver: TripViewModel.Maneuver?) {
        guard let session else { return }
        guard let maneuver else {
            session.upcomingManeuvers = []
            currentManeuverID = nil
            currentManeuver = nil
            return
        }
        let estimates = CPTravelEstimates(
            distanceRemaining: Measurement(value: maneuver.distanceMeters, unit: UnitLength.meters),
            timeRemaining: 0
        )
        if maneuver.instruction.id != currentManeuverID {
            let cp = CPManeuver()
            cp.instructionVariants = [maneuver.instruction.text]
            cp.symbolImage = UIImage(systemName: maneuver.instruction.symbolName)
            cp.initialTravelEstimates = estimates
            session.upcomingManeuvers = [cp]
            currentManeuver = cp
            currentManeuverID = maneuver.instruction.id
        } else if let current = currentManeuver {
            session.updateEstimates(estimates, for: current)
        }

        let now = Date()
        if now.timeIntervalSince(lastEstimateUpdate) >= 5, let cpTrip, let mapTemplate {
            lastEstimateUpdate = now
            let tripEstimates = CPTravelEstimates(
                distanceRemaining: Measurement(value: trip.remainingKm, unit: UnitLength.kilometers),
                timeRemaining: trip.remainingSeconds ?? 0
            )
            mapTemplate.update(tripEstimates, for: cpTrip, with: trip.trafficDelaySeconds >= 60 ? .orange : .default)
        }
    }
}
