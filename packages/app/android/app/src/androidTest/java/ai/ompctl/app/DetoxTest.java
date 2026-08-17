package ai.ompctl.app;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.LargeTest;
import androidx.test.rule.ActivityTestRule;

import com.wix.detox.Detox;
import com.wix.detox.config.DetoxConfig;

import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Detox's entry point on Android.
 *
 * This class runs no assertions of its own. It hands the instrumentation thread
 * to Detox, which then drives the app from the Cucumber suite in
 * `packages/e2e` over its own socket. The scenarios live in `.feature` files, not
 * here, so the same specifications also run on web through the Playwright client.
 *
 * It is NOT part of `connectedDebugAndroidTest`'s default run. That task executes
 * every class in this source set, and this one blocks waiting for a Detox server
 * that only exists when `detox test` started it, so an unfiltered run would hang
 * and then fail. `scripts/android-instrumentation-test.sh` therefore names its
 * own class explicitly, and Detox names this one.
 */
@RunWith(AndroidJUnit4.class)
@LargeTest
public class DetoxTest {

  @Rule
  public ActivityTestRule<MainActivity> mActivityRule = new ActivityTestRule<>(MainActivity.class, false, false);

  @Test
  public void runDetoxTests() {
    DetoxConfig config = new DetoxConfig();
    // Idle-resource sync waits for the app to go quiet before each action. The
    // app holds a live websocket to the daemon, which never goes idle, so the
    // default would time out on a healthy app rather than on a broken one.
    config.idlePolicyConfig.masterTimeoutSec = 90;
    config.idlePolicyConfig.idleResourceTimeoutSec = 30;
    config.rnContextLoadTimeoutSec = 180;

    Detox.runTests(mActivityRule, config);
  }
}
