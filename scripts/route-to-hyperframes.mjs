#!/usr/bin/env node
// Turns an Agent Markup route (agent-markup/route-v1) into a HyperFrames
// project: the recorded screenshots in a browser window, a camera that pushes
// in on each control, one cursor that travels to what was clicked, click
// ripples, typing revealed glyph by glyph from the real after-frame (at the
// widths measured in the page's own font), key and choice badges, captions that
// avoid the subject, chapter cards, and a title and end card.
//
//   node scripts/route-to-hyperframes.mjs <route.json | route dir | download.json> [--out dir]
//        [--width 1920] [--height 1080] [--title "…"] [--no-cards]
//
// Writes <out>/index.html, assets/frames/*, STORYBOARD.md (one frame per step,
// for review), REVIEW.md (everything that needs a human decision), timeline.json
// (computed beat times, for narration) and package.json/hyperframes.json.
// Then: cd <out> && npx hyperframes check && npx hyperframes preview
//
// The pixels are real; only the motion is authored. Anything the route could
// not capture is reported in REVIEW.md instead of being painted in.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const HYPERFRAMES_VERSION = "0.8.97";
const GSAP_URL = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js";

// ---- Args --------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const input = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!input) {
  console.error("usage: route-to-hyperframes.mjs <route.json | dir> [--out dir] [--width 1920] [--height 1080] [--title …] [--no-cards]");
  process.exit(2);
}
const routePath = statSync(input).isDirectory() ? join(input, "route.json") : input;
const routeDir = dirname(resolve(routePath));
const route = JSON.parse(readFileSync(routePath, "utf8"));
if (route.format !== "agent-markup/route-v1") throw new Error(`${routePath} is not an agent-markup/route-v1 route`);
const FW = Number(flag("width", 1920));
const FH = Number(flag("height", 1080));
const cards = !argv.includes("--no-cards");
const title = flag("title", route.title || "Walkthrough");
const outDir = resolve(flag("out", join(routeDir, "hyperframes")));

// ---- Helpers -----------------------------------------------------------------
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const words = (s) => String(s ?? "").split(/\s+/).filter(Boolean).length;
const pathOf = (url) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url ?? "";
  }
};
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

// ---- Frames ------------------------------------------------------------------
mkdirSync(join(outDir, "assets/frames"), { recursive: true });
const frameSrc = {};
for (const [id, f] of Object.entries(route.frames ?? {})) {
  if (!/^f\d+$/.test(id)) continue;
  if (f.dataUrl) {
    const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(f.dataUrl);
    if (!m) continue;
    const file = `assets/frames/${id}.${m[1] === "png" ? "png" : "jpg"}`;
    writeFileSync(join(outDir, file), Buffer.from(m[2], "base64"));
    frameSrc[id] = file;
  } else if (f.file && existsSync(join(routeDir, f.file))) {
    const file = `assets/frames/${basename(f.file)}`;
    copyFileSync(join(routeDir, f.file), join(outDir, file));
    frameSrc[id] = file;
  }
}
const hasFrame = (id) => !!id && !!frameSrc[id];

// ---- Geometry ----------------------------------------------------------------
const VW = route.viewport?.width || 1440;
const VH = route.viewport?.height || 900;
const CHROME = 44;
const MARGIN_X = Math.round(FW * 0.0625);
const MARGIN_Y = Math.round(FH * 0.06);
const aspect = VW / VH;
let SW = Math.min(FW - 2 * MARGIN_X, (FH - 2 * MARGIN_Y - CHROME) * aspect);
let SH = SW / aspect;
SW = Math.round(SW);
SH = Math.round(SH);
const WX = Math.round((FW - SW) / 2);
const WY = Math.round((FH - SH - CHROME) / 2);
const K = SW / VW; // page CSS px -> stage px at zoom 1
// Zoom is capped by the pixel budget: beyond it we'd be upscaling the screenshot.
const imgW = Math.max(0, ...Object.values(route.frames ?? {}).map((f) => f.width || 0)) || VW;
const ZOOM_CAP = clamp(imgW / SW, 1, 2.4);

const toStage = (rect) => ({ x: rect.x * K, y: rect.y * K, w: rect.width * K, h: rect.height * K });
const clampCam = (c) => ({ s: c.s, x: clamp(c.x, SW - c.s * SW, 0), y: clamp(c.y, SH - c.s * SH, 0) });

