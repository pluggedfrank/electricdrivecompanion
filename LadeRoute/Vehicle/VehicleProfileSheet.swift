//  VehicleProfileSheet.swift
//  Das Fahrzeugprofil bearbeiten.

import SwiftUI

struct VehicleProfileSheet: View {
    // MARK: Internal

    @ObservedObject var store: VehicleProfileStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $store.profile.name)
                    zeile("Akku nutzbar", wert: $store.profile.usableBatteryKWh, einheit: "kWh", bereich: 10 ... 150, schritt: 1)
                    zeile("Verbrauch", wert: $store.profile.consumptionKWhPer100km, einheit: "kWh/100 km", bereich: 10 ... 40, schritt: 0.5)
                    zeile("Ladeleistung", wert: $store.profile.maxChargePowerKW, einheit: "kW", bereich: 50 ... 400, schritt: 10)
                } header: {
                    Text("Fahrzeug")
                } footer: {
                    Text("Reichweite bei vollem Akku bis zur Reserve: \(Int(store.profile.fullRangeKm)) km.")
                }

                Section {
                    prozent("Ladestand jetzt", wert: $store.profile.currentChargePercent)
                    prozent("Reserve am Ziel", wert: $store.profile.minArrivalPercent)
                    prozent("Tiefster Stand unterwegs", wert: $store.profile.minChargeAtStopPercent)
                    prozent("Laden bis", wert: $store.profile.maxChargeAtStopPercent)
                } header: {
                    Text("Ladestand")
                } footer: {
                    Text(
                        "Mit \(Int(store.profile.currentChargePercent)) Prozent reicht es noch "
                            + "\(Int(store.profile.remainingRangeKm)) km. Über 80 Prozent lädt jede "
                            + "Säule langsam; weiterzufahren ist dann meist schneller als vollzuladen."
                    )
                }

                Section {
                    Button("Auf die Vorgabe zurücksetzen") { store.zurücksetzen() }
                        .foregroundStyle(Theme.signal)
                }
            }
            .navigationTitle("Fahrzeug")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Fertig") { dismiss() }
                }
            }
        }
    }

    // MARK: Private

    private func zeile(
        _ titel: String,
        wert: Binding<Double>,
        einheit: String,
        bereich: ClosedRange<Double>,
        schritt: Double
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(titel)
                Spacer()
                Text(zahl(wert.wrappedValue) + " " + einheit)
                    .font(.system(size: 15).monospacedDigit())
                    .foregroundStyle(Theme.meta)
            }
            Stepper("", value: wert, in: bereich, step: schritt)
                .labelsHidden()
        }
    }

    private func prozent(_ titel: String, wert: Binding<Double>) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(titel)
                Spacer()
                Text("\(Int(wert.wrappedValue)) %")
                    .font(.system(size: 15).monospacedDigit())
                    .foregroundStyle(Theme.meta)
            }
            Slider(value: wert, in: 0 ... 100, step: 5)
        }
    }

    private func zahl(_ wert: Double) -> String {
        wert == wert.rounded()
            ? String(Int(wert))
            : String(format: "%.1f", wert)
    }
}
