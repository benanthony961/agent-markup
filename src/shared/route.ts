// The route format: a recorded click-through of a live app, with what was
// clicked, what was typed and a screenshot of every state in between. It is the
// input to scripts/replay-route.mjs (re-film against a fixture) and
// scripts/route-to-hyperframes.mjs (compose a HyperFrames walkthrough).
// No DOM or chrome.* dependencies.

export const ROUTE_FORMAT = "agent-markup/route-v1";

/** Viewport CSS pixels. */
export interface RouteRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RouteTarget {
  /** Stable CSS selector (same rules as markup changes). */
  selector: string;
  tag: string;
  /** Explicit or implicit ARIA role: button, link, textbox, checkbox, tab, menuitem, option, ... */
  role: string;
  /** Accessible name: what a person would call the control. */
  name: string;
  /** For fields: the visible label (or placeholder) that names it. */
  label: string;
  testId?: string;
  section: string;
  /** Measured BEFORE the action, so it describes the `before` frame. */
  rect: RouteRect;
  /** Where inside the rect the pointer went down, as fractions (0..1). */
  point?: { fx: number; fy: number };
  /** False when the target was (partly) outside the viewport when it was measured. */
  inViewport: boolean;
}

/** Everything the composer needs to animate typing into a field without guessing. */
export interface RouteTyping {
  fontFamily: string;
  /** px */
  fontSize: number;
  fontWeight: string;
  fontStyle: string;
  /** px */
  letterSpacing: number;
  color: string;
  /** First painted ancestor background, for covering the placeholder while typing. */
  bg: string;
  /** Text origin relative to the field's rect (padding + border). */
  textX: number;
  textY: number;
  lineHeight: number;
  /** Cumulative text width in px after each character of `value`. */
  stops: number[];
  align: string;
}

export type StepKind = "click" | "fill" | "select" | "check" | "press" | "scroll" | "navigate" | "chapter";

export interface RouteStep {
  id: string;
  kind: StepKind;
  /** ms since the route started. */
  at: number;
  page: { url: string; title: string };
  target?: RouteTarget;
  /** fill: the final text; select: the option label; navigate: the URL. */
  value?: string;
  previousValue?: string;
  /** Password and similar fields: the value was never recorded. */
  sensitive?: boolean;
  /** Replay may substitute a different value (e.g. a SKU from the fixture). */
  variable?: string;
  /** press: key combo such as "Enter", "Escape", "Mod+K". */
  key?: string;
  /** check: state after the click. */
  checked?: boolean;
  scroll?: { container: string | null; fromX: number; fromY: number; toX: number; toY: number };
  typing?: RouteTyping;
  /** Set when the action led to another URL. */
  navigatesTo?: string;
  /** On-screen caption. Auto-written, meant to be edited. */
  caption: string;
  /** True once a person edited the caption, so it is never rewritten automatically. */
  captionEdited?: boolean;
  /** Why this step matters: a voiceover guide, not displayed. */
  note?: string;
  /** chapter: the title shown on the chapter card. */
  title?: string;
  /** Emphasize: hold longer and zoom closer. */
  emphasis?: boolean;
  frames: { before?: string; focused?: string; after?: string };
  warnings?: string[];
}

export interface RouteFrame {
  id: string;
  /** Pixel size of the image. */
  width: number;
  height: number;
  /** Viewport CSS size and device pixel ratio when it was taken. */
  viewport: { width: number; height: number };
  dpr: number;
  scrollX: number;
  scrollY: number;
  url: string;
  at: number;
  /** Relative path (exports) or data: URL (single-file downloads). */
  file?: string;
  dataUrl?: string;
}

export interface Route {
  format: typeof ROUTE_FORMAT;
  id: string;
  title: string;
  site: string;
  createdAt: string;
  updatedAt: string;
  viewport: { width: number; height: number; dpr: number };
  steps: RouteStep[];
  frames: Record<string, RouteFrame>;
  /** The state before the first step. */
  startFrame?: string;
}
