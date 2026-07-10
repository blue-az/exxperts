/**
 * Per-agent context policy.
 *
 * Declares how an agent's context is managed: what to inject,
 * when to compact, and what to preserve during compaction.
 *
 * Agents declare their policy in frontmatter:
 *
 * ```yaml
 * context:
 *   alwaysInject:
 *     - vault-state
 *   lazyLoad:
 *     - user-preferences
 *   compaction:
 *     threshold: 0.8
 *     throttle: 60
 *     preserve: "vault names, note links, user preferences"
 * ```
 *
 * When no context policy is provided, the runtime uses global defaults
 * (identical to pre-Phase-3 behaviour).
 */

// ============================================================================
// Types
// ============================================================================

/** Compaction-specific configuration for an agent. */
export interface ContextCompactionPolicy {
	/**
	 * Context usage ratio (0–1) at which auto-compaction should trigger.
	 * Default: no agent-level override (uses global setting or extension behaviour).
	 */
	threshold?: number;

	/**
	 * Minimum seconds between auto-compaction triggers.
	 * Default: no agent-level override.
	 */
	throttle?: number;

	/**
	 * Free-text instructions describing what to preserve during compaction.
	 * Appended to the default compaction prompt as "Additional focus".
	 * Example: "vault names, note links, user preferences"
	 */
	preserve?: string;
}

/** Full context policy for an agent. */
export interface ContextPolicy {
	/**
	 * Named context sources to inject into every turn.
	 * These are symbolic names resolved by extensions (e.g. "vault-state").
	 * The runtime passes these to the `before_agent_start` event so
	 * extensions can look them up and inject the relevant context.
	 */
	alwaysInject?: string[];

	/**
	 * Named context sources to inject on first use (lazy).
	 * Same symbolic names as alwaysInject, but deferred until needed.
	 */
	lazyLoad?: string[];

	/** Compaction behaviour for this agent. */
	compaction?: ContextCompactionPolicy;
}

// ============================================================================
// Defaults
// ============================================================================

/** Default context policy — no overrides, identical to pre-Phase-3 behaviour. */
export const DEFAULT_CONTEXT_POLICY: Readonly<ContextPolicy> = Object.freeze({});

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse a `context:` block from agent frontmatter into a ContextPolicy.
 * Returns undefined if the frontmatter has no `context` key.
 *
 * The frontmatter value can be any shape — this function validates and
 * extracts only the known fields, ignoring unknown ones.
 */
export function parseContextPolicy(frontmatter: Record<string, unknown>): ContextPolicy | undefined {
	const raw = frontmatter.context;
	if (raw == null || typeof raw !== "object") return undefined;

	const ctx = raw as Record<string, unknown>;
	const policy: ContextPolicy = {};

	// alwaysInject
	if (Array.isArray(ctx.alwaysInject)) {
		policy.alwaysInject = ctx.alwaysInject
			.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
			.map((v) => v.trim());
	}

	// lazyLoad
	if (Array.isArray(ctx.lazyLoad)) {
		policy.lazyLoad = ctx.lazyLoad
			.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
			.map((v) => v.trim());
	}

	// compaction
	if (ctx.compaction != null && typeof ctx.compaction === "object") {
		const comp = ctx.compaction as Record<string, unknown>;
		const compaction: ContextCompactionPolicy = {};

		if (typeof comp.threshold === "number" && comp.threshold > 0 && comp.threshold <= 1) {
			compaction.threshold = comp.threshold;
		}
		if (typeof comp.throttle === "number" && comp.throttle > 0) {
			compaction.throttle = comp.throttle;
		}
		if (typeof comp.preserve === "string" && comp.preserve.trim().length > 0) {
			compaction.preserve = comp.preserve.trim();
		}

		if (Object.keys(compaction).length > 0) {
			policy.compaction = compaction;
		}
	}

	return Object.keys(policy).length > 0 ? policy : undefined;
}

/**
 * Merge a ContextPolicy with global defaults, producing effective values.
 * Agent-level settings override globals; unset agent-level settings use globals.
 */
export function mergeContextPolicy(
	agentPolicy: ContextPolicy | undefined,
	globalDefaults: {
		compactionThreshold?: number;
		compactionThrottle?: number;
		compactionPreserve?: string;
	},
): {
	alwaysInject: string[];
	lazyLoad: string[];
	compactionThreshold: number | undefined;
	compactionThrottleMs: number | undefined;
	compactionPreserve: string | undefined;
} {
	const p = agentPolicy ?? DEFAULT_CONTEXT_POLICY;
	return {
		alwaysInject: p.alwaysInject ?? [],
		lazyLoad: p.lazyLoad ?? [],
		compactionThreshold: p.compaction?.threshold ?? globalDefaults.compactionThreshold,
		compactionThrottleMs:
			p.compaction?.throttle != null
				? p.compaction.throttle * 1000
				: globalDefaults.compactionThrottle != null
					? globalDefaults.compactionThrottle * 1000
					: undefined,
		compactionPreserve: p.compaction?.preserve ?? globalDefaults.compactionPreserve,
	};
}
