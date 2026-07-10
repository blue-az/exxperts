import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-structural-review-write-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-structural-review-write-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	createPersistentAgentFromScaffoldInput,
	fingerprintL1bSource,
	parseStructuralReviewApprovalRequest,
	writeApprovedStructuralReview,
} = await import("../src/persistent-agents.js");

const agentId = "structural-review-write-smoke-room";
const { extractStructuralReviewSourceParts, STRUCTURAL_REVIEW_MODE, STRUCTURAL_REVIEW_WORKER_TYPE } = await import("../src/structural-review.js");

const SOURCE_REVIEW_TARGET_SENTINEL = "RAW_SOURCE_REVIEW_TARGET_SENTINEL_STRUCTURAL_SMOKE";
const CANDIDATE_REVIEW_TARGET_SENTINEL = "RAW_CANDIDATE_REVIEW_TARGET_SENTINEL_STRUCTURAL_SMOKE";
const PROPOSAL_TEXT_SENTINEL = "RAW_PROPOSAL_TEXT_SENTINEL_STRUCTURAL_SMOKE";

const agentRoot = path.join(root, agentId);
const agentJsonPath = path.join(agentRoot, "agent.json");
const l1bPath = path.join(agentRoot, "L1b", "current.md");
const archiveDir = path.join(agentRoot, "L1b", "archive");
const structuralReviewEventDir = path.join(agentRoot, "events", "structural-review");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readL1b(): string {
	return fs.readFileSync(l1bPath, "utf-8");
}

function readAgentJson(): any {
	return JSON.parse(fs.readFileSync(agentJsonPath, "utf-8"));
}

function archiveCount(): number {
	return fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter((name) => name.endsWith(".md")).length : 0;
}

function structuralReviewEventCount(): number {
	return fs.existsSync(structuralReviewEventDir) ? fs.readdirSync(structuralReviewEventDir).filter((name) => name.endsWith(".json")).length : 0;
}

function isRelativePath(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]+/).includes("..");
}

function sourceL1b(): string {
	return `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Current scaffold timestamp: 2026-05-21T10:00:00.000Z
- Persistent agent id: structural-review-write-smoke-room
- UNIQUE_CHRONOS_SENTINEL_MUST_BE_PRESERVED

## Deep Memory

### Collaboration and Workflow

- The synthetic user prefers scoped GitLab MRs with explicit cleanup steps.
- The synthetic user is learning collaborative Git/GitLab workflows.

### Product Direction

- Persistent-agent memory maintenance should feel calm, lean, and signal-first.
- Duplicate product-direction wording repeats calm, lean, and signal-first memory maintenance.
- Source-only redaction marker: RAW_SOURCE_REVIEW_TARGET_SENTINEL_STRUCTURAL_SMOKE.
- UNIQUE_DEEP_MEMORY_SIGNAL_CAN_CHANGE_ONLY_IN_REVIEW_TARGET

## Active Items

### Current Focus

- Implement MR24 approval-gated Prune memory write semantics.
- Preserve exact split and graft invariants for Chronos and Recent Context.

### Parked

- Revisit shared Maintain workspace polish after Absorb and Prune memory both exist.

## Recent Context

### RC-0001 | OPEN | 2026-05-21 | Smoke context

**Session arc:** This RC entry must survive Prune memory approval exactly.

**Body:**
- UNIQUE_RECENT_CONTEXT_SENTINEL_MUST_BE_PRESERVED

**Parked:**
None.
`;
}

const candidateReviewTarget = `## Deep Memory

### Collaboration and Workflow

- The synthetic user prefers scoped GitLab MRs with explicit cleanup steps and is learning collaborative Git/GitLab workflows.

### Product Direction

- Persistent-agent memory maintenance should feel calm, lean, and signal-first.
- Candidate-only redaction marker: RAW_CANDIDATE_REVIEW_TARGET_SENTINEL_STRUCTURAL_SMOKE.
- UNIQUE_DEEP_MEMORY_SIGNAL_CAN_CHANGE_ONLY_IN_REVIEW_TARGET

## Active Items

### Current Focus

- Implement MR24 approval-gated Prune memory write semantics while preserving exact split/graft invariants.

### Parked

- Revisit shared Maintain workspace polish after Absorb and Prune memory both exist.
`;

