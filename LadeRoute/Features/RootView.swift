//  RootView.swift
//  Karte im Hintergrund, Ergebnisse in einem Sheet darüber.

import Foundation
import SwiftUI

struct RootView: View {
    @StateObject private var trip: TripViewModel
    @State private var sheetDetent: PresentationDetent = .fraction(0.35)
    @State private var showsResults = false
    @FocusState private var searchFieldFocused: Bool
    @State private var showsVehicleSheet = false

    init(apiKey: String) {
        _trip = StateObject(wrappedValue: TripViewModel(apiKey: apiKey))
    }

    var body: some View {
        ZStack(alignment: .top) {
            TomTomMapView(trip: trip)
                .ignoresSafeArea()

            mapControls

            VStack(spacing: 10) {
                header
                searchField
                if !trip.placeResults.isEmpty {
                    placeResultList
                }
                if case let .failed(message) = trip.phase {
                    errorBanner(message)
                }
                if trip.placeResults.isEmpty {
                    statusPill
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
        }
        .sheet(isPresented: $showsVehicleSheet) {
            VehicleProfileSheet(store: trip.vehicleStore)
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

    // MARK: Kartenbedienung

    /// Zoom und Ausschnitt, rechts am Rand.
    ///
    /// Ohne diese Knöpfe bleibt nur die Zwei-Finger-Geste. Auf dem Gerät geht
    /// die, im Simulator muss man dafür die Wahltaste kennen, und beim Fahren
    /// will niemand zwei Finger benutzen.
    private var mapControls: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 1) {
                controlButton(icon: "plus", label: "Hineinzoomen") {
                    trip.mapCommands.send(.zoomIn)
                }
                Divider().frame(width: 30)
                controlButton(icon: "minus", label: "Herauszoomen") {
                    trip.mapCommands.send(.zoomOut)
                }
                if trip.route != nil {
                    Divider().frame(width: 30)
                    controlButton(icon: "arrow.up.left.and.arrow.down.right", label: "Ganze Route zeigen") {
                        trip.mapCommands.send(.fitRoute)
                    }
                }
                if trip.currentLocation != nil {
                    Divider().frame(width: 30)
                    controlButton(icon: "location", label: "Zum eigenen Standort") {
                        trip.mapCommands.send(.centerOnUser)
                    }
                }
            }
            .background(Theme.paper.opacity(0.96), in: RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.12), radius: 8, y: 2)

            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.trailing, 14)
        // Über dem Blatt bleiben, sonst liegen die Knöpfe darunter.
        .padding(.bottom, trip.mapBottomInset)
    }

    private func controlButton(
        icon: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.ink2)
                .frame(width: 42, height: 40)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    // MARK: Zielsuche

    private var searchField: some View {
        HStack(spacing: 9) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.meta)

            TextField("Ziel suchen", text: $trip.destinationQuery)
                .font(.system(size: 15))
                .foregroundStyle(Theme.ink)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($searchFieldFocused)

            if trip.isSearchingPlaces {
                ProgressView().scaleEffect(0.7).frame(width: 14, height: 14)
            } else if !trip.destinationQuery.isEmpty {
                Button {
                    trip.clearPlaceSearch()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.faint)
                }
                .accessibilityLabel("Suche leeren")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(Theme.paper.opacity(0.96), in: Capsule())
        .shadow(color: .black.opacity(0.10), radius: 10, y: 3)
    }

    private var placeResultList: some View {
        VStack(spacing: 0) {
            ForEach(trip.placeResults) { place in
                Button {
                    searchFieldFocused = false
                    trip.choosePlace(place)
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "mappin.circle")
                            .font(.system(size: 16))
                            .foregroundStyle(Theme.river)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(place.title)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(Theme.ink)
                                .lineLimit(1)
                            if let subtitle = place.subtitle {
                                Text(subtitle)
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.meta)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 0)
                        if let meters = place.distanceMeters {
                            Text(entfernung(meters))
                                .font(.system(size: 12).monospacedDigit())
                                .foregroundStyle(Theme.faint)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if place.id != trip.placeResults.last?.id {
                    Divider().padding(.leading, 40)
                }
            }
        }
        .background(Theme.paper, in: RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.10), radius: 12, y: 4)
    }

    private func entfernung(_ meters: Double) -> String {
        meters < 1000
            ? "\(Int(meters.rounded())) m"
            : String(format: "%.0f km", meters / 1000)
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
            if let ziel = trip.chosenPlaceName {
                Text(ziel)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.meta)
                    .lineLimit(1)
            } else {
                Text("Prototyp")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.meta)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Theme.panel, in: Capsule())
            }

            Spacer()

            Button {
                showsVehicleSheet = true
            } label: {
                Image(systemName: "car")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.ink2)
                    .frame(width: 30, height: 30)
                    .background(Theme.paper, in: Circle())
            }
            .accessibilityLabel("Fahrzeug")

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
            pill(icon: "magnifyingglass", text: "Ziel suchen oder lange auf die Karte drücken")
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
