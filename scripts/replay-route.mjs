#!/usr/bin/env node
// Re-films a recorded route with Playwright: same clicks, same (or substituted)
// values, fresh screenshots of every state, at a viewport and scale you choose.
// Use it to film against a seeded demo/fixture instead of your live data, to
// fix steps recorded too fast, or to make variants of one walkthrough.
//
//   node scripts/replay-route.mjs <route.json | route dir> --base-url http://localhost:5173
//        [--out dir] [--viewport 1512x860] [--dpr 2]
//        [--set st_4=ABC-123] [--set sku=ABC-123] [--values values.json]
//        [--storage-state auth.json] [--headed]
//
// --set / --values take a step id or a step's variable name (set in Agent
// Markup). Password-like fields are never recorded, so they need --set.
//
// Every step asserts its target is visible before it is shot (the frame must
// show what the cursor will point at); a target that has to be scrolled to
// becomes an explicit scroll step. A step whose target can't be found stops the
// replay and writes what it has, with the failure in REPLAY.md.
import { chromium } from "playwright";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const flags = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
const input = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!input) {
  console.error("usage: replay-route.mjs <route.json | dir> [--base-url URL] [--out dir] [--viewport WxH] [--dpr N] [--set id=value] [--values file] [--storage-state file] [--headed]");
  process.exit(2);
}
const routePath = statSync(input).isDirectory() ? join(input, "route.json") : input;
const source = JSON.parse(readFileSync(routePath, "utf8"));
if (source.format !== "agent-markup/route-v1") throw new Error(`${routePath} is not an agent-markup/route-v1 route`);

const baseUrl = flag("base-url");
const [vw, vh] = (flag("viewport") ?? `${source.viewport.width}x${source.viewport.height}`).split("x").map(Number);
const dpr = Number(flag("dpr", source.viewport.dpr ?? 1));
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
const outDir = resolve(flag("out", join(dirname(resolve(routePath)), `replay-${stamp}`)));
const overrides = { ...(flag("values") ? JSON.parse(readFileSync(flag("values"), "utf8")) : {}) };
for (const kv of flags("set")) {
  const i = kv.indexOf("=");
  overrides[kv.slice(0, i)] = kv.slice(i + 1);
}

const rebase = (url) => {
  if (!baseUrl || !url) return url;
  const u = new URL(url);
  return new URL(u.pathname + u.search + u.hash, baseUrl).href;
};
const modKey = (key) => key.replace(/^Mod\+/, "ControlOrMeta+");

mkdirSync(join(outDir, "frames"), { recursive: true });
const route = { ...source, id: `${source.id}-replay`, site: baseUrl ? new URL(baseUrl).origin : source.site, viewport: { width: vw, height: vh, dpr }, steps: [], frames: {}, startFrame: undefined, updatedAt: new Date().toISOString() };
const log = [];
let frameN = 0;
let lastFrame;
const t0 = Date.now();

const browser = await chromium.launch({ headless: !argv.includes("--headed") });
const context = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr, ...(flag("storage-state") ? { storageState: flag("storage-state") } : {}) });
const page = await context.newPage();

/** Same idea as the extension: no DOM mutations for a while, or give up after max. */
async function settle({ quiet = 450, min = 300, max = 4000 } = {}) {
  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
  await page
    .evaluate(
      ({ quiet, min, max }) =>
        new Promise((done) => {
          const start = performance.now();
          let last = start;
          const mo = new MutationObserver(() => (last = performance.now()));
          mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          const tick = () => {
            const now = performance.now();
            if ((now - start >= min && now - last >= quiet) || now - start >= max) {
              mo.disconnect();
              done();
            } else setTimeout(tick, 80);
          };
          setTimeout(tick, 80);
        }),
      { quiet, min, max },
    )
    .catch(() => {});
}

async function shot() {
  const id = `f${++frameN}`;
  const file = `frames/${id}.jpg`;
  writeFileSync(join(outDir, file), await page.screenshot({ type: "jpeg", quality: 88 }));
  const [scrollX, scrollY] = await page.evaluate(() => [Math.round(scrollX), Math.round(scrollY)]);
  route.frames[id] = { id, width: Math.round(vw * dpr), height: Math.round(vh * dpr), viewport: { width: vw, height: vh }, dpr, scrollX, scrollY, url: page.url(), at: Date.now() - t0, file };
  lastFrame = id;
  return id;
}

