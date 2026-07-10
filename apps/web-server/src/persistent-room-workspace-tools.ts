import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type, type Static } from "typebox";
import * as XLSX from "xlsx";
import type { ToolDefinition } from "@exxeta/exxperts-runtime";
import { PERSISTENT_ROOM_MARKDOWN_WRITE_TOOL_NAME, PERSISTENT_ROOM_SPREADSHEET_READ_TOOL_NAME, isPersistentRoomWorkspaceToolBundleEnabled, persistentRoomWorkspaceToolNamesForPolicy } from "./persistent-room-tool-policy.js";
import type { PersistentRoomCapabilityPolicy, PersistentRoomWorkspaceRootGrant } from "./persistent-room-workspace-policy.js";
import { PERSISTENT_ROOM_DEFAULT_DENY_FILENAME_GLOBS, PERSISTENT_ROOM_DEFAULT_DENY_SEGMENTS } from "./persistent-room-workspace-policy.js";

const DEFAULT_READ_MAX_BYTES = 50 * 1024;
const DEFAULT_READ_MAX_LINES = 2000;
const DEFAULT_LS_LIMIT = 500;
const DEFAULT_FIND_LIMIT = 1000;
const MAX_FIND_LIMIT = 2000;
const MAX_FIND_VISITED = 10000;
const MAX_MARKDOWN_WRITE_BYTES = 128 * 1024;
const MAX_SPREADSHEET_BYTES = 10 * 1024 * 1024;
const DEFAULT_SPREADSHEET_MAX_ROWS = 30;
const MAX_SPREADSHEET_ROWS = 100;
const DEFAULT_SPREADSHEET_MAX_COLUMNS = 12;
const MAX_SPREADSHEET_COLUMNS = 30;
const MAX_SPREADSHEET_CELL_CHARS = 500;
const MAX_SPREADSHEET_OUTPUT_CHARS = 50 * 1024;

const workspaceReadSchema = Type.Object({
	path: Type.String({ description: "Workspace-relative path to the file to read. Absolute paths, ~, and .. traversal are not allowed." }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read." })),
});

const workspaceLsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Workspace-relative directory to list. Defaults to '.', the selected workspace root." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)." })),
});

const workspaceFindSchema = Type.Object({
	pattern: Type.String({ description: "Glob pattern for files under the selected workspace, e.g. '*.md', '**/*.json', or 'src/**/*.ts'." }),
	path: Type.Optional(Type.String({ description: "Workspace-relative directory to search in. Defaults to '.', the selected workspace root." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matching files to return (default: 1000)." })),
});

const workspaceWriteMarkdownSchema = Type.Object({
	path: Type.String({ description: "Workspace-relative path for the Markdown file to create or explicitly overwrite. Must end in .md. Absolute paths, ~, and .. traversal are not allowed." }),
	content: Type.String({ description: "Markdown content to write. UTF-8 byte length must be <= 128 KiB." }),
	overwrite: Type.Optional(Type.Boolean({ description: "Defaults to false. Existing files are rejected unless overwrite is true." })),
});

const workspaceReadSpreadsheetSchema = Type.Object({
	path: Type.String({ description: "Path to the .xlsx workbook to read. In Bounded workspace mode this must be workspace-relative; in Full access mode relative paths resolve from the selected workspace/current working directory and absolute paths or ~ are allowed." }),
	sheet: Type.Optional(Type.Union([
		Type.String({ description: "Optional sheet name to preview." }),
		Type.Number({ description: "Optional 1-based sheet index to preview." }),
	])),
	maxRows: Type.Optional(Type.Number({ description: "Maximum rows to preview (default 30, hard cap 100)." })),
	maxColumns: Type.Optional(Type.Number({ description: "Maximum columns to preview (default 12, hard cap 30)." })),
});

type WorkspaceReadInput = Static<typeof workspaceReadSchema>;
type WorkspaceLsInput = Static<typeof workspaceLsSchema>;
type WorkspaceFindInput = Static<typeof workspaceFindSchema>;
type WorkspaceWriteMarkdownInput = Static<typeof workspaceWriteMarkdownSchema>;
type WorkspaceReadSpreadsheetInput = Static<typeof workspaceReadSpreadsheetSchema>;

type TextToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> | undefined };

type GuardPurpose = "read" | "list" | "find" | "write";

export interface PersistentRoomWorkspaceToolGuardResult {
	root: PersistentRoomWorkspaceRootGrant;
	rootRealpath: string;
	absolutePath: string;
	realpath: string;
	relativePath: string;
	pathForDisplay: string;
	stat: fs.Stats;
	lstat: fs.Stats;
}

interface PersistentRoomSpreadsheetPathResult {
	absolutePath: string;
	realpath: string;
	pathForDisplay: string;
	stat: fs.Stats;
}

interface PersistentRoomWorkspaceWriteTarget {
	root: PersistentRoomWorkspaceRootGrant;
	rootRealpath: string;
	absolutePath: string;
	parentAbsolutePath: string;
	relativePath: string;
	pathForDisplay: string;
	exists: boolean;
}

export class PersistentRoomWorkspaceToolError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "PersistentRoomWorkspaceToolError";
		this.code = code;
	}
}

interface WorkspaceToolPolicyRuntime {
	policy: PersistentRoomCapabilityPolicy;
	root: PersistentRoomWorkspaceRootGrant;
	rootRealpath: string;
	denySegments: string[];
	denyFilenameGlobs: string[];
}

function toolResult(text: string, details?: Record<string, unknown>): TextToolResult {
	return { content: [{ type: "text", text }], details: details && Object.keys(details).length > 0 ? details : undefined };
}

