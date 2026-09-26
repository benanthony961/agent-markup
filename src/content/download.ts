// Saves a file to the user's Downloads folder without the "downloads"
// permission: a blob link clicked from inside our shadow root, where the page's
// click handlers (and our own click interceptor) never see it.
import { ensureRoot } from "./ui/root";

export function downloadText(filename: string, text: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  ensureRoot().appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
