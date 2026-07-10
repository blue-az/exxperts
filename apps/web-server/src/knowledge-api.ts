import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

interface KnowledgeBase {
	name: string;
	root: string;
	description?: string;
	source?: "config" | "env" | "auto";
}

const MAX_READ_BYTES = 180_000;
const MAX_TREE_FILES = 2000;
const MAX_SEARCH_FILES = 2000;
const IGNORE_DIRS = new Set([".git", ".obsidian", "node_modules", ".DS_Store", "dist", "build", "coverage"]);
const INDEX_FILE = "KB-INDEX.md";
const CONFIG_FILE = productAppStatePath("kb-vaults.json");
const MAX_PREFLIGHT_MARKDOWN_SCAN = 2000;
const MAX_INDEX_MARKDOWN_FILES = 500;
const INDEX_MARKER_START = "<!-- EXXPERTS-KB-INDEX:START -->";
const INDEX_MARKER_END = "<!-- EXXPERTS-KB-INDEX:END -->";
const NO_EXCERPT_FALLBACK = "No excerpt available. Add a short first paragraph to improve routing.";

interface KnowledgeConnectPreflightRequest {
	path?: unknown;
	indexPath?: unknown;
}

interface KnowledgeConnectRequest {
	path?: unknown;
	indexPath?: unknown;
	name?: unknown;
	description?: unknown;
}

interface KnowledgeDisconnectRequest {
	name?: unknown;
}

interface KnowledgeFileCreateRequest {
	base?: unknown;
	vault?: unknown;
	folder?: unknown;
	filename?: unknown;
	content?: unknown;
}

interface KnowledgeFileReplaceRequest {
	base?: unknown;
	vault?: unknown;
	path?: unknown;
	content?: unknown;
}

interface KnowledgeFileDeleteRequest {
	base?: unknown;
	vault?: unknown;
	path?: unknown;
}

interface KnowledgeIndexGenerateRequest {
	base?: unknown;
	vault?: unknown;
	dryRun?: unknown;
	confirm?: unknown;
}

interface KnowledgeConnectPreflightResponse {
	ok: boolean;
	folderPath: string;
	exists: boolean;
	isDirectory: boolean;
	readable: boolean;
	markdownFileCount: number;
	markdownFileCountCapped: boolean;
	indexPath: string;
	indexExists: boolean;
	suggestedName: string;
	error?: string;
}

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith(`~${path.sep}`)) return path.join(os.homedir(), p.slice(2));
	return p;
}

function slugName(s: string): string {
	return s.toLowerCase().replace(/^@[^/]+\//, "").replace(/-app$/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function normalizeBase(v: KnowledgeBase, source?: KnowledgeBase["source"]): KnowledgeBase {
	return {
		name: slugName(v.name),
		root: path.resolve(expandHome(v.root)),
		description: v.description ? String(v.description) : undefined,
		source: source ?? v.source,
	};
}

function loadConfigBases(): KnowledgeBase[] {
	if (!fs.existsSync(CONFIG_FILE)) return [];
	try {
		const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((v) => v?.name && v?.root)
			.map((v) => normalizeBase({ name: String(v.name), root: String(v.root), description: v.description ? String(v.description) : undefined }, "config"));
	} catch {
		return [];
	}
}

function saveConfigBases(bases: KnowledgeBase[]): void {
	const normalized = bases.map((v) => normalizeBase(v, "config")).map(({ name, root, description }) => ({
		name,
		root,
		...(description ? { description } : {}),
	}));
	fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalized, null, 2) + "\n", { mode: 0o600 });
}

function parseEnvBases(raw: string): KnowledgeBase[] {
	const out: KnowledgeBase[] = [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			for (const v of parsed) {
				if (v?.name && v?.root) out.push(normalizeBase({ name: String(v.name), root: String(v.root), description: v.description ? String(v.description) : undefined }, "env"));
			}
		} else if (typeof parsed === "object" && parsed) {
			for (const [name, root] of Object.entries(parsed)) out.push(normalizeBase({ name, root: String(root) }, "env"));
		}
	} catch {
		for (const part of raw.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
			const [name, ...rest] = part.split("=");
			const root = rest.join("=");
			if (name && root) out.push(normalizeBase({ name: name.trim(), root: root.trim() }, "env"));
		}
	}
	return out;
}

