import type {
	PersistentRoomScheduleCreateRequest,
	PersistentRoomScheduleJob,
	PersistentRoomScheduleType,
	PersistentRoomScheduleUpdateRequest,
} from "./types";

export const SCHEDULE_CREATE_TYPE_AUTO = "auto" as const;
export const SCHEDULE_DEFAULT_DAILY_TIME = "07:00";
export const SCHEDULE_DEFAULT_ONE_TIME_DELAY_COUNT = "2";
export const SCHEDULE_DEFAULT_ONE_TIME_DELAY_UNIT: ScheduleOneTimeDelayUnit = "hours";
export const SCHEDULE_DEFAULT_ONE_TIME_AT_DAY: ScheduleOneTimeAtDay = "today";

const MAX_DELAY_SECONDS = 366 * 24 * 60 * 60;

export type ScheduleAdvancedType = PersistentRoomScheduleType | typeof SCHEDULE_CREATE_TYPE_AUTO;
export type ScheduleRecurrenceMode = "daily" | "oneTime" | "advanced";
export type ScheduleOneTimeMode = "in" | "at";
export type ScheduleOneTimeDelayUnit = "minutes" | "hours" | "days";
export type ScheduleOneTimeAtDay = "today" | "tomorrow";

export interface ScheduleDailyRecurrenceDraft {
	time: string;
}

export interface ScheduleOneTimeInDraft {
	count: string;
	unit: ScheduleOneTimeDelayUnit;
}

export interface ScheduleOneTimeAtDraft {
	day: ScheduleOneTimeAtDay;
	time: string;
}

export interface ScheduleOneTimeRecurrenceDraft {
	mode: ScheduleOneTimeMode;
	in: ScheduleOneTimeInDraft;
	at: ScheduleOneTimeAtDraft;
}

export interface ScheduleAdvancedRecurrenceDraft {
	type: ScheduleAdvancedType;
	schedule: string;
}

export interface ScheduleRecurrenceDraft {
	mode: ScheduleRecurrenceMode;
	daily: ScheduleDailyRecurrenceDraft;
	oneTime: ScheduleOneTimeRecurrenceDraft;
	advanced: ScheduleAdvancedRecurrenceDraft;
}

export interface ParsedNativeTime {
	hour: number;
	minute: number;
}

export interface SchedulePayloadFields {
	type?: PersistentRoomScheduleType;
	schedule: string;
}

export type SchedulePayloadResult =
	| { ok: true; fields: SchedulePayloadFields; summary: string }
	| { ok: false; error: string };

export function createDefaultScheduleRecurrenceDraft(overrides: Partial<ScheduleRecurrenceDraft> = {}): ScheduleRecurrenceDraft {
	return {
		mode: overrides.mode ?? "daily",
		daily: {
			time: overrides.daily?.time ?? SCHEDULE_DEFAULT_DAILY_TIME,
		},
		oneTime: {
			mode: overrides.oneTime?.mode ?? "in",
			in: {
				count: overrides.oneTime?.in?.count ?? SCHEDULE_DEFAULT_ONE_TIME_DELAY_COUNT,
				unit: overrides.oneTime?.in?.unit ?? SCHEDULE_DEFAULT_ONE_TIME_DELAY_UNIT,
			},
			at: {
				day: overrides.oneTime?.at?.day ?? SCHEDULE_DEFAULT_ONE_TIME_AT_DAY,
				time: overrides.oneTime?.at?.time ?? SCHEDULE_DEFAULT_DAILY_TIME,
			},
		},
		advanced: {
			type: overrides.advanced?.type ?? SCHEDULE_CREATE_TYPE_AUTO,
			schedule: overrides.advanced?.schedule ?? "",
		},
	};
}

export function parseNativeTimeValue(value: string): ParsedNativeTime | null {
	const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
	return { hour, minute };
}

