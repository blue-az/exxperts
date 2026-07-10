/**
 * Long-term memory extension — thin wrapper around the runtime MemoryStore.
 *
 * The heavy lifting (storage, approval gate, prompt injection, session
 * summarisation) lives in @exxeta/exxperts-runtime's MemoryStore. This
 * extension wires it into the extension API (tools, commands, hooks).
 *
 * In delegated subprocesses the store is automatically read-only: the
 * child process can recall memories but cannot write new ones.
 */

import { Type } from "typebox";
import {
	type ExtensionAPI,
	MemoryStore,
	createMemoryStore,
	createReadOnlyMemoryStore,
} from "@exxeta/exxperts-runtime";

/**
 * Detect if we're running inside a delegated subprocess.
 * The delegate extension passes --mode json --no-session, so we check
 * for those indicators.
 */
function isDelegate(): boolean {
	const args = process.argv.join(" ");
	return args.includes("--mode") && args.includes("json") && args.includes("--no-session");
}

export default function (pi: ExtensionAPI) {
	// In delegate subprocesses: read-only. Otherwise: full access.
	const store: MemoryStore = isDelegate()
		? createReadOnlyMemoryStore()
		: createMemoryStore();

	// -----------------------------------------------------------------------
	// Hook: inject memories into system prompt on every turn
	// -----------------------------------------------------------------------
	pi.on("before_agent_start", async (event) => {
		const injected = store.injectIntoPrompt(event.systemPrompt);
		if (injected !== event.systemPrompt) {
			return { systemPrompt: injected };
		}
		return undefined;
	});

	// -----------------------------------------------------------------------
	// Tool: memory_note — propose a fact (approval-gated)
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "memory_note",
		label: "Remember",
		description: [
			"Propose a long-term fact about the user. The user MUST approve before",
			"it is saved. Use whenever the user asks you to remember something, or",
			"when you learn something durable about their preferences, projects,",
			"team, or context. Skip transient task details (today's task, the file",
			"you're editing right now). Examples of good notes: \"Prefers Vite\",",
			"\"Direct reports are A, B, C\", \"Hates the phrase 'Certainly!'\".",
		].join(" "),
		promptSnippet:
			"Use `memory_note` to PROPOSE a durable fact about the user (preferences, projects, team). The user approves before it persists.",
		parameters: Type.Object({
			fact: Type.String({ description: "A single, self-contained fact about the user." }),
			tags: Type.Optional(
				Type.Array(Type.String(), {
					description: 'Optional tags, e.g. ["preference", "client", "team"].',
				}),
			),
		}),
		async execute(_id, { fact, tags }, _signal, _onUpdate, ctx) {
			const result = await store.proposeNote(fact, tags, ctx.ui, ctx.hasUI);

			if (!result.saved) {
				const msg =
					result.reason === "read-only"
						? "Memory writes are not available in this context (delegated subprocess, read-only)."
						: result.reason === "no-ui"
							? "Memory write requires user approval; not available in this non-interactive context."
							: result.reason === "cancelled"
								? "Memory edit cancelled."
								: "User declined to save the fact.";
				return {
					content: [{ type: "text", text: msg }],
					details: { saved: false, reason: result.reason },
					isError: result.reason === "read-only" || result.reason === "no-ui",
				};
			}

			return {
				content: [{ type: "text", text: `Remembered: ${result.memory!.text}` }],
				details: { saved: true, ...result.memory },
			};
		},
	});

	// -----------------------------------------------------------------------
	// Tool: memory_recall — search memories
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "memory_recall",
		label: "Recall",
		description:
			"Search long-term memory by substring (case-insensitive, also matches tags). Returns up to `limit` matching facts (default 20). Typically all facts are already in your system prompt — only use this if you suspect there's a fact you're missing.",
		parameters: Type.Object({
			query: Type.String(),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, { query, limit = 20 }) {
			const matches = store.recall({ query, limit });
			return {
				content: [
					{
						type: "text",
						text:
							matches.length === 0
								? `No memories matching "${query}".`
								: matches
										.map((m) => `- (${MemoryStore.formatDate(m.ts)}) ${m.text}`)
										.join("\n"),
					},
				],
				details: { count: matches.length, matches },
			};
		},
	});

	// -----------------------------------------------------------------------
	// Command: /remember — direct user save (no approval needed)
	// -----------------------------------------------------------------------
	pi.registerCommand("remember", {
		description: "Save a quick memory directly (no approval — you typed it)",
		handler: async (args, ctx) => {
			const text = args?.trim();
			if (!text) {
				ctx.ui.notify("usage: /remember <text>", "warning");
				return;
			}
			if (store.isReadOnly) {
				ctx.ui.notify("Memory is read-only in this context.", "warning");
				return;
			}
			store.append({
				id: MemoryStore.generateId(),
				ts: Date.now(),
				text,
				source: "user",
			});
			ctx.ui.notify(`Remembered: ${text}`, "info");
		},
	});

	// -----------------------------------------------------------------------
	// Command: /memories — list all
	// -----------------------------------------------------------------------
	pi.registerCommand("memories", {
		description: "List long-term memories (interactive picker)",
		handler: async (_args, ctx) => {
			const mem = store.load();
			if (mem.length === 0) {
				ctx.ui.notify(
					"No memories yet. Use /remember <text> or let an agent propose one.",
					"info",
				);
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`${mem.length} memories saved (run interactively to browse).`,
					"info",
				);
				return;
			}
			const labels = mem.map(
				(m) => `${MemoryStore.formatDate(m.ts)} — ${m.text}`,
			);
			const pick = await ctx.ui.select(
				`${mem.length} memories — pick to inspect`,
				labels,
			);
			if (!pick) return;
			const idx = labels.indexOf(pick);
			if (idx < 0) return;
			const m = mem[idx];
			ctx.ui.notify(
				[
					`Saved:    ${MemoryStore.formatDate(m.ts)}`,
					`Source:   ${m.source ?? "unknown"}`,
					`Tags:     ${m.tags?.join(", ") || "(none)"}`,
					"",
					m.text,
				].join("\n"),
				"info",
			);
		},
	});

	// -----------------------------------------------------------------------
	// Command: /forget — pick one to delete
	// -----------------------------------------------------------------------
	pi.registerCommand("forget", {
		description: "Pick a memory to delete",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/forget requires an interactive UI", "warning");
				return;
			}
			if (store.isReadOnly) {
				ctx.ui.notify("Memory is read-only in this context.", "warning");
				return;
			}
			const mem = store.load();
			if (mem.length === 0) {
				ctx.ui.notify("No memories.", "info");
				return;
			}
			const labels = mem.map(
				(m) => `${MemoryStore.formatDate(m.ts)} — ${m.text}`,
			);
			const pick = await ctx.ui.select("Forget which?", labels);
			if (!pick) return;
			const idx = labels.indexOf(pick);
			if (idx < 0) return;
			const ok = await ctx.ui.confirm(
				"Delete?",
				`Permanently forget:\n\n  ${mem[idx].text}`,
			);
			if (!ok) return;
			store.delete(mem[idx].id);
			ctx.ui.notify("Forgotten.", "info");
		},
	});

	// -----------------------------------------------------------------------
	// Hook: session_shutdown — offer session-end summarisation
	// -----------------------------------------------------------------------
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI || store.isReadOnly) return;

		const memCount = store.count();
		// Only offer summarisation if the user had a meaningful session
		// (skip for very short sessions or if there are no UI capabilities)
		const shouldOffer = await ctx.ui.confirm(
			"Session ending",
			"Would you like to save any facts from this session to long-term memory?",
		);
		if (!shouldOffer) return;

		const input = await ctx.ui.input(
			"Session facts",
			"Enter facts to remember (one per line, or comma-separated). Press Enter to save, Escape to skip.",
		);
		if (!input?.trim()) return;

		// Parse user input into individual facts
		const facts = input
			.split(/[,\n]/)
			.map((f) => f.trim())
			.filter(Boolean);

		if (facts.length === 0) return;

		await store.saveSessionSummary(
			{ facts, tags: ["session-summary"] },
			ctx.ui,
			ctx.hasUI,
		);
	});
}
