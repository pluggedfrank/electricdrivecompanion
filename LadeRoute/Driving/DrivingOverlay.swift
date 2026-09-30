//  DrivingOverlay.swift
//  Die Fahransicht: rechts drei Kacheln mit den nächsten Ladern, unten links
//  Ankunft, Reststrecke und Akku, oben links der Knopf zum Beenden.
//
//  Konzept: https://claude.ai/artifact/Cw4CHJhntL2dVZHtTfZixe
//  Regeln daraus, die hier umgesetzt sind: höchstens drei Kacheln, kein
//  Scrollen, die große Zahl ist die Strecke auf der Route, daneben der Akku
//  bei Ankunft, der geplante Stopp dunkel, eine Linie, wo die Reserve endet.
//
//  Die nächste Station steht unten, die fernste oben, wie die Straße vor
//  einem: Was als Nächstes kommt, ist am Auto. Wunsch vom 30.09. nach der
//  ersten Simulation; das Konzept hatte es andersherum.

import SwiftUI

struct DrivingOverlay: View {
    @ObservedObject var trip: TripViewModel

    var body: some View {
        GeometryReader { geometry in
            let landscape = geometry.size.width > geometry.size.height
            let railWidth = landscape ? geometry.size.width * 0.30 : geometry.size.width * 0.40

            ZStack(alignment: .topLeading) {
                Color.clear

                rail(compact: !landscape)
                    .frame(width: railWidth)
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .padding(.vertical, landscape ? 10 : 70)
                    .padding(.trailing, 10)
                    .frame(maxWidth: .infinity, alignment: .trailing)

                stopButton
                    .padding(.leading, 14)
                    .padding(.top, 8)

                statusBar(compact: !landscape)
                    .padding(.leading, 14)
                    .padding(.bottom, 12)
                    .frame(maxHeight: .infinity, alignment: .bottomLeading)
            }
            .onAppear { trip.mapTrailingInset = railWidth + 20 }
            .onChange(of: railWidth) { _, width in trip.mapTrailingInset = width + 20 }
        }
    }

    // MARK: Kacheln

    @ViewBuilder
    private func rail(compact: Bool) -> some View {
        VStack(spacing: compact ? 8 : 10) {
            if trip.drivingTiles.isEmpty {
                Text(trip.driveFix == nil ? "Suche die eigene Position auf der Route …" : "Keine passenden Lader mehr bis zum Ziel.")
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
                    // Antippen holt die Belegung. Über die Station routen
                    // kommt mit der Zielführung; bis dahin gäbe es nichts,
                    // wohin eine neue Route führen könnte.
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
            if let offRoute = trip.driveFix, !offRoute.isOnRoute {
                Text("Nicht auf der Route, \(Int(offRoute.offsetMeters)) m daneben")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.signal)
            }
        }
        .animation(.easeOut(duration: 0.35), value: trip.drivingTiles.map(\.id))
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

    // MARK: Status und Bedienung

    private var stopButton: some View {
        Button {
            trip.stopDriving()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                Text(trip.isSimulatingDrive ? "Simulation beenden" : "Fahrt beenden")
                    .font(.system(size: 13, weight: .semibold))
            }
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Theme.paper.opacity(0.96), in: Capsule())
            .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
        }
        .buttonStyle(.plain)
    }

    private func statusBar(compact: Bool) -> some View {
        HStack(spacing: compact ? 14 : 22) {
            statusValue(trip.arrivalTimeText, "Ankunft", compact: compact)
            statusValue("\(Int(trip.remainingKm.rounded())) km", "bis Ziel", compact: compact)
            statusValue("\(Int(trip.chargeNowPercent.rounded())) %", "Akku jetzt", compact: compact)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(Theme.paper.opacity(0.96), in: RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
    }

    private func statusValue(_ value: String, _ label: String, compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(.system(size: compact ? 19 : 23, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(Theme.ink)
            Text(label)
                .font(.system(size: 10, weight: .medium))
                .textCase(.uppercase)
                .foregroundStyle(Theme.meta)
        }
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
