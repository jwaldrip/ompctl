/**
 * The web build's answer to `copyText`: the platform's own async clipboard,
 * with no native module involved. Resolved the same way `secrets.web.ts` is,
 * per `vite.config.ts`'s `resolve.extensions`, so a caller importing
 * `./clipboard` never asks which platform it is running on.
 */

export function copyText(value: string): void {
  // Fire and forget, matching the native seam's shape: a copy is offered, not
  // awaited, and a browser that refuses (permissions, non-secure context)
  // leaves the value on screen where the operator can still select it.
  void navigator.clipboard?.writeText(value);
}
