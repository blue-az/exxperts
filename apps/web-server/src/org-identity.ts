import fs from "node:fs";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

// Global platform state: optional organization identity injected into the L0
// platform kernel. Absent by default — the public build ships a neutral kernel;
// an enterprise deployment writes this file to brand the platform layer.
export const ORG_IDENTITY_FILE = productAppStatePath("org-identity.json");

export type OrgIdentitySource = "file" | "default" | "invalid";

export type OrgIdentity = {
	orgName: string;
	orgDescription: string | null;
	userAudience: string | null;
};

export type OrgIdentityState = {
	identity: OrgIdentity | null;
	path: string;
	source: OrgIdentitySource;
	message: string | null;
};

// Prompt-injected fields stay single-line and bounded so a config file cannot
// smuggle structure or unbounded text into the kernel layer.
const ORG_IDENTITY_MAX_FIELD_CHARS = 300;

function cleanOrgIdentityField(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
	if (!normalized) return null;
	return normalized.slice(0, ORG_IDENTITY_MAX_FIELD_CHARS);
}

function neutralOrgIdentityState(source: OrgIdentitySource, message: string | null = null): OrgIdentityState {
	return { identity: null, path: ORG_IDENTITY_FILE, source, message };
}

export function readOrgIdentityState(): OrgIdentityState {
	try {
		if (!fs.existsSync(ORG_IDENTITY_FILE)) return neutralOrgIdentityState("default");
		const raw = JSON.parse(fs.readFileSync(ORG_IDENTITY_FILE, "utf-8"));
		const orgName = cleanOrgIdentityField(raw?.orgName);
		if (!orgName) return neutralOrgIdentityState("invalid", "org-identity.json has no usable orgName; using the neutral platform kernel.");
		return {
			identity: {
				orgName,
				orgDescription: cleanOrgIdentityField(raw?.orgDescription),
				userAudience: cleanOrgIdentityField(raw?.userAudience),
			},
			path: ORG_IDENTITY_FILE,
			source: "file",
			message: null,
		};
	} catch (error) {
		return neutralOrgIdentityState("invalid", `org-identity.json could not be read; using the neutral platform kernel. ${error instanceof Error ? error.message : String(error)}`);
	}
}
