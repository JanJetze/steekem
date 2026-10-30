import { useEffect, useRef, useState } from "preact/hooks";
import QRCode from "qrcode";
import { Peer, SignalingClient, deriveKey } from "@steekem/webrtc-core";
import { canStreamToDisk, chooseSink, ensureServiceWorker, type FileSink, type SinkMode } from "../lib/file-sink";
import { useWakeLock } from "../lib/wake-lock";
import { wifiQrPayload, type WifiSecurity } from "../lib/wifi-qr";
import { detectBrand, formatCardNumber } from "../lib/card-brand";
import { deviceLabel } from "../lib/device-label";
import { CODE_LENGTH, isValidCode, parseReceiveHash } from "../lib/share-link";

interface Props {
  signalingUrl: string;
}

type Status =
  | "idle"
  | "connecting"
  | "negotiating"
  | "awaiting-offer"
  | "reviewing"
  | "review-expired"
  | "transferring"
  | "done"
  | "data-shown"
  | "remote-completed"
  | "remote-declined"
  | "remote-aborted"
  | "sender-offline"
  | "closed"
  | "connect-failed"
  | "link-mismatch"
  | "error";

interface FileOffer {
  type: "file-offer";
  name: string;
  size: number;
  mimeType: string;
  pinRequired?: boolean;
}

type InlineData =
  | { kind: "text"; text: string }
  | { kind: "wifi"; ssid: string; password: string; security: WifiSecurity; hidden: boolean }
  | { kind: "password"; service?: string; username: string; password: string; notes?: string }
  | { kind: "card"; name: string; number: string; expiry: string; cvc: string; zip?: string };

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

interface DataPayload {
  type: "data-payload";
  data: InlineData;
}

interface SessionStatusMsg {
  type: "session-status";
  status: "active" | "completed" | "declined" | "aborted";
  file?: { name: string; size: number; mimeType?: string };
  data?: { kind: "text" | "wifi" | "password" | "card"; summary?: string };
}

interface Progress {
  bytes: number;
  total: number;
}

const RAM_BUFFER_LIMIT = 1024 * 1024 * 1024;
const SENDER_OFFLINE_TIMEOUT_MS = 5_000;
// From the Receive tap to an open channel. ICE on a hopeless path otherwise
// sits in "checking" for minutes with nothing to show.
const CONNECT_TIMEOUT_MS = 20_000;
// ICE reports "disconnected" on brief hiccups it often recovers from; only a
// sustained one counts as a lost connection.
const ICE_GRACE_MS = 5_000;
// The Worker allows only two sockets per room, so a receiver idling on the
// offer card (a forgotten tab, or a scanner that never closes) would lock
// the real receiver out. Past this, the tab lets go of its slot.
const REVIEW_TIMEOUT_MS = 2 * 60 * 1000;
const PIN_LENGTH = 4;

