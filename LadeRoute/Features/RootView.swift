//  RootView.swift
//  Karte im Hintergrund, Ergebnisse in einem Sheet darüber.

import SwiftUI

struct RootView: View {
    @StateObject private var trip: TripViewModel
    @State private var sheetDetent: PresentationDetent = .fraction(0.35)
    @State private var showsResults = false

    init(apiKey: String) {
        _trip = StateObject(wrappedValue: TripViewModel(apiKey: apiKey))
    }

    var body: some View {
        ZStack(alignment: .top) {
            TomTomMapView(trip: trip)
                .ignoresSafeArea()

            VStack(spacing: 10) {
                header
                if case let .failed(message) = trip.phase {
                    errorBanner(message)
                }
                statusPill
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
        }
        .task {
            // Hier und nicht im Initialisierer: Der Freigabedialog gehört auf
            // eine sichtbare Oberfläche, nicht vor das erste Bild.
            trip.startLocating()
        }
        .onChange(of: trip.stations.count) { _, count in
            showsResults = count > 0
        }
        .sheet(isPresented: $showsResults) {
            StationListSheet(trip: trip)
                .presentationDetents([.fraction(0.35), .medium, .large], selection: $sheetDetent)
                .presentationBackgroundInteraction(.enabled(upThrough: .medium))
                .presentationDragIndicator(.visible)
                .interactiveDismissDisabled()
        }
    }

    // MARK: Kopfzeile

    private var header: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(Theme.signal)
                .frame(width: 9, height: 9)
            Text("LadeRoute")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.ink)
            Text("Prototyp")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.meta)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Theme.panel, in: Capsule())

            Spacer()

            if trip.route != nil {
                Button {
                    trip.clearTrip()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.ink2)
                        .frame(width: 30, height: 30)
                        .background(Theme.paper, in: Circle())
                }
                .accessibilityLabel("Route verwerfen")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(Theme.paper.opacity(0.96), in: Capsule())
        .shadow(color: .black.opacity(0.10), radius: 10, y: 3)
    }

    @ViewBuilder
    private var statusPill: some View {
        switch trip.phase {
        case .idle:
            pill(icon: "hand.tap", text: "Ziel lange auf die Karte drücken")
        case .planningRoute:
            pill(icon: "point.topleft.down.curvedto.point.bottomright.up", text: "Route wird geplant …", busy: true)
        case .searchingStations:
            pill(icon: "bolt.car", text: "Ladestationen entlang der Strecke …", busy: true)
        case .ready, .failed:
            EmptyView()
        }
    }

    private func pill(icon: String, text: String, busy: Bool = false) -> some View {
        HStack(spacing: 8) {
            if busy {
                ProgressView().scaleEffect(0.7).frame(width: 14, height: 14)
            } else {
                Image(systemName: icon).font(.system(size: 12, weight: .medium))
            }
            Text(text).font(.system(size: 13, weight: .medium))
        }
        .foregroundStyle(Theme.ink2)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(Theme.paper.opacity(0.96), in: Capsule())
        .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.signal)
            Text(message)
                .font(.system(size: 13))
                .foregroundStyle(Theme.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.paper, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Theme.signal.opacity(0.35), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
    }
}
