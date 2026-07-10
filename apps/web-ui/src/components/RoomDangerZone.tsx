import { useEffect, useRef, useState } from "react";
import type { PersistentAgentArchiveResponse, PersistentAgentId, PersistentAgentStatus } from "../types";

export function RoomDangerZone({ status, onArchive }: { status: PersistentAgentStatus; onArchive: (agentId: PersistentAgentId, confirmation: string) => Promise<PersistentAgentArchiveResponse> }) {
	const [confirming, setConfirming] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const confirmRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (confirming) confirmRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}, [confirming]);

	async function submitDelete(): Promise<void> {
		setSubmitting(true);
		setError(null);
		try {
			// The archive endpoint gates on this phrase; the user approved via the confirm step.
			await onArchive(status.id, `DELETE ${status.id}`);
		} catch (e) {
			setError((e as Error).message || "Failed to delete room.");
			setSubmitting(false);
		}
	}

	return (
		<div className="room-danger-zone">
			{!confirming && (
				<div className="room-danger-row">
					<p className="room-danger-note">Deleting moves the room to archive. Files stay on this machine.</p>
					<button className="inline-action room-danger-action" disabled={submitting} onClick={() => { setConfirming(true); setError(null); }}>Delete room…</button>
				</div>
			)}
			{confirming && (
				<div className="room-danger-confirm" ref={confirmRef}>
					<p className="room-danger-note"><strong>Delete {status.displayName || status.id}?</strong> The room moves to archive and disappears from Home. Files stay on this machine. Restore is not available yet.</p>
					<div className="room-danger-confirm-actions">
						<button className="landing-action room-danger-submit" disabled={submitting} onClick={() => void submitDelete()}>{submitting ? "Deleting…" : "Delete room"}</button>
						<button className="inline-action" type="button" disabled={submitting} onClick={() => { setConfirming(false); setError(null); }}>Cancel</button>
					</div>
					{error && <div className="workspaces-error">{error}</div>}
				</div>
			)}
		</div>
	);
}