function cameraFor(rect, emphasis, cur) {
  const want = clamp(Math.min(((emphasis ? 0.36 : 0.5) * SW) / Math.max(rect.w, 150), (0.55 * SH) / Math.max(rect.h, 36)), 1, ZOOM_CAP);
  // Keep the camera still when the target is already comfortably in view at about this zoom.
  const inView = (c) => {
    const x0 = c.x + c.s * rect.x, y0 = c.y + c.s * rect.y;
    const x1 = x0 + c.s * rect.w, y1 = y0 + c.s * rect.h;
    return x0 > SW * 0.08 && y0 > SH * 0.1 && x1 < SW * 0.92 && y1 < SH * 0.8;
  };
  if (Math.abs(cur.s - want) < 0.22 && inView(cur)) return cur;
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  // Bias the subject slightly above centre, leaving room for a bottom caption.
  return clampCam({ s: r3(want), x: SW / 2 - want * cx, y: SH * 0.44 - want * cy });
}

const camTravel = (a, b) => {
  const d = Math.hypot(b.x - a.x, b.y - a.y) + 520 * Math.abs(b.s - a.s);
  return d < 3 ? 0 : r2(clamp(0.3 + 0.045 * Math.sqrt(d), 0.5, 1.35));
};
const cursorTravel = (a, b) => {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  return d < 2 ? 0 : r2(clamp(0.32 + 0.028 * Math.sqrt(d), 0.45, 1.0));
};
const project = (cam, p) => ({ x: clamp(cam.x + cam.s * p.x, 6, SW - 6), y: clamp(cam.y + cam.s * p.y, 6, SH - 6) });

// ---- Build -------------------------------------------------------------------
const TITLE_DUR = cards ? 3.4 : 0;
const END_DUR = cards ? 3.6 : 0;
const FADE = 0.4;

const tl = []; // timeline source lines
const at = (t) => r2(t);
const html = { frames: [], cam: [], fx: [], caps: [], urls: [], chapters: [] };
const review = [];
const storyboard = [];
const beats = [];

// Frames: one <img> per used frame, all stacked in the camera.
const usedFrames = new Set();
if (hasFrame(route.startFrame)) usedFrames.add(route.startFrame);
for (const s of route.steps) for (const f of Object.values(s.frames ?? {})) if (hasFrame(f)) usedFrames.add(f);
for (const id of usedFrames) html.frames.push(`<img id="frm-${id}" class="frm" src="${frameSrc[id]}" alt="" />`);
if (!usedFrames.size) throw new Error("The route has no frames. Record with screenshots, or re-film it with scripts/replay-route.mjs.");

// URL bar entries.
const urlIds = new Map();
const urlEl = (url) => {
  const key = pathOf(url);
  if (!urlIds.has(key)) {
    const id = `url-${urlIds.size + 1}`;
    urlIds.set(key, id);
    html.urls.push(`<div id="${id}" class="url-item"><span class="url-host">${esc(hostOf(url))}</span><span class="url-path">${esc(key)}</span></div>`);
  }
  return urlIds.get(key);
};

let t = TITLE_DUR > 0 ? TITLE_DUR - 0.1 : 0.2;
let visible = null;
let visibleUrl = null;
let cam = { s: 1, x: 0, y: 0 };
let cursor = null; // stage px, frame space
let cursorShown = false;
let stepNo = 0;
let chapterTitle = "";

const firstFrame = hasFrame(route.startFrame) ? route.startFrame : [...usedFrames][0];
tl.push(`tl.set("#frm-${firstFrame}", { opacity: 1 }, 0);`);
visible = firstFrame;
tl.push(`tl.set("#cam", { x: 0, y: 0, scale: 1 }, 0);`);
const firstUrl = route.steps.find((s) => s.kind !== "chapter")?.page.url ?? route.site;
visibleUrl = urlEl(firstUrl);
tl.push(`tl.set("#${visibleUrl}", { opacity: 1 }, 0);`);

/** Fade out, then a hard kill at the end so a seek past the fade can't leave it visible. */
function fadeOut(sel, time, dur, extra = "") {
  tl.push(`tl.to("${sel}", { opacity: 0, duration: ${dur}${extra} }, ${at(time)});`);
  tl.push(`tl.set("${sel}", { opacity: 0 }, ${at(time + dur)});`);
}

function showFrame(id, time, dur = FADE) {
  if (!hasFrame(id) || id === visible) return;
  tl.push(`tl.to("#frm-${id}", { opacity: 1, duration: ${dur}, ease: "power1.inOut" }, ${at(time)});`);
  tl.push(`tl.set("#frm-${visible}", { opacity: 0 }, ${at(time + dur)});`);
  visible = id;
}

function showUrl(url, time) {
  const id = urlEl(url);
  if (id === visibleUrl) return;
  fadeOut(`#${visibleUrl}`, time, 0.25);
  tl.push(`tl.fromTo("#${id}", { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" }, ${at(time + 0.15)});`);
  visibleUrl = id;
}

function moveCamera(next, time) {
  const d = camTravel(cam, next);
  if (d) tl.push(`tl.to("#cam", { scale: ${next.s}, x: ${r2(next.x)}, y: ${r2(next.y)}, duration: ${d}, ease: "power2.inOut" }, ${at(time)});`);
  cam = next;
  return d;
}

