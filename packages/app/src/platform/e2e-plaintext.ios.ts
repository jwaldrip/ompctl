/**
 * The iOS half of the pairing-field masking decision.
 *
 * Detox passes `launchArgs` to a simulator as launch arguments, which iOS
 * registers in NSUserDefaults; `Settings` is how React Native reads those, and
 * it is the read that works under bridgeless, where `NativeModules` no longer
 * carries `SettingsManager`.
 *
 * The `__DEV__` guard is what keeps this out of anything shipped: a release
 * build cannot honour the argument even if someone passes it. Metro resolves
 * this file only for iOS, so react-native-web never imports `Settings`, which
 * it does not export.
 */

import { Settings } from "react-native";

const launched = Settings.get("OMPCTL_E2E_PLAINTEXT_TOKEN");

export const E2E_PLAINTEXT_TOKEN = __DEV__ && (launched === "YES" || launched === true || launched === 1);