const STATUS_LABEL: Record<Status, string> = {
  idle: "ready to receive",
  connecting: "connecting",
  negotiating: "connecting peers",
  "awaiting-offer": "waiting for sender",
  reviewing: "incoming offer",
  "review-expired": "timed out",
  transferring: "receiving",
  done: "saved",
  "data-shown": "received",
  "remote-completed": "already complete",
  "remote-declined": "already declined",
  "remote-aborted": "session canceled",
  "sender-offline": "sender offline",
  closed: "disconnected",
  "connect-failed": "couldn't connect",
  "link-mismatch": "link mismatch",
  error: "error",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function isEndState(s: Status): boolean {
  return (
    s === "done" ||
    s === "data-shown" ||
    s === "review-expired" ||
    s === "remote-completed" ||
    s === "remote-declined" ||
    s === "remote-aborted" ||
    s === "sender-offline" ||
    s === "closed" ||
    s === "connect-failed" ||
    s === "link-mismatch" ||
    s === "error"
  );
}

export default function ReceiverApp({ signalingUrl }: Props) {
  const [typedCode, setTypedCode] = useState<string | null>(null);
  const link = parseReceiveHash(typeof window !== "undefined" ? window.location.hash : "");
  // A typed code was already an explicit "receive", so it connects right
  // away. An opened link only shows the Receive button: link previews, URL
  // scanners and stray tabs load the page too, and must not take the room's
  // single receiver slot.
  if (typedCode) {
    return <ReceiverActive signalingUrl={signalingUrl} initialCode={typedCode} linkSecret={null} autoStart pinHint={false} />;
  }
  // No code in the URL → render the receive landing card with a code input.
  // The sender either shares a link (which lands here with a hash) or speaks
  // the code aloud (and the receiver types it here).
  if (!link.code) {
    return <ReceiveLanding onCode={setTypedCode} />;
  }
  return <ReceiverActive signalingUrl={signalingUrl} initialCode={link.code} linkSecret={link.secret} autoStart={false} pinHint={link.pinHint} />;
}

function ReceiveLanding({ onCode }: { onCode: (code: string) => void }) {
  const [code, setCode] = useState("");
  function go(e: Event) {
    e.preventDefault();
    const c = code.trim().toLowerCase();
    if (!isValidCode(c)) return;
    history.replaceState(null, "", `#${c}`);
    onCode(c);
  }
  return (
    <section>
      <p style="text-align: center; color: var(--text-muted); margin: 0 0 24px;">
        Type the 6-character code the sender gave you.
      </p>
      <div class="card">
        <h2 class="label">Have a code?</h2>
        <form onSubmit={go} class="join-row">
          <input
            type="text"
            placeholder="abc123"
            autoFocus
            autocapitalize="off"
            autocomplete="off"
            spellcheck={false}
            value={code}
            maxLength={CODE_LENGTH}
            onInput={(e) => setCode((e.target as HTMLInputElement).value)}
          />
          <button class="ghost" disabled={!isValidCode(code.trim().toLowerCase())}>
            Receive
          </button>
        </form>
        <p style="color: var(--text-faint); font-size: 0.8rem; margin: 14px 0 0;">
          Or open the link the sender shared — codes also arrive that way.
        </p>
      </div>
      <p class="footnote-receive">
        Want to send something instead? <a href="/">Browse the tools →</a>
      </p>
    </section>
  );
}

function ReceiverActive({ signalingUrl, initialCode, linkSecret, autoStart, pinHint }: {
  signalingUrl: string;
  initialCode: string;
  /** From the link fragment; null when the code was typed. */
  linkSecret: string | null;
  autoStart: boolean;
  pinHint: boolean;
}) {
  const [status, setStatus] = useState<Status>(autoStart ? "connecting" : "idle");
  // Bumped on every Receive tap; each value is one connection attempt. A
  // wrong PIN drops back to idle and the next tap connects afresh.
  const [connectAttempt, setConnectAttempt] = useState(autoStart ? 1 : 0);
  const [incomingOffer, setIncomingOffer] = useState<FileOffer | null>(null);
  const [pinNeeded, setPinNeeded] = useState(pinHint);
  const [pinError, setPinError] = useState<string | null>(null);
  const [checkingPin, setCheckingPin] = useState(false);
  const [incomingData, setIncomingData] = useState<InlineData | null>(null);
  const [remoteFile, setRemoteFile] = useState<{ name: string; size: number } | null>(null);
  const [remoteData, setRemoteData] = useState<{ kind: string; summary?: string } | null>(null);
  const [sinkMode, setSinkMode] = useState<SinkMode | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [log, setLog] = useState<string[]>([]);
  // Shown on code-only connections so the sender can compare them aloud.
  const [connectionWords, setConnectionWords] = useState<string[] | null>(null);

  const peerRef = useRef<Peer | null>(null);
  const iceGraceRef = useRef<number | null>(null);
  // The PIN of the last attempt, so "Try again" doesn't ask for it twice.
  const lastPinRef = useRef<string | undefined>(undefined);
  const signalingRef = useRef<SignalingClient | null>(null);
  const sinkChainRef = useRef<Promise<FileSink> | null>(null);
  const recvBytesRef = useRef(0);
  const recvOfferRef = useRef<FileOffer | null>(null);
  const senderOfflineTimerRef = useRef<number | null>(null);
  // PIN typed on the idle card, sent as soon as the offer asks for one.
  const pendingPinRef = useRef<string | null>(null);
  // What to do with the offer once the PIN check passes.
  const afterPinRef = useRef<(() => void) | null>(null);

  function append(line: string) {
    setLog((prev) => [...prev, `[${new Date().toISOString().slice(11, 19)}] ${line}`]);
  }

  // Keep the screen on while a transfer is in flight.
  useWakeLock(status !== "idle" && !isEndState(status));

  // ── pre-warm Service Worker ─────────────────────────────────────
  useEffect(() => {
    ensureServiceWorker().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      append(`sw warmup failed: ${msg} (will retry on accept)`);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── signaling + peer ────────────────────────────────────────────
  useEffect(() => {
    if (!initialCode || connectAttempt === 0) return;

    let disposed = false;
    let peer: Peer | null = null;
    let signaling: SignalingClient | null = null;
    let unsub: (() => void) | null = null;
    setConnectionWords(null);

    (async () => {
      let key: CryptoKey | null = null;
      if (linkSecret) {
        try { key = await deriveKey(linkSecret, initialCode); }
        catch (err) {
          append(`key derivation failed: ${(err as Error).message}`);
          setStatus("link-mismatch");
          return;
        }
      }
      if (disposed) return;

      signaling = new SignalingClient(`${signalingUrl}/room/${initialCode}`);
      const sig = signaling;
      // A link carries the key, so a sender who hands out this link must
      // have it too: plaintext from that side is rejected outright.
      const p = new Peer({
        signaling: sig,
        key,
        plaintext: "reject",
        onEvent: (e) => {
          if (e.type === "channel-open") {
            handleChannelOpen();
          } else if (e.type === "channel-close") {
            append("datachannel closed");
          } else if (e.type === "channel-message") {
            handleChannelMessage(e.data);
          } else if (e.type === "ice-state") {
            append(`ice: ${e.state}`);
            handleIceState(e.state);
          } else if (e.type === "encryption") {
            append(`channel protection: ${e.mode === "e2e" ? "link key" : "DTLS only"}`);
          } else if (e.type === "crypto-error") {
            append(`crypto error: ${e.error.message}`);
            setStatus((s) => (isEndState(s) ? s : "link-mismatch"));
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
          if (r === "sender") {
            // Worker assigned us sender — that means the room is empty,
            // i.e. the sender isn't here. We can't actually send anything,
            // so report the room as offline.
            append("no sender in this room");
            setStatus("sender-offline");
            return;
          }
          setStatus("negotiating");
        } else if (msg.type === "partner-joined") {
          // Another peer arrived; this can happen if sender reconnects
          // after a hiccup. Just renegotiate from their side.
        } else if (msg.type === "partner-left") {
          setStatus((s) => (isEndState(s) ? s : "sender-offline"));
        }
      });

      // Retry once after a brief delay — covers the race where a previous
      // receiver's WS hasn't fully closed yet on the Worker side, leaving the
      // room momentarily at capacity.
      try {
        await sig.connect();
      } catch (err) {
        append(`connect err: ${(err as Error).message}, retrying in 2s…`);
        await new Promise((r) => setTimeout(r, 2000));
        if (disposed) return;
        try {
          await sig.connect();
        } catch (err2) {
          append(`retry failed: ${(err2 as Error).message}`);
          setStatus("error");
        }
      }
    })();

    return () => {
      disposed = true;
      unsub?.();
      peer?.close();
      signaling?.close();
      peerRef.current = null;
      signalingRef.current = null;
      clearSenderOfflineTimer();
      clearIceGrace();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode, signalingUrl, connectAttempt]);

  // ── give up when no channel opens in time ───────────────────────
  useEffect(() => {
    if (status !== "connecting" && status !== "negotiating") return;
    const id = window.setTimeout(() => {
      append(`no connection after ${CONNECT_TIMEOUT_MS / 1000}s`);
      setStatus((s) => (s === "connecting" || s === "negotiating" ? "connect-failed" : s));
    }, CONNECT_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [status]);

  function clearIceGrace() {
    if (iceGraceRef.current !== null) {
      clearTimeout(iceGraceRef.current);
      iceGraceRef.current = null;
    }
  }

  function handleIceState(state: RTCIceConnectionState) {
    if (state === "connected" || state === "completed") {
      clearIceGrace();
      return;
    }
    if (state === "failed") {
      clearIceGrace();
      setStatus((s) => (isEndState(s) ? s : "connect-failed"));
      return;
    }
    if (state === "disconnected" && iceGraceRef.current === null) {
      iceGraceRef.current = window.setTimeout(() => {
        iceGraceRef.current = null;
        setStatus((s) => (isEndState(s) ? s : "connect-failed"));
      }, ICE_GRACE_MS);
    }
  }

  // ── auto-disconnect on end-state (or back to idle) to free the slot ─
  useEffect(() => {
    if (!isEndState(status) && status !== "idle") return;
    peerRef.current?.close();
    signalingRef.current?.close();
    peerRef.current = null;
    signalingRef.current = null;
  }, [status]);

  // ── give up the room slot if the offer sits unanswered ──────────
  useEffect(() => {
    if (status !== "reviewing") return;
    const id = window.setTimeout(() => {
      append("offer left unanswered, releasing room slot");
      setStatus((s) => (s === "reviewing" ? "review-expired" : s));
    }, REVIEW_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [status]);

  // ── handle channel-open: arm the sender-offline timer ───────────
  function handleChannelOpen() {
    setStatus("awaiting-offer");
    const peer = peerRef.current;
    try {
      // First message on the channel: encrypted when this page holds the link
      // secret, plaintext when the code was typed. The sender reads the
      // protection level off that.
      peer?.send(JSON.stringify({ type: "receiver-hello", device: deviceLabel(navigator.userAgent), e2e: linkSecret !== null }));
    } catch { /* informational only */ }
    if (!linkSecret && peer) {
      peer.connectionWords()
        .then((words) => {
          setConnectionWords(words);
          if (words) append(`connection words: ${words.join(" ")}`);
        })
        .catch(() => { /* the sender simply cannot confirm without them */ });
    }
    senderOfflineTimerRef.current = window.setTimeout(() => {
      senderOfflineTimerRef.current = null;
      setStatus((s) => (s === "awaiting-offer" ? "sender-offline" : s));
    }, SENDER_OFFLINE_TIMEOUT_MS);
  }

  function clearSenderOfflineTimer() {
    if (senderOfflineTimerRef.current != null) {
      clearTimeout(senderOfflineTimerRef.current);
      senderOfflineTimerRef.current = null;
    }
  }

  // ── messages on the data channel ────────────────────────────────
  function handleChannelMessage(data: string | ArrayBuffer | Blob) {
    if (typeof data === "string") {
      let parsed: { type?: string; [k: string]: unknown };
      try { parsed = JSON.parse(data); }
      catch { return; }

      if (parsed.type === "session-status") {
        clearSenderOfflineTimer();
        const ss = parsed as unknown as SessionStatusMsg;
        if (ss.status === "active") {
          setStatus("awaiting-offer");
        } else if (ss.status === "completed") {
          if (ss.file) setRemoteFile(ss.file);
          if (ss.data) setRemoteData(ss.data);
          setStatus("remote-completed");
          append("sender said: completed");
        } else if (ss.status === "declined") {
          if (ss.file) setRemoteFile(ss.file);
          if (ss.data) setRemoteData(ss.data);
          setStatus("remote-declined");
          append("sender said: declined");
        } else if (ss.status === "aborted") {
          setStatus("remote-aborted");
          append("sender said: aborted");
        }
        return;
      }

      if (parsed.type === "file-offer") {
        const offer = parsed as unknown as FileOffer;
        append(`file-offer received: ${offer.name} (${formatBytes(offer.size)})`);
        handleOffer(offer.pinRequired === true, () => {
          recvOfferRef.current = offer;
          setIncomingOffer(offer);
          setStatus("reviewing");
        });
        return;
      }

      if (parsed.type === "data-offer") {
        const offer = parsed as unknown as DataOffer;
        append(`data-offer received (kind=${offer.kind})`);
        // Tapping Receive (plus the PIN, if any) already was the consent,
        // so there is nothing left to ask; reveal straight away.
        handleOffer(offer.pinRequired === true, () => {
          try { peerRef.current?.send(JSON.stringify({ type: "data-accept" })); } catch { /* ignore */ }
          append("accepted data");
        });
        return;
      }

      if (parsed.type === "pin-result") {
        const result = parsed as unknown as PinResult;
        setCheckingPin(false);
        pendingPinRef.current = null;
        const next = afterPinRef.current;
        afterPinRef.current = null;
        if (result.ok) {
          setPinError(null);
          append("pin accepted");
          next?.();
          return;
        }
        append(`pin rejected (${result.attemptsLeft} left)`);
        if (result.attemptsLeft === 0) {
          // The sender cancels the share now; no point waiting for its
          // session-status before showing that.
          setStatus("remote-aborted");
          return;
        }
        setPinError(`Wrong PIN. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? "attempt" : "attempts"} left.`);
        setStatus("idle");
        return;
      }

      if (parsed.type === "data-payload") {
        const payload = parsed as unknown as DataPayload;
        setIncomingData(payload.data);
        // data-shown is treated as an end state: the inline payload has
        // arrived on this device, the sender is no longer needed. The
        // auto-disconnect useEffect will close the channel + signaling,
        // freeing the room slot. Wake lock turns off. Sender disconnects
        // no longer matter.
        setStatus("data-shown");
        append(`data-payload received (kind=${payload.data.kind})`);
        return;
      }
      return;
    }

    if (data instanceof ArrayBuffer) {
      const offer = recvOfferRef.current;
      const chain = sinkChainRef.current;
      if (!offer || !chain) return;
      const len = data.byteLength;
      recvBytesRef.current += len;
      setProgress({ bytes: recvBytesRef.current, total: offer.size });

      sinkChainRef.current = chain.then(async (sink) => {
        await sink.write(data);
        return sink;
      }).catch((err) => {
        append(`write err: ${(err as Error).message}`);
        setStatus("error");
        throw err;
      });

      if (recvBytesRef.current >= offer.size) {
        finishReceive(offer);
      }
    }
  }

  async function finishReceive(offer: FileOffer) {
    const chain = sinkChainRef.current;
    if (!chain) return;
    try {
      const sink = await chain;
      await sink.close();
      if (sink.mode === "blob") setDownloadUrl(sink.downloadUrl);
      setStatus("done");
      append(`receive complete: ${offer.name}`);
    } catch (err) {
      append(`finish err: ${(err as Error).message}`);
      setStatus("error");
    } finally {
      sinkChainRef.current = null;
    }
  }

  // ── user actions ────────────────────────────────────────────────
  async function acceptOffer() {
    const offer = recvOfferRef.current;
    const peer = peerRef.current;
    if (!offer || !peer) return;

    sinkChainRef.current = chooseSink({
      name: offer.name,
      size: offer.size,
      mimeType: offer.mimeType || "application/octet-stream",
    }, append).then((sink) => {
      setSinkMode(sink.mode);
      append(`→ sink: ${sink.mode}`);
      return sink;
    });

    recvBytesRef.current = 0;
    setProgress({ bytes: 0, total: offer.size });
    setStatus("transferring");
    peer.send(JSON.stringify({ type: "file-accept" }));
    append(`accepted ${offer.name}`);
  }

  function startReceiving(pin?: string) {
    lastPinRef.current = pin;
    pendingPinRef.current = pin ?? null;
    afterPinRef.current = null;
    setPinError(null);
    setStatus("connecting");
    setConnectAttempt((n) => n + 1);
  }

  // A PIN-protected offer is only acted on after the sender confirms the
  // PIN. Without a PIN in hand (link lacked ".p", or a typed code) the
  // receiver lets go of the room and asks for one, rather than holding the
  // only receiver slot while someone types.
  function handleOffer(pinRequired: boolean, proceed: () => void) {
    if (!pinRequired) {
      proceed();
      return;
    }
    const pin = pendingPinRef.current;
    if (!pin) {
      append("share needs a PIN");
      setPinNeeded(true);
      setStatus("idle");
      return;
    }
    afterPinRef.current = proceed;
    setCheckingPin(true);
    try { peerRef.current?.send(JSON.stringify({ type: "pin-check", pin })); } catch { /* ignore */ }
  }

  function declineOffer(reason?: string) {
    const peer = peerRef.current;
    try { peer?.send(JSON.stringify({ type: "file-reject", reason })); } catch {}
    setStatus("closed");
    append("declined");
  }

  // ── render ──────────────────────────────────────────────────────
  return (
    <section>
      <StatusLine status={status} />

      {status === "idle" && (
        <IdleCard pinNeeded={pinNeeded} pinError={pinError} onReceive={startReceiving} />
      )}

      {(status === "connecting" || status === "negotiating" || status === "awaiting-offer") && (
        <div class="card">
          <h2 class="label">{checkingPin ? "Checking PIN" : "Connecting"}</h2>
          <p style="margin: 0; color: var(--text-muted);">
            {checkingPin ? "Asking the sender to confirm the PIN…" : "Waiting for the sender…"}
          </p>
          {!linkSecret && connectionWords && status === "awaiting-offer" && !checkingPin && (
            <div class="connection-check">
              <div class="label">connection words</div>
              <div class="words">{connectionWords.join(" ")}</div>
              <p class="pin-hint">
                You typed the code, so the sender confirms these four words with
                you before releasing anything. Their screen shows the same ones.
              </p>
            </div>
          )}
        </div>
      )}

      {status === "connect-failed" && (
        <div class="card">
          <h2 class="label">Couldn't connect</h2>
          <p style="margin: 0 0 12px; color: var(--text-muted); font-size: 0.9rem;">
            Your browser and the sender's couldn't find a direct path to each
            other. Steekem has no relay server, so nothing was sent. The usual
            causes:
          </p>
          <ul style="margin: 0 0 16px 18px; padding: 0; color: var(--text-muted); font-size: 0.875rem;">
            <li>A strict firewall, a VPN, or a mobile network that blocks peer-to-peer traffic.</li>
            <li>The sender's tab went to sleep or was closed.</li>
          </ul>
          <p style="margin: 0 0 16px; color: var(--text-muted); font-size: 0.875rem;">
            Trying again usually works, especially with both devices on the same Wi-Fi.
          </p>
          <button onClick={() => startReceiving(lastPinRef.current)} style="width: 100%;">Try again</button>
        </div>
      )}

      {status === "link-mismatch" && (
        <div class="card">
          <h2 class="label">Link doesn't match</h2>
          <p style="margin: 0; color: var(--text-muted); font-size: 0.9rem;">
            The key in this link doesn't fit the sender's share, so this page
            refused to read anything from it. The link may have been cut off or
            altered on the way. Ask the sender to copy it again.
          </p>
        </div>
      )}

      {status === "reviewing" && incomingOffer && (
        <ReceiverOfferCard
          offer={incomingOffer}
          onAccept={acceptOffer}
          onDecline={() => declineOffer()}
        />
      )}

      {status === "review-expired" && (
        <div class="card">
          <h2 class="label">Timed out</h2>
          <p style="margin: 0 0 16px; color: var(--text-muted); font-size: 0.9rem;">
            This page sat idle, so it let go of the connection to keep the link
            free. Nothing was received. Reload to try again.
          </p>
          <button class="ghost" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}

      {status === "data-shown" && incomingData?.kind === "text" && (
        <TextReceivedCard text={incomingData.text} />
      )}

      {status === "data-shown" && incomingData?.kind === "wifi" && (
        <WifiReceivedCard data={incomingData} />
      )}

      {status === "data-shown" && incomingData?.kind === "password" && (
        <PasswordReceivedCard data={incomingData} />
      )}

      {status === "data-shown" && incomingData?.kind === "card" && (
        <CardReceivedCard data={incomingData} />
      )}

      {status === "transferring" && incomingOffer && progress && (
        <div class="card">
          <h2 class="label">Receiving</h2>
          <FilePill name={incomingOffer.name} size={incomingOffer.size} />
          <div style="height: 16px;" />
          <ProgressBar bytes={progress.bytes} total={progress.total} />
        </div>
      )}

      {status === "done" && incomingOffer && sinkMode === "stream" && (
        <div class="card">
          <h2 class="label">Saved</h2>
          <FilePill name={incomingOffer.name} size={incomingOffer.size} />
          <p style="color: var(--text-muted); margin: 16px 0 0; font-size: 0.875rem;">
            Streamed straight to your downloads.
          </p>
        </div>
      )}

      {status === "done" && incomingOffer && sinkMode === "blob" && (
        <BlobDoneCard offer={incomingOffer} downloadUrl={downloadUrl} />
      )}

      {status === "remote-completed" && (
        <div class="card">
          <h2 class="label">{remoteData ? "Already used" : "Already complete"}</h2>
          {remoteFile && <FilePill name={remoteFile.name} size={remoteFile.size} />}
          {remoteData && <DataPill kind={remoteData.kind} summary={remoteData.summary} />}
          <p style="color: var(--text-muted); margin: 16px 0 0; font-size: 0.9rem;">
            {remoteData
              ? "This was a single-use share and has already been delivered. Ask the sender to start a fresh session if you need it again."
              : "This transfer was completed earlier. Your copy isn't here — ask the sender to start a fresh session if you need it again."}
          </p>
        </div>
      )}

      {status === "remote-declined" && (
        <div class="card">
          <h2 class="label">Already declined</h2>
          {remoteFile && <FilePill name={remoteFile.name} size={remoteFile.size} />}
          {remoteData && <DataPill kind={remoteData.kind} summary={remoteData.summary} />}
          <p style="color: var(--text-muted); margin: 16px 0 0; font-size: 0.9rem;">
            This transfer was declined.
          </p>
        </div>
      )}

      {status === "remote-aborted" && (
        <div class="card">
          <h2 class="label">Session canceled</h2>
          <p style="margin: 0; color: var(--text-muted); font-size: 0.9rem;">
            The sender canceled this session. Ask them for a fresh link.
          </p>
        </div>
      )}

      {status === "sender-offline" && (
        <div class="card">
          <h2 class="label">Sender offline</h2>
          <p style="margin: 0 0 16px; color: var(--text-muted); font-size: 0.9rem;">
            We connected to the room but the sender isn't responding. Ask them
            to keep their tab open and share a fresh link.
          </p>
          <a class="button ghost" href="/send">Start a transfer</a>
        </div>
      )}

      {status === "closed" && (
        <div class="card">
          <h2 class="label">Disconnected</h2>
          <p style="margin: 0; color: var(--text-muted);">
            The connection ended. Ask the sender for a fresh link.
          </p>
        </div>
      )}

      {status === "error" && (
        <div class="card">
          <h2 class="label">Couldn't connect</h2>
          <p style="margin: 0 0 12px; color: var(--text-muted); font-size: 0.9rem;">
            We weren't able to reach this transfer. The most likely reasons:
          </p>
          <ul style="margin: 0 0 16px 18px; padding: 0; color: var(--text-muted); font-size: 0.875rem;">
            <li>The sender closed their tab.</li>
            <li>Another receiver is still finishing up — try again in a few seconds.</li>
            <li>A temporary network hiccup.</li>
          </ul>
          <a class="button ghost" href="/send">Start a transfer</a>
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

function DataPill({ kind, summary }: { kind: string; summary?: string }) {
  const label = kind === "text" ? "Text snippet"
    : kind === "wifi" ? "Wi-Fi credentials"
    : kind === "password" ? "Password"
    : kind === "card" ? "Credit card"
    : kind;
  return (
    <div class="file-line">
      <TextIcon />
      <span class="name">{label}</span>
      {summary && <span class="size">{summary}</span>}
    </div>
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

function TextIcon() {
  return (
    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <path d="M5 7h14M7 12h10M9 17h6" stroke-linecap="round" />
    </svg>
  );
}

const REVEAL_DURATION_S = 5;
const SESSION_DURATION_S = 5 * 60;

function formatMMSS(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const WIFI_SESSION_S = 5 * 60;
const PW_SESSION_S = 5 * 60;
const PW_REVEAL_S = 5;
const CARD_SESSION_S = 5 * 60;
const CARD_REVEAL_S = 5;

function CardReceivedCard({ data }: { data: { name: string; number: string; expiry: string; cvc: string; zip?: string } }) {
  const [revealed, setRevealed] = useState(false);
  const [revealLeft, setRevealLeft] = useState(0);
  const [sessionLeft, setSessionLeft] = useState(CARD_SESSION_S);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const brand = detectBrand(data.number);
  const formatted = formatCardNumber(data.number, brand);
  const last4 = data.number.slice(-4);
  const masked = `•••• •••• •••• ${last4}`;

  function clearTick() {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  function reveal() {
    if (expired) return;
    setRevealed(true);
    setRevealLeft(CARD_REVEAL_S);
    clearTick();
    tickRef.current = setInterval(() => {
      setRevealLeft((prev) => {
        if (prev <= 1) {
          clearTick();
          setRevealed(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  function hide() {
    clearTick();
    setRevealed(false);
    setRevealLeft(0);
  }

  function discard() {
    clearTick();
    setRevealed(false);
    setExpired(true);
    setSessionLeft(0);
  }

  useEffect(() => {
    const id = setInterval(() => {
      setSessionLeft((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          setRevealed(false);
          setExpired(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      clearInterval(id);
      clearTick();
    };
  }, []);

  async function copy(label: string, value: string) {
    if (expired) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* ignore */ }
  }

  if (expired) {
    return (
      <div class="card">
        <h2 class="label">Discarded</h2>
        <p style="margin: 0; color: var(--text-muted); font-size: 0.875rem;">
          The card details have been discarded.
        </p>
      </div>
    );
  }

  return (
    <div class="card">
      <h2 class="label">Card received</h2>
      <p style="color: var(--text-muted); margin: 0 0 16px; font-size: 0.875rem;">
        Use only for the trusted recipient who asked for this. The bytes never
        passed through any server.
      </p>

      <div class="card-visual">
        <div class="card-brand">{brand}</div>
        <div class="card-number">{revealed ? formatted : masked}</div>
        <div class="card-bottom">
          <div>
            <div class="card-mini-label">Holder</div>
            <div class="card-mini-value">{data.name || "—"}</div>
          </div>
          <div>
            <div class="card-mini-label">Expiry</div>
            <div class="card-mini-value">{data.expiry}</div>
          </div>
        </div>
      </div>

      <div class="field-row-display">
        <div class="field-display">
          <span class="field-label">Number</span>
          <span class="field-value mono">{revealed ? formatted : masked}</span>
        </div>
        <div style="display: flex; gap: 6px; flex-shrink: 0;">
          {revealed ? (
            <button class="ghost field-copy" type="button" onClick={hide}>Hide</button>
          ) : (
            <button class="ghost field-copy" type="button" onClick={reveal}>Reveal</button>
          )}
          <button class="ghost field-copy" type="button" onClick={() => copy("number", data.number)}>
            {copied === "number" ? "✓" : "Copy"}
          </button>
        </div>
      </div>
      {revealed && (
        <div class="reveal-timer">Hides in {revealLeft}s</div>
      )}
      <div class="field-row-display">
        <div class="field-display">
          <span class="field-label">Expiry</span>
          <span class="field-value mono">{data.expiry}</span>
        </div>
        <button class="ghost field-copy" type="button" onClick={() => copy("expiry", data.expiry)}>
          {copied === "expiry" ? "✓" : "Copy"}
        </button>
      </div>
      <div class="field-row-display">
        <div class="field-display">
          <span class="field-label">CVC</span>
          <span class="field-value mono">{revealed ? data.cvc : "•".repeat(data.cvc.length)}</span>
        </div>
        <button class="ghost field-copy" type="button" onClick={() => copy("cvc", data.cvc)}>
          {copied === "cvc" ? "✓" : "Copy"}
        </button>
      </div>
      {data.zip && (
        <div class="field-row-display">
          <div class="field-display">
            <span class="field-label">ZIP</span>
            <span class="field-value mono">{data.zip}</span>
          </div>
          <button class="ghost field-copy" type="button" onClick={() => copy("zip", data.zip!)}>
            {copied === "zip" ? "✓" : "Copy"}
          </button>
        </div>
      )}
      <div class="session-meta">
        <span>Auto-discards in {formatMMSS(sessionLeft)}</span>
        <button class="link-btn" type="button" onClick={discard}>Discard now</button>
      </div>
    </div>
  );
}


/** Capability check for the W3C Credential Management API. Chromium-only as
 *  of mid-2026 — Safari and Firefox don't ship the PasswordCredential
 *  constructor. The browser stores under the current origin; password-
 *  manager browser extensions (1Password, Bitwarden) intercept the prompt
 *  and let users edit the URL/name before saving to their vault. */
function canStoreCredential(): boolean {
  return typeof window !== "undefined"
    && "PasswordCredential" in window
    && typeof navigator !== "undefined"
    && !!navigator.credentials?.store;
}

function PasswordReceivedCard({ data }: { data: { service?: string; username: string; password: string; notes?: string } }) {
  const [revealed, setRevealed] = useState(false);
  const [revealLeft, setRevealLeft] = useState(0);
  const [sessionLeft, setSessionLeft] = useState(PW_SESSION_S);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function clearTick() {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  function reveal() {
    if (expired) return;
    setRevealed(true);
    setRevealLeft(PW_REVEAL_S);
    clearTick();
    tickRef.current = setInterval(() => {
      setRevealLeft((prev) => {
        if (prev <= 1) {
          clearTick();
          setRevealed(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  function hide() {
    clearTick();
    setRevealed(false);
    setRevealLeft(0);
  }

  function discard() {
    clearTick();
    setRevealed(false);
    setExpired(true);
    setSessionLeft(0);
  }

  useEffect(() => {
    const id = setInterval(() => {
      setSessionLeft((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          setRevealed(false);
          setExpired(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      clearInterval(id);
      clearTick();
    };
  }, []);

  async function copy(label: string, value: string) {
    if (expired) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* ignore */ }
  }

  async function saveToManager() {
    if (expired) return;
    if (!canStoreCredential()) return;
    setSaving(true);
    try {
      const cred = new (window as unknown as { PasswordCredential: new (init: { id: string; password: string; name?: string }) => Credential }).PasswordCredential({
        id: data.username,
        password: data.password,
        name: data.service ?? data.username,
      });
      await navigator.credentials.store(cred);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      /* user dismissed the prompt or browser declined — silent */
    } finally {
      setSaving(false);
    }
  }

  if (expired) {
    return (
      <div class="card">
        <h2 class="label">Discarded</h2>
        <p style="margin: 0; color: var(--text-muted); font-size: 0.875rem;">
          The login has been discarded.
        </p>
      </div>
    );
  }

  const showSave = canStoreCredential() && !!data.password;

  return (
    <div class="card">
      <h2 class="label">Login received</h2>
      {data.service && (
        <p style="color: var(--text-muted); margin: 0 0 16px; font-size: 0.875rem;">
          For <strong style="color: var(--text);">{data.service}</strong>
        </p>
      )}
      <div class="field-row-display">
        <div class="field-display">
          <span class="field-label">Username</span>
          <span class="field-value mono">{data.username || <em style="color: var(--text-faint);">(none)</em>}</span>
        </div>
        {data.username && (
          <button class="ghost field-copy" type="button" onClick={() => copy("username", data.username)}>
            {copied === "username" ? "✓" : "Copy"}
          </button>
        )}
      </div>
      <div class="field-row-display">
        <div class="field-display">
          <span class="field-label">Password</span>
          {revealed ? (
            <span class="field-value mono">{data.password}</span>
          ) : (
            <span class="field-value mono">{"•".repeat(Math.min(data.password.length, 32))}</span>
          )}
        </div>
        <div style="display: flex; gap: 6px; flex-shrink: 0;">
          {revealed ? (
            <button class="ghost field-copy" type="button" onClick={hide}>Hide</button>
          ) : (
            <button class="ghost field-copy" type="button" onClick={reveal}>Reveal</button>
          )}
          <button class="ghost field-copy" type="button" onClick={() => copy("password", data.password)}>
            {copied === "password" ? "✓" : "Copy"}
          </button>
        </div>
      </div>
      {revealed && (
        <div class="reveal-timer">Hides in {revealLeft}s</div>
      )}
      {data.notes && (
        <div class="field-row-display">
          <div class="field-display">
            <span class="field-label">Notes</span>
            <span class="field-value">{data.notes}</span>
          </div>
          <button class="ghost field-copy" type="button" onClick={() => copy("notes", data.notes!)}>
            {copied === "notes" ? "✓" : "Copy"}
          </button>
        </div>
      )}
      {showSave && (
        <div style="margin-top: 16px;">
          <button type="button" onClick={saveToManager} disabled={saving || saved} style="width: 100%;">
            {saved ? "Saved ✓" : saving ? "Saving…" : "Save to password manager"}
          </button>
          <p style="margin: 8px 0 0; font-size: 0.75rem; color: var(--text-faint); text-align: center;">
            Opens your browser's save-password prompt. Works with 1Password, Bitwarden, and built-in managers.
          </p>
        </div>
      )}
      <div class="session-meta">
        <span>Auto-discards in {formatMMSS(sessionLeft)}</span>
        <button class="link-btn" type="button" onClick={discard}>Discard now</button>
      </div>
    </div>
  );
}


function WifiReceivedCard({ data }: { data: { ssid: string; password: string; security: WifiSecurity; hidden: boolean } }) {
  const [qrSvg, setQrSvg] = useState<string>("");
  const [sessionLeft, setSessionLeft] = useState(WIFI_SESSION_S);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState<"ssid" | "password" | null>(null);

  useEffect(() => {
    QRCode.toString(wifiQrPayload(data), {
      type: "svg",
      margin: 0,
      color: { dark: "#0b0d10", light: "#ffffff" },
    }).then(setQrSvg).catch(() => { /* ignore */ });
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setSessionLeft((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          setExpired(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  async function copy(field: "ssid" | "password") {
    try {
      await navigator.clipboard.writeText(field === "ssid" ? data.ssid : data.password);
      setCopied(field);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* ignore */ }
  }

  function discard() {
    setExpired(true);
    setSessionLeft(0);
  }

  if (expired) {
    return (
      <div class="card">
        <h2 class="label">Discarded</h2>
        <p style="margin: 0; color: var(--text-muted); font-size: 0.875rem;">
          The Wi-Fi credentials have been discarded.
        </p>
      </div>
    );
  }

  const securityLabel = data.security === "none" ? "Open" : data.security;

  return (
    <div class="card">
      <h2 class="label">Wi-Fi credentials</h2>
      <p style="color: var(--text-muted); margin: 0 0 16px; font-size: 0.875rem;">
        {data.hidden
          ? "Hidden network — type the values into your Wi-Fi settings."
          : "Scan the code with your camera to join, or use the values below."}
      </p>
      {!data.hidden && (
        <div class="qr-block" style="margin-bottom: 16px;">
          <div class="qr">
            {qrSvg ? <div dangerouslySetInnerHTML={{ __html: qrSvg }} /> : <span class="qr-placeholder">…</span>}
          </div>
        </div>
      )}
      <div class="field-row-display">
        <div class="field-display">
          <span class="field-label">Network</span>
          <span class="field-value">{data.ssid}</span>
        </div>
        <button class="ghost field-copy" type="button" onClick={() => copy("ssid")}>
          {copied === "ssid" ? "✓" : "Copy"}
        </button>
      </div>
      {data.security !== "none" && (
        <div class="field-row-display">
          <div class="field-display">
            <span class="field-label">Password</span>
            <span class="field-value mono">{data.password}</span>
          </div>
          <button class="ghost field-copy" type="button" onClick={() => copy("password")}>
            {copied === "password" ? "✓" : "Copy"}
          </button>
        </div>
      )}
      <div class="field-row-display">
        <div class="field-display">
          <span class="field-label">Security</span>
          <span class="field-value">{securityLabel}</span>
        </div>
      </div>
      <div class="session-meta">
        <span>Auto-discards in {formatMMSS(sessionLeft)}</span>
        <button class="link-btn" type="button" onClick={discard}>Discard now</button>
      </div>
    </div>
  );
}

function TextReceivedCard({ text }: { text: string }) {
  const [revealed, setRevealed] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [sessionLeft, setSessionLeft] = useState(SESSION_DURATION_S);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyErr, setCopyErr] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function clearTick() {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  function reveal() {
    if (expired) return;
    setRevealed(true);
    setSecondsLeft(REVEAL_DURATION_S);
    clearTick();
    tickRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearTick();
          setRevealed(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }

  function hide() {
    clearTick();
    setRevealed(false);
    setSecondsLeft(0);
  }

  function discard() {
    clearTick();
    setRevealed(false);
    setSecondsLeft(0);
    setSessionLeft(0);
    setExpired(true);
  }

  // Session-wide countdown: regardless of interaction, the snippet becomes
  // unreachable after SESSION_DURATION_S. Prevents stale tabs from being a
  // long-lived secret reservoir.
  useEffect(() => {
    const id = setInterval(() => {
      setSessionLeft((prev) => {
        if (prev <= 1) {
          clearInterval(id);
          setRevealed(false);
          setSecondsLeft(0);
          setExpired(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      clearInterval(id);
      clearTick();
    };
  }, []);

  async function copy() {
    if (expired) return;
    setCopyErr(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopyErr(true);
    }
  }

  if (expired) {
    return (
      <div class="card">
        <h2 class="label">Discarded</h2>
        <p style="margin: 0; color: var(--text-muted); font-size: 0.875rem;">
          This snippet has been discarded. Ask the sender for a fresh link
          if you need it.
        </p>
      </div>
    );
  }

  return (
    <div class="card">
      <h2 class="label">Incoming text</h2>
      <p style="color: var(--text-muted); margin: 0 0 16px; font-size: 0.875rem;">
        Single-use snippet from the sender — {text.length} characters.
      </p>
      {revealed ? (
        <>
          <pre class="text-reveal">{text}</pre>
          <div class="reveal-timer">Hides in {secondsLeft}s</div>
        </>
      ) : (
        <div class="text-hidden">
          {"•".repeat(Math.min(text.length, 32))}
          {text.length > 32 ? "…" : ""}
        </div>
      )}
      <div style="display: flex; gap: 8px; margin-top: 16px;">
        {revealed ? (
          <button class="ghost" type="button" onClick={hide} style="flex: 1;">Hide</button>
        ) : (
          <button class="ghost" type="button" onClick={reveal} style="flex: 1;">Reveal</button>
        )}
        <button type="button" onClick={copy} style="flex: 1;">
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <div class="session-meta">
        <span>Auto-discards in {formatMMSS(sessionLeft)}</span>
        <button class="link-btn" type="button" onClick={discard}>Discard now</button>
      </div>
      {copyErr && (
        <p style="margin: 12px 0 0; font-size: 0.8rem; color: var(--danger);">
          Clipboard write failed — reveal the text and copy manually.
        </p>
      )}
    </div>
  );
}

function IdleCard({ pinNeeded, pinError, onReceive }: {
  pinNeeded: boolean;
  pinError: string | null;
  onReceive: (pin?: string) => void;
}) {
  const [pin, setPin] = useState("");
  const ready = !pinNeeded || pin.length === PIN_LENGTH;
  function submit(e: Event) {
    e.preventDefault();
    if (!ready) return;
    onReceive(pinNeeded ? pin : undefined);
    setPin("");
  }
  return (
    <form class="card" onSubmit={submit}>
      <h2 class="label">Someone shared something with you</h2>
      <p style="margin: 0 0 20px; color: var(--text-muted); font-size: 0.9rem;">
        {pinNeeded
          ? "This share is protected with a PIN. Ask the sender for it, then tap Receive."
          : "Tap Receive to connect to the sender. Nothing is transferred and the link stays usable until you do."}
      </p>
      {pinNeeded && (
        <div style="margin-bottom: 20px;">
          <label class="label" for="pin-input">pin</label>
          <input
            id="pin-input"
            class="pin-input"
            type="text"
            inputMode="numeric"
            autocomplete="one-time-code"
            pattern="[0-9]*"
            placeholder="····"
            maxLength={PIN_LENGTH}
            value={pin}
            autoFocus
            onInput={(e) => setPin((e.target as HTMLInputElement).value.replace(/\D/g, "").slice(0, PIN_LENGTH))}
          />
          {pinError && <p class="pin-error">{pinError}</p>}
        </div>
      )}
      <button type="submit" disabled={!ready} style="width: 100%;">Receive</button>
    </form>
  );
}

function ReceiverOfferCard({
  offer,
  onAccept,
  onDecline,
}: {
  offer: FileOffer;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const willBuffer = !canStreamToDisk();
  const tooBig = willBuffer && offer.size > RAM_BUFFER_LIMIT;
  return (
    <div class="card">
      <h2 class="label">Incoming file</h2>
      <FilePill name={offer.name} size={offer.size} />
      {willBuffer && (
        <p style="margin: 16px 0 0; color: var(--warn, #b06000); font-size: 0.85rem;">
          {tooBig
            ? "Your browser will hold this in memory and will likely run out of space — try a desktop browser for large files."
            : "Your browser doesn't support streaming to disk — the file will be held in memory until you click the download link."}
        </p>
      )}
      <div style="display: flex; gap: 8px; margin-top: 24px;">
        <button class="danger" onClick={onDecline} style="flex: 1;">Decline</button>
        <button onClick={onAccept} style="flex: 2;">Accept</button>
      </div>
    </div>
  );
}

function BlobDoneCard({ offer, downloadUrl }: { offer: FileOffer; downloadUrl: string | null }) {
  return (
    <div class="card">
      <h2 class="label">Ready</h2>
      <FilePill name={offer.name} size={offer.size} />
      <p style="color: var(--text-muted); margin: 16px 0 16px; font-size: 0.875rem;">
        Held in browser memory — click to save to disk.
      </p>
      {downloadUrl && (
        <a class="button" href={downloadUrl} download={offer.name}>
          Download
        </a>
      )}
    </div>
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
