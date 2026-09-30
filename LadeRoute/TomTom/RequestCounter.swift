//  RequestCounter.swift
//  Zählt, was die App bei TomTom abfragt, je Tag und je Monat.
//
//  Anlass: Am 30.09.2026 war das Suchkontingent leer, und niemand wusste,
//  wohin es gegangen war. Gezählt wird jede Anfrage, die rausgeht, auch eine,
//  die TomTom ablehnt. Die Testversion zeigt die Zahlen im Stationsblatt.

import Foundation

enum RequestKind: String, CaseIterable, Sendable {
    case search = "Suche"
    case availability = "Verfügbarkeit"
    case routing = "Routing"
    case matrix = "Matrix"

    /// Die Art einer REST-Anfrage, aus dem Pfad.
    static func of(_ url: URL?) -> RequestKind? {
        guard let path = url?.path else { return nil }
        if path.contains("/chargingAvailability") { return .availability }
        if path.contains("/search/") { return .search }
        if path.contains("/routing/matrix") { return .matrix }
        if path.contains("/routing/") { return .routing }
        return nil
    }
}

final class RequestCounter: @unchecked Sendable {
    static let shared = RequestCounter()
    static let didChange = Notification.Name("RequestCounterDidChange")

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func count(_ kind: RequestKind, at date: Date = Date()) {
        lock.lock()
        var counts = defaults.dictionary(forKey: Self.key) as? [String: Int] ?? [:]
        let day = Self.dayKey(date), month = Self.monthKey(date)
        counts["\(day)|\(kind.rawValue)", default: 0] += 1
        counts["\(month)|\(kind.rawValue)", default: 0] += 1
        // Nur dieser und der letzte Monat bleiben stehen.
        let previous = Self.monthKey(Calendar.current.date(byAdding: .month, value: -1, to: date) ?? date)
        counts = counts.filter { $0.key.hasPrefix(month) || $0.key.hasPrefix(previous) }
        defaults.set(counts, forKey: Self.key)
        lock.unlock()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: Self.didChange, object: nil)
        }
    }

    func today(_ kind: RequestKind, at date: Date = Date()) -> Int {
        value("\(Self.dayKey(date))|\(kind.rawValue)")
    }

    func thisMonth(_ kind: RequestKind, at date: Date = Date()) -> Int {
        value("\(Self.monthKey(date))|\(kind.rawValue)")
    }

    // MARK: Private

    private static let key = "tomtomRequestCounts"
    private let defaults: UserDefaults
    private let lock = NSLock()

    private func value(_ key: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return (defaults.dictionary(forKey: Self.key) as? [String: Int])?[key] ?? 0
    }

    private static func dayKey(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    private static func monthKey(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", c.year ?? 0, c.month ?? 0)
    }
}
