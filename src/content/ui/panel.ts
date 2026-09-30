// The floating changes panel: list, undo/redo, clear all, copy prompt.
import type { Change } from "../changes";
import { executeCommand } from "../commands";
import { truncate } from "../describe";
import { sendAndTrack, setAutoSend } from "../export";
import { elementOf } from "../registry";
import { store, type State } from "../store";
import { h, ICONS } from "./root";
import { createRouteBody } from "./routePanel";

const PANEL_KEY = "ui:panel";

function detail(c: Change): (Node | string)[] {
  switch (c.type) {
    case "edit":
      return [h("s", {}, truncate(c.oldText, 90) || "(empty)"), h("span", { class: "arrow" }, "→"), truncate(c.newText, 90) || "(empty)"];
    case "remove":
      return [c.snippet ? `“${truncate(c.snippet, 90)}”` : `<${c.tag}>`];
    case "note":
      return [`“${truncate(c.note, 140)}”`];
    case "highlight":
      return [h("mark", { class: "hl-quote" }, truncate(c.quote.replace(/\s+/g, " ").trim(), 90)), c.note ? ` — ${truncate(c.note, 110)}` : ""];
    case "move":
      return [`“${truncate(c.snippet || c.tag, 40)}” ${c.position} “${truncate(c.targetSnippet || "sibling", 40)}”`];
  }
}

function setDisabled(btn: HTMLButtonElement, disabled: boolean) {
  btn.disabled = disabled;
  btn.setAttribute("aria-disabled", String(disabled));
}

function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return truncate(u.pathname + u.search, 44) || "/";
  } catch {
    return url;
  }
}

const KIND_LABEL: Record<Change["type"], string> = { edit: "Edit text", remove: "Remove", note: "Note", move: "Move", highlight: "Highlight" };
const KIND_ICON: Record<Change["type"], string> = { edit: ICONS.edit, remove: ICONS.remove, note: ICONS.note, move: ICONS.move, highlight: ICONS.highlight };

