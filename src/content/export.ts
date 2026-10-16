// Handing a review to an agent: "Send to agent" delivers the agent-markup/v1
// export (markup.ts) to the local receiver, falling back to a file in
// Downloads; tracks what has been sent; and reads the agent's answer back.
// The read-only page bridge lives in bridge.ts.
import { HEALTH_MESSAGE, RESULT_MESSAGE, SEND_MESSAGE, TODO_CAPTURED_MESSAGE, TODO_MESSAGE, TODO_STATUS_MESSAGE } from "../shared/messages";
import { serialize, type Change } from "./changes";
import { downloadText } from "./download";
import { buildMarkup, markupFilename, type Markup } from "./markup";
import * as session from "./session";
import { store } from "./store";
import { setHostHidden } from "./ui/root";

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

/** Shows a send's progress on the Send button; a finished state clears itself. */
let statusTimer = 0;
function setSendStatus(status: NonNullable<ReturnType<typeof store.get>["sendStatus"]>) {
  clearTimeout(statusTimer);
  store.set({ sendStatus: status });
  if (status.kind !== "busy") statusTimer = window.setTimeout(() => store.set({ sendStatus: null }), status.kind === "error" ? 8000 : 4000);
}

interface AgentResult {
  results?: { number: number; status: "applied" | "needs-call"; note?: string }[];
}

/** Where Send goes now: the chosen destination, or with "auto" an agent when one is waiting, else a to-do. */
export function effectiveDestination(s = store.get()): "agent" | "todo" {
  if (s.destination !== "auto") return s.destination;
  return s.agentListening ? "agent" : "todo";
}

/** Sends the changes not sent yet, to a waiting agent or as a to-do. */
export async function sendAndTrack(): Promise<void> {
  if (store.get().sendStatus?.kind === "busy") return;
  const pending = unsent();
  if (!pending.length) return toast("Nothing new to send");
  if (effectiveDestination() === "todo") return sendAsTodo(pending);
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

/**
 * Files the changes as a to-do: the receiver keeps the review and a screenshot of the
 * page, and AIM Text Bridge turns it into a to-do with an Orca agent working on it.
 */
async function sendAsTodo(pending: Change[]): Promise<void> {
  const payload = buildMarkup(pending);
  setSendStatus({ label: "Taking screenshot…", kind: "busy" });
  // Our own UI is hidden for the screenshot, as for route frames. The background
  // says when the shot is taken, so progress shows again while the to-do is filed.
  const onCaptured = (msg: { type?: string }) => {
    if (msg?.type !== TODO_CAPTURED_MESSAGE) return;
    setHostHidden(false);
    setSendStatus({ label: "Filing to-do…", kind: "busy" });
  };
  chrome.runtime.onMessage.addListener(onCaptured);
  setHostHidden(true);
  let res: { ok?: boolean; error?: string; name?: string } | undefined;
  try {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    res = await chrome.runtime.sendMessage({ type: TODO_MESSAGE, payload }).catch(() => undefined);
  } finally {
    chrome.runtime.onMessage.removeListener(onCaptured);
    setHostHidden(false);
  }
  if (!res?.ok) {
    // No receiver: keep the review rather than lose it.
    const filename = markupFilename();
    downloadText(filename, JSON.stringify(payload, null, 2));
    return setSendStatus({ label: "Receiver off: saved to Downloads", kind: "error", help: "Start the Agent Markup receiver, then send again." });
  }
  for (const c of pending) sentSignature.set(c.id, signature(c));
  const sync = { ...store.get().sync };
  for (const c of pending) sync[c.id] = { state: "sent" };
  store.set({ sync });
  if (!res.name) return setSendStatus({ label: `Filed ${plural(pending.length)} as a to-do`, kind: "done" });
  setSendStatus({ label: "Waiting for AIM Text Bridge…", kind: "busy" });
  await awaitTodoPickup(res.name, pending.length);
}

/** Follows a filed to-do until AIM Text Bridge picks it up (it then starts an Orca agent on it). */
async function awaitTodoPickup(name: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r: { ok?: boolean; state?: string; status?: number } | undefined = await chrome.runtime
      .sendMessage({ type: TODO_STATUS_MESSAGE, name, wait: 15 })
      .catch(() => undefined);
    // An older receiver has no status route: the to-do is filed, we just can't follow it.
    if (!r?.ok) return setSendStatus({ label: `Filed ${plural(count)} as a to-do`, kind: "done" });
    if (r.state === "picked-up") return setSendStatus({ label: "To-do filed, agent starting", kind: "done" });
  }
  setSendStatus({
    label: "Filed, not picked up yet",
    kind: "error",
    help: "AIM Text Bridge hasn’t taken the to-do after 30s. Is it running? It files the to-do when it next opens.",
  });
}

// ---- Destination -------------------------------------------------------------

const DESTINATION_KEY = "destination";

export function setDestination(destination: "auto" | "agent" | "todo") {
  store.set({ destination });
  void chrome.storage.local.set({ [DESTINATION_KEY]: destination }).catch(() => {});
}

/** Restores the chosen destination and keeps "is an agent waiting?" current while Agent Markup is on. */
export async function initDestination() {
  const saved = (await chrome.storage.local.get(DESTINATION_KEY).catch(() => ({} as Record<string, unknown>)))[DESTINATION_KEY];
  if (saved === "agent" || saved === "todo" || saved === "auto") store.set({ destination: saved });
  const check = async () => {
    if (!store.get().enabled) return;
    const res: { ok?: boolean; listening?: boolean } | undefined = await chrome.runtime
      .sendMessage({ type: HEALTH_MESSAGE })
      .catch(() => undefined);
    const listening = !!(res?.ok && res.listening);
    if (listening !== store.get().agentListening) store.set({ agentListening: listening });
  };
  void check();
  window.setInterval(() => void check(), 10_000);
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
