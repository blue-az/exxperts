import { useEffect, useRef, useState } from "react";
import type { PersistentAgentStatus } from "../types";
import { fetchPersistentRoomMaintenanceSettings, updatePersistentRoomMaintenanceSettings } from "../persistent-room-management-api";
import { RsInfo } from "./rs-info";

const MEMORY_BUDGET_MIN_TOKENS = 10_000;
const MEMORY_BUDGET_MAX_TOKENS = 50_000;

function fmtTokensK(value: number): string {
	// Tiny values must not read as "0k": show them plainly.
	if (value < 950) return `${Math.max(0, Math.round(value))}`;
	if (value < 9_500) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${Math.round(value / 1000)}k`;
}

export function RoomMaintenanceSection({ status }: { status: PersistentAgentStatus }) {
	const [fastPath, setFastPath] = useState<boolean | null>(null);
	const [quickAutoApply, setQuickAutoApply] = useState<boolean | null>(null);
	const [budget, setBudget] = useState<number | null>(null);
	const [savedBudget, setSavedBudget] = useState<number | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const budgetSaveTimer = useRef<number | null>(null);

	useEffect(() => {
		let cancelled = false;
		setFastPath(null);
		setQuickAutoApply(null);
		setBudget(null);
		setSavedBudget(null);
		setError(null);
		fetchPersistentRoomMaintenanceSettings(status.id)
			.then((response) => {
				if (cancelled) return;
				setFastPath(response.settings.fastPathSecondApproval);
				setQuickAutoApply(response.settings.quickCheckpointAutoApply);
				setBudget(response.settings.memoryBudgetTokens);
				setSavedBudget(response.settings.memoryBudgetTokens);
			})
			.catch((e) => {
				if (!cancelled) setError((e as Error).message);
			});
		return () => {
			cancelled = true;
		};
	}, [status.id]);

	// Debounced budget save: the slider updates locally on every tick and
	// persists once the user settles for half a second.
	useEffect(() => {
		if (budget === null || savedBudget === null || budget === savedBudget) return;
		if (budgetSaveTimer.current !== null) window.clearTimeout(budgetSaveTimer.current);
		budgetSaveTimer.current = window.setTimeout(() => {
			budgetSaveTimer.current = null;
			updatePersistentRoomMaintenanceSettings(status.id, { memoryBudgetTokens: budget })
				.then((response) => {
					setSavedBudget(response.settings.memoryBudgetTokens);
					setBudget((current) => (current === budget ? response.settings.memoryBudgetTokens : current));
					setError(null);
				})
				.catch((e) => setError((e as Error).message));
		}, 500);
		return () => {
			if (budgetSaveTimer.current !== null) window.clearTimeout(budgetSaveTimer.current);
		};
	}, [budget, savedBudget, status.id]);

	async function toggleFastPath(next: boolean) {
		if (saving || fastPath === null) return;
		setSaving(true);
		setError(null);
		const previous = fastPath;
		setFastPath(next);
		try {
			const response = await updatePersistentRoomMaintenanceSettings(status.id, { fastPathSecondApproval: next });
			setFastPath(response.settings.fastPathSecondApproval);
		} catch (e) {
			setFastPath(previous);
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	async function toggleQuickAutoApply(next: boolean) {
		if (saving || quickAutoApply === null) return;
		setSaving(true);
		setError(null);
		const previous = quickAutoApply;
		setQuickAutoApply(next);
		try {
			const response = await updatePersistentRoomMaintenanceSettings(status.id, { quickCheckpointAutoApply: next });
			setQuickAutoApply(response.settings.quickCheckpointAutoApply);
		} catch (e) {
			setQuickAutoApply(previous);
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	const currentMemoryTokens = status.promptBudget?.l1bEstimatedTokens ?? null;
	const usagePercent = budget !== null && currentMemoryTokens !== null ? Math.round((currentMemoryTokens / budget) * 100) : null;
	const overBudget = usagePercent !== null && usagePercent > 100;

	return (
		<div className="room-maintenance-section">
			<header className="rs-pane-head">
				<h3>Memory</h3>
			</header>
			<p className="rs-pane-sub">How this room saves and maintains what it learns.</p>
			<label className="rs-row">
				<div className="rs-row-main">
					<span className="rs-row-label">
						Automatic memory maintenance
						<RsInfo text="After you sign off a Learn or Review Memory assessment, the final proposal is applied without the second review screen. Proposals that touch must-keep memory or fail validation always come back for manual review. Every change still archives the previous memory and writes an audit record." />
					</span>
					<span className="rs-row-hint">Apply signed-off memory updates without a second review screen.</span>
				</div>
				<input
					className="workspaces-tool-switch"
					type="checkbox"
					checked={fastPath === true}
					disabled={fastPath === null || saving}
					onChange={(e) => void toggleFastPath(e.target.checked)}
					aria-label="Automatic memory maintenance"
				/>
			</label>
			<label className="rs-row">
				<div className="rs-row-main">
					<span className="rs-row-label">
						Quick checkpoint applies automatically
						<RsInfo text="When nothing deterministic blocks a Checkpoint proposal, it saves without showing the content first. Proposals with blockers (trimmed transcripts, incomplete drafts) always come back for review. Every save still archives the previous memory and writes an audit record." />
					</span>
					<span className="rs-row-hint">Save blocker-free Checkpoint proposals without showing the preview.</span>
				</div>
				<input
					className="workspaces-tool-switch"
					type="checkbox"
					checked={quickAutoApply === true}
					disabled={quickAutoApply === null || saving}
					onChange={(e) => void toggleQuickAutoApply(e.target.checked)}
					aria-label="Quick checkpoint applies automatically"
				/>
			</label>
			<div className="rs-row memory-budget-block">
				<div className="memory-budget-head">
					<span className="rs-row-label">
						Memory budget
						<RsInfo text="Learn and Review Memory treat this as a target when rewriting memory: bigger keeps more detail, smaller keeps the room sharper and cheaper. Nothing is blocked when the room runs over; you are nudged to review instead." />
					</span>
					<strong className="memory-budget-value">{budget !== null ? `${fmtTokensK(budget)} tokens` : "…"}</strong>
				</div>
				<input
					className="memory-budget-slider"
					type="range"
					min={MEMORY_BUDGET_MIN_TOKENS}
					max={MEMORY_BUDGET_MAX_TOKENS}
					step={1000}
					value={budget ?? MEMORY_BUDGET_MIN_TOKENS}
					disabled={budget === null}
					onChange={(e) => setBudget(Number(e.target.value))}
					aria-label="Memory budget in tokens"
				/>
				{usagePercent !== null && (
					<p className={`memory-budget-usage${overBudget ? " over" : ""}`}>
						~{fmtTokensK(currentMemoryTokens!)} tokens in use, {usagePercent}% of the target.{overBudget ? " Consider running Review Memory." : ""}
					</p>
				)}
			</div>
			{error && <div className="room-maintenance-error">{error}</div>}
		</div>
	);
}
