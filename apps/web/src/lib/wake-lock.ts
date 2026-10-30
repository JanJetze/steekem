import { useEffect, useRef } from "preact/hooks";

/**
 * Keep the screen awake while `active` is true.
 *
 * The Wake Lock API auto-releases when the tab loses visibility, so we
 * re-acquire on visibilitychange. Silent no-op when the browser doesn't
 * support it or the user agent denies the request — wake lock is best-effort
 * UX, not a correctness primitive.
 */
export function useWakeLock(active: boolean): void {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active) return;
    if (typeof navigator === "undefined") return;
    if (!("wakeLock" in navigator)) return;

    let cancelled = false;

    async function acquire(): Promise<void> {
      try {
        const sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) {
          await sentinel.release().catch(() => { /* ignore */ });
          return;
        }
        sentinelRef.current = sentinel;
        sentinel.addEventListener("release", () => {
          if (sentinelRef.current === sentinel) sentinelRef.current = null;
        });
      } catch {
        /* denied or unavailable — best effort */
      }
    }

    acquire();

    function onVisibility(): void {
      if (document.visibilityState === "visible" && !sentinelRef.current) {
        acquire();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      const s = sentinelRef.current;
      sentinelRef.current = null;
      if (s) s.release().catch(() => { /* ignore */ });
    };
  }, [active]);
}
