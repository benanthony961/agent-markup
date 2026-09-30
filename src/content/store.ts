// One small store for changes, history state and UI state. The UI subscribes
// and re-renders; only the command layer writes `changes`/history fields.
import type { Route } from "../shared/route";
import type { Change } from "./changes";

export interface State {
  enabled: boolean;
  changes: Change[];
  /** The page currently shown (origin + path + search); follows client-side navigation. */
  pageKey: string;
  canUndo: boolean;
  canRedo: boolean;
  selectedId: string | null;
  /** Element being edited in place, if any. */
  editingId: string | null;
  /** Element whose note editor is open, if any. */
  noteEditingId: string | null;
  /** Bumped to trigger a flash animation on an element. */
  flash: { elementId: string; at: number } | null;
  /** x = left offset; y = distance from the `anchor` edge (the panel grows away from it). */
  panel: { collapsed: boolean; x: number | null; y: number | null; anchor: "top" | "bottom" };
  toast: { text: string; at: number } | null;
  /** Delivery state of changes sent to the agent, by change id. Applied changes are dismissed, so they never appear here. */
  sync: Record<string, { state: "sent" | "needs-call"; note?: string }>;
  /** Send automatically after a pause in editing. */
  autoSend: boolean;
  /** "markup" edits the page; "route" records a click-through for a walkthrough video. */
  mode: "markup" | "route";
  /** The route being recorded on this site, if any. */
  route: Route | null;
  recording: boolean;
  /** Screenshots in flight, and the last capture problem (shown in the panel). */
  capture: { pending: number; error: string | null };
}

type Listener = (state: State, prev: State) => void;

class Store {
  private state: State = {
    enabled: false,
    changes: [],
    pageKey: "",
    canUndo: false,
    canRedo: false,
    selectedId: null,
    editingId: null,
    noteEditingId: null,
    flash: null,
    panel: { collapsed: false, x: null, y: null, anchor: "bottom" },
    toast: null,
    sync: {},
    autoSend: false,
    mode: "markup",
    route: null,
    recording: false,
    capture: { pending: 0, error: null },
  };
  private listeners = new Set<Listener>();
  private scheduled = false;
  private prev = this.state;

  get(): State {
    return this.state;
  }

  set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    // Batch notifications to one per microtask.
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const prev = this.prev;
      this.prev = this.state;
      for (const l of this.listeners) l(this.state, prev);
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const store = new Store();
