/**
 * Sender-tab ownership via sessionStorage.
 *
 * sessionStorage is *per-tab*, so the token written by the tab that starts
 * a session does NOT carry to a duplicate tab opened from the share URL.
 * This lets us cleanly distinguish "the original sender's tab" from any
 * other tab that visits the same /send#code URL.
 *
 * Refresh of the original tab keeps the token (sessionStorage survives
 * page reload). New-tab opens of the same URL get nothing → we render a
 * "this session is in another tab" message instead of trying to recover.
 *
 * The link secret lives here too, for the same reason: after a refresh the
 * owner tab still has to talk to receivers who hold the original link, and
 * only this tab may ever know the secret.
 */

const PREFIX = "steekem-owner-";
const SECRET_PREFIX = "steekem-secret-";

export function claimOwnership(code: string, linkSecret: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(PREFIX + code, "1");
    sessionStorage.setItem(SECRET_PREFIX + code, linkSecret);
  } catch {}
}

export function isOwner(code: string): boolean {
  if (typeof sessionStorage === "undefined") return false;
  try { return sessionStorage.getItem(PREFIX + code) === "1"; }
  catch { return false; }
}

export function ownerSecret(code: string): string | null {
  if (typeof sessionStorage === "undefined") return null;
  try { return sessionStorage.getItem(SECRET_PREFIX + code); }
  catch { return null; }
}

export function releaseOwnership(code: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(PREFIX + code);
    sessionStorage.removeItem(SECRET_PREFIX + code);
  } catch {}
}
