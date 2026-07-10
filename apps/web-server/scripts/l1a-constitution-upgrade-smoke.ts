import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-l1a-upgrade-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-l1a-upgrade-root-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

const {
	createPersistentAgentFromScaffoldInput,
	parsePersistentAgentL1aMarker,
	planPersistentAgentConstitutionUpgrade,
	upgradePersistentAgentConstitution,
} = await import("../src/persistent-agents.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function sha256(text: string): string {
	return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function readText(file: string): string {
	return fs.readFileSync(file, "utf-8");
}

function listFiles(dir: string): string[] {
	return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

const LEGACY_V1_L1A = `# Legacy Room Constitution

<!-- exxeta:persistent-agent:l1a schema_version=1 -->

## Identity

You are **Legacy Room**, a persistent personal coordinator inside exxperts.

You serve **Alice Example**. In normal conversation, refer to the user as **Alice** unless they ask otherwise.

## Memory Rules

Official durable memory lives in L1b. If L1b is sparse, say so briefly when relevant.
`;

try {
	// Simulate an existing pre-template_version room: scaffold, then replace L1a
	// with legacy wording and strip the mode field from agent.json.
	const created = createPersistentAgentFromScaffoldInput({ displayName: "Legacy Room", userName: "Alice Example", preferredUserAddress: "Alice" });
	const agentId = created.agent.agentId;
	const agentRoot = path.join(tempAgentsRoot, agentId);
	const l1aPath = path.join(agentRoot, "L1a.md");
	const agentJsonPath = path.join(agentRoot, "agent.json");
	fs.writeFileSync(l1aPath, LEGACY_V1_L1A);
	const legacyMeta = JSON.parse(readText(agentJsonPath));
	delete legacyMeta.mode;
	fs.writeFileSync(agentJsonPath, JSON.stringify(legacyMeta, null, 2) + "\n");

	const legacyMarker = parsePersistentAgentL1aMarker(LEGACY_V1_L1A);
	assert(legacyMarker.templateVersion === 1 && legacyMarker.mode === "default", "legacy marker should parse as template v1 / default mode");
	assert(parsePersistentAgentL1aMarker("no marker at all").templateVersion === 1, "missing marker should parse as template v1");

	// Plan: v1 -> v2 upgrade, nothing written.
	const plan = planPersistentAgentConstitutionUpgrade(agentId);
	assert(plan.action === "upgrade" && plan.fromTemplateVersion === 1 && plan.toTemplateVersion === 2, "plan should propose v1 -> v2 upgrade");
	assert(plan.mode === "default", "plan should fall back to the default mode");
	assert(readText(l1aPath) === LEGACY_V1_L1A, "planning must not modify L1a");
	assert(listFiles(path.join(agentRoot, "L1a-archive")).length === 0, "planning must not create archives");

	// Upgrade: archive + rewrite + event record + agent.json mode.
	const l1bBefore = readText(path.join(agentRoot, "L1b/current.md"));
	const result = upgradePersistentAgentConstitution(agentId);
	assert(result.upgradeId != null && result.archivedL1aRelPath != null && result.eventRecordRelPath != null, "upgrade should report ids and paths");

	const newL1a = readText(l1aPath);
	const newMarker = parsePersistentAgentL1aMarker(newL1a);
	assert(newMarker.templateVersion === 2 && newMarker.mode === "default", "upgraded L1a should carry template v2 / default mode");
	assert(newL1a.includes("You work with **Alice Example**"), "upgraded L1a should rebuild identity from agent.json");
	assert(newL1a.includes("sharp thinking partner"), "upgraded L1a should carry the default mode body");
	assert(!newL1a.includes("L1b"), "upgraded L1a should not teach internal layer jargon");

	const archiveDir = path.join(agentRoot, "L1a-archive");
	const archives = listFiles(archiveDir);
	assert(archives.length === 1, "upgrade should write exactly one archive");
	assert(readText(path.join(archiveDir, archives[0])) === LEGACY_V1_L1A, "archive should preserve the legacy L1a byte-exactly");

	const eventFiles = listFiles(path.join(agentRoot, "events/constitution-upgrade"));
	assert(eventFiles.length === 1, "upgrade should write exactly one event record");
	const event = JSON.parse(readText(path.join(agentRoot, "events/constitution-upgrade", eventFiles[0])));
	assert(event.operation === "constitution_upgrade" && event.schemaVersion === 1, "event record should be schema-versioned");
	assert(event.fromTemplateVersion === 1 && event.toTemplateVersion === 2, "event record should record version transition");
	assert(event.source.l1aFingerprint.value === sha256(LEGACY_V1_L1A), "event source fingerprint should match legacy L1a sha256");
	assert(event.result.l1aFingerprint.value === sha256(newL1a), "event result fingerprint should match new L1a sha256");

	const updatedMeta = JSON.parse(readText(agentJsonPath));
	assert(updatedMeta.mode === "default", "agent.json should record the mode after upgrade");
	assert(readText(path.join(agentRoot, "L1b/current.md")) === l1bBefore, "durable memory (L1b) must be untouched by the upgrade");

	// Idempotency: second run is a no-op.
	const second = upgradePersistentAgentConstitution(agentId);
	assert(second.plan.action === "up_to_date" && second.upgradeId === null, "second upgrade should be a no-op");
	assert(listFiles(archiveDir).length === 1, "no-op run must not write another archive");
	assert(listFiles(path.join(agentRoot, "events/constitution-upgrade")).length === 1, "no-op run must not write another event record");

	// Refusals: non-idle runtime state and an active cross-surface room lock.
	fs.writeFileSync(l1aPath, LEGACY_V1_L1A);
	const runtimeStatePath = path.join(agentRoot, "runtime/state.json");
	const runtimeState = JSON.parse(readText(runtimeStatePath));
	fs.writeFileSync(runtimeStatePath, JSON.stringify({ ...runtimeState, state: "active", activeThreadId: "thread-smoke" }, null, 2) + "\n");
	let refusedForState = false;
	try {
		upgradePersistentAgentConstitution(agentId);
	} catch (error) {
		refusedForState = /runtime state/.test((error as Error).message);
	}
	assert(refusedForState, "upgrade should refuse while the room runtime is not idle");
	assert(readText(l1aPath) === LEGACY_V1_L1A, "refused upgrade must not modify L1a");
	fs.writeFileSync(runtimeStatePath, JSON.stringify(runtimeState, null, 2) + "\n");

	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
	const roomLock = (await import("node:module")).createRequire(import.meta.url)(path.join(repoRoot, "bin", "lib", "room-lock.cjs"));
	const lockOwner = { surface: "cli", pid: process.pid, host: os.hostname() };
	const acquired = roomLock.tryAcquire(agentId, lockOwner);
	assert(acquired && acquired.ok !== false, "smoke should be able to acquire the room lock");
	let refusedForLock = false;
	try {
		upgradePersistentAgentConstitution(agentId);
	} catch (error) {
		refusedForLock = /currently open/.test((error as Error).message);
	}
	assert(refusedForLock, "upgrade should refuse while the room lock is held");
	roomLock.release(agentId, lockOwner);

	const afterUnlock = upgradePersistentAgentConstitution(agentId);
	assert(afterUnlock.plan.action === "upgrade" && afterUnlock.upgradeId != null, "upgrade should succeed again after the lock is released");

	console.log("l1a constitution upgrade smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
}
