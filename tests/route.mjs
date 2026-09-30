// Route mode end to end: record a click-through on a fixture app through the
// real extension, check the recorded steps and frames, compose it into a
// HyperFrames project, and replay it with Playwright.
// Run: bun run test:route
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch } from "./harness.mjs";

const html = readFileSync(new URL("./fixtures/app.html", import.meta.url));
const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(html)).listen(0);
const base = `http://localhost:${server.address().port}`;
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "am-route-"));

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
};

const { context, page, toggle, cmd, ui } = await launch({ headless: !process.env.HEADED });
page.on("pageerror", (e) => console.log("pageerror:", e.message));
const route = async (includeFrames = false) => (await cmd("get_route", { includeFrames })).data;
/** Waits until no screenshot is in flight and the last step has its after-frame. */
async function idle(ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await page.waitForTimeout(150);
    const r = await route();
    const last = r?.steps.filter((s) => s.kind !== "chapter").at(-1);
    const pending = await ui().locator(".r-dot.busy").count();
    if (!pending && (last ? last.frames.after : r?.startFrame)) return;
  }
}

try {
  await page.goto(`${base}/`);
  await toggle();
  const mode = await cmd("set_mode", { mode: "route" });
  check("set_mode route", mode.ok && mode.data.mode === "route");
  check("route tab selected", (await ui().locator(".mode-tab[aria-selected=true]").textContent()) === "Route");

  const started = await cmd("start_recording", { title: "Create a rush order" });
  check("start_recording", started.ok, JSON.stringify(started));
  await idle();
  let r = await route();
  check("start frame captured", !!r.startFrame, r.startFrame ?? (await ui().locator(".r-status").textContent()));

  // The page must work normally in route mode (not intercepted like markup mode).
  await page.click("[data-testid=new-order]");
  await idle();
  check("page click still works in route mode", await page.isVisible("form.open"));

  await page.click("#customer");
  await idle();
  await page.keyboard.type("Nike Dunk Low", { delay: 35 });
  await idle();
  await page.selectOption("#size", { label: "10.5" });
  await idle();
  await page.check("#rush");
  await idle();
  await cmd("add_chapter", { title: "Save it" });
  await page.click("button[type=submit]");
  await idle();
  await page.click("#nav-orders");
  await idle();

  r = await route();
  const steps = r.steps.filter((s) => s.kind !== "chapter");
  const kinds = steps.map((s) => s.kind).join(",");
  check("recorded kinds", kinds === "click,fill,select,check,click,click", kinds);
  const [open, fill, select, rush, save, nav] = steps;
  check("click target named by role + name", open?.target.role === "button" && open.target.name === "New order", JSON.stringify(open?.target));
  check("click rect measured", open?.target.rect.width > 20 && open.target.inViewport);
  check("fill value", fill?.value === "Nike Dunk Low", fill?.value);
  check("fill label", fill?.target.label === "Customer", fill?.target.label);
  check("fill typing stops per char", fill?.typing?.stops.length === 13, String(fill?.typing?.stops.length));
  check("fill has focused + after frames", !!fill?.frames.focused && !!fill.frames.after, JSON.stringify(fill?.frames));
  check("select value", select?.value === "10.5", select?.value);
  check("check state", rush?.checked === true, String(rush?.checked));
  check("captions drafted", open?.caption === "Click “New order”" && fill?.caption.includes("Nike Dunk Low"), `${open?.caption} | ${fill?.caption}`);
  check("SPA navigation linked to the click", nav?.navigatesTo?.endsWith("/orders"), nav?.navigatesTo);
  check("chapter kept in order", r.steps.findIndex((s) => s.kind === "chapter") === r.steps.indexOf(r.steps.find((s) => s.id === save.id)) - 1);
  const chained = steps.slice(1).filter((s, i) => s.frames.before && s.frames.before === steps[i].frames.after).length;
  check("frames chain (after → next before)", chained >= steps.length - 2, `${chained}/${steps.length - 1}`);
  check("save's warnings empty", !save?.warnings?.length, JSON.stringify(save?.warnings));

  // Panel shows steps with thumbnails.
  await page.waitForTimeout(300);
  check("panel lists steps", (await ui().locator(".r-step").count()) === steps.length);
  check("thumbnails load", await ui().locator(".r-step img.r-thumb").first().evaluate((i) => i.src.startsWith("data:image/")));

  // Editing a caption goes through the command layer and sticks.
  await cmd("update_step", { stepId: fill.id, caption: "Search for the customer", emphasis: true });
  r = await route();
  check("caption edit + emphasis", r.steps.find((s) => s.id === fill.id).caption === "Search for the customer" && r.steps.find((s) => s.id === fill.id).emphasis);

  const prompt = await cmd("get_route_prompt");
  check("route prompt", prompt.ok && prompt.data.prompt.includes("TYPE") && prompt.data.prompt.includes("route-to-hyperframes"));

  // Compose.
  const full = await route(true);
  delete full.recording;
  const file = join(tmp, "route.json");
  writeFileSync(file, JSON.stringify(full));
  check("frames inlined", Object.values(full.frames).every((f) => f.dataUrl?.startsWith("data:image/jpeg")));
  const out = join(tmp, "video");
  const composed = spawnSync("node", ["scripts/route-to-hyperframes.mjs", file, "--out", out], { encoding: "utf8" });
  check("composer ran", composed.status === 0, composed.stderr || composed.stdout.trim());
  const index = existsSync(join(out, "index.html")) ? readFileSync(join(out, "index.html"), "utf8") : "";
  check("composition root", index.includes('data-composition-id="walkthrough"') && index.includes('window.__timelines["walkthrough"]'));
  check("typing reveal emitted", /id="typ-1"/.test(index));
  check("chapter card emitted", index.includes("Save it"));
  check("storyboard + review", existsSync(join(out, "STORYBOARD.md")) && existsSync(join(out, "REVIEW.md")));
  // The generated timeline must at least parse.
  const script = index.match(/<script>\n([\s\S]*?)<\/script>/)?.[1] ?? "";
  let parsed = true;
  try {
    new Function("gsap", "window", script);
  } catch (e) {
    parsed = false;
    console.log(e.message);
  }
  check("timeline script parses", parsed);

  // Replay against the same app.
  const replayOut = join(tmp, "replay");
  // Async: the fixture server lives in this process and must keep answering.
  const run = (args) =>
    new Promise((done) => {
      const p = spawn("node", args);
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (status) => done({ status, out }));
    });
  const replay = await run( ["scripts/replay-route.mjs", file, "--base-url", base, "--out", replayOut, "--set", `${fill.id}=Air Max 1`, "--dpr", "2"]);
  check("replay ran", replay.status === 0, replay.out.trim().split("\n").slice(-4).join(" | "));
  if (replay.status === 0) {
    const rr = JSON.parse(readFileSync(join(replayOut, "route.json"), "utf8"));
    const rf = rr.steps.find((s) => s.id === fill.id);
    check("replay substituted value", rf?.value === "Air Max 1" && rf.typing?.stops.length === 9, rf?.value);
    check("replay frames on disk", Object.values(rr.frames).every((f) => existsSync(join(replayOut, f.file))));
    const recomposed = spawnSync("node", ["scripts/route-to-hyperframes.mjs", replayOut, "--out", join(tmp, "video2")], { encoding: "utf8" });
    check("replayed route composes", recomposed.status === 0, recomposed.stderr);
  }

  const cleared = await cmd("clear_route");
  check("clear_route", cleared.ok && (await route()) === null);
  console.log(`\nartifacts: ${tmp}`);
} finally {
  await context.close();
  server.close();
}
if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
