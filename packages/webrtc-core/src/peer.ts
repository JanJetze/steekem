import type { SignalingClient, SignalingMessage } from "./signaling";
import { connectionWords, looksLikeFrame, Opener, Sealer } from "./crypto";

export type PeerRole = "sender" | "receiver";

/** How the channel is protected. Decided by the first inbound message:
 *  a frame that decrypts with the link key means both ends hold it ("e2e");
 *  a plaintext message means the other end only has the room code. */
export type EncryptionMode = "undecided" | "e2e" | "plaintext";

export type PeerEvent =
  | { type: "channel-open"; channel: RTCDataChannel }
  | { type: "channel-message"; data: string | ArrayBuffer | Blob }
  | { type: "channel-close" }
  | { type: "ice-state"; state: RTCIceConnectionState }
  | { type: "encryption"; mode: "e2e" | "plaintext" }
  | { type: "crypto-error"; error: Error }
  | { type: "error"; error: Error };

export interface PeerOptions {
  signaling: SignalingClient;
  iceServers?: RTCIceServer[];
  channelLabel?: string;
  /** AES-GCM key derived from the link secret, or null for a code-only session. */
  key?: CryptoKey | null;
  /** What to do when a plaintext message arrives while a key is set and no
   *  frame has been decrypted yet. The sender allows the downgrade, because a
   *  receiver who typed the code legitimately has no key; the receiver
   *  rejects, because a sender who handed out this link must have it. */
  plaintext?: "reject" | "allow-downgrade";
  onEvent: (event: PeerEvent) => void;
}

const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];

/** Buffered amount under which we get bufferedamountlow events. Sized to keep
 *  the SCTP send buffer continuously fed when paired with a 16 MB high-water
 *  on the sender — we resume pushing while 4 MB is still in flight, so the
 *  wire never goes idle waiting for the buffer to drain to zero. */
const BUFFERED_AMOUNT_LOW = 4 * 1024 * 1024;

export class Peer {
  private pc!: RTCPeerConnection;
  private signaling: SignalingClient;
  private channelLabel: string;
  private iceServers: RTCIceServer[];
  private onEvent: (event: PeerEvent) => void;
  private _channel: RTCDataChannel | null = null;
  private role: PeerRole | null = null;
  private remoteSet = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private unsubSignaling: (() => void) | null = null;
  private closed = false;

  /** The key from the link, kept so a downgrade for one code-only receiver
   *  does not leak into the next connection on the same room. */
  private readonly linkKey: CryptoKey | null;
  private key: CryptoKey | null;
  private plaintextPolicy: "reject" | "allow-downgrade";
  private _encryption: EncryptionMode;
  private sealer: Sealer | null = null;
  private opener: Opener | null = null;
  /** Encryption is async; these chains keep send and receive order intact. */
  private outbound: Promise<void> = Promise.resolve();
  private inbound: Promise<void> = Promise.resolve();

  /** The active DataChannel, or null until negotiation completes. Exposed so transfer code can read bufferedAmount and listen for bufferedamountlow. */
  get channel(): RTCDataChannel | null {
    return this._channel;
  }

  get encryption(): EncryptionMode {
    return this._encryption;
  }

  /** Negotiated SCTP max message size, or null if not yet known. Safari/WebKit
   *  advertises 65536 here, far below Chrome/Firefox — the sender must clamp
   *  its wire-level chunk size to this or send() throws when a Safari peer is
   *  on either end. A value of 0 means "no limit" per spec; treat as null. */
  get maxMessageSize(): number | null {
    const max = this.pc.sctp?.maxMessageSize;
    return typeof max === "number" && max > 0 ? max : null;
  }

  constructor(opts: PeerOptions) {
    this.signaling = opts.signaling;
    this.channelLabel = opts.channelLabel ?? "steekem";
    this.iceServers = opts.iceServers ?? DEFAULT_ICE;
    this.onEvent = opts.onEvent;
    this.linkKey = opts.key ?? null;
    this.key = this.linkKey;
    this.plaintextPolicy = opts.plaintext ?? "reject";
    this._encryption = this.key ? "undecided" : "plaintext";
    this.createConnection();

    this.unsubSignaling = this.signaling.onMessage((msg) => {
      this.handleSignal(msg).catch((err) =>
        this.onEvent({ type: "error", error: err instanceof Error ? err : new Error(String(err)) })
      );
    });
  }

  setRole(role: PeerRole): void {
    this.role = role;
    this.resetCipherState();
  }

  /** Sender-side: called once partner-joined arrives. Creates DataChannel + offer. */
  async startNegotiation(): Promise<void> {
    if (this.role !== "sender") {
      throw new Error("startNegotiation called on non-sender peer");
    }
    const channel = this.pc.createDataChannel(this.channelLabel, { ordered: true });
    this.attachChannel(channel);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.send({ type: "offer", sdp: offer.sdp! });
  }

  /** Throws away the RTCPeerConnection and starts a fresh one on the same
   *  signaling socket. Needed whenever the other side went away or ICE
   *  failed: a connection that has failed once cannot simply renegotiate,
   *  and a new partner must not inherit the previous one's channel. */
  resetConnection(): void {
    if (this.closed) return;
    this._channel?.close();
    this._channel = null;
    this.pc.close();
    this.createConnection();
    this.resetCipherState();
  }

  /** Words derived from both certificate fingerprints, identical on both ends
   *  unless someone sits between them. Null until both descriptions are set. */
  connectionWords(): Promise<string[] | null> {
    return connectionWords(this.pc.localDescription?.sdp, this.pc.remoteDescription?.sdp);
  }

