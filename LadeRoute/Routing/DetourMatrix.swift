//  DetourMatrix.swift
//  Rechnet Umwege zu Ladestationen mit der Matrix-Routing-API.
//
//  Gegenstück zu tools/lib/matrix.mjs, und zwar absichtlich Zeile für Zeile:
//  Die JS-Fassung läuft im Probelauf gegen die echte API und wird dort gegen
//  TomToms eigene Umwege gehalten. Was hier steht, soll dasselbe rechnen.
//
//  Der Umweg ist die Fahrzeit vom Verlassen der Route bis zum Wiederauffahren.
//  Die Along-Route-Suche liefert ihn mit, die Umkreissuche nicht, und die
//  bringt den größeren Teil der Treffer. Ohne diesen Wert steht in der App die
//  Luftlinie, und die sagt über die Fahrzeit fast nichts.
//
//  Das Verfahren:
//    1. Auf der Route alle 50 km einen Stützpunkt setzen.
//    2. Für jede Station den Stützpunkt davor und den dahinter bestimmen.
//    3. Drei Matrizen rechnen: Stützpunkt davor zur Station, Station zum
//       Stützpunkt dahinter, und Stützpunkt davor zum Stützpunkt dahinter.
//    4. Umweg = Hinfahrt + Rückfahrt minus der Strecke, die man ohnehin
//       gefahren wäre.
//
//  Die dritte Matrix ist keine Sparsamkeit wert: Die Abschnittszeit anteilig
//  aus der Gesamtfahrzeit zu schätzen, gab auf den ersten 50 km durch
//  Düsseldorf zwölf Minuten zu wenig, und genau die zwölf Minuten standen dann
//  als Umweg an jeder Station in diesem Abschnitt. Alle drei Zeiten müssen aus
//  derselben Quelle kommen.

import CoreLocation
import Foundation

enum DetourMatrix {
    /// Höchstzahl der Zellen je Anfrage. Gemessen am 10.09.2026: 200 gehen
    /// durch, 300 nicht ("The matrix size and parameters combination violates
    /// the API limitations").
    static let maxCells = 200

    /// Abstand der Stützpunkte auf der Route.
    static let supportSpacingMeters: Double = 50_000

    // MARK: Stützpunkte

    struct SupportPoint {
        let coordinate: CLLocationCoordinate2D
        let progressMeters: Double
    }

    /// Setzt Stützpunkte auf die Route und merkt sich den Weg bis dahin.
    ///
    /// Anfang und Ende sind immer dabei, damit jede Station eine Klammer hat.
    static func supportPoints(
        along geometry: [CLLocationCoordinate2D],
        spacingMeters: Double = supportSpacingMeters
    ) -> [SupportPoint] {
        guard let first = geometry.first else { return [] }

        var points = [SupportPoint(coordinate: first, progressMeters: 0)]
        var progress: Double = 0
        var lastPlaced: Double = 0

        for i in 1 ..< geometry.count {
            progress += GeoUtils.distance(geometry[i - 1], geometry[i])
            if progress - lastPlaced >= spacingMeters {
                points.append(SupportPoint(coordinate: geometry[i], progressMeters: progress))
                lastPlaced = progress
            }
        }

        if let last = geometry.last, points[points.count - 1].progressMeters < progress {
            points.append(SupportPoint(coordinate: last, progressMeters: progress))
        }

        return points
    }

    /// Der Stützpunkt davor und der dahinter, als Indizes.
    struct Bracket: Hashable {
        let before: Int
        let after: Int
    }

    static func bracket(_ supports: [SupportPoint], progressMeters: Double) -> Bracket {
        var before = 0
        for (i, support) in supports.enumerated() {
            if support.progressMeters <= progressMeters { before = i } else { break }
        }
        return Bracket(before: before, after: min(before + 1, supports.count - 1))
    }

    // MARK: Blöcke

    /// Ein Teil der Arbeit, der unter der Zellengrenze bleibt.
    ///
    /// `entries` sind Indizes in die Liste des Aufrufers, keine Kopien der
    /// Einträge. Die JS-Fassung ist genau daran einmal gescheitert: Sie hielt
    /// Kopien, und was nach der Anfrage hineingeschrieben wurde, kam beim
    /// Original nie an.
    struct Block {
        let entries: [Int]
        let supports: [Int]
    }

    /// Teilt die Arbeit in Anfragen unter der Zellengrenze auf.
    ///
    /// Gierig: Einträge kommen der Reihe nach in den Block, solange das Produkt
    /// aus verschiedenen Stützpunkten und Blockgröße unter der Grenze bleibt.
    /// Weil die Stationen entlang der Route sortiert sind, teilen sich
    /// benachbarte ihre Stützpunkte, und die Blöcke werden von selbst groß.
    ///
    /// `supportOf[i]` ist der Stützpunkt, der zum Eintrag i gehört.
    static func blocks(supportOf: [Int], maxCells: Int = maxCells) -> [Block] {
        var result: [Block] = []
        var entries: [Int] = []
        var supports: [Int] = []

        for (index, support) in supportOf.enumerated() {
            var next = supports
            if !next.contains(support) { next.append(support) }

            if !entries.isEmpty, next.count * (entries.count + 1) > maxCells {
                result.append(Block(entries: entries, supports: supports))
                entries = []
                supports = [support]
            } else {
                supports = next
            }
            entries.append(index)
        }

        if !entries.isEmpty {
            result.append(Block(entries: entries, supports: supports))
        }
        return result
    }

    /// Die Abschnitte, zwischen deren Stützpunkten Stationen liegen.
    ///
    /// Jeder nur einmal, und ohne die Klammer der Länge null: Eine Station
    /// hinter dem letzten Stützpunkt klammert auf sich selbst, da gibt es
    /// nichts zu messen.
    static func segments(_ brackets: [Bracket]) -> [Bracket] {
        var seen = Set<Bracket>()
        return brackets.filter { $0.before != $0.after && seen.insert($0).inserted }
    }

    // MARK: Ergebnis

    /// Umweg aus Hin- und Rückfahrt und der ohnehin gefahrenen Strecke.
    ///
    /// Negative Werte gibt es: Wenn die Matrix einen kürzeren Weg findet als
    /// die geplante Route, kommt rechnerisch ein Gewinn heraus. Das ist kein
    /// Umweg, sondern Rauschen, und wird auf null gesetzt.
    static func detourSeconds(outbound: Double?, inbound: Double?, along: Double?) -> Double? {
        guard let outbound, let inbound, let along else { return nil }
        return max(0, outbound + inbound - along)
    }
}
