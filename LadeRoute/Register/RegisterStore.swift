//  RegisterStore.swift
//  Das Ladesäulenregister der Bundesnetzagentur als Stationsquelle.
//
//  Gegenstück zu tools/lib/registerquelle.mjs. Warum nicht die TomTom-Suche:
//  Die Search API hat im Freemium 2.500 Anfragen im Monat, und eine
//  Routenplanung mit Along-Route- und Umkreissuche kostet rund fünfzig. Das
//  Register liegt als Datei im Bundle, deckt Deutschland vollständig ab und
//  kostet nichts. TomTom bleibt für das, was das Register nicht hat:
//  Zielsuche und Live-Belegung, beides auf Abruf.
//
//  Lizenz: CC BY 4.0, Namensnennung "Bundesnetzagentur.de". Die Nennung steht
//  in der Liste, siehe StationListSheet.

import CoreLocation
import Foundation

struct RegisterFile: Decodable {
    let quelle: String?
    let lizenz: String?
    let namensnennung: String?
    let registerdatei: String?
    let leistungAbKW: Double?
    let standorte: [RegisterSite]
}

struct RegisterSite: Decodable {
    let lat: Double
    let lon: Double
    let `operator`: String?
    let maxPowerKW: Double?
    let deviceCount: Int?
    let pointCount: Int?
    let address: String?
    let postalCode: String?
    let city: String?
}

final class RegisterStore: @unchecked Sendable {
    // MARK: Lifecycle

    init(sites: [RegisterSite], minPowerKW: Double, sourceName: String, attribution: String) {
        stations = sites.map(ChargingStation.init(registerSite:))
        self.minPowerKW = minPowerKW
        self.sourceName = sourceName
        self.attribution = attribution
    }

    /// Lädt den Export mit der niedrigsten Leistungsstufe, der im Bundle liegt.
    ///
    /// Der 150-kW-Export enthält die 300-kW-Standorte mit; wer ihn hat,
    /// braucht den anderen nicht. Fehlt er, tut es der 300-kW-Export, dann
    /// gilt die App als "ab 300 kW" und fällt für niedrigere Stufen auf die
    /// TomTom-Suche zurück.
    static func loadBundled(bundle: Bundle = .main) -> RegisterStore {
        for name in ["standorte-150kw", "standorte-300kw"] {
            guard let url = bundle.url(forResource: name, withExtension: "json") else { continue }
            do {
                let file = try JSONDecoder().decode(RegisterFile.self, from: Data(contentsOf: url))
                return RegisterStore(
                    sites: file.standorte,
                    minPowerKW: file.leistungAbKW ?? 300,
                    sourceName: file.quelle ?? "Ladesäulenregister der Bundesnetzagentur",
                    attribution: file.namensnennung ?? "Bundesnetzagentur.de"
                )
            } catch {
                assertionFailure("\(name).json nicht lesbar: \(error)")
            }
        }
        return RegisterStore(sites: [], minPowerKW: .infinity, sourceName: "", attribution: "")
    }

    // MARK: Internal

    /// Alle Standorte, unabhängig von einer Route.
    let stations: [ChargingStation]
    /// Ab welcher Leistung der Export vollständig ist. Darunter fehlt alles.
    let minPowerKW: Double
    let sourceName: String
    let attribution: String

    var isEmpty: Bool { stations.isEmpty }

    /// Die Standorte entlang einer Route, in Fahrtrichtung sortiert.
    ///
    /// Erst eine grobe Vorauswahl über die Bounding Box, dann die Projektion:
    /// Ohne Vorauswahl würden 4.668 Standorte gegen 3.700 Routenpunkte
    /// gerechnet.
    func stations(
        along geometry: [CLLocationCoordinate2D],
        maxDistanceMeters: CLLocationDistance
    ) -> [ChargingStation] {
        guard geometry.count >= 2, !stations.isEmpty else { return [] }

        let padding = maxDistanceMeters / 111_000 + 0.01
        var minLat = Double.infinity, maxLat = -Double.infinity
        var minLon = Double.infinity, maxLon = -Double.infinity
        for point in geometry {
            minLat = min(minLat, point.latitude)
            maxLat = max(maxLat, point.latitude)
            minLon = min(minLon, point.longitude)
            maxLon = max(maxLon, point.longitude)
        }

        let candidates = stations.filter {
            $0.latitude >= minLat - padding && $0.latitude <= maxLat + padding
                && $0.longitude >= minLon - padding && $0.longitude <= maxLon + padding
        }

        return GeoUtils.orderAlongRoute(
            candidates,
            routeGeometry: geometry,
            maxDistanceMeters: maxDistanceMeters
        )
    }
}

// MARK: - Aufbereitung aus dem Register

extension ChargingStation {
    init(registerSite site: RegisterSite) {
        // Eine stabile Kennung aus den Koordinaten: Das Register hat keine
        // Standort-ID. Fünf Nachkommastellen sind rund ein Meter.
        id = "bnetza:\(String(format: "%.5f", site.lat)),\(String(format: "%.5f", site.lon))"
        name = Self.shortOperator(site.`operator`)
        address = [
            site.address,
            [site.postalCode, site.city].compactMap { $0 }.joined(separator: " "),
        ]
        .compactMap { $0 }
        .filter { !$0.isEmpty }
        .joined(separator: ", ")
        latitude = site.lat
        longitude = site.lon
        // Das Register kennt keine Steckertypen, nur Leistung und Zahl der
        // Ladepunkte. Ein Anschluss je Ladepunkt mit der Standortleistung,
        // damit maxPowerKW und die Leistungsfilter unverändert funktionieren.
        connectors = (0 ..< max(1, site.pointCount ?? 1)).map { _ in
            Connector(type: nil, ratedPowerKW: site.maxPowerKW, currentType: "DC")
        }
        categories = ["Electric Vehicle Station"]
        deviceCount = site.deviceCount
        pointCount = site.pointCount
        availabilityID = nil
        detourSeconds = nil
        detourMeters = nil
        distanceFromRouteMeters = nil
        progressAlongRouteMeters = nil
        operatorName = site.`operator`
        isFromRegister = true
    }

    /// Rechtsformen weg, der Rest bleibt, wie er ist.
    ///
    /// Das Register schreibt "EnBW mobility+ AG und Co.KG". In einer Liste
    /// von vierzig Stationen ist das nur Rauschen.
    static func shortOperator(_ operatorName: String?) -> String {
        guard let operatorName, !operatorName.isEmpty else { return "Ladestation" }
        var text = operatorName
        let patterns = [
            #"\s*(&|und)\s*Co\.?\s*(KG|OHG)?\b\.?"#,
            #"\b(GmbH|AG|SE|KG|mbH|e\.?V\.?|OHG|Ltd\.?|B\.?V\.?|S\.?A\.?|Inc\.?)\b\.?"#,
        ]
        for pattern in patterns {
            text = text.replacingOccurrences(of: pattern, with: " ", options: .regularExpression)
        }
        text = text.replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
        text = text.trimmingCharacters(in: CharacterSet(charactersIn: " ,"))
        return text.isEmpty ? operatorName : text
    }
}