function normalizeSlashes(value: string): string {
	return value.replace(/\\/g, "/");
}

function toDisplayPath(relativePath: string): string {
	const normalized = normalizeSlashes(relativePath);
	return normalized === "" ? "." : normalized;
}

function splitWorkspacePath(value: string): string[] {
	return normalizeSlashes(value).split("/").filter((segment) => segment.length > 0 && segment !== ".");
}

function isPortableAbsolutePath(value: string): boolean {
	const normalized = normalizeSlashes(value);
	return path.isAbsolute(value) || normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) || /^\/\/[^/]/.test(normalized);
}

function sameOrDescendant(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRealpath(input: string): string | null {
	try {
		return fs.realpathSync.native(input);
	} catch {
		return null;
	}
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined || Number.isNaN(value)) return fallback;
	if (!Number.isFinite(value) || value < 1) return fallback;
	return Math.min(Math.floor(value), max);
}

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
	const normalized = normalizeSlashes(glob.trim());
	let source = "";
	for (let i = 0; i < normalized.length; i += 1) {
		const char = normalized[i];
		if (char === "*") {
			const next = normalized[i + 1];
			const afterNext = normalized[i + 2];
			if (next === "*") {
				if (afterNext === "/") {
					source += "(?:.*/)?";
					i += 2;
				} else {
					source += ".*";
					i += 1;
				}
			} else {
				source += "[^/]*";
			}
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += escapeRegex(char);
		}
	}
	return new RegExp(`^${source}$`);
}

function matchesGlob(value: string, glob: string): boolean {
	return globToRegExp(glob).test(normalizeSlashes(value));
}

function isSensitiveFilename(name: string, globs: readonly string[]): boolean {
	return globs.some((glob) => matchesGlob(name, glob));
}

function deniedSegmentIn(relativePath: string, denySegments: readonly string[]): boolean {
	const denied = new Set(denySegments);
	return splitWorkspacePath(relativePath).some((segment) => denied.has(segment));
}

function sensitiveFilenameIn(relativePath: string, denyFilenameGlobs: readonly string[]): boolean {
	return splitWorkspacePath(relativePath).some((segment) => isSensitiveFilename(segment, denyFilenameGlobs));
}

function assertPolicyPathAllowed(relativePath: string, runtime: WorkspaceToolPolicyRuntime): void {
	if (deniedSegmentIn(relativePath, runtime.denySegments) || sensitiveFilenameIn(relativePath, runtime.denyFilenameGlobs)) {
		throw new PersistentRoomWorkspaceToolError("blocked_by_policy", "Path is blocked by workspace policy.");
	}
}

function validateWorkspaceRelativeInput(rawPath: string, purpose: GuardPurpose): string {
	const trimmed = String(rawPath ?? "").trim();
	if (!trimmed) {
		throw new PersistentRoomWorkspaceToolError("missing_path", purpose === "read" || purpose === "write" ? "File path is required." : "Workspace path is required.");
	}
	if (trimmed.startsWith("~")) {
		throw new PersistentRoomWorkspaceToolError("home_path", "Path is outside the selected workspace.");
	}
	if (isPortableAbsolutePath(trimmed)) {
		throw new PersistentRoomWorkspaceToolError("absolute_path", "Path is outside the selected workspace.");
	}
	const normalized = normalizeSlashes(trimmed);
	if (normalized.includes("\0") || splitWorkspacePath(normalized).some((segment) => segment === "..")) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}
	return normalized || ".";
}

function createRuntime(policy: PersistentRoomCapabilityPolicy): WorkspaceToolPolicyRuntime | null {
	if (!isPersistentRoomWorkspaceToolBundleEnabled(policy) || policy.modes.read !== true || policy.roots.length < 1) return null;
	const root = policy.roots[0];
	if (!root) return null;
	const rootRealpath = safeRealpath(root.realpath) ?? safeRealpath(root.path);
	if (!rootRealpath) return null;
	try {
		if (!fs.statSync(rootRealpath).isDirectory()) return null;
	} catch {
		return null;
	}
	return {
		policy,
		root,
		rootRealpath,
		denySegments: policy.denySegments.length > 0 ? [...policy.denySegments] : [...PERSISTENT_ROOM_DEFAULT_DENY_SEGMENTS],
		denyFilenameGlobs: policy.denyFilenameGlobs.length > 0 ? [...policy.denyFilenameGlobs] : [...PERSISTENT_ROOM_DEFAULT_DENY_FILENAME_GLOBS],
	};
}

export function isPersistentRoomWorkspaceToolPolicyEnabled(policy: PersistentRoomCapabilityPolicy | null | undefined): policy is PersistentRoomCapabilityPolicy {
	return Boolean(policy && createRuntime(policy));
}

