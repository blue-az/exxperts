import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function productAppStateRoot(): string {
	return path.join(os.homedir(), ".exxperts", "app");
}

export function productAppStatePath(...segments: string[]): string {
	return path.join(productAppStateRoot(), ...segments);
}

export function ensureProductAppStateRoot(): string {
	const root = productAppStateRoot();
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	return root;
}

export function ensureProductAppStateDir(...segments: string[]): string {
	const dir = productAppStatePath(...segments);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

export function ensureProductAppUserDirs(): void {
	ensureProductAppStateRoot();
	ensureProductAppStateDir("agents");
	ensureProductAppStateDir("skills");
}

export function cliLauncherStateDir(): string {
	const fromEnv = process.env.EXXPERTS_LAUNCHER_STATE_DIR;
	if (fromEnv && fromEnv.trim()) return fromEnv;
	return productAppStatePath("run", "cli");
}

export function ensureCliLauncherStateDir(): string {
	const dir = cliLauncherStateDir();
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

export function cliLauncherStatePath(...segments: string[]): string {
	return path.join(cliLauncherStateDir(), ...segments);
}
