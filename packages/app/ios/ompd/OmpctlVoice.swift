import AVFoundation
import React

/**
 Device side of the memo voice seam declared in packages/app/src/voice/memo.ts
 (`NativeModules.OmpctlVoice`). Capture is an AVAudioEngine input tap,
 playback is an AVAudioPlayerNode on the same engine, and both are platform
 frameworks, so no dependency is added. OmpctlVoice.m holds the module
 registration; RCT_EXPORT macros are Objective-C only and cannot live here.
 */
@objc(OmpctlVoice)
final class OmpctlVoice: NSObject, RCTInvalidating {
  /**
   Set by React Native's module decorator; RCTBridgeModule.h documents this
   exact Swift shape. A plain module emits device events through it, the same
   internal path RCTEventEmitter uses, so events reach JS under both the
   bridge and the bridgeless runtime this app ships with.
   */
  @objc var callableJSModules: RCTCallableJSModules!

  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private var playerAttached = false
  private var playFormat: AVAudioFormat?
  private var converter: AVAudioConverter?
  private var captureFormat: AVAudioFormat?
  private var capturing = false
  private var pendingPlays: [PlayTicket] = []

  /**
   The wire rate every chunk plays at. Mirrors WIRE_SAMPLE_RATE in
   packages/daemon/src/voice/bridge.ts, the authority for the wire contract;
   a capture that started earlier stores the rate JS handed it, which in this
   app is the same number.
   */
  private var wireRate: Double = 16_000

  /**
   Chunks convert on the tap thread but every emission, and the resolve of
   stopCapture, funnel through this one serial queue. That ordering is the
   seam's contract made real: the stop resolves only after the final chunk
   event has been handed to JS, so a caller can send audio_end after the last
   audio frame, not beside it.
   */
  private let emitQueue = DispatchQueue(label: "ai.ompctl.voice.emit")

  /** One awaited playPcm call, resolved exactly once whether it plays out or is halted. */
  private final class PlayTicket {
    private let resolve: RCTPromiseResolveBlock
    private var done = false

    init(_ resolve: @escaping RCTPromiseResolveBlock) {
      self.resolve = resolve
    }

    func finish() {
      // stop() flushing the player also fires scheduled completions, so a
      // ticket can be asked to finish twice; the second ask is a no-op.
      guard !done else { return }
      done = true
      resolve(nil)
    }
  }

