/**
 * Curated connector directory. Every endpoint here was live-verified against
 * the actual server (an MCP endpoint answers an initialize POST with 200, or
 * 401 when it wants OAuth/token auth) — keep it that way when adding entries.
 *
 * Order is the display order on both surfaces (web directory grid and the
 * CLI add view): most popular / highest value-add first, entries that need
 * manual setup last, so they sit next to the custom-connector card.
 *
 * kind:
 * - "open"   — works immediately, no login
 * - "oauth"  — one-click login (dynamic client registration verified)
 * - "token"  — needs an API token pasted once (no DCR support upstream)
 * - "guided" — needs own credentials/tenant setup; card links the guide
 */

export interface ConnectorCatalogEntry {
	id: string;
	name: string;
	description: string;
	kind: "open" | "oauth" | "token" | "guided";
	url?: string;
	tokenHint?: string;
	docsUrl?: string;
	guideNote?: string;
}

export const CONNECTOR_CATALOG: ConnectorCatalogEntry[] = [
	{
		id: "github",
		name: "GitHub",
		description: "Repositories, issues, pull requests, and code search.",
		kind: "token",
		url: "https://api.githubcopilot.com/mcp/",
		tokenHint: "GitHub personal access token",
		docsUrl: "https://github.com/github/github-mcp-server",
	},
	{
		id: "notion",
		name: "Notion",
		description: "Search and update pages and databases in your Notion workspace.",
		kind: "oauth",
		url: "https://mcp.notion.com/mcp",
	},
	{
		id: "atlassian",
		name: "Atlassian",
		description: "Jira issues and Confluence pages from your Atlassian sites.",
		kind: "oauth",
		url: "https://mcp.atlassian.com/v1/sse",
	},
	{
		id: "linear",
		name: "Linear",
		description: "Manage issues, projects, and cycles in Linear.",
		kind: "oauth",
		url: "https://mcp.linear.app/mcp",
	},
	{
		id: "context7",
		name: "Context7",
		description: "Up-to-date documentation for programming libraries.",
		kind: "open",
		url: "https://mcp.context7.com/mcp",
	},
	{
		id: "huggingface",
		name: "Hugging Face",
		description: "Search models, datasets, and papers.",
		kind: "open",
		url: "https://huggingface.co/mcp",
	},
	{
		id: "deepwiki",
		name: "DeepWiki",
		description: "Ask questions about any public GitHub repository.",
		kind: "open",
		url: "https://mcp.deepwiki.com/mcp",
	},
	{
		id: "figma",
		name: "Figma",
		description: "Bring Figma design context into your rooms.",
		kind: "oauth",
		url: "https://mcp.figma.com/mcp",
	},
	{
		id: "canva",
		name: "Canva",
		description: "Search, create, and export Canva designs.",
		kind: "oauth",
		url: "https://mcp.canva.com/mcp",
	},
	{
		id: "asana",
		name: "Asana",
		description: "Coordinate tasks, projects, and goals in Asana.",
		kind: "oauth",
		url: "https://mcp.asana.com/sse",
	},
	{
		id: "sentry",
		name: "Sentry",
		description: "Query errors and performance issues from Sentry.",
		kind: "oauth",
		url: "https://mcp.sentry.dev/mcp",
	},
	{
		id: "stripe",
		name: "Stripe",
		description: "Query customers, payments, and subscriptions in Stripe.",
		kind: "oauth",
		url: "https://mcp.stripe.com",
	},
	{
		id: "hubspot",
		name: "HubSpot",
		description: "CRM context: contacts, companies, and deals.",
		kind: "token",
		url: "https://app.hubspot.com/mcp/v1/http",
		tokenHint: "HubSpot private app access token",
		docsUrl: "https://developers.hubspot.com/mcp",
	},
	{
		id: "cloudflare-docs",
		name: "Cloudflare Docs",
		description: "Search Cloudflare's developer documentation.",
		kind: "open",
		url: "https://docs.mcp.cloudflare.com/mcp",
	},
	// Guided — need own credentials/tenant setup; kept last, next to Custom.
	{
		id: "google-drive",
		name: "Google Drive",
		description: "Search, read, and organize files in your Drive.",
		kind: "guided",
		guideNote: "Needs your own Google OAuth client — see the guide, then add it as a custom connector.",
		docsUrl: "https://developers.google.com/workspace/drive/api/guides/configure-mcp-server",
	},
	{
		id: "gmail",
		name: "Gmail",
		description: "Search threads, draft replies, and manage labels.",
		kind: "guided",
		guideNote: "Needs your own Google OAuth client — see the guide, then add it as a custom connector.",
		docsUrl: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
	},
	{
		id: "microsoft-365",
		name: "Microsoft 365",
		description: "Teams, SharePoint, OneDrive, and Outlook (Work IQ, preview).",
		kind: "guided",
		guideNote: "Per-tenant — needs Entra setup by your admin. See the guide, then add it as a custom connector.",
		docsUrl: "https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview",
	},
];
