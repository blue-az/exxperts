/**
 * CoordinationManager — runtime-level coordination primitives for exxperts.
 *
 * Tracks active owner, continuity ledger, handoff/delegation counters,
 * and guardrail state. Used by both the web server and CLI to provide
 * identical coordination behaviour across all run modes.
 *
 * The coordination contract (docs/coordination.md) is unchanged:
 * three modes — direct specialist, one-shot delegate, interactive handoff.
 * This module moves the WHERE, not the WHAT.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LedgerEntryKind =
	| "user_prompt"
	| "assistant_text"
	| "tool_call"
	| "tool_result"
	| "routing_event"
	| "handoff_start"
	| "handoff_return";

export type LedgerEntry =
	| { kind: "user_prompt"; ts: number; owner: string; text: string }
	| { kind: "assistant_text"; ts: number; owner: string; text: string }
	| { kind: "tool_call"; ts: number; owner: string; name: string; args: string }
	| { kind: "tool_result"; ts: number; owner: string; name: string; text: string; isError: boolean }
	| { kind: "routing_event"; ts: number; from: string; to: string; summary?: string; nextStep?: string }
	| { kind: "handoff_start"; ts: number; from: string; to: string; task?: string; reason?: string; goal?: string }
	| { kind: "handoff_return"; ts: number; from: string; status: string; summary: string; nextStep: string };

export interface HandoffBriefing {
	task: string;
	reason?: string;
	goal?: string;
	constraints?: string[];
	expectedOutput?: string;
	definitionOfDone?: string;
	relevantContext?: string[];
}

export interface DelegateBriefing {
	task: string;
	reason?: string;
	goal?: string;
	constraints?: string[];
	expectedOutput?: string;
	definitionOfDone?: string;
	relevantContext?: string[];
}

export interface DelegateResult {
	ok: boolean;
	text: string;
	agent: string;
	model?: string;
	exitCode?: number;
	stopReason?: string;
	usage?: { input: number; output: number; cost: number; turns: number };
	isError?: boolean;
}

export interface PendingReturnSummary {
	from: string;
	summary: string;
	status: string;
	nextStep: string;
}

export interface GuardrailBlock {
	kind: "tool_calls" | "delegation_depth" | "handoff_chain";
	owner: string;
	message: string;
	target?: string;
}

export interface AgentRuntimeLimits {
	maxToolCallsPerTurn?: number;
	maxDelegationDepth?: number;
	maxHandoffChain?: number;
	canDelegate?: boolean;
	canStartHandoff?: boolean;
	canReturnToCoordinator?: boolean;
	allowedDelegateTargets?: string[];
	allowedHandoffTargets?: string[];
}

/** Events emitted by the CoordinationManager. */
export type CoordinationEvent =
	| { type: "owner_change"; from: string; to: string; direction: "start" | "return" | "direct" }
	| { type: "ledger_append"; entry: LedgerEntry }
	| { type: "guardrail_blocked"; block: GuardrailBlock }
	| { type: "handoff_start"; from: string; to: string; briefing: HandoffBriefing }
	| { type: "handoff_return"; from: string; summary: PendingReturnSummary }
	| { type: "delegate_start"; from: string; agent: string; briefing: DelegateBriefing }
	| { type: "routing_request"; from: string; target: string; briefing: DelegateBriefing; mode: "delegate" | "handoff" };

export type CoordinationEventListener = (event: CoordinationEvent) => void;

export interface CoordinationManagerOptions {
	/** Initial active owner (default: "coordinator"). */
	initialOwner?: string;
	/** Maximum ledger entries before oldest are trimmed. */
	maxLedgerEntries?: number;
	/** Resolver: given an agent name, return its runtime limits. */
	getAgentLimits?: (name: string) => AgentRuntimeLimits;
	/** Resolver: display label for an agent id. */
	labelFor?: (id: string) => string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LEDGER = 70;

export class CoordinationManager {
	// --- public state -------------------------------------------------------

