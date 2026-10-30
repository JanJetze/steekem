/**
 * Sender-side memory of "what happened in this room" — keyed by the 6-char
 * code. The sender is the source of truth for transfer status; this layer
 * lets the sender survive a refresh and still tell any receiver who reopens
 * the link that the transfer is done / declined / aborted.
 *
 * Receivers don't read this. They learn the status over the DataChannel
 * via a `session-status` message from the sender.
 */

const PREFIX = "steekem-room-";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type SessionOutcome = "completed" | "declined" | "aborted";

export interface SessionMemory {
  outcome: SessionOutcome;
  file?: { name: string; size: number; mimeType?: string };
  /** Inline-data payloads (text, wifi, password, card). `summary` is a short
   *  human-readable hint for the ghost-mode receiver display, not the data
   *  itself — the data was wiped when the original tab closed. */
  data?: { kind: "text" | "wifi" | "password" | "card"; summary?: string };
  /** Self-reported device label of the receiver that accepted or declined. */
  device?: string;
  /** millis since epoch */
  at: number;
}

export function rememberSession(code: string, mem: Omit<SessionMemory, "at">): void {
  if (typeof localStorage === "undefined") return;
  try {
    const value: SessionMemory = { ...mem, at: Date.now() };
    localStorage.setItem(PREFIX + code, JSON.stringify(value));
  } catch { /* quota / private mode — ignore */ }
}

export function recallSession(code: string): SessionMemory | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(PREFIX + code);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionMemory;
    if (typeof parsed?.outcome !== "string" || typeof parsed?.at !== "number") return null;
    if (Date.now() - parsed.at > TTL_MS) {
      localStorage.removeItem(PREFIX + code);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function forgetSession(code: string): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.removeItem(PREFIX + code); } catch {}
}

/** Periodic cleanup helper (call from app init). Removes entries older than TTL. */
export function pruneOldSessions(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PREFIX)) continue;
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as SessionMemory;
        if (typeof parsed?.at !== "number" || now - parsed.at > TTL_MS) {
          localStorage.removeItem(key);
        }
      } catch {
        localStorage.removeItem(key);
      }
    }
  } catch {}
}
