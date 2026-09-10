//  StationListSheet.swift
//  Die Trefferliste. Hier wird sichtbar, was der eigene Datenbestand beiträgt:
//  jede Station mit Redaktionsurteil bekommt den roten Punkt und den Klartext.

import SwiftUI

struct StationListSheet: View {
    @ObservedObject var trip: TripViewModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    filterRow
                } header: {
                    summaryHeader
                }
                .listRowBackground(Theme.paper)

                Section {
                    ForEach(Array(trip.stationsForList.enumerated()), id: \.element.id) { index, item in
                        NavigationLink {
                            StationDetailView(station: item)
                        } label: {
                            StationRow(
                                index: index + 1,
                                item: item,
                                isPlannedStop: trip.plannedStopIDs.contains(item.id)
                            )
                        }
                        .listRowBackground(
                            item.id == trip.selectedStationID ? Theme.panel : Theme.paper
                        )
                        .simultaneousGesture(TapGesture().onEnded {
                            trip.selectStation(id: item.id)
                        })
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.paper)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("\(trip.stations.count) Ladestationen")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.ink)
                }
            }
        }
    }

    /// Womit gerechnet wurde.
    ///
    /// Steht hier, weil ein Ladeplan ohne die Fahrzeugwerte nicht zu beurteilen
    /// ist. Fünf Stopps können richtig oder unsinnig sein, je nachdem, ob der
    /// Akku 40 oder 100 kWh hat und mit welchem Stand es losging. Auf einem
    /// Bildschirmfoto fehlte diese Angabe, und die Frage, ob die Planung stimmt,
    /// war ohne Rückfrage nicht zu beantworten.
    @ViewBuilder
    private var vehicleLine: some View {
        let fahrzeug = trip.vehicleStore.profile
        Text(
            "\(Int(fahrzeug.usableBatteryKWh)) kWh · "
                + String(format: "%.1f", fahrzeug.consumptionKWhPer100km) + " kWh/100 km · "
                + "Start \(Int(fahrzeug.currentChargePercent)) % · "
                + "Reichweite \(Int(fahrzeug.remainingRangeKm)) km"
        )
        .font(.system(size: 11).monospacedDigit())
        .foregroundStyle(Theme.faint)
        .textCase(nil)
    }

    /// Der Ladeplan, in einem Satz.
    ///
    /// Wichtiger als die Ladezeit ist die Zahl der Stopps: Wer zweimal hält,
    /// verliert mehr als die Differenz der Ladezeiten, weil jeder Halt
    /// Abfahren, Anstecken, Bezahlen und Wiederauffahren kostet.
    @ViewBuilder
    private var chargingPlanLine: some View {
        if let plan = trip.chargingPlan {
            // Solange die Umkreissuche läuft, ist die Liste unvollständig, und
            // eine Lücke darin ist womöglich gar keine. Ein rotes "geht nicht"
            // wäre dann schlicht falsch: Genau das ist im Simulator passiert,
            // bei 46 von 94 Stationen.
            let vorläufig = (trip.isWideningSearch || trip.isComputingDetours) && !plan.isFeasible

            HStack(alignment: .top, spacing: 7) {
                Image(systemName: symbol(for: plan, vorläufig: vorläufig))
                    .font(.system(size: 12))
                    .foregroundStyle(farbe(for: plan, vorläufig: vorläufig))
                    .padding(.top, 1)

                VStack(alignment: .leading, spacing: 2) {
                    Text(vorläufig ? "Noch keine durchgehende Ladeplanung" : planHeadline(plan))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(farbe(for: plan, vorläufig: vorläufig))

                    if vorläufig {
                        Text("Die Umkreissuche läuft noch, es fehlen Stationen.")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.meta)
                    } else if plan.isFeasible, !plan.stops.isEmpty {
                        Text(planDetail(plan))
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.meta)
                            .fixedSize(horizontal: false, vertical: true)
                    } else if let text = problemDetail(plan) {
                        Text(text)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.meta)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func symbol(for plan: ChargingPlan, vorläufig: Bool) -> String {
        if vorläufig { return "hourglass" }
        return plan.isFeasible ? "bolt.batteryblock" : "exclamationmark.triangle"
    }

    private func farbe(for plan: ChargingPlan, vorläufig: Bool) -> Color {
        if vorläufig { return Theme.meta }
        return plan.isFeasible ? Theme.ink2 : Theme.signal
    }

    /// Sagt, woran es liegt, und nennt die Stelle.
    ///
    /// "18 km zu viel" allein hilft niemandem. Wo die Lücke liegt, entscheidet
    /// darüber, ob man den Filter lockert, das Fahrzeug voller lädt oder die
    /// Route ändert.
    private func problemDetail(_ plan: ChargingPlan) -> String? {
        switch plan.problem {
        case let .gap(from, to, missing):
            return "Zwischen km \(Int(from / 1000)) und km \(Int(to / 1000)) liegen "
                + "\(Int((missing / 1000).rounded())) km mehr, als der Akku hergibt. "
                + "Mit dem Ladestand von dort reicht es \(Int((plan.rangeMeters / 1000).rounded())) km. "
                + "Eine niedrigere Leistungsstufe bringt mehr Säulen in Frage."
        case .noStations:
            return "Auf dieser Strecke steht keine Station, die den Filter erfüllt."
        case .noProgress, .none:
            return nil
        }
    }

    private func abstandText(_ meters: Double) -> String {
        meters < 1000
            ? "\(Int(meters)) m"
            : String(format: "%.1f km", meters / 1000)
    }

    private func planHeadline(_ plan: ChargingPlan) -> String {
        guard plan.isFeasible else { return "Mit diesem Filter geht die Strecke nicht auf" }
        if plan.stops.isEmpty { return "Ohne Ladestopp zu schaffen" }
        let laden = Int((plan.totalChargingSeconds / 60).rounded())
        return plan.stops.count == 1
            ? "Ein Ladestopp, \(laden) min laden"
            : "\(plan.stops.count) Ladestopps, \(laden) min laden"
    }

    private func planDetail(_ plan: ChargingPlan) -> String {
        plan.stops
            .map { stopp in
                let km = Int((stopp.progressMeters / 1000).rounded())
                let minuten = Int((stopp.chargingSeconds / 60).rounded())
                let name = stopp.station.operatorName ?? stopp.station.name
                return "km \(km) \(name), \(minuten) min"
            }
            .joined(separator: "  ·  ")
    }

    private var summaryHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let summary = trip.routeSummary {
                HStack(spacing: 6) {
                    Text(String(format: "%.0f km", summary.distanceKm))
                    Text("·")
                    Text(formattedDuration(minutes: summary.durationMinutes))
                    if trip.editorialCount > 0 {
                        Text("·")
                        HStack(spacing: 4) {
                            Circle().fill(Theme.signal).frame(width: 6, height: 6)
                            Text("\(trip.editorialCount) im Test")
                        }
                    }
                    if trip.isWideningSearch || trip.isComputingDetours {
                        Text("·")
                        HStack(spacing: 4) {
                            ProgressView().scaleEffect(0.55).frame(width: 10, height: 10)
                            Text(trip.isWideningSearch ? "suche im Umkreis" : "rechne Umwege")
                        }
                    }
                }
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.meta)
                .textCase(nil)

                chargingPlanLine
                vehicleLine
            }
        }
        .padding(.bottom, 4)
    }

    private var filterRow: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Picker("Ladeleistung", selection: $trip.powerTier) {
                    ForEach(PowerTier.allCases) { tier in
                        Text(tier.label).tag(tier)
                    }
                }
                .pickerStyle(.segmented)
                .onChange(of: trip.powerTier) { _, _ in trip.reapplyFilters() }

                Text(trip.powerTier.explanation)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.meta)
            }

            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text("Abstand von der Route")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.ink2)
                    Spacer()
                    Text(abstandText(trip.maxDistanceFromRouteMeters))
                        .font(.system(size: 14, weight: .semibold).monospacedDigit())
                        .foregroundStyle(Theme.ink)
                }
                Slider(value: $trip.maxDistanceFromRouteMeters, in: 200 ... 5000, step: 100) { editing in
                    if !editing { trip.reapplyFilters() }
                }
                .tint(Theme.signal)

                Text("Luftlinie zur Strecke. Gilt für jede Station.")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.faint)
                    .textCase(nil)
            }

            Section {
                HStack {
                    Text("Umweg höchstens")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.ink2)
                    Spacer()
                    Text("\(Int(trip.maxDetourMinutes)) min")
                        .font(.system(size: 14, weight: .semibold).monospacedDigit())
                        .foregroundStyle(Theme.ink)
                }
                Slider(value: $trip.maxDetourMinutes, in: 2 ... 30, step: 1) { editing in
                    if !editing { trip.reapplyFilters() }
                }
                .tint(Theme.signal)

                // Ohne diesen Satz wirkt der Regler kaputt: Man stellt zwei
                // Minuten ein und bekommt weiter hundert Stationen, solange die
                // Umwege noch nicht gerechnet sind.
                Text(umwegHinweis)
                .font(.system(size: 11))
                .foregroundStyle(Theme.faint)
                .textCase(nil)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
    }

    /// Was der Umwegregler gerade kann.
    private var umwegHinweis: String {
        let bekannt = trip.detourKnownCount
        let gesamt = trip.stations.count
        if trip.isComputingDetours {
            return "Echte Fahrzeit vom Abfahren bis zum Wiederauffahren, bisher für "
                + "\(bekannt) von \(gesamt) Stationen. Der Rest wird gerade gerechnet; "
                + "bis dahin greift der Regler dort nicht."
        }
        if bekannt < gesamt {
            return "Echte Fahrzeit vom Abfahren bis zum Wiederauffahren, aber nur für "
                + "\(bekannt) von \(gesamt) Stationen bekannt. Wo keiner bekannt ist, "
                + "greift der Regler nicht."
        }
        return "Echte Fahrzeit vom Abfahren bis zum Wiederauffahren, für alle "
            + "\(gesamt) Stationen. \(trip.detourComputedCount) davon über Matrix-Routing "
            + "gerechnet, der Rest von TomTom mitgeliefert."
    }

    private func formattedDuration(minutes: Double) -> String {
        let total = Int(minutes.rounded())
        let hours = total / 60
        let rest = total % 60
        return hours > 0 ? "\(hours) h \(rest) min" : "\(rest) min"
    }
}