function listBases(): KnowledgeBase[] {
	const out = [...loadConfigBases()];
	const raw = process.env.EXXETA_KB_VAULTS?.trim();
	if (raw) out.push(...parseEnvBases(raw));

	const byRoot = new Map<string, KnowledgeBase>();
	for (const v of out) {
		const root = path.resolve(v.root);
		try {
			if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
		} catch {
			continue;
		}
		byRoot.set(root, { ...v, root });
	}
	return Array.from(byRoot.values());
}

function baseByName(name: string): KnowledgeBase | null {
	return listBases().find((base) => base.name === name) ?? null;
}

function hasIndex(base: KnowledgeBase): boolean {
	return fs.existsSync(path.join(base.root, INDEX_FILE));
}

function safeResolve(base: KnowledgeBase, rel = "."): string {
	const cleaned = rel.replace(/^\/+/, "");
	const full = path.resolve(base.root, cleaned);
	const root = path.resolve(base.root);
	if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`Path escapes knowledge-base root: ${rel}`);
	return full;
}

function relPath(base: KnowledgeBase, full: string): string {
	return path.relative(base.root, full).split(path.sep).join(path.posix.sep) || ".";
}

function isTextNote(file: string): boolean {
	return /\.(md|markdown|txt)$/i.test(file);
}

function isMarkdownNote(file: string): boolean {
	return /\.(md|markdown)$/i.test(file);
}

function countMarkdownFiles(root: string, limit = MAX_PREFLIGHT_MARKDOWN_SCAN): { count: number; capped: boolean } {
	let count = 0;
	let capped = false;
	const visit = (dir: string) => {
		if (capped) return;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (capped) break;
			if (IGNORE_DIRS.has(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(full);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!isMarkdownNote(entry.name)) continue;
			count++;
			if (count >= limit) {
				capped = true;
				break;
			}
		}
	};
	visit(root);
	return { count, capped };
}

function listTree(base: KnowledgeBase, limit = MAX_TREE_FILES) {
	const dirs = new Set<string>();
	const files: Array<{ path: string; size: number; mtimeMs: number; isIndex: boolean }> = [];
	const visit = (dir: string) => {
		if (files.length >= limit) return;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (files.length >= limit) break;
			if (IGNORE_DIRS.has(entry.name)) continue;
			const full = path.join(dir, entry.name);
			const rel = relPath(base, full);
			if (entry.isDirectory()) {
				dirs.add(rel);
				visit(full);
			} else if (entry.isFile() && isTextNote(entry.name)) {
				let stat: fs.Stats;
				try { stat = fs.statSync(full); } catch { continue; }
				files.push({ path: rel, size: stat.size, mtimeMs: stat.mtimeMs, isIndex: rel === INDEX_FILE });
			}
		}
	};
	visit(base.root);
	return { dirs: Array.from(dirs).sort(), files, truncated: files.length >= limit };
}

function readNote(base: KnowledgeBase, notePath: string) {
	const full = safeResolve(base, notePath);
	if (!fs.existsSync(full)) throw new Error(`Not found: ${notePath}`);
	if (!fs.statSync(full).isFile()) throw new Error(`Not a file: ${notePath}`);
	if (!isTextNote(full)) throw new Error("Only Markdown/text notes can be read.");
	const buf = fs.readFileSync(full);
	const truncated = buf.byteLength > MAX_READ_BYTES;
	return { text: buf.subarray(0, MAX_READ_BYTES).toString("utf-8"), truncated, size: buf.byteLength };
}