/** Cursor to a stage point: separate eases per axis (vertical starts late), small overshoot, settle. */
function moveCursor(to, time) {
  if (!cursorShown) {
    const from = { x: clamp(to.x + SW * 0.18, 20, SW - 20), y: clamp(to.y + SH * 0.22, 20, SH - 20) };
    tl.push(`tl.set("#cursor", { x: ${r2(from.x)}, y: ${r2(from.y)} }, ${at(time - 0.01)});`);
    tl.push(`tl.to("#cursor", { opacity: 1, duration: 0.3 }, ${at(time)});`);
    cursor = from;
    cursorShown = true;
  }
  const d = cursorTravel(cursor, to);
  if (!d) {
    cursor = to;
    return 0;
  }
  const dx = to.x - cursor.x, dy = to.y - cursor.y;
  const len = Math.hypot(dx, dy) || 1;
  const over = Math.min(6, len * 0.03);
  const ox = r2(to.x + (dx / len) * over), oy = r2(to.y + (dy / len) * over);
  tl.push(`tl.to("#cursor", { x: ${ox}, duration: ${d}, ease: "power2.inOut" }, ${at(time)});`);
  tl.push(`tl.to("#cursor", { y: ${oy}, duration: ${r2(d - 0.06)}, ease: "power3.inOut" }, ${at(time + 0.06)});`);
  tl.push(`tl.to("#cursor", { x: ${r2(to.x)}, y: ${r2(to.y)}, duration: 0.16, ease: "power2.out" }, ${at(time + d + 0.02)});`);
  cursor = to;
  return r2(d + 0.18);
}

let fxN = 0;
function ripple(p, time) {
  const id = `rip-${++fxN}`;
  html.fx.push(`<div id="${id}" class="ripple" style="left:${r2(p.x - 30)}px;top:${r2(p.y - 30)}px"></div>`);
  tl.push(`tl.to("#cursor-i", { scale: 0.82, duration: 0.09, ease: "power2.out" }, ${at(time)});`);
  tl.push(`tl.to("#cursor-i", { scale: 1, duration: 0.18, ease: "power2.out" }, ${at(time + 0.09)});`);
  // set + to, not fromTo: a fromTo renders its from-state (a visible ring) as soon as the timeline is built.
  tl.push(`tl.set("#${id}", { scale: 0.3, opacity: 0.7 }, ${at(time)});`);
  tl.push(`tl.to("#${id}", { scale: 1.6, opacity: 0, duration: 0.6, ease: "power2.out" }, ${at(time)});`);
}

function badge(text, p, time, until, cls = "") {
  const id = `bdg-${++fxN}`;
  const above = p.y > 90;
  html.fx.push(`<div id="${id}" class="badge ${cls}" style="left:${r2(clamp(p.x - 16, 8, SW - 260))}px;top:${r2(above ? p.y - 64 : p.y + 34)}px">${text}</div>`);
  tl.push(`tl.fromTo("#${id}", { opacity: 0, y: ${above ? 8 : -8}, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.3, ease: "back.out(1.6)" }, ${at(time)});`);
  fadeOut(`#${id}`, until, 0.25);
}

function keyLabel(key) {
  return esc(key)
    .replace(/^Mod\+/, "⌘ ")
    .replace("Shift+", "⇧ ")
    .replace(/^Enter$/, "⏎ Enter")
    .replace(/^Escape$/, "Esc");
}

/** Caption plate: bottom by default, top when the subject would sit under it. */
function caption(step, n, start, end, subjectBand) {
  const id = `cap-${step.id}`;
  const capTop = FH - WY - 190; // bottom plate band in frame px
  const bandBottom = subjectBand ? WY + CHROME + subjectBand[1] : 0;
  const pos = subjectBand && bandBottom > capTop ? "top" : "bottom";
  const eyebrow = chapterTitle ? `${esc(chapterTitle)} · Step ${n}` : `Step ${n}`;
  html.caps.push(`<div id="${id}" class="cap-row ${pos}"><div class="cap"><div class="cap-eyebrow">${eyebrow}</div><div class="cap-text">${esc(step.caption)}</div></div></div>`);
  tl.push(`tl.fromTo("#${id}", { opacity: 0, y: ${pos === "top" ? -14 : 14} }, { opacity: 1, y: 0, duration: 0.35, ease: "power2.out" }, ${at(start + 0.05)});`);
  fadeOut(`#${id}`, end - 0.3, 0.28, `, ease: "power1.in"`);
  if (step.caption.length > 90) review.push(`- [ ] Step ${n}: caption is ${step.caption.length} characters; keep it under ~90 so it reads in one glance.`);
  return pos;
}

