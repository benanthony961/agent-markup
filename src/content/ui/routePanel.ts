// The panel body in route mode: record/pause, the recorded steps with
// thumbnails and editable captions, chapters, export and the agent prompt.
import { FRAMES_MESSAGE } from "../../shared/messages";
import type { RouteStep } from "../../shared/route";
import { copyText } from "../clipboard";
import { executeCommand } from "../commands";
import { truncate } from "../describe";
import { idOf } from "../registry";
import { frameKey } from "../route/state";
import { store, type State } from "../store";
import { h, ICONS, shadow } from "./root";

const KIND: Record<RouteStep["kind"], { label: string; icon: string }> = {
  click: { label: "Click", icon: ICONS.pointer },
  fill: { label: "Type", icon: ICONS.edit },
  select: { label: "Choose", icon: ICONS.chevron },
  check: { label: "Toggle", icon: ICONS.check },
  press: { label: "Press", icon: ICONS.key },
  scroll: { label: "Scroll", icon: ICONS.move },
  navigate: { label: "Go to", icon: ICONS.arrow },
  chapter: { label: "Chapter", icon: ICONS.note },
};

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function detail(s: RouteStep): string {
  const t = s.target;
  const name = t ? truncate(t.name || t.label || `<${t.tag}>`, 48) : "";
  switch (s.kind) {
    case "fill":
      return `${name} ← ${s.sensitive ? "(hidden)" : `“${truncate(s.value ?? "", 48)}”`}`;
    case "select":
      return `${name} ← “${truncate(s.value ?? "", 48)}”`;
    case "check":
      return `${name}${s.checked === undefined ? "" : s.checked ? " → on" : " → off"}`;
    case "press":
      return `${s.key}${name ? ` in ${name}` : ""}`;
    case "scroll": {
      const d = (s.scroll?.toY ?? 0) - (s.scroll?.fromY ?? 0);
      return `${d >= 0 ? "Down" : "Up"} ${Math.abs(Math.round(d))}px${s.scroll?.container ? ` in ${truncate(s.scroll.container, 36)}` : ""}`;
    }
    case "navigate":
      return pathOf(s.value ?? "");
    default:
      return `${name}${s.navigatesTo ? ` → ${pathOf(s.navigatesTo)}` : ""}`;
  }
}

