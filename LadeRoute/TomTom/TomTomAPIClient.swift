//  TomTomAPIClient.swift
//  Zugriff auf die TomTom Search API über REST.
//
//  Warum REST und nicht das Search-SDK: die Antwortstruktur ist dokumentiert und
//  stabil, wir behalten die volle Kontrolle über Filter und Paginierung, und die
//  Schicht lässt sich ohne Simulator gegen echte Endpunkte testen (siehe
//  ../tools/tomtom-probe.mjs). Karte und Routing laufen weiterhin über das SDK.

import CoreLocation
import Foundation

// MARK: - Fehler

enum TomTomAPIError: LocalizedError {
    case missingAPIKey
    case invalidURL
    case emptyRoute
    case http(status: Int, body: String)
    case decoding(underlying: Error)

    var errorDescription: String? {
        switch self {
        case .missingAPIKey:
            return "Kein TomTom-API-Key hinterlegt. Siehe ios/README.md, Abschnitt Einrichtung."
        case .invalidURL:
            return "Die Anfrage-URL konnte nicht gebildet werden."
        case .emptyRoute:
            return "Ohne Route gibt es keine Strecke, an der gesucht werden könnte."
        case let .http(status, body):
            switch status {
            case 401:
                return "TomTom lehnt die Anfrage ab (401). Nach einem erfolglosen zweiten Versuch heißt das: Key ungültig oder Search API nicht freigeschaltet."
            case 403:
                return "TomTom lehnt den Key ab (403). Fehlt das Produkt in der Key-Konfiguration?"
            case 429:
                return "Tageskontingent erreicht (429). Das Freemium-Limit greift."
            default:
                return "TomTom antwortet mit Status \(status): \(body.prefix(200))"
            }
        case let .decoding(underlying):
            return "Antwort nicht lesbar: \(underlying.localizedDescription)"
        }
    }
}

// MARK: - Ladeleistung

/// Ladeleistungsstufen.
///
/// Auf der Langstrecke ist alles unter 50 kW ohne Belang: Wer 300 km vor sich
/// hat, lädt nicht an einer 22-kW-AC-Säule. Da eine Antwort nur 20 Treffer
/// fasst, verdrängen langsame Säulen sonst die brauchbaren.
/// Ladeleistungsstufen.
///
/// Die Vorgabe ist 150 kW, nicht 50. Eine 50-kW-Säule fährt heute niemand mehr
/// gezielt an, das ist eine Notlösung, wenn sonst nichts in Reichweite steht.
/// Sie bleibt deshalb wählbar, aber nicht voreingestellt.
enum PowerTier: Double, CaseIterable, Identifiable, Sendable {
    case alle = 0
    case notloesung = 50
    case schnell = 150
    case hpc = 300

    /// Was die App zeigt, wenn nichts gewählt wurde.
    static let standard: PowerTier = .schnell

    var id: Double { rawValue }

    /// nil bedeutet: kein Filter.
    var minPowerKW: Double? { rawValue > 0 ? rawValue : nil }

    var label: String {
        switch self {
        case .alle: return "alle"
        case .notloesung: return "ab 50 kW"
        case .schnell: return "ab 150 kW"
        case .hpc: return "ab 300 kW"
        }
    }

    var explanation: String {
        switch self {
        case .alle: return "Auch AC-Säulen. Für die Stadt, nicht für die Langstrecke."
        case .notloesung: return "Notlösung. Nur, wenn sonst nichts in Reichweite steht."
        case .schnell: return "Die sinnvolle Untergrenze für lange Fahrten."
        case .hpc: return "Kurze Stopps, dafür weniger Auswahl."
        }
    }
}

// MARK: - Suchoptionen