function readTime(step) {
  return Math.max(1.9, words(step.caption) / 2.7 + 0.8) + (step.emphasis ? 1.2 : 0);
}

let typeN = 0;
/** Typing: reveal the after-frame's glyphs inside the field, one measured stop at a time. */
function typing(step, rect, start) {
  const ty = step.typing;
  const value = step.value ?? "";
  const chars = [...value];
  const dt = r3(clamp(1.9 / Math.max(chars.length, 1), 0.035, 0.09));
  const dur = r2(chars.length * dt);
  const under = step.frames.focused ?? step.frames.before;
  const canReveal =
    ty && ty.stops?.length === chars.length && chars.length > 0 && hasFrame(step.frames.after) && hasFrame(under) &&
    (ty.align === "start" || ty.align === "left") && step.target?.tag === "input" &&
    ty.stops[ty.stops.length - 1] < step.target.rect.width - ty.textX - 4;
  if (!canReveal) {
    if (chars.length && !hasFrame(step.frames.after)) review.push(`- [ ] Step ${stepNo}: typed “${value}” but there is no after-frame, so the text never appears. Re-film this step.`);
    return { end: start + Math.min(dur, 1.2), revealed: false };
  }
  // Reveal window: inside the border, from the text origin to the field's inner right edge.
  const x0 = rect.x + (ty.textX - 1) * K;
  const y0 = rect.y + 2 * K;
  const w = rect.w - (ty.textX + 3) * K;
  const h = rect.h - 4 * K;
  const id = `typ-${++typeN}`;
  // Background images, not <img>: the same frame as an <img> twice reads as duplicate media.
  const img = (src, iid) => `<div ${iid ? `id="${iid}" ` : ""}class="tcrop" style="left:${r2(-x0)}px;top:${r2(-y0)}px;background-image:url('${frameSrc[src]}')"></div>`;
  html.cam.push(
    `<div id="${id}" class="tclip" style="left:${r2(x0)}px;top:${r2(y0)}px;width:${r2(w)}px;height:${r2(h)}px">` +
      img(step.frames.after) +
      `<div id="${id}-c" class="tcover" style="width:${r2(w)}px;height:${r2(h)}px;background-color:${esc(ty.bg)}">${img(under, `${id}-ci`)}</div></div>`,
  );
  tl.push(`tl.set("#${id}", { opacity: 1 }, ${at(start - 0.02)});`);
  // A placeholder (or the old value) vanishes on the first keystroke: the one legitimate synthetic cover.
  tl.push(`tl.set("#${id}-ci", { opacity: 0 }, ${at(start)});`);
  ty.stops.forEach((stop, i) => {
    const x = r2(Math.min(stop + 1, w / K) * K);
    tl.push(`tl.set("#${id}-c", { x: ${x} }, ${at(start + i * dt)});`);
    tl.push(`tl.set("#${id}-ci", { x: ${-x} }, ${at(start + i * dt)});`);
  });
  return { end: start + dur, revealed: true, id };
}

if (ZOOM_CAP < 1.15)
  review.push(`- [ ] Frames are ${imgW}px wide for a ${SW}px stage, so there is no room to push in without upscaling. Re-film with scripts/replay-route.mjs --dpr 2 for camera zoom.`);

