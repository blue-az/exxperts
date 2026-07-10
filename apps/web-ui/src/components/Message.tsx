import { memo, useId, useState } from "react";
import type { ChatItem } from "../types";
import { MarkdownRenderer, looksLikeMarkdown, unwrapOuterMarkdownFence } from "./Markdown";

/**
 * Compact, single-line preview of a tool call's key argument. Used as
 * the inline summary on the collapsed tool chip (Claude-Code style).
 */
function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

function summarizeOmittedContent(value: unknown): string {
	if (typeof value !== "string") return "[omitted]";
	return `[omitted: ${value.length} chars, ${utf8ByteLength(value)} bytes]`;
}

function sanitizedToolArgs(name: string, args: any): any {
	if (name !== "write_markdown_file" || !args || typeof args !== "object") return args ?? {};
	return {
		path: String(args.path ?? ""),
		content: summarizeOmittedContent(args.content),
		overwrite: args.overwrite === true,
	};
}

function domainOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

/**
 * The `mcp` proxy tool routes every connector interaction through one tool,
 * so the raw call reads as "mcp {json}". Surface what actually happened
 * instead: which remote tool, connect, search, or auth step.
 */
function mcpChipView(args: any): { name: string; summary: string } {
	const a = args && typeof args === "object" ? args : {};
	if (a.tool) {
		let inner = "";
		if (typeof a.args === "string" && a.args.trim()) {
			inner = a.args.trim();
		}
		const parts = [a.server ? String(a.server) : "", inner].filter(Boolean);
		return { name: `🔌 ${String(a.tool)}`, summary: parts.join(" · ").slice(0, 160) };
	}
	if (a.action === "auth-start" || a.action === "auth-complete") {
		return { name: "🔌 Connector login", summary: String(a.server ?? "") };
	}
	if (a.connect) return { name: "🔌 Connect", summary: String(a.connect) };
	if (a.search || a.regex) return { name: "🔌 Search connector tools", summary: String(a.search ?? a.regex ?? "") };
	if (a.describe) return { name: "🔌 Describe tool", summary: String(a.describe) };
	if (a.server) return { name: "🔌 List connector tools", summary: String(a.server) };
	return { name: "🔌 Connector status", summary: "" };
}

function summariseToolArgs(name: string, args: any): string {
	if (!args || typeof args !== "object") return "";
	if (name === "bash") return String(args.command ?? "").slice(0, 160);
	if (name === "write_markdown_file") {
		const path = String(args.path ?? "").slice(0, 120);
		const content = typeof args.content === "string" ? ` · ${args.content.length} chars/${utf8ByteLength(args.content)} bytes` : "";
		const overwrite = args.overwrite === true ? " · overwrite" : "";
		return `${path}${content}${overwrite}`.slice(0, 160);
	}
	if (name === "read" || name === "ls" || name === "find" || name === "grep" || name === "write" || name === "edit")
		return String(args.path ?? "").slice(0, 160);
	if (name === "fetch_url") return String(args.url ?? "").slice(0, 160);
	if (name === "web_search") return String(args.query ?? "").slice(0, 160);
	if (name.startsWith("kb_")) {
		const vault = args.vault ? `${args.vault}` : "default knowledge base";
		const p = args.path ? ` · ${args.path}` : "";
		const q = args.query ? ` · ${args.query}` : "";
		return `${vault}${p}${q}`.slice(0, 160);
	}
	try {
		const s = JSON.stringify(args);
		return s.length > 160 ? s.slice(0, 157) + "…" : s;
	} catch {
		return "";
	}
}

function ResultBody({ text }: { text: string }) {
	const unwrapped = unwrapOuterMarkdownFence(text);
	const trimmed = unwrapped.length > 20000 ? unwrapped.slice(0, 20000) + "\n\n…(truncated)" : unwrapped;
	if (looksLikeMarkdown(trimmed)) {
		return (
			<div className="md md-result">
				<MarkdownRenderer>{trimmed}</MarkdownRenderer>
			</div>
		);
	}
	return <pre className="raw-result">{trimmed}</pre>;
}

function UserMessageText({ text }: { text: string }) {
	const contentId = useId();
	const [expanded, setExpanded] = useState(false);
	const isLong = text.split(/\r\n|\r|\n/).length > 6 || text.length > 400;
	const folded = isLong && !expanded;

	return (
		<>
			<div
				id={contentId}
				className={`user-message-content ${folded ? "is-folded" : ""}`}
			>
				{text}
			</div>
			{isLong && (
				<button
					type="button"
					className="user-message-toggle"
					aria-expanded={expanded}
					aria-controls={contentId}
					onClick={() => setExpanded((value) => !value)}
				>
					{expanded ? "Show less" : "Show more"}
				</button>
			)}
		</>
	);
}

function MessageImpl({ item }: { item: ChatItem }) {
	if (item.kind === "system") {
		return <div className={`system-line ${item.level === "error" ? "error" : ""}`}>{item.text}</div>;
	}
	if (item.kind === "tool") {
		const summary = summariseToolArgs(item.name, item.args);
		const icon = item.status === "running" ? "…" : item.status === "error" ? "✗" : "✓";
		// fetch_url reads as a source: show the page title + domain (from the
		// result details) instead of the raw tool name and URL argument.
		const isFetchUrl = item.name === "fetch_url";
		const fetchUrl = isFetchUrl ? String(item.details?.finalUrl ?? item.args?.url ?? "") : "";
		const fetchDomain = fetchUrl ? domainOf(fetchUrl) : "";
		const mcpView = item.name === "mcp" ? mcpChipView(item.args) : null;
		// web_search reads as a lookup: show the query itself, not the tool name.
		const isWebSearch = item.name === "web_search";
		const searchQuery = isWebSearch ? String(item.args?.query ?? "").slice(0, 160) : "";
		const chipName = isFetchUrl
			? `🌐 ${String(item.details?.title || "Fetch URL")}`
			: isWebSearch
				? `🔍 ${searchQuery || "Web search"}`
				: mcpView ? mcpView.name : item.name;
		const chipSummary = isFetchUrl ? fetchDomain || summary : isWebSearch ? "" : mcpView ? mcpView.summary : summary;
		return (
			<div className="bubble-row">
				<details className={`tool-chip ${item.status}`}>
					<summary>
						<span className="icon">{icon}</span>
						<span className="name">{chipName}</span>
						{chipSummary && <span className="summary">{chipSummary}</span>}
						{item.status === "running" && <span className="spinner" />}
					</summary>
					<div className="chip-body">
						{summary && (
							<div className="chip-args">
								<span className="label">args</span>
								<pre>{JSON.stringify(sanitizedToolArgs(item.name, item.args), null, 2)}</pre>
							</div>
						)}
						{item.result && item.status !== "running" && (
							<div className="chip-result">
								<span className="label">{item.status === "error" ? "error" : "result"}</span>
								<ResultBody text={item.result} />
							</div>
						)}
					</div>
				</details>
			</div>
		);
	}

	const isUser = item.kind === "user";
	return (
		<div className={`bubble-row ${isUser ? "user" : ""}`}>
			<div className={`bubble ${isUser ? "user" : ""}`}>
				{isUser ? (
					<UserMessageText text={item.text} />
				) : (
					<div className="md assistant-markdown">
						<MarkdownRenderer renderMermaid={!(item as any).streaming}>{(item as any).text || ((item as any).streaming ? "…" : "")}</MarkdownRenderer>
					</div>
				)}
			</div>
		</div>
	);
}

export const Message = memo(MessageImpl);
