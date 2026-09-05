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
 * There is no memory fallback: if localStorage is disabled by browser privacy
 * settings, quota is exceeded, or storage access throws, writeSecret rejects
 * with a named error so the pairing screen surfaces the refusal rather than
 * establishing a pairing that silently evaporates on the next refresh.
 *
 * On native platforms, secure storage is handled by react-native-keychain
 * in secrets.ts; no fallback is added there.
 */

function requireStorage(): Storage {
  try {
    if (typeof globalThis !== "undefined" && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch (cause) {
    throw new Error(`localStorage is not accessible: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  throw new Error("localStorage is not available in this environment");
}

/**
 * True on web: secrets persist to localStorage across launches and reloads.
 * Matches native keystore persistence semantics.
 */
export const SECRETS_PERSIST_ACROSS_LAUNCHES = true;

export async function readSecret(key: string): Promise<string | null> {
  try {
    const storage = requireStorage();
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export async function writeSecret(key: string, value: string): Promise<void> {
  let storage: Storage;
  try {
    storage = requireStorage();
  } catch (cause) {
    throw new Error(
      `storage refused to store secret for "${key}": ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  try {
    storage.setItem(key, value);
  } catch (cause) {
    throw new Error(
      `localStorage write failed for "${key}": ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

export async function deleteSecret(key: string): Promise<void> {
  try {
    const storage = requireStorage();
    storage.removeItem(key);
  } catch {
    // Deleting when storage is absent or throws is a safe no-op.
  }
}