export function createRouteBody() {
  const title = h("input", { class: "r-title", type: "text", placeholder: "Name this route, e.g. “Receive a purchase order”", "aria-label": "Route title" }) as HTMLInputElement;
  const status = h("div", { class: "r-status", role: "status" });
  const list = h("ol", { class: "list r-list" });
  const recBtn = h("button", { class: "btn r-rec" });
  const chapterBtn = h("button", { class: "btn quiet", title: "Add a chapter card after the last step" }, "+ Chapter");
  const clearBtn = h("button", { class: "btn danger" }, "Clear");
  const exportBtn = h("button", { class: "btn primary r-export", title: "Save route.json and frames for the HyperFrames composer" });
  const promptBtn = h("button", { class: "btn r-prompt", title: "Copy a prompt describing the route and how to build the video" }, "Copy prompt");
  const el = h(
    "div",
    { class: "body r-body" },
    h("div", { class: "r-top" }, title, status),
    list,
    h("div", { class: "tools" }, recBtn, chapterBtn, h("span", { class: "grow" }), clearBtn),
    exportBtn,
    promptBtn,
    h("div", { class: "foot", html: "Pause a beat after each action so its frame is saved" }),
  );

  title.addEventListener("change", () => void executeCommand("rename_route", { title: title.value }));
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") title.blur();
  });
  recBtn.addEventListener("click", () => {
    const s = store.get();
    void executeCommand(s.recording ? "stop_recording" : "start_recording", s.recording ? {} : { title: title.value });
  });
  chapterBtn.addEventListener("click", async () => {
    const res = await executeCommand("add_chapter", { title: "New chapter" });
    focusOnRender = (res.data as { stepId?: string } | undefined)?.stepId ?? null;
  });
  let clearArmed = 0;
  clearBtn.addEventListener("click", () => {
    if (clearArmed) {
      clearTimeout(clearArmed);
      clearArmed = 0;
      clearBtn.textContent = "Clear";
      void executeCommand("clear_route");
      return;
    }
    clearBtn.textContent = "Delete route?";
    clearArmed = window.setTimeout(() => {
      clearArmed = 0;
      clearBtn.textContent = "Clear";
    }, 3000);
  });
  exportBtn.addEventListener("click", async () => {
    exportBtn.disabled = true;
    const res = await executeCommand("export_route");
    exportBtn.disabled = false;
    if (!res.ok) store.set({ toast: { text: res.error ?? "Export failed", at: Date.now() } });
  });
  promptBtn.addEventListener("click", async () => {
    const res = await executeCommand("get_route_prompt");
    if (!res.ok) return store.set({ toast: { text: res.error ?? "No route", at: Date.now() } });
    try {
      await copyText((res.data as { prompt: string }).prompt);
      store.set({ toast: { text: "Prompt copied", at: Date.now() } });
    } catch {
      store.set({ toast: { text: "Copy failed: click the page, then try again", at: Date.now() } });
    }
  });

  // ---- Thumbnails --------------------------------------------------------------
  const thumbs = new Map<string, string>();
  const requested = new Set<string>();
  async function loadThumbs() {
    const imgs = Array.from(list.querySelectorAll<HTMLImageElement>("img[data-key]"));
    const want = [...new Set(imgs.map((i) => i.dataset.key!).filter((k) => !thumbs.has(k) && !requested.has(k)))];
    for (const img of imgs) if (thumbs.has(img.dataset.key!)) img.src = thumbs.get(img.dataset.key!)!;
    if (!want.length) return;
    want.forEach((k) => requested.add(k));
    const res: { data?: Record<string, string> } | undefined = await chrome.runtime.sendMessage({ type: FRAMES_MESSAGE, keys: want }).catch(() => undefined);
    for (const [k, v] of Object.entries(res?.data ?? {})) thumbs.set(k, v);
    for (const img of list.querySelectorAll<HTMLImageElement>("img[data-key]")) if (thumbs.has(img.dataset.key!)) img.src = thumbs.get(img.dataset.key!)!;
  }

  // ---- Rows ------------------------------------------------------------------
  let focusOnRender: string | null = null;

  function editable(text: string, placeholder: string, onSave: (v: string) => void, cls: string) {
    const node = h("div", { class: cls, contenteditable: "plaintext-only", spellcheck: "false", "data-placeholder": placeholder }, text);
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        node.blur();
      } else if (e.key === "Escape") {
        node.textContent = text;
        node.blur();
      }
    });
    node.addEventListener("blur", () => {
      const v = (node.textContent ?? "").trim();
      if (v !== text) onSave(v);
    });
    node.addEventListener("click", (e) => e.stopPropagation());
    return node;
  }

  function row(s: RouteStep, n: number, routeId: string): HTMLElement {
    const x = h("button", { class: "x", title: "Delete this step", "aria-label": `Delete step ${n}`, html: ICONS.close });
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      void executeCommand("delete_step", { stepId: s.id });
    });
    if (s.kind === "chapter") {
      const t = editable(s.title ?? "", "Chapter title", (v) => void executeCommand("update_step", { stepId: s.id, title: v || "Chapter" }), "r-chapter-title");
      t.dataset.step = s.id;
      return h("li", { class: "r-chapter" }, h("span", { class: "k-icon", html: ICONS.note }), t, x);
    }
    const star = h("button", {
      class: `r-star${s.emphasis ? " on" : ""}`,
      title: s.emphasis ? "Emphasized: holds longer and zooms closer" : "Emphasize this step",
      "aria-pressed": String(!!s.emphasis),
      html: ICONS.star,
    });
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      void executeCommand("update_step", { stepId: s.id, emphasis: !s.emphasis });
    });
    const frameId = s.frames.after ?? s.frames.focused ?? s.frames.before;
    const thumb = frameId
      ? h("img", { class: "r-thumb", alt: "", "data-key": frameKey(routeId, frameId) })
      : h("div", { class: "r-thumb pending", title: "Frame not saved yet" });
    const caption = editable(s.caption, "Caption", (v) => void executeCommand("update_step", { stepId: s.id, caption: v }), "r-cap");
    const warn = s.warnings?.length ? h("span", { class: "flag warn", title: s.warnings.join("\n"), html: ICONS.warn }) : "";
    const item = h(
      "li",
      { class: "item r-step", title: s.target?.selector ?? pathOf(s.page.url) },
      h("span", { class: "num" }, String(n)),
      h(
        "div",
        { class: "main" },
        h("div", { class: `kind k-${s.kind}` }, h("span", { class: "k-icon", html: KIND[s.kind].icon }), KIND[s.kind].label, h("span", { class: "where" }, s.target ? `<${s.target.tag}>` : ""), warn),
        caption,
        h("div", { class: "detail" }, detail(s)),
      ),
      thumb,
      h("div", { class: "r-actions" }, x, star),
    );
    // Clicking a step flashes its element when it's on this page.
    item.addEventListener("click", () => {
      if (!s.target || s.page.url.split("#")[0] !== location.href.split("#")[0]) return;
      try {
        const found = document.querySelectorAll(s.target.selector);
        if (found.length === 1) {
          found[0].scrollIntoView({ block: "center", behavior: "smooth" });
          store.set({ flash: { elementId: idOf(found[0]), at: Date.now() } });
        }
      } catch {
        // Selector no longer valid on this page.
      }
    });
    return item;
  }

  let lastRoute: State["route"] | undefined;
  let lastCount = 0;
  function render(s: State) {
    const r = s.route;
    const steps = r?.steps.filter((x) => x.kind !== "chapter").length ?? 0;
    if (shadow()?.activeElement !== title) title.value = r?.title ?? "";
    recBtn.innerHTML = s.recording ? `${ICONS.pause}<span>Pause</span>` : `${ICONS.record}<span>${r ? "Resume" : "Record"}</span>`;
    recBtn.classList.toggle("recording", s.recording);
    for (const b of [clearBtn, exportBtn, promptBtn]) b.disabled = !r;
    exportBtn.disabled = !steps;
    exportBtn.replaceChildren(h("span", { class: "r-export-icon", html: ICONS.film }), h("span", {}, "Export route"), h("span", { class: "r-export-count" }, String(steps)));

    const pending = s.capture.pending > 0;
    status.className = `r-status${s.recording ? " rec" : ""}${s.capture.error ? " err" : ""}`;
    status.replaceChildren(
      h("span", { class: `r-dot${pending ? " busy" : ""}` }),
      s.capture.error
        ? s.capture.error
        : !r
          ? "Record, then use the page normally. Clicks, typed values, choices and key presses become steps."
          : s.recording
            ? pending
              ? "Recording · saving frame…"
              : "Recording · ready for the next action"
            : `Paused · ${steps} step${steps === 1 ? "" : "s"}`,
    );

    // Don't rebuild the list under someone typing a caption.
    const active = shadow()?.activeElement;
    if (r === lastRoute || (active && list.contains(active))) return;
    lastRoute = r;
    if (!r?.steps.length) {
      list.replaceChildren(
        h(
          "li",
          { class: "empty" },
          h("div", { class: "e-title" }, "No steps yet."),
          h("div", {}, "Every step gets a screenshot, the control’s name and the value you entered, ready to animate in HyperFrames."),
        ),
      );
      lastCount = 0;
      return;
    }
    let n = 0;
    const rows: HTMLElement[] = [];
    let page = "";
    for (const st of r.steps) {
      const p = pathOf(st.page.url);
      if (st.kind !== "chapter" && p !== page) {
        page = p;
        rows.push(h("li", { class: "page-head" }, h("span", { class: "page-path" }, truncate(p, 44) || "/")));
      }
      rows.push(row(st, st.kind === "chapter" ? n : ++n, r.id));
    }
    list.replaceChildren(...rows);
    if (r.steps.length > lastCount && s.recording) list.scrollTop = list.scrollHeight;
    lastCount = r.steps.length;
    void loadThumbs();
    if (focusOnRender) {
      const t = list.querySelector<HTMLElement>(`[data-step="${focusOnRender}"]`);
      focusOnRender = null;
      if (t) {
        t.focus();
        const range = document.createRange();
        range.selectNodeContents(t);
        const sel = (shadow() as unknown as { getSelection?: () => Selection | null })?.getSelection?.() ?? getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }

  return { el, render };
}
