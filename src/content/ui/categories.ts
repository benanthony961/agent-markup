// The category picker shared by the note and highlight editors.
import type { Category } from "../../shared/settings";
import { h } from "./root";

export function categorySelect(): HTMLSelectElement {
  return h("select", { "aria-label": "Category" }) as HTMLSelectElement;
}

/** Replaces the options with the configured categories plus "No category". */
export function fillCategories(select: HTMLSelectElement, categories: Category[]) {
  select.replaceChildren(
    ...categories.map((c) => h("option", { value: c.id }, c.label)),
    h("option", { value: "" }, "No category"),
  );
}