	activeOwner: string;
	ledger: LedgerEntry[] = [];
	pendingReturnSummary: PendingReturnSummary | null = null;
	guardrailBlocked: GuardrailBlock | null = null;

	// --- counters -----------------------------------------------------------

	turnToolCallCount = 0;
	delegationDepth = 0;
	handoffChainLength = 0;
	sessionMaxDelegationDepth: number | undefined;
	sessionMaxHandoffChain: number | undefined;

	// --- private ------------------------------------------------------------

	private maxLedger: number;
	private listeners: CoordinationEventListener[] = [];
	private getAgentLimits: (name: string) => AgentRuntimeLimits;
	private _labelFor: (id: string) => string;

	constructor(opts?: CoordinationManagerOptions) {
		this.activeOwner = opts?.initialOwner ?? "coordinator";
		this.maxLedger = opts?.maxLedgerEntries ?? DEFAULT_MAX_LEDGER;
		this.getAgentLimits = opts?.getAgentLimits ?? (() => ({}));
		this._labelFor = opts?.labelFor ?? ((id) => id);
	}

	// --- event subscription -------------------------------------------------

	onEvent(listener: CoordinationEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	/** Convenience: subscribe to owner changes only. */
	onOwnerChange(callback: (from: string, to: string, direction: "start" | "return" | "direct") => void): () => void {
		return this.onEvent((event) => {
			if (event.type === "owner_change") callback(event.from, event.to, event.direction);
		});
	}

	private emit(event: CoordinationEvent) {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// swallow listener errors
			}
		}
	}

	// --- label helper -------------------------------------------------------

	labelFor(id: string): string {
		return this._labelFor(id);
	}

	// --- ledger management --------------------------------------------------

	appendLedger(entry: LedgerEntry): void {
		this.ledger.push(entry);
		while (this.ledger.length > this.maxLedger) this.ledger.shift();
		this.emit({ type: "ledger_append", entry });
	}

	/**
	 * Build the compact context packet injected into Coordinator-facing prompts
	 * for cross-agent continuity.
	 */
	buildCoordinatorContextPacket(): string {
		const recent = this.ledger.slice(-45);
		if (!recent.length) return "";
		const label = (id: string) => this.labelFor(id);
		const compactText = (s: string, max = 1200): string => {
			const clean = s.replace(/\s+/g, " ").trim();
			return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
		};
		const lines = [
			"[INTERNAL_SESSION_CONTINUITY_LEDGER]",
			"Use this compact session ledger for continuity across agent owner switches. It is server-maintained context, not a user message.",
			`Current active owner: ${this.activeOwner}`,
			"Recent sequence:",
		];
		for (const e of recent) {
			if (e.kind === "user_prompt") lines.push(`- User → ${label(e.owner)}: ${compactText(e.text, 700)}`);
			else if (e.kind === "assistant_text") lines.push(`- ${label(e.owner)} output: ${compactText(e.text, 1600)}`);
			else if (e.kind === "tool_call") lines.push(`- ${label(e.owner)} requested ${e.name}: ${compactText(e.args, 350)}`);
			else if (e.kind === "tool_result") lines.push(`- ${label(e.owner)} ${e.name} ${e.isError ? "error" : "result"}: ${compactText(e.text, 700)}`);
			else if (e.kind === "routing_event") lines.push(`- Routing: ${label(e.from)} → ${label(e.to)}${e.summary ? `; summary: ${compactText(e.summary, 700)}` : ""}${e.nextStep ? `; next: ${compactText(e.nextStep, 350)}` : ""}`);
			else if (e.kind === "handoff_start") lines.push(`- Handoff started: ${label(e.from)} → ${label(e.to)}${e.reason ? `; reason: ${compactText(e.reason, 500)}` : ""}${e.goal ? `; goal: ${compactText(e.goal, 500)}` : ""}${e.task ? `; task: ${compactText(e.task, 900)}` : ""}`);
			else if (e.kind === "handoff_return") lines.push(`- Handoff returned: ${label(e.from)} → Coordinator; status: ${e.status || "(none)"}; summary: ${compactText(e.summary, 1000)}; next: ${compactText(e.nextStep, 500)}`);
		}
		lines.push("When the user asks what happened this session, answer from this ledger. Do not claim you lack prior specialist context if this ledger contains it.");
		lines.push("[/INTERNAL_SESSION_CONTINUITY_LEDGER]");
		const packet = lines.join("\n");
		return packet.length > 10000 ? packet.slice(0, 9999) + "…\n[/INTERNAL_SESSION_CONTINUITY_LEDGER]" : packet;
	}

