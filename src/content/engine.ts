// Applies and un-applies changes on the live DOM. Every DOM mutation Agent
// Markup makes to the page goes through here, driven by the command layer.
import type { Change, HighlightChange, MoveChange } from "./changes";
import { elementOf } from "./registry";
import { findRange } from "./textAnchor";

/** What an edit replaced, restored when the edit is reverted. */
const originalContent = new WeakMap<Element, { children: Node[] } | { text: Text; data: string }>();
/** Inline display value before an element was hidden. */
const originalDisplay = new WeakMap<Element, { value: string; priority: string }>();
/** Where a moved element sat before the move was applied. */
const originalPlace = new WeakMap<MoveChange, { parent: Element; next: Node | null }>();

// ---- Highlights ------------------------------------------------------------
// Drawn with the CSS Custom Highlight API: the page's DOM is not wrapped or
// modified, so a highlight can't break the page's own scripts or layout.

const HIGHLIGHT_NAME = "agent-markup";
const highlightRanges = new Map<string, Range>();

function highlightRegistry(): Highlight | null {
  if (typeof Highlight === "undefined" || !("highlights" in CSS)) return null;
  let hl = CSS.highlights.get(HIGHLIGHT_NAME);
  if (!hl) {
    hl = new Highlight();
    CSS.highlights.set(HIGHLIGHT_NAME, hl);
    // ::highlight() must be styled from the page's own stylesheet scope.
    const style = document.createElement("style");
    style.setAttribute("data-agent-markup", "");
    style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: rgba(250, 204, 21, 0.45); color: inherit; }`;
    (document.head ?? document.documentElement).appendChild(style);
  }
  return hl;
}

/** The live range of a highlight on this page, if it could be found. */
export const rangeOf = (changeId: string): Range | undefined => highlightRanges.get(changeId);

function applyHighlight(change: HighlightChange, el: Element) {
  unapplyHighlight(change);
  const range = findRange(el, change);
  if (!range) return;
  highlightRanges.set(change.id, range);
  highlightRegistry()?.add(range);
}

function unapplyHighlight(change: HighlightChange) {
  const range = highlightRanges.get(change.id);
  if (!range) return;
  highlightRegistry()?.delete(range);
  highlightRanges.delete(change.id);
}

export function apply(change: Change) {
  const el = elementOf(change.elementId);
  if (!el) return;
  switch (change.type) {
    case "edit": {
      if (originalContent.has(el)) unapply({ ...change, type: "edit" });
      // A single text run next to icons (<button><svg/>Book a demo</button>) is edited in place.
      const runs = textRuns(el);
      if (runs.length === 1 && !change.newText.includes("\n")) {
        const run = runs[0];
        originalContent.set(el, { text: run, data: run.data });
        const [, lead, , trail] = run.data.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
        run.data = lead + change.newText + trail;
      } else {
        originalContent.set(el, { children: Array.from(el.childNodes) });
        setPlainText(el, change.newText);
      }
      break;
    }
    case "remove": {
      const style = (el as HTMLElement).style;
      if (!style) return;
      if (!originalDisplay.has(el))
        originalDisplay.set(el, { value: style.getPropertyValue("display"), priority: style.getPropertyPriority("display") });
      style.setProperty("display", "none", "important");
      break;
    }
    case "note":
      break; // Notes are drawn as pins by the overlay; nothing changes on the page.
    case "highlight":
      applyHighlight(change, el);
      break;
    case "move": {
      const target = elementOf(change.targetId);
      if (!target || !el.parentElement || !target.parentElement || el.contains(target)) return;
      originalPlace.set(change, { parent: el.parentElement, next: el.nextSibling });
      target.parentElement.insertBefore(el, change.position === "before" ? target : target.nextSibling);
      break;
    }
  }
}

export function unapply(change: Change) {
  const el = elementOf(change.elementId);
  if (!el) return;
  switch (change.type) {
    case "edit": {
      const orig = originalContent.get(el);
      if (!orig) break;
      if ("children" in orig) el.replaceChildren(...orig.children);
      else orig.text.data = orig.data;
      originalContent.delete(el);
      break;
    }
    case "remove": {
      const prev = originalDisplay.get(el);
      const style = (el as HTMLElement).style;
      if (!style) return;
      if (prev?.value) style.setProperty("display", prev.value, prev.priority);
      else style.removeProperty("display");
      if (!el.getAttribute("style")) el.removeAttribute("style");
      originalDisplay.delete(el);
      break;
    }
    case "note":
      break;
    case "highlight":
      unapplyHighlight(change);
      break;
    case "move": {
      const place = originalPlace.get(change);
      if (!place) return;
      const next = place.next && place.next.parentNode === place.parent ? place.next : null;
      place.parent.insertBefore(el, next);
      originalPlace.delete(change);
      break;
    }
  }
}

/** Moves the DOM from `before` to `after` for one change slot. */
export function transition(before: Change | null, after: Change | null) {
  if (before) unapply(before);
  if (after) apply(after);
}

/** Sets text like innerText does (newlines become <br>), without HTML parsing. */
export function setPlainText(el: Element, text: string) {
  const nodes: Node[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) nodes.push(document.createElement("br"));
    if (line) nodes.push(document.createTextNode(line));
  });
  el.replaceChildren(...nodes);
}

/** Non-whitespace text nodes inside `el`, ignoring <svg>, <style> and <script> content. */
function textRuns(el: Element): Text[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest("svg,style,script,noscript,template") || !n.nodeValue?.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const out: Text[] = [];
  while (walker.nextNode()) out.push(walker.currentNode as Text);
  return out;
}
