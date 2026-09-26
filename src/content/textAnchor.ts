// Text-quote anchoring for highlights: a highlighted phrase is stored as the
// exact text plus a little of the text on either side, so it can be found
// again after a reload even if the DOM nodes were re-created.
//
// Offsets are counted in the element's textContent, the same basis that
// Range.toString() uses, so capture and lookup agree on whitespace.

const CONTEXT = 32;

export interface TextQuote {
  quote: string;
  prefix: string;
  suffix: string;
}

/** Offset of a boundary point within `root`'s text content. */
function offsetOf(root: Node, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** Describes `range` as a quote with context, relative to `root`. */
export function describeRange(root: Element, range: Range): TextQuote {
  const text = root.textContent ?? "";
  const start = offsetOf(root, range.startContainer, range.startOffset);
  const end = offsetOf(root, range.endContainer, range.endOffset);
  return {
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

/** Length of the common suffix of `a` and `b`. */
function commonTail(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Length of the common prefix of `a` and `b`. */
function commonHead(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Maps a text offset in `root` to a (Text node, offset) boundary point. */
function pointAt(root: Element, target: number, preferNext: boolean): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last: Text | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const len = node.data.length;
    // At a boundary between two nodes, a range start belongs to the next node
    // and a range end to the previous one.
    if (target < seen + len || (target === seen + len && !preferNext)) return { node, offset: target - seen };
    seen += len;
    last = node;
  }
  return last && target === seen ? { node: last, offset: last.data.length } : null;
}

/** Finds the best match for `q` inside `root`, or null if the quote is gone. */
export function findRange(root: Element, q: TextQuote): Range | null {
  if (!q.quote) return null;
  const text = root.textContent ?? "";
  let best = -1;
  let bestScore = -1;
  for (let i = text.indexOf(q.quote); i !== -1; i = text.indexOf(q.quote, i + 1)) {
    const score = commonTail(text.slice(0, i), q.prefix) + commonHead(text.slice(i + q.quote.length), q.suffix);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  if (best === -1) return null;
  const start = pointAt(root, best, true);
  const end = pointAt(root, best + q.quote.length, false);
  if (!start || !end) return null;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

const BLOCK = "p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,dd,dt,figcaption,pre,summary,caption,label,button,a";

/** The element a highlight is attached to: the nearest block around the whole range. */
export function anchorElementFor(range: Range): Element | null {
  const node = range.commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  if (!el) return null;
  const block = el.closest(BLOCK);
  if (block && block !== document.body && block !== document.documentElement) return block;
  return el === document.body || el === document.documentElement ? null : el;
}

/** Collapses runs of whitespace, for display and prompts. */
export const tidy = (s: string) => s.replace(/\s+/g, " ").trim();
