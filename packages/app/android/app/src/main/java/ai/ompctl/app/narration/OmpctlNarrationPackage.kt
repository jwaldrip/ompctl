package ai.ompctl.app.narration

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Exposes [OmpctlNarrationModule] to JS under the exact name the narration seam
 * resolves: NativeModules.OmpctlNarration. Registered by hand in
 * MainApplication because this is app-owned code with nothing to autolink.
 */
class OmpctlNarrationPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
      listOf(OmpctlNarrationModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
      emptyList()
}
