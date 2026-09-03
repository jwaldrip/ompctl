package ai.ompctl.app.voice

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener

/**
 * Device side of the memo voice seam declared in packages/app/src/voice/memo.ts
 * (`NativeModules.OmpctlVoice`). Capture is android.media.AudioRecord and
 * playback is android.media.AudioTrack, both platform classes, so no
 * dependency is added.
 *
 * All mutable state is guarded by [lock]: module methods arrive on the RN
 * bridge queue, the permission result arrives on the main thread, the capture
 * reader loop runs on its own thread, and AudioTrack position callbacks arrive
 * on a binder thread. Ordering is part of the contract, not an implementation
 * detail: chunk events cross into JS from the capture thread, and stopCapture
 * joins that thread before resolving, so a caller can send audio_end after the
 * last audio frame, not beside it.
 */
class OmpctlVoiceModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), PermissionListener {

  override fun getName(): String = NAME

  /** A startCapture promise waiting on the runtime permission dialog, with the rate it was handed. */
  private class PendingStart(val rate: Int, val promise: Promise)

  private val lock = Any()
  private var pendingStart: PendingStart? = null
  private var record: AudioRecord? = null
  private var captureThread: Thread? = null
  private var capturing = false
  private var captureRate = 0

  private var track: AudioTrack? = null
  private var trackRate = 0
  private var framesWritten = 0

  /** Marker positions of chunks still owed a playPcm resolve, ascending. */
  private val pendingPlays = ArrayDeque<PlayChunk>()

  private class PlayChunk(val marker: Int, val promise: Promise)

  /**
   * The wire rate every chunk plays at when no capture has fixed it. Mirrors
   * WIRE_SAMPLE_RATE in packages/daemon/src/voice/bridge.ts, the authority
   * for the wire contract.
   */
  private fun effectiveRate(): Int = if (captureRate > 0) captureRate else WIRE_RATE_FALLBACK

