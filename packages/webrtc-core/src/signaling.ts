/**
 * Tiny WebSocket wrapper for the signaling Worker.
 *
 * The Worker is a dumb relay: any string we send gets forwarded to the
 * other peer in the same room verbatim, plus a few control messages
 * (joined / partner-joined / partner-left) injected by the Worker itself.
 */

export type SignalingMessage =
  | { type: "joined"; role: "sender" | "receiver"; partnerPresent: boolean }
  | { type: "partner-joined" }
  | { type: "partner-left" }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit }
  | { type: string; [key: string]: unknown };

export type SignalingHandler = (msg: SignalingMessage) => void;

export class SignalingClient {
  readonly url: string;
  private ws: WebSocket | null = null;
  private handlers = new Set<SignalingHandler>();
  private outbox: SignalingMessage[] = [];

  constructor(url: string) {
    this.url = url;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.addEventListener("open", () => {
        for (const msg of this.outbox) ws.send(JSON.stringify(msg));
        this.outbox.length = 0;
        resolve();
      });

      ws.addEventListener("message", (e) => {
        if (typeof e.data !== "string") return;
        let parsed: SignalingMessage;
        try { parsed = JSON.parse(e.data); }
        catch { return; }
        for (const h of this.handlers) h(parsed);
      });

      ws.addEventListener("error", () => reject(new Error("signaling ws error")));
      ws.addEventListener("close", () => {
        for (const h of this.handlers) h({ type: "ws-close" });
      });
    });
  }

  send(msg: SignalingMessage): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      this.outbox.push(msg);
    }
  }

  onMessage(handler: SignalingHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
