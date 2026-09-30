//  DrivingOverlay.swift
//  Die Fahransicht: oben links die nächste Anweisung, rechts drei Kacheln
//  mit den nächsten Ladern, unten die Fahrleiste mit Ankunft, Reststrecke,
//  Akku und den Knöpfen.
//
//  Konzept: https://claude.ai/artifact/Cw4CHJhntL2dVZHtTfZixe
//  Regeln daraus, die hier umgesetzt sind: höchstens drei Kacheln, kein
//  Scrollen, die große Zahl ist die Strecke auf der Route, daneben der Akku
//  bei Ankunft, der geplante Stopp dunkel, eine Linie, wo die Reserve endet.
//
//  Die nächste Station steht unten, die fernste oben, wie die Straße vor
//  einem: Was als Nächstes kommt, ist am Auto. Wunsch vom 30.09. nach der
//  ersten Simulation; das Konzept hatte es andersherum.
//
//  Aufteilung seit der Zielführung: Die Anweisung gehört dorthin, wo der
//  Blick zuerst hinfällt, nach oben links. Die Fahrleiste geht unten über
//  die ganze Breite, im Querformat nur unter der Karte, damit die Kacheln
//  die volle Höhe behalten.

import SwiftUI

struct DrivingOverlay: View {
    @ObservedObject var trip: TripViewModel

