// First-draft captions for recorded steps. They name controls the way the page
// does ("Click “Create order”") and are meant to be rewritten in the panel.
import type { RouteStep } from "../../shared/route";
import { truncate } from "../describe";

const q = (s: string) => `“${truncate(s, 60)}”`;

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export function captionFor(step: RouteStep): string {
  const t = step.target;
  const name = t?.name || t?.label || "";
  const field = t?.label || t?.name || "the field";
  switch (step.kind) {
    case "click":
      if (!name) return `Click the ${t?.role && t.role !== "generic" ? t.role : t?.tag ?? "element"}`;
      if (t?.role === "tab") return `Open the ${q(name)} tab`;
      if (t?.role === "link") return `Open ${q(name)}`;
      if (/^(option|menuitem|menuitemradio|treeitem)$/.test(t?.role ?? "")) return `Choose ${q(name)}`;
      if (t?.role === "textbox" || t?.role === "combobox" || t?.role === "searchbox") return `Click in ${q(field)}`;
      return `Click ${q(name)}`;
    case "fill":
      if (step.sensitive) return `Enter your ${field.toLowerCase()}`;
      if (!step.value) return `Clear ${q(field)}`;
      return `Type ${q(step.value)} in ${q(field)}`;
    case "select":
      return `Choose ${q(step.value ?? "")} for ${q(field)}`;
    case "check":
      if (step.checked === undefined) return `Toggle ${q(name || "the option")}`;
      if (t?.role === "radio" || t?.role === "menuitemradio") return `Select ${q(name || "the option")}`;
      return `${step.checked ? "Turn on" : "Turn off"} ${q(name || "the option")}`;
    case "press":
      return name ? `Press ${step.key} in ${q(name)}` : `Press ${step.key}`;
    case "scroll":
      return (step.scroll?.toY ?? 0) >= (step.scroll?.fromY ?? 0) ? "Scroll down" : "Scroll up";
    case "navigate":
      return `Go to ${pathOf(step.value ?? step.page.url)}`;
    case "chapter":
      return step.title ?? "";
  }
}
