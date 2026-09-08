//  StationDetailView.swift
//  Detailkarte einer Station: oben die TomTom-Daten, darunter das, was nur wir
//  haben. Genau diese Trennung ist der Punkt des Prototyps.

import MapKit
import SwiftUI

struct StationDetailView: View {
    let station: AnnotatedStation

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                titleBlock
                if let availability = station.availability { availabilityBlock(availability) }
                connectorBlock
                if let editorial = station.editorial {
                    editorialBlock(editorial)
                } else {
                    noEditorialHint
                }
                sourceNote
            }
            .padding(20)
        }
        .background(Theme.paper)
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: Blöcke

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(station.station.name)
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(Theme.ink)
            if !station.station.address.isEmpty {
                Text(station.station.address)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.meta)
            }
            HStack(spacing: 8) {
                if let detour = station.station.detourSeconds {
                    metric("Umweg", "\(Int((detour / 60).rounded())) min")
                }
                if let distance = station.station.distanceFromRouteMeters {
                    metric("ab Route", String(format: "%.0f m", distance))
                }
                if let power = station.station.maxPowerKW {
                    metric("max.", String(format: "%.0f kW", power))
                }
            }
            .padding(.top, 6)
        }
    }

    private func availabilityBlock(_ availability: StationAvailability) -> some View {
        section("Belegung gerade eben") {
            HStack(spacing: 18) {
                counter("frei", availability.available, Theme.free)
                counter("belegt", availability.occupied, Theme.busy)
                if availability.outOfService > 0 {
                    counter("gestört", availability.outOfService, Theme.broken)
                }
            }
            Text("TomTom aktualisiert diese Werte etwa alle drei Minuten.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.faint)
        }
    }

    private var connectorBlock: some View {
        section("Anschlüsse") {
            if station.station.connectors.isEmpty {
                Text("TomTom liefert für diese Station keine Steckerdetails.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.meta)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(station.station.connectors.enumerated()), id: \.offset) { _, connector in
                        HStack {
                            Text(connector.type?.displayName ?? "Unbekannt")
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.ink2)
                            Spacer()
                            if let power = connector.ratedPowerKW {
                                Text(String(format: "%.0f kW", power))
                                    .font(.system(size: 14, weight: .medium).monospacedDigit())
                                    .foregroundStyle(Theme.ink)
                            }
                            if let current = connector.currentType {
                                Text(current)
                                    .font(.system(size: 11))
                                    .foregroundStyle(Theme.faint)
                            }
                        }
                        .padding(.vertical, 9)
                        Divider().overlay(Theme.rule)
                    }
                }
            }
        }
    }

    private func editorialBlock(_ editorial: EditorialEntry) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 7) {
                Circle().fill(Theme.signal).frame(width: 8, height: 8)
                Text("Aus unserem Test")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.signal)
                    .textCase(.uppercase)
                    .kerning(0.6)
            }

            if let rating = editorial.rating, let label = editorial.ratingLabel {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(String(format: "%.1f", rating))
                        .font(.system(size: 34, weight: .semibold).monospacedDigit())
                        .foregroundStyle(Theme.ink)
                    Text(label)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Theme.meta)
                }
            }

            Text(editorial.verdict)
                .font(.system(size: 15))
                .foregroundStyle(Theme.ink2)
                .fixedSize(horizontal: false, vertical: true)

            if !editorial.tags.isEmpty {
                FlowTags(tags: editorial.tags)
            }

            HStack(spacing: 14) {
                if let price = editorial.pricePerKWh {
                    metric("im Test", String(format: "%.2f €/kWh", price))
                }
                if let tested = editorial.testedAt {
                    metric("geprüft", tested.formatted(.dateTime.month(.abbreviated).year()))
                }
            }

            if let author = editorial.author {
                Text("Erhebung: \(author)")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.faint)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Theme.signal.opacity(0.25), lineWidth: 1)
        )
    }

    private var noEditorialHint: some View {
        Text("Für diese Station liegt uns noch kein eigener Test vor.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.meta)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.panel, in: RoundedRectangle(cornerRadius: 12))
    }

    private var sourceNote: some View {
        Text("Standort, Anschlüsse und Belegung: TomTom. Bewertung und Urteil: eigene Erhebung.")
            .font(.system(size: 11))
            .foregroundStyle(Theme.faint)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: Bausteine

    private func section<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.meta)
                .textCase(.uppercase)
                .kerning(0.6)
            content()
        }
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(Theme.faint)
            Text(value)
                .font(.system(size: 14, weight: .semibold).monospacedDigit())
                .foregroundStyle(Theme.ink)
        }
    }

    private func counter(_ label: String, _ value: Int, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("\(value)")
                .font(.system(size: 26, weight: .semibold).monospacedDigit())
                .foregroundStyle(color)
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Theme.meta)
        }
    }
}

// MARK: - Umbrechende Tag-Reihe

struct FlowTags: View {
    let tags: [String]

    var body: some View {
        // Ab iOS 16 erledigt das Layout den Umbruch von selbst.
        FlowLayout(spacing: 6) {
            ForEach(tags, id: \.self) { tag in
                Text(tag)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.ink2)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Theme.paper, in: Capsule())
                    .overlay(Capsule().stroke(Theme.rule, lineWidth: 1))
            }
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        let maxWidth = proposal.width ?? bounds.width
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > bounds.minX + maxWidth, x > bounds.minX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
