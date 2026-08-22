package ai.ompctl.app.narration

import android.os.Bundle
import android.speech.tts.TextToSpeech
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Device side of the narration seam declared in packages/app/src/voice/narration.ts
 * (`NativeModules.OmpctlNarration`). Speech is android.speech.tts.TextToSpeech,
 * a platform engine, so no dependency is added.
 *
 * Engine initialization is asynchronous: the TextToSpeech constructor calls
 * back onInit later, and that callback can arrive after the first speak(). A
 * speak accepted before the engine is ready is held and only enqueued (and its
 * promise only resolved) once init succeeded. If init failed, held speaks are
 * rejected. A promise therefore never resolves while the device is saying
 * nothing. All state is guarded by [lock] because module methods arrive on the
 * RN bridge queue while onInit arrives on the main thread.
 */
class OmpctlNarrationModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  private class PendingSpeak(val text: String, val promise: Promise)

  private val lock = Any()
  private var engine: TextToSpeech? = null
  private var engineReady = false
  private var engineFailed = false
  private val pendingSpeaks = ArrayDeque<PendingSpeak>()
  private val pendingStops = ArrayList<Promise>()
  private var utteranceCounter = 0L

  @ReactMethod
  fun speak(text: String, promise: Promise) {
    synchronized(lock) {
      if (engineFailed) {
        promise.reject(ERROR_INIT, "TextToSpeech engine failed to initialize")
        return
      }
      if (engineReady) {
        enqueueLocked(text, promise)
        return
      }
      if (engine == null) startEngineLocked()
      // Init still in flight: hold the utterance rather than resolving a speak
      // that has not been handed to the engine yet.
      pendingSpeaks.addLast(PendingSpeak(text, promise))
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    synchronized(lock) {
      // Speaks held for an engine that never came up can no longer be spoken;
      // reject them instead of letting them resolve silent.
      while (pendingSpeaks.isNotEmpty()) {
        pendingSpeaks
            .removeFirst()
            .promise
            .reject(ERROR_CANCELLED, "Narration stopped before the speech engine finished initializing")
      }
      val current = engine
      when {
        engineFailed || current == null -> promise.resolve(null)
        engineReady -> {
          // Halts the utterance in progress and flushes the engine queue
          // behind it, matching the immediate stop on iOS.
          current.stop()
          promise.resolve(null)
        }
        else -> pendingStops.add(promise)
      }
    }
  }

  /**
   * Resolves on enqueue, not on completion: the JS narrator chains segments and
   * the engine queues utterances itself, so this mirrors iOS and lets stop()
   * flush a backlog the narrator has already handed over.
   */
  private fun enqueueLocked(text: String, promise: Promise) {
    val current = engine
    if (current == null) {
      // Unreachable while engineReady is true; reject rather than pretend.
      promise.reject(ERROR_ENQUEUE, "TextToSpeech engine is not available")
      return
    }
    utteranceCounter += 1
    val result = current.speak(text, TextToSpeech.QUEUE_ADD, Bundle(), "ompctl-narration-$utteranceCounter")
    if (result == TextToSpeech.SUCCESS) {
      promise.resolve(null)
    } else {
      promise.reject(ERROR_ENQUEUE, "TextToSpeech.speak failed with status $result")
    }
  }

  private fun startEngineLocked() {
    engine = TextToSpeech(reactApplicationContext) { status ->
      synchronized(lock) {
        val current = engine
        if (status == TextToSpeech.SUCCESS && current != null) {
          engineReady = true
          // Flush the speaks held while init was in flight, oldest first.
          while (pendingSpeaks.isNotEmpty()) {
            val held = pendingSpeaks.removeFirst()
            enqueueLocked(held.text, held.promise)
          }
          // A stop that raced init: nothing was handed to the engine yet, so
          // there is nothing to halt; acknowledge the stop now.
          for (stop in pendingStops) stop.resolve(null)
          pendingStops.clear()
        } else {
          engineFailed = true
          engineReady = false
          for (held in pendingSpeaks) {
            held.promise.reject(ERROR_INIT, "TextToSpeech engine failed to initialize")
          }
          pendingSpeaks.clear()
          for (stop in pendingStops) stop.resolve(null)
          pendingStops.clear()
          // The instance never became usable; release it rather than leaking a
          // service connection.
          current?.shutdown()
          engine = null
        }
      }
    }
  }

  /** RN calls this before destroying the instance; release the engine. */
  override fun invalidate() {
    synchronized(lock) {
      for (held in pendingSpeaks) {
        held.promise.reject(ERROR_CANCELLED, "Narration torn down before the speech engine finished initializing")
      }
      pendingSpeaks.clear()
      for (stop in pendingStops) stop.resolve(null)
      pendingStops.clear()
      engine?.shutdown()
      engine = null
      engineReady = false
    }
  }

  companion object {
    const val NAME = "OmpctlNarration"
    private const val ERROR_INIT = "E_TTS_INIT"
    private const val ERROR_CANCELLED = "E_TTS_CANCELLED"
    private const val ERROR_ENQUEUE = "E_TTS_ENQUEUE"
  }
}
