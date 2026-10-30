/**
 * Application-layer encryption on top of the DataChannel's DTLS.
 *
 * DTLS alone protects against everyone except whoever runs signaling: the
 * worker relays both SDP descriptions, so a hostile worker could swap in its
 * own certificate fingerprints and sit in the middle of the handshake. The
 * share link therefore carries a second secret in the URL fragment, which
 * browsers never send to any server. Both ends derive an AES-GCM key from it,
 * so the worker only ever sees ciphertext whatever it does to the handshake.
 *
 * A receiver who typed the room code has no link secret. That path keeps
 * DTLS only, and the humans compare a short word sequence derived from both
 * certificate fingerprints before the sender releases anything.
 */

const SECRET_BYTES = 16;
const IV_BYTES = 12;
const FRAME_VERSION = 1;
const KIND_TEXT = 0;
const KIND_BINARY = 1;
const HEADER_BYTES = 1 + IV_BYTES;
const TAG_BYTES = 16;

export type Direction = "sender" | "receiver";

/** 16 random bytes, base64url without padding. */
export const LINK_SECRET_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function generateLinkSecret(): string {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** The room code goes in as salt so a secret reused across rooms (it never
 *  is, but defensively) still yields distinct keys per room. */
export async function deriveKey(secret: string, roomCode: string): Promise<CryptoKey> {
  if (!LINK_SECRET_PATTERN.test(secret)) throw new Error("malformed link secret");
  const base = await crypto.subtle.importKey("raw", fromBase64Url(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8(roomCode), info: utf8("steekem-channel-v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Frame layout: version (1) | iv (12) | AES-GCM ciphertext of (kind (1) | data).
 *  The iv is direction byte + zero padding + 64-bit message counter, so the
 *  two directions can never collide on a nonce and the receiving side can
 *  insist on strictly sequential counters (the channel is ordered+reliable). */
export class Sealer {
  private counter = 0n;
  constructor(private readonly key: CryptoKey, private readonly direction: Direction) {}

  async seal(data: string | ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer> {
    const iv = buildIv(this.direction, this.counter);
    this.counter += 1n;
    const body = typeof data === "string" ? utf8(data) : toBytes(data);
    const plain = new Uint8Array(1 + body.byteLength);
    plain[0] = typeof data === "string" ? KIND_TEXT : KIND_BINARY;
    plain.set(body, 1);
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, plain);
    const frame = new Uint8Array(HEADER_BYTES + cipher.byteLength);
    frame[0] = FRAME_VERSION;
    frame.set(iv, 1);
    frame.set(new Uint8Array(cipher), HEADER_BYTES);
    return frame.buffer;
  }
}

export class Opener {
  private expected = 0n;
  constructor(private readonly key: CryptoKey, private readonly peerDirection: Direction) {}

  async open(frame: ArrayBuffer): Promise<string | ArrayBuffer> {
    const bytes = new Uint8Array(frame);
    if (!looksLikeFrame(bytes)) throw new Error("not an encrypted frame");
    const iv = bytes.subarray(1, HEADER_BYTES);
    const { direction, counter } = parseIv(iv);
    if (direction !== this.peerDirection) throw new Error("frame from wrong direction");
    if (counter !== this.expected) throw new Error("frame out of sequence");
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, this.key, bytes.subarray(HEADER_BYTES));
    } catch {
      throw new Error("decryption failed");
    }
    this.expected += 1n;
    const kind = new Uint8Array(plain)[0];
    const body = plain.slice(1);
    if (kind === KIND_TEXT) return new TextDecoder().decode(body);
    if (kind === KIND_BINARY) return body;
    throw new Error("unknown frame kind");
  }
}

export function looksLikeFrame(data: unknown): data is ArrayBuffer | Uint8Array {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
  if (!bytes) return false;
  return bytes.byteLength >= HEADER_BYTES + TAG_BYTES + 1 && bytes[0] === FRAME_VERSION;
}

/** Extracts the certificate fingerprint from an SDP description. */
export function sdpFingerprint(sdp: string | null | undefined): string | null {
  if (!sdp) return null;
  const m = /a=fingerprint:(\S+) ([0-9A-Fa-f:]+)/.exec(sdp);
  return m ? `${m[1]!.toLowerCase()} ${m[2]!.toUpperCase()}` : null;
}

export const CONNECTION_WORD_COUNT = 4;

/** Four words both ends can read aloud to detect a man in the middle. The
 *  fingerprints are sorted so both sides compute the same sequence
 *  regardless of which one is "local". 32 bits is enough that an attacker
 *  cannot grind matching certificates for both sides inside a share's
 *  lifetime. */
export async function connectionWords(localSdp: string | null | undefined, remoteSdp: string | null | undefined): Promise<string[] | null> {
  const a = sdpFingerprint(localSdp);
  const b = sdpFingerprint(remoteSdp);
  if (!a || !b) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8([a, b].sort().join("|"))));
  const words: string[] = [];
  for (let i = 0; i < CONNECTION_WORD_COUNT; i++) words.push(WORDS[digest[i]!]!);
  return words;
}

function buildIv(direction: Direction, counter: bigint): Uint8Array {
  const iv = new Uint8Array(IV_BYTES);
  iv[0] = direction === "sender" ? 1 : 2;
  new DataView(iv.buffer).setBigUint64(4, counter);
  return iv;
}

function parseIv(iv: Uint8Array): { direction: Direction | null; counter: bigint } {
  const direction = iv[0] === 1 ? "sender" : iv[0] === 2 ? "receiver" : null;
  const counter = new DataView(iv.buffer, iv.byteOffset, iv.byteLength).getBigUint64(4);
  return { direction, counter };
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The PGP word list's even-position words: 256 two-syllable words chosen
 *  to be phonetically distinct when read aloud, which is exactly the job. */
const WORDS = [
  "aardvark", "absurd", "accrue", "acme", "adrift", "adult", "afflict", "ahead",
  "aimless", "algol", "allow", "alone", "ammo", "ancient", "apple", "artist",
  "assume", "athens", "atlas", "aztec", "baboon", "backfield", "backward", "banjo",
  "beaming", "bedlamp", "beehive", "beeswax", "befriend", "belfast", "berserk", "billiard",
  "bison", "blackjack", "blockade", "blowtorch", "bluebird", "bombast", "bookshelf", "brackish",
  "breadline", "breakup", "brickyard", "briefcase", "burbank", "button", "buzzard", "cement",
  "chairlift", "chatter", "checkup", "chisel", "choking", "chopper", "christmas", "clamshell",
  "classic", "classroom", "cleanup", "clockwork", "cobra", "commence", "concert", "cowbell",
  "crackdown", "cranky", "crowfoot", "crucial", "crumpled", "crusade", "cubic", "dashboard",
  "deadbolt", "deckhand", "dogsled", "dragnet", "drainage", "dreadful", "drifter", "dropper",
  "drumbeat", "drunken", "dupont", "dwelling", "eating", "edict", "egghead", "eightball",
  "endorse", "endow", "enlist", "erase", "escape", "exceed", "eyeglass", "eyetooth",
  "facial", "fallout", "flagpole", "flatfoot", "flytrap", "fracture", "framework", "freedom",
  "frighten", "gazelle", "geiger", "glitter", "glucose", "goggles", "goldfish", "gremlin",
  "guidance", "hamlet", "highchair", "hockey", "indoors", "indulge", "inverse", "involve",
  "island", "jawbone", "keyboard", "kickoff", "kiwi", "klaxon", "locale", "lockup",
  "merit", "minnow", "miser", "mohawk", "mural", "music", "necklace", "neptune",
  "newborn", "nightbird", "oakland", "obtuse", "offload", "optic", "orca", "payday",
  "peachy", "pheasant", "physique", "playhouse", "pluto", "preclude", "prefer", "preshrunk",
  "printer", "prowler", "pupil", "puppy", "python", "quadrant", "quiver", "quota",
  "ragtime", "ratchet", "rebirth", "reform", "regain", "reindeer", "rematch", "repay",
  "retouch", "revenge", "reward", "rhythm", "ribcage", "ringbolt", "robust", "rocker",
  "ruffled", "sailboat", "sawdust", "scallion", "scenic", "scorecard", "scotland", "seabird",
  "select", "sentence", "shadow", "shamrock", "showgirl", "skullcap", "skydive", "slingshot",
  "slowdown", "snapline", "snapshot", "snowcap", "snowslide", "solo", "southward", "soybean",
  "spaniel", "spearhead", "spellbind", "spheroid", "spigot", "spindle", "spyglass", "stagehand",
  "stagnate", "stairway", "standard", "stapler", "steamship", "sterling", "stockman", "stopwatch",
  "stormy", "sugar", "surmount", "suspense", "sweatband", "swelter", "tactics", "talon",
  "tapeworm", "tempest", "tiger", "tissue", "tonic", "topmost", "tracker", "transit",
  "trauma", "treadmill", "trojan", "trouble", "tumor", "tunnel", "tycoon", "uncut",
  "unearth", "unwind", "uproot", "upset", "upshot", "vapor", "village", "virus",
  "vulcan", "waffle", "wallet", "watchword", "wayside", "willow", "woodlark", "zulu",
];
