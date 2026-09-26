// The structured export: every change as plain data, for agents and scripts.
// The prose prompt (prompt.ts) is for pasting; this is for parsing.
import { serialize, type Change } from "./changes";
import { buildPrompt } from "./prompt";
import { store } from "./store";

export const MARKUP_FORMAT = "agent-markup/v1";

export interface Markup {
  format: typeof MARKUP_FORMAT;
  exportedAt: string;
  site: string;
  viewport: { width: number; height: number };
  pages: { url: string; title: string }[];
  changes: Record<string, unknown>[];
  prompt: string;
}

function categoryLabel(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return store.get().settings.categories.find((c) => c.id === id)?.label ?? id;
}

export function buildMarkup(changes: Change[]): Markup {
  const pages = [...new Map(changes.map((c) => [c.page.key, { url: c.page.url, title: c.page.title }])).values()];
  return {
    format: MARKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    site: location.origin,
    viewport: { width: innerWidth, height: innerHeight },
    pages,
    changes: changes.map((c, i) => {
      const { page, ...rest } = serialize(c) as Record<string, unknown> & { page: { url: string; title: string } };
      const category = "category" in c ? c.category : undefined;
      return {
        number: i + 1,
        ...rest,
        page: { url: page.url, title: page.title },
        ...(category ? { category, categoryLabel: categoryLabel(category) } : {}),
      };
    }),
    prompt: buildPrompt(changes),
  };
}

/** A filename such as agent-markup-localhost-3333-20260926-184512.json. */
export function markupFilename(date = new Date()): string {
  const host = location.host.replace(/[^a-z0-9.-]+/gi, "-").replace(/\./g, "-");
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `agent-markup-${host}-${stamp}.json`;
}
