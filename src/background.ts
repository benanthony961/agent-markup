// Background service worker: toggles Agent Markup per tab, injects the content
// script on demand (activeTab), re-injects after a reload, and forwards command
// messages from other extension contexts to the tab's content script.
import { getToolDefinitions } from "./commands/definitions";
import {
  COMMAND_MESSAGE,
  PING_MESSAGE,
  RESULT_MESSAGE,
  SEND_MESSAGE,
  STATE_MESSAGE,
  TOGGLE_MESSAGE,
  TOOLS_MESSAGE,
  isCommandMessage,
  type CommandResult,
} from "./shared/messages";

const RECEIVER_URL = "http://127.0.0.1:47800/markup";
const RESULT_URL = "http://127.0.0.1:47800/result/";
const ENABLED_KEY = "enabledTabs";
const OPTED_OUT_KEY = "optedOutTabs";
// Dev servers where Agent Markup turns itself on when the page loads. Deliberately
// specific: auto-enabling on every localhost port would swallow clicks in unrelated apps.
// Override from the service worker console: chrome.storage.local.set({ autoHosts: ["localhost:3000"] })
const DEFAULT_AUTO_HOSTS = ["localhost:5173", "localhost:5199", "127.0.0.1:5173", "127.0.0.1:5199"];

async function isAutoHost(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:") return false;
    host = u.host;
  } catch {
    return false;
  }
  const { autoHosts } = await chrome.storage.local.get("autoHosts");
  return ((autoHosts as string[] | undefined) ?? DEFAULT_AUTO_HOSTS).includes(host);
}

async function setOptedOut(tabId: number, optedOut: boolean) {
  const data = await chrome.storage.session.get(OPTED_OUT_KEY);
  const tabs = new Set((data[OPTED_OUT_KEY] as number[] | undefined) ?? []);
  if (optedOut) tabs.add(tabId);
  else tabs.delete(tabId);
  await chrome.storage.session.set({ [OPTED_OUT_KEY]: [...tabs] });
}

async function isOptedOut(tabId: number): Promise<boolean> {
  const data = await chrome.storage.session.get(OPTED_OUT_KEY);
  return ((data[OPTED_OUT_KEY] as number[] | undefined) ?? []).includes(tabId);
}

async function getEnabledTabs(): Promise<number[]> {
  const data = await chrome.storage.session.get(ENABLED_KEY);
  return (data[ENABLED_KEY] as number[] | undefined) ?? [];
}

async function setTabEnabled(tabId: number, enabled: boolean) {
  const tabs = new Set(await getEnabledTabs());
  if (enabled) tabs.add(tabId);
  else tabs.delete(tabId);
  await chrome.storage.session.set({ [ENABLED_KEY]: [...tabs] });
  await chrome.action.setBadgeText({ tabId, text: enabled ? "ON" : "" }).catch(() => {});
}

async function ensureInjected(tabId: number): Promise<void> {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: PING_MESSAGE });
    if (res?.ok) return;
  } catch {
    // Not injected yet.
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

async function sendCommand(tabId: number, name: string, params: unknown = {}): Promise<CommandResult> {
  await ensureInjected(tabId);
  return chrome.tabs.sendMessage(tabId, { type: COMMAND_MESSAGE, name, params });
}

async function toggle(tabId: number) {
  try {
    await ensureInjected(tabId);
    const res: { enabled: boolean } = await chrome.tabs.sendMessage(tabId, { type: TOGGLE_MESSAGE });
    const [{ result: origin }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => location.origin });
    if (res.enabled && origin) enabledOrigin.set(tabId, origin);
    await setOptedOut(tabId, !res.enabled);
    await setTabEnabled(tabId, res.enabled);
  } catch (err) {
    // chrome://, the Web Store and similar pages can't be scripted.
    console.warn("Agent Markup: cannot run on this page", err);
    await chrome.action.setBadgeText({ tabId, text: "×" }).catch(() => {});
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {}), 1500);
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void toggle(tab.id);
});

// After a reload, bring Agent Markup back on tabs where it was on, as long as
// the tab is still on the same origin. activeTab access survives same-origin
// reloads; if it doesn't, the user toggles again and saved changes re-apply then.
const enabledOrigin = new Map<number, string>();

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete") return;
  if (!(await getEnabledTabs()).includes(tabId)) {
    // Auto-on for the dev servers, unless the user turned it off on this tab.
    if ((await isAutoHost(tab.url)) && !(await isOptedOut(tabId))) {
      try {
        await sendCommand(tabId, "set_enabled", { enabled: true });
        enabledOrigin.set(tabId, new URL(tab.url!).origin);
        await setTabEnabled(tabId, true);
      } catch (err) {
        console.warn("Agent Markup: could not auto-enable", err);
      }
    }
    return;
  }
  try {
    const [{ result: origin }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => location.origin });
    const prev = enabledOrigin.get(tabId);
    if (prev && prev !== origin) throw new Error("Navigated to another site");
    await sendCommand(tabId, "set_enabled", { enabled: true });
    await chrome.action.setBadgeText({ tabId, text: "ON" });
  } catch {
    enabledOrigin.delete(tabId);
    await setTabEnabled(tabId, false);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => void setTabEnabled(tabId, false));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === STATE_MESSAGE && sender.tab?.id !== undefined) {
    // Turning it off from the panel's close button counts as opting out for this tab.
    void setOptedOut(sender.tab.id, !msg.enabled);
    void setTabEnabled(sender.tab.id, !!msg.enabled);
    return false;
  }
  if (msg?.type === SEND_MESSAGE) {
    // Delivers to the local receiver (scripts/receiver.mjs). ok:false means it isn't running.
    fetch(RECEIVER_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg.payload) })
      .then(async (r) => sendResponse(r.ok ? { ok: true, ...(await r.json()) } : { ok: false, error: `receiver replied ${r.status}` }))
      .catch(() => sendResponse({ ok: false, error: "receiver not running" }));
    return true;
  }
  if (msg?.type === RESULT_MESSAGE) {
    fetch(RESULT_URL + encodeURIComponent(String(msg.name)) + "?wait=25")
      .then(async (r) => sendResponse(r.ok ? { ok: true, data: await r.json() } : { ok: false, status: r.status }))
      .catch(() => sendResponse({ ok: false, status: 0 }));
    return true;
  }
  if (msg?.type === TOOLS_MESSAGE) {
    sendResponse(msg.format === "openai" ? getToolDefinitions("openai") : getToolDefinitions());
    return false;
  }
  // Commands from extension pages (side panel, bridge, ...) are routed to a tab.
  // Content scripts receive commands directly via chrome.tabs.sendMessage.
  if (isCommandMessage(msg) && !sender.tab) {
    (async () => {
      const tabId = msg.tabId ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      if (tabId === undefined) return { ok: false, error: "No target tab" };
      return sendCommand(tabId, msg.name, msg.params);
    })()
      .catch((err) => ({ ok: false, error: String(err?.message ?? err) }))
      .then(sendResponse);
    return true;
  }
  return false;
});

// Handy from the service worker DevTools console.
Object.assign(globalThis, { agentMarkup: { toggle, sendCommand, getToolDefinitions } });
