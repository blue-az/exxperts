import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	buildOpenAiCompatibleSetupPlan,
	writeOpenAiCompatibleSetupFiles,
	type OpenAiCompatibleSetupConfig,
} from "../src/cli/setup-openai-compatible.js";

describe("setup openai-compatible", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authJsonPath: string;
	let appPolicyPath: string;

	const config: OpenAiCompatibleSetupConfig = {
		displayName: "OpenAI-compatible gateway",
		baseUrl: "https://gateway.example.com/v1",
		primaryRoomModelId: "primary-model",
		additionalRoomModelIds: ["secondary-model"],
		maintenanceModelId: "maintenance-model",
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-setup-openai-compatible-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authJsonPath = join(tempDir, "auth.json");
		appPolicyPath = join(tempDir, "app", "openai-compatible-ai-profile.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function buildPlan(setupConfig: OpenAiCompatibleSetupConfig = config) {
		return buildOpenAiCompatibleSetupPlan(setupConfig, { agentDir: tempDir, modelsPath: modelsJsonPath, appPolicyPath });
	}

	test("writes only non-secret runtime models config and preserves unrelated providers", () => {
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"other-provider": {
						name: "Other Provider",
						baseUrl: "https://other.example.com/v1",
						api: "openai-completions",
						models: [{ id: "other-model", name: "Other Model" }],
					},
				},
			}),
		);

		const plan = buildPlan();
		expect(plan.conflicts).toEqual([]);

		const result = writeOpenAiCompatibleSetupFiles(plan);

		expect(result.updated).toEqual([modelsJsonPath, appPolicyPath]);
		expect(result.backups).toHaveLength(1);
		expect(existsSync(authJsonPath)).toBe(false);

		const written = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
		expect(written.providers["other-provider"].models[0].id).toBe("other-model");
		expect(written.providers["openai-compatible"]).toEqual({
			name: "OpenAI-compatible gateway",
			baseUrl: "https://gateway.example.com/v1",
			api: "openai-completions",
			models: [
				{ id: "primary-model", name: "primary-model" },
				{ id: "secondary-model", name: "secondary-model" },
				{ id: "maintenance-model", name: "maintenance-model" },
			],
		});

		const policy = JSON.parse(readFileSync(appPolicyPath, "utf-8"));
		expect(policy).toEqual({
			profileId: "openai-compatible",
			providerId: "openai-compatible",
			label: "OpenAI-compatible gateway",
			roomModels: [
				{ modelId: "primary-model", label: "primary-model" },
				{ modelId: "secondary-model", label: "secondary-model" },
			],
			maintenanceModel: "maintenance-model",
		});
	});

	test("refuses to overwrite advanced existing openai-compatible provider config", () => {
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"openai-compatible": {
						name: "Existing Gateway",
						baseUrl: "https://gateway.example.com/v1",
						api: "openai-completions",
						apiKey: "GATEWAY_API_KEY",
						models: [{ id: "primary-model", name: "Primary", compat: { supportsStore: false } }],
					},
				},
			}),
		);

		const plan = buildPlan();

		expect(plan.conflicts.join("\n")).toContain("advanced provider config (apiKey)");
		expect(plan.conflicts.join("\n")).toContain("advanced model config (compat)");
		expect(() => writeOpenAiCompatibleSetupFiles(plan)).toThrow("refusing to write files");
	});
});
