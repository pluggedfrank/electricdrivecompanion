//  UserLocationSource.swift
//  Standort über CoreLocation, unabhängig vom Kartenanbieter.
//
//  Warum eigenständig und nicht über den LocationProvider der Karte: Die Karte
//  braucht eine Position, um den Pfeil zu zeichnen. Die App braucht sie, um
//  eine Route zu planen, und das ist etwas anderes. Vor allem aber fragt der
//  Anbieter der Karte die Freigabe nicht selbst an; ohne Anfrage erscheint kein
//  Dialog, ohne Dialog kommt keine Position, und die App meldet nur, es liege
//  keine vor. Genau das ist beim ersten Simulatorlauf passiert.
//
//  CoreLocation ist hier die richtige Ebene: dokumentiert, stabil, und der
//  Dialog gehört ohnehin dem Betriebssystem.

import CoreLocation
import Foundation

@MainActor
final class UserLocationSource: NSObject, ObservableObject {
    // MARK: Lifecycle

    override init() {
        manager = CLLocationManager()
        authorizationStatus = manager.authorizationStatus
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    }

    // MARK: Internal

    enum Problem: Equatable {
        /// Der Nutzer hat abgelehnt oder die Ortung ist gesperrt.
        case verweigert
        /// Freigegeben, aber es liegt noch keine Position vor.
        case nochKeineOrtung

        var message: String {
            switch self {
            case .verweigert:
                return "Ohne Standortfreigabe kennt die App keinen Startpunkt. "
                    + "In den Einstellungen unter Datenschutz freigeben."
            case .nochKeineOrtung:
                return "Noch keine Position. Im Simulator unter Features, Location "
                    + "einen Ort setzen; auf dem Gerät einen Moment warten."
            }
        }
    }

    @Published private(set) var coordinate: CLLocationCoordinate2D?
    /// Die letzte Messung mit Zeit und Tempo. Während der Fahrt die Quelle
    /// der Position, auch im Hintergrund.
    @Published private(set) var lastLocation: CLLocation?
    @Published private(set) var authorizationStatus: CLAuthorizationStatus

    /// Was gerade fehlt, oder nil, wenn eine Position vorliegt.
    var problem: Problem? {
        if coordinate != nil { return nil }
        switch authorizationStatus {
        case .denied, .restricted: return .verweigert
        default: return .nochKeineOrtung
        }
    }

    /// Fragt die Freigabe an und startet die Ortung.
    ///
    /// Mehrfach aufrufbar: iOS zeigt den Dialog nur einmal, und ein zweites
    /// `startUpdatingLocation` schadet nicht.
    func start() {
        if manager.authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
        beginUpdatesIfAllowed()
    }

    /// Fahrt beginnt: genau, ohne Pause, auch im Hintergrund.
    ///
    /// Die Karte liefert im Hintergrund keine Positionen, sie zeichnet dann
    /// nicht. Dieser Manager schon, wenn er es darf: Die Hintergrundmodi
    /// stehen in der Info.plist, und gestartet wird im Vordergrund. Dann
    /// reicht die Freigabe "Beim Verwenden", und iOS zeigt oben die blaue
    /// Anzeige, solange die App im Hintergrund ortet.
    func beginDriving() {
        manager.activityType = .automotiveNavigation
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = kCLDistanceFilterNone
        manager.pausesLocationUpdatesAutomatically = false
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        beginUpdatesIfAllowed()
    }

    /// Fahrt endet: zurück auf sparsam, kein Hintergrund mehr.
    func endDriving() {
        manager.allowsBackgroundLocationUpdates = false
        manager.showsBackgroundLocationIndicator = false
        manager.pausesLocationUpdatesAutomatically = true
        manager.activityType = .other
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    }

    // MARK: Private

    private let manager: CLLocationManager

    private func beginUpdatesIfAllowed() {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            manager.startUpdatingLocation()
        default:
            break
        }
    }
}

// MARK: - CLLocationManagerDelegate

extension UserLocationSource: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.authorizationStatus = status
            self.beginUpdatesIfAllowed()
        }
    }

    nonisolated func locationManager(
        _: CLLocationManager,
        didUpdateLocations locations: [CLLocation]
    ) {
        guard let last = locations.last else { return }
        Task { @MainActor in
            self.coordinate = last.coordinate
            self.lastLocation = last
        }
    }

    nonisolated func locationManager(_: CLLocationManager, didFailWithError _: Error) {
        // Kein Fehlerbanner: Im Simulator scheitert die Ortung so lange, bis
        // jemand einen Ort setzt. Das ist kein Zustand, über den die App
        // dauernd klagen sollte; sichtbar wird er, sobald eine Route gefragt
        // ist, und dann sagt Problem, was zu tun ist.
    }
}
