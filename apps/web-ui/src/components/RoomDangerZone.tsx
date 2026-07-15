import { useState } from "react";
import type { PersistentAgentArchiveResponse, PersistentAgentId, PersistentAgentStatus } from "../types";

// Opening the Delete room pane IS the confirmation step: the user deliberately
// navigated here, so the pane states the consequences and one red click deletes.
export function RoomDangerZone({ status, onArchive }: { status: PersistentAgentStatus; onArchive: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentArchiveResponse> }) {
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submitDelete(): Promise<void> {
		setSubmitting(true);
		setError(null);
		try {
			// The archive endpoint gates on this phrase; navigating to this pane and
			// clicking the red button is the user's confirmation.
			await onArchive(status.id, `DELETE ${status.id}`);
		} catch (e) {
			setError((e as Error).message || "Failed to delete room.");
			setSubmitting(false);
		}
	}

	return (
		<div className="room-danger-zone">
			<header className="rs-pane-head">
				<h3>Delete room</h3>
			</header>
			<p className="rs-pane-sub">Deleting moves the room to archive and it disappears from Home.</p>
			<div className="rs-row">
				<div className="rs-row-main">
					<span className="rs-row-label">Delete {status.displayName || status.id}?</span>
					<span className="rs-row-hint">Files stay on this machine. Restore is not available yet.</span>
				</div>
				<button className="rs-btn rs-btn-danger" disabled={submitting} onClick={() => void submitDelete()}>{submitting ? "Deleting…" : "Delete room"}</button>
			</div>
			{error && <div className="workspaces-error">{error}</div>}
		</div>
	);
}