struct AlongRouteSearchOptions: Sendable {
    /// Der Suchbegriff steht bei searchAlongRoute im Pfad und ist Pflicht. Er
    /// wirkt als Freitextsuche über POI-Namen und Kategorien. "charging station"
    /// trifft deshalb nur Betreiber, die das Wort im Namen führen, und lässt
    /// Ionity, EnBW oder Aral pulse liegen. "electric vehicle station" ist im
    /// Test der einzige Begriff, der die Kategorie selbst trifft.
    var query: String = "electric vehicle station"
    /// Kategoriefilter der API. Aus, weil er am 08.09. gegen die echte API
    /// widerlegt wurde: `categorySet=7309` liefert auf einem 100-km-Abschnitt
    /// der A31 null Treffer, dieselbe Anfrage ohne den Parameter liefert 20,
    /// und das für jeden getesteten Suchbegriff. Der Parameter filtert nicht,
    /// er löscht das Ergebnis.
    var useCategoryFilter: Bool = false
    /// Kategorie-ID, falls der Filter doch benutzt wird.
    var categoryID: String = TomTomAPIClient.evStationCategory
    /// Treffer ohne Ladeinfrastruktur verwerfen. Ersetzt den Kategoriefilter.
    var onlyEVStations: Bool = true
    /// Maximal zulässiger Umweg. TomTom deckelt bei 3600 s.
    var maxDetourSeconds: Int = 600
    /// Treffer pro Anfrage. Die Along-Route-Suche liefert höchstens 20.
    var limitPerRequest: Int = 20
    /// Mindest-Ladeleistung in kW. Vorgabe ist die Langstreckenschwelle.
    /// nil oder 0 schaltet den Filter ab.
    var minPowerKW: Double? = PowerTier.standard.minPowerKW
    /// Die Leistung zusätzlich an den Daten prüfen, statt dem Server zu trauen.
    /// Nach der Erfahrung mit categorySet ist das keine Paranoia.
    var enforceMinPowerLocally: Bool = true
    /// Erlaubte Steckertypen. Leer = kein Filter.
    var connectorTypes: [ConnectorType] = []
    /// Länge eines Routenabschnitts in Metern. Pro Abschnitt läuft eine Anfrage,
    /// weil TomTom pro Antwort nur 20 Treffer zurückgibt.
    /// 50 statt 100 km: ein 100-km-Abschnitt lief im Test ins 20-Treffer-Limit,
    /// es blieben also Stationen unsichtbar.
    var segmentLengthMeters: Double = 50_000
    /// Obergrenze für Stützpunkte pro Anfrage-Body.
    var maxRoutePointsPerRequest: Int = 200
    /// Verteilt Treffer über den Abschnitt, statt sie am Anfang zu häufen.
    var spreadResults: Bool = true
    /// Pause zwischen zwei Anfragen. TomTom deckelt die Anfragen pro Sekunde
    /// und meldet die Drosselung als 401 mit dem irreführenden Text
    /// "missing valid authentication credentials".
    var requestInterval: Duration = .milliseconds(300)

    // MARK: Umkreissuche

    /// Radius der Umkreissuchen entlang der Route.
    ///
    /// Am 08.09.2026 gegen das amtliche Ladesäulenregister gemessen: Die
    /// Along-Route-Suche deckt bis 500 m neben der Route 95 bis 97 Prozent ab,
    /// jenseits von 1000 m null. Auch 30 Minuten erlaubter Umweg ändern daran
    /// nichts, TomTom legt einen festen geometrischen Korridor um die Route.
    /// Mit ergänzenden Umkreissuchen stieg die Abdeckung von 51 auf 93 Prozent.
    var nearbyRadiusMeters: Double = 5_000
    /// Abstand der Umkreise. Hängt geometrisch mit dem Radius zusammen: Der
    /// abgedeckte Korridor ist sqrt(R² − (Abstand/2)²), bei 5 km Radius alle
    /// 8 km also 3 km. Größere Abstände reißen Lücken zwischen die Kreise.
    var nearbySpacingMeters: Double = 8_000
    /// poiSearch liefert bis zu 100 Treffer, die Along-Route-Suche nur 20.
    var nearbyLimit: Int = 100

}

// Der Initializer steht bewusst in einer Extension: Ein eigener Initializer im
// Typ selbst würde den memberwise-Initializer verdrängen, den der Rest des
// Codes benutzt.
extension AlongRouteSearchOptions {
    init(tier: PowerTier, maxDetourSeconds: Int = 600) {
        self.init()
        minPowerKW = tier.minPowerKW
        self.maxDetourSeconds = maxDetourSeconds
    }

    static let langstrecke = AlongRouteSearchOptions(tier: .schnell)
    static let nurHPC = AlongRouteSearchOptions(tier: .hpc, maxDetourSeconds: 900)
}

// MARK: - Client