  private createConnection(): void {
    this.remoteSet = false;
    this.pendingIce = [];
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;

    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate && this.pc === pc) {
        this.signaling.send({ type: "ice", candidate: e.candidate.toJSON() });
      }
    });
    pc.addEventListener("iceconnectionstatechange", () => {
      if (this.pc === pc) this.onEvent({ type: "ice-state", state: pc.iceConnectionState });
    });
    pc.addEventListener("datachannel", (e) => {
      if (this.pc === pc) this.attachChannel(e.channel);
    });
  }

  private resetCipherState(): void {
    this.key = this.linkKey;
    this._encryption = this.key ? "undecided" : "plaintext";
    this.sealer = null;
    this.opener = null;
    this.outbound = Promise.resolve();
    this.inbound = Promise.resolve();
  }

  private ensureCipher(): void {
    if (!this.key || !this.role) return;
    if (!this.sealer) this.sealer = new Sealer(this.key, this.role);
    if (!this.opener) this.opener = new Opener(this.key, this.role === "sender" ? "receiver" : "sender");
  }

  private async handleSignal(msg: SignalingMessage): Promise<void> {
    if (msg.type === "offer" && this.role === "receiver") {
      await this.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp as string });
      this.remoteSet = true;
      await this.flushPendingIce();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.signaling.send({ type: "answer", sdp: answer.sdp! });
    } else if (msg.type === "answer" && this.role === "sender") {
      await this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp as string });
      this.remoteSet = true;
      await this.flushPendingIce();
    } else if (msg.type === "ice") {
      const candidate = msg.candidate as RTCIceCandidateInit;
      if (!this.remoteSet) {
        this.pendingIce.push(candidate);
      } else {
        await this.addIceCandidate(candidate);
      }
    }
  }

  /** A candidate that cannot be applied (stale, from a previous connection,
   *  malformed) is not fatal: ICE either still succeeds on the others or
   *  reports failure through iceconnectionstatechange. */
  private async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try { await this.pc.addIceCandidate(candidate); }
    catch { /* see above */ }
  }

  private async flushPendingIce(): Promise<void> {
    const queue = this.pendingIce.splice(0);
    for (const c of queue) await this.addIceCandidate(c);
  }

  private attachChannel(channel: RTCDataChannel): void {
    this._channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;
    channel.addEventListener("open", () => this.onEvent({ type: "channel-open", channel }));
    channel.addEventListener("close", () => this.onEvent({ type: "channel-close" }));
    channel.addEventListener("message", (e) => this.receive(e.data));
  }

  private receive(data: string | ArrayBuffer | Blob): void {
    this.inbound = this.inbound.then(async () => {
      if (!this.key) {
        this.onEvent({ type: "channel-message", data });
        return;
      }
      this.ensureCipher();
      if (looksLikeFrame(data)) {
        let plain: string | ArrayBuffer;
        try {
          plain = await this.opener!.open(data as ArrayBuffer);
        } catch (err) {
          this.onEvent({ type: "crypto-error", error: err instanceof Error ? err : new Error(String(err)) });
          return;
        }
        if (this._encryption !== "e2e") {
          this._encryption = "e2e";
          this.onEvent({ type: "encryption", mode: "e2e" });
        }
        this.onEvent({ type: "channel-message", data: plain });
        return;
      }
      if (this._encryption === "undecided" && this.plaintextPolicy === "allow-downgrade" && typeof data === "string") {
        this.key = null;
        this.sealer = null;
        this.opener = null;
        this._encryption = "plaintext";
        this.onEvent({ type: "encryption", mode: "plaintext" });
        this.onEvent({ type: "channel-message", data });
        return;
      }
      this.onEvent({ type: "crypto-error", error: new Error("unencrypted message rejected") });
    });
  }

  /** Throws synchronously when the channel is not open. The returned promise
   *  resolves once the bytes have been handed to the channel, which matters
   *  for backpressure: bufferedAmount only reflects data that has been
   *  encrypted and queued. */
  send(data: string | ArrayBuffer | Blob | ArrayBufferView): Promise<void> {
    const ch = this._channel;
    if (!ch || ch.readyState !== "open") {
      throw new Error(`channel not open (state: ${ch?.readyState ?? "null"})`);
    }
    if (!this.key) {
      (ch.send as (d: unknown) => void)(data);
      return Promise.resolve();
    }
    if (data instanceof Blob) throw new Error("Blob payloads are not supported on an encrypted channel");
    this.ensureCipher();
    const sealer = this.sealer!;
    this.outbound = this.outbound.then(async () => {
      let frame: ArrayBuffer;
      try {
        frame = await sealer.seal(data);
      } catch (err) {
        this.onEvent({ type: "crypto-error", error: err instanceof Error ? err : new Error(String(err)) });
        return;
      }
      // The channel may have closed while encrypting; channel-close already
      // told the app, so dropping the frame silently is the right outcome.
      if (ch.readyState === "open") ch.send(frame);
    });
    return this.outbound;
  }

  /** Resolves once the channel's send buffer drops below bufferedAmountLowThreshold. */
  awaitDrain(): Promise<void> {
    const ch = this._channel;
    if (!ch || ch.readyState !== "open") return Promise.resolve();
    if (ch.bufferedAmount <= ch.bufferedAmountLowThreshold) return Promise.resolve();
    return new Promise((resolve) => {
      const onLow = () => {
        ch.removeEventListener("bufferedamountlow", onLow);
        resolve();
      };
      ch.addEventListener("bufferedamountlow", onLow);
    });
  }

  close(): void {
    this.closed = true;
    this.unsubSignaling?.();
    this.unsubSignaling = null;
    this._channel?.close();
    this.pc.close();
  }
}
