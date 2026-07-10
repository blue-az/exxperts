import fs from "node:fs";

import { createPersistentAgentFromScaffoldInput } from "../../apps/web-server/src/persistent-agents.js";

// Thin tsx helper so the rooms-only CLI picker can create a room by reusing the
// exact same scaffold logic the web app and cli-rooms extension use. Reads
// { displayName, userName, preferredUserAddress? } from stdin, prints
// { agentId, displayName } on success.

function readStdinJson(): any {
	const raw = fs.readFileSync(0, "utf-8").trim();
	return raw ? JSON.parse(raw) : {};
}

function main(): void {
	const input = readStdinJson();
	const displayName = String(input.displayName ?? "").trim();
	const userName = String(input.userName ?? "").trim();
	if (!displayName) throw new Error("displayName is required");
	if (!userName) throw new Error("userName is required");
	const preferredUserAddress = String(input.preferredUserAddress ?? "").trim();

	const result = createPersistentAgentFromScaffoldInput({
		displayName,
		userName,
		...(preferredUserAddress ? { preferredUserAddress } : {}),
	});

	process.stdout.write(JSON.stringify({ agentId: result.agent.id, displayName: result.agent.displayName }));
}

main();
