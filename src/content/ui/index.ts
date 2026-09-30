// Mounts the UI when Agent Markup is enabled and keeps it in sync with the store.
// Markup mode intercepts clicks; route mode leaves the page working and, while
// recording, runs the recorder instead.
import { createRecorder } from "../route/recorder";
import { store, type State } from "../store";
import { cancel } from "./inlineEdit";
import { createHighlights } from "./highlights";
import { createInterceptor } from "./interceptor";
import { createOverlay } from "./overlay";
import { createPanel } from "./panel";
import { ensureRoot, mountHost, unmountHost } from "./root";

export function createUI() {
  const root = ensureRoot();
  const overlay = createOverlay();
  const panel = createPanel();
  const highlights = createHighlights();
  overlay.el.append(highlights.el, panel.el);
  root.append(overlay.el);
  const interceptor = createInterceptor(overlay);
  const recorder = createRecorder();
  void panel.loadPosition();

  let raf = 0;
  const loop = () => {
    overlay.frame();
    highlights.frame();
    raf = requestAnimationFrame(loop);
  };

  let intercepting = false;
  let recording = false;
  function syncInput(s: State) {
    const intercept = s.enabled && s.mode === "markup";
    if (intercept !== intercepting) {
      intercepting = intercept;
      if (intercept) interceptor.attach();
      else {
        cancel();
        overlay.cancelDrag();
        interceptor.detach();
      }
    }
    const record = s.enabled && s.mode === "route" && s.recording && !!s.route;
    if (record !== recording) {
      recording = record;
      if (record) recorder.attach();
      else recorder.detach();
    }
  }

  function mount() {
    mountHost();
    panel.render(store.get());
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }

  function unmount() {
    store.set({ selectionDraft: null, highlightEdit: null });
    cancelAnimationFrame(raf);
    unmountHost();
  }

  store.subscribe((s, prev) => {
    if (s.enabled !== prev.enabled) (s.enabled ? mount : unmount)();
    syncInput(s);
    if (s.enabled) panel.render(s);
  });
}
