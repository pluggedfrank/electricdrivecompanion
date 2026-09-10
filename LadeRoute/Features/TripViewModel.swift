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
        editorialStore: EditorialStore = .loadBundled(),
        // nil und nicht VehicleProfileStore(): Ein Vorgabewert im
        // Parameterkopf wird außerhalb des Actors ausgewertet, und der Speicher
        // ist @MainActor. Angelegt wird er deshalb hier drinnen.
        vehicleStore: VehicleProfileStore? = nil
    ) {
        self.apiKey = apiKey
        self.editorialStore = editorialStore
        self.vehicleStore = vehicleStore ?? VehicleProfileStore()
        api = TomTomAPIClient(apiKey: apiKey)
        routePlanner = RoutePlannerService(apiKey: apiKey)

        // Ohne receive(on:): Die Quelle ist selbst @MainActor und veröffentlicht
        // dort, ein Umweg über die Queue brächte nur eine Bildschirmaktualisierung
        // Verzögerung.
        locationSource.$coordinate.assign(to: &$currentLocation)

        // Nicht bei jedem Tastendruck eine Anfrage: Ein Ziel einzutippen wären
        // sonst zwanzig Aufrufe für ein Ergebnis. 350 ms ist die Pause, nach
        // der jemand aufgehört hat zu tippen.
        $destinationQuery
            .debounce(for: .milliseconds(350), scheduler: DispatchQueue.main)
            .removeDuplicates()
            .sink { [weak self] text in self?.startPlaceSearch(text) }
            .store(in: &cancellables)

        // Ein geändertes Fahrzeug ändert die Ladeplanung, nicht die Suche.
        //
        // self. ist hier Pflicht: Im Initialisierer meint der schlichte Name
        // den Parameter, und der ist optional.
        self.vehicleStore.$profile
            .dropFirst()
            .sink { [weak self] _ in self?.planCharging() }
            .store(in: &cancellables)
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
    /// Was angezeigt wird: die gefundenen Treffer, gefiltert.
    @Published private(set) var stations: [AnnotatedStation] = []
    @Published var selectedStationID: String?
    /// Der eigene Standort. Kommt aus `UserLocationSource` und nirgends sonst;
    /// zwei Schreiber auf derselben Angabe wären eine Fehlersuche wert, die
    /// niemand führen will.
    @Published private(set) var currentLocation: CLLocationCoordinate2D?
    @Published var destination: CLLocationCoordinate2D?

    /// Wo geladen werden muss, damit die Strecke aufgeht.
    @Published private(set) var chargingPlan: ChargingPlan?

    /// Das Fahrzeug. Die Oberfläche darf es bearbeiten, die Planung hört zu.
    let vehicleStore: VehicleProfileStore

    /// Kennungen der geplanten Stopps, für die Kennzeichnung in Liste und Karte.
    var plannedStopIDs: Set<String> {
        Set(chargingPlan?.stops.map(\.station.id) ?? [])
    }

    /// Was im Suchfeld steht.
    @Published var destinationQuery = ""
    @Published private(set) var placeResults: [Place] = []
    @Published private(set) var isSearchingPlaces = false
    /// Was die Oberfläche der Karte auftragen kann.
    ///
    /// Als Befehl und nicht als Zustand: Zweimal hintereinander hineinzoomen
    /// sind zwei Ereignisse, ein @Published-Wert würde beim zweiten Mal nichts
    /// melden, weil er sich nicht geändert hat.
    enum MapCommand {
        case zoomIn
        case zoomOut
        /// Ganze Route ins Bild.
        case fitRoute
        case centerOnUser
    }

    let mapCommands = PassthroughSubject<MapCommand, Never>()

    /// Name des zuletzt gewählten Ziels, für die Kopfzeile. Beim Ziel per
    /// langem Druck gibt es keinen.
    @Published private(set) var chosenPlaceName: String?
    @Published var mapIsReady = false
    @Published var mapBottomInset: CGFloat = 0

    /// Läuft gerade die zweite Suchrunde im Umkreis?
    ///
    /// Die Suche läuft zweistufig: Zuerst die Along-Route-Suche, sieben
    /// Anfragen, in wenigen Sekunden da. Sie liefert alles bis etwa 500 m
    /// neben der Strecke. Danach die Umkreissuchen, gut vierzig Anfragen, die
    /// den Rest holen. Der Nutzer sieht so sofort etwas, statt eine halbe
    /// Minute auf die vollständige Liste zu warten.
    @Published private(set) var isWideningSearch = false

    /// Wie weit darf eine Station seitlich der Route liegen?
    ///
    /// Ohne diese Grenze schleppt die Umkreissuche Innenstadt-Ladepunkte mit,
    /// für die auf einer Durchgangsfahrt niemand abfährt.
    @Published var maxDistanceFromRouteMeters: Double = 2_000

    /// Filter, die direkt in die Suchanfrage wandern.
    ///
    /// Die Vorgabe ist die Langstreckenschwelle: Unter 50 kW lohnt ein Stopp auf
    /// einer langen Fahrt nicht, und da eine Antwort nur 20 Treffer fasst,
    /// verdrängen langsame Säulen sonst die brauchbaren.
    @Published var powerTier: PowerTier = .standard
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

    /// Stationen, deren Ladeleistung TomTom nicht kennt. Sie bleiben in der
    /// Liste, werden aber gekennzeichnet, damit niemand einen Stopp darauf plant.
    var unknownPowerCount: Int { stations.filter { !$0.station.hasKnownPower }.count }

    // MARK: Aktionen

    func setDestination(_ coordinate: CLLocationCoordinate2D) {
        destination = coordinate
        starteSuche()
    }

    /// Übernimmt ein Suchergebnis als Ziel.
    func choosePlace(_ place: Place) {
        destinationQuery = ""
        placeResults = []
        chosenPlaceName = place.title
        setDestination(place.coordinate)
    }

    func clearPlaceSearch() {
        destinationQuery = ""
        placeResults = []
    }

    func selectStation(id: String) {
        selectedStationID = id
        Task { await loadAvailability(for: id) }
    }

    func reportError(_ message: String) {
        phase = .failed(message)
    }

    func clearTrip() {
        // Erst abbrechen, dann leeren. Sonst schreibt ein laufender Suchlauf
        // gleich wieder Stationen in ein Modell, das nichts mehr anzeigen soll.
        suchlauf?.cancel()
        suchlauf = nil
        streckenNummer += 1

        route = nil
        stations = []
        fetchedStations = []
        fetchedTier = nil
        chargingPlan = nil
        selectedStationID = nil
        destination = nil
        chosenPlaceName = nil
        phase = .idle
        clearPlaceSearch()
    }

    /// Filter neu anwenden, ohne noch einmal zu suchen.
    ///
    /// Vorher hat jede Umschaltung von 150 auf 300 kW die komplette Suche neu
    /// gestartet, also rund fünfzig Anfragen für eine Entscheidung, die längst
    /// in den vorhandenen Daten steckte. Gesucht wird jetzt einmal an der
    /// Untergrenze, gefiltert wird örtlich.
    ///
    /// Eine Ausnahme bleibt: "alle" liegt unter der Untergrenze der Suche. Wer
    /// auch AC-Säulen sehen will, bekommt eine neue Runde.
    func reapplyFilters() {
        guard route != nil else { return }

        if powerTier.rawValue < Self.fetchTier.rawValue, fetchedTier != powerTier {
            starteSuche(nurStationen: true)
            return
        }
        applyLocalFilters()
    }

    // MARK: Ablauf

    private func planAndSearch(nummer: Int) async {
        guard let destination else { return }
        guard let origin = currentLocation else {
            // Die Quelle weiß, woran es liegt: keine Freigabe, oder Freigabe
            // erteilt und noch kein Fix. Das sind zwei verschiedene Ratschläge.
            phase = .failed(locationSource.problem?.message ?? "Noch keine Position.")
            return
        }

        phase = .planningRoute
        stations = []
        fetchedStations = []
        selectedStationID = nil

        do {
            let geplant = try await routePlanner.planRoute(from: origin, to: destination)
            guard gilt(nummer) else { return }
            route = geplant
        } catch {
            // Auch der Fehlschlag muss noch zur aktuellen Strecke gehören,
            // sonst löscht eine abgebrochene Planung die neue Route.
            guard gilt(nummer) else { return }
            route = nil
            phase = .failed(error.localizedDescription)
            return
        }

        await searchStations(nummer: nummer)
    }

    /// Mit dieser Untergrenze wird gesucht, unabhängig vom gewählten Filter.
    ///
    /// Nicht ganz ohne Grenze: Eine Antwort der Along-Route-Suche fasst nur
    /// zwanzig Treffer je Abschnitt. Ohne Untergrenze verdrängen AC-Säulen die
    /// brauchbaren, und dann fehlen sie in jeder Filterstufe.
    static let fetchTier: PowerTier = .notloesung

    /// So weit seitlich wird aufgehoben. Der Anzeigefilter ist enger.
    private static let keepDistanceMeters: Double = 10_000

    private func searchStations(nummer: Int) async {
        guard let route else { return }

        phase = .searchingStations
        var options = AlongRouteSearchOptions()
        // Der weiteste Wert, den der Regler zulässt. Der Umweg wird örtlich
        // gefiltert; die Messung hat gezeigt, dass maxDetourTime den Korridor
        // der Suche ohnehin nicht verbreitert.
        options.maxDetourSeconds = 30 * 60
        options.minPowerKW = powerTier == .alle ? nil : Self.fetchTier.minPowerKW
        fetchedTier = powerTier == .alle ? .alle : Self.fetchTier

        // Erste Runde: schnell, deckt den engen Korridor an der Route ab.
        do {
            let found = try await api.chargingStationsAlongRoute(
                routeGeometry: route.geometry,
                options: options
            )
            guard gilt(nummer) else { return }
            let sortiert = GeoUtils.orderAlongRoute(
                found,
                routeGeometry: route.geometry,
                maxDistanceMeters: Self.keepDistanceMeters
            )
            fetchedStations = editorialStore.annotate(sortiert)
            applyLocalFilters()
            phase = .ready
        } catch {
            guard gilt(nummer) else { return }
            phase = .failed(error.localizedDescription)
            return
        }

        await widenSearch(route: route, options: options, nummer: nummer)
    }

    /// Zweite Runde: Umkreissuchen entlang der Strecke.
    ///
    /// Am 08.09.2026 gegen das amtliche Ladesäulenregister gemessen: Die
    /// Along-Route-Suche allein findet 51 Prozent der Standorte im
    /// Zwei-Kilometer-Korridor, mit dieser zweiten Runde sind es 93 Prozent.
    /// Jenseits von einem Kilometer neben der Route findet sie ohne die
    /// Umkreise gar nichts.
    private func widenSearch(
        route: TomTomSDKRoute.Route,
        options: AlongRouteSearchOptions,
        nummer: Int
    ) async {
        isWideningSearch = true
        defer { isWideningSearch = false }

        do {
            let nearby = try await api.chargingStationsAroundRoute(
                routeGeometry: route.geometry,
                options: options
            )
            guard gilt(nummer) else { return }

            // Beide Runden zusammen sortieren, nicht die zweite hinten anhängen.
            // Die Umkreissuche liefert keinen Umweg mit, ihre Treffer ließen
            // sich sonst gar nicht einordnen.
            var known = Set(fetchedStations.map(\.id))
            var alle = fetchedStations.map(\.station)
            for station in nearby where !known.contains(station.id) {
                known.insert(station.id)
                alle.append(station)
            }

            let sortiert = GeoUtils.orderAlongRoute(
                alle,
                routeGeometry: route.geometry,
                maxDistanceMeters: Self.keepDistanceMeters
            )

            // Bereits geholte Live-Belegungen nicht wegwerfen.
            let belegungen = Dictionary(
                fetchedStations.compactMap { item in item.availability.map { (item.id, $0) } },
                uniquingKeysWith: { first, _ in first }
            )
            fetchedStations = editorialStore.annotate(sortiert).map { item in
                var angereichert = item
                angereichert.availability = belegungen[item.id]
                return angereichert
            }
            applyLocalFilters()
        } catch {
            // Die erste Runde steht bereits. Ein Fehler hier kostet nur die
            // Ergänzung, nicht das Ergebnis.
            print("Umkreissuche fehlgeschlagen: \(error.localizedDescription)")
        }
    }

    /// Live-Belegung erst beim Antippen holen, nicht für alle Treffer auf einmal.
    /// Das spart im Freemium-Kontingent den Löwenanteil der Anfragen.
    private func loadAvailability(for stationID: String) async {
        // In den Bestand geschrieben, nicht in die Anzeige: `stations` ist eine
        // abgeleitete Sicht, ein späterer Filterwechsel würde die Belegung
        // sonst wieder wegwerfen.
        guard let index = fetchedStations.firstIndex(where: { $0.id == stationID }) else { return }
        guard fetchedStations[index].availability == nil else { return }
        guard let availabilityID = fetchedStations[index].station.availabilityID else { return }

        do {
            let availability = try await api.availability(for: availabilityID)
            // Der Index kann sich zwischenzeitlich verschoben haben.
            if let current = fetchedStations.firstIndex(where: { $0.id == stationID }) {
                fetchedStations[current].availability = availability
                applyLocalFilters()
            }
        } catch {
            // Live-Daten sind eine Zugabe. Fehlen sie, bleibt der Rest nutzbar.
            print("Belegung für \(stationID) nicht abrufbar: \(error.localizedDescription)")
        }
    }

    /// Fragt die Standortfreigabe an und beginnt zu orten.
    ///
    /// Bewusst nicht im Initialisierer: Der Systemdialog soll erscheinen, wenn
    /// die Karte steht, nicht vor dem ersten Bild.
    func startLocating() {
        locationSource.start()
    }

    // MARK: Private

    /// Startet Planung und Suche und bricht ab, was noch läuft.
    ///
    /// Der Abbruch ist der Kern. Wer ein zweites Ziel setzt, während die erste
    /// Suche noch läuft, bekam bisher deren Ergebnis nachgereicht: Die
    /// Umkreissuche braucht knapp dreißig Sekunden, sie lief unbeirrt weiter
    /// und schrieb am Ende die Stationen der alten Strecke ins Modell. Auf der
    /// Karte standen dann Nadeln, die zu keiner sichtbaren Route gehörten.
    ///
    /// Abbrechen allein genügt nicht: Zwischen einem `await` und dem Schreiben
    /// liegt immer ein Moment, in dem der Abbruch schon erfolgt sein kann. Jede
    /// Strecke bekommt deshalb eine Nummer, und geschrieben wird nur, solange
    /// die eigene noch die aktuelle ist.
    private func starteSuche(nurStationen: Bool = false) {
        suchlauf?.cancel()
        streckenNummer += 1
        let nummer = streckenNummer

        suchlauf = Task { [weak self] in
            guard let self else { return }
            if nurStationen {
                await searchStations(nummer: nummer)
            } else {
                await planAndSearch(nummer: nummer)
            }
        }
    }

    /// Gilt das Ergebnis noch, oder ist längst eine andere Strecke gefragt?
    private func gilt(_ nummer: Int) -> Bool {
        nummer == streckenNummer && !Task.isCancelled
    }

    /// Rechnet die Ladestopps neu.
    ///
    /// Grundlage ist die angezeigte Liste, nicht der gesamte Bestand: Wer den
    /// Filter auf 300 kW stellt, will auch an 300 kW laden.
    private func planCharging() {
        guard let route, !stations.isEmpty else {
            chargingPlan = nil
            return
        }

        chargingPlan = ChargingStopPlanner.plan(
            routeLengthMeters: route.summary.length.converted(to: .meters).value,
            stations: stations,
            vehicle: vehicleStore.profile,
            minPowerKW: powerTier.minPowerKW ?? 50
        )
    }

    /// Wendet Leistung, Umweg und seitlichen Abstand auf das Gefundene an.
    ///
    /// Kostet keine Anfrage. Alle drei Regler sind damit sofort wirksam, und
    /// zwar in beide Richtungen: Auch das Zurückstellen von 300 auf 150 kW
    /// zeigt die Stationen wieder, statt sie neu zu suchen.
    private func applyLocalFilters() {
        let minPower = powerTier.minPowerKW
        let maxDetour = maxDetourMinutes * 60

        stations = fetchedStations.filter { item in
            let station = item.station

            if let minPower, !station.meetsMinPower(minPower) { return false }

            if let abstand = station.distanceFromRouteMeters,
               abstand > maxDistanceFromRouteMeters {
                return false
            }

            // Der Umweg gilt nur, wo einer bekannt ist. Treffer aus der
            // Umkreissuche bringen keinen mit; sie über einen fehlenden Wert
            // auszuschließen, würde die halbe Liste kosten.
            if let umweg = station.detourSeconds, umweg > maxDetour { return false }

            return true
        }

        planCharging()
    }

    /// Startet die Zielsuche neu und bricht die vorige ab.
    ///
    /// Ohne Abbruch überholt eine langsame Antwort zu "Ess" die schnelle zu
    /// "Essen", und in der Liste steht das Falsche.
    private func startPlaceSearch(_ text: String) {
        placeSearchTask?.cancel()

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
            placeResults = []
            isSearchingPlaces = false
            return
        }

        isSearchingPlaces = true
        placeSearchTask = Task { [weak self] in
            guard let self else { return }
            let near = currentLocation
            do {
                let treffer = try await api.findPlaces(matching: trimmed, near: near)
                guard !Task.isCancelled else { return }
                placeResults = treffer
            } catch {
                guard !Task.isCancelled else { return }
                // Kein Fehlerbanner: Eine misslungene Zwischensuche beim Tippen
                // ist kein Vorfall, über den jemand unterrichtet werden will.
                placeResults = []
            }
            isSearchingPlaces = false
        }
    }

    /// Alles, was die Suche gefunden hat. `stations` ist die gefilterte Sicht.
    /// Laufender Suchlauf, damit ein neues Ziel ihn abbrechen kann.
    private var suchlauf: Task<Void, Never>?
    /// Zählt die Strecken. Ergebnisse einer älteren zählen nicht mehr.
    private var streckenNummer = 0
    private var fetchedStations: [AnnotatedStation] = []
    /// Mit welcher Untergrenze zuletzt gesucht wurde.
    private var fetchedTier: PowerTier?
    private var cancellables = Set<AnyCancellable>()
    private var placeSearchTask: Task<Void, Never>?
    private let locationSource = UserLocationSource()
    private let apiKey: String
    private let api: TomTomAPIClient
    private let routePlanner: RoutePlannerService
    private let editorialStore: EditorialStore
}
