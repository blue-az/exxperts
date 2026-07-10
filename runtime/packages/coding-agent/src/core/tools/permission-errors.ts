function errorCode(value: unknown): string {
	return String((value as NodeJS.ErrnoException | undefined)?.code ?? "").trim();
}

function errorText(value: unknown): string {
	if (value instanceof Error) return value.message;
	return String(value ?? "");
}

export function isDirectoryEnumerationPermissionError(value: unknown): boolean {
	const code = errorCode(value);
	if (code === "EACCES" || code === "EPERM") return true;
	const text = errorText(value);
	return /\b(?:permission denied|operation not permitted|os error 1|eacces|eperm)\b/i.test(text);
}

export function directoryEnumerationPermissionMessage(pathForDisplay: string, cause?: unknown): string {
	const causeText = errorText(cause).trim();
	const causeSuffix = causeText ? ` Underlying error: ${causeText}` : "";
	return `Directory enumeration was blocked for ${pathForDisplay}. macOS privacy permissions, Full Disk Access, or managed corporate policy can block listing/searching protected folders even when direct file reads or writes to known paths work.${causeSuffix}`;
}
