import type { DeepLinkSource } from "./deeplink.ts";

let initialUrlRead = false;

export function resetInitialUrlReadForTesting(): void {
  initialUrlRead = false;
}

/**
 * Web implementation of DeepLinkSource.
 *
 * Reads window.location.href once on cold start, strips query and hash from the
 * address bar via history.replaceState so sensitive tokens do not linger, and
 * returns null on subsequent calls. Browser tabs do not receive native 'url'
 * events, so addEventListener is a clean no-op.
 */
export const nativeDeepLinks: DeepLinkSource = {
  async getInitialURL(): Promise<string | null> {
    if (initialUrlRead) return null;
    initialUrlRead = true;

    if (typeof window === "undefined" || !window.location?.href) {
      return null;
    }

    const currentUrl = window.location.href;
    if (typeof window.history?.replaceState === "function") {
      window.history.replaceState(null, "", window.location.pathname);
    }
    return currentUrl;
  },
  addEventListener(): { remove(): void } {
    return {
      remove(): void {
        // No-op on web: browsers do not deliver native deep link events to a tab.
      },
    };
  },
};
