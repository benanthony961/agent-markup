// Handing a route over: to the local receiver (route.json + frames/*.jpg in a
// folder), or as one self-contained JSON in Downloads, plus a prompt for the
// agent that turns it into a HyperFrames walkthrough.
import { FRAMES_MESSAGE, ROUTE_SEND_MESSAGE } from "../../shared/messages";
import type { Route, RouteStep } from "../../shared/route";
import { truncate } from "../describe";
import { store } from "../store";
import { frameKey, referencedFrames, route } from "./state";

/** The route with only the frames it references, optionally with each image inlined as a data: URL. */
export async function buildRoute(withImages: boolean): Promise<Route | null> {
  const r = route();
  if (!r) return null;
  const used = referencedFrames(r);
  const frames: Route["frames"] = {};
  for (const id of used) if (r.frames[id]?.width) frames[id] = { ...r.frames[id] };
  if (withImages) {
    const keys = Object.keys(frames).map((id) => frameKey(r.id, id));
    const res: { ok?: boolean; data?: Record<string, string> } | undefined = await chrome.runtime.sendMessage({ type: FRAMES_MESSAGE, keys }).catch(() => undefined);
    for (const id of Object.keys(frames)) {
      const url = res?.data?.[frameKey(r.id, id)];
      if (url) frames[id].dataUrl = url;
      else delete frames[id];
    }
  }
  // Drop references to frames that never finished (or were pruned), so consumers can trust every id.
  const steps = r.steps.map((s) => {
    const f: RouteStep["frames"] = {};
    for (const [k, v] of Object.entries(s.frames) as [keyof RouteStep["frames"], string | undefined][]) if (v && frames[v]) f[k] = v;
    return { ...s, frames: f };
  });
  return { ...r, steps, frames, startFrame: r.startFrame && frames[r.startFrame] ? r.startFrame : undefined };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "route";

function download(data: Route): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const name = `agent-markup-route-${slug(data.title || location.host)}-${stamp}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.documentElement.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return name;
}

/** Last export destination, so the prompt can point at it. */
let lastExport: { dir?: string; file?: string } | null = null;

export async function exportRoute(): Promise<{ via: "receiver" | "download"; dir?: string; file?: string; steps: number; frames: number }> {
  const data = await buildRoute(true);
  if (!data || !data.steps.length) throw new Error("Nothing recorded yet");
  const frames = Object.keys(data.frames).length;
  const res: { ok?: boolean; dir?: string } | undefined = await chrome.runtime.sendMessage({ type: ROUTE_SEND_MESSAGE, payload: data }).catch(() => undefined);
  const toast = (text: string) => store.set({ toast: { text, at: Date.now() } });
  if (res?.ok && res.dir) {
    lastExport = { dir: res.dir };
    toast(`Route saved: ${res.dir.split("/").slice(-1)[0]}`);
    return { via: "receiver", dir: res.dir, steps: data.steps.length, frames };
  }
  const file = download(data);
  lastExport = { file };
  toast("Route saved to Downloads");
  return { via: "download", file, steps: data.steps.length, frames };
}

const KIND_VERB: Record<RouteStep["kind"], string> = {
  click: "CLICK", fill: "TYPE", select: "CHOOSE", check: "TOGGLE", press: "PRESS", scroll: "SCROLL", navigate: "GO TO", chapter: "CHAPTER",
};

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

export function routePrompt(r: Route): string {
  const pages = [...new Set(r.steps.map((s) => pathOf(s.page.url)))];
  const lines = [
    `I recorded a click-through of ${r.site} to turn into an animated HyperFrames walkthrough.`,
    `Route: "${r.title || "Untitled route"}" — ${r.steps.filter((s) => s.kind !== "chapter").length} steps across ${pages.length} page${pages.length === 1 ? "" : "s"} (${pages.slice(0, 6).join(", ")}${pages.length > 6 ? ", …" : ""}).`,
    `Viewport: ${r.viewport.width}x${r.viewport.height} @${r.viewport.dpr}x`,
    lastExport?.dir ? `Route file: ${lastExport.dir}/route.json (frames in ${lastExport.dir}/frames/)` : lastExport?.file ? `Route file: ~/Downloads/${lastExport.file} (frames inlined)` : `Route file: not exported yet — click "Export route" in Agent Markup first.`,
    "",
  ];
  let n = 0;
  for (const s of r.steps) {
    if (s.kind === "chapter") {
      lines.push(`## ${s.title || s.caption}`);
      continue;
    }
    n++;
    const t = s.target;
    const what = t ? ` ${t.role !== "generic" ? t.role : `<${t.tag}>`} "${truncate(t.name || t.label, 60)}" — \`${t.selector}\`` : "";
    const value = s.kind === "fill" || s.kind === "select" ? ` = "${s.sensitive ? "(hidden)" : truncate(s.value ?? "", 80)}"` : s.kind === "press" ? ` ${s.key}` : s.kind === "check" ? ` → ${s.checked ? "on" : "off"}` : s.kind === "navigate" ? ` ${pathOf(s.value ?? "")}` : "";
    lines.push(`${n}. ${KIND_VERB[s.kind]}${what}${value}  (on ${pathOf(s.page.url)})`);
    lines.push(`   Caption: ${s.caption}`);
    if (s.note) lines.push(`   Voiceover guide: ${s.note}`);
    if (s.variable) lines.push(`   Variable: ${s.variable}`);
    if (s.navigatesTo) lines.push(`   Leads to: ${pathOf(s.navigatesTo)}`);
    for (const w of s.warnings ?? []) lines.push(`   ⚠ ${w}`);
  }
  lines.push(
    "",
    "Build it (scripts live in the Agent Markup repo):",
    "  node scripts/route-to-hyperframes.mjs <route.json> --out <project-dir>",
    "  cd <project-dir> && npx hyperframes check && npx hyperframes preview",
    "To re-film the same route against a seeded environment (fresh frames, optional new values):",
    "  node scripts/replay-route.mjs <route.json> --base-url <url> [--set st_4=value] --out <dir>",
    "",
    "Keep every caption naming controls the way the product does. Every frame change needs a cause on screen:",
    "if a step has a warning or a missing frame, re-film it with the replay script rather than painting the state in.",
    "Review STORYBOARD.md and REVIEW.md in the generated project before rendering.",
  );
  return lines.join("\n");
}
