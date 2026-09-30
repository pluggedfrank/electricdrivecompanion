//  SavedPlacesViews.swift
//  Die Oberfläche der gespeicherten Ziele: Knöpfe unter dem Suchfeld, der
//  Stern in der Kopfzeile, das Blatt zum Speichern und die Liste.

import SwiftUI

/// Unter dem Suchfeld: Zuhause, Arbeit, und die ganze Liste.
struct SavedPlacesBar: View {
    @ObservedObject var store: SavedPlacesStore
    let onChoose: (SavedPlace) -> Void
    let onShowAll: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            chip(for: .home)
            chip(for: .work)
            Button(action: onShowAll) {
                Label(store.recents.isEmpty ? "Gespeichert" : "Ziele", systemImage: "list.star")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                    .padding(.horizontal, 12)
                    .frame(height: 34)
                    .background(Theme.paper.opacity(0.96), in: Capsule())
                    .shadow(color: .black.opacity(0.10), radius: 8, y: 2)
            }
            .buttonStyle(.plain)
            Spacer(minLength: 0)
        }
    }

    private func chip(for category: PlaceCategory) -> some View {
        let place = store.place(for: category)
        return Button {
            if let place { onChoose(place) } else { onShowAll() }
        } label: {
            Label(category.title, systemImage: category.symbolName)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(place == nil ? Theme.faint : Theme.ink)
                .padding(.horizontal, 12)
                .frame(height: 34)
                .background(Theme.paper.opacity(0.96), in: Capsule())
                .shadow(color: .black.opacity(0.10), radius: 8, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityHint(place == nil ? "Noch nicht festgelegt" : "Route dorthin")
    }
}

/// Der Stern in der Kopfzeile: voll, wenn das Ziel gespeichert ist.
struct SaveStarButton: View {
    @ObservedObject var store: SavedPlacesStore
    @ObservedObject var trip: TripViewModel
    let onTap: () -> Void

    var body: some View {
        let saved = trip.destination.flatMap { store.saved(at: $0) }
        Button(action: onTap) {
            Image(systemName: saved == nil ? "star" : "star.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(saved == nil ? Theme.ink2 : Theme.busy)
                .frame(width: 30, height: 30)
                .background(Theme.paper, in: Circle())
        }
        .accessibilityLabel(saved == nil ? "Ziel speichern" : "Gespeichertes Ziel bearbeiten")
    }
}

/// Gespeicherte Ziele, die zum Suchtext passen, über den Treffern der Suche.
struct SavedMatchesList: View {
    @ObservedObject var store: SavedPlacesStore
    let query: String
    let onChoose: (SavedPlace) -> Void

    var body: some View {
        let matches = store.matching(query)
        if !matches.isEmpty {
            VStack(spacing: 0) {
                ForEach(matches) { place in
                    Button { onChoose(place) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: place.category.symbolName)
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.busy)
                                .frame(width: 20)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(place.name)
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(Theme.ink)
                                    .lineLimit(1)
                                if let address = place.address {
                                    Text(address)
                                        .font(.system(size: 12))
                                        .foregroundStyle(Theme.meta)
                                        .lineLimit(1)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if place.id != matches.last?.id { Divider().padding(.leading, 44) }
                }
            }
            .background(Theme.paper, in: RoundedRectangle(cornerRadius: 14))
            .shadow(color: .black.opacity(0.10), radius: 12, y: 4)
        }
    }
}

/// Speichern oder bearbeiten: Name und Kategorie.
struct SavePlaceSheet: View {
    @ObservedObject var store: SavedPlacesStore
    let initial: SavedPlace
    let isExisting: Bool
    @State private var name = ""
    @State private var category: PlaceCategory = .other
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") {
                    TextField("Name", text: $name)
                }
                Section("Kategorie") {
                    Picker("Kategorie", selection: $category) {
                        ForEach(PlaceCategory.allCases) { c in
                            Label(c.title, systemImage: c.symbolName).tag(c)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    if category.isSingle, let current = store.place(for: category), current.id != initial.id {
                        Text("Ersetzt \(current.name).")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.meta)
                    }
                }
                if let address = initial.address {
                    Section("Adresse") {
                        Text(address).foregroundStyle(Theme.meta)
                    }
                }
                if isExisting {
                    Section {
                        Button("Nicht mehr speichern", role: .destructive) {
                            store.remove(initial)
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle(isExisting ? "Ziel bearbeiten" : "Ziel speichern")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Abbrechen") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Sichern") {
                        var place = initial
                        let trimmed = name.trimmingCharacters(in: .whitespaces)
                        place.name = trimmed.isEmpty ? category.title : trimmed
                        place.category = category
                        store.save(place)
                        dismiss()
                    }
                }
            }
        }
        .onAppear {
            name = initial.name
            category = initial.category
        }
    }
}

/// Alle gespeicherten Ziele, nach Kategorien.
struct SavedPlacesSheet: View {
    @ObservedObject var store: SavedPlacesStore
    let onChoose: (SavedPlace) -> Void
    @State private var editing: SavedPlace?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if !store.recents.isEmpty {
                    Section {
                        ForEach(store.recents) { place in
                            Button {
                                onChoose(place)
                                dismiss()
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "clock.arrow.circlepath")
                                        .foregroundStyle(Theme.meta)
                                        .frame(width: 22)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(place.name).foregroundStyle(Theme.ink)
                                        if let address = place.address {
                                            Text(address)
                                                .font(.system(size: 12))
                                                .foregroundStyle(Theme.meta)
                                                .lineLimit(1)
                                        }
                                    }
                                }
                            }
                            .swipeActions {
                                Button("Speichern") { editing = SavedPlace(
                                    name: place.name, address: place.address,
                                    latitude: place.latitude, longitude: place.longitude, category: .other
                                ) }
                                .tint(Theme.busy)
                            }
                        }
                    } header: {
                        HStack {
                            Text("Zuletzt")
                            Spacer()
                            Button("Leeren") { store.clearRecents() }
                                .font(.system(size: 12))
                                .textCase(nil)
                        }
                    }
                }
                if store.places.isEmpty {
                    Section {
                        Text("Noch nichts gespeichert. Ein Ziel suchen, dann oben auf den Stern tippen. Zuhause und Arbeit lassen sich dort als Kategorie wählen.")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.meta)
                    }
                }
                ForEach(PlaceCategory.allCases) { category in
                    let places = store.places(in: category)
                    if !places.isEmpty {
                        Section(category.title) {
                            ForEach(places) { place in
                                Button {
                                    onChoose(place)
                                    dismiss()
                                } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: category.symbolName)
                                            .foregroundStyle(Theme.river)
                                            .frame(width: 22)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(place.name).foregroundStyle(Theme.ink)
                                            if let address = place.address {
                                                Text(address)
                                                    .font(.system(size: 12))
                                                    .foregroundStyle(Theme.meta)
                                                    .lineLimit(1)
                                            }
                                        }
                                    }
                                }
                                .swipeActions {
                                    Button("Löschen", role: .destructive) { store.remove(place) }
                                    Button("Bearbeiten") { editing = place }
                                        .tint(Theme.river)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Ziele")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
            .sheet(item: $editing) { place in
                SavePlaceSheet(store: store, initial: place, isExisting: store.places.contains { $0.id == place.id })
            }
        }
    }
}
