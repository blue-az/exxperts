/**
 * Content policy extension — first slice.
 *
 * Scans outbound tool-call arguments before execution and blocks obvious
 * sensitive-file/secret patterns. This is intentionally local and narrow:
 * no org policy, RBAC, approvals, or central administration yet.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@exxeta/exxperts-runtime";
import { productAppStatePath } from "../../product-state-paths.js";

interface RuleConfig {
	id?: string;
	pattern?: string;
	flags?: string;
	reason?: string;
	enabled?: boolean;
}

interface ContentPolicyConfig {
	enabled?: boolean;
	logPath?: string;
	disabledRuleIds?: string[];
	rules?: RuleConfig[];
}

interface Rule {
	id: string;
	pattern: RegExp;
	reason: string;
}

interface MatchResult {
	rule: Rule;
	matchedText: string;
}

const CONFIG_PATH = productAppStatePath("content-policy.json");
const DEFAULT_LOG_PATH = productAppStatePath("content-policy-blocks.jsonl");
const MAX_PREVIEW_CHARS = 500;
const INTERNAL_COORDINATION_TOOLS = new Set(["start_handoff", "return_handoff", "delegate"]);

const DEFAULT_RULES: Rule[] = [
	// Block secret-bearing .env files but allow common documentation templates
	// such as .env.example, .env.sample, .env.template, and .env.dist.
	{ id: "dot-env", pattern: /\.env(?!\.(?:example|sample|template|dist)\b)(?:$|["'\\/.,}\]\w-])/i, reason: "blocked .env access" },
	{ id: "pem-file", pattern: /\.pem(?:$|["'\\/.,}\]])/i, reason: "blocked PEM private-key/certificate file access" },
	{ id: "id-rsa", pattern: /id_rsa(?:$|["'\\/.,}\]\w-])/i, reason: "blocked SSH private-key access" },
	{ id: "password-assignment", pattern: /\bpassword\s*=/i, reason: "blocked password assignment/value pattern" },
	{
		id: "secret-label-value",
		pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|refresh[_-]?token|secret[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=:@-]{8,}/i,
		reason: "blocked API key/token-looking argument",
	},
	{ id: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, reason: "blocked OpenAI-style API key" },
	{ id: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/i, reason: "blocked GitHub token-looking value" },
	{ id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i, reason: "blocked Slack token-looking value" },
	{ id: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/, reason: "blocked AWS access-key-looking value" },
	{ id: "jwt-token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, reason: "blocked JWT/token-looking value" },
];

function expandHome(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
	return filePath;
}

function loadConfig(): ContentPolicyConfig {
	try {
		if (!fs.existsSync(CONFIG_PATH)) return {};
		const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function compileRule(config: RuleConfig, index: number): Rule | null {
	if (config.enabled === false || !config.pattern) return null;
	try {
		return {
			id: config.id || `custom-${index + 1}`,
			pattern: new RegExp(config.pattern, config.flags || "i"),
			reason: config.reason || "blocked by local content policy",
		};
	} catch {
		return null;
	}
}

export function buildPolicy(config: ContentPolicyConfig = loadConfig()): { enabled: boolean; logPath: string; rules: Rule[] } {
	const disabled = new Set((config.disabledRuleIds || []).map((id) => String(id).trim()).filter(Boolean));
	const defaults = DEFAULT_RULES.filter((rule) => !disabled.has(rule.id));
	const custom = (config.rules || []).map(compileRule).filter((rule): rule is Rule => Boolean(rule));
	return {
		enabled: config.enabled !== false,
		logPath: expandHome(config.logPath || DEFAULT_LOG_PATH),
		rules: [...defaults, ...custom],
	};
}

function stableStringify(value: unknown): string {
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return String(value);
	}
}

export function shouldScanTool(toolName: string | undefined): boolean {
	if (!toolName) return true;
	return !INTERNAL_COORDINATION_TOOLS.has(toolName);
}

export function scanArguments(args: unknown, rules: Rule[]): MatchResult | null {
	const text = stableStringify(args);
	for (const rule of rules) {
		const match = text.match(rule.pattern);
		if (match) return { rule, matchedText: match[0] || "" };
	}
	return null;
}

function redactPreview(raw: string): string {
	return raw
		.replace(/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|refresh[_-]?token|secret[_-]?key|client[_-]?secret|password)\b\s*[:=]\s*["']?)[^"'\\s,}]+/gi, "$1[REDACTED]")
		.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
		.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{12,}\b/gi, "gh_[REDACTED]")
		.replace(/\bgithub_pat_[A-Za-z0-9_]{12,}\b/gi, "github_pat_[REDACTED]")
		.replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/gi, "xox*-[REDACTED]")
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]")
		.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "eyJ[REDACTED]")
		.slice(0, MAX_PREVIEW_CHARS);
}

function appendBlockedAttempt(logPath: string, row: Record<string, unknown>): void {
	try {
		fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
		fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
		try {
			fs.chmodSync(logPath, 0o600);
		} catch {
			// Best effort; append still succeeded.
		}
	} catch {
		// Do not fail open/closed differently because logging failed. The tool call
		// remains blocked by the hook return value.
	}
}

export default function (pi: ExtensionAPI) {
	const policy = buildPolicy();

	// Enforcement happens in the tool_call hook below; we intentionally do not
	// surface a "content policy: on" status line in the UI.

	pi.on("tool_call", async (event, ctx) => {
		if (!policy.enabled) return undefined;
		if (!shouldScanTool(event.toolName)) return undefined;

		const input = (event as any).input ?? (event as any).arguments ?? {};
		const match = scanArguments(input, policy.rules);
		if (!match) return undefined;

		const argsText = stableStringify(input);
		appendBlockedAttempt(policy.logPath, {
			ts: new Date().toISOString(),
			cwd: ctx.cwd,
			tool: event.toolName,
			ruleId: match.rule.id,
			reason: match.rule.reason,
			argumentsPreview: redactPreview(argsText),
		});

		const reason = `Content policy blocked tool '${event.toolName}': ${match.rule.reason}. Do not retry with equivalent file/path/token access; explain the constraint to the user and ask for a safe alternative.`;
		if (ctx.hasUI) ctx.ui.notify(reason, "warning");
		return { block: true, reason };
	});
}
