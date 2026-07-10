import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-absorb-discussion-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-absorb-discussion-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	createPersistentAgentFromScaffoldInput,
	buildAbsorbDiscussionSignoff,
	buildAbsorbDiscussionTurn,
	buildAbsorbProposal,
	fingerprintL1bSource,
	getAbsorbAvailability,
} = await import("../src/persistent-agents.js");
const { getAbsorbModelLock } = await import("../src/persistent-agent-ai-profiles.js");
const ABSORB_MODEL = getAbsorbModelLock("openai-compatible");

const agentId = "absorb-discussion-smoke-room";
const {
	ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER,
	buildAbsorbDiscussionPrompt,
	buildSectionPurposeMap,
} = await import("../src/absorb-consolidation.js");

const agentRoot = path.join(root, agentId);
const l1bPath = path.join(agentRoot, "L1b", "current.md");
const registryPath = path.join(agentRoot, "section_registry.json");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readL1b(): string {
	return fs.readFileSync(l1bPath, "utf-8");
}

function rcEntry(index: number, extraBody = ""): string {
	return `### RC-${String(index).padStart(4, "0")} | OPEN | 2026-05-20 | Absorb discussion smoke ${index}\n\n**Session arc:** Smoke session ${index} produced durable absorb-discussion signal.\n\n**Body:**\n- Durable discussion understanding ${index} should be considered for Deep Memory.\n- Active follow-up ${index} should be considered for Active Items.\n${extraBody}\n\n**Parked:**\nFollow-up ${index} remains open.\n`;
}

function setRecentContextEntries(count: number, extraBody = ""): void {
	const base = readL1b();
	const match = /^##\s+Recent Context\s*$/m.exec(base);
	assert(match?.index != null, "scaffold L1b should include Recent Context");
	const start = match.index + match[0].length;
	const entries = Array.from({ length: count }, (_, i) => rcEntry(i + 1, extraBody)).join("\n");
	const updated = `${base.slice(0, start)}\n\n${entries || ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER}\n`;
	fs.writeFileSync(l1bPath, updated, "utf-8");
}

const assessmentMarkdown = `## Absorb assessment\n\nI found 5 Recent Context entries. Here is the proposed direction.\n\n### What to remember\n- The discussion path should preserve user guidance before proposal generation.\n- Absorb discussion must remain non-mutating.\n\n### What to forget\n- Repeated smoke-test chatter.\n- Completed mechanical details.\n\n### What changes in stable memory\n- Deep Memory: preserve durable discussion workflow decisions.\n- Active Items: track backend discussion implementation as current work.\n- Recent Context: all entries are expected to be cleared after approval.\n\n### Needs your judgment\n- None\n`;

const discussionReply = "The durable signal is the discussion workflow boundary; repeated smoke details can be cleared.";

const signoffMarkdown = `## Absorb discussion signoff\n\n### User guidance\n- Preserve the backend-only discussion operator boundary.\n\n### Learn / memorize\n- Discussion signoff should hand off to a separate proposal operator.\n\n### Clear / forget\n- Repeated smoke-test details can be cleared.\n\n### Update existing memory\n- Sharpen absorb workflow state around deliberative discussion.\n\n### Needs judgment\n- None\n\n### Transcript summary\nThe discussion confirmed that signoff should produce a bounded handoff, not a Candidate L1b.\n`;

function candidateL1b(): string {
	return `<!-- exxeta:l1b schema_version=1 -->\n\n## Chronos\n\n- Current scaffold timestamp: 2026-05-20T00:00:00.000Z\n- Persistent agent id: absorb-discussion-smoke-room\n- Lifecycle state: ready\n- Last checkpoint: cp_smoke\n- Last consolidation: none\n\n## Deep Memory\n\n- Synthetic user is validating persistence-native personalized agents inside exxperts.\n- Absorb discussion smoke durable understanding has been consolidated into stable memory.\n\n## Active Items\n\n### High Priority\n\n- Continue absorb discussion backend implementation.\n\n### Medium Priority\n\n- Keep discussion and proposal operators separate.\n\n### Low Priority\n\n- Add frontend discussion UX in a later MR.\n\n## Recent Context\n\n${ABSORB_EMPTY_RECENT_CONTEXT_PLACEHOLDER}\n`;
}

