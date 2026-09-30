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
        registerStore: RegisterStore = .loadBundled(),
        detourTable: DetourTable = .loadBundled(),
        // nil und nicht VehicleProfileStore(): Ein Vorgabewert im
        // Parameterkopf wird außerhalb des Actors ausgewertet, und der Speicher
        // ist @MainActor. Angelegt wird er deshalb hier drinnen.
        vehicleStore: VehicleProfileStore? = nil
    ) {
        self.apiKey = apiKey
        self.editorialStore = editorialStore
        self.registerStore = registerStore
        self.detourTable = detourTable
        self.vehicleStore = vehicleStore ?? VehicleProfileStore()
        api = TomTomAPIClient(apiKey: apiKey)
        detourCalculator = DetourCalculator(api: api)
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
    /// Platz rechts, den die Kacheln der Fahransicht belegen. Die Karte
    /// rückt ihre Mitte entsprechend nach links.
    @Published var mapTrailingInset: CGFloat = 0

    // MARK: Fahrt

    /// Läuft die Fahransicht?
    @Published private(set) var isDriving = false
    /// Fährt statt des Autos die Simulation? Zum Ausprobieren am Schreibtisch.
    @Published private(set) var isSimulatingDrive = false
    /// Wo das Auto auf der Route steht.
    @Published private(set) var driveFix: RouteTracker.Fix?
    /// Die Kacheln rechts, höchstens drei.
    @Published private(set) var drivingTiles: [DrivingTile] = []

    /// Was die Karte für die Fahrt tun soll.
    ///
    /// Die Karte ist während der Fahrt die Quelle der Position, in beiden
    /// Fällen: Beim echten Fahren liefert ihr Standortgeber GPS, bei der
    /// Simulation bekommt sie einen simulierten Geber untergeschoben, der die
    /// Route abfährt. Der Pfeil auf der Karte und die Kacheln rechts kommen
    /// so aus derselben Position und können nicht auseinanderlaufen.
    enum DriveCommand {
        case start(simulatedPath: [CLLocationCoordinate2D]?)
        case stop
    }

    let driveCommands = PassthroughSubject<DriveCommand, Never>()

    /// Läuft gerade die zweite Suchrunde im Umkreis?
    ///
    /// Die Suche läuft zweistufig: Zuerst die Along-Route-Suche, sieben
    /// Anfragen, in wenigen Sekunden da. Sie liefert alles bis etwa 500 m
    /// neben der Strecke. Danach die Umkreissuchen, gut vierzig Anfragen, die
    /// den Rest holen. Der Nutzer sieht so sofort etwas, statt eine halbe
    /// Minute auf die vollständige Liste zu warten.
    @Published private(set) var isWideningSearch = false

    /// Läuft gerade die Umwegrechnung, eine Route je Station?
    ///
    /// Registerstandorte haben keinen Umweg, nur die Luftlinie. Eine Route
    /// mit Zwischenziel je Station, in Fahrtrichtung, gut dreißig Sekunden
    /// für eine Fahrt durchs Ruhrgebiet. Solange das läuft, greift der
    /// Umwegregler erst auf einen Teil der Liste.
    @Published private(set) var isComputingDetours = false
    /// Wie weit die Umwegrechnung ist: erledigt von gesamt.
    @Published private(set) var detourProgress: (done: Int, total: Int)?

    /// Woher die Stationen kommen.
    ///
    /// Das Register ist die Regel. TomTom nur, wenn das Register nichts hat:
    /// außerhalb Deutschlands, oder wenn eine Leistungsstufe unter der des
    /// Exports gewählt ist.
    enum StationSource: Equatable {
        case register
        case tomtom
    }

    @Published private(set) var stationSource: StationSource = .register

    /// Die Pflichtnennung der Quelle, CC BY 4.0.
    var stationSourceNote: String {
        switch stationSource {
        case .register: return "Standorte: \(registerStore.sourceName), CC BY 4.0, \(registerStore.attribution)"
        case .tomtom: return "Standorte: TomTom Search"
        }
    }

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

    /// Für wie viele Stationen ist der Umweg bekannt?
    ///
    /// Nur die Along-Route-Suche liefert ihn mit. Die Umkreissuche, die den
    /// größeren Teil der Treffer bringt, liefert ihn nicht; für die rechnet
    /// die dritte Runde ihn nach. Bis sie durch ist, kann der Umwegregler nur
    /// einen Teil ausschließen, und die Zahl gehört deshalb sichtbar neben
    /// den Regler, sonst wirkt er wirkungslos.
    var detourKnownCount: Int { stations.filter { $0.station.detourSeconds != nil }.count }

    /// Wie viele davon aus der eigenen Rechnung stammen.
    var detourComputedCount: Int { stations.filter(\.station.detourIsComputed).count }

    /// Stationen, deren Ladeleistung TomTom nicht kennt. Sie bleiben in der
    /// Liste, werden aber gekennzeichnet, damit niemand einen Stopp darauf plant.
    var unknownPowerCount: Int { stations.filter { !$0.station.hasKnownPower }.count }

    // MARK: Fahrt

    /// Tempo der Simulation: 130 km/h, zehnfach. Meerbusch nach Norddeich
    /// dauert so eine knappe Viertelstunde.
    static let simulationSpeedMetersPerSecond: Double = 130 / 3.6 * 10
    /// So oft meldet der simulierte Geber eine Position.
    static let simulationTickSeconds: Double = 0.2

    /// Startet die Fahransicht, mit dem echten Standort oder simuliert.
    func startDriving(simulated: Bool) {
        guard let route, !isDriving else { return }
        let tracker = RouteTracker(geometry: route.geometry)
        self.tracker = tracker
        driveStartProgress = nil
        driveFix = nil
        drivingTiles = []
        isSimulatingDrive = simulated
        isDriving = true

        var path: [CLLocationCoordinate2D]?
        if simulated {
            // Gleichmäßige Schritte entlang der Route: Der simulierte Geber
            // springt je Takt einen Punkt weiter, der Abstand ist also das
            // Tempo.
            let step = Self.simulationSpeedMetersPerSecond * Self.simulationTickSeconds
            path = stride(from: 0, through: tracker.lengthMeters, by: step)
                .compactMap { tracker.coordinate(atProgress: $0) }
        }
        driveCommands.send(.start(simulatedPath: path))
    }

    func stopDriving() {
        guard isDriving else { return }
        isDriving = false
        isSimulatingDrive = false
        tracker = nil
        driveFix = nil
        drivingTiles = []
        mapTrailingInset = 0
        driveCommands.send(.stop)
    }

    /// Eine neue Position während der Fahrt, von der Karte gemeldet.
    func updateDrivePosition(_ coordinate: CLLocationCoordinate2D) {
        guard isDriving, var tracker else { return }
        guard let fix = tracker.locate(coordinate) else { return }
        self.tracker = tracker
        if driveStartProgress == nil { driveStartProgress = fix.progressMeters }
        driveFix = fix
        refreshDrivingTiles()
    }

    /// Verbrauch als Prozent Akku je Kilometer.
    var percentPerKm: Double {
        let profile = vehicleStore.profile
        guard profile.usableBatteryKWh > 0 else { return 0 }
        return profile.consumptionKWhPer100km / profile.usableBatteryKWh
    }

    /// Ladestand jetzt: Startwert aus dem Fahrzeugprofil minus das, was seit
    /// dem Losfahren verbraucht ist. Ohne Ladestopps; nach einem Stopp stellt
    /// man den Wert im Profil neu ein.
    var chargeNowPercent: Double {
        let start = vehicleStore.profile.currentChargePercent
        guard let fix = driveFix, let begin = driveStartProgress else { return start }
        return max(0, start - (fix.progressMeters - begin) / 1000 * percentPerKm)
    }

    /// Wie weit es bis zur Reserve noch reicht.
    var rangeToReserveKm: Double {
        guard percentPerKm > 0 else { return 0 }
        return max(0, (chargeNowPercent - vehicleStore.profile.minChargeAtStopPercent) / percentPerKm)
    }

    var remainingKm: Double {
        guard let tracker else { return 0 }
        return max(0, (tracker.lengthMeters - (driveFix?.progressMeters ?? 0)) / 1000)
    }

    /// Ankunft, anteilig aus der Fahrzeit der Route. Grob, bis die
    /// Zielführung eigene Zeiten liefert.
    var arrivalTimeText: String {
        guard let tracker, tracker.lengthMeters > 0, let route else { return "–" }
        let total = route.summary.travelTime.converted(to: .seconds).value
        let rest = total * (remainingKm * 1000 / tracker.lengthMeters)
        return Date().addingTimeInterval(rest).formatted(date: .omitted, time: .shortened)
    }

    private func refreshDrivingTiles() {
        guard isDriving, let fix = driveFix else { return }
        drivingTiles = DrivingTiles.tiles(
            stations: stations,
            progressMeters: fix.progressMeters,
            chargePercentNow: chargeNowPercent,
            percentPerKm: percentPerKm,
            reservePercent: vehicleStore.profile.minChargeAtStopPercent,
            plannedStopIDs: plannedStopIDs
        )
    }

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
        stopDriving()
        // Erst abbrechen, dann leeren. Sonst schreibt ein laufender Suchlauf
        // gleich wieder Stationen in ein Modell, das nichts mehr anzeigen soll.
        suchlauf?.cancel()
        suchlauf = nil
        umwegLauf?.cancel()
        umwegLauf = nil
        umwegVersucht = []
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

        // Unter die Stufe des Registers geht es nur über TomTom, und über
        // die Untergrenze der TomTom-Suche nur mit einer neuen Suche.
        let grenze = stationSource == .register ? registerStore.minPowerKW : Self.fetchTier.rawValue
        if powerTier.rawValue < grenze, fetchedTier != powerTier {
            starteSuche(nurStationen: true)
            return
        }
        applyLocalFilters()
        starteUmwege()
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

        // Das Register zuerst: keine Anfrage, keine Wartezeit, ganz
        // Deutschland. Nur wenn es nichts hat, TomTom.
        let wanted = powerTier.minPowerKW ?? 0
        if wanted >= registerStore.minPowerKW {
            let ausRegister = registerStore.stations(
                along: route.geometry,
                maxDistanceMeters: Self.keepDistanceMeters
            )
            if !ausRegister.isEmpty {
                stationSource = .register
                fetchedTier = powerTier
                fetchedStations = editorialStore.annotate(ausRegister)
                applyLocalFilters()
                phase = .ready
                starteUmwege()
                return
            }
        }

        stationSource = .tomtom
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
        guard gilt(nummer) else { return }
        starteUmwege()
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

    /// Rechnet Umwege für das, was die Liste gerade zeigt und noch keinen hat.
    ///
    /// Nicht für den ganzen Bestand: Auf Meerbusch nach Kiel standen 498
    /// Stationen bis fünf Kilometer neben der Route, die Liste zeigte 216 bis
    /// zwei. Die anderen 282 Anfragen hätten Werte geliefert, die niemand
    /// sieht, und ein Vierzigstel des Monatskontingents gekostet. Wer den
    /// Abstandsregler weiter aufzieht, löst über reapplyFilters() die
    /// Nachrechnung der neu sichtbaren Stationen aus.
    ///
    /// Ein eigener Lauf, nicht Teil des Suchlaufs: Er kann jederzeit neu
    /// starten, wenn sich die Anzeige ändert, und läuft nie doppelt.
    private func starteUmwege() {
        guard let route, !isComputingDetours else { return }

        // Erst nachschlagen: Was die Tabelle im Bundle oder der Gerätecache
        // kennt, kostet keine Anfrage und ist sofort da.
        let layout = DetourKey.RouteLayout(route.geometry)
        var ausTabelle = 0
        for index in fetchedStations.indices
        where fetchedStations[index].station.detourSeconds == nil {
            guard let bekannt = detourTable.lookup(fetchedStations[index].station, on: layout) else { continue }
            fetchedStations[index].station.detourSeconds = bekannt.sekunden
            fetchedStations[index].station.detourMeters = bekannt.meter
            fetchedStations[index].station.detourIsComputed = true
            ausTabelle += 1
        }
        if ausTabelle > 0 {
            applyLocalFilters()
            print("Umwege: \(ausTabelle) aus Tabelle und Cache (Bundle \(detourTable.bundledCount), Gerät \(detourTable.cachedCount))")
        }

        let kandidaten = stations
            .map(\.station)
            .filter { $0.detourSeconds == nil && !umwegVersucht.contains($0.id) }
        guard !kandidaten.isEmpty else { return }

        let nummer = streckenNummer
        umwegLauf = Task { [weak self] in
            guard let self else { return }
            await self.computeDetours(route: route, nummer: nummer, kandidaten: kandidaten)
            // Was inzwischen sichtbar wurde, gleich hinterher.
            guard self.gilt(nummer) else { return }
            self.starteUmwege()
        }
    }

    /// Eine Route je Station, in Fahrtrichtung, die Werte einzeln eingetragen:
    /// Wer die Liste sieht, sieht die vorderen Umwege nach Sekunden und muss
    /// nicht auf die hinteren warten.
    private func computeDetours(
        route: TomTomSDKRoute.Route,
        nummer: Int,
        kandidaten: [ChargingStation]
    ) async {
        isComputingDetours = true
        detourProgress = (0, kandidaten.count)
        defer {
            isComputingDetours = false
            detourProgress = nil
        }

        // Als versucht gemerkt, bevor es losgeht: Eine Station, für die die
        // Routing API nichts liefert, soll nicht bei jeder Reglerbewegung
        // wieder eine Anfrage kosten.
        for station in kandidaten { umwegVersucht.insert(station.id) }

        do {
            let ergebnis = try await detourCalculator.detours(
                for: kandidaten,
                routeGeometry: route.geometry,
                progress: { [weak self] done, total in
                    guard let self, self.gilt(nummer) else { return }
                    self.detourProgress = (done, total)
                }
            )
            guard gilt(nummer) else { return }

            let layout = DetourKey.RouteLayout(route.geometry)
            for index in fetchedStations.indices
            where fetchedStations[index].station.detourSeconds == nil {
                guard let umweg = ergebnis.detourSeconds[fetchedStations[index].id] else { continue }
                let meter = ergebnis.detourMeters[fetchedStations[index].id]
                fetchedStations[index].station.detourSeconds = umweg
                fetchedStations[index].station.detourMeters = meter
                fetchedStations[index].station.detourIsComputed = true
                detourTable.remember(umweg, meters: meter, for: fetchedStations[index].station, on: layout)
            }
            detourTable.persist()
            applyLocalFilters()
            print("Umwege: \(ergebnis.detourSeconds.count) von \(kandidaten.count) in \(ergebnis.requestCount) Anfragen, \(ergebnis.failureCount) Fehler")
        } catch {
            // Die Liste steht bereits. Ohne diese Runde fehlt nur der Umweg,
            // und dort steht dann weiter die Luftlinie.
            print("Umwege nicht berechnet: \(error.localizedDescription)")
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

        // Registerstandorte kennen keine TomTom-Kennung. Eine Umkreissuche an
        // der Stelle holt sie nach, einmal, und merkt sie sich im Bestand.
        if fetchedStations[index].station.availabilityID == nil,
           fetchedStations[index].station.isFromRegister {
            let punkt = fetchedStations[index].station.coordinate
            if let treffer = try? await api.nearestChargingStation(to: punkt),
               let current = fetchedStations.firstIndex(where: { $0.id == stationID }) {
                fetchedStations[current].station.availabilityID = treffer.availabilityID
            }
        }

        guard let current = fetchedStations.firstIndex(where: { $0.id == stationID }) else { return }
        guard let availabilityID = fetchedStations[current].station.availabilityID else { return }

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
        umwegLauf?.cancel()
        umwegVersucht = []
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
        // Während der Fahrt kommen Umwege und Belegungen nach; die Kacheln
        // sollen sie sofort zeigen, nicht erst bei der nächsten Position.
        refreshDrivingTiles()
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
    /// Laufende Umwegrechnung, getrennt vom Suchlauf.
    private var umwegLauf: Task<Void, Never>?
    /// Für welche Stationen schon eine Anfrage rausging, mit oder ohne Ergebnis.
    private var umwegVersucht: Set<String> = []
    /// Zählt die Strecken. Ergebnisse einer älteren zählen nicht mehr.
    private var streckenNummer = 0
    private var fetchedStations: [AnnotatedStation] = []
    /// Mit welcher Untergrenze zuletzt gesucht wurde.
    private var fetchedTier: PowerTier?
    private var cancellables = Set<AnyCancellable>()
    private var placeSearchTask: Task<Void, Never>?
    /// Ordnet Positionen der Route zu, solange gefahren wird.
    private var tracker: RouteTracker?
    /// Wo die Fahrt begann, für den Verbrauch seitdem.
    private var driveStartProgress: Double?
    private let locationSource = UserLocationSource()
    private let apiKey: String
    private let api: TomTomAPIClient
    private let detourCalculator: DetourCalculator
    private let routePlanner: RoutePlannerService
    private let editorialStore: EditorialStore
    private let registerStore: RegisterStore
    private let detourTable: DetourTable
}
