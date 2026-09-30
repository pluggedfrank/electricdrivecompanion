//  AppModel.swift
//  Das eine Fahrtmodell der App, für das iPhone und für CarPlay.
//
//  Vorher legte RootView sein eigenes an. Mit CarPlay gibt es zwei
//  Oberflächen für dieselbe Fahrt: Route, Kacheln, Ansagen und Position
//  müssen auf beiden dieselben sein, und eine Fahrt, die am iPhone beginnt,
//  läuft im Auto weiter. Deshalb hier einmal, und beide Szenen holen es sich.

import Foundation

@MainActor
final class AppModel {
    static let shared = AppModel()

    lazy var trip = TripViewModel(apiKey: Secrets.tomtomAPIKey)

    private init() {}
}
