// Manual self-test for the HTML render loop.
// Renders a 3-slide reference-style deck (style taken from a .pptx) to PNGs you can open.
//
//   node scripts/try-html-preview.mjs "/path/to/reference.pptx"
//
// Output: ./html-preview-out/slide-1.png ... open them to see the result.
// Needs Playwright + Chromium locally: `npm i playwright && npx playwright install chromium`.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const pptx = process.argv[2];
if (!pptx || !fs.existsSync(pptx)) {
	console.error("Usage: node scripts/try-html-preview.mjs \"/path/to/reference.pptx\"");
	process.exit(1);
}

// Keep Playwright pointed at the real browser cache even though we sandbox the home dir for isolation.
const realHome = os.homedir();
process.env.PLAYWRIGHT_BROWSERS_PATH =
	process.platform === "win32"
		? path.join(realHome, "AppData", "Local", "ms-playwright")
		: process.platform === "darwin"
			? path.join(realHome, "Library", "Caches", "ms-playwright")
			: path.join(realHome, ".cache", "ms-playwright");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-tryhtml-"));
// os.homedir() reads HOME on POSIX and USERPROFILE on Windows — set both.
process.env.HOME = home;
process.env.USERPROFILE = home;
const refsDir = path.join(home, ".exxperts", "app", "artifacts", "refs");
fs.mkdirSync(refsDir, { recursive: true });
fs.copyFileSync(pptx, path.join(refsDir, "reference.pptx"));

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(path.join(repoRoot, "pi-package/extensions/artifacts/index.ts"));
const tools = new Map();
mod.default({ registerTool(t) { tools.set(t.name, t); } });
const renderTool = tools.get("artifact_deck_workbench_render_reference_html_images");

const blank = mod.createBlankDeckWorkbench({ title: "Preview test", slideCount: 3, structurePreset: "executive" });
await mod.attachDeckWorkbenchFormatReference({ workbenchId: blank.workbenchId, filename: "reference.pptx", folder: "refs" });
const ctx = mod.getDeckWorkbenchReferenceHtmlContext({ workbenchId: blank.workbenchId });
console.log(`Reference fonts extracted: ${ctx.referenceFonts.join(", ")}`);

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sections = ctx.slides.map((s, i) => `
  <section class="slide"><div class="kicker">Slide ${i + 1}</div><h1>${esc(s.title)}</h1>
  ${s.keyMessage ? `<p class="lead">${esc(s.keyMessage)}</p>` : ""}
  <ul>${(s.bullets || []).map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
  <div class="footer">Approximate reference-style preview — fonts render only if installed locally.</div></section>`).join("");
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body,.slide,h1,p,li,.kicker,.footer{font-family:${ctx.recommendedFontStack}}
  .slide{width:1280px;height:720px;position:relative;overflow:hidden;background:#0c0d10;color:#f4f4f5;padding:80px;display:flex;flex-direction:column;justify-content:center}
  .kicker{font-size:17px;letter-spacing:4px;text-transform:uppercase;color:#f59e0b;margin-bottom:20px}
  h1{font-size:64px;line-height:1.05;font-weight:700;letter-spacing:-1px}
  .lead{font-size:26px;color:#c7c7cc;margin-top:28px;max-width:900px;line-height:1.45}
  ul{list-style:none;margin-top:28px} li{font-size:24px;padding:12px 0;border-bottom:1px solid #26262b}
  .footer{position:absolute;bottom:30px;left:80px;font-size:13px;color:#5b5b60;letter-spacing:2px;text-transform:uppercase}
</style></head><body>${sections}</body></html>`;

const result = await renderTool.execute("try-1", { workbenchId: blank.workbenchId, html });
if (result.isError) {
	console.error("\nNOT RENDERED:", result.content.find((c) => c.type === "text")?.text);
	fs.rmSync(home, { recursive: true, force: true });
	process.exit(2);
}
const outDir = path.join(repoRoot, "html-preview-out");
fs.mkdirSync(outDir, { recursive: true });
result.content.filter((c) => c.type === "image").forEach((img, i) => {
	fs.writeFileSync(path.join(outDir, `slide-${i + 1}.png`), Buffer.from(img.data, "base64"));
});
fs.rmSync(home, { recursive: true, force: true });
console.log(`\nRendered ${result.details.renderedCount} slide(s). Open: ${outDir}/slide-1.png`);