    var body: some View {
        GeometryReader { geometry in
            let landscape = geometry.size.width > geometry.size.height
            let railWidth = landscape ? geometry.size.width * 0.30 : geometry.size.width * 0.40
            let leftWidth = geometry.size.width - railWidth - 32
            let barHeight: CGFloat = landscape ? 58 : 62

            ZStack(alignment: .topLeading) {
                Color.clear

                rail(compact: !landscape)
                    .frame(width: railWidth)
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .padding(.top, 8)
                    .padding(.bottom, landscape ? 10 : barHeight + 18)
                    .padding(.trailing, 10)
                    .frame(maxWidth: .infinity, alignment: .trailing)

                guidancePanel(compact: !landscape)
                    .frame(width: leftWidth, alignment: .leading)
                    .padding(.leading, 12)
                    .padding(.top, 8)

                mapControls
                    .padding(.leading, 12)
                    .padding(.bottom, barHeight + 18)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)

                drivingBar(compact: !landscape)
                    .frame(height: barHeight)
                    .frame(width: landscape ? leftWidth : geometry.size.width - 20)
                    .padding(.leading, landscape ? 12 : 10)
                    .padding(.bottom, 8)
                    .frame(maxHeight: .infinity, alignment: .bottomLeading)
            }
            .onAppear {
                trip.mapTrailingInset = railWidth + 20
                trip.mapDrivingBottomInset = barHeight + 24
            }
            .onChange(of: railWidth) { _, width in trip.mapTrailingInset = width + 20 }
            .onChange(of: barHeight) { _, height in trip.mapDrivingBottomInset = height + 24 }
        }
        .sheet(isPresented: $trip.isAdjustingCharge) {
            ChargeAdjustSheet(initial: trip.chargeNowPercent) { percent in
                trip.setChargeNow(percent)
                trip.chargeNotice = nil
            }
            .presentationDetents([.height(260)])
        }
    }

    // MARK: Übersicht

    /// Links über der Fahrleiste: die ganze Route zeigen, und in der
    /// Übersicht Plus, Minus und zurück zur mitfahrenden Kamera.
    private var mapControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            if trip.drivingOverview {
                roundButton("plus", label: "Hineinzoomen") { trip.mapCommands.send(.zoomIn) }
                roundButton("minus", label: "Herauszoomen") { trip.mapCommands.send(.zoomOut) }
                Button { trip.drivingOverview = false } label: {
                    Label("Zur Fahrt", systemImage: "location.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 14)
                        .frame(height: 44)
                        .background(Theme.river, in: Capsule())
                        .shadow(color: .black.opacity(0.14), radius: 8, y: 2)
                }
                .buttonStyle(.plain)
            } else {
                roundButton("map", label: "Ganze Route zeigen") { trip.drivingOverview = true }
            }
        }
    }

    private func roundButton(_ systemImage: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.ink)
                .frame(width: 44, height: 44)
                .background(Theme.paper.opacity(0.97), in: Circle())
                .shadow(color: .black.opacity(0.14), radius: 8, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    // MARK: Anweisung

    @ViewBuilder
    private func guidancePanel(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if trip.isRerouting {
                notice("Route wird neu berechnet …", systemImage: "arrow.triangle.2.circlepath")
            } else if let maneuver = trip.nextManeuver {
                ManeuverBanner(maneuver: maneuver, compact: compact)
            } else if let problem = trip.guidanceProblem {
                notice(problem, systemImage: "speaker.slash")
            } else if trip.guidance.isEmpty {
                notice("Anweisungen werden geladen …", systemImage: "hourglass")
            }
            if let selected = trip.selectedStation {
                StationActionCard(
                    item: selected,
                    isVia: trip.viaStation?.id == selected.id,
                    onToggleVia: {
                        if trip.viaStation?.id == selected.id { trip.clearVia() } else { trip.routeVia(stationID: selected.id) }
                    },
                    onClose: { trip.selectedStationID = nil }
                )
            }
            if let stop = trip.simulatedStop {
                SimulatedStopCard(stop: stop, chargeNow: trip.chargeNowPercent) { trip.finishSimulatedStop() }
            } else if let name = trip.chargingAt {
                notice("Ladestopp bei \(name)", systemImage: "bolt.car")
            }
            if let charged = trip.chargeNotice {
                ChargeNoticeCard(notice: charged, onAdjust: { trip.isAdjustingCharge = true }, onClose: { trip.chargeNotice = nil })
            }
            if let fix = trip.driveFix, !fix.isOnRoute {
                notice("Nicht auf der Route, \(Int(fix.offsetMeters)) m daneben", systemImage: "exclamationmark.triangle")
            }
        }
        .animation(.easeOut(duration: 0.25), value: trip.nextManeuver?.instruction.id)
    }

    private func notice(_ text: String, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Theme.ink)
            .lineLimit(2)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Theme.paper.opacity(0.96), in: RoundedRectangle(cornerRadius: 14))
            .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
    }

    // MARK: Kacheln

    @ViewBuilder
    private func rail(compact: Bool) -> some View {
        VStack(spacing: compact ? 8 : 10) {
            if trip.drivingTiles.isEmpty {
                Text(emptyText)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.meta)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.paper.opacity(0.96), in: RoundedRectangle(cornerRadius: 14))
            }
            // Umgekehrt: die fernste oben, die nächste unten. Die Nummer
            // bleibt die Reihenfolge ab dem Auto, 1 ist die nächste.
            ForEach(Array(trip.drivingTiles.enumerated()).reversed(), id: \.element.id) { index, tile in
                DrivingTileView(tile: tile, order: index + 1, compact: compact)
                    // Antippen holt die Belegung und öffnet oben links die
                    // Karte mit "Über diese Station".
                    .onTapGesture { trip.selectStation(id: tile.id) }
                    // Neue kommen oben herein, vorbeigefahrene gehen unten
                    // hinaus, wie die Straße.
                    .transition(.asymmetric(
                        insertion: .move(edge: .top).combined(with: .opacity),
                        removal: .move(edge: .bottom).combined(with: .opacity)
                    ))
                // Die Linie der Reserve unter der ersten Station, die nicht
                // mehr erreichbar ist: darüber liegt, was zu weit ist.
                if index == reachLineIndex {
                    reachLine
                }
            }
            // Ganz unten, direkt über dem Auto: die Ausweichstation, wenn
            // der nächste Favorit zu weit ist.
            if let fallback = trip.drivingFallback {
                FallbackRow(tile: fallback, reason: trip.drivingFallbackReason, compact: compact)
                    .onTapGesture { trip.selectStation(id: fallback.id) }
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.35), value: trip.drivingTiles.map(\.id))
    }

    private var emptyText: String {
        if trip.driveFix == nil { return "Suche die eigene Position auf der Route …" }
        return trip.favoritesActive
            ? "Kein bevorzugter Anbieter mehr bis zum Ziel."
            : "Keine passenden Lader mehr bis zum Ziel."
    }

    private var reachLineIndex: Int {
        trip.drivingTiles.firstIndex { !$0.isReachable } ?? -1
    }

    private var reachLine: some View {
        HStack(spacing: 6) {
            dashed
            Text("Reserve \(Int(trip.vehicleStore.profile.minChargeAtStopPercent)) % nach \(Int(trip.rangeToReserveKm)) km")
                .font(.system(size: 10, weight: .bold))
                .textCase(.uppercase)
                .foregroundStyle(Theme.signal)
                .fixedSize()
            dashed
        }
        .padding(.vertical, 2)
    }

    private var dashed: some View {
        Rectangle()
            .fill(Theme.signal.opacity(0.7))
            .frame(height: 2)
            .mask(
                HStack(spacing: 4) {
                    ForEach(0 ..< 40, id: \.self) { _ in Rectangle().frame(width: 6) }
                }
            )
    }

    // MARK: Fahrleiste

    private func drivingBar(compact: Bool) -> some View {
        HStack(spacing: compact ? 10 : 16) {
            barButton(
                systemImage: "xmark",
                label: compact ? nil : (trip.isSimulatingDrive ? "Simulation beenden" : "Beenden"),
                accessibility: trip.isSimulatingDrive ? "Simulation beenden" : "Fahrt beenden"
            ) { trip.stopDriving() }

            if trip.isSimulatingDrive {
                Button { trip.cycleSimulationFactor() } label: {
                    Text("\(Int(trip.simulationFactor))×")
                        .font(.system(size: 14, weight: .bold, design: .rounded).monospacedDigit())
                        .foregroundStyle(Theme.river)
                        .frame(minWidth: 40, minHeight: 40)
                        .background(Theme.river.opacity(0.12), in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Tempo der Simulation, \(Int(trip.simulationFactor))-fach. Tippen zum Wechseln.")
            }

            Spacer(minLength: 0)
            statusValue(trip.arrivalTimeText, "Ankunft", compact: compact)
            statusValue("\(Int(trip.remainingKm.rounded())) km", "bis Ziel", compact: compact)
            // Antippen stellt den Ladestand ein, etwa nach einem Stopp, den
            // die Erkennung nicht bemerkt hat.
            Button { trip.isAdjustingCharge = true } label: {
                statusValue("\(Int(trip.chargeNowPercent.rounded())) %", "Akku jetzt", compact: compact)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Tippen, um den Ladestand einzustellen")
            Spacer(minLength: 0)

            barButton(
                systemImage: trip.voiceEnabled ? "speaker.wave.2.fill" : "speaker.slash.fill",
                label: nil,
                accessibility: trip.voiceEnabled ? "Ansagen an. Tippen zum Stummschalten." : "Ansagen aus. Tippen zum Einschalten."
            ) { trip.voiceEnabled.toggle() }

            barButton(
                systemImage: trip.cameraNorthUp ? "location.north.line.fill" : "location.north.line",
                label: nil,
                accessibility: trip.cameraNorthUp ? "Karte: Norden oben. Tippen für Fahrtrichtung." : "Karte: Fahrtrichtung oben. Tippen für Norden oben."
            ) {
                // Aus der Übersicht führt der Kameraknopf zurück zur Fahrt.
                if trip.drivingOverview { trip.drivingOverview = false } else { trip.cameraNorthUp.toggle() }
            }
        }
        .padding(.horizontal, 10)
        .background(Theme.paper.opacity(0.97), in: RoundedRectangle(cornerRadius: 18))
        .shadow(color: .black.opacity(0.14), radius: 10, y: 2)
    }

    private func barButton(systemImage: String, label: String?, accessibility: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 15, weight: .bold))
                if let label {
                    Text(label)
                        .font(.system(size: 13, weight: .semibold))
                }
            }
            .foregroundStyle(Theme.ink)
            .frame(minWidth: 40, minHeight: 40)
            .padding(.horizontal, label == nil ? 0 : 10)
            .background(Theme.panel, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibility)
    }

    private func statusValue(_ value: String, _ label: String, compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(.system(size: compact ? 18 : 22, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(Theme.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label)
                .font(.system(size: 9, weight: .medium))
                .textCase(.uppercase)
                .foregroundStyle(Theme.meta)
                .lineLimit(1)
        }
    }
}

