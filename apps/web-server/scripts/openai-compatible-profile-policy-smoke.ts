import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-openai-compatible-profile-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");

try {
	const profiles = await import("../src/persistent-agent-ai-profiles.js");
	const profileState = await import("../src/persistent-agent-ai-profile-state.js");

	assert(!profiles.isPersistentAgentAiProfileId("openai-compatible"), "openai-compatible should not be available before local policy exists");
	assert(!profiles.isPersistentAgentAiProfileId("arbitrary-local"), "arbitrary local profile ids should not be accepted");
	assert(
		!profiles.getAvailablePersistentAgentAiProfiles().some((profile) => profile.id === "openai-compatible"),
		"available profiles should not include openai-compatible before local policy exists",
	);

	const policyPath = path.join(tempHome, ".exxperts", "app", "openai-compatible-ai-profile.json");
	fs.mkdirSync(path.dirname(policyPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		policyPath,
		JSON.stringify(
			{
				profileId: "openai-compatible",
				providerId: "openai-compatible",
				label: "OpenAI-compatible gateway",
				roomModels: [
					{ modelId: "primary-model", label: "Primary Model" },
					{ modelId: "secondary-model", label: "Secondary Model" },
				],
				maintenanceModel: "maintenance-model",
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);

	assert(profiles.isPersistentAgentAiProfileId("openai-compatible"), "openai-compatible should be available after local policy exists");
	assert(
		profiles.getAvailablePersistentAgentAiProfiles().some((profile) => profile.id === "openai-compatible"),
		"available profiles should include openai-compatible after local policy exists",
	);

	const profile = profiles.getPersistentAgentAiProfile("openai-compatible");
	assert(profile.providerId === "openai-compatible", "local profile should use fixed provider id");
	assert(profile.processes.persistentRoom.length === 2, "local profile should expose configured room models only");
	assert(profile.processes.persistentRoom[0].model === "primary-model", "primary room model should be first");
	assert(profile.processes.persistentRoom[1].model === "secondary-model", "additional room model should be second");
	assert(profile.processes.absorb.model === "maintenance-model", "absorb should use maintenance model");
	assert(profile.processes.structuralReview.model === "maintenance-model", "structural review should use maintenance model");
	assert(
		profiles.isPersistentRoomModelForProfile("openai-compatible", "openai-compatible", "secondary-model"),
		"configured room model should be approved for persistent rooms",
	);
	assert(
		!profiles.isPersistentRoomModelForProfile("openai-compatible", "openai-compatible", "maintenance-model"),
		"maintenance-only model should not automatically become a room model",
	);

	profileState.writePersistentAgentAiProfileState("openai-compatible");
	const active = profileState.readPersistentAgentAiProfileState();
	assert(active.profileId === "openai-compatible", "active profile state should accept configured openai-compatible profile");
	assert(active.profile.processes.absorb.model === "maintenance-model", "active profile should load local maintenance policy");

	console.log("openai-compatible profile policy smoke passed");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