async function locate(t) {
  const tries = [];
  if (t.selector) tries.push(["selector", () => page.locator(t.selector)]);
  if (t.role && t.role !== "generic" && t.name) tries.push(["role", () => page.getByRole(t.role, { name: t.name, exact: true })]);
  if (t.testId && t.role !== "generic" && t.name) tries.push(["testid+role", () => page.getByTestId(t.testId).getByRole(t.role, { name: t.name, exact: true })]);
  if (t.label) tries.push(["label", () => page.getByLabel(t.label, { exact: true })]);
  if (t.name) tries.push(["text", () => page.getByText(t.name, { exact: true })]);
  for (const [how, make] of tries) {
    try {
      let loc = make();
      let n = await loc.count();
      if (n > 1) {
        loc = loc.filter({ visible: true });
        n = await loc.count();
      }
      if (n === 1) return { loc, how };
    } catch {
      // Invalid selector on this page; try the next strategy.
    }
  }
  return null;
}

/** Typing stops measured in the field's own font (mirror of the extension's typingOf). */
const typingOf = (loc, value) =>
  loc.evaluate((el, value) => {
    const cs = getComputedStyle(el);
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const letterSpacing = parseFloat(cs.letterSpacing) || 0;
    ctx.letterSpacing = `${letterSpacing}px`;
    const chars = Array.from(value);
    const stops = chars.map((_, i) => Math.round(ctx.measureText(chars.slice(0, i + 1).join("")).width * 10) / 10);
    const px = (v) => parseFloat(v) || 0;
    const fontSize = px(cs.fontSize);
    const lineHeight = px(cs.lineHeight) || fontSize * 1.2;
    let bg = "rgb(255, 255, 255)";
    for (let a = el; a; a = a.parentElement) {
      const c = getComputedStyle(a).backgroundColor;
      if (c && c !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(c)) {
        bg = c;
        break;
      }
    }
    const r = el.getBoundingClientRect();
    return { fontFamily: cs.fontFamily, fontSize, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, letterSpacing, color: cs.color, bg, textX: px(cs.borderLeftWidth) + px(cs.paddingLeft), textY: el.localName === "textarea" ? px(cs.borderTopWidth) + px(cs.paddingTop) : Math.round(((r.height - lineHeight) / 2) * 10) / 10, lineHeight, stops, align: cs.textAlign };
  }, value);

const rectOf = async (loc) => {
  const b = await loc.boundingBox();
  return b && { x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, width: Math.round(b.width * 10) / 10, height: Math.round(b.height * 10) / 10 };
};
const inViewport = (r) => r.x >= -2 && r.y >= -2 && r.x + r.width <= vw + 2 && r.y + r.height <= vh + 2;

class Stop extends Error {}
/** Stops the replay: everything after a missing target would be filmed in the wrong state. */
function fail(message) {
  log.push(`- ✗ ${message}`);
  throw new Stop(message);
}

function finish(code) {
  writeFileSync(join(outDir, "route.json"), JSON.stringify(route, null, 2));
  writeFileSync(join(outDir, "REPLAY.md"), [`# Replay of ${routePath}`, "", `Base URL: ${baseUrl ?? "(original)"} · viewport ${vw}x${vh} @${dpr}x`, "", ...log, ""].join("\n"));
  console.log(`${code ? "Replay stopped" : "Replayed"}: ${route.steps.length}/${source.steps.length} steps → ${outDir}`);
  for (const l of log.filter((l) => l.includes("✗") || l.includes("⚠"))) console.log(l);
  void browser.close().then(() => process.exit(code));
}

