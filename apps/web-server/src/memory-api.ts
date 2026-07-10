/**
 * Read-only room-memory telemetry.
 *
 * Rooms remember through the persistent-agent checkpoint architecture: each
 * room's durable memory is the `L1b/current.md` document, grown through
 * approval-gated checkpoints (see checkpoint-compression / absorb-consolidation).
 * Nothing here mutates memory — it only *reads and aggregates* what checkpoints
 * already record, so the app can finally show the user the memory it builds.
 *
 * Sources, all already on disk:
 *  - `L1b/current.md`            → current memory size + topic map (structuralReviewMetrics)
 *  - `events/checkpoint/*.json`  → the growth history (one record per checkpoint)
 *  - PersistentAgentStatus        → recent-context backlog + absorb readiness
 */

import fs from "node:fs";
import path from "node:path";
import {
	createPersistentAgentInstance,
	listPersistentAgents,
	type AbsorbEventRecord,
	type CheckpointEventRecord,
	type StructuralReviewEventRecord,
	type PersistentAgentStatus,
} from "./persistent-agents.js";
import { buildStructuralReviewMemoryMap, extractStructuralReviewSourceParts, structuralReviewMetrics, type StructuralReviewMemoryMapRow } from "./structural-review.js";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

export interface MemoryGrowthPoint {
	/** epoch ms of the event that produced this L1b state */
	ts: number;
	/** measured L1b size after the event (estimated tokens) */
	tokens: number;
	/** chars the checkpoint added (the session folded into memory); 0 for absorbs */
	added: number;
	/** title of what was learned, when recorded */
	title: string | null;
	/** which kind of event produced this point */
	kind: "checkpoint" | "absorb" | "review";
	/** Deep Memory section tokens at this event (measured from the snapshot) */
	consolidated: number;
	/** recent-context (pending) tokens at this event */
	recent: number;
}

/**
 * Payoff signals — the join of memory with the usage log. All measured, no
 * causal claim: L1b is injected every turn (footprintTokens), and because it's
 * a stable prompt block it's cached, so most of it comes back as cheap
 * cacheRead rather than fresh input. `costPerTurn` / `cacheRatio` are read
 * straight from usage.jsonl for this room.
 */
export interface RoomPayoff {
	turns: number;
	totalCost: number;
	costPerTurn: number;
	/**
	 * Cache hit rate: cacheRead / (cacheRead + input) over this room's turns —
	 * the fraction of each turn's read context served from cache rather than as
	 * fresh input. NOTE: this covers the whole stable prompt (system prompt +
	 * tools + memory + history), not the memory block alone.
	 */
	cacheHitRate: number;
}

export interface RoomMemorySummary {
	id: string;
	displayName: string;
	description?: string;
	/** measured tokens of L1b — this is what's injected into every turn */
	l1bTokens: number;
	/** number of top-level memory areas (from the memory map) */
	areas: number;
	checkpoints: number;
	lastCheckpointAt: number | null;
	/** when this room's deep memory was last reviewed/pruned, if ever */
	lastReviewAt: number | null;
	/** deep-memory token change from that last review (negative = pruned) */
	lastReviewTokenDelta: number;
	/** recent-context entries waiting to be absorbed into durable memory */
	recentContextBacklog: number;
	/** the room is ready for a consolidation pass */
	needsAbsorb: boolean;
	/** L1b size after each checkpoint, oldest → newest (drives the sparkline) */
	series: MemoryGrowthPoint[];
	/** number of Recent Context session entries (awaiting absorb) */
	sessions: number;
	/** hard cap on recent sessions before a Learn is required */
	sessionsCap: number;
	/** recent (pending, not-yet-consolidated) session titles, newest first */
	topics: string[];
	/** key things the room knows (bold phrases from durable memory) */
	knows: string[];
	/** token split of this room's memory by layer */
	composition: MemoryComposition;
	/** measured usage payoff for this room, or null if it has no logged turns */
	payoff: RoomPayoff | null;
}