  /**
   Category .playAndRecord, mode .voiceChat, option .defaultToSpeaker.
   .playAndRecord is the only category that keeps the input and output paths
   open at the same time, so memo capture and OmpctlNarration playback
   (category .playback) can overlap instead of each activation reconfiguring
   the session out from under the other. .voiceChat engages hardware echo
   cancellation so the microphone does not re-capture the agent speech the
   speaker is playing while the operator talks. .defaultToSpeaker keeps that
   speech on the loudspeaker, because .playAndRecord alone would route it to
   the earpiece.
   */
  private func activateSession() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker])
    try session.setActive(true)
  }

  /**
   AVAudioSession's recordPermission APIs are deprecated from iOS 17 in favor
   of AVAudioApplication, which does not exist before 17. The legacy pair
   lives in helpers whose availability annotations match the deprecation,
   which keeps the pre-17 branch of each call warning-free.
   */
  @available(iOS, introduced: 15.1, deprecated: 17.0)
  private func micPermissionLegacy() -> AVAudioSession.RecordPermission {
    AVAudioSession.sharedInstance().recordPermission
  }

  @available(iOS, introduced: 15.1, deprecated: 17.0)
  private func requestMicPermissionLegacy(_ completion: @escaping (Bool) -> Void) {
    AVAudioSession.sharedInstance().requestRecordPermission(completion)
  }

  private func micPermission() -> AVAudioSession.RecordPermission {
    if #available(iOS 17.0, *) {
      switch AVAudioApplication.shared.recordPermission {
      case .granted: return .granted
      case .denied: return .denied
      case .undetermined: return .undetermined
      @unknown default: return .undetermined
      }
    }
    return micPermissionLegacy()
  }

  private func requestMicPermission(_ completion: @escaping (Bool) -> Void) {
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission { granted in
        completion(granted)
      }
    } else {
      requestMicPermissionLegacy(completion)
    }
  }
  @objc(startCapture:resolver:rejecter:)
  func startCapture(
    _ sampleRate: Double,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async { [self] in
      guard sampleRate > 0 else {
        reject("E_CAPTURE", "OmpctlVoice requires a positive sample rate, got \(sampleRate)", nil)
        return
      }
      // A start must be legal immediately after a stop or a cancel, so a
      // capture still running from an abandoned start is torn down before
      // this one begins rather than leaking a second tap.
      stopEngineInput()
      switch micPermission() {
      case .granted:
        beginCapture(sampleRate, resolve, reject)
      case .undetermined:
        // Requested at the point of use, not at launch: the first press of
        // the microphone is what makes the question real to the operator.
        // Denial is rejected by name so the JS seam can say why instead of
        // recording silence.
        requestMicPermission { [weak self] granted in
          DispatchQueue.main.async {
            guard let self else { return }
            if granted {
              self.beginCapture(sampleRate, resolve, reject)
            } else {
              reject("E_PERMISSION_DENIED", "Microphone access was denied for ompctl; enable it in iOS Settings", nil)
            }
          }
        }
      case .denied:
        reject("E_PERMISSION_DENIED", "Microphone access is denied for ompctl; enable it in iOS Settings", nil)
      @unknown default:
        reject("E_PERMISSION_DENIED", "iOS reported an unknown microphone permission state", nil)
      }
    }
  }

  private func beginCapture(
    _ sampleRate: Double,
    _ resolve: @escaping RCTPromiseResolveBlock,
    _ reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      // The session must be record-capable before the input node is asked
      // for its format, or the format query fails on real hardware.
      try activateSession()
      let input = engine.inputNode
      let inputFormat = input.outputFormat(forBus: 0)
      guard let target = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: sampleRate,
        channels: 1,
        interleaved: true
      ) else {
        reject("E_CAPTURE", "OmpctlVoice could not describe the \(Int(sampleRate)) Hz PCM16 capture format", nil)
        return
      }
      wireRate = sampleRate
      converter = AVAudioConverter(from: inputFormat, to: target)
      captureFormat = target
      // 4096 frames at a 48 kHz hardware rate is about 85 ms of audio, which
      // resamples to roughly 1360 wire samples: a turn streams chunk by chunk
      // instead of arriving in one lump at the end.
      input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
        self?.handleTap(buffer, from: inputFormat)
      }
      do {
        try engine.start()
      } catch {
        engine.inputNode.removeTap(onBus: 0)
        converter = nil
        captureFormat = nil
        throw error
      }
      capturing = true
      resolve(nil)
    } catch {
      reject("E_CAPTURE", "OmpctlVoice could not start capture: \(error.localizedDescription)", error)
    }
  }

  private func handleTap(_ buffer: AVAudioPCMBuffer, from sourceFormat: AVAudioFormat) {
    guard let converter, let target = captureFormat, buffer.frameLength > 0 else { return }
    let ratio = target.sampleRate / sourceFormat.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
    var fed = false
    var conversionError: NSError?
    let status = converter.convert(to: out, error: &conversionError) { _, outStatus in
      if fed {
        outStatus.pointee = .noDataNow
        return nil
      }
      fed = true
      outStatus.pointee = .haveData
      return buffer
    }
    guard conversionError == nil, status != .error, out.frameLength > 0 else { return }
    let byteCount = Int(out.frameLength) * 2
    var chunk = Data(count: byteCount)
    if let source = out.audioBufferList.pointee.mBuffers.mData, byteCount > 0 {
      chunk.withUnsafeMutableBytes { destination in
        _ = memcpy(destination.baseAddress, source, byteCount)
      }
    }
    let pcm = chunk.base64EncodedString()
    emitQueue.async { [self] in
      emitChunk(pcm)
    }
  }

  private func emitChunk(_ pcm: String) {
    // Nil only before the decorator attaches or after teardown, and in both
    // cases there is no JS left to hear a chunk.
    guard let modules = callableJSModules else { return }
    modules.invokeModule("RCTDeviceEventEmitter", method: "emit", withArgs: ["voice_chunk", ["pcm": pcm]])
  }

  private func stopEngineInput() {
    // Removing the tap ends capture callbacks; the engine keeps running only
    // while the player needs it, so the microphone is released the moment
    // nothing is listening and speech playback is not cut off mid-word.
    engine.inputNode.removeTap(onBus: 0)
    converter = nil
    captureFormat = nil
    capturing = false
    if !player.isPlaying {
      engine.stop()
    }
  }

  @objc(stopCapture:rejecter:)
  func stopCapture(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async { [self] in
      if capturing {
        stopEngineInput()
      }
      // The resolve rides the same serial queue as the chunk emissions, so it
      // reaches JS after the final chunk rather than beside it. A stop with
      // no open utterance still resolves: the seam's cancel calls this
      // unconditionally, and a microphone already free is released.
      emitQueue.async {
        resolve(nil)
      }
    }
  }

  private func attachPlayerIfNeeded() -> AVAudioFormat? {
    guard !playerAttached else { return playFormat }
    // The connection fixes the node format once and the engine converts to
    // the hardware rate, so every chunk schedules in the wire format the
    // daemon synthesized.
    guard let format = AVAudioFormat(
      commonFormat: .pcmFormatInt16,
      sampleRate: wireRate,
      channels: 1,
      interleaved: true
    ) else { return nil }
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: format)
    playFormat = format
    playerAttached = true
    return format
  }

  @objc(playPcm:resolver:rejecter:)
  func playPcm(
    _ base64: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async { [self] in
      guard let data = Data(base64Encoded: base64), !data.isEmpty else {
        reject("E_PLAYBACK", "OmpctlVoice could not decode the audio chunk as base64 PCM16", nil)
        return
      }
      guard data.count % 2 == 0 else {
        reject("E_PLAYBACK", "OmpctlVoice received \(data.count) bytes, not a whole number of PCM16 samples", nil)
        return
      }
      do {
        try activateSession()
        guard let format = attachPlayerIfNeeded() else {
          reject("E_PLAYBACK", "OmpctlVoice could not describe the playback format", nil)
          return
        }
        let frames = AVAudioFrameCount(data.count / 2)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else {
          reject("E_PLAYBACK", "OmpctlVoice could not allocate a playback buffer", nil)
          return
        }
        buffer.frameLength = frames
        data.withUnsafeBytes { raw in
          _ = memcpy(buffer.audioBufferList.pointee.mBuffers.mData!, raw.baseAddress!, data.count)
        }
        if !engine.isRunning {
          try engine.start()
        }
        if !player.isPlaying {
          player.play()
        }
        // Resolving on playback completion, not on schedule, is what lets the
        // JS seam keep the daemon's ordered speech segments ordered on the
        // speaker: the next chunk is only handed over once this one is heard.
        let ticket = PlayTicket(resolve)
        pendingPlays.append(ticket)
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
          DispatchQueue.main.async {
            self?.finishTicket(ticket)
          }
        }
      } catch {
        reject("E_PLAYBACK", "OmpctlVoice could not play the audio chunk: \(error.localizedDescription)", error)
      }
    }
  }

  private func finishTicket(_ ticket: PlayTicket) {
    pendingPlays.removeAll { $0 === ticket }
    ticket.finish()
  }

  @objc(stopPlayback:rejecter:)
  func stopPlayback(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async { [self] in
      // stop() halts audio at the audible position and clears everything
      // scheduled behind it: the operator asked for silence now, not after
      // the backlog.
      player.stop()
      // A halted chunk counts as finished, so a stop does not leave the
      // seam's awaited playPcm promises hanging.
      let halted = pendingPlays
      pendingPlays.removeAll()
      for ticket in halted {
        ticket.finish()
      }
      resolve(nil)
    }
  }

  /**
   The JS seam calls addListener(eventName, callback) with two arguments, so
   the native signature accepts two; a one-argument declaration would make
   the bridgeless interop layer fail the call on its second argument. The
   callback is deliberately neither retained nor invoked: the interop layer
   converts a JS function argument into a single-shot block (see
   convertJSIFunctionToCallback in RCTTurboModule.mm, which aborts the
   process on a second invocation), so it cannot carry a chunk stream.
   Chunks are emitted as voice_chunk device events instead, which is the one
   event surface that streams.
   */
  @objc(addListener:callback:)
  func addListener(_: String, callback _: @escaping RCTResponseSenderBlock) {}

  /** Companion to addListener for the NativeEventEmitter convention; no native listener resources exist to track. */
  @objc(removeListeners:)
  func removeListeners(_: Double) {}

  func invalidate() {
    DispatchQueue.main.async { [self] in
      stopEngineInput()
      player.stop()
      let halted = pendingPlays
      pendingPlays.removeAll()
      for ticket in halted {
        ticket.finish()
      }
      engine.reset()
      // The session is deactivated only on full teardown: stopping capture
      // releases the microphone by stopping the engine's input, and
      // deactivating any sooner would cut off narration playback that shares
      // the session.
      try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
  }
}
