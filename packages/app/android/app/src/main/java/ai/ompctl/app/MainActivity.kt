package ai.ompctl.app

import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.swmansion.rnscreens.fragment.restoration.RNScreensFragmentFactory

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   *
   * `public` rather than the framework's default `protected`: widening a Kotlin override's
   * visibility is legal, and it is what lets `PackageIdentityTest` call the real method instead
   * of asserting a literal against itself.
   */
  public override fun getMainComponentName(): String = "ompctl"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * react-native-screens' own Android requirement, not a choice: the native
   * stack presents each route as a fragment, and Android does not persist that
   * view state consistently across an Activity restart. Without this factory a
   * restart (rotation, a process the system reclaimed and brought back) restores
   * fragments the library did not create, which crashes rather than degrading.
   * Its README is explicit that the override belongs on the Activity itself and
   * not on the delegate.
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    supportFragmentManager.fragmentFactory = RNScreensFragmentFactory()
    super.onCreate(savedInstanceState)
  }
}
