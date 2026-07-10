#!/usr/bin/env node
// Environment check for a fresh exxperts clone: verifies the things that
// actually bite new setups and prints the fix for anything missing.
//
//   npm run doctor
//
// Runs with plain node so it works even when `npm install` has not completed —
// every check degrades to a ✗ with instructions instead of crashing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "package.json"));

let failures = 0;
let warnings = 0;
const ok = (label, detail = "") => console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
const bad = (label, fix) => {
	failures++;
	console.log(`  ✗ ${label}`);
	if (fix) console.log(`      fix: ${fix}`);
};
const warn = (label, hint) => {
	warnings++;
	console.log(`  ! ${label}`);
	if (hint) console.log(`      ${hint}`);
};

console.log("exxperts doctor\n");

// fetch failures wrap the interesting code one or two levels deep (TypeError →
// cause, which is an AggregateError when a host resolves to several addresses).
const fetchErrorCode = (e) => e.cause?.code ?? e.cause?.errors?.[0]?.code ?? e.code ?? e.cause?.message ?? e.name;

const isWindows = process.platform === "win32";
const searxngStartHint = isWindows
	? "install Docker Desktop, then run `node scripts\\searxng.mjs start` (see docs/web-search.md)"
	: "run `./scripts/searxng start` (needs Docker/Podman)";

// --- Node version -----------------------------------------------------------
{
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
	const required = String(pkg.engines?.node ?? ">=20.6.0").replace(/[^\d.]/g, "");
	const [reqMajor, reqMinor = 0] = required.split(".").map(Number);
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major > reqMajor || (major === reqMajor && minor >= reqMinor)) {
		ok(`Node ${process.version}`, `requires >=${required}`);
	} else {
		bad(`Node ${process.version} is older than the required >=${required}`, "install a newer Node (https://nodejs.org) and re-run npm install");
	}
}

// --- Git Bash (Windows only: the agent's shell tool runs through bash.exe) -----
if (isWindows) {
	const candidates = [
		process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"),
		process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"),
	].filter(Boolean);
	let bashPath = candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
	if (!bashPath) {
		for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
			if (dir && fs.existsSync(path.join(dir, "bash.exe"))) {
				bashPath = path.join(dir, "bash.exe");
				break;
			}
		}
	}
	if (bashPath) {
		ok("Git Bash found (agent shell)", bashPath);
	} else {
		bad(
			"Git Bash not found — the agent cannot run shell commands on Windows",
			"install Git for Windows (https://gitforwindows.org) with the default install path",
		);
	}
}

// --- Dependencies installed ---------------------------------------------------
let depsInstalled = true;
{
	const probes = ["undici", "jsdom", "typebox", "tsx"];
	const missing = probes.filter((name) => {
		try {
			require.resolve(name);
			return false;
		} catch {
			return true;
		}
	});
	if (missing.length === 0) {
		ok("npm dependencies installed");
	} else {
		depsInstalled = false;
		bad(`npm dependencies missing (${missing.join(", ")})`, "run `npm install` from the repo root");
	}
}

// --- Runtime built ------------------------------------------------------------
{
	const cliDist = path.join(root, "runtime", "packages", "coding-agent", "dist", "cli.js");
	if (fs.existsSync(cliDist)) {
		ok("runtime built (runtime/packages/coding-agent/dist)");
	} else {
		bad("runtime not built — the server and CLI will not start", "run `npm run build` from the repo root");
	}
}

// --- Headless Chromium (fetch_url JS rendering + deck visual review) ----------
{
	let found = false;
	if (depsInstalled) {
		try {
			const { chromium } = require("playwright");
			const exe = chromium.executablePath();
			found = Boolean(exe) && fs.existsSync(exe);
		} catch {
			found = false;
		}
	}
	if (found) {
		ok("headless Chromium installed (JS-rendered pages, HTML deck review)");
	} else {
		warn(
			"headless Chromium not installed — fetch_url cannot render JavaScript-heavy pages and HTML decks skip visual review",
			"optional: run `npx playwright install chromium` from the repo root (~150 MB, one time)",
		);
	}
}