actor TomTomAPIClient {
    // MARK: Lifecycle

    init(apiKey: String, session: URLSession = .shared) {
        self.apiKey = apiKey
        self.session = session
    }

    // MARK: Internal

    /// POI-Kategorie "Electric Vehicle Station" im TomTom-Kategoriebaum.
    static let evStationCategory = "7309"

    /// Sucht Ladestationen entlang einer Route.
    ///
    /// Die Route wird in Abschnitte zerlegt, weil eine einzelne Antwort auf 20
    /// Treffer begrenzt ist. Für eine 600-km-Strecke wären das sonst 20 Stationen
    /// auf der gesamten Länge, also praktisch nichts.
    func chargingStationsAlongRoute(
        routeGeometry: [CLLocationCoordinate2D],
        options: AlongRouteSearchOptions = AlongRouteSearchOptions()
    ) async throws -> [ChargingStation] {
        guard !apiKey.isEmpty, apiKey != "YOUR_API_KEY" else { throw TomTomAPIError.missingAPIKey }
        guard routeGeometry.count >= 2 else { throw TomTomAPIError.emptyRoute }

        let segments = Self.splitIntoSegments(
            routeGeometry,
            segmentLengthMeters: options.segmentLengthMeters
        )

        var merged: [String: ChargingStation] = [:]
        var order: [String] = []

        // Abschnitte nacheinander, nicht parallel: das Freemium-Kontingent zählt
        // pro Anfrage, die Reihenfolge entlang der Route bleibt erhalten, und
        // das Tempolimit greift nicht.
        for (index, segment) in segments.enumerated() {
            if index > 0 {
                try? await Task.sleep(for: options.requestInterval)
            }

            let points = GeoUtils.downsample(segment, maxPoints: options.maxRoutePointsPerRequest)
            let stations = try await searchSegment(points: points, options: options)
            for station in stations where merged[station.id] == nil {
                merged[station.id] = station
                order.append(station.id)
            }
        }

        return order.compactMap { merged[$0] }
    }

    /// Sucht Ladestationen im Umkreis von Punkten entlang der Route.
    ///
    /// Ergänzung zur Along-Route-Suche, kein Ersatz: Die kennt den tatsächlichen
    /// Umweg und sortiert danach. Die Umkreissuche fragt Luftlinie ab und holt
    /// dafür, was weiter abseits liegt.
    func chargingStationsAroundRoute(
        routeGeometry: [CLLocationCoordinate2D],
        options: AlongRouteSearchOptions = AlongRouteSearchOptions()
    ) async throws -> [ChargingStation] {
        guard !apiKey.isEmpty else { throw TomTomAPIError.missingAPIKey }
        guard routeGeometry.count >= 2 else { throw TomTomAPIError.emptyRoute }

        let points = GeoUtils.samplePoints(
            along: routeGeometry,
            spacingMeters: options.nearbySpacingMeters
        )

        var merged: [String: ChargingStation] = [:]
        var order: [String] = []

        for (index, point) in points.enumerated() {
            if index > 0 {
                try? await Task.sleep(for: options.requestInterval)
            }

            let stations = try await searchNearby(point: point, options: options)
            for station in stations where merged[station.id] == nil {
                merged[station.id] = station
                order.append(station.id)
            }
        }

        return order.compactMap { merged[$0] }
    }

    /// Holt die Live-Belegung einer Station.
    func availability(for availabilityID: String) async throws -> StationAvailability {
        guard !apiKey.isEmpty, apiKey != "YOUR_API_KEY" else { throw TomTomAPIError.missingAPIKey }

        var components = URLComponents(string: "\(Self.baseURL)/search/2/chargingAvailability.json")
        components?.queryItems = [
            URLQueryItem(name: "key", value: apiKey),
            URLQueryItem(name: "chargingAvailability", value: availabilityID),
        ]
        guard let url = components?.url else { throw TomTomAPIError.invalidURL }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 15

        let data = try await perform(request)
        do {
            let response = try JSONDecoder().decode(ChargingAvailabilityResponse.self, from: data)
            return StationAvailability(response: response)
        } catch {
            throw TomTomAPIError.decoding(underlying: error)
        }
    }

    /// Freitextsuche nach einem Ziel.
    ///
    /// Ein Navi, bei dem man das Ziel auf der Karte suchen muss, ist keins. Die
    /// Suche laeuft ueber denselben Dienst wie die Ladestationssuche, nur ohne
    /// Kategorie- und Leistungsfilter: Gesucht wird alles, Ort, Anschrift,
    /// Betrieb.
    ///
    /// `near` verschiebt die Trefferliste in die eigene Gegend. Ohne diesen
    /// Bezugspunkt liefert eine Suche nach "Hauptstraße" irgendeine.
    func findPlaces(
        matching query: String,
        near: CLLocationCoordinate2D?,
        limit: Int = 8
    ) async throws -> [Place] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else { return [] }

        let encoded = trimmed.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        guard !encoded.isEmpty else { return [] }

        var components = URLComponents(string: "\(Self.baseURL)/search/2/search/\(encoded).json")
        var items = [
            URLQueryItem(name: "key", value: apiKey),
            URLQueryItem(name: "limit", value: String(min(limit, 20))),
            // Waehrend des Tippens: Der Dienst behandelt die Eingabe dann als
            // angefangenes Wort und nicht als vollstaendigen Suchbegriff.
            URLQueryItem(name: "typeahead", value: "true"),
            URLQueryItem(name: "language", value: "de-DE"),
        ]
        if let near {
            items.append(URLQueryItem(name: "lat", value: String(near.latitude)))
            items.append(URLQueryItem(name: "lon", value: String(near.longitude)))
        }
        components?.queryItems = items
        guard let url = components?.url else { throw TomTomAPIError.invalidURL }

        let data = try await perform(URLRequest(url: url))
        let response = try JSONDecoder().decode(AlongRouteSearchResponse.self, from: data)
        return response.results.compactMap(Place.init(result:))
    }

    // MARK: Private

    private static let baseURL = "https://api.tomtom.com"

    private let apiKey: String
    private let session: URLSession

    /// Eine Along-Route-Anfrage für genau einen Abschnitt.
    private func searchSegment(
        points: [CLLocationCoordinate2D],
        options: AlongRouteSearchOptions
    ) async throws -> [ChargingStation] {
        guard points.count >= 2 else { return [] }

        // Die Query steht im Pfad und muss encodiert werden.
        let encodedQuery = options.query
            .addingPercentEncoding(withAllowedCharacters: .alphanumerics)
            ?? "electric%20vehicle%20station"

        var components = URLComponents(
            string: "\(Self.baseURL)/search/2/searchAlongRoute/\(encodedQuery).json"
        )
        var items = [
            URLQueryItem(name: "key", value: apiKey),
            URLQueryItem(name: "maxDetourTime", value: String(min(options.maxDetourSeconds, 3600))),
            URLQueryItem(name: "limit", value: String(min(options.limitPerRequest, 20))),
            URLQueryItem(name: "sortBy", value: "detourTime"),
        ]
        if options.useCategoryFilter {
            items.append(URLQueryItem(name: "categorySet", value: options.categoryID))
        }
        if options.spreadResults {
            items.append(URLQueryItem(name: "spreadingMode", value: "auto"))
        }
        // 0 und nil heißen beide: kein Filter, also den Parameter weglassen.
        if let minPower = options.minPowerKW, minPower > 0 {
            items.append(URLQueryItem(name: "minPowerKW", value: String(minPower)))
        }
        if !options.connectorTypes.isEmpty {
            items.append(URLQueryItem(
                name: "connectorSet",
                value: options.connectorTypes.map(\.rawValue).joined(separator: ",")
            ))
        }
        components?.queryItems = items
        guard let url = components?.url else { throw TomTomAPIError.invalidURL }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 25
        request.httpBody = try JSONEncoder().encode(RouteBody(points: points))

        let data = try await perform(request)
        do {
            let response = try JSONDecoder().decode(AlongRouteSearchResponse.self, from: data)
            var stations = response.results.map(ChargingStation.init(searchResult:))

            // Ohne Kategoriefilter bringt die Freitextsuche auch Tankstellen und
            // Werkstätten mit. Die fallen hier raus.
            if options.onlyEVStations {
                stations = stations.filter(\.isChargingStation)
            }

            if options.enforceMinPowerLocally, let minPower = options.minPowerKW, minPower > 0 {
                stations = stations.filter { $0.meetsMinPower(minPower) }
            }

            return stations
        } catch {
            throw TomTomAPIError.decoding(underlying: error)
        }
    }

    /// Statuscodes, hinter denen eine Drosselung stecken kann.
    private static let throttleStatus: Set<Int> = [401, 403, 429]

    /// Führt die Anfrage aus und fasst bei Drosselung genau einmal nach.
    ///
    /// Der Unterschied ist diagnostisch wertvoll: klappt der zweite Versuch,
    /// war es das Tempolimit. Bleibt es beim Fehler, stimmt etwas mit dem Key
    /// oder der Produktfreigabe nicht.
    /// Eine Umkreissuche über poiSearch.
    private func searchNearby(
        point: CLLocationCoordinate2D,
        options: AlongRouteSearchOptions
    ) async throws -> [ChargingStation] {
        let encodedQuery = options.query
            .addingPercentEncoding(withAllowedCharacters: .alphanumerics)
            ?? "electric%20vehicle%20station"

        var components = URLComponents(string: "\(Self.baseURL)/search/2/poiSearch/\(encodedQuery).json")
        var items = [
            URLQueryItem(name: "key", value: apiKey),
            URLQueryItem(name: "lat", value: String(point.latitude)),
            URLQueryItem(name: "lon", value: String(point.longitude)),
            URLQueryItem(name: "radius", value: String(Int(options.nearbyRadiusMeters))),
            URLQueryItem(name: "limit", value: String(min(options.nearbyLimit, 100))),
        ]
        if options.useCategoryFilter {
            items.append(URLQueryItem(name: "categorySet", value: options.categoryID))
        }
        if let minPower = options.minPowerKW, minPower > 0 {
            items.append(URLQueryItem(name: "minPowerKW", value: String(minPower)))
        }
        if !options.connectorTypes.isEmpty {
            items.append(URLQueryItem(
                name: "connectorSet",
                value: options.connectorTypes.map(\.rawValue).joined(separator: ",")
            ))
        }
        components?.queryItems = items
        guard let url = components?.url else { throw TomTomAPIError.invalidURL }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 20

        let data = try await perform(request)
        do {
            let response = try JSONDecoder().decode(AlongRouteSearchResponse.self, from: data)
            var stations = response.results.map(ChargingStation.init(searchResult:))

            if options.onlyEVStations {
                stations = stations.filter(\.isChargingStation)
            }
            if options.enforceMinPowerLocally, let minPower = options.minPowerKW, minPower > 0 {
                stations = stations.filter { $0.meetsMinPower(minPower) }
            }
            return stations
        } catch {
            throw TomTomAPIError.decoding(underlying: error)
        }
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        var lastStatus = 0
        var lastBody = ""

        for attempt in 0 ... 1 {
            if attempt > 0 {
                try? await Task.sleep(for: .seconds(2))
            }

            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return data }
            if (200 ..< 300).contains(http.statusCode) { return data }

            lastStatus = http.statusCode
            lastBody = String(data: data, encoding: .utf8) ?? ""

            // Alles außerhalb der Drosselungscodes ist sofort endgültig.
            if !Self.throttleStatus.contains(http.statusCode) { break }
        }

        throw TomTomAPIError.http(status: lastStatus, body: lastBody)
    }

    /// Request-Body der Along-Route-Suche.
    private struct RouteBody: Encodable {
        let route: Route

        init(points: [CLLocationCoordinate2D]) {
            route = Route(points: points.map { Point(lat: $0.latitude, lon: $0.longitude) })
        }

        struct Route: Encodable {
            let points: [Point]
        }

        struct Point: Encodable {
            let lat: Double
            let lon: Double
        }
    }
}

