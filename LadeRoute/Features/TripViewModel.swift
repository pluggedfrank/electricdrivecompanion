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
    /// Der eigene Standort. Kommt aus `UserLocationSource` und nirgends sonst;
    /// zwei Schreiber auf derselben Angabe wären eine Fehlersuche wert, die
    /// niemand führen will.
    @Published private(set) var currentLocation: CLLocationCoordinate2D?
    @Published var destination: CLLocationCoordinate2D?

    /// Was im Suchfeld steht.
    @Published var destinationQuery = ""
    @Published private(set) var placeResults: [Place] = []
    @Published private(set) var isSearchingPlaces = false
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
        Task { await planAndSearch() }
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
        route = nil
        stations = []
        selectedStationID = nil
        destination = nil
        chosenPlaceName = nil
        phase = .idle
        clearPlaceSearch()
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
            // Die Quelle weiß, woran es liegt: keine Freigabe, oder Freigabe
            // erteilt und noch kein Fix. Das sind zwei verschiedene Ratschläge.
            phase = .failed(locationSource.problem?.message ?? "Noch keine Position.")
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
        options.minPowerKW = powerTier.minPowerKW

        // Erste Runde: schnell, deckt den engen Korridor an der Route ab.
        do {
            let found = try await api.chargingStationsAlongRoute(
                routeGeometry: route.geometry,
                options: options
            )
            let sortiert = GeoUtils.orderAlongRoute(
                found,
                routeGeometry: route.geometry,
                maxDistanceMeters: maxDistanceFromRouteMeters
            )
            stations = editorialStore.annotate(sortiert)
            phase = .ready
        } catch {
            phase = .failed(error.localizedDescription)
            return
        }

        await widenSearch(route: route, options: options)
    }

    /// Zweite Runde: Umkreissuchen entlang der Strecke.
    ///
    /// Am 08.09.2026 gegen das amtliche Ladesäulenregister gemessen: Die
    /// Along-Route-Suche allein findet 51 Prozent der Standorte im
    /// Zwei-Kilometer-Korridor, mit dieser zweiten Runde sind es 93 Prozent.
    /// Jenseits von einem Kilometer neben der Route findet sie ohne die
    /// Umkreise gar nichts.
    private func widenSearch(route: TomTomSDKRoute.Route, options: AlongRouteSearchOptions) async {
        isWideningSearch = true
        defer { isWideningSearch = false }

        do {
            let nearby = try await api.chargingStationsAroundRoute(
                routeGeometry: route.geometry,
                options: options
            )

            // Beide Runden zusammen sortieren, nicht die zweite hinten anhängen.
            // Die Umkreissuche liefert keinen Umweg mit, ihre Treffer ließen
            // sich sonst gar nicht einordnen.
            var known = Set(stations.map(\.id))
            var alle = stations.map(\.station)
            for station in nearby where !known.contains(station.id) {
                known.insert(station.id)
                alle.append(station)
            }

            let sortiert = GeoUtils.orderAlongRoute(
                alle,
                routeGeometry: route.geometry,
                maxDistanceMeters: maxDistanceFromRouteMeters
            )

            // Bereits geholte Live-Belegungen nicht wegwerfen.
            let belegungen = Dictionary(
                stations.compactMap { item in item.availability.map { (item.id, $0) } },
                uniquingKeysWith: { first, _ in first }
            )
            stations = editorialStore.annotate(sortiert).map { item in
                var angereichert = item
                angereichert.availability = belegungen[item.id]
                return angereichert
            }
        } catch {
            // Die erste Runde steht bereits. Ein Fehler hier kostet nur die
            // Ergänzung, nicht das Ergebnis.
            print("Umkreissuche fehlgeschlagen: \(error.localizedDescription)")
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

    /// Fragt die Standortfreigabe an und beginnt zu orten.
    ///
    /// Bewusst nicht im Initialisierer: Der Systemdialog soll erscheinen, wenn
    /// die Karte steht, nicht vor dem ersten Bild.
    func startLocating() {
        locationSource.start()
    }

    // MARK: Private

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

    private var cancellables = Set<AnyCancellable>()
    private var placeSearchTask: Task<Void, Never>?
    private let locationSource = UserLocationSource()
    private let apiKey: String
    private let api: TomTomAPIClient
    private let routePlanner: RoutePlannerService
    private let editorialStore: EditorialStore
}
