import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-workspace-snapshot-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-workspace-snapshot-agents-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

const {
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	readPersistentAgentBootPromptSnapshot,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const {
	createPersistentRoomDefaultCapabilityPolicy,
	ensurePersistentRoomThreadEffectiveWorkspacePolicySnapshot,
	persistentRoomRuntimeCwdForEffectiveWorkspacePolicy,
	persistentRoomWorkspaceDefaultPath,
	persistentRoomWorkspacePolicyPath,
	readPersistentRoomCapabilityPolicy,
	resolvePersistentRoomEffectiveWorkspacePolicy,
	writePersistentRoomDefaultCapabilityPolicy,
} = await import("../src/persistent-room-workspace-policy.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function l1b(agentId: string): string {
	return `<!-- exxeta:l1b schema_version=1 -->\n\n## Chronos\n\n- Persistent agent id: ${agentId}\n- Last checkpoint: none\n\n## Deep Memory\n\nWorkspace snapshot smoke deep memory.\n\n## Active Items\n\nWorkspace snapshot smoke active item.\n\n## Recent Context\n\nNo checkpointed sessions yet.\n`;
}

function writeFixtureAgent(agentId: string): void {
	const root = path.join(tempAgentsRoot, agentId);
	fs.mkdirSync(path.join(root, "L1b", "archive"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(root, "events", "checkpoint"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(root, "events", "absorb"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(root, "events", "structural-review"), { recursive: true, mode: 0o700 });
	const now = Date.now();
	fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({
		schemaVersion: 1,
		id: agentId,
		displayName: "Workspace Snapshot Smoke Room",
		description: "Workspace snapshot smoke fixture",
		role: "smoke-fixture",
		status: "ready",
		createdAt: now,
		updatedAt: now,
		l1aPath: "L1a.md",
		l1bCurrentPath: "L1b/current.md",
		l1bArchiveDir: "L1b/archive",
		sectionRegistryPath: "section_registry.json",
		currentSessionId: null,
		lastCheckpointId: null,
		recentContextSoftCap: 7,
		recentContextHardCap: 10,
		memoryTokenBudget: 12000,
	}, null, 2) + "\n", { mode: 0o600 });
	fs.writeFileSync(path.join(root, "L1a.md"), "# Workspace Snapshot Smoke Constitution\n", { mode: 0o600 });
	fs.writeFileSync(path.join(root, "L1b", "current.md"), l1b(agentId), { mode: 0o600 });
	fs.writeFileSync(path.join(root, "section_registry.json"), JSON.stringify({
		schemaVersion: 1,
		sections: {
			Chronos: { status: "mandatory" },
			"Deep Memory": { status: "mandatory" },
			"Active Items": { status: "mandatory" },
			"Recent Context": { status: "mandatory" },
		},
		updatedAt: now,
	}, null, 2) + "\n", { mode: 0o600 });
}

const agentId = "workspace-snapshot-smoke";
const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT 5.5" };
const repoRoot = path.join(tempHome, "repo");
const workspaceA = path.join(tempHome, "workspace-a");
const workspaceB = path.join(tempHome, "workspace-b");
const runtimeCwd = path.join(tempHome, "cwd");

try {
	for (const dir of [repoRoot, workspaceA, workspaceB, runtimeCwd]) fs.mkdirSync(dir, { recursive: true });
	writeFixtureAgent(agentId);
	const instance = createPersistentAgentInstance(agentId);

	const defaultA = createPersistentRoomDefaultCapabilityPolicy({
		agentId,
		repoRoot,
		root: workspaceA,
		workspaceAccessMode: "bounded",
		displayLabel: "Workspace A",
		source: "manual",
		mode: "read",
	});
	writePersistentRoomDefaultCapabilityPolicy(defaultA, { persistentAgentsRoot: tempAgentsRoot });
	assert(fs.existsSync(persistentRoomWorkspaceDefaultPath(agentId, { persistentAgentsRoot: tempAgentsRoot })), "room default A should be written");

	const threadA = "snap_a_0001";
	const writeA = writePersistentAgentThread(agentId, threadA, {
		state: "standby",
		origin: "home",
		model,
		items: [],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: threadA, model, cwd: runtimeCwd }),
	});
	assert(writeA.thread.runtime.kind === "pi-session-jsonl", "thread A should be Pi-backed");
	const sidecarAPath = persistentRoomWorkspacePolicyPath(agentId, threadA, { persistentAgentsRoot: tempAgentsRoot });
	assert(fs.existsSync(sidecarAPath), "new runtime should snapshot room default into thread sidecar");
	const sidecarA = readPersistentRoomCapabilityPolicy(agentId, threadA, { persistentAgentsRoot: tempAgentsRoot });
	assert(sidecarA?.conversationId === threadA, "thread sidecar should use thread id as conversation id");
	assert(sidecarA?.workspaceAccessMode === "bounded", "thread A sidecar should preserve bounded workspace access mode");
	assert(sidecarA?.roots[0]?.realpath === fs.realpathSync.native(workspaceA), "thread A sidecar should preserve workspace A root");

	const effectiveA = resolvePersistentRoomEffectiveWorkspacePolicy(agentId, threadA, { persistentAgentsRoot: tempAgentsRoot });
	assert(effectiveA.source === "thread", `thread A effective source should be thread after snapshot, got ${effectiveA.source}`);
	assert(effectiveA.workspaceAccessMode === "bounded", "effective workspace access mode should remain bounded");
	assert(effectiveA.pathAccess === "workspace-only", "effective path access should remain workspace-only");
	assert(effectiveA.allowedToolNames.join(",") === "ls,find,read,write_markdown_file,read_spreadsheet", "effective tools should remain exact bounded workspace bundle");
	assert(effectiveA.workspaceToolsEnabled === true, "workspace tools should be enabled for snapshotted policy");
	assert(effectiveA.markdownWriteEnabled === true, "Markdown-only write should remain enabled");
	assert(effectiveA.bashEnabled === false, "bash must remain disabled");
	assert(effectiveA.nativePiFilesystemToolsEnabled === false, "native Pi filesystem tools must remain disabled");
	assert(persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(effectiveA, runtimeCwd) === runtimeCwd, "bounded effective policy should preserve fallback runtime cwd");
	assert(effectiveA.capability?.workspaceLabel === "Workspace A", "effective capability should use workspace A label");
	const bootPromptA = readPersistentAgentBootPromptSnapshot(agentId, writeA.thread.runtime);
	assert(bootPromptA.includes("Workspace label: Workspace A"), "boot prompt should include snapshotted workspace A label");
	assert(bootPromptA.includes("Workspace tools: ls, find, read, write_markdown_file, read_spreadsheet"), "boot prompt should list exact bounded workspace tools");
	assert(crypto.createHash("sha256").update(bootPromptA, "utf-8").digest("hex") === writeA.thread.runtime.bootPromptSha256, "boot prompt hash should match runtime metadata");

	const defaultB = createPersistentRoomDefaultCapabilityPolicy({
		agentId,
		repoRoot,
		root: workspaceB,
		workspaceAccessMode: "localFiles",
		displayLabel: "Workspace B",
		source: "manual",
		mode: "read",
		toolSelection: { kind: "custom", allowedToolNames: ["read", "ls", "read_spreadsheet"] },
		bashEnabled: true,
	});
	writePersistentRoomDefaultCapabilityPolicy(defaultB, { persistentAgentsRoot: tempAgentsRoot });
	const afterDefaultChangeA = resolvePersistentRoomEffectiveWorkspacePolicy(agentId, threadA, { persistentAgentsRoot: tempAgentsRoot });
	assert(afterDefaultChangeA.policy?.roots[0]?.realpath === fs.realpathSync.native(workspaceA), "changed room default must not mutate existing snapshotted thread A");
	assert(afterDefaultChangeA.capability?.workspaceLabel === "Workspace A", "thread A effective capability should remain workspace A");

	const threadB = "snap_b_0001";
	const effectiveBeforeRuntimeB = ensurePersistentRoomThreadEffectiveWorkspacePolicySnapshot(agentId, threadB, { persistentAgentsRoot: tempAgentsRoot });
	assert(effectiveBeforeRuntimeB.source === "thread-snapshot-from-room-default", "explicit ensure should report room-default snapshot source for fresh thread B");
	assert(effectiveBeforeRuntimeB.workspaceAccessMode === "localFiles", "thread B effective policy should copy Local files mode from room default");
	assert(effectiveBeforeRuntimeB.pathAccess === "local-files", "thread B effective policy should expose local-files path access");
	assert(effectiveBeforeRuntimeB.nativePiFilesystemToolsEnabled === true, "thread B effective policy should expose native Pi filesystem capability");
	assert(effectiveBeforeRuntimeB.allowedToolNames.join(",") === "read,ls,read_spreadsheet", "thread B effective policy should preserve selected Local files subset");
	assert(effectiveBeforeRuntimeB.bashEnabled === true, "thread B effective policy should preserve explicit Local files bash setting");
	assert(effectiveBeforeRuntimeB.capability?.bashEnabled === true, "thread B capability should expose explicit Local files bash setting");
	assert(effectiveBeforeRuntimeB.policy?.workspaceAccessMode === "localFiles", "thread B sidecar policy should snapshot Local files mode");
	assert(effectiveBeforeRuntimeB.policy?.roots[0]?.realpath === fs.realpathSync.native(workspaceB), "thread B should snapshot workspace B");
	assert(persistentRoomRuntimeCwdForEffectiveWorkspacePolicy(effectiveBeforeRuntimeB, runtimeCwd) === fs.realpathSync.native(workspaceB), "local-files effective policy should use workspace root as runtime cwd");
	const writeB = writePersistentAgentThread(agentId, threadB, {
		state: "standby",
		origin: "home",
		model,
		items: [],
	}, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: threadB, model, cwd: runtimeCwd }),
	});
	assert(writeB.thread.runtime.kind === "pi-session-jsonl", "thread B should be Pi-backed");
	const bootPromptB = readPersistentAgentBootPromptSnapshot(agentId, writeB.thread.runtime);
	assert(bootPromptB.includes("Workspace label: Workspace B"), "new thread boot prompt should use updated room default B snapshot");
	assert(bootPromptB.includes("Workspace tools: read, ls, read_spreadsheet"), "new thread boot prompt should list selected Local files tools");
	assert(bootPromptB.includes("Bash/shell access: enabled"), "new thread boot prompt should reflect explicit Local files bash setting");

	console.log("persistent-room workspace policy snapshot smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	console.error(`temp agents root preserved for inspection: ${tempAgentsRoot}`);
	process.exitCode = 1;
} finally {
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	}
}
