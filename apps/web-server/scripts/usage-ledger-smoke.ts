import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-usage-ledger-"));
const tempHome = path.join(tmp, "home");
fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");

try {
	const { appendUsage, loadUsage } = await import("../src/usage-log.js");
	const { importHistoricalSessionUsage } = await import("../src/usage-import.js");
	const { modelGroupOf, registerUsageApi } = await import("../src/usage-api.js");

	// --- canonical model grouping (spec: model-names.ts) merges raw-id variants
	assert(modelGroupOf({ model: "claude-opus-4-8" }).key === modelGroupOf({ model: "claude-opus-4.8" }).key, "raw-id variants share a group");
	assert(modelGroupOf({ model: "claude-opus-4-8" }).name === "Claude Opus 4.8", "group renders the canonical name");
	assert(modelGroupOf({ model: "gpt-5.5" }).key === modelGroupOf({ model: "gpt-5.5", modelLabel: "ChatGPT Plus/Pro — GPT-5.5" }).key, "label eras share a group");

	// --- ledger append + chronological load --------------------------------
	const now = Date.now();
	const day = 24 * 3600 * 1000;
	appendUsage({ ts: now - day, agent: "room-a", persona: "business", model: "gpt-5.5", modelLabel: "ChatGPT Plus/Pro — GPT-5.5", input: 100, output: 10, cacheRead: 50, cacheWrite: 0, cost: 0.01 });
	appendUsage({ ts: now, agent: "room-a", persona: "business", model: "claude-opus-4-8", provider: "anthropic", authType: "api_key", kind: "scheduled", input: 200, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.02 });
	appendUsage({ ts: now - 10 * day, agent: "room-a", persona: "business", model: "gpt-5.5", input: 300, output: 30, cacheRead: 0, cacheWrite: 0, cost: 0.03 });
	const loaded = loadUsage();
	assert(loaded.length === 3, "three rows persisted");
	assert(loaded[0].ts <= loaded[1].ts && loaded[1].ts <= loaded[2].ts, "loadUsage restores chronological order");

	// --- historical import: dedupe, kind mapping, idempotence --------------
	const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
	const sessionsDir = path.join(agentsRoot, "room-a", "runtime", "pi-sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });
	const iso = (t: number) => new Date(t).toISOString();
	// One assistant message matching an existing ledger row (100/10/50): must be skipped.
	// One unmatched message in a cli thread: must import with kind "cli".
	fs.writeFileSync(
		path.join(sessionsDir, "c_thread1.jsonl"),
		[
			JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: iso(now - day), cwd: "/tmp" }),
			JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: iso(now - day), provider: "openai-codex", modelId: "gpt-5.5" }),
			JSON.stringify({ id: "a1", parentId: "m1", timestamp: iso(now - day + 1000), message: { role: "assistant", usage: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0, cost: { total: 0.01 } } } }),
		].join("\n") + "\n",
	);
	fs.writeFileSync(
		path.join(sessionsDir, "cli_thread2.jsonl"),
		[
			JSON.stringify({ type: "session", version: 3, id: "s2", timestamp: iso(now - 2 * day), cwd: "/tmp" }),
			JSON.stringify({ type: "model_change", id: "m2", parentId: null, timestamp: iso(now - 2 * day), provider: "openai-codex", modelId: "gpt-5.5" }),
			JSON.stringify({ id: "a2", parentId: "m2", timestamp: iso(now - 2 * day + 1000), message: { role: "assistant", usage: { input: 777, output: 66, cacheRead: 5, cacheWrite: 0, cost: { total: 0.055 } } } }),
		].join("\n") + "\n",
	);
	const summary = importHistoricalSessionUsage(agentsRoot, () => {});
	assert(summary !== null && summary.rows === 1, `reconcile recovers exactly the unmatched turn (got ${summary?.rows})`);
	const afterImport = loadUsage();
	assert(afterImport.length === 4, "one recovered row appended");
	const imported = afterImport.find((r) => r.input === 777);
	assert(imported?.kind === "cli", "cli thread imports as kind cli");
	assert(imported?.provider === "openai-codex", "import carries the thread's provider");
	const rerun = importHistoricalSessionUsage(agentsRoot, () => {});
	assert(rerun !== null && rerun.rows === 0, "re-running reconciliation imports nothing (dedupe)");
	assert(loadUsage().length === 4, "no rows duplicated by a re-run");

	// A truncated append must cost one row, not blank the ledger.
	const ledgerFile = path.join(tempHome, ".exxperts", "app", "usage.jsonl");
	fs.appendFileSync(ledgerFile, '{"ts":123,"agent":"room-a","persona":"business","inp');
	assert(loadUsage().length === 4, "damaged trailing line is skipped, ledger stays readable");
	fs.appendFileSync(ledgerFile, "\n");

	// --- /api/usage aggregation over the ledger ----------------------------
	const handlers = new Map<string, (req: unknown, reply?: unknown) => Promise<any>>();
	const fakeApp = { get: (route: string, handler: (req: unknown, reply?: unknown) => Promise<any>) => handlers.set(route, handler) };
	registerUsageApi(fakeApp as any, {
		findModel: (provider, modelId) =>
			provider === "openai-codex" && modelGroupOf({ model: modelId }).key === "gpt-5.5" ? { cost: { input: 5, cacheRead: 0.5 } } : undefined,
		liveAgents: () => new Map([["room-a", "Room A"]]),
	});
	const usage = await handlers.get("/api/usage")!({ query: {} });
	assert(usage.totals.turns === 4, "all rows aggregated");
	assert(usage.totals.cost.billed > 0.019 && usage.totals.cost.billed < 0.021, "api_key row counts as billed");
	// Labeled ChatGPT row + imported openai-codex row are plan (OAuth-only channel).
	assert(Math.abs(usage.totals.cost.plan - 0.065) < 1e-9, `plan split (got ${usage.totals.cost.plan})`);
	assert(Math.abs(usage.totals.cost.unattributed - 0.03) < 1e-9, "label-less row stays unattributed");
	assert(usage.totals.cacheSavedEst > 0, "cache savings estimated where prices are known");
	const gpt = usage.byModel.find((m: any) => m.id === "gpt-5.5");
	assert(gpt && gpt.turns === 3, "canonical model group spans eras");
	const roomA = usage.byAgent.find((a: any) => a.agent === "room-a");
	assert(roomA && roomA.retired === false, "live room not marked retired");
	assert(usage.agentNames["room-a"] === "Room A", "live room display name exposed for the Wallet");
	assert(roomA.kinds.cli?.turns === 1 && roomA.kinds.scheduled?.turns === 1, "kind split per agent");
	assert(Array.isArray(usage.weekHour) && usage.weekHour.length === 7 && usage.weekHour[0].length === 24, "weekHour matrix shape");
	assert(usage.recent.length === 4 && usage.recent[0].ts >= usage.recent[3].ts, "recent newest first");

	const scoped = await handlers.get("/api/usage")!({ query: { range: "7d", model: "gpt-5.5" } });
	assert(scoped.previous !== null, "bounded range returns a previous window");
	assert(scoped.totals.turns === 2, "range+model scoping applies (7d gpt-5.5)");

	// --- CSV export ---------------------------------------------------------
	const replyHeaders: Record<string, string> = {};
	const csv = await handlers.get("/api/usage/export.csv")!({}, { header: (k: string, v: string) => { replyHeaders[k] = v; } });
	const lines = String(csv).trim().split("\n");
	assert(lines.length === 5 && lines[0].startsWith("ts,iso,agent"), "csv has header plus one line per row");
	assert(replyHeaders["content-disposition"]?.includes("exxperts-usage.csv"), "csv download disposition");

	console.log("usage ledger smoke passed");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