function walkFiles(base: KnowledgeBase, startRel = ".", limit = MAX_SEARCH_FILES): string[] {
	const start = safeResolve(base, startRel);
	const out: string[] = [];
	const visit = (dir: string) => {
		if (out.length >= limit) return;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (out.length >= limit) break;
			if (IGNORE_DIRS.has(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(full);
			else if (entry.isFile() && isTextNote(entry.name)) out.push(relPath(base, full));
		}
	};
	if (fs.existsSync(start) && fs.statSync(start).isDirectory()) visit(start);
	else if (fs.existsSync(start) && fs.statSync(start).isFile() && isTextNote(start)) out.push(relPath(base, start));
	return out;
}

function requireQuery(value: unknown, name: string): string {
	const text = String(value ?? "").trim();
	if (!text) throw new Error(`${name} is required`);
	return text;
}

function requireVaultName(body: Record<string, unknown>): string {
	const base = String(body.base ?? "").trim();
	const vault = String(body.vault ?? "").trim();
	const name = base || vault;
	if (!name) throw new Error("base or vault is required");
	return name;
}

function normalizeRelativeFolderPath(raw: string, base: KnowledgeBase): string {
	const trimmed = raw.trim();
	const normalized = trimmed.replace(/\\+/g, "/");
	const candidate = normalized || ".";
	const full = safeResolve(base, candidate);
	const rel = relPath(base, full);
	if (rel.startsWith("../") || rel.includes("/../")) throw new Error("Invalid folder path.");
	return rel;
}

function normalizeFilename(raw: string): string {
	const name = raw.trim().replace(/\\+/g, "/");
	if (!name) throw new Error("filename is required");
	if (name === "." || name === ".." || name.includes("/") || name.includes("\u0000")) throw new Error("filename must be a single file name");
	if (!isTextNote(name)) throw new Error("Only Markdown/text note files are allowed (.md, .markdown, .txt).");
	return name;
}

function shouldIgnoreIndexEntry(name: string): boolean {
	if (name.startsWith(".")) return true;
	return IGNORE_DIRS.has(name) || name === ".trash" || name === ".Trash" || name === ".DS_Store";
}

function indexFolderLabel(folder: string): string {
	return folder === "." ? "/" : folder;
}

function stripFrontmatter(text: string): string {
	if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return text;
	const lines = text.split(/\r?\n/);
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") { end = i; break; }
	}
	if (end < 0) return text;
	return lines.slice(end + 1).join("\n");
}

function compactLine(line: string): string {
	return line.replace(/\s+/g, " ").trim();
}

function parseIndexNote(raw: string, filename: string): { title: string; excerpt: string } {
	const body = stripFrontmatter(raw);
	const lines = body.split(/\r?\n/);
	const fallbackTitle = path.basename(filename, ".md");
	let title = fallbackTitle;
	let titleLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^#\s+(.+)$/);
		if (!m) continue;
		title = compactLine(m[1]) || fallbackTitle;
		titleLine = i;
		break;
	}
	const excerptLines: string[] = [];
	for (let i = Math.max(0, titleLine + 1); i < lines.length; i++) {
		const value = compactLine(lines[i]);
		if (!value) continue;
		if (/^#{1,6}\s+/.test(value)) continue;
		excerptLines.push(value);
		if (excerptLines.length >= 3) break;
	}
	const excerpt = excerptLines.length ? excerptLines.join(" ").slice(0, 240) : NO_EXCERPT_FALLBACK;
	return { title, excerpt };
}

function collectIndexEntries(base: KnowledgeBase): { folders: string[]; files: Array<{ rel: string; folder: string; link: string; title: string; excerpt: string }>; overflow: boolean } {
	const folders = new Set<string>(["."]);
	const files: Array<{ rel: string; folder: string; link: string; title: string; excerpt: string }> = [];
	let overflow = false;
	const visit = (dir: string) => {
		if (overflow) return;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (overflow) break;
			if (shouldIgnoreIndexEntry(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				folders.add(relPath(base, full));
				visit(full);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!entry.name.toLowerCase().endsWith(".md")) continue;
			if (entry.name.startsWith(".")) continue;
			if (files.length >= MAX_INDEX_MARKDOWN_FILES) { overflow = true; break; }
			const rel = relPath(base, full);
			const folder = path.posix.dirname(rel) === "." ? "." : path.posix.dirname(rel);
			const raw = fs.readFileSync(full, "utf-8");
			const { title, excerpt } = parseIndexNote(raw, entry.name);
			files.push({ rel, folder, link: rel.replace(/\.md$/i, ""), title, excerpt });
		}
	};
	visit(base.root);
	return { folders: Array.from(folders).sort(), files, overflow };
}

