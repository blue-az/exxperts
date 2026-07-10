import { useEffect, useMemo, useState } from "react";
import type { LoginProviderCatalogEntry, PersistentAgentAiProfileStatus, ProviderModelCatalog } from "../types";
import { useEscapeKey } from "./use-escape-key";
import { fetchJson } from "../api";
import { modelDisplayName } from "../model-names";

// Catalog entries carry a bare name ("Opus 4.8") or none; canonicalise so the
// approval lists read the same as chips and Wallet ("Claude Opus 4.8").
function catalogModelName(model: { id: string; name?: string }): string {
	return modelDisplayName({ model: model.id, modelLabel: model.name }) || model.id;
}

// The model-approval checkbox list, shared by the provider and gateway modals.
export function ModelCheckboxList({ options, selected, onToggle, ariaLabel }: {
	options: Array<{ id: string; name?: string; suggested?: boolean }>;
	selected: Set<string>;
	onToggle: (modelId: string) => void;
	ariaLabel: string;
}) {
	return (
		<div className="configure-profile-model-list" role="group" aria-label={ariaLabel}>
			{options.map((option) => (
				<label key={option.id} className="configure-profile-model-option" title={option.id}>
					<input type="checkbox" checked={selected.has(option.id)} onChange={() => onToggle(option.id)} />
					<span className="configure-profile-model-name">{catalogModelName(option)}</span>
					{option.suggested && <span className="configure-profile-suggested">suggested</span>}
				</label>
			))}
		</div>
	);
}

// Masked credential entry, shared by the add-panel rows and the profile rows.
export function ApiKeyForm({ placeholder, onSave, className }: {
	placeholder: string;
	onSave: (key: string) => Promise<void>;
	className?: string;
}) {
	const [key, setKey] = useState("");
	const [saving, setSaving] = useState(false);
	async function save() {
		setSaving(true);
		try {
			await onSave(key);
			setKey("");
		} finally {
			setSaving(false);
		}
	}
	return (
		<div className={`add-provider-key-form${className ? ` ${className}` : ""}`}>
			<input
				className="launcher-path-input create-room-input"
				type="password"
				placeholder={placeholder}
				value={key}
				autoFocus
				onChange={(e) => setKey(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && key.trim() && !saving) void save();
				}}
			/>
			<button className="landing-action" disabled={!key.trim() || saving} onClick={() => void save()}>
				{saving ? "Saving…" : "Save key"}
			</button>
		</div>
	);
}

// Browser sign-in for a raw provider id: the server starts the same OAuth flow
// the CLI /login runs, we open the URL in a new tab and poll until it settles.
export function useProviderLogin(onDone: (providerId: string, ok: boolean) => void) {
	const [signingInProvider, setSigningInProvider] = useState<string | null>(null);
	// Device-code flows (GitHub Copilot) hand back a code the person must type
	// on the provider's page; callback-server flows have no instructions.
	const [instructions, setInstructions] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function signIn(providerId: string) {
		setError(null);
		setInstructions(null);
		try {
			const { url, instructions: startInstructions } = await fetchJson<{ url: string; instructions?: string | null }>("/api/auth/login", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: providerId }),
			});
			window.open(url, "_blank", "noopener");
			setInstructions(startInstructions ?? null);
			setSigningInProvider(providerId);
		} catch (e) {
			setError((e as Error).message);
		}
	}

	async function cancel() {
		try {
			await fetchJson("/api/auth/login/cancel", { method: "POST" });
		} catch {}
		setSigningInProvider(null);
		setInstructions(null);
	}

	useEffect(() => {
		if (!signingInProvider) return;
		let stopped = false;
		const timer = window.setInterval(async () => {
			try {
				const state = await fetchJson<{ pending: boolean; instructions?: string | null; error?: string | null }>("/api/auth/login/status");
				if (stopped) return;
				if (state.pending) {
					if (state.instructions) setInstructions(state.instructions);
					return;
				}
				window.clearInterval(timer);
				if (state.error) setError(state.error);
				setSigningInProvider(null);
				setInstructions(null);
				onDone(signingInProvider, !state.error);
			} catch {}
		}, 2000);
		return () => {
			stopped = true;
			window.clearInterval(timer);
		};
	}, [signingInProvider]);

	return { signingInProvider, instructions, error, setError, signIn, cancel };
}

