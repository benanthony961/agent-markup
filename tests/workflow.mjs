// End-to-end checks for the agent workflow features: categories, phrase
// highlights, the structured export, "Send to agent" and the read-only bridge.
// Run: bun run test:workflow
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { launch } from "./harness.mjs";

const html = readFileSync(new URL("./fixtures/landing.html", import.meta.url));
const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(html)).listen(0);
const url = `http://localhost:${server.address().port}/landing`;

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

/** Asks the page-side bridge for a read-only command, as a browser-driving agent would. */
const bridge = (page, name) =>
  page.evaluate(
    (name) =>
      new Promise((resolve) => {
        const id = String(Math.random());
        const on = (e) => {
          if (e.data?.type !== "agent-markup:response" || e.data.id !== id) return;
          removeEventListener("message", on);
          resolve(e.data.result);
        };
        addEventListener("message", on);
        postMessage({ type: "agent-markup:request", id, name }, location.origin);
        setTimeout(() => resolve({ timeout: true }), 2000);
      }),
    name,
  );

const { context, page, toggle, cmd, ui } = await launch({ headless: !process.env.HEADED });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
try {
  await page.goto(url);
  await toggle();
  const root = ui();

  // ---- Highlight through the command layer, across an element boundary ----
  const [sub] = (await cmd("find_elements", { selector: "p.hero-subtitle" })).data;
  const hl = await cmd("add_highlight", { elementId: sub.elementId, quote: "beautiful emails without", note: "Too salesy", category: "wording" });
  check("add_highlight across <strong>", hl.ok, JSON.stringify(hl));
  const drawn = await page.evaluate(() => {
    const h = CSS.highlights.get("agent-markup");
    const r = h && [...h][0];
    return r ? r.toString() : null;
  });
  check("highlight is drawn with the Custom Highlight API", drawn === "beautiful emails without", String(drawn));
  const missing = await cmd("add_highlight", { elementId: sub.elementId, quote: "not on the page" });
  check("add_highlight refuses text that isn't there", !missing.ok && /not found/.test(missing.error), missing.error);

  // ---- Categories on notes ----
  const [h1] = (await cmd("find_elements", { selector: "h1" })).data;
  await cmd("add_note", { elementId: h1.elementId, note: "Is this claim true?", category: "wrong" });

  // ---- Structured export ----
  const markup = (await cmd("get_markup")).data;
  check("get_markup has the v1 format", markup.format === "agent-markup/v1" && markup.changes.length === 2, markup.format);
  const [first, second] = markup.changes;
  check(
    "highlight exports quote, context and category",
    first.type === "highlight" && first.quote === "beautiful emails without" && first.prefix.endsWith("Send ") && first.category === "wording" && first.categoryLabel === "Wording",
    JSON.stringify({ type: first.type, quote: first.quote, prefix: first.prefix, category: first.category, categoryLabel: first.categoryLabel }),
  );
  check("note exports its category label", second.type === "note" && second.categoryLabel === "Wrong or unverified", second.categoryLabel);
  check("export drops runtime element ids", !("elementId" in first));
  check("prompt describes highlights and categories", /HIGHLIGHT/.test(markup.prompt) && /Category: Wording/.test(markup.prompt) && /Instruction: "Too salesy"/.test(markup.prompt));

  // ---- Update the annotation ----
  const upd = await cmd("update_annotation", { changeId: hl.data.changeId, note: "Say what it does instead", category: "unclear" });
  const afterUpd = (await cmd("list_changes")).data.find((c) => c.id === hl.data.changeId);
  check("update_annotation changes note and category", upd.ok && afterUpd.note === "Say what it does instead" && afterUpd.category === "unclear");

  // ---- Highlight survives a reload ----
  await page.reload();
  await page.waitForTimeout(800);
  const redrawn = await page.evaluate(() => {
    const h = CSS.highlights.get("agent-markup");
    return h ? [...h].map((r) => r.toString()) : [];
  });
  check("highlight is re-anchored after reload", redrawn.includes("beautiful emails without"), JSON.stringify(redrawn));

  // ---- Highlight through the UI: Shift+drag, chip, editor ----
  if (!(await root.locator(".panel").isVisible())) await toggle();
  const box = await page.locator("footer p").boundingBox();
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.waitForTimeout(150);
  const selected = await page.evaluate(() => getSelection().toString());
  check("Shift+drag selects page text while markup is on", selected.includes("Acme Mail"), JSON.stringify(selected));
  check("Highlight chip appears next to the selection", await root.locator(".hl-chip.show").isVisible());
  await root.locator(".hl-chip").click();
  await page.waitForTimeout(80);
  check("chip opens the highlight editor", await root.locator(".note-editor.show .quote").isVisible());
  await root.locator(".note-editor.show select").selectOption("cut");
  await root.locator(".note-editor.show textarea").fill("Drop the year");
  await root.locator(".note-editor.show .btn.primary").click();
  await page.waitForTimeout(100);
  const uiHl = (await cmd("list_changes")).data.find((c) => c.type === "highlight" && c.note === "Drop the year");
  check("UI highlight saved with its category", !!uiHl && uiHl.category === "cut" && uiHl.quote.includes("Acme Mail"), JSON.stringify(uiHl ?? {}).slice(0, 160));
  check("panel lists the highlight with a category badge", (await root.locator(".item .cat", { hasText: "Cut" }).count()) === 1);
  check("highlight pins are drawn", (await root.locator(".pin.hl").count()) >= 2);

  // ---- Send to agent downloads the JSON ----
  const [download] = await Promise.all([page.waitForEvent("download"), root.locator(".panel .send").click()]);
  const name = download.suggestedFilename();
  const saved = JSON.parse(readFileSync(await download.path(), "utf8"));
  check("Send to agent saves agent-markup-<host>-<time>.json", /^agent-markup-localhost-\d+-\d{8}-\d{6}\.json$/.test(name), name);
  check("downloaded file is the structured markup", saved.format === "agent-markup/v1" && saved.changes.length === 3, `${saved.changes?.length} changes`);

  // ---- Read-only bridge ----
  const read = await bridge(page, "get_markup");
  check("bridge answers get_markup on localhost", read.ok && read.data.changes.length === 3, JSON.stringify(read).slice(0, 120));
  const write = await bridge(page, "clear_all");
  check("bridge refuses commands that change anything", !write.ok && (await cmd("list_changes")).data.length === 3, write.error);
  await context.serviceWorkers()[0].evaluate(() => chrome.storage.local.set({ settings: { bridgeOrigins: ["https://docs.example.com"] } }));
  await page.waitForTimeout(150);
  const denied = await bridge(page, "get_markup");
  check("bridge is off for origins not in the settings", !denied.ok && /not enabled/.test(denied.error), denied.error);

  // ---- Undo still covers the new change types ----
  await cmd("undo");
  const afterUndo = (await cmd("list_changes")).data.filter((c) => c.type === "highlight").length;
  check("undo removes the last highlight", afterUndo === 1, String(afterUndo));
} catch (err) {
  failures++;
  console.error(err);
} finally {
  await context.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