// MARK: - Ladestopp

/// Eine angetippte Kachel: was die Station hat, und "Über diese Station".
struct StationActionCard: View {
    let item: AnnotatedStation
    let isVia: Bool
    let onToggleVia: () -> Void
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.station.name)
                        .font(.system(size: 15, weight: .semibold))
                        .lineLimit(2)
                    Text(details)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.meta)
                        .lineLimit(2)
                }
                Spacer(minLength: 4)
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Theme.meta)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Schließen")
            }
            Button(action: onToggleVia) {
                Label(isVia ? "Zwischenziel aufheben" : "Über diese Station",
                      systemImage: isVia ? "xmark.circle" : "arrow.triangle.turn.up.right.diamond.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(isVia ? Theme.meta : Theme.river, in: RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)
        }
        .foregroundStyle(Theme.ink)
        .padding(12)
        .background(Theme.paper.opacity(0.97), in: RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
    }

    private var details: String {
        var parts: [String] = []
        if let kw = item.station.maxPowerKW { parts.append("\(Int(kw)) kW") }
        if let availability = item.availability, availability.known > 0 {
            parts.append("\(availability.available)/\(availability.total) frei")
        }
        if let detour = item.station.detourSeconds { parts.append("Umweg \(Int((detour / 60).rounded())) min") }
        let street = item.station.address.split(separator: ",").first.map(String.init) ?? ""
        if !street.isEmpty { parts.append(street) }
        return parts.joined(separator: " · ")
    }
}

