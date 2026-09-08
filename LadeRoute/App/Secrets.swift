//  Secrets.swift
//  Der API-Key kommt aus der Info.plist, die ihn wiederum aus Secrets.xcconfig
//  zieht. So liegt der Schlüssel nie im Git-Repository.
//
//  Einrichtung: ios/Secrets.xcconfig.example nach ios/Secrets.xcconfig kopieren
//  und den eigenen Key eintragen.

import Foundation

enum Secrets {
    static var tomtomAPIKey: String {
        guard
            let value = Bundle.main.object(forInfoDictionaryKey: "TomTomAPIKey") as? String,
            !value.isEmpty,
            value != "$(TOMTOM_API_KEY)",
            value != "YOUR_API_KEY"
        else {
            return ""
        }
        return value
    }

    static var hasAPIKey: Bool { !tomtomAPIKey.isEmpty }
}