	/**
	 * Prepend Coordinator context to a prompt if the active owner is Coordinator.
	 */
	withCoordinatorContext(prompt: string): string {
		if (this.activeOwner !== "coordinator") return prompt;
		const packet = this.buildCoordinatorContextPacket();
		return packet ? `${packet}\n\n${prompt}` : prompt;
	}

	// --- owner management ---------------------------------------------------

	/**
	 * Switch active owner. Does NOT create/destroy sessions — that is the
	 * caller's responsibility. Emits owner_change and updates the ledger.
	 */
	switchOwner(
		nextOwner: string,
		direction: "start" | "return" | "direct",
		meta?: {
			summary?: string;
			reason?: string;
			goal?: string;
			nextStep?: string;
		},
	): void {
		if (nextOwner === this.activeOwner) return;
		const from = this.activeOwner;
		if (meta) {
			this.appendLedger({
				kind: "routing_event",
				ts: Date.now(),
				from,
				to: nextOwner,
				summary: meta.summary ?? meta.reason ?? meta.goal,
				nextStep: meta.nextStep,
			});
		}
		this.activeOwner = nextOwner;
		this.emit({ type: "owner_change", from, to: nextOwner, direction });
	}

	// --- turn lifecycle -----------------------------------------------------

	resetTurnCounters(): void {
		this.turnToolCallCount = 0;
		this.guardrailBlocked = null;
	}

	// --- guardrail checks ---------------------------------------------------

	/**
	 * Check whether a tool call should be blocked by runtime guardrails.
	 * Returns a block reason string if blocked, or null if allowed.
	 */
	checkToolCallGuardrail(toolName: string, targetAgent?: string): string | null {
		const limits = this.getAgentLimits(this.activeOwner);
		this.rememberSessionLimits(limits);

		// maxToolCallsPerTurn
		if (limits.maxToolCallsPerTurn !== undefined) {
			this.turnToolCallCount += 1;
			if (this.turnToolCallCount > limits.maxToolCallsPerTurn) {
				this.guardrailBlocked = {
					kind: "tool_calls",
					owner: this.activeOwner,
					message: `${this.labelFor(this.activeOwner)} reached its action limit for this turn.`,
				};
				this.emit({ type: "guardrail_blocked", block: this.guardrailBlocked });
				return "This agent reached its action limit for this turn. Stop calling tools and write a short user-facing summary of where things stand. If more work is needed, ask the user or return to Coordinator.";
			}
		}

		// delegation depth
		if (toolName === "delegate") {
			const canDelegate = limits.canDelegate;
			const canReturn = limits.canReturnToCoordinator;
			if (!(canDelegate === false && canReturn !== false)) {
				const maxDepth = limits.maxDelegationDepth ?? this.sessionMaxDelegationDepth;
				if (maxDepth !== undefined && this.delegationDepth >= maxDepth) {
					this.guardrailBlocked = {
						kind: "delegation_depth",
						owner: this.activeOwner,
						target: targetAgent,
						message: `${this.labelFor(this.activeOwner)} reached its delegation limit.`,
					};
					this.emit({ type: "guardrail_blocked", block: this.guardrailBlocked });
					return "This agent reached its delegation limit. Do not retry delegation. Summarise the current state and return to Coordinator or ask the user to continue from Coordinator.";
				}
				this.delegationDepth += 1;
			}
		}

		// handoff chain
		if (toolName === "start_handoff") {
			const canStart = limits.canStartHandoff;
			const canReturn = limits.canReturnToCoordinator;
			if (!(this.activeOwner !== "coordinator" && canStart === false && canReturn !== false)) {
				const maxChain = limits.maxHandoffChain ?? this.sessionMaxHandoffChain;
				if (maxChain !== undefined && this.handoffChainLength >= maxChain) {
					this.guardrailBlocked = {
						kind: "handoff_chain",
						owner: this.activeOwner,
						target: targetAgent,
						message: `The handoff chain limit was reached before starting ${targetAgent ? this.labelFor(targetAgent) : "another specialist"}.`,
					};
					this.emit({ type: "guardrail_blocked", block: this.guardrailBlocked });
					return "The handoff chain limit has been reached. Do not start another handoff. Return to Coordinator or explain the blocked state and ask the user how to continue.";
				}
			}
		}

		return null;
	}

