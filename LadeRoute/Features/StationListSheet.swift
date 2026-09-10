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

    /// Der Ladeplan, in einem Satz.
    ///
    /// Wichtiger als die Ladezeit ist die Zahl der Stopps: Wer zweimal hält,
    /// verliert mehr als die Differenz der Ladezeiten, weil jeder Halt
    /// Abfahren, Anstecken, Bezahlen und Wiederauffahren kostet.
    @ViewBuilder
    private var chargingPlanLine: some View {
        if let plan = trip.chargingPlan {
            HStack(alignment: .top, spacing: 7) {
                Image(systemName: plan.isFeasible ? "bolt.batteryblock" : "exclamationmark.triangle")
                    .font(.system(size: 12))
                    .foregroundStyle(plan.isFeasible ? Theme.river : Theme.signal)
                    .padding(.top, 1)

                VStack(alignment: .leading, spacing: 2) {
                    Text(planHeadline(plan))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(plan.isFeasible ? Theme.ink2 : Theme.signal)

                    if plan.isFeasible, !plan.stops.isEmpty {
                        Text(planDetail(plan))
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.meta)
                            .fixedSize(horizontal: false, vertical: true)
                    } else if case let .gap(_, _, missing) = plan.problem {
                        Text(
                            "Zwischen zwei Stationen liegen \(Int((missing / 1000).rounded())) km "
                                + "mehr, als der Akku hergibt. Mit einer niedrigeren Leistungsstufe "
                                + "kämen mehr Säulen in Frage."
                        )
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.meta)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.vertical, 2)
        }
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
                    if trip.isWideningSearch {
                        Text("·")
                        HStack(spacing: 4) {
                            ProgressView().scaleEffect(0.55).frame(width: 10, height: 10)
                            Text("suche im Umkreis")
                        }
                    }
                }
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.meta)
                .textCase(nil)

                chargingPlanLine
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
            }
        }
        .padding(.vertical, 4)
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
                        // Der seitliche Abstand ist der beste Ersatz.
                        badge("\(Int(abstand.rounded())) m ab Route", color: Theme.river)
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