// --- Web search (optional) -----------------------------------------------------
{
	let provider = String(process.env.EXXETA_SEARCH_PROVIDER ?? "").trim();
	let baseUrl = String(process.env.EXXETA_SEARCH_BASE_URL ?? "").trim();
	try {
		const shared = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".exxperts", "app", "web-search.json"), "utf-8"));
		provider = provider || String(shared.provider ?? "");
		baseUrl = baseUrl || String(shared.baseUrl ?? "");
	} catch {
		// unconfigured is a valid state
	}
	if (provider !== "searxng") {
		warn("web search not configured — rooms cannot search the web", `optional: ${searxngStartHint}`);
	} else {
		try {
			const res = await fetch(new URL("/search?q=ping&format=json", baseUrl), { signal: AbortSignal.timeout(5000) });
			if (res.ok) ok("web search (SearXNG) reachable", baseUrl);
			else bad(`SearXNG at ${baseUrl} answered HTTP ${res.status}`, `${searxngStartHint} and make sure the container engine is running`);
		} catch (e) {
			bad(`SearXNG configured but not reachable at ${baseUrl} (${fetchErrorCode(e)})`, `${searxngStartHint} and make sure the container engine is running`);
		}
	}
}

// --- Outbound fetch sanity (proxy / TLS-inspection corruption) -----------------
{
	const looksGarbled = (text) => {
		const sample = text.slice(0, 4000);
		if (sample.length < 64) return false;
		let junk = 0;
		for (const ch of sample) {
			const code = ch.codePointAt(0) ?? 0;
			if (ch === "�" || (code < 32 && code !== 9 && code !== 10 && code !== 13)) junk++;
		}
		return junk / sample.length > 0.1;
	};
	try {
		const res = await fetch("https://example.com/", {
			headers: { "accept-encoding": "gzip, deflate, br" },
			signal: AbortSignal.timeout(10_000),
		});
		const text = await res.text();
		if (!res.ok) {
			warn(`outbound fetch check: https://example.com answered HTTP ${res.status}`);
		} else if (looksGarbled(text) || !/<html/i.test(text)) {
			bad(
				"outbound web responses come back corrupted — a proxy or TLS-inspection layer on this network is likely mangling compressed responses",
				"try off VPN / a different network, or ask IT about the TLS-inspection proxy; the headless-browser fallback may work around it",
			);
		} else {
			ok("outbound web fetch decodes cleanly");
		}
	} catch (e) {
		bad(`outbound web fetch failed (${fetchErrorCode(e)}) — rooms cannot reach the internet`, "check your network/proxy settings");
	}
}

// --- MCP config (optional) ------------------------------------------------------
{
	const files = [
		path.join(os.homedir(), ".config", "mcp", "mcp.json"),
		path.join(os.homedir(), ".exxperts", "agent", "mcp.json"),
		path.join(process.cwd(), ".mcp.json"),
	];
	const servers = new Set();
	for (const file of files) {
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
			for (const name of Object.keys(parsed.mcpServers ?? parsed.servers ?? {})) servers.add(name);
		} catch {
			// missing or malformed files are fine — MCP is optional
		}
	}
	if (servers.size > 0) ok(`MCP servers configured (${[...servers].join(", ")})`);
	else warn("no MCP servers configured — rooms have no external connectors", "optional: see docs/mcp.md");
}

console.log("");
if (failures > 0) {
	console.log(`${failures} problem(s) found${warnings ? `, ${warnings} optional feature(s) not set up` : ""}.`);
	// Not process.exit(): a hard exit races undici's handle teardown after a
	// failed fetch and crashes libuv on Windows (UV_HANDLE_CLOSING assertion).
	process.exitCode = 1;
} else {
	console.log(`All required checks passed${warnings ? ` (${warnings} optional feature(s) not set up)` : ""}.`);
}