function renderGeneratedIndexBlock(base: KnowledgeBase): { generated: string; markdownFileCount: number; folderCount: number } {
	const collected = collectIndexEntries(base);
	if (collected.overflow) {
		throw new Error(`Knowledge base has more than ${MAX_INDEX_MARKDOWN_FILES} Markdown files. Narrow scope before generating an index.`);
	}
	const byFolder = new Map<string, Array<{ rel: string; link: string; title: string; excerpt: string }>>();
	for (const file of collected.files) {
		const list = byFolder.get(file.folder) ?? [];
		list.push(file);
		byFolder.set(file.folder, list);
	}
	for (const list of byFolder.values()) list.sort((a, b) => a.rel.localeCompare(b.rel));
	const sections: string[] = [];
	for (const folder of collected.folders) {
		sections.push(`### Folder: ${indexFolderLabel(folder)}`);
		const files = byFolder.get(folder) ?? [];
		if (!files.length) {
			sections.push("- (no Markdown notes)");
			continue;
		}
		for (const file of files) {
			sections.push(`- [[${file.link}]] — **${file.title}**: ${file.excerpt}`);
		}
	}
	return {
		generated: [
			INDEX_MARKER_START,
			"",
			"_Deterministic index generated from folder names, filenames, first H1 headings, and first non-empty lines._",
			"",
			"_To improve routing, edit source note first paragraphs or add manual notes outside this generated block._",
			"",
			...sections,
			"",
			INDEX_MARKER_END,
		].join("\n"),
		markdownFileCount: collected.files.length,
		folderCount: collected.folders.length,
	};
}

function buildDeterministicIndexPlan(base: KnowledgeBase): {
	mode: "created" | "replaced" | "appended";
	path: string;
	content: string;
	generated: string;
	markdownFileCount: number;
	folderCount: number;
} {
	const target = path.join(base.root, INDEX_FILE);
	const { generated, markdownFileCount, folderCount } = renderGeneratedIndexBlock(base);
	if (!fs.existsSync(target)) {
		return {
			mode: "created",
			path: target,
			content: `# Knowledge Base Index\n\n${generated}\n`,
			generated,
			markdownFileCount,
			folderCount,
		};
	}
	const existing = fs.readFileSync(target, "utf-8");
	const start = existing.indexOf(INDEX_MARKER_START);
	const end = existing.indexOf(INDEX_MARKER_END);
	if (start >= 0 && end > start) {
		return {
			mode: "replaced",
			path: target,
			content: `${existing.slice(0, start)}${generated}${existing.slice(end + INDEX_MARKER_END.length)}`,
			generated,
			markdownFileCount,
			folderCount,
		};
	}
	const separator = existing.endsWith("\n") ? "\n" : "\n\n";
	return {
		mode: "appended",
		path: target,
		content: `${existing}${separator}${generated}\n`,
		generated,
		markdownFileCount,
		folderCount,
	};
}

function writeDeterministicIndex(base: KnowledgeBase): {
	mode: "created" | "replaced" | "appended";
	path: string;
	markdownFileCount: number;
	folderCount: number;
	content: string;
} {
	const plan = buildDeterministicIndexPlan(base);
	fs.writeFileSync(plan.path, plan.content, "utf-8");
	return { mode: plan.mode, path: plan.path, markdownFileCount: plan.markdownFileCount, folderCount: plan.folderCount, content: plan.content };
}

function errorStatus(message: string): number {
	if (/required|invalid|more than 500/i.test(message)) return 400;
	if (/not found|no matching/i.test(message)) return 404;
	return 400;
}

