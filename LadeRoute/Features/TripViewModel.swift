//  TripViewModel.swift
//  Der gesamte Ablauf: Ziel setzen, Route planen, Ladestationen suchen,
//  eigene Daten dazulegen, Live-Belegung nachladen.

import Combine
import CoreLocation
import Foundation
import TomTomSDKRoute
import UIKit

@MainActor
final class TripViewModel: ObservableObject {
    // MARK: Lifecycle

    init(
        apiKey: String,
        editorialStore: EditorialStore = .loadBundled(),
        registerStore: RegisterStore = .loadBundled(),
        detourTable: DetourTable = .loadBundled(),
        brands: ChargingBrands = .loadBundled(),
        // nil und nicht VehicleProfileStore(): Ein Vorgabewert im
        // Parameterkopf wird außerhalb des Actors ausgewertet, und der Speicher
        // ist @MainActor. Angelegt wird er deshalb hier drinnen.
        vehicleStore: VehicleProfileStore? = nil
    ) {
        self.apiKey = apiKey
        self.editorialStore = editorialStore
        self.registerStore = registerStore
        self.detourTable = detourTable
        self.brands = brands
        brandPreferences = BrandPreferences()
        // Standorte je Marke, einmal aus dem Register, für die Auswahl.
        var counts: [String: Int] = [:]
        for station in registerStore.stations {
            if let brand = brands.brand(for: station) { counts[brand.id, default: 0] += 1 }
        }
        brandSiteCounts = counts
        self.vehicleStore = vehicleStore ?? VehicleProfileStore()
        api = TomTomAPIClient(apiKey: apiKey)
        detourCalculator = DetourCalculator(api: api)
        routePlanner = RoutePlannerService(apiKey: apiKey)
        speaker = Speaker()
        savedPlaces = SavedPlacesStore()

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

        // Andere Favoriten ändern Liste, Plan und Kacheln, nicht die Suche.
        // Ohne receive(on:) liefe der Filter im willSet, mit den alten
        // Favoriten.
        brandPreferences.$favorites
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.applyLocalFilters() }
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
        var ids = Set(chargingPlan?.stops.map(\.station.id) ?? [])
        if let via = viaStation { ids.insert(via.id) }
        return ids
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
    /// Der Suchtreffer dazu, für Adresse und Kategorie beim Speichern.
    @Published private(set) var chosenPlace: Place?
    /// Gespeicherte Ziele.
    let savedPlaces: SavedPlacesStore
    @Published var mapIsReady = false
    @Published var mapBottomInset: CGFloat = 0
    /// Platz rechts, den die Kacheln der Fahransicht belegen. Die Karte
    /// rückt ihre Mitte entsprechend nach links.
    @Published var mapTrailingInset: CGFloat = 0
    /// Platz unten, den die Fahrleiste belegt. Ohne ihn lag der Pfeil der
    /// Kamera unter der Leiste.
    @Published var mapDrivingBottomInset: CGFloat = 0

    // MARK: Fahrt

    /// Läuft die Fahransicht?
    @Published private(set) var isDriving = false
    /// Fährt statt des Autos die Simulation? Zum Ausprobieren am Schreibtisch.
    @Published private(set) var isSimulatingDrive = false
    /// Wo das Auto auf der Route steht.
    @Published private(set) var driveFix: RouteTracker.Fix?
    /// Übersicht während der Fahrt: die ganze Route statt der mitfahrenden
    /// Kamera, mit Plus und Minus. Die Fahrt-Kamera begrenzt den Zoom auf
    /// ein paar hundert Meter, und wer wissen will, wo er auf der Strecke
    /// ist, sah das nicht (Rückmeldung von der ersten iPhone-Fahrt).
    @Published var drivingOverview = false
    /// Norden oben statt Fahrtrichtung oben. Wird gemerkt.
    @Published var cameraNorthUp = UserDefaults.standard.bool(forKey: "cameraNorthUp") {
        didSet { UserDefaults.standard.set(cameraNorthUp, forKey: "cameraNorthUp") }
    }
    /// Die Kacheln rechts, höchstens drei.
    @Published private(set) var drivingTiles: [DrivingTile] = []
    /// Eine Station eines anderen Anbieters, wenn der nächste Favorit
    /// hinter der Reserve liegt.
    @Published private(set) var drivingFallback: DrivingTile?
    @Published private(set) var drivingFallbackReason: FallbackReason?

    // MARK: Ladestand unterwegs

    /// Ladestopps und von Hand gesetzte Werte dieser Fahrt.
    @Published private(set) var chargeEvents: [ChargeEvent] = []
    /// Was nach einem Ladestopp gesetzt wurde, für den Hinweis oben links.
    struct ChargeNotice: Equatable {
        let stationName: String
        let percent: Double
        let minutes: Double
    }

    @Published var chargeNotice: ChargeNotice?
    /// Steht das Auto an einer Säule? Name der Station, sobald erkannt.
    @Published private(set) var chargingAt: String?
    /// Ein Halt der Simulation: ein geplanter Stopp oder die Station, über
    /// die gerade geroutet wird.
    struct SimulatedStop: Equatable {
        let id: String
        let name: String
        let powerKW: Double?
        let chargingMinutes: Double
    }

    /// Die Simulation hält an einem Stopp und wartet auf "Weiter".
    @Published private(set) var simulatedStop: SimulatedStop?
    /// Die Station, über die gerade geroutet wird, bis sie hinter dem Auto
    /// liegt.
    @Published private(set) var viaStation: ChargingStation?
    /// Offen, wenn der Ladestand von Hand eingestellt wird.
    @Published var isAdjustingCharge = false

