// User settings, edited on the options page and read by the content script.
// Kept free of DOM code so the options page and the content script share it.

export interface Category {
  /** Stable identifier written into exports, e.g. "wording". */
  id: string;
  /** Shown in the UI, e.g. "Wording". */
  label: string;
}

export interface Settings {
  /**
   * Origins where page scripts may read the markup session through the
   * read-only bridge, e.g. "http://localhost:*" or "https://docs.example.com".
   * `*` matches any port, or any run of subdomain characters.
   */
  bridgeOrigins: string[];
  /** Categories offered for notes and highlights. The first is the default. */
  categories: Category[];
}

export const SETTINGS_KEY = "settings";

export const DEFAULT_SETTINGS: Settings = {
  bridgeOrigins: ["http://localhost:*", "http://127.0.0.1:*"],
  categories: [
    { id: "wording", label: "Wording" },
    { id: "unclear", label: "Unclear" },
    { id: "wrong", label: "Wrong or unverified" },
    { id: "cut", label: "Cut" },
    { id: "move", label: "Move elsewhere" },
    { id: "bug", label: "Product bug" },
  ],
};

/** Fills gaps in stored settings so older or partial saves still work. */
export function normalizeSettings(raw: unknown): Settings {
  const s = (raw ?? {}) as Partial<Settings>;
  const origins = Array.isArray(s.bridgeOrigins) ? s.bridgeOrigins.filter((o) => typeof o === "string" && o.trim()) : null;
  const categories = Array.isArray(s.categories)
    ? s.categories.filter((c): c is Category => !!c && typeof c.id === "string" && !!c.id.trim() && typeof c.label === "string")
    : null;
  return {
    bridgeOrigins: origins ?? DEFAULT_SETTINGS.bridgeOrigins,
    categories: categories?.length ? categories : DEFAULT_SETTINGS.categories,
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(data[SETTINGS_KEY]);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** True if `origin` (e.g. "http://localhost:3333") matches one of the patterns. */
export function originAllowed(origin: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const re = new RegExp(
      "^" +
        p
          .trim()
          .replace(/\/+$/, "")
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/:\*$/, "(:\\d+)?")
          .replace(/\*/g, "[a-z0-9-]*") +
        "$",
      "i",
    );
    return re.test(origin);
  });
}
