import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

/**
 * Wire-level tracing of the room-chat WebSocket, behind EXXETA_STREAM_TRACE=1.
 *
 * Purpose: the duplicate-answer bug has never reproduced against mocks — the
 * real provider event ordering is the missing evidence. With the flag on,
 * every frame that crosses the socket (both directions) is summarized to one
 * jsonl line per frame under <state>/stream-traces/<agent>/<conversation>.jsonl.
 * A recorded trace can then be replayed deterministically against the client
 * stream reducer (scripts/replay-stream-trace.ts).
 *
 * Privacy/cost: no full message text is recorded — only lengths, an 8-hex
 * content hash (enough to prove two frames carried identical text), and 12
 * boundary characters on each side (enough to diagnose whitespace/paragraph
 * artifacts at delta boundaries). The trace is opt-in and stays on the user's
 * machine next to the rest of the app state.
 */

export interface StreamTrace {
	frameOut(msg: unknown): void;
	frameIn(msg: unknown): void;
	note(note: string, extra?: Record<string, unknown>): void;
}

const NOOP_TRACE: StreamTrace = { frameOut() {}, frameIn() {}, note() {} };

export function isStreamTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.EXXETA_STREAM_TRACE === "1";
}

function hash8(text: string): string {
	return crypto.createHash("sha1").update(text).digest("hex").slice(0, 8);
}

function summarizeText(text: string): { len: number; hash: string; head: string; tail: string } {
	return {
		len: text.length,
		hash: hash8(text),
		head: text.slice(0, 12),
		tail: text.length > 12 ? text.slice(-12) : "",
	};
}

function summarizeContent(content: unknown): unknown {
	if (typeof content === "string") return { parts: [{ type: "text", ...summarizeText(content) }] };
	if (!Array.isArray(content)) return { parts: [] };
	return {
		parts: content.map((part: any) => {
			if (part?.type === "text" && typeof part.text === "string") return { type: "text", ...summarizeText(part.text) };
			if (part?.type === "toolCall") return { type: "toolCall", name: String(part.name ?? "?") };
			if (part?.type === "thinking") return { type: "thinking", len: typeof part.thinking === "string" ? part.thinking.length : 0 };
			return { type: String(part?.type ?? "?") };
		}),
	};
}

function summarizeMessage(message: any): unknown {
	if (!message || typeof message !== "object") return undefined;
	return {
		role: message.role,
		stopReason: message.stopReason,
		...(message.errorMessage ? { errorMessage: String(message.errorMessage).slice(0, 200) } : {}),
		...(message.toolCallId ? { toolCallId: String(message.toolCallId) } : {}),
		content: summarizeContent(message.content),
	};
}

/** Cheap per-frame projection: shape and identity, never full text. */
function summarizeFrame(msg: any): Record<string, unknown> {
	if (!msg || typeof msg !== "object") return { frame: String(msg) };
	const type = String(msg.type ?? "?");
	if (type === "event") {
		const ev = msg.event ?? {};
		const line: Record<string, unknown> = { frame: "event", event: ev.type };
		const am = ev.assistantMessageEvent;
		if (am) {
			line.am = am.type;
			if (am.contentIndex !== undefined) line.contentIndex = am.contentIndex;
			if (typeof am.delta === "string") line.delta = summarizeText(am.delta);
			if (am.type === "text_end") line.content = typeof am.content === "string" ? summarizeText(am.content) : summarizeContent(am.content);
		}
		if (ev.message) line.message = summarizeMessage(ev.message);
		return line;
	}
	if (type === "prompt") return { frame: "prompt", text: typeof msg.text === "string" ? summarizeText(msg.text) : undefined };
	if (type === "error") return { frame: "error", message: String(msg.message ?? "").slice(0, 200) };
	// ready / usage_turn / ui_request / ui_response / abort …: type is enough.
	return { frame: type };
}

export function createStreamTrace(ids: { agentId: string; conversationId: string; connectionId: string }): StreamTrace {
	if (!isStreamTraceEnabled()) return NOOP_TRACE;
	const dir = productAppStatePath("stream-traces", ids.agentId);
	const file = path.join(dir, `${ids.conversationId.replace(/[^\w.-]/g, "_")}.jsonl`);
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {
		return NOOP_TRACE;
	}
	let seq = 0;
	const write = (dir_: "out" | "in" | "note", payload: Record<string, unknown>) => {
		const line = JSON.stringify({ ts: Date.now(), seq: seq++, conn: ids.connectionId, dir: dir_, ...payload });
		// Fire-and-forget append: tracing must never slow down or break the stream.
		fs.appendFile(file, line + "\n", () => {});
	};
	write("note", { note: "trace_start", agentId: ids.agentId, conversationId: ids.conversationId });
	return {
		frameOut(msg) {
			try { write("out", summarizeFrame(msg)); } catch {}
		},
		frameIn(msg) {
			try { write("in", summarizeFrame(msg)); } catch {}
		},
		note(note, extra) {
			try { write("note", { note, ...extra }); } catch {}
		},
	};
}
