// Screenshots for route steps. The background worker does the capture (only it
// can call captureVisibleTab) and keeps the image in storage; the route keeps
// only the frame's metadata. Our own UI is hidden for the shot.
import { CAPTURE_MESSAGE } from "../../shared/messages";
import { store } from "../store";
import { setHostHidden } from "../ui/root";
import { frameKey, mutate, nextId, route } from "./state";

let chain: Promise<unknown> = Promise.resolve();
const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

function bump(delta: number, error?: string | null) {
  const c = store.get().capture;
  store.set({ capture: { pending: Math.max(0, c.pending + delta), error: error === undefined ? c.error : error } });
}

/** Captures the visible tab into the current route. Resolves to the frame id, or undefined on failure. Serialized. */
export function captureFrame(): Promise<string | undefined> {
  bump(1);
  const run = async (): Promise<string | undefined> => {
    const r = route();
    if (!r) return undefined;
    if (document.visibilityState !== "visible") {
      bump(0, "Tab hidden; frame skipped");
      return undefined;
    }
    const id = nextId("f");
    // Reserve the id before the async gap so a second capture can't take it.
    mutate((x) => (x.frames[id] = { id, width: 0, height: 0, viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio, scrollX, scrollY, url: location.href, at: 0 }));
    const meta = { viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY), url: location.href };
    setHostHidden(true);
    let res: { ok?: boolean; width?: number; height?: number; error?: string } | undefined;
    try {
      await frame();
      res = await chrome.runtime.sendMessage({ type: CAPTURE_MESSAGE, key: frameKey(r.id, id) }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
    } finally {
      setHostHidden(false);
    }
    if (!res?.ok) {
      mutate((x) => delete x.frames[id]);
      bump(0, res?.error ?? "Screenshot failed");
      return undefined;
    }
    mutate((x) => (x.frames[id] = { id, width: res!.width ?? 0, height: res!.height ?? 0, ...meta, at: Date.now() - Date.parse(x.createdAt) }));
    bump(0, null);
    return id;
  };
  const p = chain.then(run, run).finally(() => bump(-1));
  chain = p.catch(() => {});
  return p;
}

/**
 * Resolves once the page has stopped changing: no DOM mutations for `quiet` ms
 * (after at least `min` ms, for transitions), or after `max` ms regardless.
 */
export function settled({ quiet = 450, min = 300, max = 3500 } = {}): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    let last = start;
    const mo = new MutationObserver(() => (last = performance.now()));
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const tick = () => {
      const now = performance.now();
      if ((now - start >= min && now - last >= quiet) || now - start >= max) {
        mo.disconnect();
        resolve();
      } else setTimeout(tick, 80);
    };
    setTimeout(tick, 80);
  });
}
