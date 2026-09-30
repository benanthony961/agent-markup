// Records a click-through while the page works normally: what was clicked
// (measured before the click), what was typed, chosen, toggled or pressed,
// scrolls and navigations, with a screenshot of each settled state.
//
// Frames chain: a step's `after` is the next step's `before`. A step that starts
// while the previous one is still settling gets no `before` (and a warning),
// because any screenshot taken then could already show the new action.
import type { RouteStep } from "../../shared/route";
import { stableSelector } from "../describe";
import { idOf } from "../registry";
import { store } from "../store";
import { isOurEvent } from "../ui/root";
import { captionFor } from "./caption";
import { captureFrame, settled } from "./capture";
import { elapsed, mutate, nextId, route, stepById, updateStep } from "./state";
import {
  actionableTarget,
  checkedState,
  controlOf,
  describeTarget,
  isSensitive,
  isTextField,
  isToggle,
  typingOf,
  valueOf,
} from "./target";

const FAST_WARNING = "The screen was still changing when this step started, so it has no before-frame. Pause a beat between actions, or re-film with scripts/replay-route.mjs.";
const OFFSCREEN_WARNING = "The target was partly off-screen when it was clicked; the frame may not show it.";

type NewStep = Partial<RouteStep> & Pick<RouteStep, "kind">;

