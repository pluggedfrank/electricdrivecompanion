//  RouteTracker.swift
//  Wo das Auto auf der Route steht.
//
//  Gegenstück zu verorte() in tools/lib/fahrt.mjs, die Tests dort sind der
//  Maßstab. Gesucht wird zuerst in einem Fenster ab dem letzten Treffer, nicht
//  auf der ganzen Route: Eine Autobahn kommt sich an einem Kreuz selbst nahe,
//  und eine globale Suche springt dann auf den falschen Ast. Erst wenn im
//  Fenster nichts unter 300 m liegt, wird die ganze Route abgesucht.

import CoreLocation
import Foundation

struct RouteTracker {
    // MARK: Lifecycle

    init(geometry: [CLLocationCoordinate2D]) {
        points = geometry
        var cumulative = [Double](repeating: 0, count: geometry.count)
        for i in 1 ..< max(1, geometry.count) {
            cumulative[i] = cumulative[i - 1] + GeoUtils.distance(geometry[i - 1], geometry[i])
        }
        self.cumulative = cumulative
        lengthMeters = cumulative.last ?? 0
    }

    // MARK: Internal

    struct Fix: Equatable {
        /// Meter ab Routenbeginn.
        let progressMeters: Double
        /// Abstand zur Route.
        let offsetMeters: Double
        /// Liegt die Position auf der Route (unter 300 m daneben)?
        let isOnRoute: Bool
        /// Fahrtrichtung der Route an dieser Stelle, Grad ab Nord.
        let courseDegrees: Double
        /// Die Position auf der Route, nicht die gemessene.
        let snapped: CLLocationCoordinate2D

        static func == (a: Fix, b: Fix) -> Bool {
            a.progressMeters == b.progressMeters && a.offsetMeters == b.offsetMeters
        }
    }

    let points: [CLLocationCoordinate2D]
    let cumulative: [Double]
    let lengthMeters: Double

    /// Ordnet eine Position der Route zu und merkt sich den Treffer.
    mutating func locate(_ position: CLLocationCoordinate2D) -> Fix? {
        guard points.count >= 2 else { return nil }
        if let near = search(position, from: lastIndex - 20, to: lastIndex + 400), near.offset <= Self.snapMeters {
            lastIndex = near.index
            return fix(near, onRoute: true)
        }
        guard let far = search(position, from: 0, to: points.count) else { return nil }
        let onRoute = far.offset <= Self.snapMeters
        if onRoute { lastIndex = far.index }
        return fix(far, onRoute: onRoute)
    }

    /// Die Koordinate bei einem Weg ab Routenbeginn. Für die Fahrtsimulation.
    func coordinate(atProgress progress: Double) -> CLLocationCoordinate2D? {
        guard let first = points.first else { return nil }
        guard progress > 0 else { return first }
        guard progress < lengthMeters else { return points.last }
        let i = index(atProgress: progress)
        let segment = cumulative[i + 1] - cumulative[i]
        let t = segment > 0 ? (progress - cumulative[i]) / segment : 0
        let a = points[i], b = points[i + 1]
        return CLLocationCoordinate2D(
            latitude: a.latitude + (b.latitude - a.latitude) * t,
            longitude: a.longitude + (b.longitude - a.longitude) * t
        )
    }

    // MARK: Private

    private static let snapMeters: Double = 300

    private var lastIndex = 0

    private struct Hit {
        let index: Int
        let offset: Double
        let progress: Double
        let snapped: CLLocationCoordinate2D
    }

    private func search(_ p: CLLocationCoordinate2D, from: Int, to: Int) -> Hit? {
        let lower = max(0, from)
        let upper = min(points.count - 1, to)
        guard lower < upper else { return nil }

        var best: Hit?
        for i in lower ..< upper {
            let a = points[i], b = points[i + 1]
            let (t, offset) = Self.project(p, onto: a, b)
            if best == nil || offset < best!.offset {
                let segment = cumulative[i + 1] - cumulative[i]
                best = Hit(
                    index: i,
                    offset: offset,
                    progress: cumulative[i] + t * segment,
                    snapped: CLLocationCoordinate2D(
                        latitude: a.latitude + (b.latitude - a.latitude) * t,
                        longitude: a.longitude + (b.longitude - a.longitude) * t
                    )
                )
            }
        }
        return best
    }

    private func fix(_ hit: Hit, onRoute: Bool) -> Fix {
        // Die Richtung aus drei Punkten davor und drei dahinter: Zwei
        // Nachbarn liegen manchmal zehn Meter auseinander und zeigen dann in
        // jede Richtung.
        let before = points[max(0, hit.index - 3)]
        let after = points[min(points.count - 1, hit.index + 4)]
        return Fix(
            progressMeters: hit.progress,
            offsetMeters: hit.offset,
            isOnRoute: onRoute,
            courseDegrees: DetourKey.bearing(from: before, to: after),
            snapped: hit.snapped
        )
    }

    private func index(atProgress progress: Double) -> Int {
        var lo = 0
        var hi = cumulative.count - 2
        while lo < hi {
            let mid = (lo + hi + 1) >> 1
            if cumulative[mid] <= progress { lo = mid } else { hi = mid - 1 }
        }
        return lo
    }

    /// Lotfußpunkt als Anteil 0...1 und Abstand in Metern, lokal eben gerechnet.
    private static func project(
        _ p: CLLocationCoordinate2D,
        onto a: CLLocationCoordinate2D,
        _ b: CLLocationCoordinate2D
    ) -> (Double, Double) {
        let latitude = (a.latitude + b.latitude) / 2 * .pi / 180
        let mx = 111_320 * cos(latitude)
        let my = 111_132.0
        let bx = (b.longitude - a.longitude) * mx, by = (b.latitude - a.latitude) * my
        let px = (p.longitude - a.longitude) * mx, py = (p.latitude - a.latitude) * my
        let l2 = bx * bx + by * by
        let t = l2 > 0 ? max(0, min(1, (px * bx + py * by) / l2)) : 0
        let dx = px - t * bx, dy = py - t * by
        return (t, (dx * dx + dy * dy).squareRoot())
    }
}
