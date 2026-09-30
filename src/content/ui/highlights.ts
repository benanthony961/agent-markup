// Phrase highlights: the "Highlight" chip that appears next to selected page
// text, the highlight editor (quote, category, note), and numbered pins on
// existing highlights. Selecting text works while browsing (hold Alt) or with
// Shift+drag; see the interceptor.
import { executeCommand } from "../commands";
import { truncate } from "../describe";
import { rangeOf } from "../engine";
import { idOf } from "../registry";
import { store, type HighlightDraft } from "../store";
import { anchorElementFor, describeRange, tidy } from "../textAnchor";
import { editingElement } from "./inlineEdit";
import { categorySelect, fillCategories } from "./categories";
import { h, ICONS, isHost } from "./root";

type Rect = { top: number; left: number; bottom: number; right: number; width: number; height: number };

/** The live page selection as a highlight draft, or null if there isn't a usable one. */
function currentDraft(): { draft: HighlightDraft; range: Range } | null {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  if (!el || isHost(el) || el.closest("agent-markup-root")) return null;
  const editing = editingElement();
  if (editing && editing.contains(el)) return null;
  const anchor = anchorElementFor(range);
  if (!anchor) return null;
  const q = describeRange(anchor, range);
  if (!q.quote.trim()) return null;
  return { draft: { elementId: idOf(anchor), ...q }, range };
}

const visible = (r: DOMRect | undefined): Rect | null =>
  r && (r.width || r.height) && r.bottom > 0 && r.top < innerHeight ? r : null;

export function createHighlights() {
  // ---- Selection chip ----
  const chip = h("button", { class: "hl-chip", title: "Highlight this text and add a note", html: ICONS.highlight + "<span>Highlight</span>" });
  let liveRange: Range | null = null;
  // Keep the page selection when the chip is pressed.
  chip.addEventListener("mousedown", (e) => e.preventDefault());
  chip.addEventListener("click", () => {
    const draft = store.get().selectionDraft;
    if (draft) store.set({ highlightEdit: { draft }, selectionDraft: null });
  });

  document.addEventListener("selectionchange", () => {
    if (!store.get().enabled) return;
    const found = currentDraft();
    liveRange = found?.range ?? null;
    const prev = store.get().selectionDraft;
    const next = found?.draft ?? null;
    if (prev?.quote !== next?.quote || prev?.elementId !== next?.elementId || prev?.prefix !== next?.prefix) store.set({ selectionDraft: next });
  });

  // ---- Editor ----
  const quoteBox = h("div", { class: "quote" });
  const category = categorySelect();
  const noteText = h("textarea", { placeholder: "What should change here?", "aria-label": "Note for your coding agent" });
  const deleteBtn = h("button", { class: "btn danger", onclick: () => remove() }, "Remove highlight");
  const editor = h(
    "div",
    { class: "note-editor", role: "dialog", "aria-label": "Highlight" },
    h("div", { class: "title" }, "Highlight"),
    quoteBox,
    category,
    noteText,
    h(
      "div",
      { class: "row" },
      h("span", { class: "spacer", html: `<kbd>${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"}</kbd><kbd>↵</kbd>` }),
      deleteBtn,
      h("button", { class: "btn", onclick: () => close() }, "Cancel"),
      h("button", { class: "btn primary", onclick: () => save() }, "Save"),
    ),
  );
  let editorRect: Rect | null = null;

  const close = () => store.set({ highlightEdit: null });
  async function save() {
    const edit = store.get().highlightEdit;
    if (!edit) return;
    const note = noteText.value;
    if ("draft" in edit) {
      const res = await executeCommand("add_highlight", { ...edit.draft, note, category: category.value });
      if (res.ok) getSelection()?.removeAllRanges();
      else store.set({ toast: { text: res.error ?? "Could not highlight", at: Date.now() } });
    } else {
      await executeCommand("update_annotation", { changeId: edit.changeId, note, category: category.value });
    }
    close();
  }
  async function remove() {
    const edit = store.get().highlightEdit;
    if (edit && "changeId" in edit) await executeCommand("revert_change", { changeId: edit.changeId });
    close();
  }
  noteText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  // Fill the editor when it opens.
  store.subscribe((s, prev) => {
    if (s.highlightEdit === prev.highlightEdit) return;
    const edit = s.highlightEdit;
    if (!edit) return;
    fillCategories(category, s.settings.categories);
    if ("draft" in edit) {
      quoteBox.textContent = `“${truncate(tidy(edit.draft.quote), 220)}”`;
      category.value = s.settings.categories[0]?.id ?? "";
      noteText.value = "";
      deleteBtn.style.display = "none";
      editorRect = visible(liveRange?.getBoundingClientRect());
    } else {
      const c = s.changes.find((c) => c.id === edit.changeId);
      if (!c || c.type !== "highlight") return close();
      quoteBox.textContent = `“${truncate(tidy(c.quote), 220)}”`;
      category.value = c.category ?? "";
      noteText.value = c.note;
      deleteBtn.style.display = "";
      editorRect = null;
    }
    noteText.focus({ preventScroll: true });
  });

  // ---- Pins on existing highlights ----
  const pins = h("div", { class: "pins" });
  let pinKey = "";

  const el = h("div", { style: "display:contents" }, pins, chip, editor);

  function frame() {
    const s = store.get();

    const draft = s.selectionDraft;
    const sr = draft && !s.highlightEdit ? visible(liveRange?.getBoundingClientRect()) : null;
    chip.classList.toggle("show", !!sr);
    if (sr) chip.style.translate = `${Math.max(6, Math.min(sr.right - 90, innerWidth - 110))}px ${sr.bottom + 6 < innerHeight - 34 ? sr.bottom + 6 : Math.max(6, sr.top - 34)}px`;

    const list = s.changes.map((c, i) => ({ c, n: i + 1 })).filter(({ c }) => c.type === "highlight");
    const key = list.map(({ c, n }) => `${c.id}:${n}`).join(",");
    if (key !== pinKey) {
      pinKey = key;
      pins.replaceChildren(
        ...list.map(({ c, n }) =>
          h(
            "button",
            {
              class: "pin hl",
              title: c.type === "highlight" && c.note ? c.note : "Highlight",
              "data-change": c.id,
              onclick: () => store.set({ highlightEdit: { changeId: c.id } }),
            },
            String(n),
          ),
        ),
      );
    }
    for (const pin of Array.from(pins.children) as HTMLElement[]) {
      const rects = rangeOf(pin.dataset.change ?? "")?.getClientRects();
      const last = rects && rects.length ? visible(rects[rects.length - 1]) : null;
      pin.style.display = last ? "" : "none";
      if (last) pin.style.translate = `${Math.min(Math.max(last.right - 4, 2), innerWidth - 22)}px ${Math.max(last.top - 14, 2)}px`;
    }

    const edit = s.highlightEdit;
    const anchor = edit ? ("changeId" in edit ? visible(rangeOf(edit.changeId)?.getBoundingClientRect()) : editorRect) : null;
    editor.classList.toggle("show", !!edit);
    if (edit) {
      const w = 288, hh = editor.offsetHeight || 230;
      const r = anchor ?? { top: innerHeight / 3, bottom: innerHeight / 3, left: innerWidth / 2 - w / 2 } as Rect;
      let y = r.bottom + 8;
      if (y + hh > innerHeight - 8) y = Math.max(8, r.top - hh - 8);
      editor.style.translate = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px ${Math.min(y, innerHeight - hh - 8)}px`;
    }
  }

  return { el, frame };
}