export function resolvePersistentRoomWorkspacePath(
	policy: PersistentRoomCapabilityPolicy,
	rawPath: string,
	purpose: GuardPurpose,
): PersistentRoomWorkspaceToolGuardResult {
	const runtime = createRuntime(policy);
	if (!runtime) throw new PersistentRoomWorkspaceToolError("workspace_unavailable", "No selected workspace is available for this room.");
	const normalizedInput = validateWorkspaceRelativeInput(rawPath, purpose);
	assertPolicyPathAllowed(normalizedInput, runtime);
	const absolutePath = path.resolve(runtime.rootRealpath, normalizedInput === "." ? "" : normalizedInput);
	if (!sameOrDescendant(absolutePath, runtime.rootRealpath)) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}

	let lstat: fs.Stats;
	try {
		lstat = fs.lstatSync(absolutePath);
	} catch {
		throw new PersistentRoomWorkspaceToolError(purpose === "read" ? "file_not_found" : "path_not_found", purpose === "read" ? "File not found in selected workspace." : "Path not found in selected workspace.");
	}

	if ((purpose === "list" || purpose === "find") && lstat.isSymbolicLink()) {
		throw new PersistentRoomWorkspaceToolError("blocked_by_policy", "Path is blocked by workspace policy.");
	}

	const realpath = safeRealpath(absolutePath);
	if (!realpath || !sameOrDescendant(realpath, runtime.rootRealpath)) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}

	const relativeRealpath = path.relative(runtime.rootRealpath, realpath);
	if (relativeRealpath.startsWith("..") || path.isAbsolute(relativeRealpath)) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}
	assertPolicyPathAllowed(relativeRealpath || ".", runtime);

	let stat: fs.Stats;
	try {
		stat = fs.statSync(realpath);
	} catch {
		throw new PersistentRoomWorkspaceToolError(purpose === "read" ? "file_not_found" : "path_not_found", purpose === "read" ? "File not found in selected workspace." : "Path not found in selected workspace.");
	}

	return {
		root: runtime.root,
		rootRealpath: runtime.rootRealpath,
		absolutePath,
		realpath,
		relativePath: normalizeSlashes(relativeRealpath || "."),
		pathForDisplay: toDisplayPath(relativeRealpath),
		stat,
		lstat,
	};
}

function nearestExistingAncestor(startPath: string, rootRealpath: string): { absolutePath: string; lstat: fs.Stats } {
	let current = startPath;
	while (sameOrDescendant(current, rootRealpath)) {
		try {
			return { absolutePath: current, lstat: fs.lstatSync(current) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
			}
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
}

function assertNoSymlinkAncestors(runtime: WorkspaceToolPolicyRuntime, parentRelativePath: string): void {
	let current = runtime.rootRealpath;
	for (const segment of splitWorkspacePath(parentRelativePath)) {
		current = path.join(current, segment);
		let lstat: fs.Stats;
		try {
			lstat = fs.lstatSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
		}
		if (lstat.isSymbolicLink()) throw new PersistentRoomWorkspaceToolError("blocked_by_policy", "Path is blocked by workspace policy.");
		if (!lstat.isDirectory()) throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
		const realpath = safeRealpath(current);
		if (!realpath || !sameOrDescendant(realpath, runtime.rootRealpath)) {
			throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
		}
	}
}

export function resolvePersistentRoomWorkspaceWriteTarget(
	policy: PersistentRoomCapabilityPolicy,
	rawPath: string,
): PersistentRoomWorkspaceWriteTarget {
	const runtime = createRuntime(policy);
	if (!runtime) throw new PersistentRoomWorkspaceToolError("workspace_unavailable", "No selected workspace is available for this room.");
	const rawTrimmed = String(rawPath ?? "").trim();
	if (normalizeSlashes(rawTrimmed).endsWith("/")) {
		throw new PersistentRoomWorkspaceToolError("not_file", "Path is not a file in selected workspace.");
	}
	const normalizedInput = validateWorkspaceRelativeInput(rawTrimmed, "write");
	const normalizedTarget = normalizeSlashes(path.posix.normalize(normalizedInput));
	if (normalizedTarget === "." || path.posix.extname(normalizedTarget).toLowerCase() !== ".md") {
		throw new PersistentRoomWorkspaceToolError("unsupported_extension", "Only .md Markdown files can be written in the selected workspace.");
	}
	assertPolicyPathAllowed(normalizedTarget, runtime);

	const absolutePath = path.resolve(runtime.rootRealpath, normalizedTarget);
	if (!sameOrDescendant(absolutePath, runtime.rootRealpath)) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}
	const parentAbsolutePath = path.dirname(absolutePath);
	if (!sameOrDescendant(parentAbsolutePath, runtime.rootRealpath)) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}
	const parentRelativePath = normalizeSlashes(path.relative(runtime.rootRealpath, parentAbsolutePath) || ".");
	assertPolicyPathAllowed(parentRelativePath, runtime);

	const nearestAncestor = nearestExistingAncestor(parentAbsolutePath, runtime.rootRealpath);
	if (nearestAncestor.lstat.isSymbolicLink()) throw new PersistentRoomWorkspaceToolError("blocked_by_policy", "Path is blocked by workspace policy.");
	if (!nearestAncestor.lstat.isDirectory()) throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
	const ancestorRealpath = safeRealpath(nearestAncestor.absolutePath);
	if (!ancestorRealpath || !sameOrDescendant(ancestorRealpath, runtime.rootRealpath)) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}
	assertNoSymlinkAncestors(runtime, parentRelativePath);

	try {
		fs.mkdirSync(parentAbsolutePath, { recursive: true });
	} catch {
		throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
	}
	assertNoSymlinkAncestors(runtime, parentRelativePath);
	const parentRealpath = safeRealpath(parentAbsolutePath);
	if (!parentRealpath || !sameOrDescendant(parentRealpath, runtime.rootRealpath)) {
		throw new PersistentRoomWorkspaceToolError("outside_workspace", "Path is outside the selected workspace.");
	}
	assertPolicyPathAllowed(normalizeSlashes(path.relative(runtime.rootRealpath, parentRealpath) || "."), runtime);

	let targetLstat: fs.Stats | null = null;
	try {
		targetLstat = fs.lstatSync(absolutePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
		}
	}
	if (targetLstat?.isSymbolicLink()) throw new PersistentRoomWorkspaceToolError("blocked_by_policy", "Path is blocked by workspace policy.");
	if (targetLstat && !targetLstat.isFile()) throw new PersistentRoomWorkspaceToolError("not_file", "Path is not a file in selected workspace.");

	return {
		root: runtime.root,
		rootRealpath: runtime.rootRealpath,
		absolutePath,
		parentAbsolutePath,
		relativePath: normalizedTarget,
		pathForDisplay: toDisplayPath(normalizedTarget),
		exists: Boolean(targetLstat),
	};
}

