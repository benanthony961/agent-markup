// The route being recorded: the one place that changes it, and its persistence.
// A route is per site (origin), like the markup session, so it survives full
// page loads while you click through a multi-page flow.
import { FRAMES_DELETE_MESSAGE } from "../../shared/messages";
import { ROUTE_FORMAT, type Route, type RouteStep } from "../../shared/route";
import { store } from "../store";

const routeKey = () => `route:${location.origin}`;
/** Storage key of one frame's image (written by the background worker). */
export const frameKey = (routeId: string, frameId: string) => `rf:${routeId}:${frameId}`;

export const route = () => store.get().route;

export function newRoute(title = ""): Route {
  const now = new Date().toISOString();
  return {
    format: ROUTE_FORMAT,
    id: `r${Date.now().toString(36)}`,
    title,
    site: location.origin,
    createdAt: now,
    updatedAt: now,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    steps: [],
    frames: {},
  };
}

/** Applies `fn` to a copy of the route (steps and frames copied too) so subscribers see a new object. */
export function mutate(fn: (r: Route) => void) {
  const r = route();
  if (!r) return;
  const next: Route = { ...r, steps: r.steps.map((s) => ({ ...s, frames: { ...s.frames } })), frames: { ...r.frames } };
  fn(next);
  next.updatedAt = new Date().toISOString();
  store.set({ route: next });
  schedulePersist();
}

export const stepById = (id: string) => route()?.steps.find((s) => s.id === id);

export function updateStep(id: string, patch: Partial<RouteStep>) {
  mutate((r) => {
    const i = r.steps.findIndex((s) => s.id === id);
    if (i !== -1) r.steps[i] = { ...r.steps[i], ...patch, frames: { ...r.steps[i].frames, ...(patch.frames ?? {}) } };
  });
}

/** Next free id: "st_<n>" for steps, "f<n>" for frames. Never reuses a number still in the route. */
export function nextId(kind: "st" | "f"): string {
  const r = route();
  const ids = kind === "st" ? (r?.steps.map((s) => s.id) ?? []) : Object.keys(r?.frames ?? {});
  const nums = ids.map((id) => Number(id.replace(/^\D+/, ""))).filter(Number.isFinite);
  const n = Math.max(0, ...nums) + 1;
  return kind === "st" ? `st_${n}` : `f${n}`;
}

/** ms since the route started. */
export const elapsed = () => {
  const r = route();
  return r ? Math.max(0, Date.now() - Date.parse(r.createdAt)) : 0;
};

// ---- Persistence -----------------------------------------------------------

let persistTimer = 0;
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => void persist(), 250);
}

export async function persist() {
  clearTimeout(persistTimer);
  const { route, mode, recording } = store.get();
  try {
    await chrome.storage.local.set({ [routeKey()]: { route, mode, recording } });
  } catch (err) {
    console.warn("Agent Markup: could not save the route", err);
  }
}

export async function restoreRoute() {
  const saved = (await chrome.storage.local.get(routeKey()).catch(() => ({})) as Record<string, unknown>)[routeKey()] as
    | { route?: Route | null; mode?: "markup" | "route"; recording?: boolean }
    | undefined;
  if (!saved) return;
  store.set({ route: saved.route ?? null, mode: saved.mode ?? "markup", recording: !!saved.recording && !!saved.route });
}

export function setMode(mode: "markup" | "route") {
  store.set({ mode, selectedId: null, editingId: null, noteEditingId: null, ...(mode === "markup" ? { recording: false } : {}) });
  void persist();
}

export function setRecording(recording: boolean) {
  store.set({ recording });
  void persist();
}

/** Frame ids the route still references (the rest are dead weight in storage). */
export function referencedFrames(r: Route): Set<string> {
  const ids = new Set<string>();
  if (r.startFrame) ids.add(r.startFrame);
  for (const s of r.steps) for (const f of Object.values(s.frames)) if (f) ids.add(f);
  return ids;
}

export async function clearRoute() {
  const r = route();
  store.set({ route: null, recording: false, capture: { pending: 0, error: null } });
  await persist();
  if (r) {
    const keys = Object.keys(r.frames).map((f) => frameKey(r.id, f));
    await chrome.runtime.sendMessage({ type: FRAMES_DELETE_MESSAGE, keys }).catch(() => {});
  }
}
