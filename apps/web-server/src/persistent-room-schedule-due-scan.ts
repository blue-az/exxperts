import { findBackgroundRunByScheduledOccurrence } from "./background-runs.js";
import type { BackgroundRunStatus } from "./background-runs.js";
import { createScheduledPromptBackgroundRunPreflight } from "./scheduled-prompt-runs.js";
import {
	computePersistentRoomScheduleDueOccurrence,
	readPersistentRoomScheduleStore,
	validatePersistentRoomScheduleRoomId,
} from "../../../pi-package/extensions/schedule-prompt/index.js";
import type { PersistentRoomScheduleType } from "../../../pi-package/extensions/schedule-prompt/index.js";

export interface ScanPersistentRoomScheduleDueRunsInput {
	roomId: unknown;
	now?: Date;
	dryRun?: boolean;
	limit?: unknown;
}

export interface PersistentRoomScheduleDueScanSummary {
	scanned: number;
	enabled: number;
	due: number;
	created: number;
	duplicates: number;
	skipped: number;
	notDue: number;
	unsupported: number;
	errors: number;
	queued: number;
	deferred: number;
	blocked: number;
}

export interface PersistentRoomScheduleDueScanItem {
	scheduleId: string;
	name: string;
	type: PersistentRoomScheduleType;
	dueAt?: string;
	action: "created" | "duplicate" | "dry_run" | "skipped" | "not_due" | "error";
	reason: string;
	runId?: string;
	runStatus?: BackgroundRunStatus;
	duplicateRunId?: string;
}

export interface PersistentRoomScheduleDueScanResult {
	roomId: string;
	now: string;
	dryRun: boolean;
	limit: number;
	summary: PersistentRoomScheduleDueScanSummary;
	items: PersistentRoomScheduleDueScanItem[];
}

const DEFAULT_DUE_SCAN_LIMIT = 25;
const MAX_DUE_SCAN_LIMIT = 100;

function emptySummary(): PersistentRoomScheduleDueScanSummary {
	return {
		scanned: 0,
		enabled: 0,
		due: 0,
		created: 0,
		duplicates: 0,
		skipped: 0,
		notDue: 0,
		unsupported: 0,
		errors: 0,
		queued: 0,
		deferred: 0,
		blocked: 0,
	};
}

function normalizeNow(now: Date | undefined): Date {
	const date = now ? new Date(now) : new Date();
	if (Number.isNaN(date.getTime())) throw new Error("invalid schedule due scan reference time");
	return date;
}

function normalizeLimit(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_DUE_SCAN_LIMIT;
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("invalid schedule due scan limit");
	return Math.min(limit, MAX_DUE_SCAN_LIMIT);
}

function normalizeIsoDateString(value: unknown, label: string): string {
	const date = new Date(String(value ?? "").trim());
	if (Number.isNaN(date.getTime())) throw new Error(`invalid schedule due scan ${label}`);
	return date.toISOString();
}

function countCreatedStatus(summary: PersistentRoomScheduleDueScanSummary, status: BackgroundRunStatus): void {
	if (status === "queued") summary.queued += 1;
	if (status === "deferred") summary.deferred += 1;
	if (status === "blocked") summary.blocked += 1;
}

function safeErrorMessage(error: unknown): string {
	const message = (error as Error)?.message ? String((error as Error).message) : String(error);
	return message.trim() || "unknown error";
}

export function scanPersistentRoomScheduleDueRuns(input: ScanPersistentRoomScheduleDueRunsInput): PersistentRoomScheduleDueScanResult {
	const roomId = validatePersistentRoomScheduleRoomId(input.roomId);
	const now = normalizeNow(input.now);
	const nowIso = now.toISOString();
	const dryRun = input.dryRun === true;
	const limit = normalizeLimit(input.limit);
	const summary = emptySummary();
	const result: PersistentRoomScheduleDueScanResult = {
		roomId,
		now: nowIso,
		dryRun,
		limit,
		summary,
		items: [],
	};

	let store;
	try {
		store = readPersistentRoomScheduleStore(roomId);
	} catch (error) {
		summary.errors += 1;
		return result;
	}

	for (const job of store.jobs) {
		summary.scanned += 1;
		if (!job.enabled) {
			summary.skipped += 1;
			result.items.push({
				scheduleId: job.id,
				name: job.name,
				type: job.type,
				action: "skipped",
				reason: "disabled",
			});
			continue;
		}
		summary.enabled += 1;

		const occurrence = computePersistentRoomScheduleDueOccurrence(job, { now });
		if (!occurrence.due) {
			if (occurrence.reason === "not_due") {
				summary.notDue += 1;
				result.items.push({
					scheduleId: job.id,
					name: job.name,
					type: job.type,
					action: "not_due",
					reason: "not_due",
				});
				continue;
			}
			if (occurrence.reason === "unsupported_cron_due_calculation") {
				summary.skipped += 1;
				summary.unsupported += 1;
				result.items.push({
					scheduleId: job.id,
					name: job.name,
					type: job.type,
					action: "skipped",
					reason: occurrence.reason,
				});
				continue;
			}
			summary.errors += 1;
			result.items.push({
				scheduleId: job.id,
				name: job.name,
				type: job.type,
				action: "error",
				reason: occurrence.reason,
			});
			continue;
		}

		const dueAt = normalizeIsoDateString(occurrence.dueAt, "dueAt");
		summary.due += 1;
		const duplicate = findBackgroundRunByScheduledOccurrence({ roomId, schedulerJobId: job.id, dueAt });
		if (duplicate) {
			summary.duplicates += 1;
			result.items.push({
				scheduleId: job.id,
				name: job.name,
				type: job.type,
				dueAt,
				action: "duplicate",
				reason: "duplicate_scheduled_occurrence",
				duplicateRunId: duplicate.runId,
			});
			continue;
		}
		if (dryRun) {
			result.items.push({
				scheduleId: job.id,
				name: job.name,
				type: job.type,
				dueAt,
				action: "dry_run",
				reason: "would_create",
			});
			continue;
		}
		if (summary.created >= limit) {
			summary.skipped += 1;
			result.items.push({
				scheduleId: job.id,
				name: job.name,
				type: job.type,
				dueAt,
				action: "skipped",
				reason: "limit_reached",
			});
			continue;
		}

		try {
			const preflight = createScheduledPromptBackgroundRunPreflight({
				roomId,
				scheduleJobId: job.id,
				trigger: "schedule-due",
				dueAt,
				now,
			});
			summary.created += 1;
			countCreatedStatus(summary, preflight.run.status);
			result.items.push({
				scheduleId: job.id,
				name: job.name,
				type: job.type,
				dueAt,
				action: "created",
				reason: preflight.run.reason ?? "created",
				runId: preflight.run.runId,
				runStatus: preflight.run.status,
			});
		} catch (error) {
			summary.errors += 1;
			result.items.push({
				scheduleId: job.id,
				name: job.name,
				type: job.type,
				dueAt,
				action: "error",
				reason: safeErrorMessage(error),
			});
		}
	}

	return result;
}
