#!/usr/bin/env node
// Local inbox for Agent Markup. The extension POSTs a review here when you click
// "Send to agent"; each one lands as a JSON file that an agent can watch for.
//
//   node scripts/receiver.mjs            # listens on 127.0.0.1:47800
//   inbox: ~/.agent-markup/inbox/agent-markup-<host>-<time>.json
//   routes (Route mode "Export route"): ~/.agent-markup/routes/<title>-<time>/route.json + frames/*.jpg
//   to-dos ("Send as to-do"): ~/.agent-markup/todos/<host>-<time>/markup.json + screenshot.jpg,
//   picked up by AIM Text Bridge, which files the to-do and starts an Orca agent on it
//
// Loopback only, extension-only (checks the Origin header), size-capped, and it
// only writes files. It never runs anything from the payload.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const PORT = Number(process.env.AGENT_MARKUP_PORT ?? 47800);
const INBOX = process.env.AGENT_MARKUP_INBOX ?? join(homedir(), ".agent-markup", "inbox");
const ROUTES = process.env.AGENT_MARKUP_ROUTES ?? join(homedir(), ".agent-markup", "routes");
const TODOS = process.env.AGENT_MARKUP_TODOS ?? join(homedir(), ".agent-markup", "todos");
const MAX_TODO_BYTES = 30 * 1024 * 1024;
// An agent re-parks on /wait every 60s; one that asked within this window counts as listening.
const LISTENING_GRACE_MS = 90_000;
let lastWaitAt = 0;
const MAX_BYTES = 5 * 1024 * 1024;
// Routes carry their screenshots inline, so they get a bigger cap.
const MAX_ROUTE_BYTES = 200 * 1024 * 1024;
mkdirSync(INBOX, { recursive: true });

// Long-poll waiters: requests parked until something happens, so nothing has to
// poll on a timer. A parked request costs a socket and no CPU.
const newReviewWaiters = new Set(); // resolve(fileName) when a review is POSTed
const answerWaiters = new Set(); // { path, resolve } woken by inbox file changes
watch(INBOX, () => {
  for (const w of [...answerWaiters]) if (existsSync(w.path)) w.resolve();
});
const park = (set, item, ms, onTimeout) => {
  set.add(item);
  item.timer = setTimeout(() => (set.delete(item), onTimeout()), ms);
};

const server = createServer((req, res) => {
  const reply = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health") {
    const listening = newReviewWaiters.size > 0 || Date.now() - lastWaitAt < LISTENING_GRACE_MS;
    return reply(200, { ok: true, inbox: INBOX, listening });
  }
  // The agent's answer for a review: <name>.applied.json next to it, written once the agent has acted.
  // /result/<name>?wait=N parks up to N seconds (max 25) until the answer file exists.
  const result = req.method === "GET" && req.url?.match(/^\/result\/([a-z0-9._-]+\.json)(?:\?wait=(\d+))?$/i);
  if (result) {
    const answer = join(INBOX, result[1].replace(/\.json$/, ".applied.json"));
    const send = () => (existsSync(answer) ? reply(200, JSON.parse(readFileSync(answer, "utf8"))) : reply(404, { ok: false }));
    const wait = Math.min(Number(result[2] ?? 0), 25);
    if (existsSync(answer) || !wait) return send();
    const item = { path: answer, resolve: () => (clearTimeout(item.timer), answerWaiters.delete(item), send()) };
    return park(answerWaiters, item, wait * 1000, send);
  }
  // /wait parks up to 60s until a new review arrives (for an agent watching the inbox).
  if (req.method === "GET" && req.url === "/wait") {
    lastWaitAt = Date.now();
    const item = { resolve: (name) => (clearTimeout(item.timer), newReviewWaiters.delete(item), reply(200, { ok: true, name })) };
    return park(newReviewWaiters, item, 60_000, () => reply(200, { ok: true, name: null }));
  }
  // /todo/<name>?wait=N: has AIM Text Bridge picked up a filed to-do? It moves the folder
  // out of TODOS when it files it, so "picked-up" means the folder is gone. Parks up to N
  // seconds (max 25) waiting for that.
  const todoStatus = req.method === "GET" && req.url?.match(/^\/todo\/([a-z0-9._-]+)(?:\?wait=(\d+))?$/i);
  if (todoStatus) {
    const folder = join(TODOS, todoStatus[1]);
    const deadline = Date.now() + Math.min(Number(todoStatus[2] ?? 0), 25) * 1000;
    const check = () => {
      if (!existsSync(folder)) return reply(200, { ok: true, state: "picked-up" });
      if (Date.now() >= deadline || res.destroyed) return reply(200, { ok: true, state: "waiting" });
      setTimeout(check, 400);
    };
    return check();
  }
  const isRoute = req.method === "POST" && req.url === "/route";
  const isTodo = req.method === "POST" && req.url === "/todo";
  if (!isRoute && !isTodo && (req.method !== "POST" || req.url !== "/markup")) return reply(404, { ok: false });
  if (!String(req.headers.origin ?? "").startsWith("chrome-extension://")) return reply(403, { ok: false, error: "extension only" });

  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > (isRoute ? MAX_ROUTE_BYTES : isTodo ? MAX_TODO_BYTES : MAX_BYTES)) req.destroy();
    else chunks.push(c);
  });
  if (isRoute) return req.on("end", () => saveRoute(Buffer.concat(chunks), reply));
  if (isTodo) return req.on("end", () => saveTodo(Buffer.concat(chunks), reply));
  req.on("end", () => {
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (data?.format !== "agent-markup/v1" || !Array.isArray(data.changes)) return reply(400, { ok: false, error: "not agent-markup/v1" });
      const host = String(data.site ?? "site").replace(/^https?:\/\//, "").replace(/[^a-z0-9.-]/gi, "_");
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
      const file = join(INBOX, `agent-markup-${host}-${stamp}.json`);
      writeFileSync(file, JSON.stringify(data, null, 2));
      for (const w of [...newReviewWaiters]) w.resolve(file.split("/").pop());
      console.log(`received ${data.changes.length} change(s) -> ${file}`);
      reply(200, { ok: true, file, name: file.split("/").pop(), count: data.changes.length });
    } catch {
      reply(400, { ok: false, error: "invalid JSON" });
    }
  });
});