const steps = route.steps;
for (let i = 0; i < steps.length; i++) {
  const step = steps[i];
  if (step.kind === "chapter") {
    chapterTitle = step.title || step.caption;
    if (!cards) continue;
    const id = `chap-${step.id}`;
    const dur = 2.3;
    html.chapters.push(
      `<section id="${id}" class="clip" data-start="${at(t)}" data-duration="${dur}" data-track-index="3"><div id="${id}-bg" class="card-bg" style="opacity:0"></div><div id="${id}-in" class="chapter-in" style="opacity:0"><div class="chapter-eyebrow">Chapter</div><div class="chapter-title">${esc(chapterTitle)}</div></div></section>`,
    );
    tl.push(`tl.fromTo("#${id}-bg", { opacity: 0 }, { opacity: 1, duration: 0.35, ease: "power1.inOut" }, ${at(t)});`);
    fadeOut(`#${id}-bg`, t + dur - 0.36, 0.35, `, ease: "power1.inOut"`);
    tl.push(`tl.fromTo("#${id}-in", { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.45, ease: "power3.out" }, ${at(t + 0.05)});`);
    fadeOut(`#${id}-in`, t + dur - 0.4, 0.35, `, ease: "power1.in"`);
    storyboard.push({ n: null, title: `Chapter — ${chapterTitle}`, start: t, dur, step });
    t += dur;
    continue;
  }
  stepNo++;
  const S = t;
  const n = stepNo;
  let R = S + 0.4; // when the result is on screen
  let band = null;

  // The screen must match this step's before-frame. A different frame here is a change with no cause.
  if (step.frames.before && hasFrame(step.frames.before) && step.frames.before !== visible) {
    const prev = steps.slice(0, i).reverse().find((s) => s.kind !== "chapter");
    review.push(`- [ ] Step ${n}: the screen changes before it starts (step ${n - 1}'s after-frame is not its before-frame${prev ? `; was “${prev.caption}”` : ""}). Usually a deleted step or a fast action; re-film or accept the cut.`);
    showFrame(step.frames.before, S, 0.35);
  }
  if (!step.frames.before) review.push(`- [ ] Step ${n}: no before-frame (“${step.caption}”). It animates over the previous screen; check it still matches.`);
  for (const w of step.warnings ?? []) review.push(`- [ ] Step ${n}: ${w}`);
  showUrl(step.page.url, S);

  if (step.target && step.kind !== "scroll" && step.kind !== "navigate") {
    const rect = toStage(step.target.rect);
    if (!step.target.inViewport) review.push(`- [ ] Step ${n}: the target was off-screen in the capture; the cursor is clamped to the frame edge.`);
    const next = cameraFor(rect, step.emphasis, cam);
    const camDur = moveCamera(next, S);
    const pt = step.target.point ?? { fx: 0.5, fy: 0.5 };
    const anchor = { x: rect.x + rect.w * clamp(pt.fx, 0.15, 0.85), y: rect.y + rect.h * clamp(pt.fy, 0.2, 0.8) };
    const onScreen = project(cam, anchor);
    band = [cam.y + cam.s * rect.y, cam.y + cam.s * (rect.y + rect.h)];
    const curStart = S + camDur * 0.55;
    const A = curStart + moveCursor(onScreen, curStart);
    if (step.kind === "press") {
      badge(keyLabel(step.key), onScreen, A, A + 1.4, "key");
      if (hasFrame(step.frames.after)) showFrame(step.frames.after, A + 0.35);
      R = A + 0.8;
    } else {
      ripple(onScreen, A);
      if (step.kind === "fill") {
        let T0 = A + 0.2;
        if (hasFrame(step.frames.focused)) {
          showFrame(step.frames.focused, A + 0.12, 0.25);
          T0 = A + 0.45;
        }
        const typed = typing(step, rect, T0);
        if (hasFrame(step.frames.after)) showFrame(step.frames.after, typed.end + 0.18, 0.35);
        if (typed.revealed) tl.push(`tl.set("#${typed.id}", { opacity: 0 }, ${at(typed.end + 0.55)});`);
        R = typed.end + 0.55;
        if (step.sensitive) review.push(`- [ ] Step ${n}: the value was hidden while recording (password-like field); the video shows bullets.`);
      } else if (step.kind === "select") {
        badge(`<span class="bdg-dim">▾</span> ${esc(step.value)}`, onScreen, A + 0.1, A + 1.5, "choice");
        if (hasFrame(step.frames.after)) showFrame(step.frames.after, A + 0.5);
        R = A + 0.95;
        review.push(`- [ ] Step ${n}: a native dropdown can't be screenshotted, so the choice is shown as a badge. Replace with a captured open list if the product uses a custom menu.`);
      } else {
        if (hasFrame(step.frames.after)) showFrame(step.frames.after, A + 0.16);
        R = A + 0.6;
      }
    }
  } else if (step.kind === "press") {
    badge(keyLabel(step.key), cursor ?? { x: SW / 2, y: SH / 2 }, S + 0.3, S + 1.7, "key");
    if (hasFrame(step.frames.after)) showFrame(step.frames.after, S + 0.6);
    R = S + 1.1;
  } else if (step.kind === "scroll") {
    // A scroll is real motion: pan the old frame out and the new one in, no cursor click.
    const back = step.frames.before && hasFrame(step.frames.before) ? step.frames.before : visible;
    const dy = (step.scroll?.toY ?? 0) - (step.scroll?.fromY ?? 0);
    const shift = r2(clamp(dy * K, -SH * 0.45, SH * 0.45));
    if (cam.s !== 1) moveCamera({ s: 1, x: 0, y: 0 }, S);
    if (hasFrame(step.frames.after) && step.frames.after !== back) {
      const t0 = S + 0.3;
      tl.push(`tl.to("#frm-${back}", { y: ${-shift}, duration: 0.8, ease: "power2.inOut" }, ${at(t0)});`);
      tl.push(`tl.fromTo("#frm-${step.frames.after}", { y: ${shift}, opacity: 0 }, { y: 0, opacity: 1, duration: 0.8, ease: "power2.inOut" }, ${at(t0)});`);
      tl.push(`tl.set("#frm-${back}", { opacity: 0, y: 0 }, ${at(t0 + 0.8)});`);
      visible = step.frames.after;
      R = t0 + 0.8;
    } else review.push(`- [ ] Step ${n}: scroll without an after-frame; nothing moves on screen.`);
  } else if (step.kind === "navigate") {
    if (cam.s !== 1) moveCamera({ s: 1, x: 0, y: 0 }, S);
    showUrl(step.value ?? step.page.url, S + 0.2);
    if (hasFrame(step.frames.after)) showFrame(step.frames.after, S + 0.35, 0.5);
    R = S + 0.9;
  }
  if (step.navigatesTo) showUrl(step.navigatesTo, R - 0.3);

  const E = r2(Math.max(S + readTime(step), R + (step.emphasis ? 1.6 : 1.0)));
  const pos = caption(step, n, S, E, band);
  beats.push({ step: step.id, n, kind: step.kind, start: r2(S), end: E, caption: step.caption, captionPosition: pos, frames: step.frames });
  storyboard.push({ n, title: step.caption, start: S, dur: E - S, step });
  t = E;
}

