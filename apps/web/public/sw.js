// steekem streaming download bridge.
//
// The page registers a transfer with metadata + an ack port, then triggers
// a hidden navigation to /__steekem-download/{id}. We intercept that fetch
// and respond with a Response whose body is a ReadableStream fed by the
// page's postMessage chunks — the browser's native download manager then
// writes those bytes directly to disk, no JS-side buffering.

/* eslint-disable no-restricted-globals */

const DOWNLOAD_PREFIX = "/__steekem-download/";

/** @type {Map<string, {stream: ReadableStream, controller: ReadableStreamDefaultController, name: string, size: number, mimeType: string}>} */
const transfers = new Map();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  const port = event.ports && event.ports[0];

  try {
    if (data.type === "register") {
      registerTransfer(data);
      port && port.postMessage({ ok: true });
      return;
    }
    if (data.type === "chunk") {
      const t = transfers.get(data.id);
      if (!t) {
        port && port.postMessage({ ok: false, error: "unknown id" });
        return;
      }
      // data.data is an ArrayBuffer (transferred from page)
      t.controller.enqueue(new Uint8Array(data.data));
      port && port.postMessage({ ok: true });
      return;
    }
    if (data.type === "end") {
      const t = transfers.get(data.id);
      if (t) {
        try { t.controller.close(); } catch { /* already closed */ }
        t.ended = true;
        maybeCleanup(data.id);
      }
      port && port.postMessage({ ok: true });
      return;
    }
    if (data.type === "abort") {
      const t = transfers.get(data.id);
      if (t) {
        try { t.controller.error(new Error(data.reason || "aborted")); } catch {}
        transfers.delete(data.id);
      }
      port && port.postMessage({ ok: true });
      return;
    }
  } catch (err) {
    port && port.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

function registerTransfer(data) {
  const { id, name, size, mimeType } = data;
  if (!id || typeof name !== "string") throw new Error("invalid register payload");

  let controller;
  const stream = new ReadableStream({
    start(c) { controller = c; },
    cancel() {
      // User cancelled the download or navigated away — drop the entry.
      transfers.delete(id);
    },
  });

  transfers.set(id, {
    stream,
    /** @type {ReadableStreamDefaultController} */
    // @ts-ignore - controller is assigned synchronously inside start()
    controller,
    name,
    size: typeof size === "number" ? size : 0,
    mimeType: mimeType || "application/octet-stream",
    // Cleanup gating: we only drop the Map entry once BOTH the fetch has
    // happened (browser has consumed the stream) AND the page has signalled
    // 'end'. For tiny files, 'end' can fire before the browser dispatches
    // its fetch, so we can't tear down on either alone.
    ended: false,
    fetched: false,
  });

  // Safety net: if neither side resolves within 5 minutes (page closed,
  // download blocked, etc.), clean up to avoid leaking memory.
  setTimeout(() => {
    const t = transfers.get(id);
    if (t && !(t.ended && t.fetched)) {
      try { t.controller.error(new Error("transfer expired")); } catch {}
      transfers.delete(id);
    }
  }, 5 * 60_000);
}

function maybeCleanup(id) {
  const t = transfers.get(id);
  if (t && t.ended && t.fetched) transfers.delete(id);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(DOWNLOAD_PREFIX)) return;

  const id = url.pathname.slice(DOWNLOAD_PREFIX.length);
  const t = transfers.get(id);
  if (!t) {
    event.respondWith(new Response("transfer not found", { status: 404 }));
    return;
  }

  t.fetched = true;

  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": t.mimeType,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(t.name)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (t.size > 0) headers["Content-Length"] = String(t.size);

  event.respondWith(new Response(t.stream, { headers }));
  // Cleanup if 'end' already arrived; otherwise it will trigger cleanup when it does.
  maybeCleanup(id);
});