/** Writes a to-do as <dir>/markup.json (+ screenshot.jpg). A "ready" file marks it complete for the app. */
function saveTodo(body, reply) {
  let data;
  try {
    data = JSON.parse(body.toString("utf8"));
  } catch {
    return reply(400, { ok: false, error: "invalid JSON" });
  }
  const markup = data?.markup;
  if (markup?.format !== "agent-markup/v1" || !Array.isArray(markup.changes)) return reply(400, { ok: false, error: "not agent-markup/v1" });
  const host = String(markup.site ?? "site").replace(/^https?:\/\//, "").replace(/[^a-z0-9.-]/gi, "_");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const dir = join(TODOS, `${host}-${stamp}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  const shot = /^data:image\/(jpeg|png);base64,(.+)$/.exec(String(data.screenshot ?? ""));
  if (shot) writeFileSync(join(dir, shot[1] === "png" ? "screenshot.png" : "screenshot.jpg"), Buffer.from(shot[2], "base64"));
  writeFileSync(join(dir, "markup.json"), JSON.stringify({ ...markup, tabUrl: typeof data.url === "string" ? data.url : undefined }, null, 2));
  // Written last, so the app never reads a half-written to-do.
  writeFileSync(join(dir, "ready"), "");
  console.log(`received to-do (${markup.changes.length} change(s)) -> ${dir}`);
  reply(200, { ok: true, dir, name: basename(dir), count: markup.changes.length });
}

/** Writes a route as <dir>/route.json with each inlined frame decoded to <dir>/frames/<id>.jpg. */
function saveRoute(body, reply) {
  let data;
  try {
    data = JSON.parse(body.toString("utf8"));
  } catch {
    return reply(400, { ok: false, error: "invalid JSON" });
  }
  if (data?.format !== "agent-markup/route-v1" || !Array.isArray(data.steps) || typeof data.frames !== "object") return reply(400, { ok: false, error: "not agent-markup/route-v1" });
  const slug = String(data.title || String(data.site ?? "route").replace(/^https?:\/\//, "")).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "route";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const dir = join(ROUTES, `${slug}-${stamp}`);
  mkdirSync(join(dir, "frames"), { recursive: true });
  for (const [id, frame] of Object.entries(data.frames)) {
    // Frame ids become file names: allow only what the extension generates.
    if (!/^f\d+$/.test(id)) return reply(400, { ok: false, error: `bad frame id ${id}` });
    const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(frame?.dataUrl ?? "");
    if (!m) continue;
    const file = `frames/${id}.${m[1] === "png" ? "png" : "jpg"}`;
    writeFileSync(join(dir, file), Buffer.from(m[2], "base64"));
    delete frame.dataUrl;
    frame.file = file;
  }
  writeFileSync(join(dir, "route.json"), JSON.stringify(data, null, 2));
  console.log(`received route "${data.title || slug}" (${data.steps.length} steps, ${Object.keys(data.frames).length} frames) -> ${dir}`);
  reply(200, { ok: true, dir, steps: data.steps.length });
}

server.listen(PORT, "127.0.0.1", () => console.log(`Agent Markup receiver on http://127.0.0.1:${PORT}, inbox ${INBOX}`));
