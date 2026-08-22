package ai.ompctl.app.voice

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Exposes [OmpctlVoiceModule] to JS under the exact name the memo voice seam
 * resolves: NativeModules.OmpctlVoice. Registered by hand in
 * MainApplication because this is app-owned code with nothing to autolink.
 */
class OmpctlVoicePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
      listOf(OmpctlVoiceModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
      emptyList()
}
