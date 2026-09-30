//  Guidance.swift
//  Zielführung: welche Anweisung als nächste kommt, wann sie angesagt wird
//  und mit welchen Worten.
//
//  Gegenstück zu tools/lib/ansage.mjs; die Tests dort sind der Maßstab. Die
//  Texte liefert die Routing-API fertig auf Deutsch. Hier wird nur
//  entschieden, wann welcher Satz fällt, und die Entfernung davorgesetzt.

import CoreLocation
import Foundation

struct GuidanceInstruction: Identifiable, Equatable {
    let id: Int
    /// Meter ab Start laut API.
    let offsetMeters: Double
    let point: CLLocationCoordinate2D
    /// Manöver der API, etwa TURN_LEFT, TAKE_EXIT, ARRIVE_LEFT.
    let maneuver: String
    let text: String
    let combinedText: String?
    /// Meter ab Routenbeginn auf der Linie des SDK.
    var progressMeters: Double = 0
    /// Einzelteile der API für die kurze Anzeige, siehe display.
    var street: String?
    var roadNumbers: [String] = []
    var signpost: String?
    var exitNumber: String?
    var roundaboutExit: Int?

    var isDeparture: Bool { maneuver == "DEPART" }
    var isFollow: Bool { maneuver == "FOLLOW" }
    var isArrival: Bool { maneuver.hasPrefix("ARRIVE") }
    var isWaypoint: Bool { maneuver.hasPrefix("WAYPOINT") }

    static func == (a: GuidanceInstruction, b: GuidanceInstruction) -> Bool {
        a.id == b.id && a.progressMeters == b.progressMeters && a.text == b.text
    }

    struct Display: Equatable {
        /// Groß: Richtung, Straße oder Nummer, sonst die Aktion.
        let headline: String
        /// Darunter: "Ausfahrt 8 · A42", "Rechts abbiegen · Richtung Norddeich".
        let action: String?
    }

