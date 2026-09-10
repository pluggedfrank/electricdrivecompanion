//  VehicleProfile.swift
//  Was das Auto kann. Ohne diese Angaben lässt sich keine Ladeplanung rechnen.
//
//  Bewusst wenige Werte: Kapazität, Verbrauch, Ladeleistung, Ladestand, dazu
//  drei Schwellen. Mehr Genauigkeit hilft erst, wenn die groben Zahlen stimmen,
//  und die kann nur jemand liefern, der das Fahrzeug fährt.

import Foundation

struct VehicleProfile: Codable, Equatable, Sendable {
    // MARK: Werte

    var name: String
    /// Nutzbare Kapazität, nicht die Bruttokapazität. Die Differenz ist der
    /// Puffer, den das Fahrzeug selbst verwaltet.
    var usableBatteryKWh: Double
    /// Durchschnittsverbrauch auf der Langstrecke.
    var consumptionKWhPer100km: Double
    /// Spitzenladeleistung. Bestimmt, wie lange ein Stopp dauert.
    var maxChargePowerKW: Double

    /// Ladestand beim Start, in Prozent.
    var currentChargePercent: Double
    /// So viel soll am Ziel noch übrig sein.
    var minArrivalPercent: Double
    /// So leer darf es an einem Ladestopp höchstens werden.
    var minChargeAtStopPercent: Double
    /// Bis hierhin wird geladen. Darüber wird jede Säule langsam, deshalb ist
    /// Weiterfahren fast immer schneller als Vollladen.
    var maxChargeAtStopPercent: Double

    // MARK: Vorgabe

    /// Neutrales Mittelklasseprofil.
    ///
    /// 77 kWh nutzbar, 19 kWh auf 100 km, 240 kW Spitze: die Größenordnung
    /// eines aktuellen Langstreckenwagens. Änderbar, und zu ändern, sobald ein
    /// echtes Testfahrzeug feststeht.
    static let standard = VehicleProfile(
        name: "Mittelklasse",
        usableBatteryKWh: 77,
        consumptionKWhPer100km: 19,
        maxChargePowerKW: 240,
        currentChargePercent: 80,
        minArrivalPercent: 10,
        minChargeAtStopPercent: 10,
        maxChargeAtStopPercent: 80
    )

    // MARK: Abgeleitet

    var currentChargeKWh: Double { usableBatteryKWh * currentChargePercent / 100 }
    var minArrivalKWh: Double { usableBatteryKWh * minArrivalPercent / 100 }
    var minChargeAtStopKWh: Double { usableBatteryKWh * minChargeAtStopPercent / 100 }
    var maxChargeAtStopKWh: Double { usableBatteryKWh * maxChargeAtStopPercent / 100 }

    /// Reichweite mit dem aktuellen Ladestand bis zur Zielreserve, in Kilometern.
    var remainingRangeKm: Double {
        guard consumptionKWhPer100km > 0 else { return 0 }
        return max(0, (currentChargeKWh - minArrivalKWh) / consumptionKWhPer100km * 100)
    }

    /// Reichweite von voll bis zur Reserve. Der Abstand, in dem Ladestopps
    /// höchstens liegen dürfen.
    var fullRangeKm: Double {
        guard consumptionKWhPer100km > 0 else { return 0 }
        return usableBatteryKWh * 0.9 / consumptionKWhPer100km * 100
    }

    // MARK: Für die Routen-API

    /// Verbrauch über der Geschwindigkeit, wie die Routing-API ihn erwartet.
    ///
    /// Die API will eine Tabelle, kein Mittel. Aus einer einzigen Zahl lässt
    /// sich keine echte Kurve machen, aber die Form ist bekannt: Der Verbrauch
    /// steigt mit dem Quadrat der Geschwindigkeit, weil der Luftwiderstand ihn
    /// bestimmt. Der angegebene Wert gilt als der bei 100 km/h.
    ///
    /// Format: "50,8.2:100,15.5:130,22.6"
    var consumptionTable: String {
        let stützstellen: [(speed: Double, faktor: Double)] = [
            (30, 0.62), (50, 0.68), (80, 0.83), (100, 1.0), (120, 1.24), (130, 1.38),
        ]
        return stützstellen
            .map { punkt in
                let verbrauch = consumptionKWhPer100km * punkt.faktor
                return String(format: "%.0f,%.2f", punkt.speed, verbrauch)
            }
            .joined(separator: ":")
    }

    /// Ladekurve als Stützstellen, wie die Routen-API sie erwartet.
    ///
    /// Auch hier gilt die Form, nicht der Messwert: Bis etwa der Hälfte liegt
    /// die Leistung nahe am Maximum, danach fällt sie deutlich ab. Wer bei
    /// 80 Prozent weiterfährt statt vollzuladen, ist fast immer schneller da.
    func chargingCurve() -> [(chargeKWh: Double, powerKW: Double)] {
        let punkte: [(anteil: Double, leistung: Double)] = [
            (0.0, 1.0), (0.2, 1.0), (0.4, 0.92), (0.6, 0.70), (0.8, 0.45), (1.0, 0.15),
        ]
        return punkte.map { punkt in
            (
                chargeKWh: usableBatteryKWh * punkt.anteil,
                powerKW: max(11, maxChargePowerKW * punkt.leistung)
            )
        }
    }
}

// MARK: - Speicher

/// Hält das Profil und schreibt es in die Nutzereinstellungen.
///
/// UserDefaults, weil es ein Datensatz ist und keine Datenbank. Sobald mehrere
/// Profile dazukommen, tritt hier etwas anderes an die Stelle.
@MainActor
final class VehicleProfileStore: ObservableObject {
    // MARK: Lifecycle

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.key),
           let gespeichert = try? JSONDecoder().decode(VehicleProfile.self, from: data) {
            profile = gespeichert
        } else {
            profile = .standard
        }
    }

    // MARK: Internal

    @Published var profile: VehicleProfile {
        didSet { speichern() }
    }

    func zurücksetzen() {
        profile = .standard
    }

    // MARK: Private

    private static let key = "vehicleProfile"
    private let defaults: UserDefaults

    private func speichern() {
        guard let data = try? JSONEncoder().encode(profile) else { return }
        defaults.set(data, forKey: Self.key)
    }
}
