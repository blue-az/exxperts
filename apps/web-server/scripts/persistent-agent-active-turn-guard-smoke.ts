import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-agent-active-turn-guard-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-agent-active-turn-guard-cwd-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	createPersistentAgentFromScaffoldInput,
	beginPersistentAgentTurn,
	buildCheckpointProposal,
	buildPersistentAgentCheckpointTranscriptSource,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	finishPersistentAgentTurn,
	getPersistentAgentActiveTurnState,
	getPersistentAgentStatus,
	openPersistentAgentPiSessionManager,
	parseCheckpointApprovalRequest,
	writeApprovedCheckpoint,
	writePersistentAgentMementoBoundary,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");

const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
writePersistentAgentAiProfileState("openai-compatible");

const agentId = "active-turn-smoke-room";
const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function expectRejects(fn: () => Promise<unknown>, expected: RegExp, label: string): Promise<void> {
	try {
		await fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const statusCode = (error as any)?.statusCode;
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		assert(statusCode === 409 || statusCode == null, `${label}: expected optional 409 status, got ${statusCode}`);
		return;
	}
	throw new Error(`${label}: expected rejection`);
}

function expectThrows(fn: () => unknown, expected: RegExp, label: string): void {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const statusCode = (error as any)?.statusCode;
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		assert(statusCode === 409 || statusCode == null, `${label}: expected optional 409 status, got ${statusCode}`);
		return;
	}
	throw new Error(`${label}: expected error`);
}

