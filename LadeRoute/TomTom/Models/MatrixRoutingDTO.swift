//  MatrixRoutingDTO.swift
//  Anfrage und Antwort von /routing/matrix/2.
//
//  Beide Domains der TomTom-Dokumentation sind aus der Entwicklungsumgebung
//  gesperrt; das Format ist am 10.09.2026 mit tools/matrix-probe.mjs an der
//  API selbst abgefragt. Die Punkte müssen in `point` stehen, das ist Pflicht.
//  Die Antwort ist eine flache Liste mit originIndex und destinationIndex,
//  keine Matrix; Zellen ohne Route fehlen einfach.

import CoreLocation
import Foundation

struct MatrixRoutingRequest: Encodable {
    let origins: [Location]
    let destinations: [Location]

    init(origins: [CLLocationCoordinate2D], destinations: [CLLocationCoordinate2D]) {
        self.origins = origins.map(Location.init)
        self.destinations = destinations.map(Location.init)
    }

    struct Location: Encodable {
        let point: Point

        init(_ coordinate: CLLocationCoordinate2D) {
            point = Point(latitude: coordinate.latitude, longitude: coordinate.longitude)
        }
    }

    struct Point: Encodable {
        let latitude: Double
        let longitude: Double
    }
}

struct MatrixRoutingResponse: Decodable {
    let data: [Cell]

    struct Cell: Decodable {
        let originIndex: Int
        let destinationIndex: Int
        let routeSummary: RouteSummary?
    }

    struct RouteSummary: Decodable {
        let lengthInMeters: Double?
        let travelTimeInSeconds: Double?
        let trafficDelayInSeconds: Double?
    }

    /// Macht aus der flachen Liste eine Tabelle [start][ziel] mit Sekunden.
    ///
    /// nil, wo die API keine Route gefunden hat. Das muss der Aufrufer
    /// vertragen, deshalb kein Ersatzwert.
    func travelTimes(originCount: Int, destinationCount: Int) -> [[Double?]] {
        var table = [[Double?]](
            repeating: [Double?](repeating: nil, count: destinationCount),
            count: originCount
        )
        for cell in data {
            guard cell.originIndex >= 0, cell.originIndex < originCount,
                  cell.destinationIndex >= 0, cell.destinationIndex < destinationCount
            else { continue }
            table[cell.originIndex][cell.destinationIndex] = cell.routeSummary?.travelTimeInSeconds
        }
        return table
    }
}