function entryBlockedByPolicy(name: string, relativePath: string, runtime: WorkspaceToolPolicyRuntime): boolean {
	return deniedSegmentIn(relativePath, runtime.denySegments) || sensitiveFilenameIn(relativePath, runtime.denyFilenameGlobs) || isSensitiveFilename(name, runtime.denyFilenameGlobs);
}

async function executeWorkspaceLs(policy: PersistentRoomCapabilityPolicy, input: WorkspaceLsInput): Promise<TextToolResult> {
	const runtime = createRuntime(policy);
	if (!runtime) throw new PersistentRoomWorkspaceToolError("workspace_unavailable", "No selected workspace is available for this room.");
	const guarded = resolvePersistentRoomWorkspacePath(policy, input.path ?? ".", "list");
	if (!guarded.stat.isDirectory()) {
		throw new PersistentRoomWorkspaceToolError("not_directory", "Path is not a directory in selected workspace.");
	}
	const limit = normalizeLimit(input.limit, DEFAULT_LS_LIMIT, 2000);
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(guarded.realpath, { withFileTypes: true });
	} catch {
		throw new PersistentRoomWorkspaceToolError("not_readable", "Directory cannot be read in selected workspace.");
	}
	entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
	const output: string[] = [];
	let limitReached = false;
	for (const entry of entries) {
		if (output.length >= limit) {
			limitReached = true;
			break;
		}
		const entryRelative = guarded.relativePath === "." ? entry.name : `${guarded.relativePath}/${entry.name}`;
		if (entryBlockedByPolicy(entry.name, entryRelative, runtime)) continue;
		if (entry.isSymbolicLink()) {
			output.push(`${entry.name}@`);
			continue;
		}
		if (entry.isDirectory()) output.push(`${entry.name}/`);
		else if (entry.isFile()) output.push(entry.name);
	}
	if (output.length === 0) return toolResult("(empty directory)");
	let text = output.join("\n");
	const details: Record<string, unknown> = {};
	if (limitReached) {
		text += `\n\n[${limit} entries limit reached. Refine the path or increase limit.]`;
		details.entryLimitReached = limit;
	}
	return toolResult(text, details);
}

function findPatternMatcher(pattern: string): (relativeFilePath: string) => boolean {
	const normalizedPattern = normalizeSlashes(String(pattern ?? "").trim());
	if (!normalizedPattern) throw new PersistentRoomWorkspaceToolError("missing_pattern", "Find pattern is required.");
	const hasPathSeparator = normalizedPattern.includes("/");
	const regex = globToRegExp(normalizedPattern);
	return (relativeFilePath: string) => {
		const normalizedPath = normalizeSlashes(relativeFilePath);
		const value = hasPathSeparator ? normalizedPath : path.posix.basename(normalizedPath);
		return regex.test(value);
	};
}

