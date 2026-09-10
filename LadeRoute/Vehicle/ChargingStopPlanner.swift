//  ChargingStopPlanner.swift
//  Setzt Ladestopps in eine geplante Route.
//
//  Spiegelt tools/lib/ladeplanung.mjs. Was dort grün ist, muss hier genauso
//  herauskommen; wer eine Fassung ändert, ändert beide.
//
//  Warum selbst rechnen: Long Distance EV Routing von TomTom kann das, steht
//  aber nicht zur Selbstbedienung. Alles Nötige liegt ohnehin vor. Für ein
//  Magazin ist das eher Vorteil als Notbehelf: Warum genau dieser Stopp
//  vorgeschlagen wird, lässt sich damit erklären.

import Foundation

struct ChargingStop: Identifiable, Hashable, Sendable {
    let station: ChargingStation
    /// Wie weit entlang der Route der Stopp liegt.
    let progressMeters: Double
    let arrivalKWh: Double
    let departureKWh: Double
    let chargingSeconds: Double
    let detourSeconds: Double

    var id: String { station.id }

    var standSeconds: Double { chargingSeconds + detourSeconds }
}

struct ChargingPlan: Sendable {
    enum Problem: Equatable, Sendable {
        /// Zwischen zwei Punkten der Route liegt mehr Strecke, als der Akku hergibt.
        case gap(fromMeters: Double, toMeters: Double, missingMeters: Double)
        /// Auf der Strecke steht keine Station, die stark genug ist.
        case noStations
        /// Es geht nicht voran. Sollte nicht vorkommen; hier zur Sicherheit.
        case noProgress
    }

    let stops: [ChargingStop]
    let problem: Problem?
    /// Ladestand am Ziel, wenn der Plan aufgeht.
    let arrivalKWh: Double?
    /// Wie weit es mit dem aktuellen Stand noch reicht.
    let rangeMeters: Double

    var isFeasible: Bool { problem == nil }
    var totalChargingSeconds: Double { stops.reduce(0) { $0 + $1.chargingSeconds } }
    var totalDetourSeconds: Double { stops.reduce(0) { $0 + $1.detourSeconds } }
}

enum ChargingStopPlanner {
    // MARK: Ladekurve

    /// Ladeleistung bei einem bestimmten Ladestand.
    ///
    /// Zwischen den Stützstellen linear interpoliert. Die Kurve ist eine Form
    /// und keine Messung; ihr Sinn ist, dass die letzten Prozent länger dauern
    /// als die ersten, denn daran hängt die Entscheidung, wie voll geladen wird.
    static func power(at chargeKWh: Double, curve: [(chargeKWh: Double, powerKW: Double)]) -> Double {
        guard let first = curve.first, let last = curve.last else { return 0 }
        if chargeKWh <= first.chargeKWh { return first.powerKW }

        for index in 1 ..< curve.count {
            let a = curve[index - 1]
            let b = curve[index]
            guard chargeKWh <= b.chargeKWh else { continue }
            let span = b.chargeKWh - a.chargeKWh
            guard span > 0 else { return b.powerKW }
            let share = (chargeKWh - a.chargeKWh) / span
            return a.powerKW + (b.powerKW - a.powerKW) * share
        }
        return last.powerKW
    }

    /// Wie lange dauert es, von einem Ladestand auf einen anderen zu kommen.
    ///
    /// In kleinen Schritten aufsummiert, weil die Leistung während des Ladens
    /// fällt. Begrenzt wird sie doppelt: durch die Kurve des Fahrzeugs und
    /// durch das, was die Säule hergibt. Eine 400-kW-Säule lädt ein Auto nicht
    /// schneller, als das Auto kann.
    static func chargingSeconds(
        from: Double,
        to: Double,
        curve: [(chargeKWh: Double, powerKW: Double)],
        stationPowerKW: Double
    ) -> Double {
        guard to > from else { return 0 }

        let steps = 60
        let step = (to - from) / Double(steps)
        var seconds: Double = 0

        for index in 0 ..< steps {
            let middle = from + step * (Double(index) + 0.5)
            let power = min(power(at: middle, curve: curve), stationPowerKW)
            guard power > 0 else { return .infinity }
            seconds += (step / power) * 3600
        }

        return seconds
    }

    // MARK: Planung

