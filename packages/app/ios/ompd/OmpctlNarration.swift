import AVFoundation
import React

/**
 Device side of the narration seam declared in packages/app/src/voice/narration.ts
 (`NativeModules.OmpctlNarration`). Speech is AVSpeechSynthesizer, a platform
 framework, so no dependency is added. OmpctlNarration.m holds the module
 registration; RCT_EXPORT macros are Objective-C only and cannot live here.
 */
@objc(OmpctlNarration)
final class OmpctlNarration: NSObject {
  private let synthesizer = AVSpeechSynthesizer()

  /**
   Category .playback, not the default .ambient: ambient audio is muted by the
   ring/silent switch, and narration that goes quiet the moment a phone is on
   silent would read as "narration is broken". .playback keeps speech audible
   regardless of the switch. Mode .spokenAudio declares the stream as spoken
   audio so the system treats pauses like speech, not a stalled music stream.
   */
  private func activatePlaybackSession() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playback, mode: .spokenAudio)
    try session.setActive(true)
  }

  /**
   Everything runs on the main queue: speak and stop must be applied in the
   order JS issued them, and AVSpeechSynthesizer callbacks arrive on the queue
   the utterances were started from, so keeping one queue keeps ordering
   deterministic.
   */
  @objc(speak:resolver:rejecter:)
  func speak(
    _ text: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async { [self] in
      do {
        try activatePlaybackSession()
        let utterance = AVSpeechUtterance(string: text)
        // speak(_:) enqueues and returns no status, so there is no failure
        // signal at enqueue time to branch on.
        self.synthesizer.speak(utterance)
        // Resolved on enqueue, not on completion: the JS narrator chains
        // segments and the synthesizer queues utterances itself, so this
        // matches the Android engine queue and stop() can flush the backlog.
        resolve(nil)
      } catch {
        reject(
          "E_AUDIO_SESSION",
          "Narration could not activate the audio session: \(error.localizedDescription)",
          error
        )
      }
    }
  }

  @objc(stop:rejecter:)
  func stop(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async { [self] in
      // .immediate cuts the utterance mid-word and drops everything queued
      // behind it; the operator turned narration off and the backlog must not
      // keep playing.
      _ = self.synthesizer.stopSpeaking(at: .immediate)
      resolve(nil)
    }
  }
}