export function registerKnowledgeApi(app: FastifyInstance): void {
	app.get("/api/knowledge/bases", async () => {
		const bases = listBases().map((base) => ({
			name: base.name,
			root: base.root,
			description: base.description,
			source: base.source,
			hasIndex: hasIndex(base),
			indexPath: INDEX_FILE,
		}));
		return { bases, configFile: CONFIG_FILE };
	});

	app.get("/api/knowledge/tree", async (req, reply) => {
		try {
			const query = req.query as Record<string, unknown>;
			const name = requireQuery(query.base, "base");
			const base = baseByName(name);
			if (!base) throw new Error(`No matching knowledge-base folder: ${name}`);
			const tree = listTree(base);
			return { base: base.name, root: base.root, indexPath: INDEX_FILE, hasIndex: hasIndex(base), ...tree };
		} catch (e) {
			return reply.code(errorStatus((e as Error).message)).send({ error: (e as Error).message });
		}
	});

	app.get("/api/knowledge/note", async (req, reply) => {
		try {
			const query = req.query as Record<string, unknown>;
			const name = requireQuery(query.base, "base");
			const notePath = requireQuery(query.path, "path");
			const base = baseByName(name);
			if (!base) throw new Error(`No matching knowledge-base folder: ${name}`);
			const note = readNote(base, notePath);
			return { base: base.name, path: notePath, content: note.text, truncated: note.truncated, size: note.size };
		} catch (e) {
			return reply.code(errorStatus((e as Error).message)).send({ error: (e as Error).message });
		}
	});

	app.get("/api/knowledge/search", async (req, reply) => {
		try {
			const query = req.query as Record<string, unknown>;
			const name = requireQuery(query.base, "base");
			const q = requireQuery(query.q, "q").toLowerCase();
			const searchPath = String(query.path ?? ".").trim() || ".";
			const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 100);
			const base = baseByName(name);
			if (!base) throw new Error(`No matching knowledge-base folder: ${name}`);
			const matches: Array<{ path: string; line: number; snippet: string }> = [];
			for (const file of walkFiles(base, searchPath)) {
				if (matches.length >= limit) break;
				let text = "";
				try { text = readNote(base, file).text; } catch { continue; }
				const lines = text.split(/\r?\n/);
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].toLowerCase().includes(q)) {
						matches.push({ path: file, line: i + 1, snippet: lines[i].trim().slice(0, 240) });
						break;
					}
				}
			}
			return { base: base.name, query: String(query.q ?? ""), matches };
		} catch (e) {
			return reply.code(errorStatus((e as Error).message)).send({ error: (e as Error).message });
		}
	});

	app.post("/api/knowledge/connect-preflight", async (req) => {
		const body = (req.body ?? {}) as KnowledgeConnectPreflightRequest;
		const inputPath = String(body.path ?? "").trim();
		const fallbackResolved = inputPath ? path.resolve(expandHome(inputPath)) : "";
		const suggestedName = (() => {
			const baseName = path.basename(fallbackResolved || inputPath || "").trim();
			if (baseName) return baseName;
			const cleaned = inputPath.trim().replace(/[\\/]+$/, "");
			return cleaned ? cleaned : "Knowledge base";
		})();

		const fail = (error: string): KnowledgeConnectPreflightResponse => ({
			ok: false,
			folderPath: fallbackResolved,
			exists: false,
			isDirectory: false,
			readable: false,
			markdownFileCount: 0,
			markdownFileCountCapped: false,
			indexPath: INDEX_FILE,
			indexExists: false,
			suggestedName,
			error,
		});

		if (!inputPath) return fail("Folder path is required.");
		if (/^[a-z]+:\/\//i.test(inputPath)) return fail("Folder path must be a local path.");

		try {
			const folderPath = path.resolve(expandHome(inputPath));
			const stat = fs.existsSync(folderPath) ? fs.statSync(folderPath) : null;
			const exists = !!stat;
			const isDirectory = !!stat?.isDirectory();
			const readable = (() => {
				if (!isDirectory) return false;
				try {
					fs.accessSync(folderPath, fs.constants.R_OK);
					return true;
				} catch {
					return false;
				}
			})();
			const normalizedIndexPath = INDEX_FILE;
			const indexFullPath = path.resolve(folderPath, INDEX_FILE);
			const indexExists = readable && fs.existsSync(indexFullPath) && fs.statSync(indexFullPath).isFile();
			const markdownStats = readable ? countMarkdownFiles(folderPath) : { count: 0, capped: false };

			const response: KnowledgeConnectPreflightResponse = {
				ok: exists && isDirectory && readable,
				folderPath,
				exists,
				isDirectory,
				readable,
				markdownFileCount: markdownStats.count,
				markdownFileCountCapped: markdownStats.capped,
				indexPath: normalizedIndexPath,
				indexExists,
				suggestedName: path.basename(folderPath) || suggestedName,
			};

			if (!exists) response.error = "Folder does not exist.";
			else if (!isDirectory) response.error = "Path is not a folder.";
			else if (!readable) response.error = "Folder is not readable.";
			return response;
		} catch (e) {
			return fail((e as Error).message || "Invalid folder path.");
		}
	});

	app.post("/api/knowledge/connect", async (req, reply) => {
		try {
			const body = (req.body ?? {}) as KnowledgeConnectRequest;
			const inputPath = String(body.path ?? "").trim();
			if (!inputPath) throw new Error("Folder path is required.");
			if (/^[a-z]+:\/\//i.test(inputPath)) throw new Error("Folder path must be a local path.");

			const folderPath = path.resolve(expandHome(inputPath));
			const stat = fs.existsSync(folderPath) ? fs.statSync(folderPath) : null;
			if (!stat) throw new Error("Folder does not exist.");
			if (!stat.isDirectory()) throw new Error("Path is not a folder.");
			try {
				fs.accessSync(folderPath, fs.constants.R_OK);
			} catch {
				throw new Error("Folder is not readable.");
			}

			const normalizedIndexPath = INDEX_FILE;
			const indexFullPath = path.resolve(folderPath, INDEX_FILE);
			const indexExists = fs.existsSync(indexFullPath) && fs.statSync(indexFullPath).isFile();
			const normalizedName = slugName(String(body.name ?? "").trim() || path.basename(folderPath));
			const description = String(body.description ?? "").trim() || undefined;

			const config = loadConfigBases();
			const byRoot = config.findIndex((v) => path.resolve(v.root) === folderPath);
			const byName = config.findIndex((v) => v.name === normalizedName);
			if (byName >= 0 && byRoot >= 0 && byName !== byRoot) {
				throw new Error(`A configured knowledge base named "${normalizedName}" already points to ${config[byName].root}. Choose another name.`);
			}

			const nextBase: KnowledgeBase = { name: normalizedName, root: folderPath, description, source: "config" };
			const next = byRoot >= 0
				? config.map((v, i) => i === byRoot ? nextBase : v)
				: [...config, nextBase];
			saveConfigBases(next);

			return {
				saved: true,
				vault: nextBase,
				hasIndex: indexExists,
				indexExists,
				indexPath: normalizedIndexPath,
				configFile: CONFIG_FILE,
			};
		} catch (e) {
			return reply.code(errorStatus((e as Error).message)).send({ error: (e as Error).message, saved: false, configFile: CONFIG_FILE });
		}
	});

	app.post("/api/knowledge/disconnect", async (req, reply) => {
		try {
			const body = (req.body ?? {}) as KnowledgeDisconnectRequest;
			const vaultName = slugName(String(body.name ?? "").trim());
			if (!vaultName) throw new Error("Vault name is required.");

			const config = loadConfigBases();
			const idx = config.findIndex((v) => v.name === vaultName);
			if (idx < 0) {
				const envVault = parseEnvBases(process.env.EXXETA_KB_VAULTS?.trim() || "").find((v) => v.name === vaultName);
				if (envVault) throw new Error(`Knowledge base "${vaultName}" is env-only and cannot be removed from persistent config.`);
				throw new Error(`No persistent knowledge base named "${vaultName}" found in ${CONFIG_FILE}.`);
			}

			const removed = config[idx];
			saveConfigBases(config.filter((_, i) => i !== idx));
			return { saved: true, removed, configFile: CONFIG_FILE };
		} catch (e) {
			return reply.code(errorStatus((e as Error).message)).send({ error: (e as Error).message, saved: false, configFile: CONFIG_FILE });
		}
	});

	app.post("/api/knowledge/file", async (req, reply) => {
		try {
			const body = (req.body ?? {}) as KnowledgeFileCreateRequest;
			const baseName = requireVaultName(body as Record<string, unknown>);
			const base = baseByName(baseName);
			if (!base) throw new Error(`No matching knowledge-base folder: ${baseName}`);

			const folder = normalizeRelativeFolderPath(String(body.folder ?? ""), base);
			const filename = normalizeFilename(String(body.filename ?? ""));
			const content = String(body.content ?? "");

			const folderFull = safeResolve(base, folder);
			if (!fs.existsSync(folderFull)) throw new Error(`Folder not found: ${folder}`);
			if (!fs.statSync(folderFull).isDirectory()) throw new Error(`Not a folder: ${folder}`);

			const full = safeResolve(base, path.posix.join(folder === "." ? "" : folder, filename));
			if (fs.existsSync(full)) throw new Error("File already exists.");

			fs.writeFileSync(full, content, "utf-8");
			const stat = fs.statSync(full);
			return { saved: true, vault: base.name, path: relPath(base, full), size: stat.size };
		} catch (e) {
			return reply.code(errorStatus((e as Error).message)).send({ error: (e as Error).message, saved: false });
		}
	});

	app.put("/api/knowledge/file", async (req, reply) => {
		try {
			const body = (req.body ?? {}) as KnowledgeFileReplaceRequest;
			const baseName = requireVaultName(body as Record<string, unknown>);
			const notePath = requireQuery(body.path, "path");
			const content = String(body.content ?? "");
			const base = baseByName(baseName);
			if (!base) throw new Error(`No matching knowledge-base folder: ${baseName}`);

			const full = safeResolve(base, notePath);
			if (!fs.existsSync(full)) throw new Error(`Not found: ${notePath}`);
			if (!fs.statSync(full).isFile()) throw new Error(`Not a file: ${notePath}`);
			if (!isTextNote(full)) throw new Error("Only Markdown/text notes can be edited.");

			fs.writeFileSync(full, content, "utf-8");
			const stat = fs.statSync(full);
			return { saved: true, vault: base.name, path: relPath(base, full), size: stat.size };
		} catch (e) {
			return reply.code(errorStatus((e as Error).message)).send({ error: (e as Error).message, saved: false });
		}
	});

	app.delete("/api/knowledge/file", async (req, reply) => {
		try {
			const body = (req.body ?? {}) as KnowledgeFileDeleteRequest;
			const baseName = requireVaultName(body as Record<string, unknown>);
			const notePath = requireQuery(body.path, "path");
			const base = baseByName(baseName);
			if (!base) throw new Error(`No matching knowledge-base folder: ${baseName}`);

			const full = safeResolve(base, notePath);
			if (!fs.existsSync(full)) throw new Error(`Not found: ${notePath}`);
			const stat = fs.statSync(full);
			if (!stat.isFile()) throw new Error("Only files can be deleted.");
			if (!isTextNote(full)) throw new Error("Only Markdown/text notes can be deleted.");

			fs.unlinkSync(full);
			return { saved: true, vault: base.name, path: relPath(base, full) };
		} catch (e) {
			return reply.code(errorStatus((e as Error).message)).send({ error: (e as Error).message, saved: false });
		}
	});

	app.post("/api/knowledge/index", async (req, reply) => {
		try {
			const body = (req.body ?? {}) as KnowledgeIndexGenerateRequest;
			const baseName = requireVaultName(body as Record<string, unknown>);
			const base = baseByName(baseName);
			if (!base) throw new Error(`No matching knowledge-base folder: ${baseName}`);
			const confirm = body.confirm === true;
			if (!confirm) {
				const plan = buildDeterministicIndexPlan(base);
				return {
					saved: false,
					preview: true,
					vault: base.name,
					indexPath: INDEX_FILE,
					targetPath: plan.path,
					mode: plan.mode,
					markdownFileCount: plan.markdownFileCount,
					folderCount: plan.folderCount,
					content: plan.content,
				};
			}
			const result = writeDeterministicIndex(base);
			return {
				saved: true,
				vault: base.name,
				indexPath: INDEX_FILE,
				targetPath: result.path,
				mode: result.mode,
				markdownFileCount: result.markdownFileCount,
				folderCount: result.folderCount,
				content: result.content,
			};
		} catch (e) {
			return reply.code(errorStatus((e as Error).message)).send({ error: (e as Error).message, saved: false });
		}
	});
}
