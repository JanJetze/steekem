/**
 * Build a Wi-Fi-join QR payload string per the de-facto standard understood
 * by iOS Camera (16+) and Android (most OEMs since 10).
 *
 * Spec: https://en.wikipedia.org/wiki/QR_code#Joining_a_Wi-Fi_network
 *
 * Gotchas worth burning into memory:
 *  - Escape `\`, `;`, `,`, `:`, `"` inside SSID and password by prefixing
 *    each with `\`. Otherwise scanners hang or return garbage. Multiple
 *    historic bug reports across wifi-card, WiFiKeyShare, and Apple's own
 *    scanner; trust no one to be lenient.
 *  - End with TWO trailing semicolons, no newline.
 *  - For an open network use T:nopass and omit P:.
 *  - WPA2 / WPA3 are not literal T: values — both encode as T:WPA.
 *  - Hidden SSIDs ARE encodable (H:true) but iOS won't auto-join from QR;
 *    the receiver UI should still show the plaintext as a fallback.
 */
export type WifiSecurity = "WPA" | "WEP" | "none";

function escape(s: string): string {
  return s.replace(/[\\;,:"]/g, (c) => "\\" + c);
}

export function wifiQrPayload(input: {
  ssid: string;
  password: string;
  security: WifiSecurity;
  hidden: boolean;
}): string {
  const t = input.security === "none" ? "nopass" : input.security;
  const s = escape(input.ssid);
  const p = escape(input.password);
  let out = `WIFI:T:${t};S:${s};`;
  if (input.security !== "none") out += `P:${p};`;
  if (input.hidden) out += `H:true;`;
  out += `;`;
  return out;
}