function proposal(source = readL1b(), candidate = candidateReviewTarget) {
	const parts = extractStructuralReviewSourceParts(source);
	return {
		agentId: agentId,
		writesMemory: false,
		process: {
			type: STRUCTURAL_REVIEW_WORKER_TYPE,
			mode: STRUCTURAL_REVIEW_MODE,
			model: { provider: "openai-codex", model: "gpt-5.5", label: "GPT-5.5" },
		},
		source: {
			l1bFingerprint: fingerprintL1bSource(source),
			reviewTargetFingerprint: fingerprintL1bSource(parts.sourceReviewTargetL1b),
			chronosFingerprint: fingerprintL1bSource(parts.preservedChronos),
			recentContextFingerprint: fingerprintL1bSource(parts.preservedRecentContext),
			generatedAt: "2026-05-21T20:00:00.000Z",
		},
		fields: {
			summary: "Tighten durable workflow/product signal and current MR24 focus.",
			candidateReviewTargetL1b: candidate,
		},
		review: {
			metrics: {
				reviewTargetWordsBefore: 80,
				reviewTargetWordsAfter: 60,
				reviewTargetEstimatedTokensBefore: 120,
				reviewTargetEstimatedTokensAfter: 90,
				reviewTargetEstimatedTokenDelta: -30,
			},
		},
		structuralReviewTelemetry: {
			chars: parts.sourceReviewTargetL1b.length,
			bytes: Buffer.byteLength(parts.sourceReviewTargetL1b, "utf-8"),
			words: 80,
			estimatedTokens: 120,
			promptChars: 4000,
			promptEstimatedTokens: 1000,
			sectionDescriptionCount: 4,
			diagnosticHash: fingerprintL1bSource("structural telemetry hash fixture"),
			memoryMap: [{ area: "Deep Memory", words: 50, estimatedTokens: 75 }],
			rawPromptPreview: PROPOSAL_TEXT_SENTINEL,
		},
		structuralReviewUsage: {
			input: 444,
			output: 555,
			cacheRead: 66,
			cacheWrite: 77,
			totalTokens: 999,
			cost: 0.0456,
			rawProviderPayload: PROPOSAL_TEXT_SENTINEL,
		},
		rawProposalMarkdown: `Proposal body must not leak: ${PROPOSAL_TEXT_SENTINEL}`,
	};
}

function structuralReviewRequest(candidate = candidateReviewTarget, source = readL1b()) {
	return parseStructuralReviewApprovalRequest({ proposal: proposal(source, candidate) }, agentId);
}

function expectThrows(fn: () => unknown, expected: RegExp, label: string): void {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		return;
	}
	throw new Error(`${label}: expected error`);
}

function expectNoMutation(expectedL1b: string, expectedArchiveCount: number, expectedEventCount: number, label: string): void {
	assert(readL1b() === expectedL1b, `${label}: rejected approval must not rewrite L1b/current.md`);
	assert(archiveCount() === expectedArchiveCount, `${label}: rejected approval must not create archive`);
	assert(structuralReviewEventCount() === expectedEventCount, `${label}: rejected approval must not create event record`);
}

