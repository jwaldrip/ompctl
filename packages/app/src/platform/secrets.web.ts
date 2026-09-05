/**
 * Storage for scoped bearer tokens on the web portal build.
 *
 * Persists tokens to localStorage under the exact same keys the native keystore
 * uses (such as "ompd.connection.token.<id>" and "ompd.connection.token").
 *
 * XSS Tradeoff:
 * A browser tab has no hardware-backed keychain, secure enclave, or protected
 * storage. localStorage is unencrypted text accessible to any JavaScript that
 * executes on this origin. If an attacker achieves cross-site scripting (XSS)
 * on this domain, they could read stored daemon bearer tokens. This is an
 * explicit security tradeoff accepted for the web portal: the alternative is
 * losing the credential on every page reload, navigation, or tab refresh, which
 * destroys portal usability and breaks long-lived pairing.
 *
 * On native platforms, secure storage is handled by react-native-keychain
 * in secrets.ts; no fallback is added there.
 */

const fallback = new Map<string, string>();

function getStorage(): Storage | null {
  try {
    if (typeof globalThis !== "undefined" && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // Storage access can be denied by browser privacy or iframe sandbox settings.
  }
  return null;
}

/**
 * True on web now that secrets persist to localStorage across launches and reloads.
 * Matches native keystore persistence semantics.
 */
export const SECRETS_PERSIST_ACROSS_LAUNCHES = true;

export async function readSecret(key: string): Promise<string | null> {
  const storage = getStorage();
  if (storage) {
    return storage.getItem(key);
  }
  return fallback.get(key) ?? null;
}

export async function writeSecret(key: string, value: string): Promise<void> {
  const storage = getStorage();
  if (storage) {
    storage.setItem(key, value);
    return;
  }
  fallback.set(key, value);
}

export async function deleteSecret(key: string): Promise<void> {
  const storage = getStorage();
  if (storage) {
    storage.removeItem(key);
    return;
  }
  fallback.delete(key);
}
