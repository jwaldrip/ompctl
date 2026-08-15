/**
 * Voice: carrying OMP's local speech stack over the network.
 *
 * Nothing here synthesises or recognises anything. OMP already runs Parakeet
 * TDT v3 and Kokoro-82M on device, and since the control plane lives inside the
 * fork it calls those libraries directly. The daemon's job is to make them
 * reachable from a phone, and to fail loudly when the machine has neither.
 */

export {
  VoiceBridge,
  type VoiceBridgeOptions,
  VoiceBufferOverflowError,
  WIRE_SAMPLE_RATE,
} from "./bridge.ts";
export {
  BunCommandRunner,
  type CommandResult,
  type CommandRunner,
  CommandTimeoutError,
  type EngineAvailability,
  withScratchDir,
} from "./exec.ts";
export {
  loadSpeechRuntime,
  resetSpeechRuntime,
  type SpeechRuntime,
  type TtsAudioChunk,
  type TtsStream,
} from "./speech-runtime.ts";
export {
  ASR_SAMPLE_RATE,
  EmptyTranscriptError,
  NullSttEngine,
  OmpSttEngine,
  type OmpSttOptions,
  STT_ENGINE_ORDER,
  type SttEngine,
  type SttSelectionOptions,
  type SttTranscriber,
  SttUnavailableError,
  selectSttEngine,
} from "./stt.ts";
export {
  NullTtsEngine,
  OmpTtsEngine,
  type OmpTtsOptions,
  SayTtsEngine,
  type SayTtsOptions,
  selectTtsEngine,
  speakableSegments,
  TTS_ENGINE_ORDER,
  type TtsEngine,
  type TtsSelectionOptions,
  type TtsSynthesizer,
  TtsUnavailableError,
} from "./tts.ts";
export {
  chunkFrames,
  detectUtteranceEnd,
  detectUtteranceEndFromEnergies,
  frameEnergy,
  type ResolvedVadOptions,
  resolveVadOptions,
  VAD_DEFAULTS,
  type VadOptions,
} from "./vad.ts";
export {
  base64ToPcm,
  decodeWav,
  encodeWav,
  float32ToPcm,
  type PcmAudio,
  pcmToBase64,
  pcmToFloat32,
  resampleFloat32,
  resamplePcm,
  WavFormatError,
} from "./wav.ts";