export function createRecorder() {
  /** Newest settled screenshot, and whether nothing has happened since it was taken. */
  let lastFrame: string | undefined;
  let fresh = false;
  /** Bumped by every new step or keystroke; a settle/capture that sees a different value is discarded. */
  let gen = 0;
  let lastStepAt = 0;
  let lastUrl = location.href;
  let attached = false;

  /** The field being typed into. */
  let fill: { el: Element; stepId: string; timer: number } | null = null;
  /** A click into a text field, which becomes a fill if typing follows. */
  let provisional: { el: Element; stepId: string; value: string } | null = null;
  let scrolling: { container: Element | null; fromX: number; fromY: number; toX: number; toY: number; timer: number } | null = null;
  const focusValues = new WeakMap<Element, string>();
  let urlTimer = 0;

  const masked = (el: Element, v: string) => (isSensitive(el) ? "•".repeat(Math.min(v.length, 12)) : v);

  function refreshCaption(id: string) {
    const s = stepById(id);
    if (s && !s.captionEdited) updateStep(id, { caption: captionFor(s) });
  }

  async function settleCapture(g: number, stepId: string | null, beforeCapture?: () => void, opts?: Parameters<typeof settled>[0]) {
    await settled(opts);
    if (g !== gen || !attached) return;
    beforeCapture?.();
    const f = await captureFrame();
    // A new step began during the capture: the image may already show its effect.
    if (g !== gen || !f) return;
    if (stepId) updateStep(stepId, { frames: { after: f } });
    else if (!route()?.startFrame) mutate((r) => (r.startFrame = f));
    lastFrame = f;
    fresh = true;
  }

  function begin(fields: NewStep, opts: { settle?: boolean; beforeCapture?: (id: string) => void } = {}): string {
    const id = nextId("st");
    const warnings = [...(fields.warnings ?? [])];
    if (!fresh) warnings.push(FAST_WARNING);
    if (fields.target && !fields.target.inViewport) warnings.push(OFFSCREEN_WARNING);
    const step: RouteStep = {
      id,
      at: elapsed(),
      page: { url: location.href, title: document.title },
      caption: "",
      ...fields,
      frames: { ...(fresh && lastFrame ? { before: lastFrame } : {}) },
      ...(warnings.length ? { warnings } : {}),
    };
    step.caption = captionFor(step);
    gen++;
    fresh = false;
    provisional = null;
    lastStepAt = Date.now();
    mutate((r) => r.steps.push(step));
    if (opts.settle !== false) void settleCapture(gen, id, opts.beforeCapture && (() => opts.beforeCapture!(id)));
    return id;
  }

  const flash = (el: Element) => store.set({ flash: { elementId: idOf(el), at: Date.now() } });

  // ---- Typing ----------------------------------------------------------------

  function finishFill() {
    if (!fill) return;
    const { el, stepId } = fill;
    fill = null;
    if (el.isConnected) updateStep(stepId, { typing: typingOf(el, masked(el, valueOf(el))) });
  }

  /** contenteditable events target inner nodes; the field is the editing host. */
  function fieldOf(t: EventTarget | undefined): Element | null {
    let el = t instanceof Element ? t : null;
    if (el instanceof HTMLElement && el.isContentEditable) while (el.parentElement?.isContentEditable) el = el.parentElement;
    return isTextField(el) ? el : null;
  }

  function onInput(e: Event) {
    if (!e.isTrusted || isOurEvent(e)) return;
    const el = fieldOf(e.composedPath()[0]);
    if (!el) return;
    if (fill?.el !== el) {
      finishFill();
      const click = provisional?.el === el ? stepById(provisional.stepId) : undefined;
      let stepId: string;
      if (click) {
        // The click that focused the field becomes the fill; its after-frame is the focused state.
        stepId = click.id;
        updateStep(stepId, {
          kind: "fill",
          previousValue: masked(el, provisional!.value),
          frames: { before: click.frames.before, focused: click.frames.after, after: undefined },
        });
        provisional = null;
      } else {
        stepId = begin(
          { kind: "fill", target: describeTarget(el), previousValue: masked(el, focusValues.get(el) ?? "") },
          { settle: false },
        );
        flash(el);
      }
      fill = { el, stepId, timer: 0 };
    }
    // Every keystroke invalidates pending captures: the next frame is taken once typing pauses.
    gen++;
    fresh = false;
    const value = valueOf(el);
    updateStep(fill.stepId, { value: masked(el, value), ...(isSensitive(el) ? { sensitive: true } : {}) });
    refreshCaption(fill.stepId);
    const current = fill;
    clearTimeout(current.timer);
    const g = gen;
    current.timer = window.setTimeout(() => {
      void settleCapture(g, current.stepId, () => {
        if (el.isConnected) updateStep(current.stepId, { typing: typingOf(el, masked(el, valueOf(el))) });
      }, { quiet: 350, min: 150 });
    }, 450);
  }

  function onFocusIn(e: FocusEvent) {
    const t = e.composedPath()[0];
    if (t instanceof Element && (isTextField(t) || t instanceof HTMLSelectElement)) focusValues.set(t, selectText(t) ?? valueOf(t));
  }

  function onFocusOut(e: FocusEvent) {
    if (fill && e.composedPath()[0] === fill.el) finishFill();
  }

  const selectText = (el: Element) =>
    el instanceof HTMLSelectElement ? Array.from(el.selectedOptions).map((o) => o.label || o.text).join(", ") : undefined;

  // ---- Pointer, change, keys -------------------------------------------------

  function onPointerDown(e: PointerEvent) {
    if (!e.isTrusted || e.button !== 0 || isOurEvent(e)) return;
    const el = actionableTarget(e.composedPath()[0]);
    if (!el) return;
    const control = controlOf(el);
    // Clicking inside the field being typed into just moves the caret.
    if (fill && (fill.el === control || fill.el.contains(el))) return;
    finishFill();
    // Native <select> popups can't be screenshotted; the choice is recorded on change.
    if (control instanceof HTMLSelectElement) return;
    const toggle = isToggle(el);
    const id = begin(
      { kind: toggle ? "check" : "click", target: describeTarget(el, e) },
      toggle
        ? {
            beforeCapture: (id) => {
              updateStep(id, { checked: checkedState(el) });
              refreshCaption(id);
            },
          }
        : {},
    );
    if (isTextField(control)) provisional = { el: control, stepId: id, value: valueOf(control) };
    flash(el);
  }

  function onChange(e: Event) {
    if (isOurEvent(e)) return;
    const el = e.composedPath()[0];
    // A <select> change is the one untrusted event we keep: automation (Playwright's
    // selectOption, form tools) sets selects programmatically, and pages rarely do.
    if (!e.isTrusted && !(el instanceof HTMLSelectElement)) return;
    if (el instanceof HTMLSelectElement) {
      finishFill();
      begin({ kind: "select", target: describeTarget(el), value: selectText(el), previousValue: focusValues.get(el) });
      focusValues.set(el, selectText(el) ?? "");
      flash(el);
    } else if (fill?.el === el) finishFill();
  }

  function deepActive(): Element | null {
    let a: Element | null = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!e.isTrusted || e.repeat || e.isComposing || isOurEvent(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!(e.key === "Enter" || e.key === "Escape" || (mod && e.key.length === 1))) return;
    // Clipboard, undo and select-all inside a field are part of typing.
    if (mod && /^[acvxyz]$/i.test(e.key) && fieldOf(e.composedPath()[0])) return;
    finishFill();
    const active = deepActive();
    const key = `${mod ? "Mod+" : ""}${mod && e.shiftKey ? "Shift+" : ""}${e.key.length === 1 ? e.key.toUpperCase() : e.key}`;
    begin({ kind: "press", key, ...(active && active !== document.body && active !== document.documentElement ? { target: describeTarget(active) } : {}) });
  }

  // ---- Scroll and navigation -------------------------------------------------

  function onScroll(e: Event) {
    // Scrolls caused by a step (anchors, scrollIntoView) land in that step's after-frame.
    if (!fresh || Date.now() - lastStepAt < 700) return;
    const t = e.target;
    const container = t === document || t === document.documentElement || t === document.scrollingElement || !(t instanceof Element) ? null : t;
    const x = container ? container.scrollLeft : scrollX;
    const y = container ? container.scrollTop : scrollY;
    if (!scrolling || scrolling.container !== container) {
      if (scrolling) finishScroll();
      const known = !container && lastFrame ? route()?.frames[lastFrame] : undefined;
      scrolling = { container, fromX: known?.scrollX ?? x, fromY: known?.scrollY ?? y, toX: x, toY: y, timer: 0 };
    } else {
      scrolling.toX = x;
      scrolling.toY = y;
    }
    clearTimeout(scrolling.timer);
    scrolling.timer = window.setTimeout(finishScroll, 400);
  }

  function finishScroll() {
    const s = scrolling;
    scrolling = null;
    if (!s) return;
    clearTimeout(s.timer);
    if (Math.hypot(s.toX - s.fromX, s.toY - s.fromY) < 80) return;
    begin({
      kind: "scroll",
      scroll: { container: s.container ? stableSelector(s.container) : null, fromX: s.fromX, fromY: s.fromY, toX: Math.round(s.toX), toY: Math.round(s.toY) },
    });
  }

  function checkUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const last = route()?.steps.at(-1);
    if (last && last.kind !== "navigate" && last.kind !== "chapter" && Date.now() - lastStepAt < 2500) {
      updateStep(last.id, { navigatesTo: location.href });
      return;
    }
    finishFill();
    begin({ kind: "navigate", value: location.href });
  }

  /** On (re)attach, e.g. after a full page load mid-route: take a fresh frame and link it up. */
  function resume() {
    const r = route();
    if (!r) return;
    const last = r.steps.filter((s) => s.kind !== "chapter").at(-1);
    lastFrame = undefined;
    fresh = false;
    const g = ++gen;
    if (!last) {
      void settleCapture(g, null);
      return;
    }
    const lastUrlSeen = last.navigatesTo ?? (last.kind === "navigate" ? last.value : last.page.url);
    const recent = Date.now() - (Date.parse(r.createdAt) + last.at) < 6000;
    if (recent && location.href !== last.page.url && last.kind !== "navigate") {
      // The last click loaded this page; this load is its result.
      lastStepAt = Date.now();
      updateStep(last.id, { navigatesTo: location.href });
      void settleCapture(g, last.id);
    } else if (location.href !== lastUrlSeen) {
      fresh = !!(last.frames.after ?? last.frames.before);
      lastFrame = last.frames.after ?? last.frames.before;
      begin({ kind: "navigate", value: location.href });
    } else {
      void settleCapture(g, null);
    }
  }

  const listeners: [string, EventListener, AddEventListenerOptions][] = [
    ["pointerdown", onPointerDown as EventListener, { capture: true, passive: true }],
    ["input", onInput, { capture: true }],
    ["change", onChange, { capture: true }],
    ["keydown", onKeyDown as EventListener, { capture: true }],
    ["focusin", onFocusIn as EventListener, { capture: true }],
    ["focusout", onFocusOut as EventListener, { capture: true }],
    ["scroll", onScroll, { capture: true, passive: true }],
    ["popstate", checkUrl, {}],
  ];

  return {
    attach() {
      if (attached) return;
      attached = true;
      lastUrl = location.href;
      for (const [t, fn, o] of listeners) window.addEventListener(t, fn, o);
      urlTimer = window.setInterval(checkUrl, 300);
      resume();
    },
    detach() {
      if (!attached) return;
      attached = false;
      finishFill();
      if (scrolling) clearTimeout(scrolling.timer);
      scrolling = null;
      provisional = null;
      gen++;
      for (const [t, fn, o] of listeners) window.removeEventListener(t, fn, o);
      clearInterval(urlTimer);
    },
  };
}