export function createPanel() {
  const count = h("span", { class: "count" }, "0");
  const collapseBtn = h("button", { class: "icon-btn collapse", title: "Collapse", "aria-label": "Collapse panel", html: ICONS.chevron });
  const closeBtn = h("button", { class: "icon-btn", title: "Turn off Agent Markup (Alt+Shift+R)", "aria-label": "Turn off", html: ICONS.close });
  const markupTab = h("button", { class: "mode-tab", role: "tab", title: "Edit the page and send changes to your agent" }, "Markup");
  const routeTab = h("button", { class: "mode-tab", role: "tab", title: "Record a click-through for a walkthrough video" }, "Route");
  markupTab.addEventListener("click", () => void executeCommand("set_mode", { mode: "markup" }));
  routeTab.addEventListener("click", () => void executeCommand("set_mode", { mode: "route" }));
  const head = h(
    "div",
    { class: "head" },
    h("span", { class: "logo", html: ICONS.mark }),
    h("div", { class: "modes", role: "tablist", "aria-label": "Mode" }, markupTab, routeTab),
    count,
    h("span", { class: "browse" }, "Browsing"),
    h("span", { class: "grow" }),
    collapseBtn,
    closeBtn,
  );
  const list = h("ol", { class: "list" });
  const undoBtn = h("button", { class: "btn quiet", title: "Undo (⌘/Ctrl+Z)", html: ICONS.undo + "<span>Undo</span>" });
  const redoBtn = h("button", { class: "btn quiet", title: "Redo (⌘/Ctrl+Shift+Z)", html: ICONS.redo + "<span>Redo</span>" });
  const clearBtn = h("button", { class: "btn danger" }, "Clear all");
  const copyBtn = h("button", { class: "btn primary copy" });
  const sendBtn = h("button", {
    class: "btn send",
    title: "Send new changes to the agent (⌘⇧Enter). Saves a JSON file to Downloads if the receiver is off.",
    html: ICONS.send + "<span>Send to agent</span>",
  });
  const autoBox = h("input", { type: "checkbox", id: "am-auto" }) as HTMLInputElement;
  const autoRow = h("label", { class: "auto", for: "am-auto" }, autoBox, h("span", {}, "Auto-send after a 5s pause"));
  autoBox.addEventListener("change", () => setAutoSend(autoBox.checked));
  const copyHelp = h("div", { class: "copy-help", role: "status" });
  const body = h(
    "div",
    { class: "body" },
    list,
    h("div", { class: "tools" }, undoBtn, redoBtn, h("span", { class: "grow" }), clearBtn),
    copyBtn,
    sendBtn,
    copyHelp,
    autoRow,
    h("div", { class: "foot", html: "Hold <kbd>Alt</kbd> to use the page normally" }),
  );
  const routeBody = createRouteBody();
  const panel = h("div", { class: "panel", role: "region", "aria-label": "Agent Markup" }, head, body, routeBody.el);

  undoBtn.addEventListener("click", () => void executeCommand("undo"));
  redoBtn.addEventListener("click", () => void executeCommand("redo"));
  closeBtn.addEventListener("click", () => void executeCommand("set_enabled", { enabled: false }));
  collapseBtn.addEventListener("click", () => setPanel({ collapsed: !store.get().panel.collapsed }));

  // Clear all runs immediately; an inline Undo strip covers mistakes.
  let undoOffer: { count: number; after: Change[]; timer: number } | null = null;
  const dismissUndo = () => {
    if (!undoOffer) return;
    clearTimeout(undoOffer.timer);
    undoOffer = null;
  };
  clearBtn.addEventListener("click", async () => {
    const res = await executeCommand("clear_all");
    const count = (res.data as { cleared?: number } | undefined)?.cleared ?? 0;
    if (!res.ok || !count) return;
    dismissUndo();
    undoOffer = { count, after: store.get().changes, timer: window.setTimeout(() => (dismissUndo(), rerender()), 8000) };
    rerender();
  });

  sendBtn.addEventListener("click", async () => {
    try {
      await sendAndTrack();
    } catch (err) {
      flashCopy({ label: "Export failed", kind: "error", help: String((err as Error)?.message ?? err) });
    }
  });

  let copyTimer = 0;
  let copyState: { label: string; kind: "done" | "error"; help?: string } | null = null;
  copyBtn.addEventListener("click", async () => {
    const res = await executeCommand("copy_prompt");
    if (!res.ok) flashCopy({ label: "Copy failed", kind: "error", help: `${res.error ?? "The clipboard isn’t available"}. Try again, or click the page first.` });
  });
  const flashCopy = (state: NonNullable<typeof copyState>) => {
    copyState = state;
    clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copyState = null;
      render(store.get());
    }, state.kind === "error" ? 6000 : 2500);
    render(store.get());
  };

  // Dragging the panel by its header.
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as Element).closest("button") || e.button !== 0) return;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const x = Math.min(Math.max(ev.clientX - dx, 4), innerWidth - r.width - 4);
      const y = Math.min(Math.max(ev.clientY - dy, 4), innerHeight - 40);
      applyPos(x, y);
    };
    const up = (ev: PointerEvent) => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      const pr = panel.getBoundingClientRect();
      if (Math.abs(ev.clientX - dx - r.left) > 2 || Math.abs(ev.clientY - dy - r.top) > 2) {
        // Anchor to the nearer vertical edge so the panel grows into open space.
        const lower = pr.top + pr.height / 2 > innerHeight / 2;
        setPanel({ x: pr.left, y: lower ? innerHeight - pr.bottom : pr.top, anchor: lower ? "bottom" : "top" });
      }
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
  });

  function applyPos(x: number | null, y: number | null, anchor: "top" | "bottom" = "top") {
    const s = panel.style;
    if (x === null || y === null) {
      s.left = s.top = s.right = s.bottom = s.maxHeight = "";
      return;
    }
    // Keep the panel on screen after viewport resizes, and cap its height to the
    // space left between the anchored edge and the far edge so the list scrolls
    // instead of pushing the Copy button off screen.
    const cx = Math.min(Math.max(x, 4), Math.max(4, innerWidth - panel.offsetWidth - 4));
    const cy = Math.min(Math.max(y, 4), Math.max(4, innerHeight - 120));
    s.left = `${cx}px`;
    s.right = "auto";
    s[anchor] = `${cy}px`;
    s[anchor === "top" ? "bottom" : "top"] = "auto";
    s.maxHeight = `min(560px, calc(100vh - ${cy + 12}px))`;
  }

  function setPanel(patch: Partial<State["panel"]>) {
    const next = { ...store.get().panel, ...patch };
    store.set({ panel: next });
    void chrome.storage.local.set({ [PANEL_KEY]: next }).catch(() => {});
  }

  let lastToast = 0;
  let lastChanges: Change[] | null = null;
  let lastPageKey = "";
  let lastOfferKey = 0;
  let lastSync: State["sync"] | null = null;
  const rerender = () => {
    lastChanges = null;
    render(store.get());
  };
  const undoStrip = (count: number) => {
    const undo = h("button", { class: "btn" }, "Undo");
    undo.addEventListener("click", () => {
      dismissUndo();
      void executeCommand("undo");
    });
    return h("li", { class: "undo-strip", role: "status" }, h("span", {}, `Cleared ${count} ${count === 1 ? "change" : "changes"}`), undo);
  };
  let routeToastTimer = 0;
  function render(s: State) {
    const route = s.mode === "route";
    panel.classList.toggle("route-mode", route);
    markupTab.setAttribute("aria-selected", String(!route));
    routeTab.setAttribute("aria-selected", String(route));
    if (route) {
      count.textContent = String(s.route?.steps.filter((x) => x.kind !== "chapter").length ?? 0);
      panel.classList.toggle("collapsed", s.panel.collapsed);
      collapseBtn.title = s.panel.collapsed ? "Expand" : "Collapse";
      applyPos(s.panel.x, s.panel.y, s.panel.anchor);
      routeBody.render(s);
      if (s.toast && s.toast.at !== lastToast) {
        lastToast = s.toast.at;
        panel.dataset.toast = s.toast.text;
        clearTimeout(routeToastTimer);
        routeToastTimer = window.setTimeout(() => delete panel.dataset.toast, 2600);
      }
      lastChanges = null;
      return;
    }
    if (s.toast && s.toast.at !== lastToast) {
      lastToast = s.toast.at;
      flashCopy({ label: s.toast.text, kind: "done" });
      return;
    }
    const n = s.changes.length;
    count.textContent = String(n);
    panel.classList.toggle("collapsed", s.panel.collapsed);
    collapseBtn.title = s.panel.collapsed ? "Expand" : "Collapse";
    applyPos(s.panel.x, s.panel.y, s.panel.anchor);
    setDisabled(undoBtn, !s.canUndo);
    setDisabled(redoBtn, !s.canRedo);
    setDisabled(clearBtn, n === 0);
    setDisabled(sendBtn, n === 0);
    autoBox.checked = s.autoSend;
    copyBtn.classList.toggle("done", copyState?.kind === "done");
    copyBtn.classList.toggle("error", copyState?.kind === "error");
    copyBtn.replaceChildren(
      h("span", { class: "copy-icon", html: copyState ? (copyState.kind === "done" ? ICONS.check : ICONS.warn) : ICONS.copy }),
      h("span", {}, copyState?.label ?? "Copy prompt"),
      copyState ? "" : h("span", { class: "copy-count" }, String(n)),
    );
    copyHelp.textContent = copyState?.help ?? "";
    copyHelp.classList.toggle("show", !!copyState?.help);
    if (undoOffer && s.changes !== undoOffer.after) dismissUndo();

    const offerKey = undoOffer ? undoOffer.timer : 0;
    if (s.changes === lastChanges && s.pageKey === lastPageKey && offerKey === lastOfferKey && s.sync === lastSync) return;
    lastChanges = s.changes;
    lastPageKey = s.pageKey;
    lastOfferKey = offerKey;
    lastSync = s.sync;
    const strip = undoOffer ? [undoStrip(undoOffer.count)] : [];
    if (!n) {
      list.replaceChildren(
        ...strip,
        h(
          "li",
          { class: "empty" },
          h("div", { class: "e-title" }, "No changes yet."),
          h("div", {}, "Click text to edit it. Shift+click an element to remove it, add a note or move it."),
          h("div", { class: "e-hint", html: "<kbd>⌘⇧Enter</kbd> sends your changes to the agent." }),
        ),
      );
      return;
    }
    const multiPage = new Set(s.changes.map((c) => c.page.key)).size > 1;
    const rows: HTMLElement[] = [];
    s.changes.forEach((c, i) => {
      const here = c.page.key === s.pageKey;
      if (multiPage && c.page.key !== s.changes[i - 1]?.page.key) {
        rows.push(
          h(
            "li",
            { class: `page-head${here ? " here" : ""}`, title: c.page.url },
            h("span", { class: "page-path" }, pagePath(c.page.url)),
            here ? h("span", { class: "page-here" }, "This page") : "",
          ),
        );
      }
      const found = here && !!elementOf(c.elementId);
      const x = h("button", { class: "x", title: "Revert this change", "aria-label": `Revert change ${i + 1}`, html: ICONS.close });
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        void executeCommand("revert_change", { changeId: c.id });
      });
      const item = h(
        "li",
        {
          class: `item${found ? "" : here ? " missing" : " elsewhere"}`,
          title: found ? c.selector : here ? "Element not found on the page" : `Go to ${pagePath(c.page.url)}`,
        },
        h("span", { class: "num" }, String(i + 1)),
        h(
          "div",
          { class: "main" },
          h(
            "div",
            { class: `kind k-${c.type}` },
            h("span", { class: "k-icon", html: KIND_ICON[c.type] }),
            KIND_LABEL[c.type],
            h("span", { class: "where" }, `<${c.tag}>`),
            "category" in c && c.category
              ? h("span", { class: "cat" }, s.settings.categories.find((k) => k.id === c.category)?.label ?? c.category)
              : "",
            here && !found ? h("span", { class: "flag" }, "Not on page") : "",
            s.sync[c.id] ? h("span", { class: `flag sync-${s.sync[c.id].state}`, title: s.sync[c.id].note ?? "" }, s.sync[c.id].state === "sent" ? "Sent" : "Needs your call") : "",
          ),
          h("div", { class: "detail" }, ...detail(c)),
          s.sync[c.id]?.note ? h("div", { class: "agent-note" }, s.sync[c.id].note!) : "",
        ),
        x,
      );
      item.addEventListener("click", () => {
        if (found) void executeCommand("select_element", { elementId: c.elementId, scrollIntoView: true, flash: true });
        else if (!here) location.assign(c.page.url);
      });
      rows.push(item);
    });
    list.replaceChildren(...strip, ...rows);
  }

  addEventListener("resize", () => {
    const { x, y, anchor } = store.get().panel;
    applyPos(x, y, anchor);
  });

  async function loadPosition() {
    const saved = (await chrome.storage.local.get(PANEL_KEY).catch(() => ({} as Record<string, unknown>)))[PANEL_KEY] as State["panel"] | undefined;
    if (saved)
      store.set({ panel: { collapsed: !!saved.collapsed, x: saved.x ?? null, y: saved.y ?? null, anchor: saved.anchor ?? "top" } });
  }

  return { el: panel, render, loadPosition };
}
