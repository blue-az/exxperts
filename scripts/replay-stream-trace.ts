// Replay a recorded stream trace against the web-ui assistant stream reducer.
//
// Usage:
//   npx tsx scripts/replay-stream-trace.ts ~/.exxperts/app/stream-traces/<room>/<conversation>.jsonl
//
// Traces are recorded by the web server when EXXETA_STREAM_TRACE=1 (see
// apps/web-server/src/stream-trace.ts). They contain no full message text —
// only lengths, 8-hex content hashes and 12 boundary characters — so the
// replay reconstructs synthetic text with the same lengths and, crucially,
// the same identity structure: frames that carried identical text (identical
// hash) are replayed with identical synthetic text. Exact replays and
// duplicated frames therefore reproduce byte-for-byte, which is what the
// reducer's quarantine keys on.
//
// The replay drives the reducer with the recorded event order and timing
// (ticks are simulated every 16ms of trace time) and then reports the
// resulting transcript items, any quarantine warnings, and — the point of the
// exercise — whether any answer would have rendered twice.

import fs from "node:fs";
import {
	createAssistantStreamState,
	normaliseAssistantText,
	reduceAssistantStream,
	type AssistantStreamAction,
	type AssistantStreamState,
} from "../apps/web-ui/src/assistant-stream.js";

interface TraceLine {
	ts: number;
	seq: number;
	conn: string;
	dir: "out" | "in" | "note";
	frame?: string;
	event?: string;
	am?: string;
	contentIndex?: number;
	delta?: { len: number; hash: string; head: string; tail: string };
	content?: { len: number; hash: string; head: string; tail: string } | { parts: any[] };
	message?: { role?: string; stopReason?: string; errorMessage?: string; content?: { parts: any[] } };
	note?: string;
}

const file = process.argv[2];
if (!file) {
	console.error("usage: npx tsx scripts/replay-stream-trace.ts <trace.jsonl>");
	process.exit(2);
}

const lines: TraceLine[] = fs.readFileSync(file, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l));

// --- synthetic text reconstruction ---------------------------------------
// hash → synthetic text. First sighting of a hash mints text of the right
// length from a deterministic corpus cursor; later sightings reuse it, so
// identical frames replay identically and substring relations at delta
// boundaries are preserved for exact replays.
const textByHash = new Map<string, string>();
let corpusCursor = 0;
function corpus(len: number): string {
	const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon".split(" ");
	let out = "";
	while (out.length < len) {
		out += `${words[corpusCursor % words.length]} `;
		corpusCursor += 1;
	}
	return out.slice(0, len);
}
function synthetic(summary: { len: number; hash: string; head: string; tail: string } | undefined): string {
	if (!summary || summary.len === 0) return "";
	const existing = textByHash.get(summary.hash);
	if (existing) return existing;
	// Preserve recorded boundary characters so whitespace artifacts at delta
	// boundaries reproduce; fill the middle from the corpus.
	const middleLen = Math.max(0, summary.len - summary.head.length - summary.tail.length);
	const text = (summary.head + corpus(middleLen) + summary.tail).slice(0, summary.len);
	textByHash.set(summary.hash, text);
	return text;
}

// message_end text: prefer the recorded joined-parts summaries. Because the
// full text hash never matched any delta hash, synthesize it as the exact
// concatenation of this message's deltas when the lengths line up — that is
// how the runtime builds it too.
let currentMessageDeltas: string[] = [];

function messageEndText(message: TraceLine["message"]): string {
	const parts = (message?.content as { parts?: any[] } | undefined)?.parts ?? [];
	const textParts = parts.filter((p) => p.type === "text");
	const totalLen = textParts.reduce((sum, p) => sum + (p.len ?? 0), 0);
	const fromDeltas = currentMessageDeltas.join("");
	if (fromDeltas.length === totalLen) return fromDeltas;
	if (textParts.length > 0) {
		const joined = textParts.map((p) => synthetic(p)).join("");
		if (fromDeltas.length > 0 && joined.length > fromDeltas.length && joined.length - fromDeltas.length <= 2) {
			// Off-by-a-trim: keep delta identity, pad from the part summary.
			return fromDeltas + joined.slice(fromDeltas.length);
		}
		return joined;
	}
	return fromDeltas;
}