/** Memory token split by layer. "Deep memory" in the UI means `deep` ONLY. */
export interface MemoryComposition {
	/** the Deep Memory section — distilled knowledge */
	deep: number;
	/** Active Items — open threads and tasks */
	active: number;
	/** Recent Context — session summaries not yet absorbed */
	recent: number;
	/** Chronos — the chronological timeline spine */
	chronos: number;
}

/** A Recent Context session, sized in tokens (same unit as the memory map). */
export interface RecentSession {
	title: string;
	tokens: number;
	ts: number | null;
}

export interface MemoryOverview {
	generatedAt: number;
	totals: {
		rooms: number;
		l1bTokens: number;
		checkpoints: number;
		recentContextBacklog: number;
		roomsNeedingAbsorb: number;
		/** cross-room memory composition by layer */
		composition: MemoryComposition;
	};
	rooms: RoomMemorySummary[];
}

/** How developed a room's memory is — a heuristic from size + consolidations. */
export interface RoomMaturity {
	/** 0..3 */
	level: number;
	/** Forming | Practiced | Established | Deep */
	label: string;
	/** durable ÷ (durable + recent): how much memory is consolidated */
	consolidatedPct: number;
}

export interface RoomMemoryDetail extends RoomMemorySummary {
	l1aExists: boolean;
	/** the memory map: composition by area, with measured token weight */
	memoryMap: StructuralReviewMemoryMapRow[];
	/** the Recent Context sessions, newest first — sized in tokens */
	recentSessions: RecentSession[];
	/** how developed this room's memory is */
	maturity: RoomMaturity;
}

const MATURITY_LABELS = ["Forming", "Practiced", "Established", "Deep"];

function roomMaturity(summary: RoomMemorySummary): RoomMaturity {
	const { deep, recent } = summary.composition;
	// Depth grows with consolidations and deep knowledge; recent-only memory
	// counts less because it hasn't been distilled yet.
	const score = summary.checkpoints + deep / 200;
	const level = score < 2 ? 0 : score < 6 ? 1 : score < 15 ? 2 : 3;
	return {
		level,
		label: MATURITY_LABELS[level],
		consolidatedPct: deep + recent > 0 ? deep / (deep + recent) : 0,
	};
}

// --- disk readers (defensive: a room may have no checkpoints or no L1b yet) ---

function readCheckpoints(id: string): CheckpointEventRecord[] {
	let dir: string;
	try {
		dir = createPersistentAgentInstance(id).checkpointEventDir();
	} catch {
		return [];
	}
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return []; // no checkpoints yet
	}
	const records: CheckpointEventRecord[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			records.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as CheckpointEventRecord);
		} catch {
			// skip an unreadable/partial record rather than failing the whole room
		}
	}
	records.sort((a, b) => Date.parse(a.approvedAt) - Date.parse(b.approvedAt));
	return records;
}

// --- per-room usage join (read from the same usage.jsonl the dashboard uses) ---

interface UsageRow {
	ts: number;
	agent: string;
	input: number;
	cacheRead: number;
	cost: number;
}

/** Aggregate usage.jsonl per room (agent). Read once per request, defensively. */
function loadPayoffByRoom(): Map<string, RoomPayoff> {
	const file = productAppStatePath("usage.jsonl");
	const acc = new Map<string, { turns: number; cost: number; input: number; cacheRead: number }>();
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch {
		return new Map(); // no usage logged yet
	}
	for (const line of text.split("\n")) {
		if (!line) continue;
		let row: UsageRow;
		try {
			row = JSON.parse(line) as UsageRow;
		} catch {
			continue;
		}
		if (!row || typeof row.agent !== "string" || typeof row.ts !== "number") continue;
		let a = acc.get(row.agent);
		if (!a) acc.set(row.agent, (a = { turns: 0, cost: 0, input: 0, cacheRead: 0 }));
		a.turns += 1;
		a.cost += row.cost ?? 0;
		a.input += row.input ?? 0;
		a.cacheRead += row.cacheRead ?? 0;
	}
	const out = new Map<string, RoomPayoff>();
	for (const [room, a] of acc) {
		out.set(room, {
			turns: a.turns,
			totalCost: a.cost,
			costPerTurn: a.turns > 0 ? a.cost / a.turns : 0,
			cacheHitRate: a.cacheRead + a.input > 0 ? a.cacheRead / (a.cacheRead + a.input) : 0,
		});
	}
	return out;
}

