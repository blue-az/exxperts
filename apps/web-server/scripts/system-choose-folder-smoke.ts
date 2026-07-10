import { chooseMacosFolder, type LocalFolderPickerRunner } from "../src/local-folder-picker.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
	const unsupported = await chooseMacosFolder({ platform: "linux" });
	assert(!unsupported.ok, "non-macOS platform should be unsupported");
	assert(unsupported.supported === false, "unsupported platform should report supported=false");
	assert(unsupported.code === "unsupported_platform", `unexpected unsupported code: ${JSON.stringify(unsupported)}`);

	let capturedCommand = "";
	let capturedArgs: string[] = [];
	let capturedTimeout = 0;
	const selectedRunner: LocalFolderPickerRunner = async (command, args, options) => {
		capturedCommand = command;
		capturedArgs = args;
		capturedTimeout = options.timeoutMs;
		return { stdout: "/Users/example/Workspace Folder/\n", stderr: "" };
	};
	const selected = await chooseMacosFolder({ platform: "darwin", runner: selectedRunner, timeoutMs: 1234, osascriptPath: "/custom/osascript" });
	assert(selected.ok && !selected.cancelled, `selected folder should succeed: ${JSON.stringify(selected)}`);
	assert(selected.path === "/Users/example/Workspace Folder/", `selected path should be trimmed, got ${selected.path}`);
	assert(capturedCommand === "/custom/osascript", `runner should receive configured osascript path, got ${capturedCommand}`);
	assert(capturedArgs.length === 2 && capturedArgs[0] === "-e", `runner should receive osascript -e args, got ${capturedArgs.join(" ")}`);
	assert(capturedArgs[1]?.includes("choose folder"), "osascript should invoke native choose folder dialog");
	assert(capturedTimeout === 1234, `runner should receive timeout, got ${capturedTimeout}`);

	const cancelledRunner: LocalFolderPickerRunner = async () => {
		const error = new Error("Command failed: osascript");
		throw Object.assign(error, { stderr: "execution error: User canceled. (-128)" });
	};
	const cancelled = await chooseMacosFolder({ platform: "darwin", runner: cancelledRunner });
	assert(cancelled.ok && cancelled.cancelled === true && cancelled.path === null, `cancelled dialog should be a clean cancellation: ${JSON.stringify(cancelled)}`);

	const missingRunner: LocalFolderPickerRunner = async () => {
		const error = new Error("spawn osascript ENOENT") as NodeJS.ErrnoException;
		error.code = "ENOENT";
		throw error;
	};
	const missing = await chooseMacosFolder({ platform: "darwin", runner: missingRunner });
	assert(!missing.ok && missing.supported === false && missing.code === "folder_chooser_unavailable", `missing osascript should be unavailable: ${JSON.stringify(missing)}`);

	const timeoutRunner: LocalFolderPickerRunner = async () => {
		const error = new Error("Command timed out") as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
		error.code = "ETIMEDOUT";
		error.killed = true;
		error.signal = "SIGTERM";
		throw error;
	};
	const timedOut = await chooseMacosFolder({ platform: "darwin", runner: timeoutRunner });
	assert(!timedOut.ok && timedOut.supported === true && timedOut.code === "folder_chooser_timeout", `timeout should be normalized: ${JSON.stringify(timedOut)}`);

	const emptyRunner: LocalFolderPickerRunner = async () => ({ stdout: "\n", stderr: "" });
	const empty = await chooseMacosFolder({ platform: "darwin", runner: emptyRunner });
	assert(!empty.ok && empty.supported === true && empty.code === "choose_folder_failed", `empty stdout should fail safely: ${JSON.stringify(empty)}`);

	console.log("system choose-folder smoke passed");
}

await main();
