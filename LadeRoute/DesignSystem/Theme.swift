//  Theme.swift
//  Farbwerte aus dem punktlive-CI, damit der Prototyp zur Markenfamilie passt.
//  Referenz: README.md im Repo-Wurzelverzeichnis, Abschnitt CI-Kurzreferenz.

import SwiftUI

enum Theme {
    static let signal = Color(hex: 0xB8361F)
    static let signal2 = Color(hex: 0x9B2D19)
    static let ink = Color(hex: 0x1A1714)
    static let ink2 = Color(hex: 0x3D362E)
    static let meta = Color(hex: 0x6B625A)
    static let faint = Color(hex: 0x9C9388)
    static let paper = Color(hex: 0xFBF8F3)
    static let panel = Color(hex: 0xF1F1EE)
    static let rule = Color(hex: 0xE6E4DF)
    static let river = Color(hex: 0x2B5F7A)

    /// Ampelfarben für die Live-Belegung.
    static let free = Color(hex: 0x2E7D4F)
    static let busy = Color(hex: 0xB4741A)
    static let broken = Color(hex: 0x8A8178)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}
