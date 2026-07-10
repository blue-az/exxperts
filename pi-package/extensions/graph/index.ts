/**
 * Microsoft Graph tools.
 *
 * Auth strategy:
 *   1. EXXETA_GRAPH_TOKEN env var (dev shortcut)
 *   2. ~/.exxperts/app/auth.json written by the auth-entra extension
 *
 * If neither is present, every tool returns { isError: true } with a clear
 * "auth_required" message instructing the user to run /login-entra.
 *
 * The tools below are intentionally small and composable. Add more as your
 * use cases solidify; the skill files teach the model how to combine them.
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@exxeta/exxperts-runtime";
import { Type } from "typebox";
import { productAppStatePath } from "../../product-state-paths.js";

const AUTH_FILE = productAppStatePath("auth.json");

interface CachedAuth {
	access_token: string;
	expires_at: number; // ms epoch
	refresh_token?: string;
}

function loadCached(): CachedAuth | null {
	try {
		const raw = fs.readFileSync(AUTH_FILE, "utf-8");
		const j = JSON.parse(raw) as CachedAuth;
		if (j.expires_at && j.expires_at > Date.now() + 30_000) return j;
	} catch {}
	return null;
}

function getToken(): string | null {
	if (process.env.EXXETA_GRAPH_TOKEN) return process.env.EXXETA_GRAPH_TOKEN;
	const cached = loadCached();
	return cached?.access_token ?? null;
}

async function graphFetch(token: string, url: string, init: RequestInit = {}, signal?: AbortSignal) {
	const res = await fetch(url, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
		signal,
	});
	const text = await res.text();
	let body: any = text;
	try {
		body = JSON.parse(text);
	} catch {}
	return { ok: res.ok, status: res.status, body };
}

function authRequired() {
	return {
		content: [
			{
				type: "text" as const,
				text: "auth_required: no Microsoft Graph token. Run /login-entra (or set EXXETA_GRAPH_TOKEN in .env for dev).",
			},
		],
		details: { auth_required: true },
		isError: true,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "graph_mail_search",
		label: "Mail search",
		description:
			"Search the user's Outlook mail. `q` is a Graph $search expression (e.g. 'from:alice subject:invoice'). Returns up to `top` (default 10) recent matches.",
		parameters: Type.Object({ q: Type.String(), top: Type.Optional(Type.Number()) }),
		async execute(_id, params, signal) {
			const token = getToken();
			if (!token) return authRequired();
			const top = params.top ?? 10;
			const url = `https://graph.microsoft.com/v1.0/me/messages?$search="${encodeURIComponent(params.q)}"&$top=${top}&$select=subject,from,receivedDateTime,bodyPreview,webLink`;
			const r = await graphFetch(token, url, {}, signal);
			if (!r.ok) {
				return {
					content: [{ type: "text", text: `Graph error ${r.status}: ${JSON.stringify(r.body).slice(0, 500)}` }],
					details: { auth_required: false },
					isError: true,
				};
			}
			const items = (r.body.value ?? []).map((m: any) => ({
				subject: m.subject,
				from: m.from?.emailAddress?.address,
				received: m.receivedDateTime,
				preview: m.bodyPreview,
				link: m.webLink,
			}));
			return {
				content: [{ type: "text", text: `Found ${items.length} message(s).\n${JSON.stringify(items, null, 2)}` }],
				details: { auth_required: false, count: items.length, items },
			};
		},
	});

	pi.registerTool({
		name: "graph_calendar_list_today",
		label: "Today's calendar",
		description: "List the user's Outlook calendar events for today (local time).",
		parameters: Type.Object({}),
		async execute(_id, _p, signal) {
			const token = getToken();
			if (!token) return authRequired();
			const start = new Date();
			start.setHours(0, 0, 0, 0);
			const end = new Date(start);
			end.setDate(end.getDate() + 1);
			const url = `https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=${start.toISOString()}&endDateTime=${end.toISOString()}&$select=subject,organizer,start,end,attendees,onlineMeeting,bodyPreview&$orderby=start/dateTime`;
			const r = await graphFetch(token, url, {}, signal);
			if (!r.ok) {
				return {
					content: [{ type: "text", text: `Graph error ${r.status}: ${JSON.stringify(r.body).slice(0, 500)}` }],
					details: { auth_required: false },
					isError: true,
				};
			}
			const items = r.body.value ?? [];
			return {
				content: [{ type: "text", text: `${items.length} event(s) today:\n${JSON.stringify(items, null, 2)}` }],
				details: { auth_required: false, count: items.length, items },
			};
		},
	});

	pi.registerTool({
		name: "graph_teams_list_chats",
		label: "List Teams chats",
		description: "List the user's recent Teams chats (oneOnOne, group, meeting). Returns up to `top` (default 20).",
		parameters: Type.Object({ top: Type.Optional(Type.Number()) }),
		async execute(_id, params, signal) {
			const token = getToken();
			if (!token) return authRequired();
			const top = params.top ?? 20;
			const url = `https://graph.microsoft.com/v1.0/me/chats?$top=${top}&$expand=members&$orderby=lastUpdatedDateTime desc`;
			const r = await graphFetch(token, url, {}, signal);
			if (!r.ok) {
				return {
					content: [{ type: "text", text: `Graph error ${r.status}: ${JSON.stringify(r.body).slice(0, 500)}` }],
					details: { auth_required: false },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: JSON.stringify(r.body.value ?? [], null, 2) }],
				details: { auth_required: false, count: (r.body.value ?? []).length },
			};
		},
	});

	pi.registerTool({
		name: "graph_people_search",
		label: "People search",
		description: "Search Exxeta directory people the user knows or works with.",
		parameters: Type.Object({ q: Type.String() }),
		async execute(_id, params, signal) {
			const token = getToken();
			if (!token) return authRequired();
			const url = `https://graph.microsoft.com/v1.0/me/people?$search="${encodeURIComponent(params.q)}"&$top=10`;
			const r = await graphFetch(token, url, {}, signal);
			if (!r.ok) {
				return {
					content: [{ type: "text", text: `Graph error ${r.status}: ${JSON.stringify(r.body).slice(0, 500)}` }],
					details: { auth_required: false },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: JSON.stringify(r.body.value ?? [], null, 2) }],
				details: { auth_required: false, count: (r.body.value ?? []).length },
			};
		},
	});
}