// --- replay ----------------------------------------------------------------
let state: AssistantStreamState = createAssistantStreamState();
const items = new Map<string, { text: string; streaming: boolean }>();
const warnings: string[] = [];
let tickPending = false;
let virtualNow = lines.length ? lines[0].ts : 0;

function dispatch(action: AssistantStreamAction): void {
	const result = reduceAssistantStream(state, action);
	state = result.state;
	for (const effect of result.effects) {
		if (effect.kind === "upsert") items.set(effect.id, { text: effect.text, streaming: effect.streaming });
		else if (effect.kind === "schedule_tick") tickPending = true;
		else if (effect.kind === "warn") warnings.push(`${effect.message} ${JSON.stringify(effect.detail ?? {})}`);
	}
}

function runTicksUntil(ts: number): void {
	while (tickPending && virtualNow + 16 <= ts) {
		virtualNow += 16;
		tickPending = false;
		dispatch({ type: "tick", now: virtualNow, mode: "paced" });
	}
	virtualNow = Math.max(virtualNow, ts);
}

let eventCount = 0;
for (const line of lines) {
	runTicksUntil(line.ts);
	if (line.dir === "in" && line.frame === "prompt") {
		dispatch({ type: "new_turn", now: line.ts });
		continue;
	}
	if (line.dir !== "out" || line.frame !== "event") continue;
	eventCount += 1;
	const now = line.ts;
	if (line.event === "message_start" && line.message?.role === "assistant") {
		currentMessageDeltas = [];
		dispatch({ type: "message_start", now });
	} else if (line.event === "message_update" && line.am === "text_delta") {
		const text = synthetic(line.delta);
		currentMessageDeltas.push(text);
		dispatch({ type: "delta", text, now });
	} else if (line.event === "message_update" && line.am === "text_end") {
		const summary = line.content && "len" in line.content ? line.content : undefined;
		dispatch({ type: "text_end", blockText: synthetic(summary), now });
	} else if (line.event === "message_end" && line.message?.role === "assistant") {
		dispatch({ type: "message_end", finalText: messageEndText(line.message), stopReason: line.message.stopReason, now });
		currentMessageDeltas = [];
	} else if (line.event === "auto_retry_start") {
		dispatch({ type: "auto_retry_start", now });
	}
}
// settle
for (let i = 0; i < 500_000 && tickPending; i++) {
	virtualNow += 16;
	tickPending = false;
	dispatch({ type: "tick", now: virtualNow, mode: "paced" });
}

// --- report ---------------------------------------------------------------
console.log(`replayed ${eventCount} events from ${lines.length} trace lines\n`);
const texts = [...items.values()].map((it) => normaliseAssistantText(it.text));
let duplicates = 0;
for (let i = 0; i < texts.length; i++) {
	for (let j = i + 1; j < texts.length; j++) {
		if (!texts[i] || !texts[j]) continue;
		if (texts[i] === texts[j]) {
			duplicates += 1;
			console.log(`DUPLICATE: items ${i} and ${j} render identical text (${texts[i].length} chars)`);
		} else if (texts[i].endsWith(texts[j]) || texts[j].endsWith(texts[i])) {
			duplicates += 1;
			console.log(`FRAGMENT: item ${j} is a suffix of item ${i} (or vice versa)`);
		}
	}
}
console.log(`items rendered: ${items.size}`);
for (const [id, it] of items) {
	console.log(`  ${id}: ${it.text.length} chars${it.streaming ? " (still streaming!)" : ""} | ${it.text.slice(0, 80).replace(/\n/g, "¶")}…`);
}
if (warnings.length) {
	console.log(`\nquarantine warnings (${warnings.length}) — these frames would have duplicated on the old client:`);
	for (const w of warnings) console.log(`  ${w}`);
}
console.log(duplicates === 0 ? "\nno duplicate answers in replay" : `\n${duplicates} duplicate/fragment pair(s) in replay`);
process.exit(duplicates === 0 ? 0 : 1);
