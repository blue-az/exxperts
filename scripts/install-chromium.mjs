// Best-effort browser fetch for Content Producer's visual deck review.
//
// Content Producer authors bespoke HTML decks and then renders them with a headless Chromium
// (via Playwright) so a vision-capable model can actually look at the output and revise it before
// you ever see a preview. The Chromium binary is a separate ~150 MB download that `npm install`
// does not pull on its own, so we fetch it here after install.
//
// This is intentionally NON-FATAL: if the download can't run (offline, corporate proxy, CI,
// `--ignore-scripts`, Playwright not installed), we never fail `npm install`. HTML decks still work
// without it — Content Producer just skips the visual-critique pass — and the browser can be
// fetched later with `npx playwright install chromium`.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

function skip(reason) {
	console.warn("");
	console.warn(`[exxperts] ${reason}`);
	console.warn("[exxperts] HTML decks still work; Content Producer just skips the visual-critique pass.");
	console.warn("[exxperts] To enable it later, run:  npx playwright install chromium");
	console.warn("");
	process.exit(0); // never block setup
}

// `npm install --ignore-scripts`, CI, or anyone who just wants a fast install can opt out.
if (process.env.EXXETA_SKIP_BROWSER_INSTALL === "1") {
	console.log("[exxperts] EXXETA_SKIP_BROWSER_INSTALL=1 — skipping Chromium download.");
	process.exit(0);
}

// Resolve Playwright's CLI by file path rather than relying on `playwright` being on PATH
// (it is only on PATH during npm lifecycle scripts, not when this file is run directly).
const require = createRequire(import.meta.url);
let cli;
for (const pkg of ["playwright", "playwright-core"]) {
	try {
		const candidate = join(dirname(require.resolve(`${pkg}/package.json`)), "cli.js");
		if (existsSync(candidate)) { cli = candidate; break; }
	} catch { /* not installed under this name — try the next */ }
}
if (!cli) skip("Playwright is not installed, so Chromium can't be fetched.");

console.log("[exxperts] Fetching headless Chromium for Content Producer's visual deck review (one-time, ~150 MB)…");
const result = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });

if (result.error || result.status !== 0) {
	skip("Could not download Chromium right now — that's OK.");
}

process.exit(0);
