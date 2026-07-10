/**
 * In-app provider sign-in: drives the runtime OAuth flows (the same ones the
 * CLI /login runs) from the web UI. One login may be in flight at a time; the
 * start call returns the browser URL, the login completes through the
 * provider's local callback server, and credentials land in the shared local
 * auth store. The UI polls /api/auth/login/status plus the profile status
 * until the provider reports configured.
 */
import { AuthStorage, isApiKeyLoginProvider, ModelRegistry } from "@exxeta/exxperts-runtime";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const URL_WAIT_TIMEOUT_MS = 15 * 1000;

export class ProviderAuthError extends Error {
	statusCode: number;
	constructor(message: string, statusCode = 400) {
		super(message);
		this.statusCode = statusCode;
	}
}

type PendingLogin = {
	provider: string;
	url: string | null;
	instructions: string | null;
	abort: AbortController;
	timeout: ReturnType<typeof setTimeout>;
	error: string | null;
	done: boolean;
};

let pending: PendingLogin | null = null;

export function knownOAuthProviderIds(): string[] {
	return AuthStorage.create().getOAuthProviders().map((provider) => provider.id);
}

export function providerLoginState(): { pending: boolean; provider?: string; url?: string | null; instructions?: string | null; error?: string | null } {
	if (!pending) return { pending: false };
	if (pending.done) return { pending: false, provider: pending.provider, error: pending.error };
	return { pending: true, provider: pending.provider, url: pending.url, instructions: pending.instructions };
}

export async function startProviderLogin(providerId: string): Promise<{ url: string; instructions?: string | null }> {
	if (!knownOAuthProviderIds().includes(providerId)) {
		throw new ProviderAuthError(`Unknown OAuth provider: ${providerId}`, 400);
	}
	if (pending && !pending.done) {
		// Re-requesting the same provider is a retry from the UI: hand back the URL.
		if (pending.provider === providerId && pending.url) return { url: pending.url, instructions: pending.instructions };
		throw new ProviderAuthError("Another sign-in is already in progress. Cancel it first.", 409);
	}

	const abort = new AbortController();
	const entry: PendingLogin = {
		provider: providerId,
		url: null,
		instructions: null,
		abort,
		timeout: setTimeout(() => {
			// The runtime flow does not observe the abort signal; settle here.
			abort.abort();
			if (!entry.done) {
				entry.done = true;
				entry.error = "Sign-in timed out. Try again.";
			}
		}, LOGIN_TIMEOUT_MS),
		error: null,
		done: false,
	};
	pending = entry;

	let resolveUrl!: (url: string) => void;
	let rejectUrl!: (error: Error) => void;
	const urlReady = new Promise<string>((resolve, reject) => {
		resolveUrl = resolve;
		rejectUrl = reject;
	});
	const urlTimeout = setTimeout(() => rejectUrl(new Error("The sign-in flow did not produce a login URL in time.")), URL_WAIT_TIMEOUT_MS);

	AuthStorage.create()
		.login(providerId, {
			onAuth: (info) => {
				entry.url = info.url;
				// Device-code flows (GitHub Copilot) deliver a user code here that
				// the person must type on the provider's page — surface it.
				entry.instructions = info.instructions ?? null;
				resolveUrl(info.url);
			},
			// Optional prompts (e.g. Copilot's GitHub Enterprise domain) take
			// their default; there is no interactive input in the web flow, so
			// a required prompt ends the flow with the reason instead of hanging.
			onPrompt: async (prompt) => {
				if (prompt.allowEmpty) return "";
				throw new Error(`Sign-in needs input that is not available here (${prompt.message}). Use "exxperts cli" and /login instead.`);
			},
			// The flows race the callback server against this promise and tear
			// the server down when it rejects — the only cancellation hook they
			// honor (the abort signal itself is ignored, and Anthropic's
			// callback port is fixed, so an orphaned server blocks retries).
			onManualCodeInput: () =>
				new Promise<string>((_, reject) => {
					const rejectCancelled = () => reject(new Error("Sign-in was cancelled."));
					if (abort.signal.aborted) return rejectCancelled();
					abort.signal.addEventListener("abort", rejectCancelled, { once: true });
				}),
			signal: abort.signal,
		})
		.then(() => {
			entry.done = true;
		})
		.catch((error: unknown) => {
			entry.done = true;
			entry.error = abort.signal.aborted ? "Sign-in was cancelled." : (error as Error).message;
			rejectUrl(new Error(entry.error));
		})
		.finally(() => {
			clearTimeout(entry.timeout);
		});

	try {
		const url = await urlReady;
		return { url, instructions: entry.instructions };
	} finally {
		clearTimeout(urlTimeout);
	}
}

export function cancelProviderLogin(): { cancelled: boolean } {
	if (!pending || pending.done) return { cancelled: false };
	// The runtime login flow does not observe the abort signal, so settle the
	// tracked state here; a late completion still stores credentials, which is
	// harmless (the UI refresh would simply show the profile as signed in).
	pending.abort.abort();
	pending.done = true;
	pending.error = "Sign-in was cancelled.";
	clearTimeout(pending.timeout);
	return { cancelled: true };
}

export function knownApiKeyProviderIds(): string[] {
	const authStorage = AuthStorage.create();
	const registry = ModelRegistry.create(authStorage);
	const oauthProviderIds = new Set(authStorage.getOAuthProviders().map((provider) => provider.id));
	const providerIds = new Set(registry.getAll().map((model) => model.provider));
	return [...providerIds].filter((providerId) => isApiKeyLoginProvider(providerId, oauthProviderIds)).sort();
}

export function saveProviderApiKey(providerId: string, key: string): void {
	const trimmedKey = key.trim();
	if (!trimmedKey) throw new ProviderAuthError("API key is required.", 400);
	if (!knownApiKeyProviderIds().includes(providerId)) {
		throw new ProviderAuthError(`Provider does not support API-key sign-in: ${providerId}`, 400);
	}
	AuthStorage.create().set(providerId, { type: "api_key", key: trimmedKey });
}

export function logoutProvider(providerId: string): void {
	const authStorage = AuthStorage.create();
	// Sign-out covers both OAuth credentials and stored API keys.
	if (!knownOAuthProviderIds().includes(providerId) && !authStorage.hasAuth(providerId)) {
		throw new ProviderAuthError(`Unknown provider: ${providerId}`, 400);
	}
	authStorage.logout(providerId);
}
