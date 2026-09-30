// What was interacted with, described the way a person (and a Playwright
// locator) would name it: role, accessible name, label, test id, rect.
import type { RouteTarget, RouteTyping } from "../../shared/route";
import { sectionOf, stableSelector, truncate } from "../describe";

const ACTIONABLE = [
  "a[href]", "button", "input", "select", "textarea", "summary", "label",
  "[role=button]", "[role=link]", "[role=menuitem]", "[role=menuitemcheckbox]", "[role=menuitemradio]",
  "[role=option]", "[role=tab]", "[role=checkbox]", "[role=switch]", "[role=radio]", "[role=combobox]",
  "[role=treeitem]", "[role=gridcell]", "[role=row]", "[role=slider]",
  "[contenteditable='']", "[contenteditable=true]", "[onclick]",
].join(",");

const TEXT_INPUT = /^(text|search|email|url|tel|password|number|date|datetime-local|month|week|time|)$/;

/** The element a pointer event acted on: the nearest actionable ancestor, or a cursor:pointer element. */
export function actionableTarget(raw: EventTarget | null): Element | null {
  let el = raw instanceof Element ? raw : raw instanceof Node ? raw.parentElement : null;
  if (!el) return null;
  if (el instanceof SVGElement) {
    let svg: SVGElement = el;
    while (svg.ownerSVGElement) svg = svg.ownerSVGElement;
    el = svg;
  }
  if (el === document.documentElement || el === document.body) return null;
  const hit = el.closest(ACTIONABLE);
  if (hit) return hit;
  // React/Vue click handlers leave no trace in the DOM; cursor:pointer usually does.
  let pointer: Element | null = null;
  for (let a: Element | null = el, i = 0; a && a !== document.body && i < 6; a = a.parentElement, i++) {
    if (getComputedStyle(a).cursor === "pointer") pointer = a;
    else if (pointer) break;
  }
  return pointer;
}

export function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_INPUT.test(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/** The form control a label or wrapper stands for. */
export function controlOf(el: Element): Element {
  if (el instanceof HTMLLabelElement && el.control) return el.control;
  return el;
}

export function isToggle(el: Element): boolean {
  const c = controlOf(el);
  if (c instanceof HTMLInputElement && (c.type === "checkbox" || c.type === "radio")) return true;
  return /^(checkbox|switch|radio|menuitemcheckbox|menuitemradio)$/.test(c.getAttribute("role") ?? "");
}

/** Checked state after a toggle, from the native property or ARIA/data attributes. */
export function checkedState(el: Element): boolean | undefined {
  const c = controlOf(el);
  if (c instanceof HTMLInputElement && (c.type === "checkbox" || c.type === "radio")) return c.checked;
  const aria = c.getAttribute("aria-checked") ?? c.getAttribute("aria-pressed");
  if (aria === "true" || aria === "mixed") return true;
  if (aria === "false") return false;
  const state = c.getAttribute("data-state");
  if (state === "checked" || state === "on") return true;
  if (state === "unchecked" || state === "off") return false;
  return undefined;
}

export function isSensitive(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  return el.type === "password" || /\b(cc-|one-time-code|current-password|new-password)/.test(el.autocomplete ?? "");
}

const IMPLICIT_ROLE: Record<string, string> = {
  a: "link", button: "button", select: "combobox", textarea: "textbox", summary: "button", option: "option",
  h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading", img: "img",
};

export function roleOf(el: Element): string {
  const explicit = el.getAttribute("role")?.split(/\s+/)[0];
  if (explicit) return explicit;
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox") return "checkbox";
    if (el.type === "radio") return "radio";
    if (el.type === "range") return "slider";
    if (/^(button|submit|reset|image)$/.test(el.type)) return "button";
    if (el.type === "search") return "searchbox";
    if (el.getAttribute("list")) return "combobox";
    return "textbox";
  }
  if (el.localName === "a" && !el.hasAttribute("href")) return "generic";
  return IMPLICIT_ROLE[el.localName] ?? (el instanceof HTMLElement && el.isContentEditable ? "textbox" : "generic");
}

const clean = (s: string | null | undefined, max = 80) => truncate((s ?? "").replace(/\s+/g, " ").trim(), max);

function textOfIds(ids: string): string {
  return ids
    .split(/\s+/)
    .map((id) => document.getElementById(id))
    .map((n) => (n as HTMLElement | null)?.innerText ?? n?.textContent ?? "")
    .join(" ");
}

/** A label's own words, without the text of controls nested in it (a <select>'s options, say). */
function labelText(label: HTMLLabelElement): string {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) parts.push(n.textContent ?? "");
    else if (n instanceof Element && !/^(select|textarea|input|button|option|datalist)$/.test(n.localName)) n.childNodes.forEach(walk);
  };
  label.childNodes.forEach(walk);
  return parts.join(" ");
}