// Settle back to the full screen before the end.
if (cam.s !== 1 || cam.x || cam.y) {
  moveCamera({ s: 1, x: 0, y: 0 }, t);
  t += 1.0;
}
if (cursorShown) fadeOut("#cursor", t - 0.32, 0.3);
const END_START = r2(t);
const TOTAL = r2(END_START + (cards ? END_DUR : 0.6));

// ---- Cards ---------------------------------------------------------------------
const stepCount = steps.filter((s) => s.kind !== "chapter").length;
const chapters = steps.filter((s) => s.kind === "chapter").map((s) => s.title || s.caption);
const recap = (chapters.length ? chapters : steps.filter((s) => s.kind !== "chapter" && s.kind !== "scroll").map((s) => s.caption)).slice(0, 6);
let cardHtml = "";
if (cards) {
  cardHtml += `
    <section id="title-card" class="clip card" data-start="0" data-duration="${TITLE_DUR}" data-track-index="2">
      <div id="title-bg" class="card-bg"></div>
      <div id="title-in" class="card-in">
        <div class="card-eyebrow">${esc(hostOf(route.site))}</div>
        <h1 class="card-title">${esc(title)}</h1>
        <div class="card-sub">${stepCount} step${stepCount === 1 ? "" : "s"}${chapters.length ? ` · ${chapters.length} part${chapters.length === 1 ? "" : "s"}` : ""}</div>
      </div>
    </section>
    <section id="end-card" class="clip card" data-start="${END_START}" data-duration="${r2(TOTAL - END_START)}" data-track-index="2">
      <div id="end-bg" class="card-bg" style="opacity:0"></div>
      <div id="end-in" class="card-in" style="opacity:0">
        <div class="card-eyebrow">Recap</div>
        <h2 class="card-title small">${esc(title)}</h2>
        <ol class="recap">${recap.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>
      </div>
    </section>`;
  tl.push(`tl.fromTo("#title-in", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.6, ease: "power3.out" }, 0.15);`);
  tl.push(`tl.to("#title-in", { opacity: 0, y: -12, duration: 0.45, ease: "power2.in" }, ${at(TITLE_DUR - 0.75)});`);
  tl.push(`tl.set("#title-in", { opacity: 0 }, ${at(TITLE_DUR - 0.3)});`);
  fadeOut("#title-bg", TITLE_DUR - 0.52, 0.5, `, ease: "power1.inOut"`);
  tl.push(`tl.fromTo("#end-bg", { opacity: 0 }, { opacity: 1, duration: 0.5, ease: "power1.inOut" }, ${at(END_START)});`);
  tl.push(`tl.fromTo("#end-in", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.55, ease: "power3.out" }, ${at(END_START + 0.15)});`);
}