// Suggest-then-approve model configuration for one provider: which models its
// rooms may use, and which model runs Learn and Review Memory. Saving creates
// or updates the provider's custom AI profile.
export function ConfigureProfileModal({ providerId, providerName, existingProfile, allowRemove = true, onClose, onSaved }: {
	providerId: string;
	providerName: string;
	existingProfile?: PersistentAgentAiProfileStatus;
	// Built-in profiles are edited through the same modal but cannot be removed,
	// only reset from the row menu.
	allowRemove?: boolean;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [catalog, setCatalog] = useState<ProviderModelCatalog | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [roomModels, setRoomModels] = useState<Set<string>>(new Set());
	const [learnModel, setLearnModel] = useState("");
	const [reviewMemoryModel, setReviewMemoryModel] = useState("");
	const [saving, setSaving] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	useEscapeKey(onClose, true);

	const existingRoomModels = useMemo(
		() => (existingProfile?.processes?.persistentRoom.models ?? []).map((model) => model.model),
		[existingProfile],
	);
	const existingForPurpose = (token: string) =>
		existingProfile?.requiredModels.find((model) => (model.purpose ?? "").split("/").includes(token))?.model ?? "";

	useEffect(() => {
		let stopped = false;
		fetchJson<ProviderModelCatalog>(`/api/persistent-agent-ai-profiles/model-catalog?provider=${encodeURIComponent(providerId)}`)
			.then((result) => {
				if (stopped) return;
				setCatalog(result);
				const initialRooms = existingRoomModels.length > 0 ? existingRoomModels : [result.suggested];
				setRoomModels(new Set(initialRooms.filter((id) => result.models.some((model) => model.id === id))));
				setLearnModel(existingForPurpose("absorb") || result.suggested);
				setReviewMemoryModel(existingForPurpose("structural-review") || result.suggested);
			})
			.catch((e) => {
				if (!stopped) setLoadError((e as Error).message);
			});
		return () => {
			stopped = true;
		};
	}, [providerId]);

	function toggleRoomModel(modelId: string) {
		setRoomModels((current) => {
			const next = new Set(current);
			if (next.has(modelId)) next.delete(modelId);
			else next.add(modelId);
			return next;
		});
	}

	async function save() {
		setSaving(true);
		setSaveError(null);
		try {
			await fetchJson("/api/persistent-agent-ai-profiles/custom", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					providerId,
					label: providerName,
					roomModels: [...roomModels],
					learnModel,
					reviewMemoryModel,
				}),
			});
			onSaved();
			onClose();
		} catch (e) {
			setSaveError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	async function removeProfile() {
		if (!existingProfile) return;
		setRemoving(true);
		setSaveError(null);
		try {
			await fetchJson(`/api/persistent-agent-ai-profiles/custom/${encodeURIComponent(existingProfile.id)}`, { method: "DELETE" });
			onSaved();
			onClose();
		} catch (e) {
			setSaveError((e as Error).message);
		} finally {
			setRemoving(false);
		}
	}

	const canSave = roomModels.size > 0 && Boolean(learnModel) && Boolean(reviewMemoryModel) && !saving && !removing;

	return (
		<div className="room-settings-overlay configure-profile-overlay" role="dialog" aria-modal="true" aria-label={`Configure ${providerName} models`} onClick={onClose}>
			<div className="room-settings-modal configure-profile-modal" onClick={(e) => e.stopPropagation()}>
				<div className="room-settings-head">
					<div className="room-settings-title-block">
						<div className="room-settings-title-row">
							<h2>{`Approve ${providerName} models`}</h2>
						</div>
					</div>
					<button className="icon-btn" onClick={onClose} aria-label="Close">Close</button>
				</div>
				<div className="room-settings-body configure-profile-body">
					<p className="ai-setup-copy">
						Choose the models your rooms may run on, and which model handles Learn and Review Memory. You can change this later.
					</p>
					{loadError && <div className="checkpoint-proposal-error">{loadError}</div>}
					{!catalog && !loadError && <p className="cli-note">Loading models…</p>}
					{catalog && (
						<>
							{catalog.note && <p className="cli-note">{catalog.note}</p>}
							<div className="configure-profile-field">
								<h3>Rooms</h3>
								<ModelCheckboxList
									options={catalog.models.map((model) => ({ id: model.id, name: model.name, suggested: model.suggestedDefault }))}
									selected={roomModels}
									onToggle={toggleRoomModel}
									ariaLabel="Room models"
								/>
							</div>
							<div className="configure-profile-field">
								<h3>Learn</h3>
								<select className="configure-profile-select" value={learnModel} onChange={(e) => setLearnModel(e.target.value)} aria-label="Learn model">
									{catalog.models.map((model) => (
										<option key={model.id} value={model.id}>{catalogModelName(model)}{model.suggestedDefault ? " (suggested)" : ""}</option>
									))}
								</select>
							</div>
							<div className="configure-profile-field">
								<h3>Review Memory</h3>
								<select className="configure-profile-select" value={reviewMemoryModel} onChange={(e) => setReviewMemoryModel(e.target.value)} aria-label="Review Memory model">
									{catalog.models.map((model) => (
										<option key={model.id} value={model.id}>{catalogModelName(model)}{model.suggestedDefault ? " (suggested)" : ""}</option>
									))}
								</select>
							</div>
							{saveError && <div className="checkpoint-proposal-error">{saveError}</div>}
							<div className="create-room-actions">
								<button className="landing-action" disabled={!canSave} onClick={() => void save()}>{saving ? "Saving…" : "Save profile"}</button>
								<button className="inline-action" disabled={saving || removing} onClick={onClose}>Cancel</button>
								{existingProfile && allowRemove && (
									<button className="ai-profile-foot-link configure-profile-remove" disabled={saving || removing} onClick={() => void removeProfile()}>
										{removing ? "Removing…" : "Remove profile"}
									</button>
								)}
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

type GatewayConfig = {
	configured: boolean;
	displayName?: string;
	baseUrl?: string;
	roomModels?: string[];
	maintenanceModel?: string;
};

// OpenAI-compatible gateway (LiteLLM, vLLM, company proxies): the same setup
// the `exxperts setup openai-compatible` wizard performs, as a form. The
// gateway's models are fetched with the person's token so they approve from a
// picker; manual id entry stays as the fallback for gateways without /models.
export function GatewayConfigModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
	const [loaded, setLoaded] = useState(false);
	const [configured, setConfigured] = useState(false);
	const [displayName, setDisplayName] = useState("OpenAI-compatible gateway");
	const [baseUrl, setBaseUrl] = useState("");
	const [token, setToken] = useState("");
	const [discovered, setDiscovered] = useState<string[] | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [existingRoomModels, setExistingRoomModels] = useState<string[]>([]);
	const [manualMode, setManualMode] = useState(false);
	const [modelsText, setModelsText] = useState("");
	const [maintenanceModel, setMaintenanceModel] = useState("");
	const [discovering, setDiscovering] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEscapeKey(onClose, true);

	const manualIds = useMemo(() => {
		const seen = new Set<string>();
		return modelsText
			.split(/[\n,]/)
			.map((value) => value.trim())
			.filter((value) => {
				if (!value || seen.has(value)) return false;
				seen.add(value);
				return true;
			});
	}, [modelsText]);

	const chosenIds = manualMode ? manualIds : [...selected];
	// One derivation for both the dropdown and the save payload.
	const effectiveMaintenanceModel = maintenanceModel && chosenIds.includes(maintenanceModel) ? maintenanceModel : chosenIds[0] ?? "";

	useEffect(() => {
		fetchJson<GatewayConfig>("/api/persistent-agent-ai-profiles/openai-compatible")
			.then((config) => {
				if (config.configured) {
					setConfigured(true);
					if (config.displayName) setDisplayName(config.displayName);
					setBaseUrl(config.baseUrl ?? "");
					setExistingRoomModels(config.roomModels ?? []);
					setModelsText((config.roomModels ?? []).join("\n"));
					setMaintenanceModel(config.maintenanceModel ?? "");
				}
			})
			.catch(() => {})
			.finally(() => setLoaded(true));
	}, []);

	async function discover() {
		setDiscovering(true);
		setError(null);
		try {
			const result = await fetchJson<{ models: string[] }>("/api/persistent-agent-ai-profiles/openai-compatible/discover", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ baseUrl, key: token }),
			});
			setDiscovered(result.models);
			setManualMode(false);
			// On edit, keep the already-approved models selected; new ids start unchecked.
			setSelected(new Set(existingRoomModels.filter((id) => result.models.includes(id))));
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setDiscovering(false);
		}
	}

	function toggleModel(modelId: string) {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(modelId)) next.delete(modelId);
			else next.add(modelId);
			return next;
		});
	}

	async function save() {
		setSaving(true);
		setError(null);
		try {
			await fetchJson("/api/persistent-agent-ai-profiles/openai-compatible", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					displayName,
					baseUrl,
					roomModels: chosenIds,
					maintenanceModel: effectiveMaintenanceModel,
				}),
			});
			// The gateway provider exists in the runtime catalog once the config
			// is written; only then can its key be stored.
			if (token.trim()) {
				await fetchJson("/api/auth/api-key", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ provider: "openai-compatible", key: token }),
				});
			}
			onSaved();
			onClose();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	const canDiscover = Boolean(baseUrl.trim()) && (Boolean(token.trim()) || configured) && !discovering && !saving;
	const canSave = loaded && Boolean(baseUrl.trim()) && chosenIds.length > 0 && (Boolean(token.trim()) || configured) && !saving;

	return (
		<div className="room-settings-overlay configure-profile-overlay" role="dialog" aria-modal="true" aria-label="Set up OpenAI-compatible gateway" onClick={onClose}>
			<div className="room-settings-modal configure-profile-modal" onClick={(e) => e.stopPropagation()}>
				<div className="room-settings-head">
					<div className="room-settings-title-block">
						<div className="room-settings-title-row">
							<h2>Custom gateway</h2>
						</div>
					</div>
					<button className="icon-btn" onClick={onClose} aria-label="Close">Close</button>
				</div>
				<div className="room-settings-body configure-profile-body">
					<p className="ai-setup-copy">
						Connect an OpenAI-compatible endpoint such as a company LiteLLM or vLLM gateway. Enter the address and your API key, load the models it routes, and approve the ones your rooms may use.
					</p>
					<div className="configure-profile-field">
						<h3>Display name</h3>
						<input className="launcher-path-input create-room-input" type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
					</div>
					<div className="configure-profile-field">
						<h3>Base URL</h3>
						<input className="launcher-path-input create-room-input" type="text" placeholder="https://litellm.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
					</div>
					<div className="configure-profile-field">
						<h3>API key</h3>
						<input
							className="launcher-path-input create-room-input"
							type="password"
							placeholder={configured ? "leave blank to keep the saved key" : "sk-…"}
							value={token}
							onChange={(e) => setToken(e.target.value)}
						/>
					</div>
					<div className="configure-profile-field">
						<h3>Room models</h3>
						{!manualMode && discovered === null && (
							<div className="gateway-discover-row">
								<button className="landing-action" disabled={!canDiscover} onClick={() => void discover()}>{discovering ? "Loading…" : "Load models from gateway"}</button>
								<button className="ai-profile-foot-link" disabled={saving} onClick={() => setManualMode(true)}>enter ids manually</button>
							</div>
						)}
						{!manualMode && discovered !== null && (
							<>
								<ModelCheckboxList
									options={discovered.map((modelId) => ({ id: modelId }))}
									selected={selected}
									onToggle={toggleModel}
									ariaLabel="Room models"
								/>
								<div className="gateway-discover-row">
									<button className="ai-profile-foot-link" disabled={discovering || saving} onClick={() => void discover()}>{discovering ? "reloading…" : "reload"}</button>
									<button className="ai-profile-foot-link" disabled={saving} onClick={() => setManualMode(true)}>enter ids manually</button>
								</div>
							</>
						)}
						{manualMode && (
							<>
								<textarea
									className="launcher-path-input create-room-input gateway-models-input"
									placeholder={"one model id per line, e.g.\ngpt-4o\nclaude-sonnet"}
									value={modelsText}
									onChange={(e) => setModelsText(e.target.value)}
									rows={4}
								/>
								<div className="gateway-discover-row">
									<button className="ai-profile-foot-link" disabled={!canDiscover} onClick={() => void discover()}>load from gateway instead</button>
								</div>
							</>
						)}
					</div>
					<div className="configure-profile-field">
						<h3>Learn &amp; Review Memory</h3>
						<select className="configure-profile-select" value={effectiveMaintenanceModel} onChange={(e) => setMaintenanceModel(e.target.value)} aria-label="Maintenance model" disabled={chosenIds.length === 0}>
							{chosenIds.map((id) => (
								<option key={id} value={id}>{catalogModelName({ id })}</option>
							))}
						</select>
					</div>
					{error && <div className="checkpoint-proposal-error">{error}</div>}
					<div className="create-room-actions">
						<button className="landing-action" disabled={!canSave} onClick={() => void save()}>{saving ? "Saving…" : "Save gateway"}</button>
						<button className="inline-action" disabled={saving} onClick={onClose}>Cancel</button>
					</div>
				</div>
			</div>
		</div>
	);
}

