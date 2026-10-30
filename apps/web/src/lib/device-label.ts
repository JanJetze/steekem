/**
 * Short device hint derived from a user-agent string, e.g. "iPhone · Safari".
 * The receiver reports this to the sender so the sender can tell who has
 * the share link open. It is self-reported and trivially spoofable, so it is
 * informational only and never used for any decision.
 */

export const MAX_DEVICE_LABEL_LENGTH = 60;

export function deviceLabel(ua: string): string {
  // Automated URL scanners (email and chat security tools) commonly run
  // headless Chromium and leave this marker in the UA.
  if (/Headless/i.test(ua)) return "Headless browser (likely a link scanner)";

  const os = /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Macintosh|Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "Unknown device";

  // Order matters: Edge, Opera and Samsung Internet all also claim Chrome,
  // and every Chromium/iOS browser also claims Safari.
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? "Edge"
    : /SamsungBrowser\//.test(ua) ? "Samsung Internet"
    : /OPR\/|OPiOS\//.test(ua) ? "Opera"
    : /Firefox\/|FxiOS\//.test(ua) ? "Firefox"
    : /Chrome\/|CriOS\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "browser";

  return `${os} · ${browser}`;
}

/** Normalizes a device label received over the wire from the peer. */
export function sanitizeDeviceLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, MAX_DEVICE_LABEL_LENGTH);
  return trimmed || null;
}
