//  CarPlaySceneDelegate.swift
//  Die App im Auto: Karte, Abbiegehinweis, Ziele und die nächsten Lader.
//
//  CarPlay erlaubt nur Apples Vorlagen und eine eigene Karte darunter. Was
//  hier steht, ist deshalb schmaler als auf dem iPhone:
//  - Karte mit Route, Pfeil und den Stationen der Kacheln
//    (CarPlayMapController)
//  - vor der Fahrt: "Ziele" (Zuhause, Arbeit, Gespeichert, Zuletzt) und
//    "Suchen"; ein gewähltes Ziel erscheint als Fahrtvorschau mit
//    "Losfahren", wie Apple den Ablauf vorgibt
//  - während der Fahrt: der Abbiegehinweis mit Strecke, den viele Autos auch
//    im Kombiinstrument zeigen, Ankunft und Restkilometer, "Lader" mit den
//    nächsten Stationen (Antippen führt über die Station) und "Beenden"
//
//  Eine Fahrt, die am iPhone beginnt, läuft im Auto weiter und umgekehrt:
//  Beide Oberflächen hängen am selben Modell (AppModel).
//
//  Apples Regeln (CarPlay Developer Guide, Juni 2026), die hier greifen:
//  - Die Karte zeigt nur Karte; alles andere kommt aus Apples Vorlagen.
//  - Nie dazu auffordern, das iPhone in die Hand zu nehmen; jeder Ablauf
//    geht ohne iPhone, deshalb die Suche im Auto.
//  - Beendet das Auto die Zielführung (etwa weil das eingebaute Navi
//    startet), endet sie hier sofort.
//  - Schätzungen nur senden, wenn sich die Anzeige ändert.
//  - Abbiegesymbole mit hellem und dunklem Bild.
//
//  Ins Auto kommt die App erst mit Apples Freischaltung für Navigation
//  (com.apple.developer.carplay-maps). Bis dahin nur im Simulator:
//  I/O, External Displays, CarPlay.

import CarPlay
import Combine
import MapKit
import UIKit