/// Die Simulation hält an einem Stopp.
struct SimulatedStopCard: View {
    let stop: TripViewModel.SimulatedStop
    let chargeNow: Double
    let onContinue: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Ladestopp, Simulation", systemImage: "bolt.car.fill")
                .font(.system(size: 11, weight: .bold))
                .textCase(.uppercase)
                .foregroundStyle(Theme.river)
            Text(stop.name)
                .font(.system(size: 15, weight: .semibold))
                .lineLimit(2)
            Text("Ankunft mit \(Int(chargeNow.rounded())) %, \(Int(stop.chargingMinutes.rounded())) min laden")
                .font(.system(size: 13))
                .foregroundStyle(Theme.meta)
            Button(action: onContinue) {
                Text("Laden und weiter")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(Theme.river, in: RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)
        }
        .foregroundStyle(Theme.ink)
        .padding(12)
        .background(Theme.paper.opacity(0.97), in: RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
    }
}

/// Nach einem Ladestopp: was gesetzt wurde, mit "Ändern".
struct ChargeNoticeCard: View {
    let notice: TripViewModel.ChargeNotice
    let onAdjust: () -> Void
    let onClose: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "battery.100.bolt")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Theme.free)
            VStack(alignment: .leading, spacing: 3) {
                Text("Akku auf \(Int(notice.percent.rounded())) % geschätzt")
                    .font(.system(size: 14, weight: .semibold))
                Text("\(Int(notice.minutes.rounded())) min bei \(notice.stationName)")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.meta)
                    .lineLimit(1)
                Button("Ändern", action: onAdjust)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.river)
            }
            Spacer(minLength: 0)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Theme.meta)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Hinweis schließen")
        }
        .foregroundStyle(Theme.ink)
        .padding(12)
        .background(Theme.paper.opacity(0.97), in: RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
    }
}

/// Ladestand von Hand einstellen.
struct ChargeAdjustSheet: View {
    let initial: Double
    let onApply: (Double) -> Void
    @State private var percent: Double = 0
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 16) {
            Text("Akku jetzt")
                .font(.system(size: 13, weight: .semibold))
                .textCase(.uppercase)
                .foregroundStyle(Theme.meta)
            Text("\(Int(percent)) %")
                .font(.system(size: 44, weight: .bold, design: .rounded).monospacedDigit())
            Slider(value: $percent, in: 0 ... 100, step: 1)
                .tint(Theme.river)
            Button {
                onApply(percent)
                dismiss()
            } label: {
                Text("Übernehmen")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(Theme.ink, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
        }
        .padding(20)
        .onAppear { percent = initial.rounded() }
    }
}