function proposalFixture(candidate = candidateL1b()): string {
	return `## Memory Absorption Proposal\n\n### Mode\nRC_CONSOLIDATION\n\n### Primacy Map\nThe RC chain captures absorb discussion backend implementation and operator-boundary decisions.\n\n### Section-Level Change Log\n| Section | Prior Words | Candidate Words | Action | Rationale |\n|---|---:|---:|---|---|\n| Deep Memory | 20 | 28 | sharpen | Preserve durable discussion architecture direction. |\n| Active Items | 20 | 26 | update | Preserve live implementation thread. |\n| Recent Context | 200 | 4 | clear | Strict absorb clears RC entries. |\n\n### Entry-Level Detail\n| Entry / Block | Operation | Target Section | Rationale |\n|---|---|---|---|\n| RC-0001..RC-0005 | consolidate | Deep Memory / Active Items | Durable signal survives outside RC. |\n\n### Compression Metrics\n- RC input words: 200\n- RC removed words: 200\n- RC removed percent: 100%\n- Stable memory words before: 80\n- Stable memory words after: 90\n- Stable memory delta: +10\n- Compression ratio: 2.2\n\n### Warnings\nNone\n\n### Candidate L1b\n${candidate}`;
}

async function expectThrowsAsync(fn: () => Promise<unknown>, expected: RegExp, label: string): Promise<void> {
	try {
		await fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		return;
	}
	throw new Error(`${label}: expected error`);
}

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Absorb Discussion Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	assert(fs.existsSync(l1bPath), "scaffold should create L1b/current.md");
	setRecentContextEntries(5);
	assert(getAbsorbAvailability(agentId).available, "5 RC entries should make absorb available");

	const sourceL1b = readL1b();
	const sourceFingerprint = fingerprintL1bSource(sourceL1b);
	const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
	const promptAssembly = buildAbsorbDiscussionPrompt({
		agentId: agentId,
		l1b: sourceL1b,
		model: ABSORB_MODEL,
		sectionPurposeMap: buildSectionPurposeMap(registry),
		assessmentMarkdown,
		messages: [],
		userMessage: "Can we preserve the operator-boundary decision?",
		sourceFingerprint,
		mode: "turn",
	});
	assert(promptAssembly.prompt.includes("absorb discussion operator"), "discussion prompt should identify discussion operator");
	assert(promptAssembly.prompt.includes("No Candidate L1b generation as the official proposal"), "discussion prompt should forbid official Candidate L1b generation");
	assert(!promptAssembly.prompt.includes("# Absorb Discussion Smoke Room Constitution"), "discussion prompt should not inject L1a constitution text");
	assert(promptAssembly.tokenBudget.state === "ok", "normal discussion prompt should be within budget");

	let turnGeneratorCalled = false;
	const turnResponse = await buildAbsorbDiscussionTurn({
		agentId,
		source: { l1bFingerprint: sourceFingerprint },
		assessmentMarkdown,
		messages: [],
		userMessage: "Can we preserve the operator-boundary decision?",
	}, ABSORB_MODEL, async (prompt, model) => {
		turnGeneratorCalled = true;
		assert(prompt.includes("## Task: Absorb Discussion Turn"), "turn builder should pass turn task to generator");
		assert(model.provider === ABSORB_MODEL.provider && model.model === ABSORB_MODEL.model, "discussion turn should use system-selected absorb model");
		return { text: discussionReply, usage: { input: 10, output: 5, totalTokens: 15, cost: 0 } };
	});
	assert(turnGeneratorCalled, "discussion turn should call generator");
	assert(turnResponse.writesMemory === false, "discussion turn should be non-mutating");
	assert(turnResponse.process.type === "absorb-discussion-worker", "discussion turn should identify discussion worker");
	assert(turnResponse.message.role === "assistant", "discussion turn should return assistant message");
	assert(turnResponse.message.content === discussionReply, "discussion turn should return generated whole message");
	assert(readL1b() === sourceL1b, "discussion turn must not mutate L1b");

	let signoffGeneratorCalled = false;
	const signoffResponse = await buildAbsorbDiscussionSignoff({
		agentId,
		source: { l1bFingerprint: sourceFingerprint },
		assessmentMarkdown,
		messages: [
			{ role: "user", content: "Preserve the operator-boundary decision." },
			{ role: "assistant", content: discussionReply },
		],
	}, ABSORB_MODEL, async (prompt, model) => {
		signoffGeneratorCalled = true;
		assert(prompt.includes("## Task: Absorb Discussion Signoff Handoff"), "signoff builder should pass signoff task to generator");
		assert(model.provider === ABSORB_MODEL.provider && model.model === ABSORB_MODEL.model, "discussion signoff should use system-selected absorb model");
		return { text: signoffMarkdown, usage: { input: 20, output: 15, totalTokens: 35, cost: 0 } };
	});
	assert(signoffGeneratorCalled, "discussion signoff should call generator");
	assert(signoffResponse.writesMemory === false, "discussion signoff should be non-mutating");
	assert(signoffResponse.assessmentHandoff.source === "discussion_signoff", "signoff should return discussion_signoff handoff source");
	assert(signoffResponse.assessmentHandoff.text.includes("## Absorb discussion signoff"), "signoff should return handoff markdown");
	assert(readL1b() === sourceL1b, "discussion signoff must not mutate L1b");

	const proposalResponse = await buildAbsorbProposal({
		agentId,
		assessmentMarkdown,
		assessmentHandoff: signoffResponse.assessmentHandoff,
		source: { l1bFingerprint: sourceFingerprint },
	}, ABSORB_MODEL, async (prompt, model) => {
		assert(prompt.includes("Source: discussion_signoff"), "proposal prompt should include discussion signoff handoff source");
		assert(prompt.includes("Preserve the backend-only discussion operator boundary"), "proposal prompt should include handoff text");
		assert(model.provider === ABSORB_MODEL.provider && model.model === ABSORB_MODEL.model, "proposal should use system-selected absorb model");
		return { text: proposalFixture(), usage: { input: 30, output: 40, totalTokens: 70, cost: 0 } };
	});
	assert(proposalResponse.writesMemory === false, "proposal from discussion signoff should be non-mutating");
	assert(proposalResponse.candidateValidation.valid, "proposal from discussion signoff should validate candidate");
	assert(readL1b() === sourceL1b, "proposal generation must not mutate L1b");

	setRecentContextEntries(5);
	const staleFingerprint = sourceFingerprint;
	const changedL1b = readL1b().replace("Durable discussion understanding 3", "Durable discussion understanding 3 changed after discussion");
	fs.writeFileSync(l1bPath, changedL1b, "utf-8");
	let staleGeneratorCalled = false;
	await expectThrowsAsync(
		() => buildAbsorbDiscussionTurn({
			agentId,
			source: { l1bFingerprint: staleFingerprint },
			assessmentMarkdown,
			messages: [],
			userMessage: "Please continue.",
		}, ABSORB_MODEL, async () => {
			staleGeneratorCalled = true;
			return { text: "should not run" };
		}),
		/source L1b fingerprint changed/,
		"stale discussion source should be rejected before generator",
	);
	assert(!staleGeneratorCalled, "stale discussion source should not call generator");

	const freshFingerprint = fingerprintL1bSource(readL1b());
	let staleProposalGeneratorCalled = false;
	await expectThrowsAsync(
		() => buildAbsorbProposal({
			agentId,
			assessmentMarkdown,
			assessmentHandoff: signoffResponse.assessmentHandoff,
			source: { l1bFingerprint: staleFingerprint },
		}, ABSORB_MODEL, async () => {
			staleProposalGeneratorCalled = true;
			return { text: proposalFixture() };
		}),
		/source L1b fingerprint changed/,
		"stale discussion signoff proposal source should be rejected before generator",
	);
	assert(!staleProposalGeneratorCalled, "stale discussion signoff proposal source should not call generator");

	const hugeBody = `- ${"budget pressure ".repeat(34000)}`;
	setRecentContextEntries(5, hugeBody);
	const hugeFingerprint = fingerprintL1bSource(readL1b());
	let budgetGeneratorCalled = false;
	await expectThrowsAsync(
		() => buildAbsorbDiscussionTurn({
			agentId,
			source: { l1bFingerprint: hugeFingerprint },
			assessmentMarkdown,
			messages: [],
			userMessage: "Please continue despite the large source.",
		}, ABSORB_MODEL, async () => {
			budgetGeneratorCalled = true;
			return { text: "should not run" };
		}),
		/token budget exceeded/,
		"over-budget discussion turn should be rejected before generator",
	);
	assert(!budgetGeneratorCalled, "over-budget discussion turn should not call generator");
	assert(freshFingerprint.value !== hugeFingerprint.value, "huge source should update fingerprint for budget test");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("absorb discussion smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
