// Options page: edit categories and the bridge's allowed origins.
import { DEFAULT_SETTINGS, loadSettings, normalizeSettings, SETTINGS_KEY, type Settings } from "./shared/settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const categories = $<HTMLTextAreaElement>("categories");
const origins = $<HTMLTextAreaElement>("origins");
const status = $<HTMLSpanElement>("status");

function show(s: Settings) {
  categories.value = s.categories.map((c) => `${c.id}: ${c.label}`).join("\n");
  origins.value = s.bridgeOrigins.join("\n");
}

function read(): Settings {
  const cats = categories.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(":");
      const id = (i === -1 ? line : line.slice(0, i)).trim().toLowerCase().replace(/\s+/g, "-");
      const label = (i === -1 ? line : line.slice(i + 1)).trim() || id;
      return { id, label };
    });
  const list = origins.value.split("\n").map((o) => o.trim()).filter(Boolean);
  return normalizeSettings({ categories: cats, bridgeOrigins: list });
}

async function save(s: Settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
  show(s);
  status.textContent = "Saved. Open pages pick this up right away.";
  setTimeout(() => (status.textContent = ""), 3000);
}

$("save").addEventListener("click", () => void save(read()));
$("reset").addEventListener("click", () => void save(DEFAULT_SETTINGS));
void loadSettings().then(show);