// MARK: - Anweisung

/// Die nächste Anweisung: Pfeil, Strecke bis dahin, der Satz der API und,
/// wenn gleich danach die nächste kommt, ein kleines "Dann".
struct ManeuverBanner: View {
    let maneuver: TripViewModel.Maneuver
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: maneuver.instruction.symbolName)
                    .font(.system(size: compact ? 30 : 36, weight: .bold))
                    .frame(width: compact ? 40 : 48)
                Text(Guidance.shortDistance(maneuver.distanceMeters))
                    .font(.system(size: compact ? 30 : 36, weight: .bold, design: .rounded).monospacedDigit())
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            Text(maneuver.instruction.text)
                .font(.system(size: compact ? 14 : 16, weight: .semibold))
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            if let then = maneuver.then {
                HStack(spacing: 6) {
                    Text("Dann")
                        .font(.system(size: 11, weight: .bold))
                        .textCase(.uppercase)
                    Image(systemName: then.symbolName)
                        .font(.system(size: 14, weight: .bold))
                }
                .foregroundStyle(Color(hex: 0xCFC7BC))
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.ink, in: RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.18), radius: 10, y: 3)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Ausweichen

/// Eine schmale Zeile für eine Station, die kein Favorit ist.
///
/// Bewusst kleiner und blasser als die Kacheln, aber ablesbar: Sie erscheint
/// nur, wenn der nächste Favorit hinter der Reserve liegt.
struct FallbackRow: View {
    let tile: DrivingTile
    let reason: FallbackReason?
    let compact: Bool