    /// Der Abbiegehinweis zum schnellen Ablesen. Auf der Autobahn zählt das
    /// Schild (Richtung), in der Stadt die Straße; E-, L- und K-Nummern
    /// bleiben weg, außer es gibt sonst nichts. Gegenstück zu anzeige() in
    /// tools/lib/ansage.mjs.
    var display: Display {
        var action = Self.actions[maneuver]
        if maneuver == "TAKE_EXIT", let exitNumber { action = "Ausfahrt \(exitNumber)" }
        if maneuver.hasPrefix("ROUNDABOUT") {
            action = roundaboutExit.map { "Kreisverkehr, \($0). Ausfahrt" } ?? "Kreisverkehr"
        }
        let number = roadNumbers.first { $0.range(of: #"^[EKL]\d"#, options: .regularExpression) == nil }
            ?? (street == nil ? roadNumbers.first : nil)
        let order = Self.signpostManeuvers.contains(maneuver)
            ? [signpost, number, street]
            : [street, number, signpost]
        guard let headline = order.compactMap({ $0 }).first else {
            return Display(headline: action ?? text, action: nil)
        }
        var parts = [action].compactMap { $0 }
        if let number, number != headline { parts.append(number) }
        if let signpost, signpost != headline { parts.append("Richtung \(signpost)") }
        return Display(headline: headline, action: parts.isEmpty ? nil : parts.joined(separator: " · "))
    }

    private static let actions: [String: String] = [
        "TURN_LEFT": "Links abbiegen", "TURN_RIGHT": "Rechts abbiegen",
        "SHARP_LEFT": "Scharf links", "SHARP_RIGHT": "Scharf rechts",
        "BEAR_LEFT": "Links halten", "BEAR_RIGHT": "Rechts halten",
        "KEEP_LEFT": "Links bleiben", "KEEP_RIGHT": "Rechts bleiben",
        "STRAIGHT": "Geradeaus", "FOLLOW": "Weiter",
        "ENTER_MOTORWAY": "Auffahren", "ENTER_FREEWAY": "Auffahren", "ENTER_HIGHWAY": "Auffahren",
        "TAKE_EXIT": "Ausfahrt", "MOTORWAY_EXIT_LEFT": "Ausfahrt links", "MOTORWAY_EXIT_RIGHT": "Ausfahrt rechts",
        "SWITCH_MOTORWAY_LEFT": "Links wechseln", "SWITCH_MOTORWAY_RIGHT": "Rechts wechseln",
        "SWITCH_PARALLEL_ROAD": "Parallelfahrbahn", "SWITCH_MAIN_ROAD": "Hauptfahrbahn",
        "MAKE_UTURN": "Wenden", "TRY_MAKE_UTURN": "Wenden",
        "TAKE_FERRY": "Fähre", "DEPART": "Start",
        "ARRIVE": "Ziel", "ARRIVE_LEFT": "Ziel links", "ARRIVE_RIGHT": "Ziel rechts",
        "WAYPOINT_REACHED": "Zwischenziel", "WAYPOINT_LEFT": "Zwischenziel links", "WAYPOINT_RIGHT": "Zwischenziel rechts",
    ]

    private static let signpostManeuvers: Set<String> = [
        "ENTER_MOTORWAY", "ENTER_FREEWAY", "ENTER_HIGHWAY", "TAKE_EXIT", "MOTORWAY_EXIT_LEFT",
        "MOTORWAY_EXIT_RIGHT", "KEEP_LEFT", "KEEP_RIGHT", "FOLLOW", "STRAIGHT",
        "SWITCH_MOTORWAY_LEFT", "SWITCH_MOTORWAY_RIGHT", "SWITCH_PARALLEL_ROAD", "SWITCH_MAIN_ROAD",
    ]

    /// Ein SF Symbol für das Manöver.
    var symbolName: String {
        switch maneuver {
        case "TURN_LEFT", "SHARP_LEFT": return "arrow.turn.up.left"
        case "TURN_RIGHT", "SHARP_RIGHT": return "arrow.turn.up.right"
        case "BEAR_LEFT", "KEEP_LEFT", "MOTORWAY_EXIT_LEFT": return "arrow.up.left"
        case "BEAR_RIGHT", "KEEP_RIGHT", "MOTORWAY_EXIT_RIGHT", "TAKE_EXIT": return "arrow.up.right"
        case "ENTER_MOTORWAY", "ENTER_FREEWAY", "ENTER_HIGHWAY", "SWITCH_MOTORWAY", "SWITCH_PARALLEL_ROAD", "SWITCH_MAIN_ROAD":
            return "arrow.merge"
        case "MAKE_UTURN", "TRY_MAKE_UTURN": return "arrow.uturn.left"
        case "TAKE_FERRY": return "ferry"
        default:
            if maneuver.hasPrefix("ROUNDABOUT") { return "arrow.triangle.2.circlepath" }
            if isArrival { return "flag.checkered" }
            if isWaypoint { return "mappin.and.ellipse" }
            return "arrow.up"
        }
    }
}

enum Guidance {
    /// Aus der Antwort der API, in der Reihenfolge der Route.
    static func instructions(from dto: [CalculateRouteResponse.Instruction]) -> [GuidanceInstruction] {
        dto.enumerated().map { index, a in
            GuidanceInstruction(
                id: index,
                offsetMeters: a.routeOffsetInMeters,
                point: CLLocationCoordinate2D(latitude: a.point.latitude, longitude: a.point.longitude),
                maneuver: a.maneuver,
                text: signed(a.message),
                combinedText: a.combinedMessage.map(signed),
                street: a.street,
                roadNumbers: a.roadNumbers ?? [],
                signpost: a.signpostText,
                exitNumber: a.exitNumber,
                roundaboutExit: a.roundaboutExitNumber
            )
        }
    }

    /// Legt die Anweisungen auf die Linie des SDK. Maßgeblich ist der
    /// Manöverpunkt, gesucht ab der vorigen Anweisung vorwärts. Liegt er mehr
    /// als 100 m daneben, bleibt der Meterwert der API, auf die Länge
    /// umgerechnet.
    static func locate(_ instructions: [GuidanceInstruction], on tracker: RouteTracker, snapMeters: Double = 100) -> [GuidanceInstruction] {
        let total = instructions.last?.offsetMeters ?? 0
        let factor = total > 0 ? tracker.lengthMeters / total : 1
        var from = 0
        var last = 0.0
        return instructions.map { instruction in
            var located = instruction
            var progress = instruction.offsetMeters * factor
            if let hit = tracker.nearest(to: instruction.point, from: from), hit.offsetMeters <= snapMeters {
                progress = hit.progressMeters
                from = hit.index
            }
            progress = max(last, progress)
            last = progress
            located.progressMeters = progress
            return located
        }
    }

    enum Stage: Int, CaseIterable {
        case early, near, now
    }

    /// Ab welcher Entfernung welche Stufe gilt, nach Tempo in m/s.
    static func thresholds(speed: Double) -> (early: Double, near: Double, now: Double) {
        if speed >= 22 { return (2000, 600, min(300, max(60, speed * 4))) }
        if speed >= 12 { return (800, 250, min(120, max(40, speed * 4))) }
        return (400, 120, 40)
    }

    static func stage(distance: Double, speed: Double) -> Stage? {
        let t = thresholds(speed: speed)
        if distance <= t.now { return .now }
        if distance <= t.near { return .near }
        if distance <= t.early { return .early }
        return nil
    }

    private static func comma(_ text: String) -> String {
        text.replacingOccurrences(of: ".", with: ",")
    }

    private static func number(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : comma(String(value))
    }

    /// Lässt weg, was so nicht auf den Schildern steht: Europastraßen,
    /// Landes- und Kreisstraßennummern, sobald daneben ein anderer Name
    /// steht. "A57/E31" wird "A57", "Moerser Straße/L137" wird "Moerser
    /// Straße". Allein bleibt die Nummer. Gegenstück zu beschilderung() in
    /// tools/lib/ansage.mjs.
    static func signed(_ text: String) -> String {
        text
            .replacingOccurrences(of: #"/[EKL]\d{1,4}\b"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\b[EKL]\d{1,4}/"#, with: "", options: .regularExpression)
    }

    /// Macht den Text sprechbar: "B1" wird "B eins" statt "B eine", "A52"
    /// wird "A 52", und ein verbliebener Schrägstrich wird zur Pause.
    /// Gegenstück zu sprechbar() in tools/lib/ansage.mjs.
    static func speakable(_ text: String) -> String {
        var s = text
        s = s.replacingOccurrences(of: #"\s*/\s*"#, with: ", ", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\b([A-Z]{1,2})1\b"#, with: "$1 eins", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\b([A-Z]{1,2})(\d{1,4})\b"#, with: "$1 $2", options: .regularExpression)
        return s
    }

    /// "500 Metern", "1,5 Kilometern", "einem Kilometer": für "In ..."
    static func spokenDistance(_ meters: Double) -> String {
        if meters >= 950 {
            let km = meters < 9500 ? (meters / 500).rounded() / 2 : (meters / 1000).rounded()
            return km == 1 ? "einem Kilometer" : "\(number(km)) Kilometern"
        }
        let rounded = meters >= 300 ? (meters / 100).rounded() * 100 : max(50, (meters / 50).rounded() * 50)
        return "\(Int(rounded)) Metern"
    }

    /// Für die Anzeige: "250 m", "1,5 km", "209 km".
    static func shortDistance(_ meters: Double) -> String {
        if meters >= 1000 {
            let km = meters / 1000
            return km < 10 ? "\(comma(String(format: "%.1f", km))) km" : "\(Int(km.rounded())) km"
        }
        if meters >= 200 { return "\(Int((meters / 50).rounded() * 50)) m" }
        return "\(max(0, Int((meters / 10).rounded() * 10))) m"
    }

    private static let verbFirst = try! NSRegularExpression(
        pattern: "^(Biegen|Halten|Bleiben|Nehmen|Fahren|Folgen|Wenden|Verlassen|Wechseln|Ordnen) Sie\\b"
    )

    /// Der Satz für eine Anweisung in einer Stufe, oder nil.
    static func announcement(
        _ a: GuidanceInstruction,
        stage: Stage,
        distance: Double,
        toNext: Double = 0,
        withThen: Bool = false
    ) -> String? {
        if a.isDeparture { return nil }
        if a.isFollow {
            // Nur, wenn danach lange nichts kommt: Dann ist die Strecke die Nachricht.
            guard stage == .now, toNext >= 10_000 else { return nil }
            return "\(a.text) für \(Int((toNext / 1000).rounded())) Kilometer"
        }
        let sentence = stage == .near || (stage == .now && withThen) ? (a.combinedText ?? a.text) : a.text
        if stage == .now { return sentence }
        let lead = "In \(spokenDistance(distance))"
        if a.isArrival { return "\(lead) erreichen Sie Ihr Ziel" }
        if a.isWaypoint { return "\(lead) erreichen Sie Ihren Zwischenhalt" }
        let range = NSRange(sentence.startIndex..., in: sentence)
        if verbFirst.firstMatch(in: sentence, range: range) != nil {
            return "\(lead) \(sentence.prefix(1).lowercased())\(sentence.dropFirst())"
        }
        return "\(lead): \(sentence)"
    }

    /// Index der nächsten Anweisung vor dem Auto, ohne die Abfahrt. Das Ziel
    /// bleibt noch 100 m über seinen Punkt hinaus die nächste.
    static func nextIndex(_ instructions: [GuidanceInstruction], progress: Double) -> Int? {
        if let i = instructions.firstIndex(where: { !$0.isDeparture && $0.progressMeters > progress }) {
            return i
        }
        if let last = instructions.indices.last, instructions[last].isArrival,
           progress - instructions[last].progressMeters < 100 {
            return last
        }
        return nil
    }
}

/// Was schon gesagt ist, über die Fahrt hinweg.
struct Announcer {
    struct Step {
        let index: Int?
        let distance: Double?
        let text: String?
    }

    private var marked = Set<String>()
    private var spoken = Set<String>()
    private var covered = Set<Int>()

    /// Ein Schritt der Zielführung: die nächste Anweisung, der Abstand dahin
    /// und, wenn jetzt etwas zu sagen ist, der Satz. Jede Stufe fällt
    /// höchstens einmal; ist eine spätere schon erreicht, entfallen die
    /// früheren. Hat die vorige Anweisung ihren Nachfolger mit "dann ..."
    /// angekündigt, sagt der nur noch "jetzt".
    mutating func step(_ instructions: [GuidanceInstruction], progress: Double, speed: Double) -> Step {
        guard let index = Guidance.nextIndex(instructions, progress: progress) else {
            return Step(index: nil, distance: nil, text: nil)
        }
        let a = instructions[index]
        let distance = max(0, a.progressMeters - progress)
        guard let stage = Guidance.stage(distance: distance, speed: speed) else {
            return Step(index: index, distance: distance, text: nil)
        }

        let later = Guidance.Stage.allCases.filter { $0.rawValue >= stage.rawValue }
        if later.contains(where: { marked.contains("\(index):\($0.rawValue)") }) {
            return Step(index: index, distance: distance, text: nil)
        }
        for s in Guidance.Stage.allCases where s.rawValue <= stage.rawValue {
            marked.insert("\(index):\(s.rawValue)")
        }
        if covered.contains(index), stage != .now {
            return Step(index: index, distance: distance, text: nil)
        }

        let toNext = index + 1 < instructions.count ? instructions[index + 1].progressMeters - a.progressMeters : 0
        let withThen = stage == .now && !spoken.contains("\(index):\(Guidance.Stage.near.rawValue)")
        let text = Guidance.announcement(a, stage: stage, distance: distance, toNext: toNext, withThen: withThen)
        if text != nil {
            spoken.insert("\(index):\(stage.rawValue)")
            if stage == .near || withThen, a.combinedText != nil { covered.insert(index + 1) }
        }
        return Step(index: index, distance: distance, text: text)
    }
}
