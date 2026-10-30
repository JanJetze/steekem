export { Room } from "./room";

export interface Env {
  ROOM: DurableObjectNamespace;
}

const ROOM_ID_PATTERN = /^\/room\/([a-zA-Z0-9_-]{4,64})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const match = url.pathname.match(ROOM_ID_PATTERN);
    if (!match) {
      return new Response("not found", { status: 404, headers: corsHeaders() });
    }

    const roomId = match[1]!;
    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Upgrade",
  };
}
