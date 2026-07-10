import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as XLSX from "xlsx";

const {
	createPersistentRoomCapabilityPolicy,
} = await import("../src/persistent-room-workspace-policy.js");
const {
	createPersistentRoomWorkspaceTools,
	PersistentRoomWorkspaceToolError,
} = await import("../src/persistent-room-workspace-tools.js");

const agentId = "workspace-spreadsheet-smoke-room";

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

function writeWorkbook(file: string): void {
	const wb = XLSX.utils.book_new();
	const sales = XLSX.utils.aoa_to_sheet([
		["Name", "Revenue", "Double revenue", "Notes"],
		["Alice", 100, null, "North"],
		["Bob", 250, null, "South"],
		["Carla", 325, null, "West"],
	]);
	sales.C2 = { t: "n", f: "B2*2", v: 200, w: "200" } as any;
	sales.C3 = { t: "n", f: "B3*2", v: 500, w: "500" } as any;
	XLSX.utils.book_append_sheet(wb, sales, "Sales");

	const rows: any[][] = [["Index", "Value", "Extra"]];
	for (let i = 1; i <= 12; i += 1) rows.push([i, `value-${i}`, `extra-${i}`]);
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Large");

	const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
	fs.writeFileSync(file, buffer);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-workspace-spreadsheet-"));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;

try {
	const repoRoot = path.join(tmp, "repo");
	const homeRoot = path.join(tmp, "home");
	const exxetaStateRoot = path.join(homeRoot, ".exxperts", "app");
	const persistentAgentsRoot = path.join(exxetaStateRoot, "personalized-agents");
	const workspaceRoot = path.join(tmp, "workspace");
	const outsideRoot = path.join(tmp, "outside");
	for (const dir of [repoRoot, exxetaStateRoot, persistentAgentsRoot, workspaceRoot, outsideRoot]) fs.mkdirSync(dir, { recursive: true });

	const workbookPath = path.join(workspaceRoot, "sales.xlsx");
	writeWorkbook(workbookPath);
	fs.writeFileSync(path.join(workspaceRoot, "not-a-workbook.txt"), "Name,Revenue\nAlice,100\n");
	const outsideWorkbookPath = path.join(outsideRoot, "outside.xlsx");
	writeWorkbook(outsideWorkbookPath);
	const homeWorkbookPath = path.join(homeRoot, "home.xlsx");
	writeWorkbook(homeWorkbookPath);
	process.env.HOME = homeRoot;
	process.env.USERPROFILE = homeRoot;
	try {
		fs.symlinkSync(outsideWorkbookPath, path.join(workspaceRoot, "outside-link.xlsx"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
	}

	const policy = createPersistentRoomCapabilityPolicy({
		agentId,
		conversationId: "c_workspace_spreadsheet_smoke",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root: workspaceRoot,
		workspaceAccessMode: "bounded",
		source: "manual",
		mode: "read",
		now: new Date("2026-07-01T00:00:00.000Z"),
	});
	const tools = new Map(createPersistentRoomWorkspaceTools(policy).map((tool: any) => [tool.name, tool]));
	assert(tools.has("read_spreadsheet"), "read_spreadsheet should be registered for bounded workspace policy");

	const firstSheet = await execute(tools, "read_spreadsheet", { path: "sales.xlsx" }, tmp);
	assert(firstSheet.includes("# Spreadsheet preview: sales.xlsx"), "output should identify workbook basename only");
	assert(firstSheet.includes("Sheets (2):"), "output should list workbook sheets");
	assert(firstSheet.includes("1. Sales"), "output should list Sales sheet");
	assert(firstSheet.includes("2. Large"), "output should list Large sheet");
	assert(firstSheet.includes("Selected sheet: Sales"), "default should preview first sheet");
	assert(firstSheet.includes("| Name | Revenue | Double revenue | Notes |"), "output should include readable table header");
	assert(firstSheet.includes("| Alice | 100 | 200 | North |"), "output should include cached/display formula value without raw ZIP/XML");
	assert(firstSheet.includes("Warning: formula cells were detected"), "output should warn when formulas are present");
	assert(!firstSheet.includes("PK\u0003\u0004") && !firstSheet.includes("xl/workbook.xml"), "output should not expose raw XLSX ZIP/XML bytes");

	const selectedByName = await execute(tools, "read_spreadsheet", { path: "sales.xlsx", sheet: "Large", maxRows: 3, maxColumns: 2 }, tmp);
	assert(selectedByName.includes("Selected sheet: Large"), "sheet name selection should work");
	assert(selectedByName.includes("Preview: 3 of 13 rows, 2 of 3 columns."), "preview dimensions should respect row/column limits");
	assert(selectedByName.includes("Truncated preview: row cap 3, column cap 2."), "output should explain row/column truncation");
	assert(selectedByName.includes("| Index | Value |"), "bounded preview should include selected sheet table");
	assert(!selectedByName.includes("Extra"), "column cap should omit later columns from preview table");

	const selectedByIndex = await execute(tools, "read_spreadsheet", { path: "sales.xlsx", sheet: 2, maxRows: 2, maxColumns: 2 }, tmp);
	assert(selectedByIndex.includes("Selected sheet: Large"), "1-based numeric sheet selection should work");

	const detailResult = await executeResult(tools, "read_spreadsheet", { path: "sales.xlsx", sheet: "Sales", maxRows: 2, maxColumns: 2 }, tmp);
	assert(detailResult.details?.path === "sales.xlsx", "details should include workspace-relative path only");
	assert(detailResult.details?.workbook === "sales.xlsx", "details should include workbook basename");
	assert(detailResult.details?.sheet === "Sales", "details should include selected sheet name");
	assert(detailResult.details?.previewRows === 2 && detailResult.details?.previewColumns === 2, "details should include bounded preview dimensions");

	await expectReject(() => execute(tools, "read_spreadsheet", { path: path.join(workspaceRoot, "sales.xlsx") }, tmp), tmp, "absolute spreadsheet path");
	await expectReject(() => execute(tools, "read_spreadsheet", { path: "~/sales.xlsx" }, tmp), tmp, "home spreadsheet path");
	await expectReject(() => execute(tools, "read_spreadsheet", { path: "../outside/outside.xlsx" }, tmp), tmp, "parent traversal spreadsheet path");
	await expectReject(() => execute(tools, "read_spreadsheet", { path: "not-a-workbook.txt" }, tmp), tmp, "unsupported spreadsheet extension");
	await expectReject(() => execute(tools, "read_spreadsheet", { path: "sales.xlsx", sheet: 99 }, tmp), tmp, "missing numeric sheet");
	await expectReject(() => execute(tools, "read_spreadsheet", { path: "sales.xlsx", sheet: "Missing" }, tmp), tmp, "missing named sheet");
	if (fs.existsSync(path.join(workspaceRoot, "outside-link.xlsx"))) {
		await expectReject(() => execute(tools, "read_spreadsheet", { path: "outside-link.xlsx" }, tmp), tmp, "symlink file escape");
	}

	const localFilesPolicy = createPersistentRoomCapabilityPolicy({
		agentId,
		conversationId: "c_workspace_spreadsheet_local_files_smoke",
		repoRoot,
		persistentAgentsRoot,
		exxetaStateRoot,
		root: workspaceRoot,
		workspaceAccessMode: "localFiles",
		source: "manual",
		mode: "read",
		now: new Date("2026-07-01T00:05:00.000Z"),
	});
	const localFilesTools = new Map(createPersistentRoomWorkspaceTools(localFilesPolicy).map((tool: any) => [tool.name, tool]));
	assert([...localFilesTools.keys()].join(",") === "read_spreadsheet", "local-files mode should register only spreadsheet custom tool");
	const localRelative = await execute(localFilesTools, "read_spreadsheet", { path: "sales.xlsx", sheet: "Sales", maxRows: 2, maxColumns: 2 }, tmp);
	assert(localRelative.includes("# Spreadsheet preview: sales.xlsx"), "local-files relative read should resolve from workspace root");
	assert(localRelative.includes("| Name | Revenue |"), "local-files relative read should include table preview");
	const localAbsolute = await executeResult(localFilesTools, "read_spreadsheet", { path: outsideWorkbookPath, sheet: "Sales", maxRows: 2, maxColumns: 2 }, tmp);
	assert(toolOutput(localAbsolute).includes("# Spreadsheet preview: outside.xlsx"), "local-files absolute read should allow explicit outside workbook path");
	assert(localAbsolute.details?.path === "outside.xlsx", "local-files absolute details should avoid exposing temp absolute root when possible");
	const localHome = await executeResult(localFilesTools, "read_spreadsheet", { path: "~/home.xlsx", sheet: 1, maxRows: 2, maxColumns: 2 }, tmp);
	assert(toolOutput(localHome).includes("# Spreadsheet preview: home.xlsx"), "local-files ~ read should expand home path");
	assert(localHome.details?.path === "home.xlsx", "local-files ~ details should avoid exposing temp home root when possible");
	if (fs.existsSync(path.join(workspaceRoot, "outside-link.xlsx"))) {
		const localSymlink = await execute(localFilesTools, "read_spreadsheet", { path: "outside-link.xlsx", sheet: "Sales", maxRows: 2, maxColumns: 2 }, tmp);
		assert(localSymlink.includes("# Spreadsheet preview: outside-link.xlsx"), "local-files spreadsheet read should allow symlink traversal");
	}

	console.log("persistent-room workspace spreadsheet smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
} finally {
	process.env.HOME = previousHome;
	if (previousUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = previousUserProfile;
	fs.rmSync(tmp, { recursive: true, force: true });
}