// ---- Write -------------------------------------------------------------------
const indexHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${FW}, height=${FH}" />
    <title>${esc(title)}</title>
    <script src="${GSAP_URL}"></script>
    <style>
      body { margin: 0; background: #0d0e11; font-family: Inter, -apple-system, "Segoe UI", system-ui, sans-serif; }
      #root { position: relative; width: ${FW}px; height: ${FH}px; overflow: hidden; }
      .clip { position: absolute; inset: 0; }
      .bg { position: absolute; inset: 0; background: radial-gradient(120% 90% at 50% 0%, #23262d 0%, #121317 55%, #0b0c0e 100%); }
      .window { position: absolute; left: ${WX}px; top: ${WY}px; width: ${SW}px; height: ${SH + CHROME}px; border-radius: 14px; overflow: hidden; background: #fff;
        box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 30px 80px rgba(0,0,0,.55), 0 8px 24px rgba(0,0,0,.35); }
      .chrome { position: absolute; left: 0; top: 0; width: 100%; height: ${CHROME}px; background: #1d1f24; display: flex; align-items: center; gap: 14px; padding: 0 16px; box-sizing: border-box; }
      .dots { display: flex; gap: 8px; }
      .dots span { width: 12px; height: 12px; border-radius: 50%; background: #3a3d45; }
      .url { position: relative; flex: 1; height: 28px; border-radius: 8px; background: #2a2d34; overflow: hidden; }
      .url-item { position: absolute; inset: 0; display: flex; align-items: center; gap: 2px; padding: 0 14px; font: 500 15px/1 ui-monospace, "SF Mono", Menlo, monospace; opacity: 0; white-space: nowrap; }
      .url-host { color: #9aa0ab; }
      .url-path { color: #e7e9ee; }
      .viewport { position: absolute; left: 0; top: ${CHROME}px; width: ${SW}px; height: ${SH}px; overflow: hidden; background: #fff; }
      #cam { position: absolute; left: 0; top: 0; width: ${SW}px; height: ${SH}px; transform-origin: 0 0; }
      .frm { position: absolute; left: 0; top: 0; width: ${SW}px; height: ${SH}px; opacity: 0; }
      .tclip { position: absolute; overflow: hidden; opacity: 0; }
      .tcrop { position: absolute; width: ${SW}px; height: ${SH}px; background-size: ${SW}px ${SH}px; background-repeat: no-repeat; }
      .tcover { position: absolute; left: 0; top: 0; overflow: hidden; }
      .fx { position: absolute; left: 0; top: ${CHROME}px; width: ${SW}px; height: ${SH}px; overflow: hidden; pointer-events: none; }
      .ripple { position: absolute; width: 60px; height: 60px; border-radius: 50%; border: 3px solid #ff7a1a; box-sizing: border-box; opacity: 0; }
      .badge { position: absolute; display: flex; align-items: center; gap: 8px; height: 46px; padding: 0 16px; border-radius: 12px; opacity: 0;
        font: 600 22px/1 Inter, -apple-system, system-ui, sans-serif; color: #fff; background: rgba(20,21,25,.92); box-shadow: 0 8px 24px rgba(0,0,0,.35); white-space: nowrap; }
      .badge.key { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
      .bdg-dim { color: #ff9a4d; }
      #cursor { position: absolute; left: 0; top: ${CHROME}px; width: 30px; height: 36px; opacity: 0; }
      #cursor-i { width: 30px; height: 36px; transform-origin: 3px 3px; }
      .caps { position: absolute; left: 0; top: 0; width: ${FW}px; height: ${FH}px; pointer-events: none; }
      .cap-row { position: absolute; left: 0; width: ${FW}px; display: flex; justify-content: center; opacity: 0; }
      .cap-row.bottom { top: ${FH - WY - 150}px; }
      .cap-row.top { top: ${WY + CHROME + 26}px; }
      .cap { max-width: ${Math.round(SW * 0.72)}px; padding: 16px 26px 18px; border-radius: 16px; background: rgba(14,15,18,.9); box-shadow: 0 12px 40px rgba(0,0,0,.4), 0 0 0 1px rgba(255,255,255,.06); }
      .cap-eyebrow { font: 700 15px/1 Inter, -apple-system, system-ui, sans-serif; letter-spacing: .08em; text-transform: uppercase; color: #ff9a4d; margin-bottom: 8px; }
      .cap-text { font: 600 34px/1.25 Inter, -apple-system, system-ui, sans-serif; color: #f5f6f8; text-wrap: balance; }
      .card-bg { position: absolute; inset: 0; background: radial-gradient(120% 90% at 50% 0%, #262930 0%, #121317 60%, #0b0c0e 100%); }
      .card-in { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px; padding: 0 160px; text-align: center; }
      .card-eyebrow, .chapter-eyebrow { font: 700 22px/1 Inter, -apple-system, system-ui, sans-serif; letter-spacing: .12em; text-transform: uppercase; color: #ff9a4d; }
      .card-title { margin: 0; font: 700 92px/1.05 Inter, -apple-system, system-ui, sans-serif; letter-spacing: -.02em; color: #f7f8fa; text-wrap: balance; }
      .card-title.small { font-size: 64px; }
      .card-sub { font: 500 30px/1.3 Inter, -apple-system, system-ui, sans-serif; color: #a7acb7; }
      .recap { margin: 12px 0 0; padding: 0; list-style: none; counter-reset: r; display: flex; flex-direction: column; gap: 14px; text-align: left; }
      .recap li { counter-increment: r; display: flex; gap: 16px; align-items: baseline; font: 500 30px/1.3 Inter, -apple-system, system-ui, sans-serif; color: #dfe2e8; }
      .recap li::before { content: counter(r); font-weight: 700; color: #ff9a4d; min-width: 28px; }
      .chapter-in { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px; }
      .chapter-title { font: 700 76px/1.1 Inter, -apple-system, system-ui, sans-serif; color: #f7f8fa; letter-spacing: -.02em; text-align: center; padding: 0 160px; text-wrap: balance; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="walkthrough" data-start="0" data-width="${FW}" data-height="${FH}" data-duration="${TOTAL}">
      <section id="stage" class="clip" data-start="0" data-duration="${TOTAL}" data-track-index="1">
        <div class="bg"></div>
        <div class="window">
          <div class="chrome"><div class="dots"><span></span><span></span><span></span></div><div class="url">
            ${html.urls.join("\n            ")}
          </div></div>
          <div class="viewport" data-layout-allow-overflow>
            <div id="cam">
              ${html.frames.join("\n              ")}
              ${html.cam.join("\n              ")}
            </div>
          </div>
          <div class="fx" data-layout-allow-overflow>
            ${html.fx.join("\n            ")}
          </div>
          <div id="cursor"><div id="cursor-i"><svg viewBox="0 0 30 36" width="30" height="36"><path d="M3 3v24.5l6.4-6.1 4.4 9.6 4.2-1.9-4.3-9.4h8.9z" fill="#111" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/></svg></div></div>
        </div>
        <div class="caps">
          ${html.caps.join("\n          ")}
        </div>
      </section>${cardHtml}
      ${html.chapters.join("\n      ")}
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      ${tl.join("\n      ")}
      window.__timelines["walkthrough"] = tl;
    </script>
  </body>
</html>
`;
writeFileSync(join(outDir, "index.html"), indexHtml);
writeFileSync(join(outDir, "route.json"), JSON.stringify({ ...route, frames: Object.fromEntries(Object.entries(route.frames).map(([k, f]) => [k, { ...f, dataUrl: undefined, file: frameSrc[k] }])) }, null, 2));
writeFileSync(join(outDir, "timeline.json"), JSON.stringify({ duration: TOTAL, title: TITLE_DUR, endCard: cards ? END_START : null, beats }, null, 2));

const sb = [
  "---",
  `format: ${FW}x${FH}`,
  `duration: ${Math.round(TOTAL)}s`,
  `message: ${JSON.stringify(title)}`,
  "arc: title → steps → recap",
  "---",
  "",
  `Generated by route-to-hyperframes from ${basename(routePath)} (${route.site}). Edit captions in Agent Markup or route.json and regenerate; timings are computed.`,
  "",
];
storyboard.forEach((b, i) => {
  const s = b.step;
  sb.push(`## Frame ${i + 1} — ${b.title}`, `- status: animated`, `- duration: ${r2(b.dur)}s`, `- start: ${r2(b.start)}s`, `- scene: ${b.title}`);
  if (s.kind !== "chapter") {
    sb.push(`- voiceover: ${s.note || s.caption}`, `- action: ${s.kind}${s.target ? ` ${s.target.role} “${s.target.name || s.target.label}” (\`${s.target.selector}\`)` : ""}`);
    if (s.value !== undefined && !s.sensitive) sb.push(`- value: ${s.value}`);
    if (s.key) sb.push(`- key: ${s.key}`);
    sb.push(`- page: ${pathOf(s.page.url)}`, `- frames: ${["before", "focused", "after"].filter((k) => s.frames[k]).map((k) => `${k}=${s.frames[k]}`).join(", ") || "none"}`);
  }
  sb.push("");
});
writeFileSync(join(outDir, "STORYBOARD.md"), sb.join("\n"));

writeFileSync(
  join(outDir, "REVIEW.md"),
  [
    `# Review: ${title}`,
    "",
    `${stepCount} steps, ${r2(TOTAL)}s. Resolve or accept each item before rendering. Anything marked "re-film" is a missing capture, not a rendering problem: use scripts/replay-route.mjs rather than painting the state in.`,
    "",
    ...(review.length ? review : ["Nothing to review: every step has its frames and every change has a cause on screen."]),
    "",
  ].join("\n"),
);

if (!existsSync(join(outDir, "package.json")))
  writeFileSync(
    join(outDir, "package.json"),
    JSON.stringify(
      {
        name: basename(outDir).toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
        private: true,
        type: "module",
        scripts: Object.fromEntries(["preview", "check", "render"].map((c) => [c === "preview" ? "dev" : c, `npx --yes hyperframes@${HYPERFRAMES_VERSION} ${c}`])),
      },
      null,
      2,
    ),
  );
if (!existsSync(join(outDir, "hyperframes.json")))
  writeFileSync(
    join(outDir, "hyperframes.json"),
    JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, authoringSkill: "general-video" }, null, 2),
  );

console.log(`${outDir}\n  ${stepCount} steps · ${r2(TOTAL)}s · ${usedFrames.size} frames · zoom cap ${r2(ZOOM_CAP)}x · ${review.length} review item${review.length === 1 ? "" : "s"}`);
console.log(`  next: cd ${outDir} && npx hyperframes check && npx hyperframes preview`);