export function toNativeTimeValue(hour: number, minute: number): string {
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function formatNativeTimeSummary(value: string): string | null {
	const parsed = parseNativeTimeValue(value);
	if (!parsed) return null;
	return formatParsedTimeSummary(parsed);
}

export function formatParsedTimeSummary({ hour, minute }: ParsedNativeTime): string {
	const period = hour < 12 ? "AM" : "PM";
	const hour12 = hour % 12 === 0 ? 12 : hour % 12;
	return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

export function generateDailyCronSchedule(time: string): string | null {
	const parsed = parseNativeTimeValue(time);
	if (!parsed) return null;
	return `0 ${parsed.minute} ${parsed.hour} * * *`;
}

export function detectSimpleDailyCronSchedule(type: PersistentRoomScheduleType, schedule: string): string | null {
	if (type !== "cron") return null;
	const parts = schedule.trim().split(/\s+/);
	if (parts.length !== 6) return null;
	const [seconds, minuteValue, hourValue, dayOfMonth, month, dayOfWeek] = parts;
	if (seconds !== "0" || dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") return null;
	if (!/^\d+$/.test(minuteValue) || !/^\d+$/.test(hourValue)) return null;
	const minute = Number(minuteValue);
	const hour = Number(hourValue);
	if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
	return toNativeTimeValue(hour, minute);
}

export function generateOneTimeInSchedule(countValue: string, unit: ScheduleOneTimeDelayUnit): string | null {
	const count = parsePositiveInteger(countValue);
	if (count === null || !isSupportedDelayUnit(unit)) return null;
	return `+${count}${delayUnitSuffix(unit)}`;
}

export function generateOneTimeAtIsoSchedule(day: ScheduleOneTimeAtDay, time: string, now = new Date()): string | null {
	const date = resolveOneTimeAtDate(day, time, now);
	if (!date || date.getTime() <= now.getTime()) return null;
	return date.toISOString();
}

export function validateScheduleRecurrenceDraft(
	draft: ScheduleRecurrenceDraft,
	options: { allowAutoType?: boolean; now?: Date } = {},
): string | null {
	const now = options.now ?? new Date();
	switch (draft.mode) {
		case "daily": {
			if (!draft.daily.time) return "Choose a daily time.";
			if (!parseNativeTimeValue(draft.daily.time)) return "Daily time must be a valid hour and minute.";
			return null;
		}
		case "oneTime": {
			if (draft.oneTime.mode === "in") {
				const count = parsePositiveInteger(draft.oneTime.in.count);
				if (count === null) return "Enter a positive whole number for the delay.";
				if (!isSupportedDelayUnit(draft.oneTime.in.unit)) return "Choose minutes, hours, or days for the delay.";
				if (delayToSeconds(count, draft.oneTime.in.unit) > MAX_DELAY_SECONDS) return "Choose a delay of 366 days or less.";
				return null;
			}
			if (!draft.oneTime.at.time) return "Choose a time for this one-time schedule.";
			if (!parseNativeTimeValue(draft.oneTime.at.time)) return "One-time schedule time must be a valid hour and minute.";
			const date = resolveOneTimeAtDate(draft.oneTime.at.day, draft.oneTime.at.time, now);
			if (!date) return "Choose Today or Tomorrow and a valid time.";
			if (date.getTime() <= now.getTime()) return "That time has already passed today. Choose Tomorrow or a future time.";
			return null;
		}
		case "advanced": {
			if (!options.allowAutoType && draft.advanced.type === SCHEDULE_CREATE_TYPE_AUTO) return "Choose Once, Interval, or Cron for this advanced schedule.";
			if (!draft.advanced.schedule.trim()) return "Enter a schedule expression.";
			return null;
		}
		default: return "Choose when this task should run.";
	}
}

export function recurrenceDraftToScheduleFields(
	draft: ScheduleRecurrenceDraft,
	options: { allowAutoType?: boolean; now?: Date } = {},
): SchedulePayloadResult {
	const error = validateScheduleRecurrenceDraft(draft, options);
	if (error) return { ok: false, error };
	switch (draft.mode) {
		case "daily": {
			const schedule = generateDailyCronSchedule(draft.daily.time);
			const summary = formatScheduleRecurrenceDraftSummary(draft, options.now) ?? "Runs every day.";
			if (!schedule) return { ok: false, error: "Daily time must be a valid hour and minute." };
			return { ok: true, fields: { type: "cron", schedule }, summary };
		}
		case "oneTime": {
			const summary = formatScheduleRecurrenceDraftSummary(draft, options.now) ?? "Runs once.";
			if (draft.oneTime.mode === "in") {
				const schedule = generateOneTimeInSchedule(draft.oneTime.in.count, draft.oneTime.in.unit);
				if (!schedule) return { ok: false, error: "Enter a positive whole number for the delay." };
				return { ok: true, fields: { type: "once", schedule }, summary };
			}
			const schedule = generateOneTimeAtIsoSchedule(draft.oneTime.at.day, draft.oneTime.at.time, options.now);
			if (!schedule) return { ok: false, error: "That time has already passed today. Choose Tomorrow or a future time." };
			return { ok: true, fields: { type: "once", schedule }, summary };
		}
		case "advanced": {
			const type = draft.advanced.type === SCHEDULE_CREATE_TYPE_AUTO ? undefined : draft.advanced.type;
			const schedule = draft.advanced.schedule.trim();
			return { ok: true, fields: { ...(type ? { type } : {}), schedule }, summary: formatAdvancedScheduleSummary(draft.advanced.type, schedule) };
		}
	}
}

export function recurrenceDraftToCreateRequestFields(
	draft: ScheduleRecurrenceDraft,
	options: { now?: Date } = {},
): SchedulePayloadResult {
	return recurrenceDraftToScheduleFields(draft, { ...options, allowAutoType: true });
}

export function recurrenceDraftToUpdateRequestFields(
	draft: ScheduleRecurrenceDraft,
	options: { now?: Date } = {},
): SchedulePayloadResult {
	return recurrenceDraftToScheduleFields(draft, { ...options, allowAutoType: false });
}

export function applyRecurrenceToCreateRequest(
	base: Omit<PersistentRoomScheduleCreateRequest, "type" | "schedule">,
	draft: ScheduleRecurrenceDraft,
	options: { now?: Date } = {},
): PersistentRoomScheduleCreateRequest | { error: string } {
	const result = recurrenceDraftToCreateRequestFields(draft, options);
	if (!result.ok) return { error: result.error };
	return { ...base, ...result.fields };
}

export function applyRecurrenceToUpdateRequest(
	base: Omit<PersistentRoomScheduleUpdateRequest, "type" | "schedule">,
	draft: ScheduleRecurrenceDraft,
	options: { now?: Date } = {},
): PersistentRoomScheduleUpdateRequest | { error: string } {
	const result = recurrenceDraftToUpdateRequestFields(draft, options);
	if (!result.ok) return { error: result.error };
	return { ...base, ...result.fields };
}

export function inferScheduleRecurrenceDraftFromJob(job: PersistentRoomScheduleJob, now = new Date()): ScheduleRecurrenceDraft {
	const advanced = { type: job.type, schedule: job.schedule };
	const dailyTime = detectSimpleDailyCronSchedule(job.type, job.schedule);
	if (dailyTime) {
		return createDefaultScheduleRecurrenceDraft({
			mode: "daily",
			daily: { time: dailyTime },
			advanced,
		});
	}
	const oneTimeAt = inferOneTimeAtDraft(job, now);
	if (oneTimeAt) {
		return createDefaultScheduleRecurrenceDraft({
			mode: "oneTime",
			oneTime: {
				mode: "at",
				in: {
					count: SCHEDULE_DEFAULT_ONE_TIME_DELAY_COUNT,
					unit: SCHEDULE_DEFAULT_ONE_TIME_DELAY_UNIT,
				},
				at: oneTimeAt,
			},
			advanced,
		});
	}
	return createDefaultScheduleRecurrenceDraft({
		mode: "advanced",
		advanced,
	});
}

export function formatScheduleRecurrenceDraftSummary(draft: ScheduleRecurrenceDraft, now = new Date()): string | null {
	switch (draft.mode) {
		case "daily": {
			const time = formatNativeTimeSummary(draft.daily.time);
			return time ? `Runs every day at ${time}.` : null;
		}
		case "oneTime": {
			if (draft.oneTime.mode === "in") {
				const count = parsePositiveInteger(draft.oneTime.in.count);
				if (count === null || !isSupportedDelayUnit(draft.oneTime.in.unit)) return null;
				return `Runs once in ${formatDelay(count, draft.oneTime.in.unit)}.`;
			}
			const error = validateScheduleRecurrenceDraft(draft, { now });
			if (error) return null;
			const time = formatNativeTimeSummary(draft.oneTime.at.time);
			if (!time) return null;
			return `Runs once ${draft.oneTime.at.day} at ${time}.`;
		}
		case "advanced": return formatAdvancedScheduleSummary(draft.advanced.type, draft.advanced.schedule);
	}
}

export function formatFriendlyWhenForJob(job: PersistentRoomScheduleJob, now = new Date()): string {
	const dailyTime = detectSimpleDailyCronSchedule(job.type, job.schedule);
	if (dailyTime) {
		const summary = formatNativeTimeSummary(dailyTime);
		if (summary) return `Every day at ${summary}.`;
	}
	const oneTimeAt = inferOneTimeAtDraft(job, now);
	if (oneTimeAt) {
		const summary = formatNativeTimeSummary(oneTimeAt.time);
		if (summary) return `Once ${oneTimeAt.day} at ${summary}.`;
	}
	return formatAdvancedScheduleSummary(job.type, job.schedule);
}

export function formatAdvancedScheduleSummary(type: ScheduleAdvancedType, schedule: string): string {
	const normalizedSchedule = schedule.trim();
	const typeLabel = type === SCHEDULE_CREATE_TYPE_AUTO ? "auto" : type;
	return normalizedSchedule ? `Custom schedule: ${typeLabel} ${normalizedSchedule}` : "Custom schedule.";
}

function inferOneTimeAtDraft(job: PersistentRoomScheduleJob, now: Date): ScheduleOneTimeAtDraft | null {
	if (job.type !== "once") return null;
	const date = new Date(job.schedule);
	if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) return null;
	const day = inferTodayOrTomorrow(date, now);
	if (!day) return null;
	return { day, time: toNativeTimeValue(date.getHours(), date.getMinutes()) };
}

function inferTodayOrTomorrow(date: Date, now: Date): ScheduleOneTimeAtDay | null {
	if (sameLocalDate(date, now)) return "today";
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	return sameLocalDate(date, tomorrow) ? "tomorrow" : null;
}

function sameLocalDate(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear()
		&& a.getMonth() === b.getMonth()
		&& a.getDate() === b.getDate();
}

function resolveOneTimeAtDate(day: ScheduleOneTimeAtDay, time: string, now: Date): Date | null {
	const parsed = parseNativeTimeValue(time);
	if (!parsed) return null;
	const date = new Date(now);
	if (day === "tomorrow") date.setDate(date.getDate() + 1);
	date.setHours(parsed.hour, parsed.minute, 0, 0);
	return date;
}

function parsePositiveInteger(value: string): number | null {
	if (!/^\d+$/.test(value.trim())) return null;
	const count = Number(value.trim());
	if (!Number.isSafeInteger(count) || count <= 0) return null;
	return count;
}

function isSupportedDelayUnit(unit: string): unit is ScheduleOneTimeDelayUnit {
	return unit === "minutes" || unit === "hours" || unit === "days";
}

function delayUnitSuffix(unit: ScheduleOneTimeDelayUnit): "m" | "h" | "d" {
	switch (unit) {
		case "minutes": return "m";
		case "hours": return "h";
		case "days": return "d";
	}
}

function delayToSeconds(count: number, unit: ScheduleOneTimeDelayUnit): number {
	switch (unit) {
		case "minutes": return count * 60;
		case "hours": return count * 60 * 60;
		case "days": return count * 24 * 60 * 60;
	}
}

function formatDelay(count: number, unit: ScheduleOneTimeDelayUnit): string {
	const singular = unit === "minutes" ? "minute" : unit === "hours" ? "hour" : "day";
	return `${count} ${count === 1 ? singular : unit}`;
}
