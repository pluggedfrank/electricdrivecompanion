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

// MARK: - Suchoptionen

struct AlongRouteSearchOptions: Sendable {
    /// Der Suchbegriff steht bei searchAlongRoute im Pfad und ist Pflicht. Er
    /// wirkt als Freitextsuche über POI-Namen und Kategorien. "charging station"
    /// trifft deshalb nur Betreiber, die das Wort im Namen führen, und lässt
    /// Ionity, EnBW oder Aral pulse liegen. Der offizielle Kategoriename zu 7309
    /// trifft dagegen die Kategorie selbst.
    var query: String = "electric vehicle station"
    /// Zusätzlich hart auf die EV-Kategorie filtern.
    var useCategoryFilter: Bool = true
    /// Maximal zulässiger Umweg. TomTom deckelt bei 3600 s.
    var maxDetourSeconds: Int = 600
    /// Treffer pro Anfrage. Die Along-Route-Suche liefert höchstens 20.
    var limitPerRequest: Int = 20
    /// Mindest-Ladeleistung in kW. nil = kein Filter.
    var minPowerKW: Double?
    /// Erlaubte Steckertypen. Leer = kein Filter.
    var connectorTypes: [ConnectorType] = []
    /// Länge eines Routenabschnitts in Metern. Pro Abschnitt läuft eine Anfrage,
    /// weil TomTom pro Antwort nur 20 Treffer zurückgibt.
    var segmentLengthMeters: Double = 100_000
    /// Obergrenze für Stützpunkte pro Anfrage-Body.
    var maxRoutePointsPerRequest: Int = 200
    /// Verteilt Treffer über den Abschnitt, statt sie am Anfang zu häufen.
    var spreadResults: Bool = true
    /// Pause zwischen zwei Anfragen. TomTom deckelt die Anfragen pro Sekunde
    /// und meldet die Drosselung als 401 mit dem irreführenden Text
    /// "missing valid authentication credentials".
    var requestInterval: Duration = .milliseconds(300)

    static let schnellladen = AlongRouteSearchOptions(
        maxDetourSeconds: 900,
        minPowerKW: 100,
        connectorTypes: [.ccs2, .chademo, .tesla]
    )
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
            items.append(URLQueryItem(name: "categorySet", value: Self.evStationCategory))
        }
        if options.spreadResults {
            items.append(URLQueryItem(name: "spreadingMode", value: "auto"))
        }
        if let minPower = options.minPowerKW {
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
            return response.results.map(ChargingStation.init(searchResult:))
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
