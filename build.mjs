// Bundles the extension into dist/ (or dist-test/ with --test, which adds
// <all_urls> host access so the e2e suite can inject without a toolbar click).
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { makeIcon } from "./scripts/icon.mjs";

const test = process.argv.includes("--test");
const watch = process.argv.includes("--watch");
const outdir = test ? "dist-test" : "dist";

rmSync(outdir, { recursive: true, force: true });
mkdirSync(`${outdir}/icons`, { recursive: true });

const manifest = JSON.parse(readFileSync("src/manifest.json", "utf8"));
if (test) manifest.host_permissions = ["<all_urls>"];
writeFileSync(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2));
for (const size of [16, 32, 48, 128]) writeFileSync(`${outdir}/icons/icon${size}.png`, makeIcon(size));
cpSync("src/options.html", `${outdir}/options.html`);

const options = {
  entryPoints: { background: "src/background.ts", content: "src/content/index.ts", options: "src/options.ts" },
  outdir,
  bundle: true,
  format: "iife",
  target: "chrome114",
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  // Test builds use an open shadow root so the e2e suite can reach the UI.
  // Test builds talk to a different receiver port, so a suite never drops reviews into the real inbox.
  define: { __SHADOW_MODE__: JSON.stringify(test ? "open" : "closed"), __RECEIVER__: JSON.stringify(test ? "http://127.0.0.1:47899" : "http://127.0.0.1:47800") },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
