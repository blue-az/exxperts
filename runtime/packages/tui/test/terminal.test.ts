import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(target, key, descriptor);
	else Reflect.deleteProperty(target, key);
}

describe("ProcessTerminal dimensions", () => {
	it("falls back to COLUMNS and LINES before default dimensions", () => {
		const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const previousColumns = process.env.COLUMNS;
		const previousLines = process.env.LINES;

		try {
			Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
			process.env.COLUMNS = "123";
			process.env.LINES = "45";

			const terminal = new ProcessTerminal();

			assert.equal(terminal.columns, 123);
			assert.equal(terminal.rows, 45);
		} finally {
			if (previousColumnsDescriptor) {
				Object.defineProperty(process.stdout, "columns", previousColumnsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "columns");
			}
			if (previousRowsDescriptor) {
				Object.defineProperty(process.stdout, "rows", previousRowsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
			if (previousColumns === undefined) {
				delete process.env.COLUMNS;
			} else {
				process.env.COLUMNS = previousColumns;
			}
			if (previousLines === undefined) {
				delete process.env.LINES;
			} else {
				process.env.LINES = previousLines;
			}
		}
	});
});

describe("ProcessTerminal keyboard protocol cleanup", () => {
	it("cancels the modifyOtherKeys fallback timer when stopped before timeout", async () => {
		const stdinDescriptors = {
			isRaw: Object.getOwnPropertyDescriptor(process.stdin, "isRaw"),
			on: Object.getOwnPropertyDescriptor(process.stdin, "on"),
			pause: Object.getOwnPropertyDescriptor(process.stdin, "pause"),
			removeListener: Object.getOwnPropertyDescriptor(process.stdin, "removeListener"),
			resume: Object.getOwnPropertyDescriptor(process.stdin, "resume"),
			setEncoding: Object.getOwnPropertyDescriptor(process.stdin, "setEncoding"),
			setRawMode: Object.getOwnPropertyDescriptor(process.stdin, "setRawMode"),
		};
		const stdoutDescriptors = {
			on: Object.getOwnPropertyDescriptor(process.stdout, "on"),
			removeListener: Object.getOwnPropertyDescriptor(process.stdout, "removeListener"),
			write: Object.getOwnPropertyDescriptor(process.stdout, "write"),
		};
		const processKillDescriptor = Object.getOwnPropertyDescriptor(process, "kill");
		const writes: string[] = [];

		try {
			Object.defineProperty(process.stdin, "isRaw", { value: false, configurable: true });
			Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
			Object.defineProperty(process.stdin, "setEncoding", { value: () => process.stdin, configurable: true });
			Object.defineProperty(process.stdin, "resume", { value: () => process.stdin, configurable: true });
			Object.defineProperty(process.stdin, "pause", { value: () => process.stdin, configurable: true });
			Object.defineProperty(process.stdin, "on", { value: () => process.stdin, configurable: true });
			Object.defineProperty(process.stdin, "removeListener", { value: () => process.stdin, configurable: true });
			Object.defineProperty(process.stdout, "write", {
				value: (chunk: unknown) => {
					writes.push(String(chunk));
					return true;
				},
				configurable: true,
			});
			Object.defineProperty(process.stdout, "on", { value: () => process.stdout, configurable: true });
			Object.defineProperty(process.stdout, "removeListener", { value: () => process.stdout, configurable: true });
			Object.defineProperty(process, "kill", { value: () => true, configurable: true });

			const terminal = new ProcessTerminal();
			terminal.start(() => {}, () => {});
			terminal.stop();

			await new Promise((resolve) => setTimeout(resolve, 220));

			assert.equal(writes.includes("\x1b[>4;2m"), false);
		} finally {
			restoreProperty(process.stdin, "isRaw", stdinDescriptors.isRaw);
			restoreProperty(process.stdin, "setRawMode", stdinDescriptors.setRawMode);
			restoreProperty(process.stdin, "setEncoding", stdinDescriptors.setEncoding);
			restoreProperty(process.stdin, "resume", stdinDescriptors.resume);
			restoreProperty(process.stdin, "pause", stdinDescriptors.pause);
			restoreProperty(process.stdin, "on", stdinDescriptors.on);
			restoreProperty(process.stdin, "removeListener", stdinDescriptors.removeListener);
			restoreProperty(process.stdout, "write", stdoutDescriptors.write);
			restoreProperty(process.stdout, "on", stdoutDescriptors.on);
			restoreProperty(process.stdout, "removeListener", stdoutDescriptors.removeListener);
			restoreProperty(process, "kill", processKillDescriptor);
		}
	});
});