async function executeWorkspaceFind(policy: PersistentRoomCapabilityPolicy, input: WorkspaceFindInput): Promise<TextToolResult> {
	const runtime = createRuntime(policy);
	if (!runtime) throw new PersistentRoomWorkspaceToolError("workspace_unavailable", "No selected workspace is available for this room.");
	const guarded = resolvePersistentRoomWorkspacePath(policy, input.path ?? ".", "find");
	if (!guarded.stat.isDirectory()) {
		throw new PersistentRoomWorkspaceToolError("not_directory", "Path is not a directory in selected workspace.");
	}
	const matches = findPatternMatcher(input.pattern);
	const limit = normalizeLimit(input.limit, DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT);
	const results: string[] = [];
	let visited = 0;
	let resultLimitReached = false;
	let traversalLimitReached = false;

	const walk = async (directoryRealpath: string, directoryRelativePath: string): Promise<void> => {
		if (resultLimitReached || traversalLimitReached) return;
		visited += 1;
		if (visited > MAX_FIND_VISITED) {
			traversalLimitReached = true;
			return;
		}
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(directoryRealpath, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
		for (const entry of entries) {
			if (results.length >= limit) {
				resultLimitReached = true;
				return;
			}
			const relativeEntryPath = directoryRelativePath === "." ? entry.name : `${directoryRelativePath}/${entry.name}`;
			if (entryBlockedByPolicy(entry.name, relativeEntryPath, runtime)) continue;
			const absoluteEntryPath = path.join(directoryRealpath, entry.name);
			let lstat: fs.Stats;
			try {
				lstat = await fs.promises.lstat(absoluteEntryPath);
			} catch {
				continue;
			}
			if (lstat.isSymbolicLink()) continue;
			if (lstat.isDirectory()) {
				await walk(absoluteEntryPath, normalizeSlashes(relativeEntryPath));
			} else if (lstat.isFile()) {
				const displayPath = normalizeSlashes(relativeEntryPath);
				if (matches(displayPath)) results.push(displayPath);
			}
		}
	};

	await walk(guarded.realpath, guarded.relativePath);
	if (results.length === 0) return toolResult("No files found matching pattern");
	let text = results.join("\n");
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (resultLimitReached) {
		details.resultLimitReached = limit;
		notices.push(`${limit} results limit reached. Refine pattern or path for more.`);
	}
	if (traversalLimitReached) {
		details.traversalLimitReached = MAX_FIND_VISITED;
		notices.push("workspace traversal limit reached. Refine pattern or path for more.");
	}
	if (notices.length > 0) text += `\n\n[${notices.join(" ")}]`;
	return toolResult(text, details);
}

function sliceReadLines(text: string, offset: number | undefined, limit: number | undefined): { text: string; nextOffset?: number; totalLines: number; startLine: number; endLine: number } {
	const lines = text.split("\n");
	const totalLines = lines.length;
	const startLine = offset === undefined ? 1 : Math.max(1, Math.floor(offset));
	if (!Number.isFinite(startLine) || startLine < 1 || startLine > totalLines) {
		throw new PersistentRoomWorkspaceToolError("invalid_offset", "Offset is outside the selected file.");
	}
	const maxLines = limit === undefined || !Number.isFinite(limit) || limit < 1 ? DEFAULT_READ_MAX_LINES : Math.min(Math.floor(limit), DEFAULT_READ_MAX_LINES);
	const startIndex = startLine - 1;
	const endIndex = Math.min(startIndex + maxLines, totalLines);
	return {
		text: lines.slice(startIndex, endIndex).join("\n"),
		nextOffset: endIndex < totalLines ? endIndex + 1 : undefined,
		totalLines,
		startLine,
		endLine: endIndex,
	};
}

function truncateReadBytes(text: string): { text: string; truncated: boolean } {
	const bytes = Buffer.byteLength(text, "utf-8");
	if (bytes <= DEFAULT_READ_MAX_BYTES) return { text, truncated: false };
	return { text: Buffer.from(text, "utf-8").subarray(0, DEFAULT_READ_MAX_BYTES).toString("utf-8"), truncated: true };
}

async function executeWorkspaceRead(policy: PersistentRoomCapabilityPolicy, input: WorkspaceReadInput): Promise<TextToolResult> {
	const guarded = resolvePersistentRoomWorkspacePath(policy, input.path, "read");
	if (!guarded.stat.isFile()) {
		throw new PersistentRoomWorkspaceToolError("not_file", "Path is not a file in selected workspace.");
	}
	let raw: string;
	try {
		raw = await fs.promises.readFile(guarded.realpath, "utf-8");
	} catch {
		throw new PersistentRoomWorkspaceToolError("not_readable", "File cannot be read in selected workspace.");
	}
	const sliced = sliceReadLines(raw, input.offset, input.limit);
	const truncated = truncateReadBytes(sliced.text);
	const notices: string[] = [];
	if (truncated.truncated) notices.push(`${DEFAULT_READ_MAX_BYTES / 1024}KB limit reached. Use offset to continue.`);
	if (sliced.nextOffset !== undefined) notices.push(`Showing lines ${sliced.startLine}-${sliced.endLine} of ${sliced.totalLines}. Use offset=${sliced.nextOffset} to continue.`);
	const output = notices.length > 0 ? `${truncated.text}\n\n[${notices.join(" ")}]` : truncated.text;
	return toolResult(output, { path: guarded.pathForDisplay, truncated: truncated.truncated || sliced.nextOffset !== undefined });
}

function extensionLowercase(displayPath: string): string {
	return path.posix.extname(normalizeSlashes(displayPath)).toLowerCase();
}

function expandLocalFilesPathInput(input: string): string {
	// os.homedir() honors HOME on POSIX but reads USERPROFILE on Windows —
	// preferring HOME directly would break under Git Bash's POSIX-style HOME.
	if (input === "~") return os.homedir();
	if (input.startsWith(`~${path.sep}`) || input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}

function localFilesSpreadsheetDisplayPath(rawPath: string, absolutePath: string, rootRealpath: string): string {
	const trimmed = String(rawPath ?? "").trim();
	if (trimmed && !isPortableAbsolutePath(trimmed) && !trimmed.startsWith("~")) return toDisplayPath(normalizeSlashes(path.posix.normalize(normalizeSlashes(trimmed))));
	const relativeToRoot = path.relative(rootRealpath, absolutePath);
	if (relativeToRoot && !relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot)) return toDisplayPath(relativeToRoot);
	return path.basename(absolutePath) || "workbook.xlsx";
}

function resolvePersistentRoomSpreadsheetPath(policy: PersistentRoomCapabilityPolicy, rawPath: string): PersistentRoomSpreadsheetPathResult {
	if (policy.workspaceAccessMode !== "localFiles") return resolvePersistentRoomWorkspacePath(policy, rawPath, "read");
	const runtime = createRuntime(policy);
	if (!runtime) throw new PersistentRoomWorkspaceToolError("workspace_unavailable", "No selected workspace is available for this room.");
	const trimmed = String(rawPath ?? "").trim();
	if (!trimmed) throw new PersistentRoomWorkspaceToolError("missing_path", "File path is required.");
	if (trimmed.includes("\0")) throw new PersistentRoomWorkspaceToolError("invalid_path", "File path is invalid.");
	const expanded = expandLocalFilesPathInput(trimmed);
	const absolutePath = isPortableAbsolutePath(expanded) ? path.resolve(expanded) : path.resolve(runtime.rootRealpath, expanded);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(absolutePath);
	} catch {
		throw new PersistentRoomWorkspaceToolError("file_not_found", "File not found.");
	}
	const realpath = safeRealpath(absolutePath) ?? absolutePath;
	return {
		absolutePath,
		realpath,
		pathForDisplay: localFilesSpreadsheetDisplayPath(trimmed, absolutePath, runtime.rootRealpath),
		stat,
	};
}