	// --- handoff lifecycle --------------------------------------------------

	/**
	 * Record a handoff start. Increments handoff chain length and appends ledger.
	 * Owner switching is the caller's responsibility.
	 */
	recordHandoffStart(from: string, to: string, briefing: HandoffBriefing): void {
		this.handoffChainLength += 1;
		this.appendLedger({
			kind: "handoff_start",
			ts: Date.now(),
			from,
			to,
			task: briefing.task,
			reason: briefing.reason,
			goal: briefing.goal,
		});
		this.emit({ type: "handoff_start", from, to, briefing });
	}

	/**
	 * Record a handoff return. Sets pendingReturnSummary and appends ledger.
	 * Owner switching is the caller's responsibility.
	 */
	recordHandoffReturn(from: string, status: string, summary: string, nextStep: string): void {
		this.pendingReturnSummary = { from, summary, status, nextStep };
		this.appendLedger({
			kind: "handoff_return",
			ts: Date.now(),
			from,
			status,
			summary,
			nextStep,
		});
		this.emit({ type: "handoff_return", from, summary: this.pendingReturnSummary });
	}

	/**
	 * Consume the pending return summary (after Coordinator has processed it).
	 */
	consumePendingReturn(): PendingReturnSummary | null {
		const ret = this.pendingReturnSummary;
		this.pendingReturnSummary = null;
		return ret;
	}

	/**
	 * Record a routing request (specialist wants to delegate/handoff but lacks
	 * authority — routes through Coordinator instead).
	 */
	recordRoutingRequest(from: string, target: string, briefing: DelegateBriefing, mode: "delegate" | "handoff"): void {
		this.emit({ type: "routing_request", from, target, briefing, mode });
	}

	// --- utility helpers ----------------------------------------------------

	/** Check if a tool name is a retrieval tool (kb_*, graph_*, memory_*). */
	static isRetrievalTool(name: string): boolean {
		return name.startsWith("kb_") || name.startsWith("graph_") || name.startsWith("memory_");
	}

	/** Compact a string for ledger storage. */
	static compactText(s: string, max = 1200): string {
		const clean = s.replace(/\s+/g, " ").trim();
		return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
	}

	// --- private ------------------------------------------------------------

	private rememberSessionLimits(limits: AgentRuntimeLimits): void {
		if (limits.maxDelegationDepth !== undefined) {
			this.sessionMaxDelegationDepth =
				this.sessionMaxDelegationDepth === undefined
					? limits.maxDelegationDepth
					: Math.min(this.sessionMaxDelegationDepth, limits.maxDelegationDepth);
		}
		if (limits.maxHandoffChain !== undefined) {
			this.sessionMaxHandoffChain =
				this.sessionMaxHandoffChain === undefined
					? limits.maxHandoffChain
					: Math.min(this.sessionMaxHandoffChain, limits.maxHandoffChain);
		}
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCoordinationManager(opts?: CoordinationManagerOptions): CoordinationManager {
	return new CoordinationManager(opts);
}
