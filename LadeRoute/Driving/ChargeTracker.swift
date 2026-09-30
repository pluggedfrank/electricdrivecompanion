//  ChargeTracker.swift
//  Der Ladestand während der Fahrt, auch über Ladestopps hinweg.
//
//  Gegenstück zu tools/lib/akku.mjs; die Tests dort sind der Maßstab.

import CoreLocation
import Foundation

/// Nach so viel gefahrener Strecke stand der Akku auf so viel, etwa nach
/// einem Ladestopp oder weil jemand den Wert von Hand gesetzt hat.
struct ChargeEvent: Equatable {
    let drivenMeters: Double
    let percent: Double
}

enum ChargeTracker {
    /// Ladestand jetzt: Es zählt das letzte Ereignis hinter dem Auto,
    /// abzüglich des Verbrauchs seitdem.
    static func chargeNow(start: Double, events: [ChargeEvent], drivenMeters: Double, percentPerKm: Double) -> Double {
        var base = ChargeEvent(drivenMeters: 0, percent: start)
        for event in events where event.drivenMeters <= drivenMeters && event.drivenMeters >= base.drivenMeters {
            base = event
        }
        return max(0, base.percent - (drivenMeters - base.drivenMeters) / 1000 * percentPerKm)
    }

    /// Ladestand nach `seconds` an einer Säule, ab `fromKWh`. Halbminütlich
    /// vorwärts, Leistung aus der Kurve und gedeckelt durch die Säule.
    static func charge(
        from fromKWh: Double,
        after seconds: Double,
        curve: [(chargeKWh: Double, powerKW: Double)],
        stationPowerKW: Double,
        batteryKWh: Double
    ) -> Double {
        var charge = fromKWh
        var rest = seconds
        while rest > 0, charge < batteryKWh {
            let dt = min(30, rest)
            let power = min(ChargingStopPlanner.power(at: charge, curve: curve), stationPowerKW)
            guard power > 0 else { break }
            charge = min(batteryKWh, charge + power * dt / 3600)
            rest -= dt
        }
        return charge
    }

    /// Ladestand nach einem Halt an einer Säule, in Prozent. Zwei Minuten
    /// gehen für An- und Abstecken ab; ohne bekannte Leistung 50 kW.
    static func estimate(chargePercent: Double, stopMinutes: Double, stationPowerKW: Double?, vehicle: VehicleProfile) -> Double {
        let kWh = vehicle.usableBatteryKWh
        guard kWh > 0 else { return chargePercent }
        let seconds = max(0, stopMinutes - 2) * 60
        let charged = charge(
            from: chargePercent / 100 * kWh,
            after: seconds,
            curve: vehicle.chargingCurve(),
            stationPowerKW: stationPowerKW ?? 50,
            batteryKWh: kWh
        )
        return min(100, charged / kWh * 100)
    }
}

/// Erkennt, dass das Auto an einer Säule gestanden hat.
///
/// Zwei Minuten innerhalb von 150 m zählen als Ladestopp, das Wegfahren über
/// 300 m beendet ihn. Ein Stau direkt neben einer Säule sieht genauso aus;
/// dafür lässt sich der Stand danach antippen und korrigieren.
struct StopDetector {
    enum Event {
        case arrived(station: ChargingStation)
        case departed(station: ChargingStation, minutes: Double)
    }

    static let radiusMeters: Double = 150
    static let minimumSeconds: TimeInterval = 120
    static let departMeters: Double = 300

    private var station: ChargingStation?
    private var since: Date?
    private var arrived = false

    /// Steht das Auto gerade an einer Säule, erkannt oder noch nicht?
    var isNearStation: Bool { station != nil }

    mutating func step(time: Date, position: CLLocationCoordinate2D, stations: [ChargingStation]) -> Event? {
        if let current = station, let since {
            let d = GeoUtils.distance(position, current.coordinate)
            if d <= Self.radiusMeters {
                if !arrived, time.timeIntervalSince(since) >= Self.minimumSeconds {
                    arrived = true
                    return .arrived(station: current)
                }
                return nil
            }
            if d < Self.departMeters { return nil }
            let event: Event? = arrived ? .departed(station: current, minutes: time.timeIntervalSince(since) / 60) : nil
            reset()
            return event
        }

        var nearest: ChargingStation?
        var best = Double.infinity
        for s in stations {
            let d = GeoUtils.distance(position, s.coordinate)
            if d < best {
                best = d
                nearest = s
            }
        }
        if let nearest, best <= Self.radiusMeters {
            station = nearest
            since = time
            arrived = false
        }
        return nil
    }

    mutating func reset() {
        station = nil
        since = nil
        arrived = false
    }
}
