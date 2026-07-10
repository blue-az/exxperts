import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
	createPersistentRoomCapabilityPolicy,
	createPersistentRoomDefaultCapabilityPolicy,
	deletePersistentRoomDefaultCapabilityPolicy,
	persistentRoomWorkspacePolicyPath,
	resolvePersistentRoomCapabilityPolicy,
	writePersistentRoomDefaultCapabilityPolicy,
} = await import("../src/persistent-room-workspace-policy.js");
const {
	createPersistentRoomWorkspaceTools,
	isPersistentRoomWorkspaceToolPolicyEnabled,
	PersistentRoomWorkspaceToolError,
	resolvePersistentRoomWorkspacePath,
} = await import("../src/persistent-room-workspace-tools.js");

const agentId = "workspace-tools-smoke-room";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function toolOutput(result: any): string {
	return (result?.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
}

function assertNoAbsoluteLeak(value: unknown, tmp: string, label: string): void {
	const serialized = typeof value === "string" ? value : JSON.stringify(value);
	assert(!serialized.includes(tmp), `${label}: must not leak temp absolute workspace path`);
}

async function executeResult(tools: Map<string, any>, name: string, params: Record<string, unknown>, tmp: string): Promise<any> {
	const tool = tools.get(name);
	assert(tool, `tool ${name} should be registered`);
	const result = await tool.execute(`smoke-${name}`, params, undefined, undefined, {} as any);
	assertNoAbsoluteLeak(result, tmp, `${name} result`);
	return result;
}

async function execute(tools: Map<string, any>, name: string, params: Record<string, unknown>, tmp: string): Promise<string> {
	const result = await executeResult(tools, name, params, tmp);
	const output = toolOutput(result);
	assertNoAbsoluteLeak(output, tmp, `${name} output`);
	return output;
}

async function expectReject(fn: () => unknown | Promise<unknown>, tmp: string, label: string): Promise<void> {
	try {
		await fn();
	} catch (error) {
		assert(error instanceof PersistentRoomWorkspaceToolError, `${label}: expected PersistentRoomWorkspaceToolError`);
		assertNoAbsoluteLeak(error.message, tmp, `${label} error`);
		assert(!/\/var\/|\/tmp\/|Users\//.test(error.message), `${label}: error should stay generic`);
		return;
	}
	throw new Error(`${label}: expected rejection`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-workspace-tools-"));

try {
	const repoRoot = path.join(tmp, "repo");
	const homeRoot = path.join(tmp, "home");
	const exxetaStateRoot = path.join(homeRoot, ".exxeta");
	const persistentAgentsRoot = path.join(exxetaStateRoot, "personalized-agents");
	const workspaceRoot = path.join(tmp, "workspace");
	const outsideRoot = path.join(tmp, "outside");
	for (const dir of [repoRoot, exxetaStateRoot, persistentAgentsRoot, workspaceRoot, outsideRoot]) fs.mkdirSync(dir, { recursive: true });

	fs.writeFileSync(path.join(workspaceRoot, "README.md"), "# Workspace\n\nSafe file.\n");
	fs.mkdirSync(path.join(workspaceRoot, "docs"));
	fs.writeFileSync(path.join(workspaceRoot, "docs", "plan.md"), "Plan line 1\nPlan line 2\n");
	fs.writeFileSync(path.join(workspaceRoot, "docs", "notes.txt"), "Notes are safe.\n");
	fs.mkdirSync(path.join(workspaceRoot, "existing-dir.md"));
	fs.mkdirSync(path.join(workspaceRoot, ".git"));
	fs.writeFileSync(path.join(workspaceRoot, ".git", "config"), "[secret]\n");
	fs.mkdirSync(path.join(workspaceRoot, ".exxeta"));
	fs.writeFileSync(path.join(workspaceRoot, ".exxeta", "state.json"), "{}\n");
	fs.mkdirSync(path.join(workspaceRoot, "node_modules"));
	fs.writeFileSync(path.join(workspaceRoot, "node_modules", "package.json"), "{}\n");
	fs.writeFileSync(path.join(workspaceRoot, ".env"), "TOKEN=secret\n");
	fs.writeFileSync(path.join(workspaceRoot, ".env.local"), "TOKEN=secret\n");
	fs.writeFileSync(path.join(workspaceRoot, "private.pem"), "secret\n");
	fs.writeFileSync(path.join(workspaceRoot, "deploy.key"), "secret\n");
	fs.writeFileSync(path.join(workspaceRoot, "id_rsa"), "secret\n");
	fs.writeFileSync(path.join(outsideRoot, "outside.txt"), "outside secret\n");
	fs.writeFileSync(path.join(outsideRoot, "outside.md"), "outside markdown\n");
	try {
		fs.symlinkSync(path.join(outsideRoot, "outside.txt"), path.join(workspaceRoot, "outside-link.txt"));
		fs.symlinkSync(path.join(outsideRoot, "outside.md"), path.join(workspaceRoot, "outside-link.md"));
		fs.symlinkSync(outsideRoot, path.join(workspaceRoot, "outside-dir-link"), "dir");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
	}

	const policy = createPersistentRoomCapabilityPolicy({
		agentId: agentId,
		conversationId: "c_workspace_tools_smoke",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root: workspaceRoot,
		workspaceAccessMode: "bounded",
		source: "manual",
		mode: "read",
		now: new Date("2026-05-27T00:00:00.000Z"),
	});
	const legacyNoToolPolicy = { ...policy, allowedToolNames: [] };
	delete (legacyNoToolPolicy as any).toolSelection;
	assert(!isPersistentRoomWorkspaceToolPolicyEnabled(legacyNoToolPolicy), "legacy MR5.5a policy with root but empty allowedToolNames must not activate workspace tools");
	assert(createPersistentRoomWorkspaceTools(legacyNoToolPolicy).length === 0, "legacy MR5.5a policy should not create workspace tools");

	const tools = new Map(createPersistentRoomWorkspaceTools(policy).map((tool: any) => [tool.name, tool]));
	assert(isPersistentRoomWorkspaceToolPolicyEnabled(policy), "workspace policy should activate workspace tools");
	assert([...tools.keys()].sort().join(",") === "find,ls,read,read_spreadsheet,write_markdown_file", "should register exactly the standard bounded workspace tools");
	assert(!tools.has("bash") && !tools.has("grep") && !tools.has("write") && !tools.has("edit"), "should not register bash or native Pi filesystem mutation/search tools");
	for (const tool of tools.values()) {
		assert(String(tool.description).includes("workspace-relative") || String(tool.description).includes("workspace-relative paths"), `${tool.name} description should state workspace-relative contract`);
	}

	const localFilesPolicy = createPersistentRoomCapabilityPolicy({
		agentId: agentId,
		conversationId: "c_workspace_tools_local_files_smoke",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root: workspaceRoot,
		workspaceAccessMode: "localFiles",
		source: "manual",
		mode: "read",
		now: new Date("2026-05-27T00:05:00.000Z"),
	});
	const localFilesTools = new Map(createPersistentRoomWorkspaceTools(localFilesPolicy).map((tool: any) => [tool.name, tool]));
	assert(isPersistentRoomWorkspaceToolPolicyEnabled(localFilesPolicy), "local-files policy should activate workspace tools");
	assert([...localFilesTools.keys()].sort().join(",") === "read_spreadsheet", "local-files custom tools should register only read_spreadsheet and avoid native read/ls/find collisions");
	assert(!localFilesTools.has("read") && !localFilesTools.has("ls") && !localFilesTools.has("find") && !localFilesTools.has("grep") && !localFilesTools.has("write") && !localFilesTools.has("edit") && !localFilesTools.has("bash"), "local-files mode should not register native filesystem tools as custom tools");
	const localFilesNoSpreadsheetPolicy = createPersistentRoomCapabilityPolicy({
		agentId: agentId,
		conversationId: "c_workspace_tools_local_files_no_spreadsheet_smoke",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root: workspaceRoot,
		workspaceAccessMode: "localFiles",
		source: "manual",
		mode: "read",
		toolSelection: { kind: "custom", allowedToolNames: ["read", "ls"] },
		now: new Date("2026-05-27T00:06:00.000Z"),
	});
	assert(isPersistentRoomWorkspaceToolPolicyEnabled(localFilesNoSpreadsheetPolicy), "local-files native-only custom policy should still activate native runtime tools");
	assert(createPersistentRoomWorkspaceTools(localFilesNoSpreadsheetPolicy).length === 0, "disabled read_spreadsheet should not register custom spreadsheet tool");

	const lsRoot = await execute(tools, "ls", { path: "." }, tmp);
	assert(lsRoot.includes("README.md"), "ls . should include safe file");
	assert(lsRoot.includes("docs/"), "ls . should suffix directories with slash");
	assert(!lsRoot.includes(".git"), "ls . must omit .git");
	assert(!lsRoot.includes(".exxeta"), "ls . must omit .exxeta");
	assert(!lsRoot.includes("node_modules"), "ls . must omit node_modules");
	assert(!lsRoot.includes(".env"), "ls . must omit .env files");
	assert(!lsRoot.includes("private.pem") && !lsRoot.includes("deploy.key") && !lsRoot.includes("id_rsa"), "ls . must omit secret-looking filenames");

	const findMarkdown = await execute(tools, "find", { pattern: "**/*.md", path: "." }, tmp);
	assert(findMarkdown.includes("README.md"), "find should include root markdown files");
	assert(findMarkdown.includes("docs/plan.md"), "find should include nested safe markdown files");
	assert(!findMarkdown.includes(workspaceRoot), "find output must not include absolute workspace root");
	assert(!findMarkdown.includes(".git") && !findMarkdown.includes(".exxeta") && !findMarkdown.includes("node_modules"), "find must skip denied directories");
	assert(!findMarkdown.includes(".env") && !findMarkdown.includes("private.pem") && !findMarkdown.includes("deploy.key") && !findMarkdown.includes("id_rsa"), "find must skip secret-looking files");
	assert(!findMarkdown.includes("outside"), "find must not follow symlinked directories or expose outside paths");

	const readSafe = await execute(tools, "read", { path: "docs/plan.md" }, tmp);
	assert(readSafe.includes("Plan line 1") && readSafe.includes("Plan line 2"), "read should return safe file contents");
	assert(!readSafe.includes("bash"), "workspace read output should not suggest bash fallback");

	const writeContent = "# Test\n\nSmall synthetic body.\n";
	const writeResult = await executeResult(tools, "write_markdown_file", { path: "notes/test.md", content: writeContent }, tmp);
	const writeOutput = toolOutput(writeResult);
	assert(writeOutput.includes("file generated to notes/test.md"), "write should report generated workspace-relative path");
	assert(writeResult.details?.path === "notes/test.md", "write details should include workspace-relative path");
	assert(writeResult.details?.bytes === Buffer.byteLength(writeContent, "utf-8"), "write details should include byte count");
	assert(writeResult.details?.created === true && writeResult.details?.overwritten === false, "write details should report created metadata");
	assert(!JSON.stringify(writeResult).includes(writeContent.trim()), "write result/details must not echo full content");
	assert(fs.readFileSync(path.join(workspaceRoot, "notes", "test.md"), "utf-8") === writeContent, "write should create Markdown file under workspace");

	const nestedContent = "# Nested\n";
	await execute(tools, "write_markdown_file", { path: "reports/demo/test.md", content: nestedContent }, tmp);
	assert(fs.readFileSync(path.join(workspaceRoot, "reports", "demo", "test.md"), "utf-8") === nestedContent, "write should create missing parent directories inside workspace");
	await expectReject(() => execute(tools, "write_markdown_file", { path: "notes/test.md", content: "replacement" }, tmp), tmp, "write existing without overwrite");
	const overwriteResult = await executeResult(tools, "write_markdown_file", { path: "notes/test.md", content: "# Replacement\n", overwrite: true }, tmp);
	assert(overwriteResult.details?.created === false && overwriteResult.details?.overwritten === true, "overwrite details should report overwritten metadata");
	assert(fs.readFileSync(path.join(workspaceRoot, "notes", "test.md"), "utf-8") === "# Replacement\n", "overwrite should replace existing Markdown file");
	await expectReject(() => execute(tools, "write_markdown_file", { path: "notes/test.txt", content: "no" }, tmp), tmp, "write non-md");
	await expectReject(() => execute(tools, "write_markdown_file", { path: "notes/test.markdown", content: "no" }, tmp), tmp, "write markdown extension");
	await expectReject(() => execute(tools, "write_markdown_file", { path: path.join(workspaceRoot, "abs.md"), content: "no" }, tmp), tmp, "write absolute path");
	await expectReject(() => execute(tools, "write_markdown_file", { path: "~/test.md", content: "no" }, tmp), tmp, "write home path");
	await expectReject(() => execute(tools, "write_markdown_file", { path: "../escape.md", content: "no" }, tmp), tmp, "write parent escape");
	await expectReject(() => execute(tools, "write_markdown_file", { path: ".git/test.md", content: "no" }, tmp), tmp, "write denied .git");
	await expectReject(() => execute(tools, "write_markdown_file", { path: ".exxeta/test.md", content: "no" }, tmp), tmp, "write denied .exxeta");
	await expectReject(() => execute(tools, "write_markdown_file", { path: "node_modules/test.md", content: "no" }, tmp), tmp, "write denied node_modules");
	await expectReject(() => execute(tools, "write_markdown_file", { path: "existing-dir.md", content: "no" }, tmp), tmp, "write existing directory");
	if (fs.existsSync(path.join(workspaceRoot, "outside-link.md"))) {
		await expectReject(() => execute(tools, "write_markdown_file", { path: "outside-link.md", content: "no", overwrite: true }, tmp), tmp, "write symlink target");
	}
	if (fs.existsSync(path.join(workspaceRoot, "outside-dir-link"))) {
		await expectReject(() => execute(tools, "write_markdown_file", { path: "outside-dir-link/escape.md", content: "no" }, tmp), tmp, "write parent symlink escape");
	}
	await expectReject(() => execute(tools, "write_markdown_file", { path: "too-large.md", content: "x".repeat(128 * 1024 + 1) }, tmp), tmp, "write oversized content");

	await expectReject(() => execute(tools, "read", { path: path.join(workspaceRoot, "README.md") }, tmp), tmp, "absolute path");
	await expectReject(() => execute(tools, "read", { path: "~/README.md" }, tmp), tmp, "home path");
	await expectReject(() => execute(tools, "read", { path: "../outside/outside.txt" }, tmp), tmp, "parent escape");
	await expectReject(() => execute(tools, "read", { path: ".git/config" }, tmp), tmp, ".git read");
	await expectReject(() => execute(tools, "read", { path: ".exxeta/state.json" }, tmp), tmp, ".exxeta read");
	await expectReject(() => execute(tools, "read", { path: "node_modules/package.json" }, tmp), tmp, "node_modules read");
	await expectReject(() => execute(tools, "read", { path: ".env" }, tmp), tmp, ".env read");
	await expectReject(() => execute(tools, "read", { path: ".env.local" }, tmp), tmp, ".env.* read");
	await expectReject(() => execute(tools, "read", { path: "private.pem" }, tmp), tmp, "pem read");
	await expectReject(() => execute(tools, "read", { path: "deploy.key" }, tmp), tmp, "key read");
	await expectReject(() => execute(tools, "read", { path: "id_rsa" }, tmp), tmp, "id_rsa read");
	await expectReject(() => execute(tools, "read", { path: "docs" }, tmp), tmp, "read directory");
	await expectReject(() => execute(tools, "read", { path: "missing.txt" }, tmp), tmp, "nonexistent read");
	if (fs.existsSync(path.join(workspaceRoot, "outside-link.txt"))) {
		await expectReject(() => execute(tools, "read", { path: "outside-link.txt" }, tmp), tmp, "symlink file escape");
	}
	if (fs.existsSync(path.join(workspaceRoot, "outside-dir-link"))) {
		await expectReject(() => execute(tools, "ls", { path: "outside-dir-link" }, tmp), tmp, "symlink directory ls");
	}

	await expectReject(() => resolvePersistentRoomWorkspacePath(policy, "/etc/passwd", "read"), tmp, "direct guard absolute");
	await expectReject(() => resolvePersistentRoomWorkspacePath(policy, "~/.ssh/id_rsa", "read"), tmp, "direct guard home");
	await expectReject(() => resolvePersistentRoomWorkspacePath(policy, "../outside/outside.txt", "read"), tmp, "direct guard traversal");

	const noWorkspaceResolution = resolvePersistentRoomCapabilityPolicy(agentId, "c_workspace_tools_no_default", { persistentAgentsRoot });
	assert(noWorkspaceResolution.source === "none" && noWorkspaceResolution.policy === null, "resolver without thread/default policy should be normal none case");
	const defaultPolicy = createPersistentRoomDefaultCapabilityPolicy({
		agentId: agentId,
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root: workspaceRoot,
		workspaceAccessMode: "bounded",
		displayLabel: "Default Tools Workspace",
		source: "manual",
		mode: "read",
		now: new Date("2026-05-27T01:00:00.000Z"),
	});
	writePersistentRoomDefaultCapabilityPolicy(defaultPolicy, { persistentAgentsRoot });
	assert(!fs.existsSync(persistentRoomWorkspacePolicyPath(agentId, "room_default", { persistentAgentsRoot })), "room-default fallback must not create a room_default thread sidecar");
	const defaultResolution = resolvePersistentRoomCapabilityPolicy(agentId, "c_workspace_tools_default_fallback", { persistentAgentsRoot });
	assert(defaultResolution.source === "room-default", "resolver should use room default when no thread policy exists");
	assert(isPersistentRoomWorkspaceToolPolicyEnabled(defaultResolution.policy), "room-default fallback policy should activate workspace tools");
	const defaultTools = new Map(createPersistentRoomWorkspaceTools(defaultResolution.policy).map((tool: any) => [tool.name, tool]));
	const defaultRead = await execute(defaultTools, "read", { path: "README.md" }, tmp);
	assert(defaultRead.includes("Safe file."), "workspace tools should read via room-default fallback policy");
	deletePersistentRoomDefaultCapabilityPolicy(agentId, { persistentAgentsRoot });
	assert(resolvePersistentRoomCapabilityPolicy(agentId, "c_workspace_tools_default_fallback", { persistentAgentsRoot }).source === "none", "resolver should return none after clearing room default");

	console.log("persistent-room workspace tools smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