function workbookSheetRange(sheet: XLSX.WorkSheet | undefined): XLSX.Range | null {
	const ref = String(sheet?.["!ref"] ?? "").trim();
	if (!ref) return null;
	try {
		return XLSX.utils.decode_range(ref);
	} catch {
		return null;
	}
}

function rangeDimensions(range: XLSX.Range | null): { rows: number; columns: number } {
	if (!range) return { rows: 0, columns: 0 };
	return {
		rows: Math.max(0, range.e.r - range.s.r + 1),
		columns: Math.max(0, range.e.c - range.s.c + 1),
	};
}

function sheetDisplayName(value: string): string {
	return value.replace(/\r?\n/g, " ").slice(0, 80) || "(unnamed sheet)";
}

function resolveSpreadsheetSheetName(workbook: XLSX.WorkBook, requested: WorkspaceReadSpreadsheetInput["sheet"]): string {
	const sheetNames = workbook.SheetNames ?? [];
	if (sheetNames.length === 0) {
		throw new PersistentRoomWorkspaceToolError("empty_workbook", "Workbook does not contain readable sheets.");
	}
	if (requested === undefined || requested === null || String(requested).trim() === "") return sheetNames[0]!;
	if (typeof requested === "number") {
		const index = Math.floor(requested);
		if (!Number.isFinite(index) || index < 1 || index > sheetNames.length) {
			throw new PersistentRoomWorkspaceToolError("sheet_not_found", "Requested sheet was not found in the workbook.");
		}
		return sheetNames[index - 1]!;
	}
	const requestedName = String(requested).trim();
	const exact = sheetNames.find((name) => name === requestedName);
	if (exact) return exact;
	const lower = requestedName.toLowerCase();
	const caseInsensitive = sheetNames.find((name) => name.toLowerCase() === lower);
	if (caseInsensitive) return caseInsensitive;
	throw new PersistentRoomWorkspaceToolError("sheet_not_found", "Requested sheet was not found in the workbook.");
}

function spreadsheetCellText(cell: XLSX.CellObject | undefined): { text: string; formula: boolean; truncated: boolean } {
	if (!cell) return { text: "", formula: false, truncated: false };
	const formula = typeof (cell as any).f === "string" && (cell as any).f.length > 0;
	let value = "";
	if (typeof cell.w === "string") value = cell.w;
	else if (cell.v instanceof Date) value = cell.v.toISOString().slice(0, 10);
	else if (cell.v !== undefined && cell.v !== null) value = String(cell.v);
	else if (formula) value = "[formula; no cached value]";
	value = value.replace(/\r?\n/g, " ").trim();
	const truncated = value.length > MAX_SPREADSHEET_CELL_CHARS;
	if (truncated) value = `${value.slice(0, MAX_SPREADSHEET_CELL_CHARS)}…`;
	return { text: value, formula, truncated };
}

function markdownTableCell(value: string): string {
	return value.replace(/\|/g, "\\|");
}

function boundedSpreadsheetOutput(lines: string[]): { text: string; truncated: boolean } {
	const text = lines.join("\n");
	if (text.length <= MAX_SPREADSHEET_OUTPUT_CHARS) return { text, truncated: false };
	return {
		text: `${text.slice(0, MAX_SPREADSHEET_OUTPUT_CHARS)}\n\n[Output truncated at ${MAX_SPREADSHEET_OUTPUT_CHARS / 1024}KB. Use a smaller sheet/row/column preview.]`,
		truncated: true,
	};
}

function sheetContainsFormula(sheet: XLSX.WorkSheet | undefined): boolean {
	if (!sheet) return false;
	return Object.entries(sheet).some(([address, cell]) => !address.startsWith("!") && typeof (cell as any)?.f === "string" && (cell as any).f.length > 0);
}

