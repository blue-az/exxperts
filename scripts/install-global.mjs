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
import fs from "node:fs";
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

// Fail fast when the final `npm install -g` would need sudo (system-wide Node
// installs own /usr/local), BEFORE minutes of building. Guides to the
// supported fix instead of letting people reach for sudo, which runs build
// scripts as root and leaves root-owned files in the clone.
if (process.platform !== "win32") {
	const prefixRes = spawnSync("npm", ["config", "get", "prefix"], { cwd: root, encoding: "utf8", shell });
	const prefix = prefixRes.status === 0 ? prefixRes.stdout.trim() : "";
	if (prefix) {
		const probe = [path.join(prefix, "lib", "node_modules"), path.join(prefix, "lib"), prefix].find((p) => fs.existsSync(p));
		let writable = true;
		if (probe) {
			try { fs.accessSync(probe, fs.constants.W_OK); } catch { writable = false; }
		}
		if (!writable) {
			console.error(`[exxperts] npm's global prefix (${prefix}) is not writable by your user, so the
[exxperts] final "npm install -g" step would fail with EACCES. Please do NOT
[exxperts] rerun with sudo: that runs build scripts as root and leaves
[exxperts] root-owned files in this clone that break future updates.
[exxperts]
[exxperts] One-time fix — switch npm to a user-level prefix:
[exxperts]
[exxperts]   mkdir -p ~/.npm-global
[exxperts]   npm config set prefix ~/.npm-global
[exxperts]   echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
[exxperts]   source ~/.zshrc          # bash: use ~/.bashrc or ~/.bash_profile
[exxperts]   npm run install:global
[exxperts]
[exxperts] Details: docs/packaging-local.md`);
			process.exit(1);
		}
	}
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
