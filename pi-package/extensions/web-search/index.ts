import * as fs from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@exxeta/exxperts-runtime";
import { productAppStatePath } from "../../product-state-paths.js";

type SearchProvider = "disabled" | "searxng";

// Setup command shown in user-facing messages, shell-appropriate per platform
// (the bash entry point does not run from PowerShell/cmd).
const SEARXNG_START = process.platform === "win32" ? "node scripts\\searxng.mjs start" : "./scripts/searxng start";

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

interface SearxngResult {
	title?: string;
	url?: string;
	content?: string;
}

// Shared web-search config in the user data dir. Written by `./scripts/searxng
// start` and read here, so search works the same whether the app is launched
// via the global `exxperts` command or the repo `./scripts/exxeta` — and it
// survives reinstalls. Environment variables still override it.
interface SharedSearchConfig {
	provider?: string;
	baseUrl?: string;
}

let sharedConfigCache: SharedSearchConfig | null | undefined;

function sharedConfig(): SharedSearchConfig {
	if (sharedConfigCache !== undefined) return sharedConfigCache ?? {};
	try {
		const file = productAppStatePath("web-search.json");
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
		sharedConfigCache = parsed && typeof parsed === "object" ? (parsed as SharedSearchConfig) : null;
	} catch {
		sharedConfigCache = null;
	}
	return sharedConfigCache ?? {};
}

function getProvider(): SearchProvider {
	const raw = String(process.env.EXXETA_SEARCH_PROVIDER || sharedConfig().provider || "disabled").trim().toLowerCase();
	return raw === "searxng" ? "searxng" : "disabled";
}

function clampLimit(limit: unknown): number {
	const n = Number(limit ?? 5);
	if (!Number.isFinite(n)) return 5;
	return Math.max(1, Math.min(10, Math.floor(n)));
}

function formatResults(query: string, results: SearchResult[]): string {
	if (results.length === 0) return `No web results for "${query}".`;
	return results
		.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Snippet: ${r.snippet}`)
		.join("\n\n");
}

async function searchSearxng(query: string, limit: number): Promise<SearchResult[]> {
	const baseUrl = process.env.EXXETA_SEARCH_BASE_URL || sharedConfig().baseUrl;
	if (!baseUrl) {
		throw new Error(`Web search is not configured. Run ${SEARXNG_START} to enable local web search, then restart the app.`);
	}

	const url = new URL(baseUrl.replace(/\/+$/, "") + "/search");
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");

	let res: Response;
	try {
		res = await fetch(url, { headers: { accept: "application/json" } });
	} catch (e) {
		throw new Error(`SearXNG search is not reachable at ${baseUrl}. Start it with ${SEARXNG_START} (and make sure the container engine is running). ${(e as Error).message}`);
	}
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`SearXNG search failed (${res.status} ${res.statusText}). ${body}`.trim());
	}

	const data = await res.json() as { results?: SearxngResult[] };
	return (data.results ?? []).slice(0, limit).map((r) => ({
		title: r.title || "Untitled",
		url: r.url || "",
		snippet: r.content || "",
	}));
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description:
			`Search the public web through a local SearXNG instance. Disabled until enabled with \`${SEARXNG_START}\`.`,
		promptSnippet:
			"Use `web_search` when the user asks for latest/current web information, market/client research, trends, or sourced briefings. Cite URLs in the final answer.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query." }),
			limit: Type.Optional(Type.Number({ description: "Maximum number of results to return. Default 5, max 10." })),
		}),
		async execute(_id, { query, limit = 5 }): Promise<any> {
			const provider = getProvider();
			const maxResults = clampLimit(limit);

			if (provider === "disabled") {
				return {
					content: [
						{
							type: "text",
							text: [
								"Web search is not configured.",
								`Run \`${SEARXNG_START}\` to enable local web search — it starts SearXNG and writes the config for you.`,
								"Then restart the app.",
							].join(" "),
						},
					],
					details: { configured: false, provider },
					isError: true,
				};
			}

			try {
				const results = await searchSearxng(query, maxResults);
				return {
					content: [{ type: "text", text: formatResults(query, results) }],
					details: { configured: true, provider, query, count: results.length, results },
				};
			} catch (e) {
				return {
					content: [{ type: "text", text: `Web search failed: ${(e as Error).message}` }],
					details: { configured: false, provider, error: (e as Error).message },
					isError: true,
				};
			}
		},
	});
}
