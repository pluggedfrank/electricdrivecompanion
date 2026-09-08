//  GeoUtils.swift
//  Geometrie-Helfer ohne SDK-Abhängigkeit, damit sie isoliert testbar bleiben.

import CoreLocation
import Foundation

enum GeoUtils {
    static let earthRadiusMeters = 6_371_008.8

    /// Entfernung zweier Koordinaten in Metern (Haversine).
    static func distance(
        _ a: CLLocationCoordinate2D,
        _ b: CLLocationCoordinate2D
    ) -> CLLocationDistance {
        let phi1 = a.latitude * .pi / 180
        let phi2 = b.latitude * .pi / 180
        let dPhi = (b.latitude - a.latitude) * .pi / 180
        let dLambda = (b.longitude - a.longitude) * .pi / 180

        let h = sin(dPhi / 2) * sin(dPhi / 2)
            + cos(phi1) * cos(phi2) * sin(dLambda / 2) * sin(dLambda / 2)
        return 2 * earthRadiusMeters * asin(min(1, sqrt(h)))
    }

    /// Senkrechter Abstand von `point` zur Strecke `start`–`end`, in Metern.
    ///
    /// Rechnet in einer lokalen äquirektangulären Projektion. Auf den wenigen
    /// hundert Metern, um die es bei der Vereinfachung geht, ist der Fehler
    /// vernachlässigbar.
    static func perpendicularDistance(
        of point: CLLocationCoordinate2D,
        from start: CLLocationCoordinate2D,
        to end: CLLocationCoordinate2D
    ) -> CLLocationDistance {
        let latRef = (start.latitude + end.latitude) / 2 * .pi / 180
        let mPerDegLat = 111_132.0
        let mPerDegLon = 111_320.0 * cos(latRef)

        let px = (point.longitude - start.longitude) * mPerDegLon
        let py = (point.latitude - start.latitude) * mPerDegLat
        let ex = (end.longitude - start.longitude) * mPerDegLon
        let ey = (end.latitude - start.latitude) * mPerDegLat

        let segmentLengthSquared = ex * ex + ey * ey
        guard segmentLengthSquared > 0 else { return sqrt(px * px + py * py) }

        // Projektion auf das Segment, auf [0, 1] begrenzt.
        let t = max(0, min(1, (px * ex + py * ey) / segmentLengthSquared))
        let dx = px - t * ex
        let dy = py - t * ey
        return sqrt(dx * dx + dy * dy)
    }

    /// Douglas-Peucker-Vereinfachung mit fester Toleranz in Metern.
    static func simplify(
        _ coordinates: [CLLocationCoordinate2D],
        toleranceMeters: CLLocationDistance
    ) -> [CLLocationCoordinate2D] {
        guard coordinates.count > 2 else { return coordinates }

        var keep = [Bool](repeating: false, count: coordinates.count)
        keep[0] = true
        keep[coordinates.count - 1] = true

        // Iterativ statt rekursiv, damit sehr lange Routen den Stack nicht sprengen.
        var stack: [(Int, Int)] = [(0, coordinates.count - 1)]
        while let (first, last) = stack.popLast() {
            guard last > first + 1 else { continue }

            var maxDistance: CLLocationDistance = 0
            var maxIndex = first
            for i in (first + 1) ..< last {
                let d = perpendicularDistance(
                    of: coordinates[i],
                    from: coordinates[first],
                    to: coordinates[last]
                )
                if d > maxDistance {
                    maxDistance = d
                    maxIndex = i
                }
            }

            if maxDistance > toleranceMeters {
                keep[maxIndex] = true
                stack.append((first, maxIndex))
                stack.append((maxIndex, last))
            }
        }

        return zip(coordinates, keep).compactMap { $1 ? $0 : nil }
    }

    /// Reduziert eine Route auf höchstens `maxPoints` Stützpunkte.
    ///
    /// Die Along-Route-Suche bekommt die Geometrie im Request-Body. Eine echte
    /// Autobahnroute hat schnell mehrere tausend Punkte, das bläht den Request
    /// unnötig auf. Erst Douglas-Peucker mit wachsender Toleranz, danach als
    /// harte Grenze ein gleichmäßiges Ausdünnen.
    static func downsample(
        _ coordinates: [CLLocationCoordinate2D],
        maxPoints: Int
    ) -> [CLLocationCoordinate2D] {
        guard maxPoints >= 2 else { return coordinates }
        guard coordinates.count > maxPoints else { return coordinates }

        var tolerance: CLLocationDistance = 10
        var simplified = coordinates
        // Toleranz verdoppeln, bis es passt. 20 Runden reichen bis ~10.000 km.
        for _ in 0 ..< 20 {
            simplified = simplify(coordinates, toleranceMeters: tolerance)
            if simplified.count <= maxPoints { return simplified }
            tolerance *= 2
        }

        return stride(of: simplified, toAtMost: maxPoints)
    }

    /// Setzt entlang der Route alle `spacingMeters` einen Punkt.
    ///
    /// Anders als beim Ausdünnen geht es hier nicht um die Form der Linie,
    /// sondern um gleichmäßige Abstände: Diese Punkte werden zu Mittelpunkten
    /// von Umkreissuchen. Anfang und Ende sind immer dabei.
    static func samplePoints(
        along coordinates: [CLLocationCoordinate2D],
        spacingMeters: CLLocationDistance
    ) -> [CLLocationCoordinate2D] {
        guard let first = coordinates.first else { return [] }
        guard coordinates.count > 1, spacingMeters > 0 else { return [first] }

        var samples = [first]
        var sinceLast: CLLocationDistance = 0

        for i in 1 ..< coordinates.count {
            sinceLast += distance(coordinates[i - 1], coordinates[i])
            if sinceLast >= spacingMeters {
                samples.append(coordinates[i])
                sinceLast = 0
            }
        }

        if let last = coordinates.last, let lastSample = samples.last,
           last.latitude != lastSample.latitude || last.longitude != lastSample.longitude {
            samples.append(last)
        }

        return samples
    }

    /// Welche Korridorbreite deckt eine Kette von Umkreisen ab?
    ///
    /// Zwei benachbarte Kreise mit Radius R im Abstand S erfassen einen Punkt
    /// im senkrechten Abstand d, solange sqrt((S/2)² + d²) ≤ R gilt. Wird das
    /// Ergebnis null, klaffen zwischen den Kreisen Lücken.
    static func coveredCorridorWidth(
        radiusMeters: CLLocationDistance,
        spacingMeters: CLLocationDistance
    ) -> CLLocationDistance {
        let half = spacingMeters / 2
        let squared = radiusMeters * radiusMeters - half * half
        return squared <= 0 ? 0 : sqrt(squared)
    }

    /// Gleichmäßiges Ausdünnen mit garantiertem Erhalt von Anfang und Ende.
    static func stride(
        of coordinates: [CLLocationCoordinate2D],
        toAtMost maxPoints: Int
    ) -> [CLLocationCoordinate2D] {
        guard coordinates.count > maxPoints, maxPoints >= 2 else { return coordinates }

        var result: [CLLocationCoordinate2D] = []
        result.reserveCapacity(maxPoints)
        let step = Double(coordinates.count - 1) / Double(maxPoints - 1)
        for i in 0 ..< maxPoints {
            result.append(coordinates[Int((Double(i) * step).rounded())])
        }
        return result
    }
}