// MARK: - Routenaufteilung

extension TomTomAPIClient {
    /// Zerlegt eine Route in Abschnitte von etwa `segmentLengthMeters` Länge.
    ///
    /// Aufeinanderfolgende Abschnitte überlappen sich um einen Punkt, damit an
    /// den Nahtstellen keine Lücke entsteht.
    static func splitIntoSegments(
        _ coordinates: [CLLocationCoordinate2D],
        segmentLengthMeters: Double
    ) -> [[CLLocationCoordinate2D]] {
        guard coordinates.count >= 2, segmentLengthMeters > 0 else {
            return coordinates.isEmpty ? [] : [coordinates]
        }

        var segments: [[CLLocationCoordinate2D]] = []
        var current: [CLLocationCoordinate2D] = [coordinates[0]]
        var accumulated: Double = 0

        for i in 1 ..< coordinates.count {
            accumulated += GeoUtils.distance(coordinates[i - 1], coordinates[i])
            current.append(coordinates[i])

            if accumulated >= segmentLengthMeters, i < coordinates.count - 1 {
                segments.append(current)
                // Überlappung: der letzte Punkt eröffnet den nächsten Abschnitt.
                current = [coordinates[i]]
                accumulated = 0
            }
        }

        if current.count >= 2 {
            segments.append(current)
        } else if var last = segments.popLast() {
            // Ein einzelner Restpunkt hängt an den vorherigen Abschnitt.
            last.append(contentsOf: current)
            segments.append(last)
        }

        return segments
    }
}