/** The visible label that names a form field. */
export function fieldLabel(el: Element): string {
  const labelled = el.getAttribute("aria-labelledby");
  if (labelled) return clean(textOfIds(labelled));
  const labels = (el as HTMLInputElement).labels;
  if (labels?.length) return clean(labelText(labels[0]));
  const aria = el.getAttribute("aria-label");
  if (aria) return clean(aria);
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return clean(placeholder);
  // A label-looking sibling just before the field ("<span>Quantity</span><input>").
  const prev = el.previousElementSibling as HTMLElement | null;
  if (prev && prev.innerText && prev.innerText.length < 40 && !prev.querySelector("input,select,textarea,button")) return clean(prev.innerText);
  return clean(el.getAttribute("name") ?? el.getAttribute("title"));
}

/** Accessible name, close to what getByRole(role, { name }) matches. */
export function accessibleName(el: Element): string {
  const labelled = el.getAttribute("aria-labelledby");
  if (labelled) return clean(textOfIds(labelled));
  const aria = el.getAttribute("aria-label");
  if (aria) return clean(aria);
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    if (el instanceof HTMLInputElement && /^(button|submit|reset)$/.test(el.type)) return clean(el.value);
    return fieldLabel(el);
  }
  if (el instanceof HTMLLabelElement) return clean(labelText(el));
  if (el instanceof HTMLImageElement) return clean(el.alt);
  const text = clean((el as HTMLElement).innerText ?? el.textContent);
  if (text) return text;
  const inner = el.querySelector("[aria-label],img[alt],svg title");
  return clean(inner?.getAttribute("aria-label") ?? (inner as HTMLImageElement | null)?.alt ?? inner?.textContent ?? el.getAttribute("title"));
}

export function describeTarget(el: Element, pointer?: { clientX: number; clientY: number }): RouteTarget {
  const r = el.getBoundingClientRect();
  const clamp = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
  const testId = el.closest("[data-testid]")?.getAttribute("data-testid") ?? undefined;
  return {
    selector: stableSelector(el),
    tag: el.localName,
    role: roleOf(el),
    name: accessibleName(el),
    label: isTextField(el) || el instanceof HTMLSelectElement ? fieldLabel(el) : "",
    ...(testId ? { testId } : {}),
    section: sectionOf(el),
    rect: { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) },
    ...(pointer && r.width && r.height
      ? { point: { fx: clamp((pointer.clientX - r.left) / r.width), fy: clamp((pointer.clientY - r.top) / r.height) } }
      : {}),
    inViewport: r.top >= -2 && r.left >= -2 && r.bottom <= innerHeight + 2 && r.right <= innerWidth + 2,
  };
}

const round = (n: number) => Math.round(n * 10) / 10;

/** The first ancestor that actually paints a background (inputs are often transparent). */
function paintedBackground(el: Element): string {
  for (let a: Element | null = el; a; a = a.parentElement) {
    const bg = getComputedStyle(a).backgroundColor;
    if (bg && bg !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(bg)) return bg;
  }
  return "rgb(255, 255, 255)";
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** Measured typing stops in the field's own font, so a composer can reveal whole glyphs. */
export function typingOf(el: Element, value: string): RouteTyping {
  const cs = getComputedStyle(el);
  measureCtx ??= document.createElement("canvas").getContext("2d");
  const ctx = measureCtx!;
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const letterSpacing = parseFloat(cs.letterSpacing) || 0;
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${letterSpacing}px`;
  const chars = Array.from(value);
  const stops: number[] = [];
  for (let i = 1; i <= chars.length; i++) stops.push(round(ctx.measureText(chars.slice(0, i).join("")).width));
  const px = (v: string) => parseFloat(v) || 0;
  const fontSize = px(cs.fontSize);
  const lineHeight = px(cs.lineHeight) || fontSize * 1.2;
  const multiline = el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);
  const r = el.getBoundingClientRect();
  return {
    fontFamily: cs.fontFamily,
    fontSize,
    fontWeight: cs.fontWeight,
    fontStyle: cs.fontStyle,
    letterSpacing,
    color: cs.color,
    bg: paintedBackground(el),
    textX: px(cs.borderLeftWidth) + px(cs.paddingLeft),
    textY: multiline ? px(cs.borderTopWidth) + px(cs.paddingTop) : round((r.height - lineHeight) / 2),
    lineHeight,
    stops,
    align: cs.textAlign,
  };
}

export function valueOf(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return (el as HTMLElement).innerText ?? "";
}
