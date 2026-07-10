import { assertNoForbiddenDiagnosticKeys } from "./prompt-diagnostics.js";
import type { PromptAssemblyManifest, PromptDiagnosticsSurface } from "./prompt-diagnostics.js";

export interface PromptAssemblyManifestFilter {
	agentId: string;
	conversationId?: string;
	surface?: PromptDiagnosticsSurface;
}

export interface PromptDiagnosticsStoreOptions {
	maxManifests?: number;
}

export const DEFAULT_PROMPT_DIAGNOSTICS_MANIFEST_LIMIT = 20;

let manifests: PromptAssemblyManifest[] = [];
let manifestLimit = DEFAULT_PROMPT_DIAGNOSTICS_MANIFEST_LIMIT;

/**
 * Records a redacted prompt assembly manifest in process memory only.
 *
 * Storage is newest-first, bounded, and intentionally not persisted to disk.
 * Callers must pass already-redacted PromptAssemblyManifest objects; this store
 * rejects forbidden raw-text-bearing keys and defensively clones stored/returned
 * manifests to avoid accidental mutation of retained diagnostics.
 */
export function recordPromptAssemblyManifest(manifest: PromptAssemblyManifest, options: PromptDiagnosticsStoreOptions = {}): PromptAssemblyManifest {
	const nextLimit = normalizeLimit(options.maxManifests ?? manifestLimit);
	manifestLimit = nextLimit;
	assertNoForbiddenDiagnosticKeys(manifest);
	const stored = cloneManifest(manifest);
	manifests = [stored, ...manifests].slice(0, nextLimit);
	return cloneManifest(stored);
}

export function listPromptAssemblyManifests(filter: PromptAssemblyManifestFilter): PromptAssemblyManifest[] {
	return manifests
		.filter((manifest) => manifest.agentId === filter.agentId)
		.filter((manifest) => filter.conversationId == null || manifest.conversationId === filter.conversationId)
		.filter((manifest) => filter.surface == null || manifest.surface === filter.surface)
		.map(cloneManifest);
}

export function clearPromptAssemblyManifests(options: PromptDiagnosticsStoreOptions = {}): void {
	manifests = [];
	manifestLimit = normalizeLimit(options.maxManifests ?? DEFAULT_PROMPT_DIAGNOSTICS_MANIFEST_LIMIT);
}

function normalizeLimit(limit: number): number {
	if (!Number.isFinite(limit) || limit < 1) return DEFAULT_PROMPT_DIAGNOSTICS_MANIFEST_LIMIT;
	return Math.floor(limit);
}

function cloneManifest(manifest: PromptAssemblyManifest): PromptAssemblyManifest {
	return JSON.parse(JSON.stringify(manifest)) as PromptAssemblyManifest;
}