    // MARK: Zielführung

    /// Die Anweisungen der Strecke, auf der Linie des SDK verortet.
    @Published private(set) var guidance: [GuidanceInstruction] = []
    /// Was die Anzeige oben links zeigt: die nächste Anweisung und die
    /// Strecke bis dahin.
    struct Maneuver: Equatable {
        let instruction: GuidanceInstruction
        let distanceMeters: Double
        /// Die übernächste, wenn sie gleich dahinter kommt: "dann rechts".
        let then: GuidanceInstruction?
    }

    @Published private(set) var nextManeuver: Maneuver?
    /// Warum es keine Anweisungen gibt, wenn es keine gibt.
    @Published private(set) var guidanceProblem: String?
    /// Wird gerade neu geplant, weil das Auto die Route verlassen hat?
    @Published private(set) var isRerouting = false
    /// Ansagen an oder aus. Wird gemerkt; an ist die Vorgabe.
    @Published var voiceEnabled = UserDefaults.standard.object(forKey: "voiceGuidance") as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(voiceEnabled, forKey: "voiceGuidance")
            if !voiceEnabled { speaker.stop() }
        }
    }

    // MARK: Bevorzugte Anbieter

    let brands: ChargingBrands
    let brandPreferences: BrandPreferences
    /// Standorte ab der Leistung des Registers je Marke, für die Auswahl.
    let brandSiteCounts: [String: Int]
    /// Zeigt die Liste nur Favoriten? Die Kacheln tun es ohnehin, sobald
    /// welche gewählt sind; die Liste lässt sich aufmachen, um zu sehen, was
    /// es sonst noch gibt.
    @Published var listOnlyFavorites = true

    func isFavorite(_ item: AnnotatedStation) -> Bool {
        isFavorite(item.station)
    }

    func isFavorite(_ station: ChargingStation) -> Bool {
        guard let brand = station.brandID else { return false }
        return brandPreferences.favorites.contains(brand)
    }

    var favoritesActive: Bool { brandPreferences.isActive }

    /// Was die Karte für die Fahrt tun soll.
    ///
    /// Die Karte ist während der Fahrt die Quelle der Position, in beiden
    /// Fällen: Beim echten Fahren liefert ihr Standortgeber GPS, bei der
    /// Simulation bekommt sie einen simulierten Geber untergeschoben, der die
    /// Route abfährt. Der Pfeil auf der Karte und die Kacheln rechts kommen
    /// so aus derselben Position und können nicht auseinanderlaufen.
    enum DriveCommand {
        case start(simulatedPath: [CLLocationCoordinate2D]?)
        /// Neues Tempo der Simulation: der Rest der Route in anderen Schritten.
        case updateSimulatedPath([CLLocationCoordinate2D])
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
        /// Register in Deutschland, TomTom im Ausland.
        case mixed
        case tomtom
    }

    @Published private(set) var stationSource: StationSource = .register

    /// Die Pflichtnennung der Quelle, CC BY 4.0.
    var stationSourceNote: String {
        switch stationSource {
        case .register: return "Standorte: \(registerStore.sourceName), CC BY 4.0, \(registerStore.attribution)"
        case .mixed:
            return "Standorte in Deutschland: \(registerStore.sourceName), CC BY 4.0, \(registerStore.attribution). Im Ausland: TomTom Search"
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
    /// Vorgabe 5 Minuten: Wer auf der Langstrecke lädt, will an der Säule
    /// stehen, nicht im Stadtverkehr davor.
    @Published var maxDetourMinutes: Double = 5

    var selectedStation: AnnotatedStation? {
        // Auch aus dem Bestand: Die Ausweichzeile zeigt Stationen, die der
        // Leistungsfilter aus der Liste nimmt.
        stations.first { $0.id == selectedStationID } ?? fetchedStations.first { $0.id == selectedStationID }
    }

    var routeSummary: (distanceKm: Double, durationMinutes: Double)? {
        guard let summary = route?.summary else { return nil }
        return (
            summary.length.converted(to: .kilometers).value,
            summary.travelTime.converted(to: .minutes).value
        )
    }

    /// Was Liste und Karte zeigen: bei gewählten Favoriten nur deren
    /// Stationen, sofern der Schalter in der Liste nicht aufgemacht ist.
    var stationsForList: [AnnotatedStation] {
        guard favoritesActive, listOnlyFavorites else { return stations }
        return stations.filter { isFavorite($0) }
    }

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

    /// Die Simulation fährt 130 km/h mal `simulationFactor`. Zehnfach dauert
    /// Meerbusch nach Norddeich eine knappe Viertelstunde, aber die Ansagen
    /// überholen sich dann: 600 m vor der Ausfahrt sind knapp zwei Sekunden.
    /// Dreifach reicht für einen Satz je Stufe. Die Ansagen richten sich
    /// immer nach 130 km/h, gleich wie schnell die Simulation läuft.
    static let simulationBaseSpeedMetersPerSecond: Double = 130 / 3.6
    static let simulationFactors: [Double] = [1, 3, 10]
    @Published private(set) var simulationFactor: Double = {
        let stored = UserDefaults.standard.double(forKey: "simulationFactor")
        return TripViewModel.simulationFactors.contains(stored) ? stored : 3
    }()
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
        drivingFallback = nil
        drivingFallbackReason = nil
        isSimulatingDrive = simulated
        drivingOverview = false
        isDriving = true
        // Der Bildschirm bleibt an, solange gefahren wird.
        UIApplication.shared.isIdleTimerDisabled = true
        if !simulated {
            locationSource.beginDriving()
            realPositionSubscription = locationSource.$lastLocation
                .compactMap { $0 }
                .removeDuplicates { $0.timestamp == $1.timestamp }
                .sink { [weak self] location in
                    self?.updateDrivePosition(location.coordinate, measuredSpeed: location.speed >= 0 ? location.speed : nil)
                }
        }
        drivenBeforeRerouteMeters = 0
        chargeEvents = []
        chargeNotice = nil
        chargingAt = nil
        simulatedStop = nil
        handledSimulatedStops = []
        selectedStationID = nil
        stopDetector.reset()
        viaProgressMeters = viaStation.flatMap { tracker.nearest(to: $0.coordinate, from: 0)?.progressMeters }
        resetGuidanceProgress()
        loadGuidance(for: route, tracker: tracker)

        var path: [CLLocationCoordinate2D]?
        if simulated {
            path = simulatedPath(on: tracker, from: 0)
        }
        driveCommands.send(.start(simulatedPath: path))
    }

    /// Gleichmäßige Schritte entlang der Route ab `start`: Der simulierte
    /// Geber springt je Takt einen Punkt weiter, der Abstand ist das Tempo.
    private func simulatedPath(on tracker: RouteTracker, from start: Double) -> [CLLocationCoordinate2D] {
        let step = Self.simulationBaseSpeedMetersPerSecond * simulationFactor * Self.simulationTickSeconds
        return stride(from: start, through: tracker.lengthMeters, by: step)
            .compactMap { tracker.coordinate(atProgress: $0) }
    }

    /// 1-, 3-, 10-fach, reihum. Läuft die Simulation, fährt sie ab der
    /// aktuellen Stelle im neuen Tempo weiter.
    func cycleSimulationFactor() {
        let factors = Self.simulationFactors
        let index = factors.firstIndex(of: simulationFactor) ?? 0
        simulationFactor = factors[(index + 1) % factors.count]
        UserDefaults.standard.set(simulationFactor, forKey: "simulationFactor")
        guard isDriving, isSimulatingDrive, let tracker else { return }
        driveCommands.send(.updateSimulatedPath(simulatedPath(on: tracker, from: driveFix?.progressMeters ?? 0)))
    }

    func stopDriving() {
        guard isDriving else { return }
        isDriving = false
        isSimulatingDrive = false
        tracker = nil
        driveFix = nil
        drivingTiles = []
        drivingFallback = nil
        drivingFallbackReason = nil
        mapTrailingInset = 0
        guidanceTask?.cancel()
        rerouteTask?.cancel()
        guidance = []
        nextManeuver = nil
        guidanceProblem = nil
        isRerouting = false
        chargingAt = nil
        simulatedStop = nil
        isAdjustingCharge = false
        realPositionSubscription = nil
        drivingOverview = false
        locationSource.endDriving()
        UIApplication.shared.isIdleTimerDisabled = false
        speaker.stop()
        driveCommands.send(.stop)
    }

    /// Eine neue Position während der Fahrt, von der Karte gemeldet.
    /// `measuredSpeed` ist das Tempo aus dem GPS, in m/s, wenn es eines gibt.
    func updateDrivePosition(_ coordinate: CLLocationCoordinate2D, measuredSpeed: Double? = nil) {
        guard isDriving, var tracker else { return }
        guard let fix = tracker.locate(coordinate) else { return }
        self.tracker = tracker
        if driveStartProgress == nil { driveStartProgress = fix.progressMeters }
        driveFix = fix
        lastDriveCoordinate = coordinate
        if needsReplan { planCharging() }
        updateSpeed(progress: fix.progressMeters, measured: measuredSpeed)
        watchForChargingStop(at: coordinate)
        releaseViaIfPassed()
        refreshDrivingTiles()
        refreshGuidance()
        watchForDeviation(fix: fix, at: coordinate)
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
        ChargeTracker.chargeNow(
            start: vehicleStore.profile.currentChargePercent,
            events: chargeEvents,
            drivenMeters: drivenMeters,
            percentPerKm: percentPerKm
        )
    }

    /// Seit Abfahrt gefahren, über Umleitungen hinweg.
    var drivenMeters: Double {
        guard let fix = driveFix, let begin = driveStartProgress else { return drivenBeforeRerouteMeters }
        return drivenBeforeRerouteMeters + max(0, fix.progressMeters - begin)
    }

    /// Setzt den Ladestand jetzt, von Hand oder nach einem Ladestopp.
    func setChargeNow(_ percent: Double) {
        chargeEvents.append(ChargeEvent(drivenMeters: drivenMeters, percent: min(100, max(0, percent))))
        planCharging()
        refreshDrivingTiles()
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
        let favorites = brandPreferences.favorites
        let set = DrivingTiles.tilesWithFavorites(
            stations: stations,
            lowerPower: lowerPowerStations,
            isFavorite: { item in item.station.brandID.map(favorites.contains) ?? false },
            favoritesActive: favoritesActive,
            progressMeters: fix.progressMeters,
            chargePercentNow: chargeNowPercent,
            percentPerKm: percentPerKm,
            reservePercent: vehicleStore.profile.minChargeAtStopPercent,
            plannedStopIDs: plannedStopIDs
        )
        drivingTiles = set.tiles
        drivingFallback = set.fallback
        drivingFallbackReason = set.fallbackReason
        refreshTileAvailability()
    }

    /// Belegung der Kacheln während der Fahrt, ohne Antippen: für die drei
    /// Kacheln und die Ausweichzeile, je Station höchstens alle fünf Minuten.
    /// Eine Fahrt von 300 km sieht so vielleicht dreißig Stationen in den
    /// Kacheln, das sind rund sechzig Abfragen; die Liste zieht weiter erst
    /// beim Antippen nach.
    private func refreshTileAvailability() {
        guard isDriving else { return }
        let ids = drivingTiles.map(\.id) + (drivingFallback.map { [$0.id] } ?? [])
        let now = Date()
        for id in ids {
            if let last = availabilityRequestedAt[id], now.timeIntervalSince(last) < 300 { continue }
            availabilityRequestedAt[id] = now
            Task { [weak self] in await self?.loadAvailability(for: id, refresh: true) }
        }
    }

    // MARK: Ladestopps

    /// Beim echten Fahren: Hat das Auto an einer Säule gestanden? Beim
    /// Wegfahren wird der Akku auf den geschätzten Stand gesetzt; der Hinweis
    /// oben links nennt ihn, Antippen korrigiert ihn. Die Simulation hält
    /// stattdessen an den geplanten Stopps.
    private func watchForChargingStop(at coordinate: CLLocationCoordinate2D) {
        if isSimulatingDrive {
            watchSimulatedStop()
            return
        }
        let event = stopDetector.step(time: Date(), position: coordinate, stations: fetchedStations.map(\.station))
        switch event {
        case let .arrived(station):
            chargingAt = station.name
        case let .departed(station, minutes):
            chargingAt = nil
            applyChargingStop(stationName: station.name, stationPowerKW: station.maxPowerKW, minutes: minutes)
        case nil:
            break
        }
    }

    private func applyChargingStop(stationName: String, stationPowerKW: Double?, minutes: Double) {
        let estimate = ChargeTracker.estimate(
            chargePercent: chargeNowPercent,
            stopMinutes: minutes,
            stationPowerKW: stationPowerKW,
            vehicle: vehicleStore.profile
        )
        setChargeNow(estimate)
        chargeNotice = ChargeNotice(stationName: stationName, percent: estimate, minutes: minutes)
        if voiceEnabled {
            speaker.speak("Akku nach dem Ladestopp auf \(Int(estimate.rounded())) Prozent geschätzt.")
        }
    }

    /// Die Simulation fährt an geplanten Stopps nicht ab, sie hält auf der
    /// Route, auf Höhe der Station, und wartet auf "Laden und weiter".
    private func watchSimulatedStop() {
        guard simulatedStop == nil, let fix = driveFix else { return }
        var stop: SimulatedStop?
        if let via = viaStation, !handledSimulatedStops.contains(via.id),
           let progress = viaProgressMeters, progress <= fix.progressMeters {
            stop = SimulatedStop(
                id: via.id,
                name: via.name,
                powerKW: via.maxPowerKW,
                chargingMinutes: minutesToChargeUp(at: via.maxPowerKW)
            )
        } else if let planned = chargingPlan?.stops.first(where: {
            !handledSimulatedStops.contains($0.id) && $0.progressMeters <= fix.progressMeters
        }) {
            stop = SimulatedStop(
                id: planned.id,
                name: planned.station.name,
                powerKW: planned.station.maxPowerKW,
                chargingMinutes: planned.chargingSeconds / 60
            )
        }
        guard let stop else { return }
        handledSimulatedStops.insert(stop.id)
        simulatedStop = stop
        chargingAt = stop.name
        driveCommands.send(.updateSimulatedPath([fix.snapped]))
    }

    /// Wie lange es von jetzt bis zur Ladegrenze des Profils dauert.
    private func minutesToChargeUp(at powerKW: Double?) -> Double {
        let profile = vehicleStore.profile
        let from = chargeNowPercent / 100 * profile.usableBatteryKWh
        let seconds = ChargingStopPlanner.chargingSeconds(
            from: from,
            to: profile.maxChargeAtStopKWh,
            curve: profile.chargingCurve(),
            stationPowerKW: powerKW ?? 50
        )
        return seconds.isFinite ? seconds / 60 : 30
    }

    /// Nach dem simulierten Stopp: laden, so lange der Plan es vorsieht, und
    /// weiterfahren.
    func finishSimulatedStop() {
        guard let stop = simulatedStop, let tracker else { return }
        simulatedStop = nil
        chargingAt = nil
        applyChargingStop(stationName: stop.name, stationPowerKW: stop.powerKW, minutes: stop.chargingMinutes + 2)
        driveCommands.send(.updateSimulatedPath(simulatedPath(on: tracker, from: driveFix?.progressMeters ?? 0)))
    }

    // MARK: Zielführung, Ablauf

    /// Holt die Anweisungen zur Strecke. Kostet eine Routing-Anfrage. Mit
    /// der Station, über die geroutet wird, als Zwischenziel, und mit der
    /// Fahrtrichtung, wenn mitten in der Fahrt neu geplant wurde: Sonst
    /// nähme die Anfrage womöglich eine andere Route als das SDK.
    private func loadGuidance(for route: TomTomSDKRoute.Route, tracker: RouteTracker, heading: Double? = nil) {
        guard let first = route.geometry.first, let last = route.geometry.last else { return }
        var points = [first]
        if let via = viaStation { points.append(via.coordinate) }
        points.append(last)
        guidanceTask?.cancel()
        guidanceProblem = nil
        guidanceTask = Task { [weak self] in
            guard let self else { return }
            do {
                let dto = try await api.routeInstructions(through: points, heading: heading)
                guard !Task.isCancelled, isDriving else { return }
                guidance = Guidance.locate(Guidance.instructions(from: dto), on: tracker)
                if guidance.isEmpty { guidanceProblem = "Keine Anweisungen für diese Strecke." }
                refreshGuidance()
            } catch {
                guard !Task.isCancelled, isDriving else { return }
                guidance = []
                guidanceProblem = "Ohne Ansagen: \(error.localizedDescription)"
            }
        }
    }

    private func resetGuidanceProgress() {
        announcer = Announcer()
        nextManeuver = nil
        speedMetersPerSecond = isSimulatingDrive ? Self.simulationBaseSpeedMetersPerSecond : 0
        lastSpeedSample = nil
        offRouteFixes = 0
    }

    /// Tempo aus dem Weg auf der Route, geglättet. In der Simulation fest,
    /// damit die Ansagen so fallen wie auf der Autobahn, nur schneller.
    private func updateSpeed(progress: Double, measured gps: Double? = nil) {
        guard !isSimulatingDrive else { return }
        // Das GPS misst das Tempo direkt, genauer als der Weg auf der Route.
        if let gps {
            speedMetersPerSecond = speedMetersPerSecond == 0 ? gps : speedMetersPerSecond * 0.5 + gps * 0.5
            return
        }
        let now = Date()
        guard let last = lastSpeedSample else {
            lastSpeedSample = (progress, now)
            return
        }
        // Erst ab einer halben Sekunde messen, sonst rauscht es.
        let seconds = now.timeIntervalSince(last.time)
        guard seconds >= 0.5 else { return }
        lastSpeedSample = (progress, now)
        let measured = max(0, (progress - last.progress) / seconds)
        speedMetersPerSecond = speedMetersPerSecond == 0 ? measured : speedMetersPerSecond * 0.7 + measured * 0.3
    }

    private func refreshGuidance() {
        guard isDriving, let fix = driveFix, !guidance.isEmpty else { return }
        let step = announcer.step(guidance, progress: fix.progressMeters, speed: speedMetersPerSecond)
        if let index = step.index, let distance = step.distance {
            let current = guidance[index]
            var then: GuidanceInstruction?
            if index + 1 < guidance.count {
                let following = guidance[index + 1]
                if !following.isFollow, following.progressMeters - current.progressMeters < 500 { then = following }
            }
            nextManeuver = Maneuver(instruction: current, distanceMeters: distance, then: then)
        } else {
            nextManeuver = nil
        }
        // Neben der Route gelten die Anweisungen der alten Linie nicht mehr.
        // Still bleiben, bis die neue Route da ist.
        if let text = step.text, voiceEnabled, fix.offsetMeters <= 50 {
            speaker.speak(text)
        }
    }

    /// Neben der Route: drei Positionen hintereinander mehr als 50 m daneben,
    /// dann wird ab hier neu geplant. Nicht öfter als alle 20 Sekunden, und
    /// nicht in der Simulation, die fährt die Route ab.
    private func watchForDeviation(fix: RouteTracker.Fix, at coordinate: CLLocationCoordinate2D) {
        guard !isSimulatingDrive else { return }
        offRouteFixes = fix.offsetMeters > 50 ? offRouteFixes + 1 : 0
        guard !isRerouting, let destination else { return }
        if shouldReroute(at: coordinate) {
            reroute(from: coordinate, to: destination)
        }
    }

    /// Wann neu geplant wird. Gegenstück zu neuPlanen() in
    /// tools/lib/abweichung.mjs, die Tests dort sind der Maßstab.
    ///
    /// Wer zu einer Säule abbiegt, verlässt die Route mit Absicht; dann
    /// nicht neu planen. Aber nur für Stationen, zu denen jemand absichtlich
    /// fährt: das Zwischenziel (1,5 km), geplante Stopps (1 km), sonst erst
    /// auf dem Gelände einer angezeigten Station (300 m). Die erste Fassung
    /// sah jede aufbewahrte Station im Umkreis von 1 km, und in der Stadt
    /// liegt fast überall eine: Auf der ersten iPhone-Fahrt kam nach dem
    /// Abbiegen keine Ansage mehr, weil nie neu geplant wurde.
    private func shouldReroute(at coordinate: CLLocationCoordinate2D) -> Bool {
        guard offRouteFixes >= 3 else { return false }
        if let last = lastRerouteAt, Date().timeIntervalSince(last) < 20 { return false }
        if let via = viaStation, GeoUtils.distance(via.coordinate, coordinate) <= 1500 { return false }
        if chargingPlan?.stops.contains(where: { GeoUtils.distance($0.station.coordinate, coordinate) <= 1000 }) == true {
            return false
        }
        if stations.contains(where: { GeoUtils.distance($0.station.coordinate, coordinate) <= 300 }) { return false }
        return true
    }

    private func reroute(from origin: CLLocationCoordinate2D, to destination: CLLocationCoordinate2D, announce: String = "Route wird neu berechnet") {
        isRerouting = true
        lastRerouteAt = Date()
        if voiceEnabled { speaker.speak(announce) }
        let heading = driveFix?.courseDegrees
        let via = viaStation.map { [$0.coordinate] } ?? []
        rerouteTask?.cancel()
        rerouteTask = Task { [weak self] in
            guard let self else { return }
            defer { isRerouting = false }
            do {
                let neu = try await routePlanner.planRoute(from: origin, to: destination, via: via, heading: heading)
                guard !Task.isCancelled, isDriving else { return }
                adoptRerouted(neu, heading: heading)
            } catch {
                // Kein Abbruch: Die alte Route bleibt, und nach 20 Sekunden
                // wird es wieder versucht, falls das Auto noch daneben ist.
                guidanceProblem = "Neuberechnung fehlgeschlagen: \(error.localizedDescription)"
            }
        }
    }

    /// Übernimmt die neue Route mitten in der Fahrt.
    ///
    /// Die Stationen bleiben, sie werden nur neu auf die Linie gelegt: Eine
    /// Umleitung ändert die Strecke meist um ein paar Kilometer, und eine neue
    /// Suche kostete fünfzig Anfragen. Was weiter als 10 km neben der neuen
    /// Route liegt, fällt heraus. Der Verbrauch zählt weiter.
    private func adoptRerouted(_ neu: TomTomSDKRoute.Route, heading: Double?) {
        if let fix = driveFix, let begin = driveStartProgress {
            drivenBeforeRerouteMeters += fix.progressMeters - begin
        }
        driveStartProgress = nil
        route = neu
        let tracker = RouteTracker(geometry: neu.geometry)
        self.tracker = tracker
        driveFix = nil

        let bisher = Dictionary(fetchedStations.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let neuGelegt = GeoUtils.orderAlongRoute(
            fetchedStations.map(\.station),
            routeGeometry: neu.geometry,
            maxDistanceMeters: Self.keepDistanceMeters
        )
        fetchedStations = neuGelegt.compactMap { station in
            guard var item = bisher[station.id] else { return nil }
            item.station = station
            return item
        }
        applyLocalFilters()

        viaProgressMeters = viaStation.flatMap { tracker.nearest(to: $0.coordinate, from: 0)?.progressMeters }
        guidance = []
        resetGuidanceProgress()
        loadGuidance(for: neu, tracker: tracker, heading: heading)
        // Die Simulation fährt die neue Linie ab, vom Anfang: Der liegt dort,
        // wo das Auto gerade ist.
        if isSimulatingDrive {
            driveCommands.send(.updateSimulatedPath(simulatedPath(on: tracker, from: 0)))
        }
    }

    // MARK: Über eine Station

    /// Plant ab hier über die Station zum Ziel. Während der Fahrt, aus einer
    /// Kachel oder der Liste; vor der Fahrt wird die Route mit der Station
    /// neu geplant und neu gesucht.
    func routeVia(stationID: String) {
        guard let item = fetchedStations.first(where: { $0.id == stationID }) else { return }
        viaStation = item.station
        selectedStationID = nil
        guard isDriving else {
            starteSuche()
            return
        }
        guard let destination, let origin = lastDriveCoordinate ?? driveFix?.snapped else { return }
        reroute(from: origin, to: destination, announce: "Route über \(item.station.name)")
    }

    /// Hebt das Zwischenziel auf und plant direkt zum Ziel.
    func clearVia() {
        guard viaStation != nil else { return }
        viaStation = nil
        viaProgressMeters = nil
        guard isDriving else {
            starteSuche()
            return
        }
        guard let destination, let origin = lastDriveCoordinate ?? driveFix?.snapped else { return }
        reroute(from: origin, to: destination, announce: "Route direkt zum Ziel")
    }

    /// Liegt die Station hinter dem Auto, ist sie kein Zwischenziel mehr.
    /// Eine spätere Neuplanung führt sonst zurück zur Säule.
    private func releaseViaIfPassed() {
        guard viaStation != nil, let progress = viaProgressMeters, let fix = driveFix else { return }
        if fix.progressMeters > progress + 500, !stopDetector.isNearStation {
            viaStation = nil
            viaProgressMeters = nil
        }
    }

    // MARK: Aktionen

    /// Neues Ziel. Vom langen Druck auf die Karte ohne Namen; die Kopfzeile
    /// zeigte vorher den Namen des vorigen Ziels weiter.
    func setDestination(_ coordinate: CLLocationCoordinate2D, name: String? = nil, place: Place? = nil) {
        destination = coordinate
        chosenPlaceName = name
        chosenPlace = place
        viaStation = nil
        starteSuche()
    }

    /// Übernimmt ein Suchergebnis als Ziel.
    func choosePlace(_ place: Place) {
        destinationQuery = ""
        placeResults = []
        setDestination(place.coordinate, name: place.title, place: place)
    }

    /// Fährt ein gespeichertes Ziel an.
    func chooseSaved(_ saved: SavedPlace) {
        destinationQuery = ""
        placeResults = []
        setDestination(saved.coordinate, name: saved.name)
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
        viaStation = nil
        viaProgressMeters = nil
        stations = []
        fetchedStations = []
        fetchedTier = nil
        chargingPlan = nil
        selectedStationID = nil
        destination = nil
        chosenPlaceName = nil
        chosenPlace = nil
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
        let grenze = stationSource == .tomtom ? Self.fetchTier.rawValue : registerStore.minPowerKW
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
            let geplant = try await routePlanner.planRoute(
                from: origin,
                to: destination,
                via: viaStation.map { [$0.coordinate] } ?? []
            )
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
        // Deutschland. Die Stücke im Ausland sucht TomTom dazu; hat das
        // Register gar nichts, sucht TomTom die ganze Route ab.
        let wanted = powerTier.minPowerKW ?? 0
        if wanted >= registerStore.minPowerKW {
            let ausRegister = registerStore.stations(
                along: route.geometry,
                maxDistanceMeters: Self.keepDistanceMeters
            )
            if !ausRegister.isEmpty {
                let foreign = StationSources.foreignPieces(geometry: route.geometry, ranges: countryRanges(of: route))
                stationSource = foreign.isEmpty ? .register : .mixed
                fetchedTier = powerTier
                fetchedStations = editorialStore.annotate(withBrands(ausRegister))
                applyLocalFilters()
                phase = .ready
                if !foreign.isEmpty {
                    await addForeignStations(pieces: foreign, route: route, register: ausRegister, nummer: nummer)
                    guard gilt(nummer) else { return }
                }
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
            fetchedStations = editorialStore.annotate(withBrands(sortiert))
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

    /// Die Länder der Route. Aus den Abschnitten des SDK; fehlen die, aus der
    /// Abdeckung des Registers.
    private func countryRanges(of route: TomTomSDKRoute.Route) -> [StationSources.CountryRange] {
        let sections = route.sections.countrySections.map {
            StationSources.CountryRange(
                from: $0.sectionLocation.startPointIndex,
                to: $0.sectionLocation.endPointIndex,
                country: $0.countryCode
            )
        }
        if !sections.isEmpty { return sections }
        return StationSources.coverageRanges(geometry: route.geometry, register: registerStore.stations)
    }

    /// Sucht die Stücke außerhalb Deutschlands bei TomTom ab und legt die
    /// Treffer zum Register. Nur die Along-Route-Suche, ohne Umkreise: Die
    /// Schnelllader im Ausland stehen wie hier an der Autobahn, und das
    /// Search-Kontingent (2.500 im Monat) soll für mehr als eine Fahrt
    /// reichen.
    private func addForeignStations(
        pieces: [[CLLocationCoordinate2D]],
        route: TomTomSDKRoute.Route,
        register: [ChargingStation],
        nummer: Int
    ) async {
        isWideningSearch = true
        defer { isWideningSearch = false }
        var options = AlongRouteSearchOptions()
        options.maxDetourSeconds = 30 * 60
        options.minPowerKW = Self.fetchTier.minPowerKW

        var found: [ChargingStation] = []
        for piece in pieces where piece.count >= 2 {
            do {
                found += try await api.chargingStationsAlongRoute(routeGeometry: piece, options: options)
            } catch {
                print("Auslandssuche fehlgeschlagen: \(error.localizedDescription)")
            }
            guard gilt(nummer) else { return }
        }
        guard !found.isEmpty else { return }

        let merged = StationSources.merge(register: register, tomtom: found)
        let ordered = GeoUtils.orderAlongRoute(
            merged,
            routeGeometry: route.geometry,
            maxDistanceMeters: Self.keepDistanceMeters
        )
        fetchedStations = editorialStore.annotate(withBrands(ordered))
        applyLocalFilters()
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
            fetchedStations = editorialStore.annotate(withBrands(sortiert)).map { item in
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
    ///
    /// `refresh` holt sie neu, auch wenn schon eine da ist: für die Kacheln
    /// während der Fahrt, alle fünf Minuten.
    private func loadAvailability(for stationID: String, refresh: Bool = false) async {
        // In den Bestand geschrieben, nicht in die Anzeige: `stations` ist eine
        // abgeleitete Sicht, ein späterer Filterwechsel würde die Belegung
        // sonst wieder wegwerfen.
        guard let index = fetchedStations.firstIndex(where: { $0.id == stationID }) else { return }
        guard refresh || fetchedStations[index].availability == nil else { return }

        // Registerstandorte kennen keine TomTom-Kennung. Eine Umkreissuche an
        // der Stelle holt sie nach, einmal, und merkt sie sich im Bestand.
        // Nur einmal je Station: Findet die Umkreissuche nichts, kostete jeder
        // weitere Versuch wieder eine Search-Anfrage.
        if fetchedStations[index].station.availabilityID == nil,
           fetchedStations[index].station.isFromRegister,
           availabilityLookupTried.insert(stationID).inserted {
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
    ///
    /// Während der Fahrt ab dem Auto, mit dem Ladestand jetzt: Nach einem
    /// Ladestopp, einer Umleitung oder einem Zwischenziel stimmt der Plan vom
    /// Start nicht mehr. Die Planung rechnet dazu auf dem Rest der Route, als
    /// begänne sie hier, und die Stopps werden danach wieder auf Meter ab
    /// Routenbeginn gesetzt.
    private func planCharging() {
        guard let route, !stations.isEmpty else {
            chargingPlan = nil
            return
        }
        // Gleich nach einer Umleitung steht das Auto noch nicht auf der neuen
        // Linie. Dann bleibt der alte Plan, bis die erste Position da ist.
        if isDriving, driveFix == nil, chargingPlan != nil {
            needsReplan = true
            return
        }
        needsReplan = false

        var length = route.summary.length.converted(to: .meters).value
        let minPower = powerTier.minPowerKW ?? 50
        var vehicle = vehicleStore.profile
        var offset = 0.0
        var candidates = stations

        if isDriving, let fix = driveFix {
            offset = fix.progressMeters
            length = (tracker?.lengthMeters ?? length) - offset
            vehicle.currentChargePercent = chargeNowPercent
            // Was keine 500 m mehr vor dem Auto liegt, ist verpasst.
            candidates = stations.compactMap { item in
                guard let progress = item.station.progressAlongRouteMeters, progress > offset + 500 else { return nil }
                var shifted = item
                shifted.station.progressAlongRouteMeters = progress - offset
                return shifted
            }
        }

        // Erst nur mit Favoriten. Geht die Strecke damit nicht auf, mit allen;
        // die Liste kennzeichnet dann die Stopps, die kein Favorit sind.
        var plan: ChargingPlan?
        if favoritesActive {
            let favoriten = candidates.filter { isFavorite($0) }
            if !favoriten.isEmpty {
                let favPlan = ChargingStopPlanner.plan(
                    routeLengthMeters: length,
                    stations: favoriten,
                    vehicle: vehicle,
                    minPowerKW: minPower
                )
                if favPlan.isFeasible { plan = favPlan }
            }
        }
        let result = plan ?? ChargingStopPlanner.plan(
            routeLengthMeters: length,
            stations: candidates,
            vehicle: vehicle,
            minPowerKW: minPower
        )
        chargingPlan = offset > 0 ? result.shifted(by: offset, stations: stations) : result
    }

    /// Wendet Leistung, Umweg und seitlichen Abstand auf das Gefundene an.
    ///
    /// Kostet keine Anfrage. Alle drei Regler sind damit sofort wirksam, und
    /// zwar in beide Richtungen: Auch das Zurückstellen von 300 auf 150 kW
    /// zeigt die Stationen wieder, statt sie neu zu suchen.
    private func applyLocalFilters() {
        let minPower = powerTier.minPowerKW

        stations = fetchedStations.filter { item in
            if let minPower, !item.station.meetsMinPower(minPower) { return false }
            return passesDistanceAndDetour(item.station)
        }

        // Die Reserve der Ausweichzeile: dieselben Grenzen für Abstand und
        // Umweg, aber Leistung unter der gewählten Stufe, bis 150 kW hinab.
        // Darunter nicht: Eine 50-kW-Säule fährt niemand gezielt an.
        if let minPower, minPower > Self.lowestFallbackPowerKW {
            lowerPowerStations = fetchedStations.filter { item in
                guard let power = item.station.maxPowerKW,
                      power >= Self.lowestFallbackPowerKW, power < minPower else { return false }
                return passesDistanceAndDetour(item.station)
            }
        } else {
            lowerPowerStations = []
        }

        planCharging()
        // Während der Fahrt kommen Umwege und Belegungen nach; die Kacheln
        // sollen sie sofort zeigen, nicht erst bei der nächsten Position.
        refreshDrivingTiles()
    }

    /// So weit geht die Ausweichzeile mit der Leistung hinunter.
    static let lowestFallbackPowerKW: Double = 150

    private func passesDistanceAndDetour(_ station: ChargingStation) -> Bool {
        if let abstand = station.distanceFromRouteMeters,
           abstand > maxDistanceFromRouteMeters {
            return false
        }
        // Der Umweg gilt nur, wo einer bekannt ist. Treffer aus der
        // Umkreissuche bringen keinen mit; sie über einen fehlenden Wert
        // auszuschließen, würde die halbe Liste kosten.
        if let umweg = station.detourSeconds, umweg > maxDetourMinutes * 60 { return false }
        return true
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
    /// Stationen unter der gewählten Leistung, bis 150 kW: die Reserve der
    /// Ausweichzeile.
    private var lowerPowerStations: [AnnotatedStation] = []
    /// Mit welcher Untergrenze zuletzt gesucht wurde.
    private var fetchedTier: PowerTier?
    private var cancellables = Set<AnyCancellable>()
    private var placeSearchTask: Task<Void, Never>?
    /// Ordnet Positionen der Route zu, solange gefahren wird.
    private var tracker: RouteTracker?
    /// Wo die Fahrt begann, für den Verbrauch seitdem.
    private var driveStartProgress: Double?
    /// Gefahrene Meter auf früheren Routen dieser Fahrt, vor einer Umleitung.
    private var drivenBeforeRerouteMeters: Double = 0
    private var announcer = Announcer()
    private let speaker: Speaker
    private var guidanceTask: Task<Void, Never>?
    private var rerouteTask: Task<Void, Never>?
    private var speedMetersPerSecond: Double = 0
    private var lastSpeedSample: (progress: Double, time: Date)?
    private var offRouteFixes = 0
    private var stopDetector = StopDetector()
    private var lastDriveCoordinate: CLLocationCoordinate2D?
    private var realPositionSubscription: AnyCancellable?
    private var needsReplan = false
    private var availabilityRequestedAt: [String: Date] = [:]
    private var availabilityLookupTried = Set<String>()
    /// Wo auf der aktuellen Route die Station liegt, über die geroutet wird.
    private var viaProgressMeters: Double?
    private var handledSimulatedStops = Set<String>()
    private var lastRerouteAt: Date?
    private let locationSource = UserLocationSource()
    private let apiKey: String
    private let api: TomTomAPIClient
    private let detourCalculator: DetourCalculator
    private let routePlanner: RoutePlannerService
    private let editorialStore: EditorialStore
    private let registerStore: RegisterStore
    private let detourTable: DetourTable

    /// Trägt die Marke an jeder Station ein, bevor sie in den Bestand geht.
    private func withBrands(_ stations: [ChargingStation]) -> [ChargingStation] {
        stations.map { station in
            var tagged = station
            tagged.brandID = brands.brand(for: station)?.id
            return tagged
        }
    }
}
