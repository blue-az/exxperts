import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@exxeta/exxperts-core";
import { afterEach } from "vitest";

export function createUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

export function createAssistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

// Creating symlinks on Windows needs Developer Mode or elevation; probe once
// so symlink-dependent tests can skip instead of failing with EPERM.
export const symlinksSupported = (() => {
	if (process.platform !== "win32") return true;
	const dir = join(tmpdir(), `pi-agent-symlink-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	try {
		writeFileSync(join(dir, "target"), "");
		symlinkSync(join(dir, "target"), join(dir, "link"));
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
})();

const tempDirs: string[] = [];

export function createTempDir(): string {
	const dir = join(tmpdir(), `pi-agent-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

export function getLatestTempDir(): string {
	return tempDirs[tempDirs.length - 1]!;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});