    /// Wählt die Ladestopps.
    ///
    /// Zwei Regeln, in dieser Reihenfolge:
    ///
    /// 1. So wenige Stopps wie möglich. Ist eine Station in Reichweite, von der
    ///    aus das Ziel erreichbar ist, wird eine davon genommen, und zwar die
    ///    mit der kürzesten Standzeit aus Laden und Umweg.
    /// 2. Sonst die Station, die je Minute Standzeit am weitesten bringt.
    ///
    /// Die Reihenfolge ist der Kern. Die naheliegende Auswahl wäre, immer die
    /// stärkste Säule in Reichweite zu nehmen; das ist falsch, weil eine
    /// 300-kW-Säule nach 60 km einen zweiten Stopp erzwingt, den eine
    /// 150-kW-Säule nach 260 km erspart. Ein Stopp kostet mehr als die Ladezeit:
    /// abfahren, anstecken, bezahlen, wieder auffahren.
    ///
    /// Die Fahrzeit steht in keiner der beiden Regeln. Sie fällt an, egal welche
    /// Station gewählt wird; sie mitzurechnen ließ weit entfernte Stationen
    /// teuer aussehen und bevorzugte den frühen Stopp.
    static func plan(
        routeLengthMeters: Double,
        stations: [AnnotatedStation],
        vehicle: VehicleProfile,
        minPowerKW: Double = 50
    ) -> ChargingPlan {
        let perMeter = vehicle.consumptionKWhPer100km / 100_000
        let curve = vehicle.chargingCurve()
        let atStop = vehicle.minChargeAtStopKWh
        let atArrival = vehicle.minArrivalKWh
        let chargeUpTo = vehicle.maxChargeAtStopKWh

        let candidates = stations
            .map(\.station)
            .filter { ($0.maxPowerKW ?? 0) >= minPowerKW }
            .compactMap { station -> (station: ChargingStation, progress: Double)? in
                guard let progress = station.progressAlongRouteMeters,
                      progress > 0, progress < routeLengthMeters
                else { return nil }
                return (station, progress)
            }
            .sorted { $0.progress < $1.progress }

        var stops: [ChargingStop] = []
        var position: Double = 0
        var charge = vehicle.currentChargeKWh

        // Mehr Stopps als Kandidaten kann es nicht geben. Die Schranke fängt
        // einen Programmierfehler ab, statt die App hängen zu lassen.
        for _ in 0 ... max(candidates.count, 1) {
            let toDestination = routeLengthMeters - position
            if charge >= toDestination * perMeter + atArrival {
                return ChargingPlan(
                    stops: stops,
                    problem: nil,
                    arrivalKWh: charge - toDestination * perMeter,
                    rangeMeters: max(0, (charge - atStop) / perMeter)
                )
            }

            let rangeMeters = max(0, (charge - atStop) / perMeter)
            let reachable = candidates.filter {
                $0.progress > position && $0.progress - position <= rangeMeters
            }

            guard !reachable.isEmpty else {
                let next = candidates.first { $0.progress > position }
                return ChargingPlan(
                    stops: stops,
                    problem: next.map {
                        .gap(
                            fromMeters: position,
                            toMeters: $0.progress,
                            missingMeters: $0.progress - position - rangeMeters
                        )
                    } ?? .noStations,
                    arrivalKWh: nil,
                    rangeMeters: rangeMeters
                )
            }

            var rated: [(stop: ChargingStop, gainMeters: Double, finishes: Bool)] = []
            for candidate in reachable {
                let distance = candidate.progress - position
                let arrival = charge - distance * perMeter
                let detour = candidate.station.detourSeconds ?? 0

                // Bis wohin laden: so viel, wie bis zum Ziel noch fehlt,
                // höchstens bis zur Grenze, ab der jede Säule langsam wird.
                let rest = routeLengthMeters - candidate.progress
                let needed = rest * perMeter + atArrival
                let target = min(chargeUpTo, max(arrival, min(needed, vehicle.usableBatteryKWh)))

                let seconds = chargingSeconds(
                    from: arrival,
                    to: target,
                    curve: curve,
                    stationPowerKW: candidate.station.maxPowerKW ?? 0
                )
                let furtherMeters = max(0, (target - atStop) / perMeter)
                let totalMeters = candidate.progress + furtherMeters
                guard totalMeters > position else { continue }

                rated.append((
                    stop: ChargingStop(
                        station: candidate.station,
                        progressMeters: candidate.progress,
                        arrivalKWh: arrival,
                        departureKWh: target,
                        chargingSeconds: seconds,
                        detourSeconds: detour
                    ),
                    gainMeters: totalMeters - position,
                    finishes: target - rest * perMeter >= atArrival - 1e-9
                ))
            }

            guard !rated.isEmpty else {
                return ChargingPlan(
                    stops: stops,
                    problem: .noProgress,
                    arrivalKWh: nil,
                    rangeMeters: rangeMeters
                )
            }

            let finishing = rated.filter(\.finishes)
            let best = finishing.isEmpty
                ? rated.min { $0.stop.standSeconds / $0.gainMeters < $1.stop.standSeconds / $1.gainMeters }!
                : finishing.min { $0.stop.standSeconds < $1.stop.standSeconds }!

            stops.append(best.stop)
            position = best.stop.progressMeters
            charge = best.stop.departureKWh
        }

        return ChargingPlan(stops: stops, problem: .noProgress, arrivalKWh: nil, rangeMeters: 0)
    }
}
