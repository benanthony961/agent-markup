// The agent-markup/v1 export and everything around handing a review to an agent:
// "Send to agent" (local receiver, Downloads fallback), tracking what has been
// sent, reading the agent's answer back, and the page bridge.
import { RESULT_MESSAGE, SEND_MESSAGE } from "../shared/messages";
import { serialize, type Change } from "./changes";
import { executeCommand } from "./commands";
import * as session from "./session";
import { store } from "./store";

export const EXPORT_FORMAT = "agent-markup/v1";

export interface MarkupExport {
  format: typeof EXPORT_FORMAT;
  site: string;
  exportedAt: string;
  changes: { id: string; number: number }[];
}

/** All changes, or only those whose ids are in `only`. `number` is the position in the full list. */
export async function buildExport(only?: Set<string>): Promise<MarkupExport> {
  const res = await executeCommand("list_changes");
  const all = (res.data as MarkupExport["changes"] | undefined) ?? [];
  return {
    format: EXPORT_FORMAT,
    site: location.origin,
    exportedAt: new Date().toISOString(),
    changes: only ? all.filter((c) => only.has(c.id)) : all,
  };
}

/** Saves the export as ~/Downloads/agent-markup-<host>-<time>.json (the name agents look for). */
async function download(data: MarkupExport) {
  const stamp = data.exportedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const host = location.host.replace(/[^a-z0-9.-]/gi, "_");
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `agent-markup-${host}-${stamp}.json`;
  document.documentElement.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---- Sent-state tracking ---------------------------------------------------

/** What each change looked like when it was last sent, so only new or edited ones go out next time. */
const sentSignature = new Map<string, string>();
const signature = (c: Change) => JSON.stringify(serialize(c));
const unsent = () => session.changes().filter((c) => sentSignature.get(c.id) !== signature(c));

const toast = (text: string) => store.set({ toast: { text, at: Date.now() } });
const plural = (n: number) => `${n} change${n === 1 ? "" : "s"}`;

interface AgentResult {
  results?: { number: number; status: "applied" | "needs-call"; note?: string }[];
}

/** Sends the changes the agent hasn't seen yet. Delivered: watch for its answer. Otherwise: save a file. */
export async function sendAndTrack(): Promise<void> {
  const pending = unsent();
  if (!pending.length) return toast("Nothing new to send");
  const payload = await buildExport(new Set(pending.map((c) => c.id)));
  const numberToId = new Map(payload.changes.map((c) => [c.number, c.id]));
  const res: { ok?: boolean; name?: string } | undefined = await chrome.runtime.sendMessage({ type: SEND_MESSAGE, payload }).catch(() => undefined);

  for (const c of pending) sentSignature.set(c.id, signature(c));
  const sync = { ...store.get().sync };
  for (const c of pending) sync[c.id] = { state: "sent" };
  store.set({ sync });

  if (res?.ok && res.name) {
    toast(`Sent ${plural(pending.length)} to agent`);
    void awaitResult(res.name, numberToId);
  } else {
    await download(payload);
    toast(`Saved ${plural(pending.length)} to Downloads`);
  }
}

/** Polls the receiver for the agent's answer, then dismisses what it applied and flags what needs a decision. */
async function awaitResult(name: string, numberToId: Map<number, string>) {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    // The receiver holds this request open for up to 25s until the answer exists, so this isn't a tight loop.
    const res: { ok?: boolean; status?: number; data?: AgentResult } | undefined = await chrome.runtime.sendMessage({ type: RESULT_MESSAGE, name }).catch(() => undefined);
    if (!res?.ok) {
      // Receiver unreachable: back off instead of hammering it.
      if (!res?.status) await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    const applied: string[] = [];
    const sync = { ...store.get().sync };
    for (const r of res.data?.results ?? []) {
      const id = numberToId.get(r.number);
      if (!id) continue;
      if (r.status === "applied") {
        applied.push(id);
        delete sync[id];
        sentSignature.delete(id);
      } else {
        sync[id] = { state: "needs-call", note: r.note };
      }
    }
    store.set({ sync });
    session.dismiss(applied);
    const flagged = (res.data?.results ?? []).length - applied.length;
    toast(flagged > 0 ? `${applied.length} applied, ${flagged} need your call` : `${plural(applied.length)} applied`);
    return;
  }
}

// ---- Auto-send after a pause -----------------------------------------------

const AUTO_SEND_KEY = "autoSend";
const AUTO_SEND_DELAY = 5000;

export function setAutoSend(on: boolean) {
  store.set({ autoSend: on });
  void chrome.storage.local.set({ [AUTO_SEND_KEY]: on }).catch(() => {});
}

export async function initAutoSend() {
  const saved = (await chrome.storage.local.get(AUTO_SEND_KEY).catch(() => ({} as Record<string, unknown>)))[AUTO_SEND_KEY];
  store.set({ autoSend: saved === true });
  let timer = 0;
  store.subscribe((s, prev) => {
    if (s.changes === prev.changes && s.autoSend === prev.autoSend) return;
    clearTimeout(timer);
    if (!s.enabled || !s.autoSend || s.editingId || s.noteEditingId || !unsent().length) return;
    timer = window.setTimeout(() => void sendAndTrack(), AUTO_SEND_DELAY);
  });
}

// ---- Page bridge -----------------------------------------------------------

export const BRIDGE_REQUEST = "agent-markup:request";
export const BRIDGE_RESPONSE = "agent-markup:response";

/**
 * Lets an agent driving this tab read the markup in place (postMessage from the
 * page context, same origin only, read-only, and only while Agent Markup is on).
 */
export function installBridge(isEnabled: () => boolean) {
  addEventListener("message", async (e) => {
    const m = e.data as { type?: string; id?: string; name?: string } | null;
    if (e.source !== window || e.origin !== location.origin || m?.type !== BRIDGE_REQUEST || m.name !== "get_markup") return;
    const result = isEnabled()
      ? { ok: true, data: await buildExport() }
      : { ok: false, error: "Agent Markup is off on this tab" };
    postMessage({ type: BRIDGE_RESPONSE, id: m.id, result }, location.origin);
  });
}