try {
	createPersistentAgentFromScaffoldInput({
		displayName: "Structural Review Write Smoke Room",
		userName: "Synthetic User",
		preferredUserAddress: "Synthetic User",
	});
	fs.writeFileSync(l1bPath, sourceL1b(), "utf-8");
	assert(fs.existsSync(l1bPath), "scaffold should create L1b/current.md");
	assert(archiveCount() === 0, "fresh scaffold should have no archives");
	assert(structuralReviewEventCount() === 0, "fresh scaffold should have no structural-review event records");

	const sourceBeforeApproval = readL1b();
	const partsBeforeApproval = extractStructuralReviewSourceParts(sourceBeforeApproval);
	const metaBeforeApproval = readAgentJson();
	const parsed = structuralReviewRequest();
	const result = writeApprovedStructuralReview(parsed.request, parsed.warnings, new Date("2026-05-21T20:00:00.000Z"));
	const approvedL1b = readL1b();
	const partsAfterApproval = extractStructuralReviewSourceParts(approvedL1b);
	const metaAfterApproval = readAgentJson();

	assert(result.writesMemory === true, "structural review approval should report memory write");
	assert(result.structuralReviewId.startsWith("structural_review_"), "structural review approval should return structuralReviewId");
	assert(result.eventRecordPath === path.join(structuralReviewEventDir, `${result.structuralReviewId}.json`), "approval should return canonical structural-review event path");
	assert(fs.existsSync(result.eventRecordPath), "structural-review event record should exist");
	assert(archiveCount() === 1, "structural review approval should archive previous L1b");
	assert(fs.readFileSync(result.archivedL1bPath, "utf-8") === sourceBeforeApproval, "archive should contain pre-approval L1b");
	assert(metaAfterApproval.updatedAt === new Date("2026-05-21T20:00:00.000Z").getTime(), "approval should update agent.json.updatedAt");
	assert(metaAfterApproval.updatedAt !== metaBeforeApproval.updatedAt, "approval should change updatedAt");
	assert(partsAfterApproval.preservedChronos === partsBeforeApproval.preservedChronos, "approval must preserve Chronos exactly");
	assert(partsAfterApproval.preservedRecentContext === partsBeforeApproval.preservedRecentContext, "approval must preserve Recent Context exactly");
	assert(partsAfterApproval.sourceReviewTargetL1b === candidateReviewTarget.trimEnd() + "\n", "approval should graft approved candidate review target");
	assert(approvedL1b.includes("UNIQUE_CHRONOS_SENTINEL_MUST_BE_PRESERVED"), "approved L1b should retain Chronos sentinel");
	assert(approvedL1b.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_MUST_BE_PRESERVED"), "approved L1b should retain Recent Context sentinel");
	assert(/^## Chronos\n[\s\S]*^## Deep Memory\n[\s\S]*^## Active Items\n[\s\S]*^## Recent Context/m.test(approvedL1b), "approved L1b should preserve mandatory topology/order");

	const eventRecord = JSON.parse(fs.readFileSync(result.eventRecordPath, "utf-8"));
	assert(eventRecord.schemaVersion === 1, "structural-review event should use schema version 1");
	assert(eventRecord.operation === "structural_review", "structural-review event should identify operation");
	assert(eventRecord.mode === "stc_diagnostic", "structural-review event should identify mode");
	assert(eventRecord.agentId === agentId, "structural-review event should include agent id");
	assert(eventRecord.structuralReviewId === result.structuralReviewId, "structural-review event should match response id");
	assert(eventRecord.approvedAt === "2026-05-21T20:00:00.000Z", "structural-review event should include approval timestamp");
	assert(eventRecord.archivedL1bPath == null, "new structural-review event should not persist top-level archive path");
	assert(eventRecord.updatedL1bPath == null, "new structural-review event should not persist top-level updated L1b path");
	assert(result.eventRelPath === `events/structural-review/${result.structuralReviewId}.json`, "structural review approval should return canonical relative event path");
	assert(eventRecord.mutation?.target === "l1b", "structural-review event mutation should target L1b");
	assert(eventRecord.mutation?.kind === "stable_memory_restructure_prune", "structural-review event mutation should identify stable-memory restructure/prune");
	assert(eventRecord.mutation.sectionsAffected.includes("Deep Memory"), "structural-review event should mark Deep Memory affected");
	assert(eventRecord.mutation.sectionsAffected.includes("Active Items"), "structural-review event should mark Active Items affected");
	assert(eventRecord.mutation.sectionsPreserved.includes("Chronos"), "structural-review event should mark Chronos preserved");
	assert(eventRecord.mutation.sectionsPreserved.includes("Recent Context"), "structural-review event should mark Recent Context preserved");
	assert(isRelativePath(eventRecord.paths?.archivedL1bRelPath), "structural-review archive path in event should be relative");
	assert(isRelativePath(eventRecord.paths?.updatedL1bRelPath), "structural-review updated L1b path in event should be relative");
	assert(isRelativePath(eventRecord.paths?.eventRelPath), "structural-review event path in event should be relative");
	assert(eventRecord.paths.archivedL1bRelPath === path.relative(agentRoot, result.archivedL1bPath).split(path.sep).join("/"), "structural-review event archive path should be agent-root relative");
	assert(eventRecord.paths.updatedL1bRelPath === "L1b/current.md", "structural-review event updated L1b path should be agent-root relative");
	assert(eventRecord.paths.eventRelPath === result.eventRelPath, "structural-review event relative path should match response relative path");
	assert(eventRecord.process?.type === STRUCTURAL_REVIEW_WORKER_TYPE, "structural-review event should include proposal-time worker type");
	assert(eventRecord.process?.mode === STRUCTURAL_REVIEW_MODE, "structural-review event should include process mode");
	assert(eventRecord.process?.source === "proposal_time", "structural-review event process should identify proposal-time source");
	assert(eventRecord.process?.model?.provider === "openai-codex", "structural-review event should copy proposal model provider");
	assert(eventRecord.process?.model?.model === "gpt-5.5", "structural-review event should copy proposal model id");
	assert(eventRecord.process?.model?.label === "GPT-5.5", "structural-review event should copy proposal model label");
	assert(eventRecord.proposal?.generatedAt === "2026-05-21T20:00:00.000Z", "structural-review event should copy proposal generation timestamp");
	assert(eventRecord.proposal?.sourceL1bFingerprint?.value === fingerprintL1bSource(sourceBeforeApproval).value, "structural-review event should copy source L1b fingerprint");
	assert(eventRecord.proposal?.reviewTargetFingerprint?.value === fingerprintL1bSource(partsBeforeApproval.sourceReviewTargetL1b).value, "structural-review event should copy review-target fingerprint");
	assert(eventRecord.proposal?.telemetry?.promptChars === 4000, "structural-review event should copy numeric proposal telemetry");
	assert(eventRecord.proposal?.telemetry?.promptEstimatedTokens === 1000, "structural-review event should copy numeric token telemetry");
	assert(eventRecord.proposal?.telemetry?.diagnosticHash?.algorithm === "sha256", "structural-review event should copy hash-shaped telemetry");
	assert(Array.isArray(eventRecord.proposal?.telemetry?.memoryMap), "structural-review event should preserve sanitized numeric telemetry arrays");
	assert(eventRecord.proposal.telemetry.memoryMap[0].words === 50, "structural-review event should keep numeric nested telemetry");
	assert(eventRecord.proposal.telemetry.memoryMap[0].area == null, "structural-review event should omit text nested telemetry");
	assert(eventRecord.proposal?.telemetry?.rawPromptPreview == null, "structural-review event should omit raw telemetry text");
	assert(eventRecord.proposal?.usage?.input === 444, "structural-review event should copy numeric usage input");
	assert(eventRecord.proposal?.usage?.output === 555, "structural-review event should copy numeric usage output");
	assert(eventRecord.proposal?.usage?.cacheRead === 66, "structural-review event should copy numeric usage cacheRead");
	assert(eventRecord.proposal?.usage?.cacheWrite === 77, "structural-review event should copy numeric usage cacheWrite");
	assert(eventRecord.proposal?.usage?.totalTokens === 999, "structural-review event should copy numeric usage totalTokens");
	assert(eventRecord.proposal?.usage?.cost === 0.0456, "structural-review event should copy numeric usage cost");
	assert(eventRecord.proposal?.usage?.rawProviderPayload == null, "structural-review event should omit raw usage payloads");
	assert(eventRecord.source.l1bFingerprint.value === fingerprintL1bSource(sourceBeforeApproval).value, "event should capture source full L1b fingerprint");
	assert(eventRecord.source.reviewTargetFingerprint.value === fingerprintL1bSource(partsBeforeApproval.sourceReviewTargetL1b).value, "event should capture source review target fingerprint");
	assert(eventRecord.source.chronosFingerprint.value === fingerprintL1bSource(partsBeforeApproval.preservedChronos).value, "event should capture source Chronos fingerprint");
	assert(eventRecord.source.recentContextFingerprint.value === fingerprintL1bSource(partsBeforeApproval.preservedRecentContext).value, "event should capture source Recent Context fingerprint");
	assert(eventRecord.result.l1bFingerprint.value === fingerprintL1bSource(approvedL1b).value, "event should capture result full L1b fingerprint");
	assert(eventRecord.result.reviewTargetFingerprint.value === fingerprintL1bSource(partsAfterApproval.sourceReviewTargetL1b).value, "event should capture result review target fingerprint");
	assert(eventRecord.result.chronosFingerprint.value === eventRecord.source.chronosFingerprint.value, "event should show Chronos fingerprint preserved");
	assert(eventRecord.result.recentContextFingerprint.value === eventRecord.source.recentContextFingerprint.value, "event should show Recent Context fingerprint preserved");
	assert(eventRecord.metrics.reviewTargetEstimatedTokensAfter <= eventRecord.metrics.reviewTargetEstimatedTokensBefore, "event metrics should capture pruning token delta");
	assert(eventRecord.structuralReview?.reviewTargetWordsBefore === eventRecord.metrics.reviewTargetWordsBefore, "structural-review summary should mirror review words before");
	assert(eventRecord.structuralReview?.reviewTargetWordsAfter === eventRecord.metrics.reviewTargetWordsAfter, "structural-review summary should mirror review words after");
	assert(eventRecord.structuralReview?.reviewTargetEstimatedTokensBefore === eventRecord.metrics.reviewTargetEstimatedTokensBefore, "structural-review summary should mirror tokens before");
	assert(eventRecord.structuralReview?.reviewTargetEstimatedTokensAfter === eventRecord.metrics.reviewTargetEstimatedTokensAfter, "structural-review summary should mirror tokens after");
	assert(eventRecord.structuralReview?.reviewTargetEstimatedTokenDelta === eventRecord.metrics.reviewTargetEstimatedTokenDelta, "structural-review summary should mirror token delta");
	assert(typeof eventRecord.structuralReview?.stableMemoryBytesBefore === "number", "structural-review summary should include stable memory bytes before");
	assert(typeof eventRecord.structuralReview?.stableMemoryBytesAfter === "number", "structural-review summary should include stable memory bytes after");
	assert(typeof eventRecord.structuralReview?.stableMemoryDeltaBytes === "number", "structural-review summary should include stable memory byte delta");
	assert(eventRecord.structuralReview.stableMemoryDeltaBytes === eventRecord.structuralReview.stableMemoryBytesAfter - eventRecord.structuralReview.stableMemoryBytesBefore, "structural-review stable byte delta should be derived");
	assert(eventRecord.structuralReview.chronosPreserved === true, "structural-review summary should mark Chronos preserved");
	assert(eventRecord.structuralReview.recentContextPreserved === true, "structural-review summary should mark Recent Context preserved");
	assert(eventRecord.structuralReview.recentContextEntryCountBefore === 1, "structural-review summary should capture RC count before");
	assert(eventRecord.structuralReview.recentContextEntryCountAfter === 1, "structural-review summary should capture unchanged RC count after");
	assert(eventRecord.validation.valid === true, "event should capture validation success");
	assert(Array.isArray(eventRecord.validation.warnings), "event should capture validation warnings");
	const serializedEvent = JSON.stringify(eventRecord);
	assert(!serializedEvent.includes(root), "structural-review event JSON should not include temp persistent-agents root");
	assert(!serializedEvent.includes(agentRoot), "structural-review event JSON should not include default agent absolute root");
	assert(!serializedEvent.includes(SOURCE_REVIEW_TARGET_SENTINEL), "structural-review event JSON should not include raw source review-target sentinel");
	assert(!serializedEvent.includes(CANDIDATE_REVIEW_TARGET_SENTINEL), "structural-review event JSON should not include raw candidate review-target sentinel");
	assert(!serializedEvent.includes(PROPOSAL_TEXT_SENTINEL), "structural-review event JSON should not include raw proposal text sentinel");
	assert(!serializedEvent.includes("UNIQUE_CHRONOS_SENTINEL_MUST_BE_PRESERVED"), "structural-review event JSON should not include raw Chronos sentinel");
	assert(!serializedEvent.includes("UNIQUE_RECENT_CONTEXT_SENTINEL_MUST_BE_PRESERVED"), "structural-review event JSON should not include raw Recent Context sentinel");

	fs.writeFileSync(l1bPath, sourceL1b(), "utf-8");
	const baselineL1b = readL1b();
	const baselineArchiveCount = archiveCount();
	const baselineEventCount = structuralReviewEventCount();

	const staleParsed = structuralReviewRequest();
	fs.writeFileSync(l1bPath, baselineL1b.replace("MR24 approval-gated", "MR24 stale-source approval-gated"), "utf-8");
	expectThrows(
		() => writeApprovedStructuralReview(staleParsed.request, staleParsed.warnings, new Date("2026-05-21T20:01:00.000Z")),
		/source L1b fingerprint changed/,
		"stale full L1b fingerprint should reject before archive/write",
	);
	expectNoMutation(readL1b(), baselineArchiveCount, baselineEventCount, "stale full L1b fingerprint");

	fs.writeFileSync(l1bPath, baselineL1b, "utf-8");
	const reviewTargetStale = structuralReviewRequest();
	reviewTargetStale.request.proposal.source!.reviewTargetFingerprint = fingerprintL1bSource("stale review target");
	expectThrows(
		() => writeApprovedStructuralReview(reviewTargetStale.request, reviewTargetStale.warnings, new Date("2026-05-21T20:02:00.000Z")),
		/source review target fingerprint changed/,
		"stale review target fingerprint should reject before archive/write",
	);
	expectNoMutation(baselineL1b, baselineArchiveCount, baselineEventCount, "stale review target fingerprint");

	const chronosStale = structuralReviewRequest();
	chronosStale.request.proposal.source!.chronosFingerprint = fingerprintL1bSource("stale chronos");
	expectThrows(
		() => writeApprovedStructuralReview(chronosStale.request, chronosStale.warnings, new Date("2026-05-21T20:03:00.000Z")),
		/source Chronos fingerprint changed/,
		"stale Chronos fingerprint should reject before archive/write",
	);
	expectNoMutation(baselineL1b, baselineArchiveCount, baselineEventCount, "stale Chronos fingerprint");

	const recentContextStale = structuralReviewRequest();
	recentContextStale.request.proposal.source!.recentContextFingerprint = fingerprintL1bSource("stale recent context");
	expectThrows(
		() => writeApprovedStructuralReview(recentContextStale.request, recentContextStale.warnings, new Date("2026-05-21T20:04:00.000Z")),
		/source Recent Context fingerprint changed/,
		"stale Recent Context fingerprint should reject before archive/write",
	);
	expectNoMutation(baselineL1b, baselineArchiveCount, baselineEventCount, "stale Recent Context fingerprint");

	expectThrows(
		() => writeApprovedStructuralReview(structuralReviewRequest(`${candidateReviewTarget}\n\n## Chronos\n\nTampered chronos\n`).request, [], new Date("2026-05-21T20:05:00.000Z")),
		/exactly Deep Memory and Active Items|must not include Chronos/,
		"candidate with Chronos top-level section should reject before archive/write",
	);
	expectNoMutation(baselineL1b, baselineArchiveCount, baselineEventCount, "candidate with Chronos");

	expectThrows(
		() => writeApprovedStructuralReview(structuralReviewRequest(`${candidateReviewTarget}\n\n## Recent Context\n\nTampered recent context\n`).request, [], new Date("2026-05-21T20:06:00.000Z")),
		/exactly Deep Memory and Active Items|must not include Recent Context/,
		"candidate with Recent Context top-level section should reject before archive/write",
	);
	expectNoMutation(baselineL1b, baselineArchiveCount, baselineEventCount, "candidate with Recent Context");

	expectThrows(
		() => writeApprovedStructuralReview(structuralReviewRequest(`${candidateReviewTarget}\n\n## Optional Memory\n\nExtra top-level section\n`).request, [], new Date("2026-05-21T20:07:00.000Z")),
		/exactly Deep Memory and Active Items/,
		"candidate with extra top-level section should reject before archive/write",
	);
	expectNoMutation(baselineL1b, baselineArchiveCount, baselineEventCount, "candidate with extra top-level section");

	const bloatedCandidate = `## Deep Memory\n\n### Bloated\n\n- ${"This candidate intentionally grows stable memory far beyond the source review target. ".repeat(120)}\n\n## Active Items\n\n### Current Focus\n\n- Keep MR24 focused.\n`;
	expectThrows(
		() => writeApprovedStructuralReview(structuralReviewRequest(bloatedCandidate).request, [], new Date("2026-05-21T20:08:00.000Z")),
		/token growth exceeds Structural Review hard limit/,
		"candidate above token growth hard limit should reject before archive/write",
	);
	expectNoMutation(baselineL1b, baselineArchiveCount, baselineEventCount, "candidate above token growth hard limit");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("structural review write smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
