//  LadeRouteApp.swift
//  Einstiegspunkt. Registriert den API-Key beim Maps SDK, bevor die erste Karte
//  aufgebaut wird.

import SwiftUI
import TomTomSDKMapDisplay

@main
struct LadeRouteApp: App {
    init() {
        MapsDisplayService.apiKey = Secrets.tomtomAPIKey
    }

    var body: some Scene {
        WindowGroup {
            if Secrets.hasAPIKey {
                RootView(apiKey: Secrets.tomtomAPIKey)
            } else {
                MissingKeyView()
            }
        }
    }
}

/// Ohne Key startet die Karte gar nicht erst. Besser ein klarer Hinweis als ein
/// leerer grauer Bildschirm.
struct MissingKeyView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Circle().fill(Theme.signal).frame(width: 9, height: 9)
                Text("Kein API-Key hinterlegt")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(Theme.ink)
            }
            Text("So geht es weiter:")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.ink2)
            VStack(alignment: .leading, spacing: 7) {
                step(1, "Auf developer.tomtom.com registrieren und einen Key anlegen.")
                step(2, "ios/Secrets.xcconfig.example nach ios/Secrets.xcconfig kopieren.")
                step(3, "TOMTOM_API_KEY dort eintragen und die App neu starten.")
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .background(Theme.paper)
    }

    private func step(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Text("\(number)")
                .font(.system(size: 12, weight: .semibold).monospacedDigit())
                .foregroundStyle(.white)
                .frame(width: 19, height: 19)
                .background(Theme.signal, in: Circle())
            Text(text)
                .font(.system(size: 14))
                .foregroundStyle(Theme.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