function approvedRecentContext(): string {
	return `### RC-DRAFT | CLOSED | 2026-06-15 | Active turn guard smoke\n\n**Session arc:** A synthetic active-turn guard smoke verified runtime boundary protection.\n\n**Body:**\n- Running and cancelling turns blocked checkpoint and Memento boundaries.\n\n**Parked:**\nNone\n`;
}

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Active Turn Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	const threadId = "active_turn_guard_0001";
	const write = writePersistentAgentThread(agentId, threadId, {
		state: "active",
		origin: "home",
		model,
		items: [{ kind: "user", id: "display-user", text: "Synthetic active-turn guard display item." }],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }),
	});
	assert(write.thread.runtime.kind === "pi-session-jsonl", "fixture should be Pi-backed");
	const session = openPersistentAgentPiSessionManager(agentId, write.thread.runtime, tempCwd);
	session.appendMessage({ role: "user", content: "Synthetic checkpointable user message.", timestamp: Date.now() });

	const l1b = fs.readFileSync(path.join(root, agentId, "L1b", "current.md"), "utf-8");
	const source = buildPersistentAgentCheckpointTranscriptSource({ agentId, conversationId: threadId, l1b, runtimeCwd: tempCwd }).source;
	const parsedApproval = parseCheckpointApprovalRequest({
		conversationId: threadId,
		model,
		density: "compact",
		proposal: {
			agentId,
			conversationId: threadId,
			sessionId: null,
			writesMemory: false,
			density: "compact",
			process: { model },
			source,
			proposedRecentContext: approvedRecentContext(),
		},
		approvedRecentContext: approvedRecentContext(),
	}, agentId);

	const running = beginPersistentAgentTurn(agentId, threadId, { turnId: "turn_active_guard_running", connectionId: "ws_active_guard" });
	assert(running.state === "running", "begin should mark turn running");
	let status = getPersistentAgentStatus(agentId);
	assert(status.activeThread?.threadId === threadId, "status should expose fixture activeThread");
	assert(status.activeThread.inFlight === true, "status should mark running thread in-flight");
	assert(status.activeThread.working === true, "status should mark running thread working");
	assert(status.activeThread.cancelling === false, "status should not mark running thread cancelling");

	await expectRejects(
		() => buildCheckpointProposal({ agentId, conversationId: threadId, model, density: "compact", runtimeCwd: tempCwd }, async () => ({ text: "TITLE:\nShould not run\n\nSESSION_ARC:\nNo-op\n\nBODY:\nNo-op\n\nPARKED:\nNone\n" })),
		/still running|cancelling|activeThread/i,
		"running turn should block checkpoint proposal",
	);
	expectThrows(
		() => writeApprovedCheckpoint(parsedApproval.request, parsedApproval.warnings, new Date("2026-06-15T12:00:00.000Z"), { runtimeCwd: tempCwd }),
		/still running|cancelling|activeThread/i,
		"running turn should block checkpoint approval",
	);
	expectThrows(
		() => writePersistentAgentMementoBoundary(agentId, threadId, new Date("2026-06-15T12:01:00.000Z"), { runtimeCwd: tempCwd }),
		/still running|cancelling|activeThread/i,
		"running turn should block Memento",
	);

	finishPersistentAgentTurn(agentId, threadId, { turnId: running.turnId, terminalReason: "completed" });
	assert(getPersistentAgentActiveTurnState(agentId, threadId).state === "idle", "finish should clear running state");
	status = getPersistentAgentStatus(agentId);
	assert(status.activeThread?.inFlight === false, "status should clear in-flight after finish");
	assert(status.activeThread.activeTurn.lastTerminalReason === "completed", "status should expose safe terminal reason");

	const cancelling = beginPersistentAgentTurn(agentId, threadId, { turnId: "turn_active_guard_cancelling", connectionId: "ws_active_guard" });
	assert(cancelling.state === "running", "second begin should mark running");
	const { markPersistentAgentTurnCancelling } = await import("../src/persistent-agents.js");
	markPersistentAgentTurnCancelling(agentId, threadId, "cancelled");
	status = getPersistentAgentStatus(agentId);
	assert(status.activeThread?.inFlight === true, "status should keep cancelling thread in-flight");
	assert(status.activeThread.working === false, "status should not mark cancelling thread working");
	assert(status.activeThread.cancelling === true, "status should expose cancelling state");
	expectThrows(
		() => beginPersistentAgentTurn(agentId, threadId, { turnId: "turn_active_guard_duplicate", connectionId: "ws_active_guard" }),
		/cancelling|still running|activeThread/i,
		"cancelling turn should block a duplicate prompt begin",
	);
	await expectRejects(
		() => buildCheckpointProposal({ agentId, conversationId: threadId, model, density: "compact", runtimeCwd: tempCwd }, async () => ({ text: "TITLE:\nShould not run\n\nSESSION_ARC:\nNo-op\n\nBODY:\nNo-op\n\nPARKED:\nNone\n" })),
		/cancelling|still running|activeThread/i,
		"cancelling turn should block checkpoint proposal",
	);
	expectThrows(
		() => writeApprovedCheckpoint(parsedApproval.request, parsedApproval.warnings, new Date("2026-06-15T12:01:30.000Z"), { runtimeCwd: tempCwd }),
		/cancelling|still running|activeThread/i,
		"cancelling turn should block checkpoint approval",
	);
	expectThrows(
		() => writePersistentAgentMementoBoundary(agentId, threadId, new Date("2026-06-15T12:02:00.000Z"), { runtimeCwd: tempCwd }),
		/cancelling|still running|activeThread/i,
		"cancelling turn should block Memento",
	);
	finishPersistentAgentTurn(agentId, threadId, { turnId: "turn_active_guard_cancelling", terminalReason: "cancelled" });
	assert(getPersistentAgentActiveTurnState(agentId, threadId).state === "idle", "finish should clear cancelling state");
	finishPersistentAgentTurn(agentId, threadId, { turnId: "turn_active_guard_cancelling", terminalReason: "failed" });
	assert(getPersistentAgentActiveTurnState(agentId, threadId).lastTerminalReason === "cancelled", "duplicate terminal finish should not overwrite cancellation reason");

	// Once idle again, an existing runtime boundary can proceed.
	const memento = writePersistentAgentMementoBoundary(agentId, threadId, new Date("2026-06-15T12:03:00.000Z"), { runtimeCwd: tempCwd });
	assert(memento.runtimeBoundary.closedThreadId === threadId, "idle Memento should close original thread");
	assert(memento.postMemento.activeThreadId === memento.runtimeBoundary.newThreadId, "idle Memento should create fresh thread");

	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
	console.log("persistent agent active-turn guard smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	console.error(`temp cwd preserved for inspection: ${tempCwd}`);
	process.exitCode = 1;
}
