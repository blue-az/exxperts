#!/usr/bin/env node
// One-command packaged install: build → pack → npm install -g <exact tarball>.
//
//   npm run install:global
//
// Exists so the packaged install is a single command on every platform — the
// manual `npm install -g ./exxeta-exxperts-app-*.tgz` relies on shell glob
// expansion, which PowerShell/cmd don't do. Manual steps stay documented in
// docs/packaging-local.md.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// npm is npm.cmd on Windows; a shell is required to spawn it there.
const shell = process.platform === "win32";

function run(args, opts = {}) {
	const res = spawnSync("npm", args, { cwd: root, stdio: "inherit", shell, ...opts });
	if (res.status !== 0) process.exit(res.status ?? 1);
	return res;
}

console.log("[exxperts] building…");
run(["run", "build"]);

console.log("[exxperts] packing…");
const pack = spawnSync("npm", ["pack", "--json"], { cwd: root, encoding: "utf8", shell });
if (pack.status !== 0) {
	process.stderr.write(pack.stderr ?? "");
	process.exit(pack.status ?? 1);
}
const filename = JSON.parse(pack.stdout)[0]?.filename;
if (!filename) {
	console.error("[exxperts] npm pack did not report a tarball filename");
	process.exit(1);
}

// Replacing a large installed tree in place hits npm ENOTEMPTY/tar races on
// Windows; uninstalling first is reliable there and harmless elsewhere.
console.log("[exxperts] removing any previous global install…");
spawnSync("npm", ["uninstall", "-g", "@exxeta/exxperts-app"], { cwd: root, stdio: "inherit", shell });

console.log(`[exxperts] installing ${filename} globally…`);
run(["install", "-g", path.join(root, filename)]);

console.log("[exxperts] done — run: exxperts web  (web app)  or: exxperts cli  (CLI/TUI)");