async function executeWorkspaceReadSpreadsheet(policy: PersistentRoomCapabilityPolicy, input: WorkspaceReadSpreadsheetInput): Promise<TextToolResult> {
	const spreadsheetPath = resolvePersistentRoomSpreadsheetPath(policy, input.path);
	if (!spreadsheetPath.stat.isFile()) {
		throw new PersistentRoomWorkspaceToolError("not_file", policy.workspaceAccessMode === "localFiles" ? "Path is not a file." : "Path is not a file in selected workspace.");
	}
	if (extensionLowercase(spreadsheetPath.realpath) !== ".xlsx") {
		throw new PersistentRoomWorkspaceToolError("unsupported_extension", "Only .xlsx workbooks can be read with this tool.");
	}
	if (spreadsheetPath.stat.size > MAX_SPREADSHEET_BYTES) {
		throw new PersistentRoomWorkspaceToolError("file_too_large", "Workbook is too large for this tool.");
	}

	let workbook: XLSX.WorkBook;
	try {
		const buffer = await fs.promises.readFile(spreadsheetPath.realpath);
		workbook = XLSX.read(buffer, {
			type: "buffer",
			cellDates: true,
			cellFormula: true,
			cellHTML: false,
			cellNF: false,
			cellStyles: false,
		});
	} catch {
		throw new PersistentRoomWorkspaceToolError("not_readable", "Workbook cannot be read in selected workspace.");
	}

	const sheetName = resolveSpreadsheetSheetName(workbook, input.sheet);
	const sheet = workbook.Sheets[sheetName];
	const range = workbookSheetRange(sheet);
	const dimensions = rangeDimensions(range);
	const maxRows = normalizeLimit(input.maxRows, DEFAULT_SPREADSHEET_MAX_ROWS, MAX_SPREADSHEET_ROWS);
	const maxColumns = normalizeLimit(input.maxColumns, DEFAULT_SPREADSHEET_MAX_COLUMNS, MAX_SPREADSHEET_COLUMNS);
	const previewRows = Math.min(dimensions.rows, maxRows);
	const previewColumns = Math.min(dimensions.columns, maxColumns);
	const formulaDetected = sheetContainsFormula(sheet);
	let cellTruncated = false;

	const lines: string[] = [];
	const workbookName = path.posix.basename(normalizeSlashes(spreadsheetPath.pathForDisplay));
	lines.push(`# Spreadsheet preview: ${workbookName}`);
	lines.push("");
	lines.push(`Sheets (${workbook.SheetNames.length}):`);
	for (const [index, name] of workbook.SheetNames.entries()) {
		const sheetRange = workbookSheetRange(workbook.Sheets[name]);
		const sheetDimensions = rangeDimensions(sheetRange);
		lines.push(`- ${index + 1}. ${sheetDisplayName(name)} (${sheetDimensions.rows} rows × ${sheetDimensions.columns} columns)`);
	}
	lines.push("");
	lines.push(`Selected sheet: ${sheetDisplayName(sheetName)}`);
	lines.push(`Preview: ${previewRows} of ${dimensions.rows} rows, ${previewColumns} of ${dimensions.columns} columns.`);
	if (dimensions.rows > maxRows || dimensions.columns > maxColumns) {
		lines.push(`Truncated preview: row cap ${maxRows}, column cap ${maxColumns}.`);
	}
	if (formulaDetected) {
		lines.push("Warning: formula cells were detected. Formulas were not evaluated; cached/display values are shown where available.");
	}
	lines.push("");

	if (!range || previewRows === 0 || previewColumns === 0) {
		lines.push("(selected sheet is empty)");
	} else {
		const rows: string[][] = [];
		for (let row = range.s.r; row < range.s.r + previewRows; row += 1) {
			const values: string[] = [];
			for (let column = range.s.c; column < range.s.c + previewColumns; column += 1) {
				const address = XLSX.utils.encode_cell({ r: row, c: column });
				const cell = spreadsheetCellText(sheet?.[address]);
				if (cell.truncated) cellTruncated = true;
				values.push(markdownTableCell(cell.text));
			}
			rows.push(values);
		}
		const header = rows[0] ?? [];
		lines.push(`| ${header.join(" | ")} |`);
		lines.push(`| ${header.map(() => "---").join(" | ")} |`);
		for (const row of rows.slice(1)) lines.push(`| ${row.join(" | ")} |`);
	}
	if (cellTruncated) lines.push("\n[Some cell values were truncated to 500 characters.]");
	const bounded = boundedSpreadsheetOutput(lines);
	return toolResult(bounded.text, {
		path: spreadsheetPath.pathForDisplay,
		workbook: workbookName,
		sheet: sheetName,
		sheetCount: workbook.SheetNames.length,
		rows: dimensions.rows,
		columns: dimensions.columns,
		previewRows,
		previewColumns,
		formulaDetected,
		truncated: bounded.truncated || cellTruncated || dimensions.rows > maxRows || dimensions.columns > maxColumns,
	});
}

async function executeWorkspaceWriteMarkdown(policy: PersistentRoomCapabilityPolicy, input: WorkspaceWriteMarkdownInput): Promise<TextToolResult> {
	if (typeof input.content !== "string") {
		throw new PersistentRoomWorkspaceToolError("invalid_content", "Markdown content is required.");
	}
	const bytes = Buffer.byteLength(input.content, "utf-8");
	if (bytes > MAX_MARKDOWN_WRITE_BYTES) {
		throw new PersistentRoomWorkspaceToolError("content_too_large", "Markdown content is too large for this tool.");
	}
	const overwrite = input.overwrite === true;
	const target = resolvePersistentRoomWorkspaceWriteTarget(policy, input.path);
	if (target.exists && !overwrite) {
		throw new PersistentRoomWorkspaceToolError("file_exists", "File already exists in selected workspace. Set overwrite=true to replace it.");
	}
	try {
		if (overwrite) {
			let lstat: fs.Stats;
			try {
				lstat = await fs.promises.lstat(target.absolutePath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					await fs.promises.writeFile(target.absolutePath, input.content, { encoding: "utf-8", flag: "wx" });
					return toolResult(`file generated to ${target.pathForDisplay} (${bytes} bytes)`, {
						ok: true,
						path: target.pathForDisplay,
						bytes,
						created: true,
						overwritten: false,
					});
				}
				throw error;
			}
			if (lstat.isSymbolicLink()) throw new PersistentRoomWorkspaceToolError("blocked_by_policy", "Path is blocked by workspace policy.");
			if (!lstat.isFile()) throw new PersistentRoomWorkspaceToolError("not_file", "Path is not a file in selected workspace.");
			await fs.promises.writeFile(target.absolutePath, input.content, { encoding: "utf-8", flag: "w" });
			return toolResult(`file overwritten at ${target.pathForDisplay} (${bytes} bytes)`, {
				ok: true,
				path: target.pathForDisplay,
				bytes,
				created: false,
				overwritten: true,
			});
		}
		await fs.promises.writeFile(target.absolutePath, input.content, { encoding: "utf-8", flag: "wx" });
		return toolResult(`file generated to ${target.pathForDisplay} (${bytes} bytes)`, {
			ok: true,
			path: target.pathForDisplay,
			bytes,
			created: true,
			overwritten: false,
		});
	} catch (error) {
		if (error instanceof PersistentRoomWorkspaceToolError) throw error;
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new PersistentRoomWorkspaceToolError("file_exists", "File already exists in selected workspace. Set overwrite=true to replace it.");
		}
		throw new PersistentRoomWorkspaceToolError("not_writable", "File cannot be written in selected workspace.");
	}
}

