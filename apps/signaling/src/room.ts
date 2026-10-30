import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

type Role = "sender" | "receiver";

interface Attachment {
  role: Role;
}

export class Room extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const peers = this.ctx.getWebSockets();
    if (peers.length >= 2) {
      return new Response("room full", { status: 409 });
    }

    const role: Role = peers.length === 0 ? "sender" : "receiver";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation API: DO can be evicted from memory between events.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role } satisfies Attachment);

    server.send(JSON.stringify({
      type: "joined",
      role,
      partnerPresent: peers.length === 1,
    }));

    if (peers.length === 1) {
      try {
        peers[0]!.send(JSON.stringify({ type: "partner-joined" }));
      } catch { /* peer dead — close handler will clean up */ }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // The DO is a dumb relay: every message goes verbatim to the other peer.
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;
      try { peer.send(message); } catch { /* drop */ }
    }
  }

  override async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;
      try { peer.send(JSON.stringify({ type: "partner-left" })); } catch { /* drop */ }
    }
  }

  override async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // close handler runs after; nothing to do here for now
  }
}