try {
  const first = source.steps.find((s) => s.kind !== "chapter");
  await page.goto(rebase(first?.page.url ?? source.site));
  await settle();
  route.startFrame = await shot();
  let n = 0;
  for (const s of source.steps) {
    if (s.kind === "chapter") {
      route.steps.push({ ...s, frames: {} });
      continue;
    }
    n++;
    const step = { ...s, at: Date.now() - t0, page: { url: page.url(), title: await page.title() }, frames: {}, warnings: undefined };
    const override = overrides[s.id] ?? (s.variable ? overrides[s.variable] : undefined);
    if (override !== undefined) step.value = String(override);

    if (s.kind === "navigate") {
      step.frames.before = lastFrame;
      step.value = rebase(s.value);
      await page.goto(step.value);
      await settle();
      step.frames.after = await shot();
      route.steps.push(step);
      log.push(`- ${n}. go to ${new URL(step.value).pathname}`);
      continue;
    }
    if (s.kind === "scroll") {
      step.frames.before = lastFrame;
      const { container, toX, toY } = s.scroll;
      if (container) await page.locator(container).first().evaluate((el, [x, y]) => el.scrollTo(x, y), [toX, toY]).catch(() => {});
      else await page.evaluate(([x, y]) => scrollTo(x, y), [toX, toY]);
      await settle({ min: 200 });
      step.frames.after = await shot();
      route.steps.push(step);
      log.push(`- ${n}. scroll`);
      continue;
    }

    const found = s.target ? await locate(s.target) : null;
    if (s.target && !found) fail(`Step ${n} (${s.caption}): can't find ${s.target.role} “${s.target.name || s.target.label}” (${s.target.selector}) on ${page.url()}.`);
    if (!found && s.kind !== "press") fail(`Step ${n} (${s.caption}): no target recorded.`);
    const loc = found?.loc;
    if (loc) {
      // The frame must show the target: scroll to it first, as its own visible step.
      const before = await page.evaluate(() => [scrollX, scrollY]);
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      const after = await page.evaluate(() => [scrollX, scrollY]);
      if (before[1] !== after[1] || before[0] !== after[0]) {
        const from = lastFrame;
        await settle({ min: 200 });
        const scrolled = await shot();
        route.steps.push({ id: `${s.id}_scroll`, kind: "scroll", at: step.at, page: step.page, caption: after[1] > before[1] ? "Scroll down" : "Scroll up", scroll: { container: null, fromX: before[0], fromY: before[1], toX: after[0], toY: after[1] }, frames: { before: from, after: scrolled } });
        log.push(`- ${n}. ⚠ added a scroll step so the target is on screen before it's clicked`);
      }
      const rect = await rectOf(loc);
      if (!rect || !inViewport(rect)) fail(`Step ${n} (${s.caption}): the target is not fully visible after scrolling; a frame can't show it.`);
      step.target = { ...s.target, rect, inViewport: true };
    }
    step.frames.before = lastFrame;
    const position = step.target?.point && step.target.rect ? { x: step.target.rect.width * step.target.point.fx, y: step.target.rect.height * step.target.point.fy } : undefined;

    if (s.kind === "click" || s.kind === "check") {
      await loc.click({ position });
      await settle();
      if (s.kind === "check") step.checked = await loc.isChecked().catch(() => s.checked);
      if (override !== undefined) log.push(`- ${n}. ⚠ override ignored for a ${s.kind} step`);
    } else if (s.kind === "fill") {
      if (s.sensitive && override === undefined) fail(`Step ${n} (${s.caption}): this field's value was never recorded; pass --set ${s.id}=… (or --set ${s.variable ?? "<variable>"}=…).`);
      await loc.click({ position });
      await settle({ min: 150 });
      step.frames.focused = await shot();
      if (await loc.inputValue().catch(() => "")) await loc.press("ControlOrMeta+A");
      await loc.pressSequentially(step.value ?? "", { delay: 30 });
      if (s.sensitive) step.value = "•".repeat(Math.min(String(override).length, 12));
      step.typing = await typingOf(loc, s.sensitive ? step.value : (step.value ?? "")).catch(() => undefined);
      await settle({ quiet: 350, min: 150 });
    } else if (s.kind === "select") {
      await loc.selectOption({ label: step.value });
      await settle();
    } else if (s.kind === "press") {
      if (loc) await loc.press(modKey(s.key));
      else await page.keyboard.press(modKey(s.key));
      await settle();
    }
    step.frames.after = await shot();
    if (page.url() !== step.page.url) step.navigatesTo = page.url();
    else delete step.navigatesTo;
    delete step.warnings;
    route.steps.push(step);
    log.push(`- ${n}. ${s.kind} ${s.target ? `“${s.target.name || s.target.label}” via ${found.how}` : s.key ?? ""}${override !== undefined ? ` = “${s.sensitive ? "(hidden)" : override}”` : ""}`);
  }
  finish(0);
} catch (err) {
  if (!(err instanceof Stop)) log.push(`- ✗ Unexpected error: ${err?.message ?? err}`);
  finish(1);
}
