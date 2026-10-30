/**
 * The receive URL's fragment: `code[.secret][.p]`.
 *
 * - `code` is the 6-character room code, the only part the signaling worker
 *   ever learns (it is the WebSocket path).
 * - `secret` is the link secret both ends derive the channel key from. It
 *   stays in the fragment, which browsers never send to a server. A typed
 *   code has no secret, so a hash without one is valid too.
 * - `p` tells the receive page to ask for the PIN up front. It is a UI hint
 *   only; the sender enforces the PIN regardless.
 */

import { LINK_SECRET_PATTERN } from "@steekem/webrtc-core";

export const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no i/l/o/0/1
export const CODE_LENGTH = 6;

export function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const c of code) if (!CODE_ALPHABET.includes(c)) return false;
  return true;
}

export interface ReceiveHash {
  code: string | null;
  secret: string | null;
  pinHint: boolean;
}

export function buildReceiveHash(code: string, secret: string | null, pin: boolean): string {
  let hash = code;
  if (secret) hash += `.${secret}`;
  if (pin) hash += ".p";
  return hash;
}

export function parseReceiveHash(rawHash: string): ReceiveHash {
  const hash = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  const parts = hash.split(".");
  const code = (parts[0] ?? "").toLowerCase();
  let secret: string | null = null;
  let pinHint = false;
  for (const part of parts.slice(1)) {
    if (part.toLowerCase() === "p") pinHint = true;
    else if (LINK_SECRET_PATTERN.test(part)) secret = part;
  }
  return { code: isValidCode(code) ? code : null, secret, pinHint };
}