final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate, CPMapTemplateDelegate,
    CPSearchTemplateDelegate
{
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
        searchTask?.cancel()
        session = nil
        cpTrip = nil
        awaitingPreview = false
        previewShown = false
        mapTemplate = nil
        mapController = nil
        interfaceController = nil
    }

    // MARK: CPMapTemplateDelegate

    /// "Losfahren" in der Fahrtvorschau.
    func mapTemplate(_: CPMapTemplate, startedTrip _: CPTrip, using _: CPRouteChoice) {
        mapTemplate?.hideTripPreviews()
        previewShown = false
        #if targetEnvironment(simulator)
        // Im Simulator steht der Standort still; ohne Simulation bewegt sich nichts.
        trip.startDriving(simulated: true)
        #else
        trip.startDriving(simulated: false)
        #endif
    }

    /// Das Auto hat die Zielführung beendet, etwa weil das eingebaute Navi
    /// übernimmt. Apple verlangt: sofort aufhören.
    func mapTemplateDidCancelNavigation(_: CPMapTemplate) {
        session = nil
        cpTrip = nil
        trip.stopDriving()
    }

    // MARK: CPSearchTemplateDelegate

    func searchTemplate(
        _: CPSearchTemplate,
        updatedSearchText searchText: String,
        completionHandler: @escaping ([CPListItem]) -> Void
    ) {
        searchTask?.cancel()
        let text = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 3 else {
            completionHandler([])
            return
        }
        // Erst suchen, wenn das Tippen kurz ruht: Jede Anfrage zählt gegen
        // das Kontingent der Search-API.
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            guard let self, !Task.isCancelled else { return }
            let places = await self.trip.findPlaces(text)
            guard !Task.isCancelled else { return }
            completionHandler(places.map { place in
                let item = CPListItem(text: place.title, detailText: place.subtitle, image: UIImage(systemName: "mappin"))
                item.userInfo = place
                return item
            })
        }
    }

    func searchTemplate(_: CPSearchTemplate, selectedResult item: CPListItem, completionHandler: @escaping () -> Void) {
        if let place = item.userInfo as? Place {
            awaitingPreview = true
            trip.choosePlace(place)
        }
        interfaceController?.popToRootTemplate(animated: true, completion: nil)
        completionHandler()
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
    private var maneuverEstimateKey: Int?
    private var tripEstimateKey: String?
    private var searchTask: Task<Void, Never>?
    private var sessionPaused = false
    /// Im Auto ein Ziel gewählt: Sobald die Route steht, kommt die Vorschau.
    private var awaitingPreview = false
    private var previewShown = false
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
            .sink { [weak self] route in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.updateButtons()
                    if route == nil {
                        if self.previewShown { self.mapTemplate?.hideTripPreviews() }
                        self.previewShown = false
                    } else if (self.awaitingPreview || self.previewShown), !self.trip.isDriving {
                        self.showPreview()
                    }
                }
            }
            .store(in: &cancellables)

        // Der Ladeplan kommt nach der Route; die Vorschau zeigt dann die Stopps.
        trip.$chargingPlan
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.previewShown, !self.trip.isDriving else { return }
                    self.showPreview()
                }
            }
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
            mapTemplate.leadingNavigationBarButtons = [
                barButton("Ziele") { [weak self] in self?.showDestinations() },
                barButton("Suchen") { [weak self] in self?.showSearch() },
            ]
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
            let hint = CPListItem(text: "Noch keine Ziele", detailText: "Mit „Suchen“ ein Ziel finden")
            sections.append(CPListSection(items: [hint]))
        }
        let list = CPListTemplate(title: "Ziele", sections: sections)
        interfaceController?.pushTemplate(list, animated: true, completion: nil)
    }

    private func placeItem(_ place: SavedPlace) -> CPListItem {
        let item = CPListItem(text: place.name, detailText: place.address, image: UIImage(systemName: place.category.symbolName))
        item.handler = { [weak self] _, completion in
            self?.awaitingPreview = true
            self?.trip.chooseSaved(place)
            self?.interfaceController?.popToRootTemplate(animated: true, completion: nil)
            completion()
        }
        return item
    }

    private func showSearch() {
        let search = CPSearchTemplate()
        search.delegate = self
        interfaceController?.pushTemplate(search, animated: true, completion: nil)
    }

    // MARK: Fahrtvorschau

    /// Die Vorschau mit Länge, Fahrzeit und Ladestopps; darunter zeigt die
    /// Karte die ganze Route.
    private func showPreview() {
        guard let mapTemplate, let route = trip.route, let destination = trip.destination else { return }
        awaitingPreview = false
        let km = route.summary.length.converted(to: .kilometers).value
        let seconds = route.summary.travelTime.converted(to: .seconds).value
        let delayMinutes = Int(route.summary.trafficDelay.converted(to: .minutes).value.rounded())

        var details: [String] = []
        if let stops = trip.chargingPlan?.stops.count {
            details.append(stops == 0 ? "ohne Ladestopp" : stops == 1 ? "1 Ladestopp" : "\(stops) Ladestopps")
        }
        if delayMinutes >= 1 { details.append("+\(delayMinutes) min Stau") }

        let choice = CPRouteChoice(
            summaryVariants: ["\(Int(km.rounded())) km · \(durationText(seconds))", "\(Int(km.rounded())) km"],
            additionalInformationVariants: details.isEmpty ? [] : [details.joined(separator: " · ")],
            selectionSummaryVariants: []
        )
        let preview = makeTrip(to: destination, choice: choice)
        cpTrip = preview
        mapTemplate.showTripPreviews([preview], textConfiguration: CPTripPreviewTextConfiguration(
            startButtonTitle: "Losfahren", additionalRoutesButtonTitle: nil, overviewButtonTitle: nil
        ))
        mapTemplate.updateEstimates(
            CPTravelEstimates(distanceRemaining: Measurement(value: km, unit: UnitLength.kilometers), timeRemaining: seconds),
            for: preview
        )
        previewShown = true
    }

    private func makeTrip(to destination: CLLocationCoordinate2D, choice: CPRouteChoice) -> CPTrip {
        let origin = trip.driveFix?.snapped ?? trip.currentLocation ?? trip.route?.geometry.first ?? destination
        let destinationItem = MKMapItem(placemark: MKPlacemark(coordinate: destination))
        destinationItem.name = trip.chosenPlaceName ?? "Ziel"
        return CPTrip(
            origin: MKMapItem(placemark: MKPlacemark(coordinate: origin)),
            destination: destinationItem,
            routeChoices: [choice]
        )
    }

    private func durationText(_ seconds: Double) -> String {
        let minutes = Int((seconds / 60).rounded())
        return minutes < 60 ? "\(minutes) min" : "\(minutes / 60) h \(String(format: "%02d", minutes % 60)) min"
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
        if previewShown {
            mapTemplate.hideTripPreviews()
            previewShown = false
        }
        awaitingPreview = false
        // Die Fahrt aus der Vorschau, oder eine neue, wenn am iPhone gestartet.
        let newTrip = cpTrip ?? makeTrip(to: destination, choice: CPRouteChoice(
            summaryVariants: [trip.chosenPlaceName ?? "Ziel"],
            additionalInformationVariants: [],
            selectionSummaryVariants: []
        ))
        cpTrip = newTrip
        session = mapTemplate.startNavigationSession(for: newTrip)
        sessionPaused = false
        currentManeuverID = nil
        maneuverEstimateKey = nil
        tripEstimateKey = nil
        showManeuver(trip.nextManeuver)
    }

    private func finishSession() {
        session?.finishTrip()
        session = nil
        cpTrip = nil
        currentManeuverID = nil
        currentManeuver = nil
        maneuverEstimateKey = nil
        tripEstimateKey = nil
    }

    /// Der Abbiegehinweis: neu, wenn die Anweisung wechselt, sonst nur die
    /// Strecke bis dahin, und die nur, wenn sich die Anzeige ändert. Dazu
    /// Ankunft und Rest für die Fahrt, ebenso nur bei Änderung.
    private func showManeuver(_ maneuver: TripViewModel.Maneuver?) {
        guard let session else { return }
        guard let maneuver else {
            // Noch keine Anweisungen, oder die Route wird neu berechnet:
            // CarPlay zeigt dann den passenden Wartezustand.
            if !sessionPaused {
                session.upcomingManeuvers = []
                session.pauseTrip(for: trip.isRerouting ? .rerouting : .loading, description: nil)
                sessionPaused = true
            }
            currentManeuverID = nil
            currentManeuver = nil
            maneuverEstimateKey = nil
            return
        }
        let estimates = CPTravelEstimates(
            distanceRemaining: Measurement(value: maneuver.distanceMeters, unit: UnitLength.meters),
            timeRemaining: 0
        )
        if maneuver.instruction.id != currentManeuverID {
            sessionPaused = false
            let cp = CPManeuver()
            // Längste zuerst: CarPlay zeigt die längste, die passt.
            let display = maneuver.instruction.display
            let compact = [display.action, display.headline].compactMap { $0 }.joined(separator: " · ")
            var variants: [String] = []
            for v in [maneuver.instruction.text, compact, display.headline].sorted(by: { $0.count > $1.count })
                where !variants.contains(v) { variants.append(v) }
            cp.instructionVariants = variants
            cp.symbolImage = Self.maneuverImage(maneuver.instruction.symbolName)
            cp.initialTravelEstimates = estimates
            session.upcomingManeuvers = [cp]
            currentManeuver = cp
            currentManeuverID = maneuver.instruction.id
            maneuverEstimateKey = Self.distanceKey(maneuver.distanceMeters)
        } else if let current = currentManeuver {
            let key = Self.distanceKey(maneuver.distanceMeters)
            if key != maneuverEstimateKey {
                maneuverEstimateKey = key
                session.updateEstimates(estimates, for: current)
            }
        }

        if let cpTrip, let mapTemplate {
            let seconds = trip.remainingSeconds ?? 0
            let jammed = trip.trafficDelaySeconds >= 60
            let key = "\(Int(trip.remainingKm))|\(Int(seconds / 60))|\(jammed)"
            if key != tripEstimateKey {
                tripEstimateKey = key
                let tripEstimates = CPTravelEstimates(
                    distanceRemaining: Measurement(value: trip.remainingKm, unit: UnitLength.kilometers),
                    timeRemaining: seconds
                )
                mapTemplate.update(tripEstimates, for: cpTrip, with: jammed ? .orange : .default)
            }
        }
    }

    /// Stufen, in denen die Anzeige springt: unter einem Kilometer 50 m,
    /// darüber 100 m.
    private static func distanceKey(_ meters: Double) -> Int {
        meters < 1000 ? Int(meters / 50) : 1000 + Int(meters / 100)
    }

    /// Das Abbiegesymbol, schwarz auf hellem und weiß auf dunklem Grund.
    /// CarPlay wählt aus dem Bildsatz, was zum Auto passt.
    private static func maneuverImage(_ name: String) -> UIImage? {
        let config = UIImage.SymbolConfiguration(pointSize: 36, weight: .semibold)
        guard let base = UIImage(systemName: name, withConfiguration: config) else { return nil }
        let asset = UIImageAsset()
        asset.register(base.withTintColor(.black, renderingMode: .alwaysOriginal), with: UITraitCollection(userInterfaceStyle: .light))
        asset.register(base.withTintColor(.white, renderingMode: .alwaysOriginal), with: UITraitCollection(userInterfaceStyle: .dark))
        return asset.image(with: UITraitCollection(userInterfaceStyle: .light))
    }
}
