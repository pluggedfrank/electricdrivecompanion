//  Speaker.swift
//  Spricht die Ansagen der Zielführung.
//
//  Musik und Podcasts werden leiser, solange ein Satz läuft, und danach
//  wieder lauter. Ein neuer Satz unterbricht den alten: Was vor 600 m galt,
//  ist bei 300 m überholt. In der zehnfachen Simulation fällt das auf, auf
//  der Straße kaum.
//
//  Apples Regeln für Navigations-Apps (CarPlay Developer Guide, Voice
//  prompts): Sitzung nur aktiv, solange gesprochen wird, und vor jedem Satz
//  promptStyle fragen. Telefoniert jemand oder spricht mit Siri, kommt kein
//  Satz, höchstens ein Ton.

import AudioToolbox
import AVFoundation

@MainActor
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ text: String) {
        prepareCategory()
        switch AVAudioSession.sharedInstance().promptStyle {
        case .none:
            return
        case .short:
            AudioServicesPlaySystemSound(Self.shortPromptTone)
            return
        default:
            break
        }
        activateSession()
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .word)
        }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.voice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        deactivateSession()
    }

    // MARK: AVSpeechSynthesizerDelegate

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            if !self.synthesizer.isSpeaking { self.deactivateSession() }
        }
    }

    // MARK: Private

    private let synthesizer = AVSpeechSynthesizer()
    private var sessionActive = false
    private var categorySet = false
    /// Der kurze Hinweiston, wenn nur ein Ton passt.
    private static let shortPromptTone: SystemSoundID = 1057

    /// Die beste deutsche Stimme, die auf dem Gerät liegt.
    private static let voice: AVSpeechSynthesisVoice? = {
        let german = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "de-DE" }
        return german.max { $0.quality.rawValue < $1.quality.rawValue } ?? AVSpeechSynthesisVoice(language: "de-DE")
    }()

    /// Die Kategorie vor promptStyle setzen: Die Antwort gilt für die
    /// Kategorie der Sitzung.
    private func prepareCategory() {
        guard !categorySet else { return }
        try? AVAudioSession.sharedInstance().setCategory(
            .playback, mode: .voicePrompt, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers]
        )
        categorySet = true
    }

    private func activateSession() {
        guard !sessionActive else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        sessionActive = true
    }

    private func deactivateSession() {
        guard sessionActive else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        sessionActive = false
    }
}
