/**
 * MCP support, provided by pi-mcp-adapter.
 *
 * The adapter exposes every configured MCP server through a single `mcp`
 * proxy tool (search/describe/call). Transports: stdio, HTTP (StreamableHTTP
 * with SSE fallback), and OAuth-protected servers.
 *
 * The bare `/mcp` command opens OUR connectors panel (connectors-panel.ts) —
 * the adapter is used as a library there, matching the web Connectors page.
 * Subcommands (`/mcp setup`, `reconnect`, `logout`, …) and headless calls
 * delegate to the adapter's original handler, which we capture at
 * registration time.
 *
 * Server configuration is read from, in precedence order:
 *   ~/.config/mcp/mcp.json     shared user-global (Cursor/Claude compatible)
 *   ~/.exxperts/agent/mcp.json exxperts user-global
 *   .mcp.json                  project-local
 *   .pi/mcp.json               project override
 */

import * as os from "node:os";
import * as path from "node:path";

// Kept non-literal so tsc never resolves the specifiers into raw .ts sources,
// and so no tsconfig `paths` remap is needed — a remap would also be applied
// by tsx at runtime and break the real import.
const PI_MCP_ADAPTER_SPECIFIER = "pi-mcp-adapter" as string;
const ADAPTER_CONFIG_SPECIFIER = "pi-mcp-adapter/config.ts" as string;
const CONNECTORS_PANEL_SPECIFIER = "./connectors-panel.ts" as string;

interface RegisteredCommandLike {
	description?: string;
	handler: (args: string | undefined, ctx: unknown) => Promise<void> | void;
}

export default async function (pi: unknown) {
	// The adapter resolves its agent-global config dir from PI_CODING_AGENT_DIR
	// (defaulting to ~/.pi/agent); point it at the exxperts agent dir instead.
	if (!process.env.PI_CODING_AGENT_DIR) {
		process.env.PI_CODING_AGENT_DIR = path.join(os.homedir(), ".exxperts", "agent");
	}
	// Dynamic import: default-export interop differs between the jiti and tsx
	// loading paths — including a double `default` wrapper when this module
	// itself is loaded through an extension factory. Unwrap until callable.
	let register: unknown = await import(PI_MCP_ADAPTER_SPECIFIER);
	while (register && typeof register !== "function" && typeof (register as any).default !== "undefined") {
		register = (register as any).default;
	}
	if (typeof register !== "function") throw new Error("pi-mcp-adapter did not export a register function");

	// Capture the adapter's /mcp command so subcommands keep working after we
	// override the bare command with our own panel. Commands are stored per
	// extension keyed by name, so the later registration below wins.
	let adapterMcpCommand: RegisteredCommandLike | null = null;
	const api = pi as { registerCommand?: (name: string, options: RegisteredCommandLike) => void };
	const originalRegisterCommand = api.registerCommand?.bind(pi);
	if (originalRegisterCommand) {
		api.registerCommand = (name: string, options: RegisteredCommandLike) => {
			if (name === "mcp") adapterMcpCommand = options;
			// /mcp-auth duplicates the connectors panel's login (l); skip it.
			if (name === "mcp-auth") return;
			originalRegisterCommand(name, options);
		};
	}
	let result: unknown;
	try {
		result = await (register as (pi: unknown) => unknown)(pi);
	} finally {
		if (originalRegisterCommand) api.registerCommand = originalRegisterCommand;
	}

	// Fingerprint the connector list as loaded for this session, so the panel
	// can say when the on-disk config has drifted (rooms load config once).
	let sessionConfigKey: string | null = null;
	try {
		const [configMod, panelMod] = await Promise.all([import(ADAPTER_CONFIG_SPECIFIER), import(CONNECTORS_PANEL_SPECIFIER)]);
		sessionConfigKey = panelMod.connectorConfigKey(configMod.loadMcpConfig());
	} catch {
		// drift detection is best-effort
	}

	if (originalRegisterCommand && adapterMcpCommand) {
		const adapterHandler = (adapterMcpCommand as RegisteredCommandLike).handler;
		originalRegisterCommand("mcp", {
			description: "Manage MCP connectors (/mcp setup imports Cursor/Claude configs)",
			handler: async (args: string | undefined, ctx: unknown) => {
				const sub = args?.trim() ?? "";
				const hasUI = Boolean((ctx as { hasUI?: boolean }).hasUI);
				if (sub !== "" || !hasUI) {
					await adapterHandler(args, ctx);
					return;
				}
				const panelMod = await import(CONNECTORS_PANEL_SPECIFIER);
				const result = await panelMod.openConnectorsPanel(ctx as Parameters<typeof panelMod.openConnectorsPanel>[0], sessionConfigKey);
				if (result === "setup") await adapterHandler("setup", ctx);
			},
		});
	}

	return result;
}