interface RoomL1bInfo {
	metrics: ReturnType<typeof structuralReviewMetrics> | null;
	composition: MemoryComposition;
	/** session titles in document order (oldest → newest) */
	sessionTitles: string[];
	/** key phrases (bold) from durable memory */
	knows: string[];
}

/** Structural section names — never useful as "knows about" chips. */
const KNOWS_STRUCTURAL = new Set(["deep memory", "active items", "recent context", "chronos", "memory"]);

/**
 * Pull distinct key phrases from durable memory as "knows about" chips: bold
 * phrases first (the strongest signal), then section headings as a fallback so
 * memories written without bold still get chips.
 */
function extractKnows(durable: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	const push = (raw: string) => {
		const phrase = raw.replace(/[\s.,;:]+$/, "").replace(/^[\s.,;:]+/, "").trim();
		const key = phrase.toLowerCase();
		if (phrase.length < 2 || phrase.length > 44 || seen.has(key) || KNOWS_STRUCTURAL.has(key)) return;
		seen.add(key);
		out.push(phrase);
	};
	for (const m of durable.matchAll(/\*\*([^*]+)\*\*/g)) {
		if (out.length >= 10) break;
		push(m[1]);
	}
	if (out.length < 4) {
		for (const m of durable.matchAll(/^#{2,6}\s+(.+?)\s*$/gm)) {
			if (out.length >= 10) break;
			push(m[1]);
		}
	}
	return out;
}

/** Body of one top-level (##) section, or null if absent. */
function topSectionBody(src: string, name: string): string | null {
	const headings = Array.from(src.matchAll(/^##\s+(.+?)\s*$/gm));
	for (let i = 0; i < headings.length; i++) {
		if (headings[i][1].trim().toLowerCase() !== name.toLowerCase()) continue;
		const start = (headings[i].index ?? 0) + headings[i][0].length;
		const end = i + 1 < headings.length ? (headings[i + 1].index ?? src.length) : src.length;
		return src.slice(start, end);
	}
	return null;
}

/** Read a room's L1b once and derive everything: total, composition, sessions. */
function readRoomL1bInfo(id: string): RoomL1bInfo {
	let l1b: string;
	try {
		l1b = createPersistentAgentInstance(id).readL1b();
	} catch {
		return { metrics: null, composition: { deep: 0, active: 0, recent: 0, chronos: 0 }, sessionTitles: [], knows: [] };
	}
	const metrics = structuralReviewMetrics(l1b);
	try {
		const parts = extractStructuralReviewSourceParts(l1b);
		const durable = structuralReviewMetrics(parts.sourceReviewTargetL1b).estimatedTokens;
		const deepBody = topSectionBody(parts.sourceReviewTargetL1b, "Deep Memory");
		const deep = deepBody !== null ? structuralReviewMetrics(deepBody).estimatedTokens : durable;
		return {
			metrics,
			composition: {
				deep,
				active: Math.max(0, durable - deep),
				recent: structuralReviewMetrics(parts.preservedRecentContext).estimatedTokens,
				chronos: structuralReviewMetrics(parts.preservedChronos).estimatedTokens,
			},
			sessionTitles: recentContextSessions(parts.preservedRecentContext).map((s) => s.title),
			knows: extractKnows(parts.sourceReviewTargetL1b),
		};
	} catch {
		// Legacy/malformed topology — everything counts as deep.
		return { metrics, composition: { deep: metrics.estimatedTokens, active: 0, recent: 0, chronos: 0 }, sessionTitles: [], knows: [] };
	}
}

/**
 * Split the Recent Context section into its individual sessions. Each entry is
 * a `### RC-#### | STATUS | date | Title` subsection; we surface a human title
 * and the session's current token size (same unit as the memory map).
 */
function recentContextSessions(recentContext: string): Array<{ title: string; tokens: number; ts: number | null }> {
	const headings = Array.from(recentContext.matchAll(/^###\s+(.+?)\s*$/gm));
	const out: Array<{ title: string; tokens: number; ts: number | null }> = [];
	for (let i = 0; i < headings.length; i++) {
		const start = headings[i].index ?? 0;
		const end = i + 1 < headings.length ? (headings[i + 1].index ?? recentContext.length) : recentContext.length;
		const body = recentContext.slice(start, end);
		// Heading like "RC-0004 | OPEN | 2026-07-07 | Finalized reading list". Prefer
		// the trailing human title; take the date from the entry itself (not a
		// guessed checkpoint), so any "ago" we show is factual.
		const cells = headings[i][1].split("|").map((s) => s.trim()).filter(Boolean);
		const title = cells.length >= 4 ? cells.slice(3).join(" | ") : headings[i][1].trim();
		let ts: number | null = null;
		const dateMatch = headings[i][1].match(/\d{4}-\d{2}-\d{2}/);
		if (dateMatch) {
			const parsed = Date.parse(dateMatch[0]);
			if (Number.isFinite(parsed)) ts = parsed;
		}
		out.push({ title, tokens: structuralReviewMetrics(body).estimatedTokens, ts });
	}
	return out;
}

/**
 * The full memory composition — everything the room carries, not just the
 * prune-target. `buildStructuralReviewMemoryMap` covers only Deep Memory +
 * Active Items (that map exists to prune stable memory); it deliberately omits
 * Recent Context (the un-absorbed session summaries — usually the bulk) and
 * Chronos (the timeline). We add those back. Recent Context stays a single
 * summarised row — the per-session detail lives in `recentSessions`.
 */
function buildFullMemoryMap(l1b: string): StructuralReviewMemoryMapRow[] {
	try {
		const parts = extractStructuralReviewSourceParts(l1b);
		// Top-level rows only — parent aggregates already include their subsections,
		// so keeping the "Parent / Child" rows too would double-count.
		const rows = buildStructuralReviewMemoryMap(parts.sourceReviewTargetL1b).filter((r) => !r.area.includes(" / "));
		const rc = structuralReviewMetrics(parts.preservedRecentContext);
		if (rc.estimatedTokens > 0) {
			const n = recentContextSessions(parts.preservedRecentContext).length;
			rows.push({ area: `Recent sessions · ${n} · not yet learned`, words: rc.words, estimatedTokens: rc.estimatedTokens });
		}
		const chronos = structuralReviewMetrics(parts.preservedChronos);
		if (chronos.estimatedTokens > 0) {
			rows.push({ area: "Timeline", words: chronos.words, estimatedTokens: chronos.estimatedTokens });
		}
		return rows;
	} catch {
		// Legacy/malformed topology — fall back to the review-target-only map.
		return structuralReviewMetrics(l1b).memoryMap;
	}
}

/** Read a room's L1b once and return its Recent Context sessions (doc order). */
function readRoomSessions(id: string): Array<{ title: string; tokens: number; ts: number | null }> {
	try {
		const parts = extractStructuralReviewSourceParts(createPersistentAgentInstance(id).readL1b());
		return recentContextSessions(parts.preservedRecentContext);
	} catch {
		return [];
	}
}

/**
 * Per-layer sizes measured at an event, from the event's stored snapshot.
 * `deep` is the Deep Memory section ONLY (events record per-section metrics);
 * older records without topLevel fall back to the coarser non-recent figure.
 */
function eventLayers(result: CheckpointEventRecord["result"]): { deep: number; recent: number } {
	const tl = result.sections?.topLevel;
	const deepSection = tl?.find((s) => s.title?.trim().toLowerCase() === "deep memory");
	return {
		deep: deepSection ? deepSection.estimatedTokens : (result.sections?.nonRecentContext?.estimatedTokens ?? result.estimatedTokens),
		recent: result.sections?.recentContext?.estimatedTokens ?? 0,
	};
}

function growthPoint(record: CheckpointEventRecord): MemoryGrowthPoint {
	const layers = eventLayers(record.result);
	return {
		ts: Date.parse(record.approvedAt) || 0,
		tokens: record.result.estimatedTokens,
		added: record.checkpoint.approvedEntry.chars,
		title: record.checkpoint.approvedEntry.title ?? null,
		kind: "checkpoint",
		consolidated: layers.deep,
		recent: layers.recent,
	};
}

/** Absorb (consolidation) events — read like checkpoints, for the growth series. */
function readAbsorbs(id: string): AbsorbEventRecord[] {
	let dir: string;
	try {
		dir = createPersistentAgentInstance(id).absorbEventDir();
	} catch {
		return [];
	}
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const records: AbsorbEventRecord[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			records.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as AbsorbEventRecord);
		} catch {
			// skip an unreadable record
		}
	}
	return records;
}

function absorbPoint(record: AbsorbEventRecord): MemoryGrowthPoint {
	const layers = eventLayers(record.result);
	return {
		ts: Date.parse(record.approvedAt) || 0,
		tokens: record.result.estimatedTokens,
		added: 0,
		title: "Learn",
		kind: "absorb",
		consolidated: layers.deep,
		recent: layers.recent,
	};
}

function readReviews(id: string): StructuralReviewEventRecord[] {
	let dir: string;
	try {
		dir = createPersistentAgentInstance(id).structuralReviewEventDir();
	} catch {
		return [];
	}
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const records: StructuralReviewEventRecord[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			records.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as StructuralReviewEventRecord);
		} catch {
			// skip an unreadable record
		}
	}
	return records;
}

function reviewPoint(record: StructuralReviewEventRecord): MemoryGrowthPoint {
	const layers = eventLayers(record.result);
	return {
		ts: Date.parse(record.approvedAt) || 0,
		tokens: record.result.estimatedTokens,
		added: record.structuralReview?.reviewTargetEstimatedTokenDelta ?? 0,
		title: "Review",
		kind: "review",
		consolidated: layers.deep,
		recent: layers.recent,
	};
}

/** Merged growth series: checkpoints + Learn (absorb) + Review (prune), oldest → newest. */
function growthSeries(id: string, checkpoints: CheckpointEventRecord[]): MemoryGrowthPoint[] {
	const points = [...checkpoints.map(growthPoint), ...readAbsorbs(id).map(absorbPoint), ...readReviews(id).map(reviewPoint)];
	points.sort((a, b) => a.ts - b.ts);
	return points;
}

function summarizeRoom(status: PersistentAgentStatus, payoffByRoom: Map<string, RoomPayoff>): RoomMemorySummary {
	const info = readRoomL1bInfo(status.id);
	const checkpoints = readCheckpoints(status.id);
	const lastCheckpointAt = status.memoryStatus.lastCheckpointAt
		? Date.parse(status.memoryStatus.lastCheckpointAt) || null
		: (checkpoints.length ? growthPoint(checkpoints[checkpoints.length - 1]).ts : null);
	const reviews = readReviews(status.id).map(reviewPoint).sort((a, b) => a.ts - b.ts);
	const lastReview = reviews.length ? reviews[reviews.length - 1] : null;
	return {
		id: status.id,
		displayName: status.displayName?.trim() || status.id,
		description: status.description,
		// Total = sum of the composition parts, so the bar and the total always
		// reconcile (no separately-rounded whole-file estimate that can drift).
		l1bTokens: info.composition.deep + info.composition.active + info.composition.recent + info.composition.chronos,
		areas: info.metrics?.memoryMap.length ?? status.l1b.sections.length,
		checkpoints: checkpoints.length,
		lastCheckpointAt,
		recentContextBacklog: status.memoryStatus.recentContextCount,
		needsAbsorb: status.status === "needs_absorb",
		series: growthSeries(status.id, checkpoints),
		lastReviewAt: lastReview ? lastReview.ts : null,
		lastReviewTokenDelta: lastReview ? lastReview.added : 0,
		sessions: info.sessionTitles.length,
		sessionsCap: status.memoryStatus.recentContextHardCap || 10,
		topics: info.sessionTitles.slice(-4).reverse(),
		knows: info.knows.filter((k) => {
			const kl = k.toLowerCase();
			return kl !== (status.displayName ?? "").toLowerCase() && kl !== status.id.toLowerCase();
		}).slice(0, 6),
		composition: info.composition,
		payoff: payoffByRoom.get(status.id) ?? null,
	};
}

// --- public builders (called by the routes) ---

export function buildMemoryOverview(): MemoryOverview {
	// listPersistentAgents() returns active (non-archived) rooms only.
	const payoffByRoom = loadPayoffByRoom();
	const rooms = listPersistentAgents().map((status) => summarizeRoom(status, payoffByRoom));
	// Heaviest memory first — that's where the signal is.
	rooms.sort((a, b) => b.l1bTokens - a.l1bTokens);
	return {
		generatedAt: Date.now(),
		totals: {
			rooms: rooms.length,
			l1bTokens: rooms.reduce((sum, r) => sum + r.l1bTokens, 0),
			checkpoints: rooms.reduce((sum, r) => sum + r.checkpoints, 0),
			recentContextBacklog: rooms.reduce((sum, r) => sum + r.recentContextBacklog, 0),
			roomsNeedingAbsorb: rooms.filter((r) => r.needsAbsorb).length,
			composition: {
				deep: rooms.reduce((sum, r) => sum + r.composition.deep, 0),
				active: rooms.reduce((sum, r) => sum + r.composition.active, 0),
				recent: rooms.reduce((sum, r) => sum + r.composition.recent, 0),
				chronos: rooms.reduce((sum, r) => sum + r.composition.chronos, 0),
			},
		},
		rooms,
	};
}

// --- local memory search: grep the durable memory, no model involved --------

export interface MemorySearchHit {
	roomId: string;
	room: string;
	/** nearest markdown heading above the match — the memory area */
	area: string;
	snippet: string;
}

/** Case-insensitive substring search over each room's L1b, section-aware. */
export function searchMemory(query: string, roomId?: string, limit = 25): MemorySearchHit[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const hits: MemorySearchHit[] = [];
	const rooms = listPersistentAgents().filter((s) => !roomId || s.id === roomId);
	for (const status of rooms) {
		let l1b: string;
		try {
			l1b = createPersistentAgentInstance(status.id).readL1b();
		} catch {
			continue; // no L1b to search
		}
		const room = status.displayName?.trim() || status.id;
		let area = "Start of memory";
		for (const rawLine of l1b.split("\n")) {
			const line = rawLine.trim();
			if (!line) continue;
			// Skip document metadata (schema comments etc.) — internals, not memory.
			if (line.startsWith("<!--")) continue;
			const heading = line.match(/^#{1,6}\s*(.+)$/);
			if (heading) {
				area = heading[1].trim();
				continue;
			}
			if (line.toLowerCase().includes(q)) {
				hits.push({ roomId: status.id, room, area, snippet: line.length > 240 ? line.slice(0, 240) + "…" : line });
				if (hits.length >= limit) return hits;
			}
		}
	}
	return hits;
}

// --- hivemind retrieval: assemble cross-room memory context for a question ---

const ASK_BUDGET_TOKENS = 12000;

const ASK_STOPWORDS = new Set(
	"the a an and or but of to in on for with is are was were be been being what which who whom whose how why when where do does did my your our their its about across into from at by as this that these those i you we they it me us them can could should would will".split(" "),
);

/** Content words from a question — used to rank rooms when memory exceeds budget. */
function queryTerms(question: string): string[] {
	return [...new Set((question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []))].filter((t) => !ASK_STOPWORDS.has(t));
}

/** Keep a room label safe as a prompt delimiter (no newlines / heading marks). */
function safeRoomLabel(name: string): string {
	return name.replace(/[\r\n#]+/g, " ").replace(/\s+/g, " ").trim() || "room";
}

export interface MemoryAskContext {
	context: string;
	/** room display names in scope for this answer */
	sources: string[];
}

/**
 * Gather memory across ALL rooms to answer a question (the "hivemind").
 * Hybrid: if every room's memory fits the budget, include it all (best
 * synthesis). Otherwise rank rooms by how well they match the question's
 * content words and include the most relevant, truncating to fit. Always
 * returns non-empty context when any memory exists. Read-only.
 */
export function buildMemoryAskContext(question: string, budgetTokens = ASK_BUDGET_TOKENS, roomIds?: string[]): MemoryAskContext {
	const scope = roomIds && roomIds.length ? new Set(roomIds) : null;
	const blocks: Array<{ room: string; text: string; tokens: number }> = [];
	for (const status of listPersistentAgents()) {
		if (scope && !scope.has(status.id)) continue;
		let text = "";
		try {
			const parts = extractStructuralReviewSourceParts(createPersistentAgentInstance(status.id).readL1b());
			text = `## Durable memory\n\n${parts.sourceReviewTargetL1b.trim()}\n\n## Recent sessions\n\n${parts.preservedRecentContext.trim()}`;
		} catch {
			try { text = createPersistentAgentInstance(status.id).readL1b(); } catch { continue; }
		}
		if (!text.trim()) continue;
		blocks.push({ room: safeRoomLabel(status.displayName?.trim() || status.id), text, tokens: structuralReviewMetrics(text).estimatedTokens });
	}
	if (blocks.length === 0) return { context: "", sources: [] };

	const render = (chosen: Array<{ room: string; text: string }>) => chosen.map((b) => `# Exxpert: ${b.room}\n\n${b.text}`).join("\n\n---\n\n");

	const total = blocks.reduce((sum, b) => sum + b.tokens, 0);
	if (total <= budgetTokens) {
		return { context: render(blocks), sources: blocks.map((b) => b.room) };
	}

	// Over budget — rank rooms by term-frequency match to the question.
	const terms = queryTerms(question);
	const scored = blocks
		.map((b) => {
			const lc = b.text.toLowerCase();
			const score = terms.reduce((s, t) => s + (lc.split(t).length - 1), 0);
			return { ...b, score };
		})
		.sort((a, z) => z.score - a.score || z.tokens - a.tokens);

	const picked: Array<{ room: string; text: string }> = [];
	let used = 0;
	for (const b of scored) {
		if (b.score === 0 && picked.length > 0) break; // once we have relevant rooms, don't pad with irrelevant ones
		const remaining = budgetTokens - used;
		if (remaining <= 250) break;
		if (b.tokens <= remaining) {
			picked.push({ room: b.room, text: b.text });
			used += b.tokens;
		} else {
			// truncate this room to fit the remaining budget rather than skip it
			picked.push({ room: b.room, text: b.text.slice(0, remaining * 4) + "\n\n…(truncated)" });
			used = budgetTokens;
			break;
		}
	}
	// Guarantee non-empty: if nothing scored/fit, include the largest room truncated.
	if (picked.length === 0) {
		const big = [...blocks].sort((a, z) => z.tokens - a.tokens)[0];
		picked.push({ room: big.room, text: big.text.slice(0, budgetTokens * 4) + "\n\n…(truncated)" });
	}
	return { context: render(picked), sources: picked.map((b) => b.room) };
}

// --- catch-up digest: what each room learned since a given timestamp --------

export interface DigestRoomChange {
	id: string;
	displayName: string;
	newCheckpoints: number;
	newReviews: number;
	addedChars: number;
	/** best-available human title of the most recent thing learned (or null) */
	title: string | null;
	/** the checkpoints since `since`, newest first — what was folded into memory */
	learned: MemoryGrowthPoint[];
}

export interface MemoryDigest {
	since: number;
	generatedAt: number;
	totals: { newCheckpoints: number; newReviews: number; roomsChanged: number; addedChars: number; topRoom: string | null };
	rooms: DigestRoomChange[];
}

export function buildMemoryDigest(sinceMs: number): MemoryDigest {
	const changes: DigestRoomChange[] = [];
	for (const status of listPersistentAgents()) {
		const points = readCheckpoints(status.id).map(growthPoint).filter((p) => p.ts >= sinceMs);
		const reviewsSince = readReviews(status.id).map(reviewPoint).filter((p) => p.ts >= sinceMs);
		if (points.length === 0 && reviewsSince.length === 0) continue;
		points.sort((a, b) => b.ts - a.ts); // newest first
		// Prefer the newest recent-context session title (a real, human label)
		// over the checkpoint's approvedEntry.title, which is often absent.
		const sessions = readRoomSessions(status.id);
		const title = (sessions.length ? sessions[sessions.length - 1].title : null) || points[0]?.title || null;
		changes.push({
			id: status.id,
			displayName: status.displayName?.trim() || status.id,
			newCheckpoints: points.length,
			newReviews: reviewsSince.length,
			addedChars: points.reduce((sum, p) => sum + p.added, 0),
			title,
			learned: points,
		});
	}
	// Biggest mover first.
	changes.sort((a, b) => b.addedChars - a.addedChars);
	return {
		since: sinceMs,
		generatedAt: Date.now(),
		totals: {
			newCheckpoints: changes.reduce((sum, c) => sum + c.newCheckpoints, 0),
			newReviews: changes.reduce((sum, c) => sum + c.newReviews, 0),
			roomsChanged: changes.length,
			addedChars: changes.reduce((sum, c) => sum + c.addedChars, 0),
			topRoom: changes[0]?.displayName ?? null,
		},
		rooms: changes,
	};
}

// --- read one memory area's content (for the click-to-read memory map) ------

export interface MemoryAreaContent {
	area: string;
	/** the section's body markdown, without its heading or schema comments */
	content: string;
}

/** Strip schema/HTML comments and a single leading heading line. */
function cleanAreaBody(text: string): string {
	return text
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/^\s*#{1,6}\s+.+$/m, "")
		.trim();
}

/**
 * Return the raw text of one memory area so the user can READ their memory,
 * not just measure it. Read-only. Areas match the memory map's top-level rows:
 * review-target sections (Deep Memory, Active Items, …) plus "Timeline".
 */
export function readMemoryArea(id: string, areaName: string): MemoryAreaContent | null {
	let l1b: string;
	try {
		l1b = createPersistentAgentInstance(id).readL1b();
	} catch {
		return null;
	}
	let parts: ReturnType<typeof extractStructuralReviewSourceParts>;
	try {
		parts = extractStructuralReviewSourceParts(l1b);
	} catch {
		return null;
	}
	if (areaName.trim().toLowerCase() === "timeline") {
		return { area: "Timeline", content: cleanAreaBody(parts.preservedChronos) };
	}
	// Split the review target into its top-level (##) sections and match by name.
	const src = parts.sourceReviewTargetL1b;
	const headings = Array.from(src.matchAll(/^##\s+(.+?)\s*$/gm));
	for (let i = 0; i < headings.length; i++) {
		const name = headings[i][1].trim();
		if (name.toLowerCase() !== areaName.trim().toLowerCase()) continue;
		const start = (headings[i].index ?? 0) + headings[i][0].length;
		const end = i + 1 < headings.length ? (headings[i + 1].index ?? src.length) : src.length;
		return { area: name, content: cleanAreaBody(src.slice(start, end)) };
	}
	return null;
}

export function buildRoomMemory(status: PersistentAgentStatus): RoomMemoryDetail {
	const summary = summarizeRoom(status, loadPayoffByRoom());
	let memoryMap: StructuralReviewMemoryMapRow[] = [];
	try {
		memoryMap = buildFullMemoryMap(createPersistentAgentInstance(status.id).readL1b());
	} catch {
		memoryMap = []; // no L1b to map
	}
	// Newest first, each carrying its own recorded date (or null) — no guessed
	// checkpoint pairing, so any time shown belongs to that session.
	const recentSessions: RecentSession[] = readRoomSessions(status.id)
		.reverse()
		.map((s) => ({ title: s.title, tokens: s.tokens, ts: s.ts }));
	return {
		...summary,
		l1aExists: status.l1a.exists,
		memoryMap,
		recentSessions,
		maturity: roomMaturity(summary),
	};
}
