//  TomTomMapView.swift
//  Bindet die MapView des Maps SDK in SwiftUI ein.
//
//  Aufbau übernommen aus dem offiziellen TomTom-Beispiel
//  (tomtom-navigation-ios-examples, OnlineNavigationContent.swift): die MapView
//  ist eine UIView, der Coordinator übersetzt zwischen Delegate-Callbacks und
//  dem ObservableObject.

import Combine
import CoreLocation
import SwiftUI
import TomTomSDKLocationProvider
import TomTomSDKMapDisplay
import TomTomSDKRoute

struct TomTomMapView: UIViewRepresentable {
    typealias UIViewType = TomTomSDKMapDisplay.MapView

    @ObservedObject var trip: TripViewModel

    func makeUIView(context: Context) -> TomTomSDKMapDisplay.MapView {
        let mapView = TomTomSDKMapDisplay.MapView()
        mapView.delegate = context.coordinator
        mapView.currentLocationButtonVisibilityPolicy = .hiddenWhenCentered
        mapView.compassButtonVisibilityPolicy = .visibleWhenNeeded
        context.coordinator.attach(mapView: mapView)
        return mapView
    }

    func updateUIView(_ mapView: TomTomSDKMapDisplay.MapView, context: Context) {
        // Während der Fahrt liegt rechts die Kachelspalte und unten kein
        // Blatt; die Mitte der Karte, und damit der Pfeil, rückt nach links.
        mapView.contentInsets = NSDirectionalEdgeInsets(
            top: 0,
            leading: 0,
            bottom: trip.isDriving ? 0 : trip.mapBottomInset,
            trailing: trip.isDriving ? trip.mapTrailingInset : 0
        )
    }

    func makeCoordinator() -> MapCoordinator {
        MapCoordinator(trip: trip)
    }
}
