import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import QRCode from "qrcode";
import { Peer, SignalingClient, deriveKey, generateLinkSecret } from "@steekem/webrtc-core";
import { ensureServiceWorker } from "../lib/file-sink";
import { pruneOldSessions, recallSession, rememberSession, type SessionMemory } from "../lib/session-memory";
import { claimOwnership, isOwner, ownerSecret } from "../lib/ownership";
import { buildReceiveHash } from "../lib/share-link";
import { buildBundle, totalFileCount, totalSize, type BundleNode, type TransferBundle } from "../lib/transfer-bundle";
import { deleteAtPath, nodesFromDrop, nodesFromFilePicker, nodesFromFolderPicker } from "../lib/staged-import";
import { useWakeLock } from "../lib/wake-lock";
import { sanitizeDeviceLabel } from "../lib/device-label";

type Status =
  | "lobby"          // pre-session
  | "connecting"     // WS opening
  | "waiting"        // active session, no peer yet
  | "negotiating"    // peer paired, handshaking
  | "offered"        // offer sent, waiting for accept
  | "transferring"   // bytes flowing
  | "done"           // sent (also ghost-completed after refresh)
  | "rejected"       // receiver declined (also ghost-declined)
  | "interrupted"    // refresh mid-transfer / orphaned room
  | "locked"         // this tab is not the session's owner
  | "error";

interface FileOffer {
  type: "file-offer";
  name: string;
  size: number;
  mimeType: string;
  pinRequired?: boolean;
}

/** Inline structured payload — sent in one DataOffer message. Files are
 *  separate (need accept/streaming). New verticals (wifi, password, card)
 *  add more `kind` variants here. */
type InlineData =
  | { kind: "text"; text: string }
  | { kind: "wifi"; ssid: string; password: string; security: "WPA" | "WEP" | "none"; hidden: boolean }
  | { kind: "password"; service?: string; username: string; password: string; notes?: string }
  | { kind: "card"; name: string; number: string; expiry: string; cvc: string; zip?: string };

/** Announces only the kind. The payload itself is withheld until the
 *  receiver explicitly accepts, so link unfurlers, URL scanners and
 *  accidentally opened tabs can't consume a single-use share. */
interface DataOffer {
  type: "data-offer";
  kind: InlineData["kind"];
  pinRequired?: boolean;
}

interface PinResult {
  type: "pin-result";
  ok: boolean;
  attemptsLeft: number;
}

/** Why the sender ended an otherwise healthy session. Drives the copy on
 *  the "interrupted" card; null after a refresh, where the reason is lost. */
type CancelReason = "canceled" | "expired" | "pin" | "mismatch";

interface DataPayload {
  type: "data-payload";
  data: InlineData;
}

interface SessionStatusMsg {
  type: "session-status";
  status: "active" | "completed" | "declined" | "aborted";
  file?: { name: string; size: number; mimeType?: string };
  /** Future inline kinds (wifi, password, card) widen this. The receiver
   *  only renders kinds it understands; unknown kinds fall back to a
   *  generic "transfer completed" state. */
  data?: { kind: "text" | "wifi" | "password" | "card"; summary?: string };
}

interface Progress {
  bytes: number;
  total: number;
}

type Payload =
  | { kind: "files"; bundle: TransferBundle }
  | InlineData;

type GhostInfo =
  | { kind: "files"; name: string; size: number }
  | { kind: "text" | "wifi" | "password" | "card"; summary?: string };

interface Props {
  signalingUrl: string;
  mode?: "files" | "text" | "wifi" | "password" | "card";
}

const MAX_TEXT_LENGTH = 8 * 1024;

// Cap on the JSON-serialized payload for the structured inline kinds
// (wifi, password, card). Their <input> fields have no maxLength on most
// of them, so without this devtools could be used to stuff arbitrary blobs
// into a field. Real legitimate inputs are well under 200 bytes; 2 KB
// leaves slack for long password notes without leaving room for a
// meaningful binary payload. Text has its own MAX_TEXT_LENGTH cap.
const MAX_STRUCTURED_PAYLOAD_BYTES = 2 * 1024;

// 256 KB is the practical maximum for RTCDataChannel messages across modern
// browsers. 16 MB high-water keeps SCTP's send buffer deep enough to saturate
// the wire on LAN. BUFFERED_AMOUNT_LOW (in peer.ts) is 4 MB so we resume
// pushing chunks while there's still 4 MB queued — no idle gaps waiting for
// the buffer to fully drain.
const CHUNK_SIZE = 256 * 1024;
// SCTP fallback when a peer advertises no max-message-size (spec default).
// Matches Safari/WebKit's advertised limit, so it's always safe to send.
const SAFE_CHUNK_SIZE = 64 * 1024;
const HIGH_WATER = 16 * 1024 * 1024;
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no i/l/o/0/1
const CODE_LENGTH = 6;

// Inline shares are secrets; one that nobody opens shouldn't sit waiting in
// an open tab indefinitely. Files are exempt — large transfers are often
// set up ahead of time.
const INLINE_SHARE_TTL_MS = 15 * 60 * 1000;

// A 4-digit PIN with 3 attempts per session gives a guesser a 0.03% chance,
// while staying short enough to read out over the phone.
const PIN_LENGTH = 4;
const MAX_PIN_ATTEMPTS = 3;
// How long a receiver gets from partner-joined to an open channel before the
// attempt is written off; ICE on a hopeless path can otherwise sit in
// "checking" for minutes with nothing to show either side.
const NEGOTIATION_TIMEOUT_MS = 20_000;
// ICE reports "disconnected" on brief hiccups it often recovers from; only a
// sustained one counts as a lost connection.
const ICE_GRACE_MS = 5_000;
const NO_PATH_MESSAGE =
  "Someone opened the link, but no direct path could be found between the two devices " +
  "(usually a strict firewall, a VPN or a mobile carrier's NAT). Steekem has no relay server, " +
  "so nothing was sent. The link still works; trying again on the same Wi-Fi usually helps.";
const LINK_MISMATCH_MESSAGE =
  "A receiver connected with a link whose key didn't match this share, so nothing was sent to it. " +
  "Copy the link again if that was the intended person.";
const PIN_PATTERN = /^\d{4}$/;

function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]!).join("");
}


function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const c of code) if (!CODE_ALPHABET.includes(c)) return false;
  return true;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const STATUS_LABEL: Record<Status, string> = {
  lobby: "ready",
  connecting: "connecting",
  waiting: "waiting for the receiver",
  negotiating: "connecting peers",
  offered: "waiting for accept",
  transferring: "sending",
  done: "sent",
  rejected: "declined",
  interrupted: "session ended",
  locked: "session locked",
  error: "error",
};

function isEndState(s: Status): boolean {
  return (
    s === "done" ||
    s === "rejected" ||
    s === "interrupted" ||
    s === "locked" ||
    s === "error"
  );
}

