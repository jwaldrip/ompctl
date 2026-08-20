/**
 * Whether the pairing token field renders unmasked for an automated run.
 *
 * False everywhere except the iOS simulator harness, which has its own module
 * beside this one. A masked field makes iOS 26 offer to save the value, and
 * that sheet belongs to the system rather than the app: Detox cannot dismiss
 * it, so an otherwise unattended run would stop for a person to tap it.
 *
 * This is the default because Android's Detox run never raises that sheet, and
 * react-native-web has no NSUserDefaults to read at all.
 */
export const E2E_PLAINTEXT_TOKEN = false;