// MARK: - Zeile

struct StationRow: View {
    let index: Int
    let item: AnnotatedStation
    /// Steht die Station im Ladeplan? Dann ist sie kein Vorschlag mehr,
    /// sondern der Halt, mit dem die Strecke aufgeht.
    var isPlannedStop = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle()
                    .fill(
                        isPlannedStop
                            ? Theme.river
                            : (item.hasEditorialContent ? Theme.signal : Theme.faint)
                    )
                    .frame(width: 26, height: 26)
                Text("\(index)")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(item.station.name)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.ink)
                        .lineLimit(1)

                    if isPlannedStop {
                        HStack(spacing: 3) {
                            Image(systemName: "bolt.fill").font(.system(size: 8, weight: .bold))
                            Text("Ladestopp")
                                .font(.system(size: 10, weight: .semibold))
                        }
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(Theme.river, in: Capsule())
                    }
                }

                HStack(spacing: 6) {
                    if let power = item.station.maxPowerKW {
                        badge(String(format: "%.0f kW", power), color: Theme.ink2)
                    } else {
                        // Nicht ausgefiltert, aber sichtbar gemacht: fehlende
                        // Daten sind kein Beleg für eine langsame Säule.
                        badge("kW unbekannt", color: Theme.faint)
                    }
                    ForEach(item.station.distinctConnectorTypes.prefix(2), id: \.self) { type in
                        badge(type.shortName, color: Theme.meta)
                    }
                    if let detour = item.station.detourSeconds {
                        badge("+\(Int((detour / 60).rounded())) min", color: Theme.river)
                    } else if let abstand = item.station.distanceFromRouteMeters {
                        // Treffer aus der Umkreissuche bringen keinen Umweg mit.
                        // Die Luftlinie ist der beste Ersatz, und sie heißt hier
                        // auch so: Ein Umweg in Minuten und eine Luftlinie in
                        // Metern sind zwei verschiedene Dinge, und wer sie gleich
                        // beschriftet, lädt zum Vergleich von Unvergleichbarem ein.
                        badge("\(Int(abstand.rounded())) m Luftlinie", color: Theme.meta)
                    }
                }

                if let availability = item.availability {
                    availabilityLine(availability)
                }

                if let editorial = item.editorial, editorial.isTested {
                    editorialLine(editorial)
                }
            }
        }
        .padding(.vertical, 5)
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 11, weight: .medium).monospacedDigit())
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Theme.panel, in: RoundedRectangle(cornerRadius: 4))
    }

    private func availabilityLine(_ availability: StationAvailability) -> some View {
        HStack(spacing: 5) {
            Circle()
                .fill(availability.isUsable ? Theme.free : Theme.busy)
                .frame(width: 6, height: 6)
            Text("\(availability.available) von \(availability.total) frei")
                .font(.system(size: 12).monospacedDigit())
                .foregroundStyle(Theme.meta)
        }
    }

    private func editorialLine(_ editorial: EditorialEntry) -> some View {
        HStack(alignment: .top, spacing: 5) {
            Circle()
                .fill(Theme.signal)
                .frame(width: 6, height: 6)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 1) {
                if let label = editorial.ratingLabel, let rating = editorial.rating {
                    Text("\(label) · \(String(format: "%.1f", rating))")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.signal)
                }
                Text(editorial.verdictText ?? "")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.ink2)
                    .lineLimit(2)
            }
        }
    }
}
