//  Speaker.swift
//  Spricht die Ansagen der Zielführung.
//
//  Musik und Podcasts werden leiser, solange ein Satz läuft, und danach
//  wieder lauter. Ein neuer Satz unterbricht den alten: Was vor 600 m galt,
//  ist bei 300 m überholt. In der zehnfachen Simulation fällt das auf, auf
//  der Straße kaum.

import AVFoundation

@MainActor
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ text: String) {
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

    /// Die beste deutsche Stimme, die auf dem Gerät liegt.
    private static let voice: AVSpeechSynthesisVoice? = {
        let german = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "de-DE" }
        return german.max { $0.quality.rawValue < $1.quality.rawValue } ?? AVSpeechSynthesisVoice(language: "de-DE")
    }()

    private func activateSession() {
        guard !sessionActive else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
        try? session.setActive(true)
        sessionActive = true
    }

    private func deactivateSession() {
        guard sessionActive else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        sessionActive = false
    }
}
