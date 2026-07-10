import os from "node:os";
import path from "node:path";

function normalizeForDisplay(value: string): string {
	return value.replace(/\\/g, "/");
}

/**
 * Return a browser-safe local path string for diagnostics.
 *
 * Home-contained absolute paths remain useful as ~/... display paths. Other
 * absolute paths are intentionally reduced to a basename so browser status
 * payloads do not expose local directory layouts.
 */
export function browserSafeLocalPath(value: string): string {
	if (!value) return value;
	if (!path.isAbsolute(value)) return normalizeForDisplay(value);

	const normalizedPath = path.normalize(value);
	const normalizedHome = path.normalize(os.homedir());
	const relativeToHome = path.relative(normalizedHome, normalizedPath);
	const isHomeOrWithinHome = relativeToHome === "" || (!relativeToHome.startsWith("..") && !path.isAbsolute(relativeToHome));

	if (isHomeOrWithinHome) {
		return relativeToHome === "" ? "~" : `~/${normalizeForDisplay(relativeToHome)}`;
	}

	const basename = path.basename(normalizedPath);
	return basename ? `<local>/${basename}` : "<local>";
}

/**
 * Redact local absolute paths embedded in browser-facing diagnostic strings.
 * Keep this conservative for MR2: known model-registry errors include a
 * dedicated "File: <path>" line, so sanitize that value without rewriting
 * arbitrary prose or URLs.
 */
export function browserSafeDiagnosticText(value: string): string {
	return value.replace(/(\bFile:\s*)([^\r\n]+)/g, (_match, prefix: string, filePath: string) => {
		const trimmedPath = filePath.trim();
		return `${prefix}${browserSafeLocalPath(trimmedPath)}`;
	});
}
