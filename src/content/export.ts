// Handing a review to an agent: "Send to agent" delivers the agent-markup/v1
// export (markup.ts) to the local receiver, falling back to a file in
// Downloads; tracks what has been sent; and reads the agent's answer back.
// The read-only page bridge lives in bridge.ts.
import { RESULT_MESSAGE, SEND_MESSAGE } from "../shared/messages";
import { serialize, type Change } from "./changes";
import { downloadText } from "./download";
import { buildMarkup, markupFilename, type Markup } from "./markup";
import * as session from "./session";
import { store } from "./store";

/** Receiver first; if it isn't running, a file in Downloads. */
export async function deliver(payload: Markup): Promise<{ via: "receiver"; name: string } | { via: "download"; filename: string }> {
  const res: { ok?: boolean; name?: string } | undefined = await chrome.runtime.sendMessage({ type: SEND_MESSAGE, payload }).catch(() => undefined);
  if (res?.ok && res.name) return { via: "receiver", name: res.name };
  const filename = markupFilename();
  downloadText(filename, JSON.stringify(payload, null, 2));
  return { via: "download", filename };
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
  // Numbered 1..n within this send; the agent answers by number.
  const payload = buildMarkup(pending);
  const numberToId = new Map(pending.map((c, i) => [i + 1, c.id]));
  const sent = await deliver(payload);

  for (const c of pending) sentSignature.set(c.id, signature(c));
  const sync = { ...store.get().sync };
  for (const c of pending) sync[c.id] = { state: "sent" };
  store.set({ sync });

  if (sent.via === "receiver") {
    toast(`Sent ${plural(pending.length)} to agent`);
    void awaitResult(sent.name, numberToId);
  } else toast(`Saved ${plural(pending.length)} to Downloads`);
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