    private var headline: String {
        switch reason {
        case .lowerPower: return "Ausweichen, weniger Leistung"
        case .otherProviderLowerPower: return "Ausweichen, anderer Anbieter, weniger Leistung"
        case .otherProvider, .none: return "Ausweichen, anderer Anbieter"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                Image(systemName: "arrow.uturn.right")
                    .font(.system(size: 10, weight: .bold))
                Text(headline)
                    .font(.system(size: 10, weight: .bold))
                    .textCase(.uppercase)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .foregroundStyle(Theme.busy)

            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(kmText)
                    .font(.system(size: compact ? 17 : 20, weight: .bold, design: .rounded).monospacedDigit())
                Text(tile.station.station.name)
                    .font(.system(size: compact ? 12 : 13, weight: .semibold))
                    .lineLimit(1)
                Spacer(minLength: 2)
                Text("\(max(0, Int(tile.arrivalPercent.rounded()))) %")
                    .font(.system(size: compact ? 13 : 15, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(tile.arrivalPercent < 20 ? Theme.busy : Theme.ink2)
            }
            .foregroundStyle(Theme.ink2)

            if let kw = tile.station.station.maxPowerKW {
                Text("\(Int(kw)) kW")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.meta)
            }
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.panel.opacity(0.96), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.busy.opacity(0.5), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private var kmText: String {
        let km = max(0, tile.meters / 1000)
        return (km < 10 ? String(format: "%.1f", km).replacingOccurrences(of: ".", with: ",") : "\(Int(km.rounded()))") + " km"
    }
}

// MARK: - Eine Kachel

struct DrivingTileView: View {
    let tile: DrivingTile
    /// Die Nummer, die auch die Nadel auf der Karte trägt.
    let order: Int
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 3 : 4) {
            if tile.isPlannedStop {
                Text("Geplanter Ladestopp")
                    .font(.system(size: 10, weight: .bold))
                    .textCase(.uppercase)
                    .foregroundStyle(tile.isPlannedStop ? Color(hex: 0xFFB4A3) : Theme.signal)
            }

            if compact {
                distance
                arrival
            } else {
                HStack(alignment: .firstTextBaseline) {
                    distance
                    Spacer(minLength: 4)
                    arrival
                }
            }

            Text(title)
                .font(.system(size: compact ? 13 : 15, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.tail)

            HStack(spacing: 5) {
                chip(powerText, background: chipBackground, foreground: primary)
                if let detour = tile.station.station.detourSeconds, detour >= 120 {
                    chip("+\(Int((detour / 60).rounded())) min", background: Theme.river.opacity(tile.isPlannedStop ? 0.35 : 0.12),
                         foreground: tile.isPlannedStop ? Color(hex: 0xBFDDEC) : Theme.river)
                }
                if !compact, let availability = tile.station.availability, availability.known > 0 {
                    chip("\(availability.available)/\(availability.total) frei",
                         background: Theme.free.opacity(tile.isPlannedStop ? 0.3 : 0.12),
                         foreground: tile.isPlannedStop ? Color(hex: 0xBDE6CD) : Theme.free)
                }
                if !compact, tile.moreHere > 0 {
                    Text("+\(tile.moreHere) weitere")
                        .font(.system(size: 11))
                        .foregroundStyle(secondary)
                }
            }
        }
        .foregroundStyle(primary)
        .padding(.horizontal, compact ? 10 : 13)
        .padding(.vertical, compact ? 9 : 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tile.isPlannedStop ? Theme.ink : Color.white, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(tile.isPlannedStop ? Theme.ink : Theme.rule, lineWidth: 1))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
        .opacity(tile.isReachable ? 1 : 0.55)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Tippen, um die Belegung zu laden")
    }

    private var distance: some View {
        HStack(alignment: .firstTextBaseline, spacing: 2) {
            Text("\(order)")
                .font(.system(size: compact ? 10 : 11, weight: .bold))
                .foregroundStyle(tile.isPlannedStop ? Theme.ink : .white)
                .frame(width: compact ? 16 : 18, height: compact ? 16 : 18)
                .background(tile.isPlannedStop ? Color.white : Theme.river, in: Circle())
                .alignmentGuide(.firstTextBaseline) { d in d[.bottom] - 3 }
                .padding(.trailing, 5)
            Text(kmText)
                .font(.system(size: compact ? 30 : 38, weight: .bold, design: .rounded).monospacedDigit())
            Text("km")
                .font(.system(size: compact ? 13 : 15, weight: .semibold))
                .foregroundStyle(secondary)
        }
    }

    private var arrival: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text("\(max(0, Int(tile.arrivalPercent.rounded()))) %")
                .font(.system(size: compact ? 17 : 21, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(arrivalColor)
            Text("bei Ankunft")
                .font(.system(size: 9, weight: .medium))
                .textCase(.uppercase)
                .foregroundStyle(secondary)
        }
    }

    private var kmText: String {
        let km = max(0, tile.meters / 1000)
        return km < 10 ? String(format: "%.1f", km).replacingOccurrences(of: ".", with: ",") : "\(Int(km.rounded()))"
    }

    private var title: String {
        let station = tile.station.station
        // Registerstandorte: Betreiber und Straße, sonst steht dreimal "EnBW".
        let place = station.address.split(separator: ",").first.map(String.init) ?? ""
        return place.isEmpty ? station.name : "\(station.name) · \(place)"
    }

    private var powerText: String {
        guard let kw = tile.station.station.maxPowerKW else { return "kW ?" }
        return "\(Int(kw)) kW"
    }

    private var arrivalColor: Color {
        if !tile.isReachable || tile.arrivalPercent < 10 { return tile.isPlannedStop ? Color(hex: 0xFFB4A3) : Theme.signal }
        if tile.arrivalPercent < 20 { return Theme.busy }
        return tile.isPlannedStop ? Color(hex: 0xBDE6CD) : Theme.free
    }

    private var primary: Color { tile.isPlannedStop ? .white : Theme.ink }
    private var secondary: Color { tile.isPlannedStop ? Color(hex: 0xCFC7BC) : Theme.meta }
    private var chipBackground: Color { tile.isPlannedStop ? .white.opacity(0.12) : Theme.panel }

    private func chip(_ text: String, background: Color, foreground: Color) -> some View {
        Text(text)
            .font(.system(size: compact ? 11 : 12, weight: .semibold))
            .foregroundStyle(foreground)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(background, in: RoundedRectangle(cornerRadius: 6))
    }
}