  @ReactMethod
  fun startCapture(sampleRate: Double, promise: Promise) {
    if (sampleRate <= 0.0 || sampleRate > MAX_RATE) {
      promise.reject(ERROR_CAPTURE, "OmpctlVoice requires a positive sample rate, got $sampleRate")
      return
    }
    val rate = sampleRate.toInt()
    if (granted()) {
      beginCapture(rate, promise)
      return
    }
    // Requested at the point of use, not at launch: the first press of the
    // microphone is what makes the question real to the operator. There is no
    // way to ask from a backgrounded app, so that case is rejected by name
    // rather than holding the promise forever.
    val activity = reactApplicationContext.getCurrentActivity()
    if (activity !is PermissionAwareActivity) {
      promise.reject(
          ERROR_NO_ACTIVITY,
          "OmpctlVoice cannot ask for microphone permission while no activity is in the foreground")
      return
    }
    synchronized(lock) {
      // One dialog at a time; a second start while the first is unanswered
      // supersedes it, because only one capture can follow.
      pendingStart?.promise?.reject(
          ERROR_SUPERSEDED, "another startCapture superseded this one while permission was pending")
      pendingStart = PendingStart(rate, promise)
    }
    activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), PERMISSION_REQUEST, this)
  }

  private fun granted(): Boolean =
      reactApplicationContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
          PackageManager.PERMISSION_GRANTED

  /**
   * Called by the host activity with the dialog's result. True tells the
   * activity this listener has consumed the request and can be dropped.
   */
  override fun onRequestPermissionsResult(
      requestCode: Int,
      permissions: Array<String>,
      grantResults: IntArray
  ): Boolean {
    if (requestCode != PERMISSION_REQUEST) return false
    val pending =
        synchronized(lock) {
          val held = pendingStart
          pendingStart = null
          held
        }
    if (pending == null) return true
    if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
      beginCapture(pending.rate, pending.promise)
    } else {
      // Denied is rejected by name so the JS seam can say why instead of
      // recording silence.
      pending.promise.reject(
          ERROR_PERMISSION,
          "Microphone access was denied for ompctl; enable it in the app's Permissions settings")
    }
    return true
  }

  private fun beginCapture(rate: Int, promise: Promise) {
    synchronized(lock) {
      // A start must be legal immediately after a stop or a cancel, so a
      // capture still running from an abandoned start is torn down before
      // this one begins rather than leaking a second recorder.
      stopCaptureLocked()
      val minBuffer =
          AudioRecord.getMinBufferSize(
              rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      if (minBuffer <= 0) {
        promise.reject(ERROR_CAPTURE, "OmpctlVoice could not size a $rate Hz input buffer")
        return
      }
      val recorder =
          AudioRecord(
              MediaRecorder.AudioSource.MIC,
              rate,
              AudioFormat.CHANNEL_IN_MONO,
              AudioFormat.ENCODING_PCM_16BIT,
              maxOf(minBuffer * 2, READ_BYTES * 2))
      if (recorder.state != AudioRecord.STATE_INITIALIZED) {
        recorder.release()
        promise.reject(ERROR_CAPTURE, "OmpctlVoice could not initialize the microphone")
        return
      }
      recorder.startRecording()
      record = recorder
      capturing = true
      captureRate = rate
      val reader =
          Thread {
            val buffer = ByteArray(READ_BYTES)
            while (true) {
              val current: AudioRecord?
              synchronized(lock) {
                if (!capturing) return@Thread
                current = record
              }
              if (current == null) break
              // READ_BYTES is 2048 bytes, 1024 samples, 64 ms of wire audio:
              // a turn streams chunk by chunk instead of arriving in one lump
              // at the end.
              val read = current.read(buffer, 0, READ_BYTES)
              if (read > 0) {
                emitChunk(Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP))
              } else if (read < 0) {
                break
              }
            }
            // The recorder is released on the reader thread after the final
            // emit returns, so stopCapture's join below guarantees the mic is
            // free and every chunk has crossed into JS before it resolves.
            synchronized(lock) {
              if (record === recorder) {
                record = null
              }
            }
            try {
              recorder.stop()
            } catch (_: IllegalStateException) {
              // Already stopped or never started; release below is the part
              // that matters.
            }
            recorder.release()
          }
      reader.name = "ompctl-voice-capture"
      reader.start()
      captureThread = reader
      promise.resolve(null)
    }
  }

  private fun emitChunk(pcm: String) {
    val payload: WritableMap = Arguments.createMap()
    payload.putString("pcm", pcm)
    reactApplicationContext.emitDeviceEvent(VOICE_CHUNK_EVENT, payload)
  }

  /** Requires [lock]. Stops the reader, releases the recorder, and forgets the thread. */
  private fun stopCaptureLocked() {
    capturing = false
    val reader = captureThread
    captureThread = null
    val recorder = record
    record = null
    if (reader != null) {
      // Holding the lock across join: the reader takes the lock only for
      // short flag reads, never for I/O, so this cannot deadlock.
      try {
        reader.join(JOIN_TIMEOUT_MS)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    } else if (recorder != null) {
      // No thread to release it: do it here so the microphone is never held.
      try {
        recorder.stop()
      } catch (_: IllegalStateException) {}
      recorder.release()
    }
  }

  @ReactMethod
  fun stopCapture(promise: Promise) {
    synchronized(lock) {
      // The join above is what makes the seam's ordering contract real: the
      // resolve happens only after the reader finished its final emit. A stop
      // with no open utterance still resolves, because the seam's cancel
      // calls this unconditionally and a microphone already free is released.
      stopCaptureLocked()
      promise.resolve(null)
    }
  }

  private fun ensureTrackLocked(rate: Int): AudioTrack? {
    if (track != null && trackRate == rate) return track
    track?.release()
    track = null
    val minBuffer =
        AudioTrack.getMinBufferSize(
            rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    if (minBuffer <= 0) return null
    val built =
        AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    // Speech, not music: the mixer groups it with narration
                    // rather than the media-volume ducking rules.
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build())
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(rate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build())
            .setBufferSizeInBytes(maxOf(minBuffer * 2, READ_BYTES * 2))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
    track = built
    trackRate = rate
    framesWritten = 0
    return built
  }

  @ReactMethod
  fun playPcm(base64: String, promise: Promise) {
    val bytes =
        try {
          Base64.decode(base64, Base64.NO_WRAP)
        } catch (_: IllegalArgumentException) {
          promise.reject(
              ERROR_PLAYBACK, "OmpctlVoice could not decode the audio chunk as base64 PCM16")
          return
        }
    if (bytes.isEmpty() || bytes.size % 2 != 0) {
      promise.reject(
          ERROR_PLAYBACK,
          "OmpctlVoice received ${bytes.size} bytes, not a whole number of PCM16 samples")
      return
    }
    synchronized(lock) {
      val rate = effectiveRate()
      val current = ensureTrackLocked(rate)
      if (current == null) {
        promise.reject(ERROR_PLAYBACK, "OmpctlVoice could not initialize playback at $rate Hz")
        return
      }
      if (current.playState != AudioTrack.PLAYSTATE_PLAYING) {
        current.play()
      }
      // The blocking write returns once the mixer has taken the bytes, not
      // when they are heard; the marker below is what marks heard.
      current.write(bytes, 0, bytes.size)
      framesWritten += bytes.size / 2
      // Resolving when playback reaches the end of this chunk, not when it is
      // queued, is what lets the JS seam keep the daemon's ordered speech
      // segments ordered on the speaker.
      current.setNotificationMarkerPosition(framesWritten)
      current.setPlaybackPositionUpdateListener(
          object : AudioTrack.OnPlaybackPositionUpdateListener {
            override fun onMarkerReached(playback: AudioTrack?) {
              resolveUpTo(framesWritten)
            }

            override fun onPeriodicNotification(playback: AudioTrack?) {}
          })
      pendingPlays.addLast(PlayChunk(framesWritten, promise))
    }
  }

  /** Resolves every chunk whose audio has fully played, from the marker callback. */
  private fun resolveUpTo(marker: Int) {
    synchronized(lock) {
      while (pendingPlays.isNotEmpty() && pendingPlays.first().marker <= marker) {
        pendingPlays.removeFirst().promise.resolve(null)
      }
    }
  }

  @ReactMethod
  fun stopPlayback(promise: Promise) {
    synchronized(lock) {
      val current = track
      if (current != null) {
        // Pause halts at the audible position; flush drops everything queued
        // behind it: the operator asked for silence now, not after the
        // backlog. A halted chunk counts as finished so the seam's awaited
        // playPcm promises do not hang.
        current.pause()
        current.flush()
        framesWritten = 0
      }
      while (pendingPlays.isNotEmpty()) {
        pendingPlays.removeFirst().promise.resolve(null)
      }
      promise.resolve(null)
    }
  }

  /**
   * The JS seam calls addListener(eventName, callback) with two arguments, so
   * the method accepts two; a one-argument declaration would fail the call on
   * its second argument. The callback is deliberately neither retained nor
   * invoked: a bridge Callback may only be invoked once (CallbackImpl throws
   * on the second call), so it cannot carry a chunk stream. Chunks are
   * emitted as voice_chunk device events instead, which is the one event
   * surface that streams.
   */
  @ReactMethod
  fun addListener(eventName: String, callback: Callback) {}

  /** Companion to addListener for the NativeEventEmitter convention; no native listener resources exist to track. */
  @ReactMethod
  fun removeListeners(count: Double) {}

  /** RN calls this before destroying the instance; release the recorder and the track. */
  override fun invalidate() {
    synchronized(lock) {
      pendingStart?.promise?.reject(
          ERROR_CANCELLED, "OmpctlVoice torn down before the microphone was granted")
      pendingStart = null
      stopCaptureLocked()
      track?.release()
      track = null
      while (pendingPlays.isNotEmpty()) {
        pendingPlays.removeFirst().promise.resolve(null)
      }
    }
    super.invalidate()
  }

  companion object {
    const val NAME = "OmpctlVoice"
    private const val VOICE_CHUNK_EVENT = "voice_chunk"
    private const val WIRE_RATE_FALLBACK = 16_000
    private const val MAX_RATE = 96_000
    private const val READ_BYTES = 2048
    private const val JOIN_TIMEOUT_MS = 2_000L
    private const val PERMISSION_REQUEST = 70_130
    private const val ERROR_CAPTURE = "E_CAPTURE"
    private const val ERROR_PLAYBACK = "E_PLAYBACK"
    private const val ERROR_PERMISSION = "E_PERMISSION_DENIED"
    private const val ERROR_NO_ACTIVITY = "E_NO_ACTIVITY"
    private const val ERROR_SUPERSEDED = "E_SUPERSEDED"
    private const val ERROR_CANCELLED = "E_CANCELLED"
  }
}