export function createPersistentRoomWorkspaceTools(policy: PersistentRoomCapabilityPolicy): Array<ToolDefinition<any, any>> {
	if (!createRuntime(policy)) return [];
	const selectedToolNames = new Set(persistentRoomWorkspaceToolNamesForPolicy(policy));
	const readSpreadsheetTool: ToolDefinition<typeof workspaceReadSpreadsheetSchema, Record<string, unknown> | undefined> = {
		name: PERSISTENT_ROOM_SPREADSHEET_READ_TOOL_NAME,
		label: "workspace spreadsheet read",
		description: policy.workspaceAccessMode === "localFiles"
			? "Read a .xlsx workbook using Full access semantics and return a compact table preview. Relative paths resolve from the selected workspace/current working directory; absolute paths and ~ are allowed. Use sheet to select a sheet name or 1-based sheet index. Output is bounded by row, column, cell, file-size, and total-output limits. Formulas are not evaluated; cached/display values are shown where available."
			: "Read a .xlsx workbook under the selected persistent-room workspace only and return a compact table preview. Path must be workspace-relative; absolute paths, '~', and '..' traversal are rejected. Use sheet to select a sheet name or 1-based sheet index. Output is bounded by row, column, cell, file-size, and total-output limits. Formulas are not evaluated; cached/display values are shown where available.",
		promptSnippet: policy.workspaceAccessMode === "localFiles"
			? "Read .xlsx spreadsheets using Full access path semantics"
			: "Read selected-workspace .xlsx spreadsheets using workspace-relative paths only",
		parameters: workspaceReadSpreadsheetSchema,
		execute: async (_toolCallId, params) => executeWorkspaceReadSpreadsheet(policy, params),
	};
	if (policy.workspaceAccessMode === "localFiles") {
		return selectedToolNames.has(PERSISTENT_ROOM_SPREADSHEET_READ_TOOL_NAME) ? [readSpreadsheetTool] : [];
	}
	const lsTool: ToolDefinition<typeof workspaceLsSchema, Record<string, unknown> | undefined> = {
		name: "ls",
		label: "workspace ls",
		description: "List files and folders under the selected persistent-room workspace only. Paths are workspace-relative; '.' means the selected workspace root. Absolute paths, '~', and '..' traversal are rejected. Denied folders/files and secret-looking filenames are omitted. Symlinks are marked without dereferencing.",
		promptSnippet: "List selected-workspace directory contents using workspace-relative paths only",
		parameters: workspaceLsSchema,
		execute: async (_toolCallId, params) => executeWorkspaceLs(policy, params),
	};
	const findTool: ToolDefinition<typeof workspaceFindSchema, Record<string, unknown> | undefined> = {
		name: "find",
		label: "workspace find",
		description: "Find files under the selected persistent-room workspace only. Pattern and path are evaluated with workspace-relative paths; '.' means the selected workspace root. Absolute paths, '~', and '..' traversal are rejected. Denied directories/files are skipped, symlink directories are not followed, and output paths are workspace-relative.",
		promptSnippet: "Find selected-workspace files using workspace-relative paths only",
		parameters: workspaceFindSchema,
		execute: async (_toolCallId, params) => executeWorkspaceFind(policy, params),
	};
	const readTool: ToolDefinition<typeof workspaceReadSchema, Record<string, unknown> | undefined> = {
		name: "read",
		label: "workspace read",
		description: "Read a text file under the selected persistent-room workspace only. Path must be workspace-relative; absolute paths, '~', and '..' traversal are rejected. Denied directories/files and secret-looking filenames are blocked. Output is truncated safely; use offset/limit to continue large files.",
		promptSnippet: "Read selected-workspace text files using workspace-relative paths only",
		parameters: workspaceReadSchema,
		execute: async (_toolCallId, params) => executeWorkspaceRead(policy, params),
	};
	const writeMarkdownTool: ToolDefinition<typeof workspaceWriteMarkdownSchema, Record<string, unknown> | undefined> = {
		name: PERSISTENT_ROOM_MARKDOWN_WRITE_TOOL_NAME,
		label: "workspace Markdown write",
		description: "Create or explicitly overwrite a .md Markdown file under the selected persistent-room workspace only. Path must be workspace-relative and end in .md; absolute paths, '~', '..' traversal, denied folders/files, symlink targets, and paths outside the workspace are rejected. Parent directories may be created inside the workspace. Existing files are rejected unless overwrite=true. Ask before overwriting unless the user explicitly requested it. After success, tell the user the workspace-relative file path and do not paste the full written content.",
		promptSnippet: "Create or explicitly overwrite selected-workspace .md files only using workspace-relative paths",
		parameters: workspaceWriteMarkdownSchema,
		execute: async (_toolCallId, params) => executeWorkspaceWriteMarkdown(policy, params),
	};
	return [lsTool, findTool, readTool, writeMarkdownTool, readSpreadsheetTool].filter((tool) => selectedToolNames.has(String(tool.name)));
}
