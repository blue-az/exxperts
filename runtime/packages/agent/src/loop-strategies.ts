/**
 * Per-agent loop strategies.
 *
 * A LoopStrategy controls how the ReAct loop behaves for a given agent:
 * how many iterations/tool-calls are allowed, and when to stop.
 *
 * The "default" strategy preserves the original Pi behaviour: the loop
 * runs until the model stops requesting tools, with no artificial limits.
 */

import type { AgentMessage } from "./types.js";
import type { AssistantMessage, ToolResultMessage } from "@exxeta/exxperts-ai";

// ============================================================================
// Types
// ============================================================================

/**
 * Snapshot of the current loop state, passed to strategy methods each turn.
 */
export interface LoopState {
	/** Number of completed turns (assistant response + tool execution = 1 turn). */
	iteration: number;
	/** Cumulative tool calls executed so far in this agent run. */
	toolCallCount: number;
	/** The stop reason from the latest assistant message. */
	lastStopReason: string;
	/** Estimated context usage as a fraction (0–1) if available, else -1. */
	contextUsagePercent: number;
}

/**
 * Configuration for a loop strategy, typically parsed from agent frontmatter.
 */
export interface LoopStrategyConfig {
	/** Strategy name. */
	strategy: string;
	/** Maximum number of turns (iterations) before forcing stop. */
	maxIterations?: number;
	/** Maximum cumulative tool calls before forcing stop. */
	maxToolCallsPerTurn?: number;
	/** Context usage threshold for compaction (informational, not enforced by strategy). */
	compactionThreshold?: number;
	/** Custom compaction instructions (informational, not enforced by strategy). */
	compactionInstructions?: string;
}

/**
 * A loop strategy determines whether the agent loop should continue after a turn.
 */
export interface LoopStrategy {
	/** Strategy identifier. */
	readonly name: string;
	/** Maximum iterations allowed. */
	readonly maxIterations: number;
	/** Maximum cumulative tool calls allowed. */
	readonly maxToolCallsPerTurn: number;

	/**
	 * Called after each turn to determine whether the loop should stop.
	 * Returns true if the loop should STOP (not continue).
	 */
	shouldStop(state: LoopState): boolean;

	/**
	 * Optional hook called when the loop ends (either naturally or forced).
	 */
	onLoopEnd?(state: LoopState): void;
}

// ============================================================================
// Built-in Strategies
// ============================================================================

/**
 * Default strategy — identical to the original Pi behaviour.
 * No artificial iteration or tool-call limits. The loop stops only when
 * the model stops requesting tools or an error/abort occurs.
 */
export class DefaultLoopStrategy implements LoopStrategy {
	readonly name = "default";
	readonly maxIterations = Infinity;
	readonly maxToolCallsPerTurn = Infinity;

	shouldStop(_state: LoopState): boolean {
		// Never force-stop — let the model decide
		return false;
	}
}

/**
 * Tool-heavy strategy — for coding agents that need many iterations.
 * High limits but not infinite, to prevent runaway loops.
 */
export class ToolHeavyLoopStrategy implements LoopStrategy {
	readonly name = "tool-heavy";
	readonly maxIterations: number;
	readonly maxToolCallsPerTurn: number;

	constructor(maxIterations = 25, maxToolCallsPerTurn = 50) {
		this.maxIterations = maxIterations;
		this.maxToolCallsPerTurn = maxToolCallsPerTurn;
	}

	shouldStop(state: LoopState): boolean {
		if (state.iteration >= this.maxIterations) return true;
		if (state.toolCallCount >= this.maxToolCallsPerTurn) return true;
		return false;
	}
}

/**
 * Retrieve-then-respond strategy — one retrieval pass with tools,
 * then the model should produce a final response without tools.
 * Designed for knowledge/retrieval agents.
 */
export class RetrieveThenRespondLoopStrategy implements LoopStrategy {
	readonly name = "retrieve-then-respond";
	readonly maxIterations: number;
	readonly maxToolCallsPerTurn: number;

	constructor(maxIterations = 5, maxToolCallsPerTurn = 10) {
		this.maxIterations = maxIterations;
		this.maxToolCallsPerTurn = maxToolCallsPerTurn;
	}

	shouldStop(state: LoopState): boolean {
		if (state.iteration >= this.maxIterations) return true;
		if (state.toolCallCount >= this.maxToolCallsPerTurn) return true;
		return false;
	}
}

/**
 * Route-first strategy — classify intent and delegate quickly.
 * Very short turns, designed for routing/coordinator agents.
 */
export class RouteFirstLoopStrategy implements LoopStrategy {
	readonly name = "route-first";
	readonly maxIterations: number;
	readonly maxToolCallsPerTurn: number;

	constructor(maxIterations = 3, maxToolCallsPerTurn = 5) {
		this.maxIterations = maxIterations;
		this.maxToolCallsPerTurn = maxToolCallsPerTurn;
	}

	shouldStop(state: LoopState): boolean {
		if (state.iteration >= this.maxIterations) return true;
		if (state.toolCallCount >= this.maxToolCallsPerTurn) return true;
		return false;
	}
}

// ============================================================================
// Strategy Resolution
// ============================================================================

/**
 * Resolve a LoopStrategy from a config object (typically from agent frontmatter).
 * Returns DefaultLoopStrategy if no config or unknown strategy name.
 */
export function resolveLoopStrategy(config?: LoopStrategyConfig): LoopStrategy {
	if (!config || !config.strategy) {
		return new DefaultLoopStrategy();
	}

	const maxIter = config.maxIterations;
	const maxTools = config.maxToolCallsPerTurn;

	switch (config.strategy) {
		case "default":
			return new DefaultLoopStrategy();
		case "tool-heavy":
			return new ToolHeavyLoopStrategy(maxIter, maxTools);
		case "retrieve-then-respond":
			return new RetrieveThenRespondLoopStrategy(maxIter, maxTools);
		case "route-first":
			return new RouteFirstLoopStrategy(maxIter, maxTools);
		default:
			// Unknown strategy name — fall back to default
			return new DefaultLoopStrategy();
	}
}

/**
 * Create a `shouldStopAfterTurn` callback that delegates to a LoopStrategy.
 *
 * This is the bridge between the strategy system and the existing AgentLoopConfig.
 * It wraps the strategy's shouldStop() method and tracks iteration/tool-call state.
 *
 * When the strategy is "default" (no limits), returns undefined so the loop
 * behaves identically to pre-strategy code (no shouldStopAfterTurn set).
 */
export function createStrategyStopHook(strategy: LoopStrategy): {
	shouldStopAfterTurn: (context: {
		message: AgentMessage;
		toolResults: ToolResultMessage[];
		context: { messages: AgentMessage[] };
		newMessages: AgentMessage[];
	}) => boolean;
	/** Reset state for a new agent run. */
	reset: () => void;
} | null {
	// Default strategy has no limits — don't install a hook
	if (strategy.name === "default") {
		return null;
	}

	let iteration = 0;
	let toolCallCount = 0;

	return {
		shouldStopAfterTurn({ message, toolResults }) {
			iteration++;
			toolCallCount += toolResults.length;

			const state: LoopState = {
				iteration,
				toolCallCount,
				lastStopReason: (message as AssistantMessage).stopReason ?? "unknown",
				contextUsagePercent: -1,
			};

			return strategy.shouldStop(state);
		},
		reset() {
			iteration = 0;
			toolCallCount = 0;
		},
	};
}
