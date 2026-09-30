// Read-only bridge for agents that drive the browser (e.g. an agent reading
// the page through a DevTools/automation connection). On origins the user
// allowed in the settings, a page-context script can ask for the markup:
//
//   window.postMessage({ type: "agent-markup:request", id: "1", name: "get_markup" }, location.origin)
//   -> window message { type: "agent-markup:response", id: "1", result: { ok, data | error } }
//
// Only reads are answered. Nothing a page script sends can change the
// session, the page, or the settings. Any script on an allowed origin can read
// the session, so allow only sites you control.
import { originAllowed } from "../shared/settings";
import { executeCommand } from "./commands";
import { store } from "./store";

const READ_ONLY = new Set(["get_markup", "list_changes", "get_prompt"]);
export const REQUEST = "agent-markup:request";
export const RESPONSE = "agent-markup:response";

export function startBridge() {
  addEventListener("message", async (e: MessageEvent) => {
    if (e.source !== window || e.data?.type !== REQUEST) return;
    const { id, name } = e.data as { id?: unknown; name?: unknown };
    const reply = (result: unknown) => window.postMessage({ type: RESPONSE, id, result }, location.origin);
    if (!originAllowed(location.origin, store.get().settings.bridgeOrigins)) {
      reply({ ok: false, error: `Agent Markup's bridge is not enabled for ${location.origin}. Add it on the extension's options page.` });
      return;
    }
    if (typeof name !== "string" || !READ_ONLY.has(name)) {
      reply({ ok: false, error: `Only ${[...READ_ONLY].join(", ")} are available to page scripts` });
      return;
    }
    reply(await executeCommand(name, {}));
  });
}
