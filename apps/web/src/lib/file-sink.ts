/**
 * Receiver-side sinks for incoming file bytes.
 *
 * We have two implementations:
 *
 *  - `StreamSaverSink`: registers a transfer with our Service Worker, then
 *    triggers a hidden download to a synthetic URL. The SW responds with a
 *    streaming Response, so the browser's native download manager writes
 *    bytes straight to disk. This is the only way to handle multi-GB files
 *    without exhausting browser RAM.
 *
 *  - `BlobSink`: accumulates chunks in memory and emits a single Blob URL
 *    on close. Used as a fallback when SW streaming isn't available
 *    (notably iOS Safari, where SW download streaming is broken).
 *
 * Pick the right one at runtime via `chooseSink()`.
 */

export interface FileMeta {
  name: string;
  size: number;
  mimeType: string;
}

export type SinkMode = "stream" | "blob";

export interface FileSink {
  readonly mode: SinkMode;
  readonly meta: FileMeta;
  /** Append a chunk. Caller transfers ownership of the buffer. */
  write(chunk: ArrayBuffer): Promise<void>;
  /** Close the sink. For BlobSink, populates `downloadUrl`. */
  close(): Promise<void>;
  abort(reason?: string): Promise<void>;
  /** For BlobSink: a Blob URL the user must click. Null for StreamSaverSink (download already started). */
  readonly downloadUrl: string | null;
}

// ─── capability detection ────────────────────────────────────────

export function canStreamToDisk(): boolean {
  if (typeof navigator === "undefined") return false;
  if (!("serviceWorker" in navigator)) return false;
  // iOS Safari supports SW but its download streaming is broken — fall back.
  if (isIosSafari()) return false;
  return true;
}

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const isIos = /iP(ad|hone|od)/i.test(ua) || (/Mac/i.test(ua) && "ontouchend" in document);
  if (!isIos) return false;
  // CriOS = Chrome iOS, FxiOS = Firefox iOS, EdgiOS = Edge iOS — all built on
  // WebKit but we treat them as Safari-like for SW download purposes.
  return /Safari/i.test(ua) || /CriOS|FxiOS|EdgiOS/i.test(ua);
}

let swInFlight: Promise<ServiceWorker> | null = null;

/**
 * Register the SW (idempotent) and resolve with the active worker that
 * controls this page. Throws if the browser doesn't support SW.
 *
 * On failure (no controller after activation timeout, registration error)
 * the cached promise is cleared so the next caller can retry — otherwise
 * a transient cold-start failure would force every subsequent transfer
 * onto BlobSink even when the SW eventually claims the page.
 */
export function ensureServiceWorker(scriptUrl = "/sw.js"): Promise<ServiceWorker> {
  if (swInFlight) return swInFlight;
  if (!("serviceWorker" in navigator)) {
    return Promise.reject(new Error("ServiceWorker not supported"));
  }
  const promise: Promise<ServiceWorker> = (async () => {
    try {
      await navigator.serviceWorker.register(scriptUrl);
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller) {
        return navigator.serviceWorker.controller;
      }
      // First install: clients.claim() in activate hasn't yet fired
      // controllerchange on this page. Wait for it.
      return await new Promise<ServiceWorker>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          navigator.serviceWorker.removeEventListener("controllerchange", onChange);
          if (timer !== null) clearTimeout(timer);
        };
        const onChange = () => {
          const ctrl = navigator.serviceWorker.controller;
          if (ctrl) {
            cleanup();
            resolve(ctrl);
          }
        };
        navigator.serviceWorker.addEventListener("controllerchange", onChange);
        timer = setTimeout(() => {
          cleanup();
          const ctrl = navigator.serviceWorker.controller;
          if (ctrl) resolve(ctrl);
          else reject(new Error("ServiceWorker activation timed out"));
        }, 15_000);
      });
    } catch (err) {
      swInFlight = null;
      throw err;
    }
  })();
  swInFlight = promise;
  return promise;
}

// ─── sinks ──────────────────────────────────────────────────────

export class StreamSaverSink implements FileSink {
  readonly mode: SinkMode = "stream";
  readonly meta: FileMeta;
  readonly downloadUrl = null;
  private id: string;
  private sw: ServiceWorker;

  static async create(meta: FileMeta): Promise<StreamSaverSink> {
    const sw = await ensureServiceWorker();
    const id = crypto.randomUUID();
    await postWithAck(sw, { type: "register", id, ...meta });

    // Programmatic anchor click — works on mobile (Android Chrome, etc.)
    // where iframe-triggered downloads can stay in "pending" state.
    const a = document.createElement("a");
    a.href = `/__steekem-download/${id}`;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1_000);

    return new StreamSaverSink(id, sw, meta);
  }

  private constructor(id: string, sw: ServiceWorker, meta: FileMeta) {
    this.id = id;
    this.sw = sw;
    this.meta = meta;
  }

  async write(chunk: ArrayBuffer): Promise<void> {
    // Ownership transfer to SW — page no longer needs the buffer after this.
    this.sw.postMessage({ type: "chunk", id: this.id, data: chunk }, [chunk]);
  }

  async close(): Promise<void> {
    this.sw.postMessage({ type: "end", id: this.id });
  }

  async abort(reason?: string): Promise<void> {
    this.sw.postMessage({ type: "abort", id: this.id, reason });
  }
}

export class BlobSink implements FileSink {
  readonly mode: SinkMode = "blob";
  readonly meta: FileMeta;
  private chunks: ArrayBuffer[] = [];
  downloadUrl: string | null = null;

  constructor(meta: FileMeta) {
    this.meta = meta;
  }

  async write(chunk: ArrayBuffer): Promise<void> {
    this.chunks.push(chunk);
  }

  async close(): Promise<void> {
    const blob = new Blob(this.chunks, { type: this.meta.mimeType });
    this.downloadUrl = URL.createObjectURL(blob);
    this.chunks = [];
  }

  async abort(): Promise<void> {
    this.chunks = [];
    if (this.downloadUrl) {
      URL.revokeObjectURL(this.downloadUrl);
      this.downloadUrl = null;
    }
  }
}

export async function chooseSink(meta: FileMeta, log?: (msg: string) => void): Promise<FileSink> {
  if (!canStreamToDisk()) {
    log?.("stream sink unavailable (no SW or iOS Safari) — using blob");
    return new BlobSink(meta);
  }
  try {
    return await StreamSaverSink.create(meta);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(`stream sink failed: ${msg} — using blob`);
    console.warn("[steekem] stream sink failed, falling back to blob:", err);
    return new BlobSink(meta);
  }
}

// ─── helpers ────────────────────────────────────────────────────

function postWithAck(sw: ServiceWorker, message: unknown, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error("sw ack timeout")), timeoutMs);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      if (e.data?.ok) resolve();
      else reject(new Error(e.data?.error || "sw nack"));
    };
    sw.postMessage(message, [channel.port2]);
  });
}