// Approve-models for the OpenAI-compatible gateway: the same suggest-then-
// approve step custom providers get, scoped to the model set only. Base URL
// and API key are untouched here; Edit gateway owns those. The gateway policy
// file has one maintenance model that runs both Learn and Review Memory, so
// the modal shows a single picker for it instead of pretending there are two.
export function GatewayApproveModelsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
	const [config, setConfig] = useState<GatewayConfig | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [discovered, setDiscovered] = useState<string[] | null>(null);
	const [discovering, setDiscovering] = useState(false);
	const [discoverError, setDiscoverError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [manualMode, setManualMode] = useState(false);
	const [modelsText, setModelsText] = useState("");
	const [maintenanceModel, setMaintenanceModel] = useState("");
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	useEscapeKey(onClose, true);

	const approvedModels = config?.roomModels ?? [];

	// `keepSelection` carries the user's in-session checkbox state through a
	// reload; without it the initial load selects the saved approved set.
	async function discover(baseUrl: string, approved: string[], keepSelection?: Set<string>) {
		setDiscovering(true);
		setDiscoverError(null);
		try {
			// No key in the body: the server uses the stored gateway key.
			const result = await fetchJson<{ models: string[] }>("/api/persistent-agent-ai-profiles/openai-compatible/discover", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ baseUrl }),
			});
			// Approved models the gateway no longer lists stay visible (and
			// checked) so saving without changes never silently drops them.
			const merged = [...new Set([...result.models, ...approved, ...(keepSelection ?? [])])].sort();
			setDiscovered(merged);
			setSelected(keepSelection ?? new Set(approved));
			setManualMode(false);
		} catch (e) {
			setDiscoverError((e as Error).message);
			// Graceful fallback: offer the currently approved set as the list.
			setDiscovered(null);
			setSelected(keepSelection ?? new Set(approved));
		} finally {
			setDiscovering(false);
		}
	}

	useEffect(() => {
		let stopped = false;
		fetchJson<GatewayConfig>("/api/persistent-agent-ai-profiles/openai-compatible")
			.then((result) => {
				if (stopped) return;
				if (!result.configured) {
					setLoadError("No gateway is configured yet. Set it up from Add another provider first.");
					return;
				}
				setConfig(result);
				const approved = result.roomModels ?? [];
				setSelected(new Set(approved));
				setModelsText(approved.join("\n"));
				setMaintenanceModel(result.maintenanceModel ?? "");
				void discover(result.baseUrl ?? "", approved);
			})
			.catch((e) => {
				if (!stopped) setLoadError((e as Error).message);
			});
		return () => {
			stopped = true;
		};
	}, []);

	const manualIds = useMemo(() => {
		const seen = new Set<string>();
		return modelsText
			.split(/[\n,]/)
			.map((value) => value.trim())
			.filter((value) => {
				if (!value || seen.has(value)) return false;
				seen.add(value);
				return true;
			});
	}, [modelsText]);

	// When discovery failed, the currently approved set is the checkbox list.
	const options = discovered ?? approvedModels;
	const chosenIds = manualMode ? manualIds : [...selected];
	const effectiveMaintenanceModel = maintenanceModel && chosenIds.includes(maintenanceModel) ? maintenanceModel : chosenIds[0] ?? "";

	function toggleModel(modelId: string) {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(modelId)) next.delete(modelId);
			else next.add(modelId);
			return next;
		});
	}

	async function save() {
		if (!config) return;
		setSaving(true);
		setSaveError(null);
		try {
			await fetchJson("/api/persistent-agent-ai-profiles/openai-compatible", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					displayName: config.displayName ?? "OpenAI-compatible gateway",
					baseUrl: config.baseUrl ?? "",
					roomModels: chosenIds,
					maintenanceModel: effectiveMaintenanceModel,
				}),
			});
			onSaved();
			onClose();
		} catch (e) {
			setSaveError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	const loading = !config && !loadError;
	const canSave = Boolean(config) && chosenIds.length > 0 && !saving && !discovering;
	const gatewayName = config?.displayName || "gateway";

	return (
		<div className="room-settings-overlay configure-profile-overlay" role="dialog" aria-modal="true" aria-label="Approve gateway models" onClick={onClose}>
			<div className="room-settings-modal configure-profile-modal" onClick={(e) => e.stopPropagation()}>
				<div className="room-settings-head">
					<div className="room-settings-title-block">
						<div className="room-settings-title-row">
							<h2>{`Approve ${gatewayName} models`}</h2>
						</div>
					</div>
					<button className="icon-btn" onClick={onClose} aria-label="Close">Close</button>
				</div>
				<div className="room-settings-body configure-profile-body">
					<p className="ai-setup-copy">
						Choose the models your rooms may run on, and which model handles Learn and Review Memory. The gateway address and API key stay as they are; use Edit gateway to change those.
					</p>
					{loadError && <div className="checkpoint-proposal-error">{loadError}</div>}
					{loading && <p className="cli-note">Loading gateway configuration…</p>}
					{config && (
						<>
							<div className="configure-profile-field">
								<h3>Rooms</h3>
								{discovering && <p className="cli-note">Loading models from the gateway…</p>}
								{!discovering && discoverError && (
									<>
										<div className="checkpoint-proposal-error">{discoverError}</div>
										<p className="cli-note">Showing the currently approved models instead. You can reload from the gateway or enter ids manually.</p>
									</>
								)}
								{!discovering && !manualMode && (
									<>
										<ModelCheckboxList
											options={options.map((modelId) => ({ id: modelId }))}
											selected={selected}
											onToggle={toggleModel}
											ariaLabel="Room models"
										/>
										<div className="gateway-discover-row">
											<button className="ai-profile-foot-link" disabled={saving} onClick={() => void discover(config.baseUrl ?? "", approvedModels, new Set(selected))}>reload from gateway</button>
											<button className="ai-profile-foot-link" disabled={saving} onClick={() => setManualMode(true)}>enter ids manually</button>
										</div>
									</>
								)}
								{!discovering && manualMode && (
									<>
										<textarea
											className="launcher-path-input create-room-input gateway-models-input"
											placeholder={"one model id per line, e.g.\ngpt-4o\nclaude-sonnet"}
											value={modelsText}
											onChange={(e) => setModelsText(e.target.value)}
											rows={4}
										/>
										<div className="gateway-discover-row">
											<button className="ai-profile-foot-link" disabled={saving} onClick={() => setManualMode(false)}>back to the model list</button>
										</div>
									</>
								)}
							</div>
							<div className="configure-profile-field">
								<h3>Learn and Review Memory</h3>
								<select className="configure-profile-select" value={effectiveMaintenanceModel} onChange={(e) => setMaintenanceModel(e.target.value)} aria-label="Maintenance model" disabled={chosenIds.length === 0}>
									{chosenIds.map((id) => (
										<option key={id} value={id}>{catalogModelName({ id })}</option>
									))}
								</select>
							</div>
							{saveError && <div className="checkpoint-proposal-error">{saveError}</div>}
							<div className="create-room-actions">
								<button className="landing-action" disabled={!canSave} onClick={() => void save()}>{saving ? "Saving…" : "Save models"}</button>
								<button className="inline-action" disabled={saving} onClick={onClose}>Cancel</button>
							</div>
						</>
					)}
					{loadError && (
						<div className="create-room-actions">
							<button className="inline-action" onClick={onClose}>Close</button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

// Providers most people reach for first; the rest follow alphabetically.
const POPULAR_PROVIDER_ORDER = ["google", "mistral", "openrouter", "deepseek", "xai", "groq", "together", "fireworks"];

// "Add provider" flow on the AI setup page: the full raw-Pi sign-in surface —
// subscription (OAuth) providers plus API-key providers — followed by the
// approve-models step that creates the provider's profile.
export function AddProviderPanel({ onProfilesChanged }: { onProfilesChanged: () => void }) {
	const [open, setOpen] = useState(false);
	const [providers, setProviders] = useState<LoginProviderCatalogEntry[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [apiKeyProvider, setApiKeyProvider] = useState<LoginProviderCatalogEntry | null>(null);
	const [configureProvider, setConfigureProvider] = useState<{ id: string; name: string } | null>(null);
	const [gatewayOpen, setGatewayOpen] = useState(false);
	const [gatewayConfigured, setGatewayConfigured] = useState(false);
	const [filter, setFilter] = useState("");
	const [addedNote, setAddedNote] = useState<string | null>(null);

	// Called when a provider gains its profile: collapse the panel and narrate
	// the hand-off so the row appearing above does not read as a disappearance.
	function announceAdded(name: string) {
		setAddedNote(`${name} added · it now appears above as a profile.`);
		setOpen(false);
		setFilter("");
	}

	const login = useProviderLogin((providerId, ok) => {
		if (!ok) return;
		const entry = providers?.find((provider) => provider.id === providerId);
		if (!entry?.profileId) setConfigureProvider({ id: providerId, name: entry?.name ?? providerId });
		onProfilesChanged();
	});

	async function refreshProviders() {
		try {
			const result = await fetchJson<{ providers: LoginProviderCatalogEntry[] }>("/api/auth/providers");
			setProviders(result.providers);
			setLoadError(null);
		} catch (e) {
			setLoadError((e as Error).message);
		}
	}

	useEffect(() => {
		if (!open) return;
		void refreshProviders();
		fetchJson<{ configured: boolean }>("/api/persistent-agent-ai-profiles/openai-compatible")
			.then((config) => setGatewayConfigured(config.configured))
			.catch(() => {});
	}, [open]);

	async function removeKey(provider: LoginProviderCatalogEntry) {
		login.setError(null);
		try {
			await fetchJson("/api/auth/logout", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: provider.id }),
			});
			onProfilesChanged();
			void refreshProviders();
		} catch (e) {
			login.setError((e as Error).message);
		}
	}

	async function saveApiKey(key: string) {
		if (!apiKeyProvider) return;
		login.setError(null);
		try {
			await fetchJson("/api/auth/api-key", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: apiKeyProvider.id, key }),
			});
			const needsProfile = !apiKeyProvider.profileId;
			const picked = apiKeyProvider;
			setApiKeyProvider(null);
			if (needsProfile) setConfigureProvider({ id: picked.id, name: picked.name });
			onProfilesChanged();
			void refreshProviders();
		} catch (e) {
			login.setError((e as Error).message);
		}
	}

	// Providers that already carry a profile have their own row above.
	const addable = (providers ?? []).filter((provider) => !provider.profileId);
	const filterText = filter.trim().toLowerCase();
	const matchesFilter = (provider: LoginProviderCatalogEntry) =>
		!filterText || provider.name.toLowerCase().includes(filterText) || provider.id.toLowerCase().includes(filterText);
	const oauthProviders = addable.filter((provider) => provider.authTypes.includes("oauth")).filter(matchesFilter);
	const apiKeyProviders = addable
		.filter((provider) => !provider.authTypes.includes("oauth"))
		.filter(matchesFilter)
		.sort((a, b) => {
			const aRank = POPULAR_PROVIDER_ORDER.indexOf(a.id);
			const bRank = POPULAR_PROVIDER_ORDER.indexOf(b.id);
			if (aRank !== -1 || bRank !== -1) return (aRank === -1 ? POPULAR_PROVIDER_ORDER.length : aRank) - (bRank === -1 ? POPULAR_PROVIDER_ORDER.length : bRank);
			return a.name.localeCompare(b.name);
		});

	return (
		<div className="add-provider-panel">
			<span className="add-provider-toggle-row">
				<button className="ai-profile-foot-link add-provider-toggle" aria-expanded={open} onClick={() => { setAddedNote(null); setOpen((value) => !value); }}>
					{open ? "Add another provider ▴" : "Add another provider ▾"}
				</button>
				{addedNote && !open && <span className="add-provider-added-note">{addedNote}</span>}
			</span>
			{open && (
				<div className="ai-setup-block add-provider-block">
					<p className="cli-note">
						Sign in with any provider the runtime supports · the same options as the CLI /login. After signing in you approve which models it may use.
					</p>
					{loadError && <div className="checkpoint-proposal-error">{loadError}</div>}
					{!providers && !loadError && <p className="cli-note">Loading providers…</p>}
					{login.error && <div className="checkpoint-proposal-error">{login.error}</div>}
					{providers && addable.length > 6 && (
						<input
							className="launcher-path-input create-room-input add-provider-filter"
							type="text"
							placeholder="Filter providers…"
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
						/>
					)}
					{providers && filterText && oauthProviders.length === 0 && apiKeyProviders.length === 0 && (
						<p className="cli-note">No provider matches "{filter.trim()}".</p>
					)}
					{oauthProviders.length > 0 && (
						<div className="add-provider-group">
							<h3>Subscription</h3>
							<div className="add-provider-rows">
								{oauthProviders.map((provider) => (
									<div key={provider.id} className="add-provider-row-group">
										<div className="add-provider-row">
											<span className="add-provider-name">{provider.name}</span>
											<span className="add-provider-side">
												{provider.configured && <span className="add-provider-configured">signed in</span>}
												{login.signingInProvider === provider.id ? (
													<>
														<span className="add-provider-configured">finish signing in in your browser…</span>
														<button className="ai-profile-foot-link" onClick={() => void login.cancel()}>Cancel</button>
													</>
												) : provider.configured ? (
													<button className="ai-profile-foot-link" onClick={() => setConfigureProvider({ id: provider.id, name: provider.name })}>Approve models</button>
												) : (
													<button className="ai-profile-signin" disabled={login.signingInProvider !== null} onClick={() => void login.signIn(provider.id)}>Sign in →</button>
												)}
											</span>
										</div>
										{login.signingInProvider === provider.id && login.instructions && (
											<div className="add-provider-instructions">{login.instructions}</div>
										)}
									</div>
								))}
							</div>
						</div>
					)}
					<div className="add-provider-group">
						<h3>Custom gateway</h3>
						<div className="add-provider-rows">
							<div className="add-provider-row">
								<span className="add-provider-name">OpenAI-compatible gateway · LiteLLM, vLLM, company proxies</span>
								<span className="add-provider-side">
									{gatewayConfigured && <span className="add-provider-configured">configured</span>}
									<button className="ai-profile-foot-link" onClick={() => setGatewayOpen(true)}>{gatewayConfigured ? "Edit gateway" : "Set up gateway"}</button>
								</span>
							</div>
						</div>
					</div>
					{apiKeyProviders.length > 0 && (
						<div className="add-provider-group">
							<h3>API key</h3>
							<div className="add-provider-rows">
								{apiKeyProviders.map((provider) => (
									<div key={provider.id} className="add-provider-row-group">
										<div className="add-provider-row">
											<span className="add-provider-name">{provider.name}</span>
											<span className="add-provider-side">
												{provider.configured && <span className="add-provider-configured">key saved</span>}
												{provider.configured ? (
													<>
														<button className="ai-profile-foot-link" onClick={() => setConfigureProvider({ id: provider.id, name: provider.name })}>Approve models</button>
														<button className="ai-profile-foot-link" onClick={() => setApiKeyProvider(apiKeyProvider?.id === provider.id ? null : provider)}>
															{apiKeyProvider?.id === provider.id ? "Cancel" : "Replace key"}
														</button>
														<button className="ai-profile-foot-link" onClick={() => void removeKey(provider)}>Remove key</button>
													</>
												) : (
													<button
														className="ai-profile-foot-link"
														onClick={() => setApiKeyProvider(apiKeyProvider?.id === provider.id ? null : provider)}
													>
														{apiKeyProvider?.id === provider.id ? "Cancel" : "Add API key"}
													</button>
												)}
											</span>
										</div>
										{apiKeyProvider?.id === provider.id && (
											<ApiKeyForm placeholder={`${provider.name} API key`} onSave={saveApiKey} />
										)}
									</div>
								))}
							</div>
							<p className="cli-note">Keys stay on this device in the local auth store, shared with the exxperts CLI.</p>
						</div>
					)}
				</div>
			)}
			{gatewayOpen && (
				<GatewayConfigModal
					onClose={() => setGatewayOpen(false)}
					onSaved={() => {
						const firstSetup = !gatewayConfigured;
						setGatewayConfigured(true);
						if (firstSetup) announceAdded("Your gateway");
						onProfilesChanged();
						void refreshProviders();
					}}
				/>
			)}
			{configureProvider && (
				<ConfigureProfileModal
					providerId={configureProvider.id}
					providerName={configureProvider.name}
					onClose={() => setConfigureProvider(null)}
					onSaved={() => {
						announceAdded(configureProvider.name);
						onProfilesChanged();
						void refreshProviders();
					}}
				/>
			)}
		</div>
	);
}
