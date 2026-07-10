import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@exxeta/exxperts-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

describe("createAgentSession rawSystemPrompt", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-raw-system-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses the raw system prompt exactly", async () => {
		const workerPrompt = "You are the hidden checkpoint maintenance worker. Return only JSON.";

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			sessionManager: SessionManager.inMemory(cwd),
			rawSystemPrompt: workerPrompt,
		});

		try {
			expect(session.systemPrompt).toBe(workerPrompt);
		} finally {
			session.dispose();
		}
	});

	it("does not append default prompt, context files, cwd, tools, or date text", async () => {
		const workerPrompt = "WORKER_RAW_PROMPT_ONLY";
		const agentsSentinel = "RAW_PROMPT_TEST_AGENTS_SENTINEL";
		writeFileSync(join(cwd, "AGENTS.md"), `# Project Context\n\n${agentsSentinel}\n`);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			sessionManager: SessionManager.inMemory(cwd),
			rawSystemPrompt: workerPrompt,
		});

		try {
			expect(session.systemPrompt).toBe(workerPrompt);
			expect(session.systemPrompt).not.toContain("expert coding assistant");
			expect(session.systemPrompt).not.toContain("# Project Context");
			expect(session.systemPrompt).not.toContain(agentsSentinel);
			expect(session.systemPrompt).not.toContain("Available tools:");
			expect(session.systemPrompt).not.toContain("Current date:");
			expect(session.systemPrompt).not.toContain("Current working directory:");
			expect(session.systemPrompt).not.toContain(cwd);
		} finally {
			session.dispose();
		}
	});

	it("keeps noTools all active-tool isolation with a raw system prompt", async () => {
		const workerPrompt = "RAW_NO_TOOLS_WORKER_PROMPT";

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			sessionManager: SessionManager.inMemory(cwd),
			rawSystemPrompt: workerPrompt,
			noTools: "all",
		});

		try {
			expect(session.systemPrompt).toBe(workerPrompt);
			expect(session.getActiveToolNames()).toEqual([]);
			expect(session.agent.state.tools).toEqual([]);
		} finally {
			session.dispose();
		}
	});
});
