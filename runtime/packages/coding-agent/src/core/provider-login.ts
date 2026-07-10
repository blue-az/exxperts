/**
 * Provider login classification shared by the interactive TUI and product surfaces.
 */

import { getProviders } from "@exxeta/exxperts-ai";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.js";

export const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());

export function isApiKeyLoginProvider(
	providerId: string,
	oauthProviderIds: ReadonlySet<string>,
	builtInProviderIds: ReadonlySet<string> = BUILT_IN_MODEL_PROVIDERS,
): boolean {
	if (BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId]) {
		return true;
	}
	if (builtInProviderIds.has(providerId)) {
		return false;
	}
	return !oauthProviderIds.has(providerId);
}
