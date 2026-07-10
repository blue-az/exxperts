/**
 * Entra ID device-code auth for Microsoft Graph.
 *
 * Registers /login-entra and /logout-entra commands. On successful login,
 * writes ~/.exxperts/app/auth.json which the graph extension picks up.
 *
 * Requires:
 *   ENTRA_TENANT_ID  (or "common" / "organizations")
 *   ENTRA_CLIENT_ID  (your registered app)
 *
 * Scopes default to a sensible read-mostly set. Adjust as needed.
 *
 * Reference: https://learn.microsoft.com/azure/active-directory/develop/v2-oauth2-device-code
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@exxeta/exxperts-runtime";
import { productAppStatePath } from "../../product-state-paths.js";

const AUTH_FILE = productAppStatePath("auth.json");

const SCOPES = [
	"offline_access",
	"User.Read",
	"Mail.Read",
	"Mail.Send",
	"Calendars.ReadWrite",
	"Chat.Read",
	"People.Read",
	"Files.Read.All",
].join(" ");

interface DeviceCodeResp {
	user_code: string;
	device_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
	message: string;
}

interface TokenResp {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
	error?: string;
	error_description?: string;
}

function authority() {
	const tenant = process.env.ENTRA_TENANT_ID || "common";
	return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
}

async function startDeviceCode(clientId: string): Promise<DeviceCodeResp> {
	const res = await fetch(`${authority()}/devicecode`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: clientId, scope: SCOPES }),
	});
	if (!res.ok) throw new Error(`devicecode failed ${res.status}: ${await res.text()}`);
	return (await res.json()) as DeviceCodeResp;
}

async function pollToken(clientId: string, deviceCode: string, intervalSec: number, signal: AbortSignal) {
	while (!signal.aborted) {
		await new Promise((r) => setTimeout(r, intervalSec * 1000));
		const res = await fetch(`${authority()}/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: clientId,
				device_code: deviceCode,
			}),
		});
		const body = (await res.json()) as TokenResp;
		if (res.ok && body.access_token) return body;
		if (body.error === "authorization_pending") continue;
		if (body.error === "slow_down") {
			intervalSec += 5;
			continue;
		}
		throw new Error(body.error_description || body.error || `token poll failed ${res.status}`);
	}
	throw new Error("aborted");
}

function saveAuth(token: TokenResp) {
	fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		AUTH_FILE,
		JSON.stringify(
			{
				access_token: token.access_token,
				refresh_token: token.refresh_token,
				expires_at: Date.now() + (token.expires_in - 60) * 1000,
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("login-entra", {
		description: "Sign in to Microsoft Graph (device-code flow)",
		handler: async (_args, ctx) => {
			const clientId = process.env.ENTRA_CLIENT_ID;
			if (!clientId) {
				ctx.ui.notify(
					[
						"Entra setup needed:",
						"  1. Register an app in Entra ID with 'Allow public client flows' = Yes.",
						"  2. Add delegated permissions: User.Read, Mail.Read, Mail.Send, Calendars.ReadWrite, Chat.Read, People.Read, Files.Read.All.",
						"  3. Set ENTRA_CLIENT_ID and (optional) ENTRA_TENANT_ID in .env, then re-run.",
						"",
						"For dev shortcuts, set EXXETA_GRAPH_TOKEN to a token from the Graph Explorer.",
					].join("\n"),
					"warning",
				);
				return;
			}

			ctx.ui.notify("Requesting device code…", "info");
			const dc = await startDeviceCode(clientId);
			ctx.ui.notify(
				`To sign in:\n  1. Open ${dc.verification_uri}\n  2. Enter code: ${dc.user_code}\n\nWaiting (Esc to cancel)…`,
				"info",
			);

			const ac = new AbortController();
			// Tie to ctx.signal if available (so Esc cancels)
			const onSig = () => ac.abort();
			ctx.signal?.addEventListener("abort", onSig, { once: true });

			try {
				const token = await pollToken(clientId, dc.device_code, dc.interval, ac.signal);
				saveAuth(token);
				ctx.ui.notify(`Signed in. Token cached at ${AUTH_FILE}`, "info");
			} catch (e) {
				ctx.ui.notify(`Login failed: ${(e as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("logout-entra", {
		description: "Forget cached Microsoft Graph token",
		handler: async (_args, ctx) => {
			try {
				fs.unlinkSync(AUTH_FILE);
				ctx.ui.notify("Token removed.", "info");
			} catch {
				ctx.ui.notify("No cached token.", "info");
			}
		},
	});
}