export default function SendApp({ signalingUrl, mode: initialMode }: Props) {
  const [status, setStatus] = useState<Status>("lobby");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string>("");
  const [qrSvg, setQrSvg] = useState<string>("");
  const [copyTip, setCopyTip] = useState<string>("");
  const [log, setLog] = useState<string[]>([]);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [staged, setStaged] = useState<BundleNode[]>([]);
  const mode = initialMode ?? "files";
  const [textDraft, setTextDraft] = useState("");
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [wifiSecurity, setWifiSecurity] = useState<"WPA" | "WEP" | "none">("WPA");
  const [wifiHidden, setWifiHidden] = useState(false);
  const [pwService, setPwService] = useState("");
  const [pwUsername, setPwUsername] = useState("");
  const [pwPassword, setPwPassword] = useState("");
  const [pwNotes, setPwNotes] = useState("");
  const [cardName, setCardName] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const [cardExpiry, setCardExpiry] = useState("");
  const [cardCvc, setCardCvc] = useState("");
  const [cardZip, setCardZip] = useState("");
  const [processing, setProcessing] = useState(false);
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [ghost, setGhost] = useState<GhostInfo | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [receiverDevice, setReceiverDevice] = useState<string | null>(null);
  const [pinDraft, setPinDraft] = useState("");
  const [pin, setPin] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [cancelReason, setCancelReason] = useState<CancelReason | null>(null);
  const peerRef = useRef<Peer | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const recalledRef = useRef<SessionMemory | null>(null);
  const lastSyncedHashRef = useRef<string | null>(null);

  // Live mirrors of state for callbacks (avoid stale-closure issues).
  const statusRef = useRef<Status>("lobby");
  const payloadRef = useRef<Payload | null>(null);
  const receiverDeviceRef = useRef<string | null>(null);
  const pinRef = useRef<string | null>(null);
  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { payloadRef.current = payload; }, [payload]);
  useEffect(() => { receiverDeviceRef.current = receiverDevice; }, [receiverDevice]);
  useEffect(() => { pinRef.current = pin; }, [pin]);
  // Per-connection: a receiver must pass the PIN check before its accept is
  // honored. Failures count per session, so reconnecting doesn't reset them.
  const pinVerifiedRef = useRef(false);
  const pinFailuresRef = useRef(0);
  // Per-connection protection level. "e2e": the receiver's first message
  // decrypted with the link key, so it holds the secret. "code": it typed the
  // room code and only DTLS protects the channel, so the humans compare the
  // connection words before anything is released.
  const [linkMode, setLinkMode] = useState<"e2e" | "code" | null>(null);
  const linkModeRef = useRef<"e2e" | "code" | null>(null);
  const [connectionWords, setConnectionWords] = useState<string[] | null>(null);
  const wordsConfirmedRef = useRef(false);
  const pendingConsentRef = useRef<(() => void) | null>(null);
  const [consentPending, setConsentPending] = useState(false);
  const helloSeenRef = useRef(false);
  const [connectIssue, setConnectIssue] = useState<string | null>(null);
  const iceGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const negotiationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the screen on while a file transfer is in flight. Text mode is
  // a one-shot delivery — no long-running transfer, no need to fight the
  // OS screen-lock for it.
  useWakeLock(status !== "lobby" && !isEndState(status) && payload?.kind === "files");

  // Ticks once a second while an inline share is pending, both for the
  // visible countdown and to cancel the share when it runs out.
  useEffect(() => {
    if (expiresAt === null || status === "lobby" || isEndState(status)) return;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t >= expiresAt) cancelSession("expired");
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt, status]);

  function append(line: string) {
    setLog((prev) => [...prev, `[${new Date().toISOString().slice(11, 19)}] ${line}`]);
  }

  function setGhostFromRecalled(r: SessionMemory) {
    if (r.file) setGhost({ kind: "files", name: r.file.name, size: r.file.size });
    else if (r.data) setGhost({ kind: r.data.kind, summary: r.data.summary });
    setReceiverDevice(r.device ?? null);
  }

  // ── lobby vs active session (mount + hashchange) ────────────────
  // /send is two things in one page:
  //   - no hash → lobby (drop a file or paste a code to receive)
  //   - with hash → sender's own session URL, locked to the original tab
  useEffect(() => {
    pruneOldSessions();

    function syncFromHash() {
      const hash = window.location.hash.slice(1).toLowerCase();
      if (!hash) {
        setStatus("lobby");
        setRoomId(null);
        return;
      }
      if (!isValidCode(hash)) return;
      if (hash === lastSyncedHashRef.current) return;
      lastSyncedHashRef.current = hash;

      // Owner gate: only the tab that started this session (sessionStorage
      // token) is allowed to render the active sender UI. Everyone else
      // (other tabs, fresh visits) sees a "session locked" message.
      if (!isOwner(hash)) {
        setStatus("locked");
        setRoomId(hash);
        return;
      }

      const recalled = recallSession(hash);
      recalledRef.current = recalled;

      if (recalled) {
        setRoomId(hash);
        if (recalled.outcome === "completed") {
          setStatus("done");
          setGhostFromRecalled(recalled);
        } else if (recalled.outcome === "declined") {
          setStatus("rejected");
          setGhostFromRecalled(recalled);
        } else if (recalled.outcome === "aborted") {
          setStatus("interrupted");
        }
        return;
      }

      // Owner with no localStorage marker → either a fresh start (payload
      // already in memory; we just set the hash ourselves) OR the original
      // tab refreshed mid-transfer and lost its payload.
      if (payloadRef.current) {
        // Fresh start — roomId useEffect picks it up.
        setRoomId(hash);
      } else {
        // Refresh-mid-transfer: file gone. Just clear the hash and drop
        // back to the lobby — that's friendlier than showing a dead-end
        // "session interrupted" page when the user can just pick a new file.
        history.replaceState(null, "", "/send");
        lastSyncedHashRef.current = null;
        setStatus("lobby");
        setRoomId(null);
      }
    }

    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  // ── pre-warm Service Worker ─────────────────────────────────────
  useEffect(() => {
    ensureServiceWorker().catch(() => { /* fine */ });
  }, []);

  // ── share URL + QR (we share the receiver-side URL, /r#code) ────
  useEffect(() => {
    if (!roomId) {
      setShareUrl("");
      setQrSvg("");
      return;
    }
    // ".p" tells the receive page to ask for the PIN up front. It's a
    // convenience only; the PIN check itself happens on this side.
    const url = `${window.location.origin}/r#${buildReceiveHash(roomId, ownerSecret(roomId), pin !== null)}`;
    setShareUrl(url);
    QRCode.toString(url, {
      type: "svg",
      margin: 0,
      color: { dark: "#0b0d10", light: "#ffffff" },
    })
      .then(setQrSvg)
      .catch((err) => append(`qr err: ${err.message}`));
  }, [roomId, pin]);

  // ── signaling + peer ────────────────────────────────────────────
  useEffect(() => {
    if (!roomId) return;
    if (status === "locked") return; // never connect on a locked tab

    setStatus((s) => (isEndState(s) ? s : "connecting"));

    let disposed = false;
    let peer: Peer | null = null;
    let signaling: SignalingClient | null = null;
    let unsub: (() => void) | null = null;

    (async () => {
      // The key is derived before the socket opens so nothing can be said
      // in the clear by accident. A session without a stored secret (started
      // before secrets existed) runs code-only.
      const secret = ownerSecret(roomId);
      let key: CryptoKey | null = null;
      if (secret) {
        try { key = await deriveKey(secret, roomId); }
        catch (err) { append(`key derivation failed: ${(err as Error).message}`); }
      }
      if (disposed) return;

      signaling = new SignalingClient(`${signalingUrl}/room/${roomId}`);
      const sig = signaling;
      const p = new Peer({
        signaling: sig,
        key,
        plaintext: "allow-downgrade",
        onEvent: (e) => {
          if (e.type === "channel-open") {
            append("datachannel open");
            handleChannelOpen();
          } else if (e.type === "channel-close") {
            append("datachannel closed");
          } else if (e.type === "channel-message") {
            handleChannelMessage(e.data);
          } else if (e.type === "ice-state") {
            append(`ice: ${e.state}`);
            handleIceState(p, e.state);
          } else if (e.type === "encryption") {
            append(`channel protection: ${e.mode === "e2e" ? "link key" : "DTLS only (typed code)"}`);
          } else if (e.type === "crypto-error") {
            append(`crypto error: ${e.error.message}`);
            failConnection(p, LINK_MISMATCH_MESSAGE);
          } else if (e.type === "error") {
            append(`peer error: ${e.error.message}`);
            setStatus("error");
          }
        },
      });
      peer = p;
      peerRef.current = p;
      signalingRef.current = sig;

      unsub = sig.onMessage((msg) => {
        if (msg.type === "joined") {
          const r = msg.role as "sender" | "receiver";
          p.setRole(r);
          if (r !== "sender") {
            // Only the sender renders the /send#code UI. If we ended up
            // assigned receiver here something's off — most likely the room
            // was orphaned and we're stuck.
            append("worker assigned receiver role on /send — orphaned room");
            setStatus("error");
            return;
          }
          if (statusRef.current === "interrupted" || statusRef.current === "done" || statusRef.current === "rejected") {
            // Ghost mode — keep the sticky status. Negotiate so we can
            // broadcast the right status to the partner once channel opens.
            if (msg.partnerPresent) beginNegotiation(p);
          } else if (payloadRef.current) {
            setStatus(msg.partnerPresent ? "negotiating" : "waiting");
            if (msg.partnerPresent) beginNegotiation(p);
          } else {
            // We're a sender with no payload — refresh-mid-transfer, mark aborted.
            const code = roomId!;
            rememberSession(code, { outcome: "aborted" });
            recalledRef.current = recallSession(code);
            setStatus("interrupted");
            if (msg.partnerPresent) beginNegotiation(p);
          }
        } else if (msg.type === "partner-joined") {
          setStatus((s) => (isEndState(s) ? s : "negotiating"));
          beginNegotiation(p);
        } else if (msg.type === "partner-left") {
          // Receiver closed their tab. Until they explicitly accept or
          // decline, the session stays open — they (or someone else) can
          // re-open the share link and try again. Mid-transfer is the same:
          // bytes lost, but the session itself isn't dead.
          clearConnectionTimers();
          p.resetConnection();
          resetConnectionState();
          setStatus((s) => (isEndState(s) ? s : "waiting"));
          // After delivery the receiver disconnects on its own; keep its device
          // label so the done card can say where the share went.
          if (!isEndState(statusRef.current)) setReceiverDevice(null);
        }
      });

      sig.connect().catch((err) => {
        append(`signaling connect err: ${err.message}`);
        setStatus("error");
      });
    })();

    return () => {
      disposed = true;
      clearConnectionTimers();
      unsub?.();
      peer?.close();
      signaling?.close();
      peerRef.current = null;
      signalingRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, signalingUrl]);

  // ── connection health ───────────────────────────────────────────
  function beginNegotiation(peer: Peer) {
    clearConnectionTimers();
    negotiationTimerRef.current = setTimeout(() => {
      negotiationTimerRef.current = null;
      append(`no channel after ${NEGOTIATION_TIMEOUT_MS / 1000}s`);
      failConnection(peer, NO_PATH_MESSAGE);
    }, NEGOTIATION_TIMEOUT_MS);
    peer.startNegotiation().catch((err) => append(`negotiate err: ${err.message}`));
  }

  function clearConnectionTimers() {
    if (negotiationTimerRef.current !== null) {
      clearTimeout(negotiationTimerRef.current);
      negotiationTimerRef.current = null;
    }
    if (iceGraceRef.current !== null) {
      clearTimeout(iceGraceRef.current);
      iceGraceRef.current = null;
    }
  }

  function handleIceState(peer: Peer, state: RTCIceConnectionState) {
    if (state === "connected" || state === "completed") {
      if (iceGraceRef.current !== null) {
        clearTimeout(iceGraceRef.current);
        iceGraceRef.current = null;
      }
      return;
    }
    if (state === "failed") {
      failConnection(peer, NO_PATH_MESSAGE);
      return;
    }
    if (state === "disconnected" && iceGraceRef.current === null) {
      iceGraceRef.current = setTimeout(() => {
        iceGraceRef.current = null;
        failConnection(peer, NO_PATH_MESSAGE);
      }, ICE_GRACE_MS);
    }
  }

  // Everything that belongs to one receiver's connection attempt.
  function resetConnectionState() {
    pinVerifiedRef.current = false;
    helloSeenRef.current = false;
    wordsConfirmedRef.current = false;
    pendingConsentRef.current = null;
    setConsentPending(false);
    linkModeRef.current = null;
    setLinkMode(null);
    setConnectionWords(null);
    setProgress(null);
  }

  // Drops the current attempt and gets ready for the next one. The share
  // itself stays valid: the receiver can retry, and the message explains why
  // it may have failed.
  function failConnection(peer: Peer, message: string) {
    clearConnectionTimers();
    peer.resetConnection();
    resetConnectionState();
    if (isEndState(statusRef.current)) return;
    append("connection attempt failed; waiting for a new one");
    setConnectIssue(message);
    setReceiverDevice(null);
    setStatus((s) => (isEndState(s) ? s : "waiting"));
  }

  function handleChannelOpen() {
    clearConnectionTimers();
    setConnectIssue(null);
    helloSeenRef.current = false;
    wordsConfirmedRef.current = false;
    pendingConsentRef.current = null;
    setConsentPending(false);
    // Nothing is announced yet: the receiver's hello is the first message, and
    // whether it decrypts decides the protection level of this connection.
  }


  // ── sender broadcasts session-status once the receiver has said hello ──
  function announceSession(peer: Peer) {
    const s = statusRef.current;
    const p = payloadRef.current;
    const recalled = recalledRef.current;

    // Status broadcasts go to whoever opens the link, including scanners and
    // forwarded-link recipients, so inline kinds carry only the kind. The
    // local summary (SSID, last 4 card digits, username) stays on this tab.
    function payloadMeta(): Pick<SessionStatusMsg, "file" | "data"> {
      const file = recalled?.file ?? (p?.kind === "files"
        ? { name: p.bundle.name, size: p.bundle.size, mimeType: p.bundle.mimeType }
        : undefined);
      const kind = recalled?.data?.kind ?? (p && p.kind !== "files" ? p.kind : undefined);
      return { file, data: kind ? { kind } : undefined };
    }

    if (s === "done") {
      peer.send(JSON.stringify({ type: "session-status", status: "completed", ...payloadMeta() } satisfies SessionStatusMsg));
      return;
    }
    if (s === "rejected") {
      peer.send(JSON.stringify({ type: "session-status", status: "declined", ...payloadMeta() } satisfies SessionStatusMsg));
      return;
    }
    if (s === "interrupted") {
      peer.send(JSON.stringify({ type: "session-status", status: "aborted" } satisfies SessionStatusMsg));
      return;
    }

    if (p?.kind === "files") {
      peer.send(JSON.stringify({ type: "session-status", status: "active" } satisfies SessionStatusMsg));
      sendFileOffer(peer, p.bundle);
      return;
    }
    if (p) {
      // p must be one of the inline-data kinds.
      peer.send(JSON.stringify({ type: "session-status", status: "active" } satisfies SessionStatusMsg));
      sendDataOffer(peer, p);
      return;
    }

    peer.send(JSON.stringify({ type: "session-status", status: "aborted" } satisfies SessionStatusMsg));
  }

  function sendFileOffer(peer: Peer, b: TransferBundle) {
    const offer: FileOffer = {
      type: "file-offer",
      name: b.name,
      size: b.size,
      mimeType: b.mimeType,
      pinRequired: pinRef.current !== null,
    };
    peer.send(JSON.stringify(offer));
    setStatus("offered");
    append(`file-offer sent: ${offer.name} (${formatBytes(offer.size)})`);
  }

  function sendDataOffer(peer: Peer, data: InlineData) {
    const offer: DataOffer = { type: "data-offer", kind: data.kind, pinRequired: pinRef.current !== null };
    peer.send(JSON.stringify(offer));
    setStatus("offered");
    append(`data-offer sent (kind=${data.kind})`);
  }

  function handleChannelMessage(data: string | ArrayBuffer | Blob) {
    if (typeof data !== "string") return; // bytes never flow into the sender
    let parsed: { type?: string; [k: string]: unknown };
    try { parsed = JSON.parse(data); }
    catch { return; }

    if (parsed.type === "receiver-hello") {
      const device = sanitizeDeviceLabel(parsed.device);
      setReceiverDevice(device);
      receiverDeviceRef.current = device;
      append(`receiver device: ${device ?? "unknown"}`);
      if (helloSeenRef.current) return;
      helloSeenRef.current = true;
      const peer = peerRef.current;
      if (!peer) return;
      const mode = peer.encryption === "e2e" ? "e2e" : "code";
      linkModeRef.current = mode;
      setLinkMode(mode);
      if (mode === "code") {
        peer.connectionWords()
          .then((words) => {
            setConnectionWords(words);
            if (words) append(`connection words: ${words.join(" ")}`);
          })
          .catch(() => { /* words stay unavailable; the confirm button stays disabled */ });
      }
      announceSession(peer);
      return;
    }

    // Anything else is only meaningful after the hello settled the mode.
    if (!helloSeenRef.current) {
      append(`${parsed.type} ignored: no hello yet`);
      return;
    }

    if (parsed.type === "pin-check") {
      handlePinCheck(parsed.pin);
      return;
    }

    const isConsent =
      parsed.type === "file-accept" || parsed.type === "file-reject" ||
      parsed.type === "data-accept";
    if (!isConsent) return;

    // A recalled outcome means the share was already delivered, declined or
    // canceled; never act on consent a second time.
    if (recalledRef.current) {
      append(`${parsed.type} ignored: session already ${recalledRef.current.outcome}`);
      return;
    }
    // The receiver UI only offers accept/decline after a passed PIN check;
    // anything else is a client bypassing it.
    if (pinRef.current !== null && !pinVerifiedRef.current) {
      append(`${parsed.type} ignored: PIN not verified`);
      return;
    }

    // A code-only connection releases nothing until the sender has compared
    // the connection words with the receiver's screen.
    if (linkModeRef.current === "code" && !wordsConfirmedRef.current) {
      const held = parsed;
      pendingConsentRef.current = () => actOnConsent(held);
      setConsentPending(true);
      append(`${parsed.type} held until the connection words are confirmed`);
      return;
    }
    actOnConsent(parsed);
  }

  function confirmConnectionWords() {
    wordsConfirmedRef.current = true;
    setConsentPending(false);
    const run = pendingConsentRef.current;
    pendingConsentRef.current = null;
    append("connection words confirmed");
    run?.();
  }

  function actOnConsent(parsed: { type?: string; [k: string]: unknown }) {
    const device = receiverDeviceRef.current ?? undefined;
    const via = device ? ` on ${device}` : "";

    if (parsed.type === "file-accept") {
      const p = payloadRef.current;
      if (!p || p.kind !== "files") {
        append("file-accept received but no files payload — bug");
        return;
      }
      append(`receiver accepted${via}`);
      startSendBytes(p.bundle);
      return;
    }

    if (parsed.type === "file-reject") {
      const reason = (parsed as { reason?: string }).reason;
      append(`receiver declined${via}${reason ? ": " + reason : ""}`);
      const p = payloadRef.current;
      const code = roomId;
      if (code && p?.kind === "files") {
        rememberSession(code, {
          outcome: "declined",
          file: { name: p.bundle.name, size: p.bundle.size, mimeType: p.bundle.mimeType },
          device,
        });
        recalledRef.current = recallSession(code);
        setGhost({ kind: "files", name: p.bundle.name, size: p.bundle.size });
      }
      setStatus("rejected");
      return;
    }

    const p = payloadRef.current;
    if (!p || p.kind === "files") {
      append(`${parsed.type} received but no inline payload — bug`);
      return;
    }
    const peer = peerRef.current;
    if (!peer) return;
    peer.send(JSON.stringify({ type: "data-payload", data: p } satisfies DataPayload));
    append(`receiver accepted${via}, data sent (kind=${p.kind})`);
    // Marked completed as soon as the payload leaves this tab, not on a
    // receiver ack: once sent, the share is spent whether or not the
    // receiver survives long enough to confirm.
    const code = roomId;
    const summary = inlineSummary(p);
    if (code) {
      rememberSession(code, {
        outcome: "completed",
        data: { kind: p.kind, summary },
        device,
      });
      recalledRef.current = recallSession(code);
    }
    setGhost({ kind: p.kind, summary });
    setStatus("done");
  }

  function handlePinCheck(attempt: unknown) {
    const peer = peerRef.current;
    if (!peer || recalledRef.current) return;
    const expected = pinRef.current;
    // Only a real 4-digit guess counts as an attempt.
    if (expected !== null && (typeof attempt !== "string" || !PIN_PATTERN.test(attempt))) return;
    if (expected === null || attempt === expected) {
      pinVerifiedRef.current = true;
      peer.send(JSON.stringify({ type: "pin-result", ok: true, attemptsLeft: MAX_PIN_ATTEMPTS - pinFailuresRef.current } satisfies PinResult));
      append("pin verified");
      return;
    }
    pinFailuresRef.current += 1;
    const attemptsLeft = Math.max(0, MAX_PIN_ATTEMPTS - pinFailuresRef.current);
    peer.send(JSON.stringify({ type: "pin-result", ok: false, attemptsLeft } satisfies PinResult));
    append(`wrong pin (${attemptsLeft} attempts left)`);
    if (attemptsLeft === 0) cancelSession("pin");
  }

  // Ends the session for good: marks it aborted (so later visitors hear
  // "canceled"), tells a connected receiver, and drops the payload from
  // memory so nothing can release it afterwards.
  function cancelSession(reason: CancelReason) {
    const code = roomId;
    if (!code || recalledRef.current) return;
    rememberSession(code, { outcome: "aborted" });
    recalledRef.current = recallSession(code);
    try {
      peerRef.current?.send(JSON.stringify({ type: "session-status", status: "aborted" } satisfies SessionStatusMsg));
    } catch { /* channel not open — nobody to tell */ }
    payloadRef.current = null;
    setPayload(null);
    setExpiresAt(null);
    setCancelReason(reason);
    setStatus("interrupted");
    append(`session ended: ${reason}`);
  }

  function inlineSummary(d: InlineData): string {
    if (d.kind === "text") return `${d.text.length} chars`;
    if (d.kind === "wifi") return d.ssid;
    if (d.kind === "password") return d.service || d.username;
    if (d.kind === "card") return `•••• ${d.number.slice(-4)}`;
    return "";
  }

  // ── lobby actions ───────────────────────────────────────────────
  function startSession(p: Payload) {
    if (p.kind === "wifi" || p.kind === "password" || p.kind === "card") {
      const size = JSON.stringify(p).length;
      if (size > MAX_STRUCTURED_PAYLOAD_BYTES) {
        append(`payload too large: ${size} > ${MAX_STRUCTURED_PAYLOAD_BYTES} bytes`);
        return;
      }
    }
    if (pinDraft && !PIN_PATTERN.test(pinDraft)) return;
    const sessionPin = pinDraft || null;
    pinRef.current = sessionPin;
    setPin(sessionPin);
    setPayload(p);
    const code = generateCode();
    claimOwnership(code, generateLinkSecret());
    lastSyncedHashRef.current = code;
    window.location.hash = code;
    setRoomId(code);
    setExpiresAt(p.kind === "files" ? null : Date.now() + INLINE_SHARE_TTL_MS);
  }

  // Auto-skip stage when this is the first drop AND it's a single bare file.
  // Anything else (folder, multiple items, mix, or appending while staged is
  // non-empty) goes through the staging UI.
  function intake(newNodes: BundleNode[]) {
    if (newNodes.length === 0) return;
    if (staged.length === 0 && newNodes.length === 1 && newNodes[0]!.kind === "file") {
      const b = buildBundle([newNodes[0]!]);
      if (b) startSession({ kind: "files", bundle: b });
      return;
    }
    setStaged((prev) => [...prev, ...newNodes]);
  }

  function onDeletePath(path: number[]) {
    setStaged((prev) => deleteAtPath(prev, path));
  }

  function onClearStaged() {
    setStaged([]);
  }

  function onSendStaged() {
    const b = buildBundle(staged);
    if (!b) {
      append("nothing to send — selection is empty after pruning");
      return;
    }
    startSession({ kind: "files", bundle: b });
  }

  function onSendText() {
    const text = textDraft;
    if (!text || text.length === 0) return;
    if (text.length > MAX_TEXT_LENGTH) {
      append(`text exceeds ${MAX_TEXT_LENGTH} characters`);
      return;
    }
    startSession({ kind: "text" as const, text });
  }

  function onSendWifi() {
    const ssid = wifiSsid.trim();
    if (!ssid) return;
    startSession({
      kind: "wifi" as const,
      ssid,
      password: wifiPassword,
      security: wifiSecurity,
      hidden: wifiHidden,
    });
  }

  function onSendPassword() {
    const username = pwUsername.trim();
    const password = pwPassword;
    if (!username && !password) return;
    startSession({
      kind: "password" as const,
      service: pwService.trim() || undefined,
      username,
      password,
      notes: pwNotes.trim() || undefined,
    });
  }

  function onSendCard() {
    const number = cardNumber.replace(/\s+/g, "");
    if (!number || !cardCvc || !cardExpiry) return;
    startSession({
      kind: "card" as const,
      name: cardName.trim(),
      number,
      expiry: cardExpiry.trim(),
      cvc: cardCvc.trim(),
      zip: cardZip.trim() || undefined,
    });
  }

  async function onDrop(e: DragEvent) {
    startProcessing();
    try {
      const nodes = await nodesFromDrop(e);
      intake(nodes);
    } catch (err) {
      append(`drop failed: ${(err as Error).message}`);
    } finally {
      stopProcessing();
    }
  }

  // Show the spinner the moment a picker is opened (or a drop starts) so it's
  // already on screen during iOS Safari's File-handle materialization window
  // — that's the multi-second delay between picker dismissal and onChange
  // firing. Failsafe timeout clears the state if neither onChange nor cancel
  // fires (older browsers don't dispatch cancel on file inputs).
  function startProcessing(timeoutMs = 60_000) {
    setProcessing(true);
    if (processingTimerRef.current) clearTimeout(processingTimerRef.current);
    processingTimerRef.current = setTimeout(() => {
      setProcessing(false);
      processingTimerRef.current = null;
    }, timeoutMs);
  }

  function stopProcessing() {
    setProcessing(false);
    if (processingTimerRef.current) {
      clearTimeout(processingTimerRef.current);
      processingTimerRef.current = null;
    }
  }

  // Capture the FileList synchronously into stable File references *before*
  // the onChange caller resets the input via `target.value = ""`. iOS Safari
  // empties the live FileList on reset, so any access after a yield (await
  // setTimeout) would see length 0.
  async function onPickFiles(files: FileList | null) {
    if (!files || files.length === 0) {
      stopProcessing();
      return;
    }
    const nodes = nodesFromFilePicker(files);
    if (nodes.length === 0) {
      stopProcessing();
      return;
    }
    startProcessing();
    await new Promise<void>((r) => setTimeout(r, 0));
    intake(nodes);
    stopProcessing();
  }

  async function onPickFolder(files: FileList | null) {
    if (!files || files.length === 0) {
      stopProcessing();
      return;
    }
    const nodes = nodesFromFolderPicker(files);
    if (nodes.length === 0) {
      stopProcessing();
      return;
    }
    startProcessing();
    await new Promise<void>((r) => setTimeout(r, 0));
    intake(nodes);
    stopProcessing();
  }


  // ── sender bytes ────────────────────────────────────────────────
  async function startSendBytes(b: TransferBundle) {
    const peer = peerRef.current;
    if (!peer) return;
    const channel = peer.channel;
    if (!channel || channel.readyState !== "open") {
      append("channel not open at byte-pump time");
      setStatus("error");
      return;
    }

    setStatus("transferring");
    setProgress({ bytes: 0, total: b.size });

    // Clamp to the negotiated SCTP max message size. Safari advertises 64 KB,
    // far below CHUNK_SIZE — sending a larger message throws/closes the channel
    // whenever a Safari peer is on either end. Chrome/Firefox negotiate 256 KB+.
    const maxMessage = peer.maxMessageSize ?? SAFE_CHUNK_SIZE;
    const chunkSize = Math.min(CHUNK_SIZE, maxMessage);
    append(`chunk size ${chunkSize} (sctp max ${peer.maxMessageSize ?? "unknown"})`);

    const reader = b.openStream().getReader();
    const cancel = async () => { try { await reader.cancel(); } catch { /* ignore */ } };
    let sent = 0;

    try {
      while (true) {
        // If the receiver disconnected mid-transfer (channel closed),
        // bow out gracefully — the partner-left handler already moved us
        // back to "waiting", so don't override that with an error.
        if (channel.readyState !== "open") {
          append("channel closed mid-transfer — receiver gone");
          setStatus((s) => (s === "transferring" ? "waiting" : s));
          setProgress(null);
          await cancel();
          return;
        }

        const { value, done } = await reader.read();
        if (done) break;
        let chunk: Uint8Array = value;
        // Re-chunk to chunkSize so wire-level message size stays consistent
        // regardless of what the source stream hands us. Also where
        // backpressure is enforced.
        while (chunk.byteLength > 0) {
          if (channel.readyState !== "open") {
            append("channel closed mid-transfer — receiver gone");
            setStatus((s) => (s === "transferring" ? "waiting" : s));
            setProgress(null);
            await cancel();
            return;
          }
          if (channel.bufferedAmount > HIGH_WATER) await peer.awaitDrain();
          const sliceLen = Math.min(chunk.byteLength, chunkSize);
          await peer.send(chunk.subarray(0, sliceLen));
          sent += sliceLen;
          setProgress({ bytes: sent, total: b.size });
          chunk = chunk.subarray(sliceLen);
        }
      }

      append("send complete");
      const code = roomId;
      if (code) {
        rememberSession(code, {
          outcome: "completed",
          file: { name: b.name, size: b.size, mimeType: b.mimeType },
          device: receiverDeviceRef.current ?? undefined,
        });
        recalledRef.current = recallSession(code);
      }
      setGhost({ kind: "files", name: b.name, size: b.size });
      setStatus("done");
    } catch (err) {
      // Likely cause of mid-pump throws is the channel closing because the
      // receiver disconnected between our channel-state check and the next
      // send call. Treat that as graceful (back to waiting), not an error.
      if (channel.readyState !== "open") {
        append("channel closed during send — receiver gone");
        setStatus((s) => (s === "transferring" ? "waiting" : s));
        setProgress(null);
        await cancel();
        return;
      }
      append(`send err: ${(err as Error).message}`);
      setStatus("error");
      await cancel();
    }
  }

  // ── share helpers ───────────────────────────────────────────────
  async function copyToClipboard(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyTip(label);
      setTimeout(() => setCopyTip(""), 1400);
    } catch {
      append("clipboard write failed");
    }
  }

  function startNew() {
    window.location.href = "/send";
  }

  // ── render ──────────────────────────────────────────────────────

  if (status === "lobby") {
    return (
      <Lobby
        mode={mode}
        staged={staged}
        processing={processing}
        textDraft={textDraft}
        onTextChange={setTextDraft}
        onSendText={onSendText}
        pinDraft={pinDraft}
        onPinDraft={setPinDraft}
        wifiSsid={wifiSsid}
        wifiPassword={wifiPassword}
        wifiSecurity={wifiSecurity}
        wifiHidden={wifiHidden}
        onWifiSsid={setWifiSsid}
        onWifiPassword={setWifiPassword}
        onWifiSecurity={setWifiSecurity}
        onWifiHidden={setWifiHidden}
        onSendWifi={onSendWifi}
        pwService={pwService}
        pwUsername={pwUsername}
        pwPassword={pwPassword}
        pwNotes={pwNotes}
        onPwService={setPwService}
        onPwUsername={setPwUsername}
        onPwPassword={setPwPassword}
        onPwNotes={setPwNotes}
        onSendPassword={onSendPassword}
        cardName={cardName}
        cardNumber={cardNumber}
        cardExpiry={cardExpiry}
        cardCvc={cardCvc}
        cardZip={cardZip}
        onCardName={setCardName}
        onCardNumber={setCardNumber}
        onCardExpiry={setCardExpiry}
        onCardCvc={setCardCvc}
        onCardZip={setCardZip}
        onSendCard={onSendCard}
        onDrop={onDrop}
        onPickFiles={onPickFiles}
        onPickFolder={onPickFolder}
        onPickerOpen={startProcessing}
        onPickerCancel={stopProcessing}
        onDeletePath={onDeletePath}
        onSendStaged={onSendStaged}
        onClearStaged={onClearStaged}
        isDragging={isDragging}
        setIsDragging={setIsDragging}
      />
    );
  }

  if (status === "locked") {
    return (
      <section>
        <StatusLine status={status} />
        <div class="card">
          <h2 class="label">Session locked</h2>
          <p style="margin: 0 0 16px; color: var(--text-muted); font-size: 0.9rem;">
            This sender session belongs to another tab — only the original tab can
            send the file. To send something else, start a new transfer.
          </p>
          <button onClick={startNew}>Start a new transfer</button>
        </div>
      </section>
    );
  }

  return (
    <section>
      <StatusLine status={status} />

      {(status === "waiting" || status === "connecting" || status === "negotiating") && payload && (
        <ShareCard
          payload={payload}
          shareUrl={shareUrl}
          roomId={roomId ?? ""}
          qrSvg={qrSvg}
          copyTip={copyTip}
          onCopy={copyToClipboard}
        >
          {connectIssue && <p class="notice notice-warn">{connectIssue}</p>}
          <SessionControls
            pin={pin}
            expiresInMs={expiresAt === null ? null : expiresAt - now}
            onCancel={() => cancelSession("canceled")}
          />
        </ShareCard>
      )}

      {status === "offered" && payload && (
        <div class="card">
          <h2 class="label">{payload.kind === "files" ? "Waiting for accept" : "Receiver connected"}</h2>
          <PayloadPill payload={payload} />
          <p style="color: var(--text-muted); margin: 16px 0 0; font-size: 0.9rem;">
            {payload.kind === "files"
              ? "The receiver is reviewing this transfer. They can accept or decline."
              : pin && !pinVerifiedRef.current
              ? "The receiver is connected and has to enter the PIN before anything is sent."
              : linkMode === "code"
              ? "The receiver typed the code instead of opening the link. Nothing is sent until you confirm the words below match their screen."
              : "The receiver is connected. Delivering…"}
          </p>
          {receiverDevice && <DeviceLine prefix="Connected:" device={receiverDevice} />}
          {linkMode === "code" && (
            <ConnectionCheck
              words={connectionWords}
              pending={consentPending}
              onConfirm={confirmConnectionWords}
              onReject={() => cancelSession("mismatch")}
            />
          )}
          <SessionControls
            pin={pin}
            expiresInMs={expiresAt === null ? null : expiresAt - now}
            onCancel={() => cancelSession("canceled")}
          />
        </div>
      )}

      {status === "transferring" && payload?.kind === "files" && progress && (
        <div class="card">
          <h2 class="label">Sending</h2>
          <FilePill name={payload.bundle.name} size={payload.bundle.size} />
          <div style="height: 16px;" />
          <ProgressBar bytes={progress.bytes} total={progress.total} />
        </div>
      )}

      {status === "done" && (
        <div class="card">
          <h2 class="label">{ghost?.kind === "text" ? "Delivered" : "Sent"}</h2>
          {ghost && <GhostPill ghost={ghost} />}
          <p style="color: var(--text-muted); margin: 16px 0 16px; font-size: 0.9rem;">
            {ghost?.kind === "text"
              ? "The text was delivered. You can close this tab."
              : "Transfer complete. This URL still confirms delivery to anyone who opens it."}
          </p>
          {receiverDevice && <DeviceLine prefix="Delivered to" device={receiverDevice} />}
          <button class="ghost" onClick={startNew}>Start a new transfer</button>
        </div>
      )}

      {status === "rejected" && (
        <div class="card">
          <h2 class="label">Declined</h2>
          {ghost && <GhostPill ghost={ghost} />}
          <p style="color: var(--text-muted); margin: 16px 0 16px; font-size: 0.9rem;">
            The receiver declined this transfer.
          </p>
          {receiverDevice && <DeviceLine prefix="Declined on" device={receiverDevice} />}
          <button class="ghost" onClick={startNew}>Start a new transfer</button>
        </div>
      )}

      {status === "interrupted" && (
        <div class="card">
          <h2 class="label">
            {cancelReason === "canceled" ? "Share canceled"
              : cancelReason === "expired" ? "Share expired"
              : cancelReason === "pin" ? "Share locked"
              : cancelReason === "mismatch" ? "Share canceled"
              : "Session interrupted"}
          </h2>
          <p style="margin: 0 0 16px; color: var(--text-muted); font-size: 0.9rem;">
            {cancelReason === "canceled"
              ? "You canceled this share. The link no longer works and nothing was sent."
              : cancelReason === "expired"
              ? "Nobody opened this share in time, so it was canceled. The link no longer works and nothing was sent."
              : cancelReason === "pin"
              ? `The PIN was entered wrong ${MAX_PIN_ATTEMPTS} times, so the share was canceled to stop guessing. Nothing was sent.`
              : cancelReason === "mismatch"
              ? "The connection words didn't match, so nothing was sent. Something may have been sitting between the two browsers. Start a new share and send the link rather than the code."
              : "This session was broken — the file isn't loaded anymore. The session is closed; you'll need to start a new one to continue."}
          </p>
          <button onClick={startNew}>Start a new transfer</button>
        </div>
      )}

      {status === "error" && (
        <div class="card">
          <h2 class="label">Couldn't connect</h2>
          <p style="margin: 0 0 12px; color: var(--text-muted); font-size: 0.9rem;">
            We couldn't open this session. This usually means a temporary
            network issue or the signaling service being unreachable.
          </p>
          <button onClick={startNew}>Start a new transfer</button>
        </div>
      )}

      <DebugLog log={log} />
    </section>
  );
}

// ─── sub-components ──────────────────────────────────────────────

function StatusLine({ status }: { status: Status }) {
  return (
    <div class="status-wrap">
      <span class="status" data-state={status}>
        <span class="dot" />
        <span>{STATUS_LABEL[status]}</span>
      </span>
    </div>
  );
}

function FilePill({ name, size }: { name: string; size: number }) {
  return (
    <div class="file-line">
      <FileIcon />
      <span class="name">{name}</span>
      <span class="size">{formatBytes(size)}</span>
    </div>
  );
}

function DataPill({ kind, summary }: { kind: "text" | "wifi" | "password" | "card"; summary?: string }) {
  const label = kind === "text" ? "Text snippet"
    : kind === "wifi" ? "Wi-Fi credentials"
    : kind === "password" ? "Login"
    : "Credit card";
  const Icon = kind === "wifi" ? WifiIcon
    : kind === "password" ? KeyIcon
    : kind === "card" ? CardIcon
    : TextIcon;
  return (
    <div class="file-line">
      <Icon />
      <span class="name">{label}</span>
      {summary && <span class="size">{summary}</span>}
    </div>
  );
}

function PayloadPill({ payload }: { payload: Payload }) {
  if (payload.kind === "files") {
    return <FilePill name={payload.bundle.name} size={payload.bundle.size} />;
  }
  return <DataPill kind={payload.kind} summary={inlineSummaryRender(payload)} />;
}

function inlineSummaryRender(d: InlineData): string {
  if (d.kind === "text") return `${d.text.length} chars`;
  if (d.kind === "wifi") return d.ssid;
  if (d.kind === "password") return d.service || d.username;
  if (d.kind === "card") return `•••• ${d.number.slice(-4)}`;
  return "";
}

function GhostPill({ ghost }: { ghost: GhostInfo }) {
  if (ghost.kind === "files") return <FilePill name={ghost.name} size={ghost.size} />;
  return <DataPill kind={ghost.kind} summary={ghost.summary} />;
}

function TextIcon() {
  return (
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d="M5 7h14M7 12h10M9 17h6" stroke-linecap="round" />
    </svg>
  );
}

function WifiIcon() {
  return (
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d="M5 12.55a11 11 0 0 1 14 0M2 8.82a16 16 0 0 1 20 0M8.5 16.43a6 6 0 0 1 7 0M12 20h.01" stroke-linecap="round" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <circle cx="8" cy="15" r="3.5" />
      <path d="M11.2 13.6 21 4M16 9l3 3" stroke-linecap="round" />
    </svg>
  );
}

function CardIcon() {
  return (
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <rect x="2" y="6" width="20" height="13" rx="2" />
      <path d="M2 11h20" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function Lobby({
  mode,
  staged,
  processing,
  textDraft,
  onTextChange,
  onSendText,
  pinDraft,
  onPinDraft,
  wifiSsid,
  wifiPassword,
  wifiSecurity,
  wifiHidden,
  onWifiSsid,
  onWifiPassword,
  onWifiSecurity,
  onWifiHidden,
  onSendWifi,
  pwService,
  pwUsername,
  pwPassword,
  pwNotes,
  onPwService,
  onPwUsername,
  onPwPassword,
  onPwNotes,
  onSendPassword,
  cardName,
  cardNumber,
  cardExpiry,
  cardCvc,
  cardZip,
  onCardName,
  onCardNumber,
  onCardExpiry,
  onCardCvc,
  onCardZip,
  onSendCard,
  onDrop,
  onPickFiles,
  onPickFolder,
  onPickerOpen,
  onPickerCancel,
  onDeletePath,
  onSendStaged,
  onClearStaged,
  isDragging,
  setIsDragging,
}: {
  mode: "files" | "text" | "wifi" | "password" | "card";
  staged: BundleNode[];
  processing: boolean;
  textDraft: string;
  onTextChange: (s: string) => void;
  onSendText: () => void;
  pinDraft: string;
  onPinDraft: (v: string) => void;
  wifiSsid: string;
  wifiPassword: string;
  wifiSecurity: "WPA" | "WEP" | "none";
  wifiHidden: boolean;
  onWifiSsid: (v: string) => void;
  onWifiPassword: (v: string) => void;
  onWifiSecurity: (v: "WPA" | "WEP" | "none") => void;
  onWifiHidden: (v: boolean) => void;
  onSendWifi: () => void;
  pwService: string;
  pwUsername: string;
  pwPassword: string;
  pwNotes: string;
  onPwService: (v: string) => void;
  onPwUsername: (v: string) => void;
  onPwPassword: (v: string) => void;
  onPwNotes: (v: string) => void;
  onSendPassword: () => void;
  cardName: string;
  cardNumber: string;
  cardExpiry: string;
  cardCvc: string;
  cardZip: string;
  onCardName: (v: string) => void;
  onCardNumber: (v: string) => void;
  onCardExpiry: (v: string) => void;
  onCardCvc: (v: string) => void;
  onCardZip: (v: string) => void;
  onSendCard: () => void;
  onDrop: (e: DragEvent) => void;
  onPickFiles: (files: FileList | null) => void;
  onPickFolder: (files: FileList | null) => void;
  onPickerOpen: () => void;
  onPickerCancel: () => void;
  onDeletePath: (path: number[]) => void;
  onSendStaged: () => void;
  onClearStaged: () => void;
  isDragging: boolean;
  setIsDragging: (v: boolean) => void;
}) {
  const filesPickerRef = useRef<HTMLInputElement | null>(null);
  const folderPickerRef = useRef<HTMLInputElement | null>(null);
  const hasStaged = staged.length > 0;
  const hasDraft = textDraft.length > 0;
  const composing = (mode === "files" && hasStaged) || (mode === "text" && hasDraft);
  const draftOver = textDraft.length > MAX_TEXT_LENGTH;
  const pinIncomplete = pinDraft.length > 0 && !PIN_PATTERN.test(pinDraft);
  const pinField = <PinField value={pinDraft} onChange={onPinDraft} />;

  function openFiles() { onPickerOpen(); filesPickerRef.current?.click(); }
  function openFolder() { onPickerOpen(); folderPickerRef.current?.click(); }

  // The cancel event fires when the picker is dismissed without a selection
  // (Chromium 113+, Safari 16.4+). For older browsers our 60s failsafe in
  // SendApp clears the spinner. The DOM event isn't part of Preact's typed
  // props on inputs, so we attach it imperatively.
  useEffect(() => {
    const f = filesPickerRef.current;
    const d = folderPickerRef.current;
    const handler = () => onPickerCancel();
    f?.addEventListener("cancel", handler);
    d?.addEventListener("cancel", handler);
    return () => {
      f?.removeEventListener("cancel", handler);
      d?.removeEventListener("cancel", handler);
    };
  }, [onPickerCancel]);

  const dragHandlers = {
    onDragOver: (e: DragEvent) => { e.preventDefault(); setIsDragging(true); },
    onDragEnter: (e: DragEvent) => { e.preventDefault(); setIsDragging(true); },
    onDragLeave: () => setIsDragging(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      onDrop(e);
    },
  };

  return (
    <section>
      {mode === "files" && !hasStaged && (
        <div class={`dropzone ${isDragging ? "dragging" : ""}`} {...dragHandlers}>
          {processing ? (
            <ProcessingHint message="Reading items…" />
          ) : (
            <>
              <div class="primary">Drop files or a folder</div>
              <p class="hint">or pick from your computer</p>
              <div class="picker-row">
                <button class="ghost" type="button" onClick={openFiles}>
                  Choose files
                </button>
                <button class="ghost" type="button" onClick={openFolder}>
                  Choose folder
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {mode === "files" && hasStaged && (
        <StageCard
          staged={staged}
          processing={processing}
          isDragging={isDragging}
          dragHandlers={dragHandlers}
          onDeletePath={onDeletePath}
          onAddFiles={openFiles}
          onAddFolder={openFolder}
          onSend={onSendStaged}
          onClear={onClearStaged}
        />
      )}

      {mode === "text" && (
        <div class="card text-compose-card">
          <h2 class="label">Compose text</h2>
          <textarea
            class="text-compose"
            placeholder="A password, an SSH key, a config snippet — anything short to share."
            value={textDraft}
            onInput={(e) => onTextChange((e.target as HTMLTextAreaElement).value)}
            rows={6}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
          />
          {pinField}
          <div class="text-compose-meta">
            <span class={`char-count ${draftOver ? "over" : ""}`}>
              {textDraft.length} / {MAX_TEXT_LENGTH}
            </span>
            <button type="button" onClick={onSendText} disabled={!hasDraft || draftOver || pinIncomplete}>
              Send
            </button>
          </div>
          <p class="hint" style="margin-top: 12px; font-size: 0.8rem; color: var(--text-faint);">
            Single-use. Once the receiver taps Receive, the link won't work for anyone else.
          </p>
        </div>
      )}

      {mode === "password" && (
        <form class="card composer-card" onSubmit={(e) => { e.preventDefault(); onSendPassword(); }}>
          <h2 class="label">Compose login</h2>
          <div class="field">
            <label for="pw-service">Service (optional)</label>
            <input
              id="pw-service"
              name="url"
              type="text"
              autocapitalize="off"
              autocomplete="url"
              spellcheck={false}
              value={pwService}
              onInput={(e) => onPwService((e.target as HTMLInputElement).value)}
              placeholder="github.com, Spotify, etc."
            />
          </div>
          <div class="field">
            <label for="pw-username">Username or email</label>
            <input
              id="pw-username"
              name="username"
              type="text"
              autocapitalize="off"
              autocomplete="username"
              spellcheck={false}
              value={pwUsername}
              onInput={(e) => onPwUsername((e.target as HTMLInputElement).value)}
              placeholder="alice@example.com"
            />
          </div>
          <div class="field">
            <label for="pw-password">Password</label>
            <input
              id="pw-password"
              name="password"
              type="text"
              autocapitalize="off"
              autocomplete="current-password"
              spellcheck={false}
              value={pwPassword}
              onInput={(e) => onPwPassword((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="field">
            <label for="pw-notes">Notes (optional)</label>
            <input
              id="pw-notes"
              name="notes"
              type="text"
              value={pwNotes}
              onInput={(e) => onPwNotes((e.target as HTMLInputElement).value)}
              placeholder="2FA recovery, account context, etc."
            />
          </div>
          {pinField}
          <div class="composer-actions">
            <button type="submit" disabled={(!pwUsername.trim() && !pwPassword) || pinIncomplete}>Send</button>
          </div>
          <p class="hint" style="margin-top: 12px; font-size: 0.8rem; color: var(--text-faint);">
            Tap a field to let your password manager fill it. Only share credentials for accounts you own or have authority to share.
          </p>
        </form>
      )}

      {mode === "card" && (
        <form class="card composer-card" onSubmit={(e) => { e.preventDefault(); onSendCard(); }}>
          <h2 class="label">Compose card share</h2>
          <p style="color: var(--warn, #b06000); margin: 0 0 16px; font-size: 0.8rem;">
            For sharing your own card with family/friends — not for merchant
            payments. Your card never touches a server.
          </p>
          {/* cc-* autocomplete tokens trigger Apple Pay / Google Wallet /
              browser-saved cards / 1Password card autofill. */}
          <div class="field">
            <label for="card-number">Card number</label>
            <input
              id="card-number"
              name="cardnumber"
              type="text"
              inputMode="numeric"
              autocomplete="cc-number"
              value={cardNumber}
              onInput={(e) => onCardNumber((e.target as HTMLInputElement).value)}
              placeholder="1234 5678 9012 3456"
            />
          </div>
          <div class="field">
            <label for="card-name">Cardholder name</label>
            <input
              id="card-name"
              name="ccname"
              type="text"
              autocomplete="cc-name"
              value={cardName}
              onInput={(e) => onCardName((e.target as HTMLInputElement).value)}
              placeholder="Name as on card"
            />
          </div>
          <div class="field-row">
            <div class="field">
              <label for="card-expiry">Expiry</label>
              <input
                id="card-expiry"
                name="cc-exp"
                type="text"
                inputMode="numeric"
                autocomplete="cc-exp"
                value={cardExpiry}
                onInput={(e) => onCardExpiry((e.target as HTMLInputElement).value)}
                placeholder="MM/YY"
                maxLength={5}
              />
            </div>
            <div class="field">
              <label for="card-cvc">CVC</label>
              <input
                id="card-cvc"
                name="cvc"
                type="text"
                inputMode="numeric"
                autocomplete="cc-csc"
                value={cardCvc}
                onInput={(e) => onCardCvc((e.target as HTMLInputElement).value)}
                placeholder="123"
                maxLength={4}
              />
            </div>
            <div class="field">
              <label for="card-zip">ZIP (optional)</label>
              <input
                id="card-zip"
                name="postal-code"
                type="text"
                autocomplete="postal-code"
                value={cardZip}
                onInput={(e) => onCardZip((e.target as HTMLInputElement).value)}
                placeholder="12345"
              />
            </div>
          </div>
          {pinField}
          <div class="composer-actions">
            <button type="submit" disabled={!cardNumber || !cardExpiry || !cardCvc || pinIncomplete}>Send</button>
          </div>
          <p class="hint" style="margin-top: 12px; font-size: 0.8rem; color: var(--text-faint);">
            Tap the card-number field — Apple Pay, Google Wallet, your browser's saved cards, or 1Password can fill this for you.
          </p>
        </form>
      )}

      {mode === "wifi" && (
        <form class="card composer-card" onSubmit={(e) => { e.preventDefault(); onSendWifi(); }}>
          <h2 class="label">Compose Wi-Fi share</h2>
          {/* Field names + labels are tuned for 1Password / Bitwarden Wi-Fi
              entry heuristics — they match by 'ssid', 'network name',
              'wifi password' substrings. The HTML autocomplete spec has no
              wifi tokens, so 'username' on the SSID is the closest hint. */}
          <div class="field">
            <label for="wifi-ssid">Network name (SSID)</label>
            <input
              id="wifi-ssid"
              name="ssid"
              type="text"
              autocapitalize="off"
              autocomplete="username"
              spellcheck={false}
              value={wifiSsid}
              onInput={(e) => onWifiSsid((e.target as HTMLInputElement).value)}
              placeholder="MyHomeWifi"
            />
          </div>
          <div class="field">
            <label for="wifi-password">Wi-Fi password</label>
            <input
              id="wifi-password"
              name="wifi-password"
              type="text"
              autocapitalize="off"
              autocomplete="current-password"
              spellcheck={false}
              value={wifiPassword}
              onInput={(e) => onWifiPassword((e.target as HTMLInputElement).value)}
              placeholder={wifiSecurity === "none" ? "(no password)" : ""}
              disabled={wifiSecurity === "none"}
            />
          </div>
          <div class="field-row">
            <div class="field">
              <label for="wifi-security">Security</label>
              <select
                id="wifi-security"
                value={wifiSecurity}
                onChange={(e) => onWifiSecurity((e.target as HTMLSelectElement).value as "WPA" | "WEP" | "none")}
              >
                <option value="WPA">WPA / WPA2 / WPA3</option>
                <option value="WEP">WEP (legacy)</option>
                <option value="none">Open (no password)</option>
              </select>
            </div>
            <label class="field-checkbox">
              <input
                type="checkbox"
                checked={wifiHidden}
                onChange={(e) => onWifiHidden((e.target as HTMLInputElement).checked)}
              />
              <span>Hidden network</span>
            </label>
          </div>
          {pinField}
          <div class="composer-actions">
            <button type="submit" disabled={!wifiSsid.trim() || pinIncomplete}>Send</button>
          </div>
          <p class="hint" style="margin-top: 12px; font-size: 0.8rem; color: var(--text-faint);">
            Tap a field to let your password manager fill from a saved Wi-Fi entry. Receiver scans a QR with their camera to join.
          </p>
        </form>
      )}

      <input
        ref={(el) => { filesPickerRef.current = el; }}
        type="file"
        multiple
        style="display: none;"
        onChange={(e) => {
          const target = e.target as HTMLInputElement;
          onPickFiles(target.files);
          target.value = "";
        }}
      />
      <input
        // webkitdirectory turns this picker into a folder picker. Set via ref
        // because the attribute isn't in lib.dom's HTMLInputElement type yet.
        ref={(el) => {
          if (el) {
            el.setAttribute("webkitdirectory", "");
            el.setAttribute("directory", "");
          }
          folderPickerRef.current = el;
        }}
        type="file"
        multiple
        style="display: none;"
        onChange={(e) => {
          const target = e.target as HTMLInputElement;
          onPickFolder(target.files);
          target.value = "";
        }}
      />

      {!composing && (
        <p class="footnote-receive">
          Got a code from someone? <a href="/r">Receive a transfer →</a>
        </p>
      )}
    </section>
  );
}

function StageCard({
  staged,
  processing,
  isDragging,
  dragHandlers,
  onDeletePath,
  onAddFiles,
  onAddFolder,
  onSend,
  onClear,
}: {
  staged: BundleNode[];
  processing: boolean;
  isDragging: boolean;
  dragHandlers: {
    onDragOver: (e: DragEvent) => void;
    onDragEnter: (e: DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent) => void;
  };
  onDeletePath: (path: number[]) => void;
  onAddFiles: () => void;
  onAddFolder: () => void;
  onSend: () => void;
  onClear: () => void;
}) {
  const fileCount = totalFileCount(staged);
  const bytes = totalSize(staged);
  return (
    <div class={`card stage-card ${isDragging ? "dragging" : ""}`} {...dragHandlers}>
      <div class="stage-header">
        <span class="stage-summary">
          {staged.length} item{staged.length === 1 ? "" : "s"} · {fileCount} file{fileCount === 1 ? "" : "s"} · {formatBytes(bytes)}
        </span>
        <button class="link-btn" type="button" onClick={onClear} disabled={processing}>Clear</button>
      </div>
      <ul class="stage-tree">
        {staged.map((node, i) => (
          <StageNode node={node} path={[i]} depth={0} onDelete={onDeletePath} />
        ))}
      </ul>
      {processing && (
        <div class="stage-processing"><Spinner /> Reading items…</div>
      )}
      <div class="stage-actions">
        <div class="stage-add">
          <button class="ghost" type="button" onClick={onAddFiles} disabled={processing}>+ Files</button>
          <button class="ghost" type="button" onClick={onAddFolder} disabled={processing}>+ Folder</button>
        </div>
        <button type="button" onClick={onSend} disabled={processing}>Send</button>
      </div>
    </div>
  );
}

function ProcessingHint({ message }: { message: string }) {
  return (
    <div class="processing-hint">
      <Spinner />
      <span>{message}</span>
    </div>
  );
}

function Spinner() {
  return <span class="spinner" aria-hidden="true" />;
}

function StageNode({
  node,
  path,
  depth,
  onDelete,
}: {
  node: BundleNode;
  path: number[];
  depth: number;
  onDelete: (path: number[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const indent = { paddingLeft: `${depth * 16}px` };

  if (node.kind === "file") {
    return (
      <li class="stage-row" style={indent}>
        <span class="chev-spacer" />
        <FileIcon />
        <span class="name">{node.file.name}</span>
        <span class="size">{formatBytes(node.file.size)}</span>
        <button class="row-delete" type="button" aria-label="Remove" onClick={() => onDelete(path)}>×</button>
      </li>
    );
  }

  const childCount = totalFileCount([node]);
  const childBytes = totalSize([node]);
  return (
    <>
      <li class="stage-row" style={indent}>
        <button
          class="chev"
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <FolderIcon />
        <span class="name">{node.name}/</span>
        <span class="size">{childCount} file{childCount === 1 ? "" : "s"} · {formatBytes(childBytes)}</span>
        <button class="row-delete" type="button" aria-label="Remove" onClick={() => onDelete(path)}>×</button>
      </li>
      {expanded && node.children.map((child, i) => (
        <StageNode node={child} path={[...path, i]} depth={depth + 1} onDelete={onDelete} />
      ))}
    </>
  );
}

function FolderIcon() {
  return (
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

function ShareCard({
  payload,
  shareUrl,
  roomId,
  qrSvg,
  copyTip,
  onCopy,
  children,
}: {
  payload: Payload;
  shareUrl: string;
  roomId: string;
  qrSvg: string;
  copyTip: string;
  onCopy: (text: string, label: string) => void;
  children?: ComponentChildren;
}) {
  return (
    <div class="card">
      <PayloadPill payload={payload} />

      <div style="margin-top: 24px;">
        <div class="qr-block">
          <div class="qr">
            {qrSvg ? (
              <div dangerouslySetInnerHTML={{ __html: qrSvg }} />
            ) : (
              <span class="qr-placeholder">QR…</span>
            )}
          </div>
        </div>
      </div>

      <div class="code-section" style="margin-top: 24px;">
        <div class="label">code</div>
        <div class="code">{roomId}</div>
      </div>

      <div style="margin-top: 24px;">
        <div class="label">link</div>
        <div class="url-row">
          <input
            type="text"
            value={shareUrl}
            readOnly
            onFocus={(e) => (e.target as HTMLInputElement).select()}
          />
          <button class="ghost" onClick={() => onCopy(shareUrl, "Copied")}>
            {copyTip ? "✓" : "Copy"}
          </button>
        </div>
      </div>

      {children}
    </div>
  );
}

function SessionControls({
  pin,
  expiresInMs,
  onCancel,
}: {
  pin: string | null;
  expiresInMs: number | null;
  onCancel: () => void;
}) {
  const secs = expiresInMs === null ? null : Math.max(0, Math.ceil(expiresInMs / 1000));
  return (
    <div class="session-controls">
      {pin && (
        <div class="pin-block">
          <div class="label">pin</div>
          <div class="code">{pin}</div>
          <p class="pin-hint">
            Tell the receiver this PIN another way — out loud or in a call,
            not in the same chat as the link. Three wrong attempts cancel the
            share.
          </p>
        </div>
      )}
      <div class="session-actions">
        {secs !== null && (
          <span class="session-expiry">
            Expires in {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
          </span>
        )}
        <button class="link-btn" onClick={onCancel}>Cancel share</button>
      </div>
    </div>
  );
}

function PinField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div class="pin-field">
      <label for="share-pin">PIN <span class="optional">(optional)</span></label>
      <input
        id="share-pin"
        class="pin-input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autocomplete="off"
        placeholder="····"
        maxLength={PIN_LENGTH}
        value={value}
        onInput={(e) => onChange((e.target as HTMLInputElement).value.replace(/\D/g, "").slice(0, PIN_LENGTH))}
      />
      <span class="pin-field-hint">
        {value.length > 0 && value.length < PIN_LENGTH
          ? `${PIN_LENGTH} digits`
          : "The receiver has to enter it. Three wrong attempts cancel the share."}
      </span>
    </div>
  );
}

function ConnectionCheck({ words, pending, onConfirm, onReject }: {
  words: string[] | null;
  pending: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  return (
    <div class="connection-check">
      <div class="label">connection words</div>
      <div class="words">{words ? words.join(" ") : "…"}</div>
      <p class="pin-hint">
        With a typed code only the browser's transport encryption protects this
        connection, so the receiver's screen shows the same four words unless
        something sits in between. Compare them out loud before sending.
      </p>
      <div class="session-actions">
        <button onClick={onConfirm} disabled={!pending || !words}>
          {pending ? "They match, send" : "Waiting for the receiver…"}
        </button>
        <button class="link-btn" onClick={onReject}>They differ, cancel</button>
      </div>
    </div>
  );
}

function DeviceLine({ prefix, device }: { prefix: string; device: string }) {
  return (
    <p class="device-line">
      {prefix} <strong>{device}</strong>
    </p>
  );
}

function ProgressBar({ bytes, total }: { bytes: number; total: number }) {
  const pct = total > 0 ? (bytes / total) * 100 : 0;
  return (
    <div class="progress">
      <div class="track">
        <div class="fill" style={`width: ${pct.toFixed(1)}%`} />
      </div>
      <div class="meta">
        <span>{formatBytes(bytes)} / {formatBytes(total)}</span>
        <span>{pct.toFixed(1)}%</span>
      </div>
    </div>
  );
}

function DebugLog({ log }: { log: string[] }) {
  return (
    <details class="debug">
      <summary>Debug log</summary>
      <pre>{log.join("\n")}</pre>
    </details>
  );
}
