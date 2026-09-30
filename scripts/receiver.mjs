#!/usr/bin/env node
// Local inbox for Agent Markup. The extension POSTs a review here when you click
// "Send to agent"; each one lands as a JSON file that an agent can watch for.
//
//   node scripts/receiver.mjs            # listens on 127.0.0.1:47800
//   inbox: ~/.agent-markup/inbox/agent-markup-<host>-<time>.json
//
// Loopback only, extension-only (checks the Origin header), size-capped, and it
// only writes files. It never runs anything from the payload.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.AGENT_MARKUP_PORT ?? 47800);
const INBOX = process.env.AGENT_MARKUP_INBOX ?? join(homedir(), ".agent-markup", "inbox");
const MAX_BYTES = 5 * 1024 * 1024;
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
  if (req.method === "GET" && req.url === "/health") return reply(200, { ok: true, inbox: INBOX });
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
    const item = { resolve: (name) => (clearTimeout(item.timer), newReviewWaiters.delete(item), reply(200, { ok: true, name })) };
    return park(newReviewWaiters, item, 60_000, () => reply(200, { ok: true, name: null }));
  }
  if (req.method !== "POST" || req.url !== "/markup") return reply(404, { ok: false });
  if (!String(req.headers.origin ?? "").startsWith("chrome-extension://")) return reply(403, { ok: false, error: "extension only" });

  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BYTES) req.destroy();
    else chunks.push(c);
  });
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

server.listen(PORT, "127.0.0.1", () => console.log(`Agent Markup receiver on http://127.0.0.1:${PORT}, inbox ${INBOX}`));
