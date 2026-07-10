import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, MutableRefObject, ReactNode, Ref } from "react";
import { Approval } from "./Approval";
import { Message } from "./Message";
import { useEscapeKey } from "./use-escape-key";
import type { ApprovalPreviewData } from "../approval-preview";
import type { ChatItem, ContextHealthStatus } from "../types";
import { modelDisplayName } from "../model-names";

export interface InRoomChatUsage {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	totalTokens: number;
}

export interface InRoomChatShellViewProps {
	sidebar: ReactNode;
	withPreview?: boolean;
	activeDisplay: string;
	ownerSecondary?: string | null;
	busy: boolean;
	usage: InRoomChatUsage;
	contextHealth?: ContextHealthStatus | null;
	currentModelLabel?: string | null;
	topbarActions?: ReactNode;
	composerRightActions?: ReactNode;
	connected: boolean;
	items: ChatItem[];
	empty: boolean;
	messagesRef?: Ref<HTMLDivElement>;
	onSend: (text: string) => boolean;
	onStop?: () => void;
	stopVisible?: boolean;
	stopDisabled?: boolean;
	stopLabel?: string;
	textareaRef?: Ref<HTMLTextAreaElement>;
	composerPlaceholder: string;
	sendUnavailable?: boolean;
	initialDraftValue?: string;
	draftResetKey?: string | number;
	onResolveApproval: (requestId: string, value: any, label: string) => void;
	onApprovalPreview?: (preview: ApprovalPreviewData) => void;
	previewSlot?: ReactNode;
	checkpointPreviewSlot?: ReactNode;
	globalOverlaySlot?: ReactNode;
	// Optional hooks for the resizable right pane (e.g. approval preview).
	// All absent in fixtures, so default behaviour is unchanged.
	workbenchRef?: Ref<HTMLDivElement>;
	workbenchClassName?: string;
	workbenchStyle?: CSSProperties;
	beforeMessagesSlot?: ReactNode;
	emptySlot?: ReactNode;
	renderItem?: (item: ChatItem, index: number, items: ChatItem[]) => ReactNode;
	aboveComposerSlot?: ReactNode;
}

function fmtTok(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return (n / 1000).toFixed(1) + "k";
	if (n < 1_000_000) return Math.round(n / 1000) + "k";
	return (n / 1_000_000).toFixed(1) + "M";
}

const AUTO_FOLLOW_BOTTOM_THRESHOLD_PX = 96;
const JUMP_TO_LATEST_SHOW_MIN_PX = 300;
const JUMP_TO_LATEST_SHOW_VIEWPORT_RATIO = 0.35;
const JUMP_TO_LATEST_HIDE_MIN_PX = 120;
const JUMP_TO_LATEST_HIDE_VIEWPORT_RATIO = 0.15;

function bottomDistance(el: HTMLElement): number {
	return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function isNearBottom(el: HTMLElement, threshold = AUTO_FOLLOW_BOTTOM_THRESHOLD_PX): boolean {
	return bottomDistance(el) <= threshold;
}

function jumpToLatestShowThreshold(el: HTMLElement): number {
	return Math.max(JUMP_TO_LATEST_SHOW_MIN_PX, el.clientHeight * JUMP_TO_LATEST_SHOW_VIEWPORT_RATIO);
}

function jumpToLatestHideThreshold(el: HTMLElement): number {
	return Math.max(JUMP_TO_LATEST_HIDE_MIN_PX, el.clientHeight * JUMP_TO_LATEST_HIDE_VIEWPORT_RATIO);
}

function shouldShowJumpToLatest(el: HTMLElement, wasShowing: boolean, empty: boolean): boolean {
	if (empty || el.scrollHeight <= el.clientHeight) return false;
	const distance = bottomDistance(el);
	return distance > (wasShowing ? jumpToLatestHideThreshold(el) : jumpToLatestShowThreshold(el));
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
	if (!ref) return;
	if (typeof ref === "function") {
		ref(value);
		return;
	}
	(ref as MutableRefObject<T | null>).current = value;
}

function fmtCost(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.01) return "<$0.01";
	return "$" + n.toFixed(2);
}

function compactModelLabel(label: string): string {
	// currentModelLabel is already canonical for new sessions; historical
	// "Provider — Name" strings still pass through here.
	return modelDisplayName({ modelLabel: label }) || label;
}

function fmtContextTok(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtExact(n: number): string {
	return new Intl.NumberFormat("en-US").format(Math.round(n));
}

function ContextPill({
	status,
	usage,
	currentModelLabel,
	connected,
}: {
	status: ContextHealthStatus;
	usage: InRoomChatUsage;
	currentModelLabel?: string | null;
	connected: boolean;
}) {
	const [open, setOpen] = useState(false);
	const anchorRef = useRef<HTMLDivElement | null>(null);
	const popoverId = useId();
	const known = status.tokens != null && status.checkpointPercent != null;
	const zone = connected ? (status.zone ?? "unknown") : "offline";
	const label = !connected
		? "Offline"
		: known
			? `${Math.round(status.checkpointPercent!)}% of recommended checkpoint tokens`
			: "Measuring tokens";
	const title = connected
		? "Context and model details"
		: "Connection to the exxperts server was lost. Reconnecting.";

	useEscapeKey(() => setOpen(false), open);

	useEffect(() => {
		if (!open) return;
		function onPointerDown(event: MouseEvent) {
			const anchor = anchorRef.current;
			if (anchor && event.target instanceof Node && !anchor.contains(event.target)) {
				setOpen(false);
			}
		}
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, [open]);

	return (
		<div className="composer-context-anchor" ref={anchorRef}>
			<button
				type="button"
				className={`composer-context-pill ${zone}`}
				title={title}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-controls={open ? popoverId : undefined}
				onClick={() => setOpen((v) => !v)}
			>
				<span className="context-health-dot" aria-hidden="true" />
				<span className="composer-context-pill-label">{label}</span>
			</button>
			{open && (
				<div className="composer-context-popover" id={popoverId} role="dialog" aria-label="Context and model details">
					{currentModelLabel && (
						<div className="composer-context-popover-row" title={`current chat model: ${currentModelLabel}`}>
							<span>model</span>
							<strong>{compactModelLabel(currentModelLabel)}</strong>
						</div>
					)}
					{known && (
						<div className="composer-context-popover-row">
							<span>context</span>
							<strong>{fmtExact(status.tokens!)} tokens</strong>
						</div>
					)}
					{!known && (
						<div className="composer-context-popover-row">
							<span>context</span>
							<strong>appears after the next response</strong>
						</div>
					)}
					<div className="composer-context-popover-row">
						<span>recommended checkpoint</span>
						<strong>{fmtContextTok(status.checkpointTokens)}</strong>
					</div>
					{status.contextWindow && (
						<div className="composer-context-popover-row">
							<span>window</span>
							<strong>{fmtContextTok(status.contextWindow)}</strong>
						</div>
					)}
					<div className="composer-context-popover-row">
						<span>turns</span>
						<strong>{usage.turns}</strong>
					</div>
					<div className="composer-context-popover-row">
						<span>cost</span>
						<strong>{fmtCost(usage.cost)}</strong>
					</div>
					<div className="composer-context-popover-row">
						<span>connection</span>
						<strong>{connected ? "online" : "offline"}</strong>
					</div>
					<p className="composer-context-popover-note">
						{zone === "red"
							? "Recommended checkpoint reached. Consider checkpointing soon. No automatic action is taken."
							: zone === "yellow"
								? "Approaching the checkpoint threshold."
								: "The recommended checkpoint optimises for answer quality: models lose sharpness as context grows, so checkpoint into memory before that happens."}
					</p>
				</div>
			)}
		</div>
	);
}

interface TranscriptItemsProps {
	items: ChatItem[];
	empty: boolean;
	emptySlot?: ReactNode;
	renderItem?: (item: ChatItem, index: number, items: ChatItem[]) => ReactNode;
	onResolveApproval: (requestId: string, value: any, label: string) => void;
	onApprovalPreview?: (preview: ApprovalPreviewData) => void;
	showThinkingIndicator: boolean;
}

const TranscriptItems = memo(function TranscriptItems({
	items,
	empty,
	emptySlot,
	renderItem,
	onResolveApproval,
	onApprovalPreview,
	showThinkingIndicator,
}: TranscriptItemsProps) {
	return (
		<>
			{empty ? (
				emptySlot ?? null
			) : renderItem ? (
				items.map((it, idx) => renderItem(it, idx, items))
			) : (
				items.map((it) =>
					it.kind === "approval" ? (
						<Approval key={it.id} item={it} onResolve={onResolveApproval} onPreview={onApprovalPreview} />
					) : (
						<Message key={it.id} item={it} />
					),
				)
			)}
			{showThinkingIndicator && (
				<div className="thinking-row" role="status" aria-label="thinking">
					<span className="thinking-dot" aria-hidden="true" />
				</div>
			)}
		</>
	);
});

interface ComposerInputProps {
	onSend: (text: string) => boolean;
	onStop?: () => void;
	stopVisible?: boolean;
	stopDisabled?: boolean;
	stopLabel?: string;
	textareaRef?: Ref<HTMLTextAreaElement>;
	placeholder: string;
	sendUnavailable?: boolean;
	initialDraftValue?: string;
	draftResetKey?: string | number;
	statusSlot?: ReactNode;
	rightActions?: ReactNode;
}

function ComposerInput({
	onSend,
	onStop,
	stopVisible = false,
	stopDisabled = false,
	stopLabel = "Stop",
	textareaRef,
	placeholder,
	sendUnavailable = false,
	initialDraftValue,
	draftResetKey,
	statusSlot,
	rightActions,
}: ComposerInputProps) {
	const [draft, setDraft] = useState(() => initialDraftValue ?? "");
	const textareaNodeRef = useRef<HTMLTextAreaElement | null>(null);
	const sendDisabled = sendUnavailable || !draft.trim();

	const setTextareaNode = useCallback((node: HTMLTextAreaElement | null) => {
		textareaNodeRef.current = node;
		assignRef(textareaRef, node);
	}, [textareaRef]);

	useEffect(() => {
		setDraft(initialDraftValue ?? "");
	}, [draftResetKey]);

	useLayoutEffect(() => {
		const el = textareaNodeRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
	}, [draft]);

	const submitDraft = useCallback(() => {
		if (sendDisabled) return;
		const accepted = onSend(draft);
		if (accepted) {
			setDraft("");
		}
	}, [draft, onSend, sendDisabled]);

	function handleComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submitDraft();
		}
	}

	return (
		<div className="composer-box">
			<textarea
				ref={setTextareaNode}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={handleComposerKeyDown}
				placeholder={placeholder}
				rows={2}
				spellCheck={false}
			/>
			<div className="composer-box-bottom">
				<div className="composer-box-status">{statusSlot}</div>
				<div className="composer-box-controls">
					{rightActions && <div className="composer-actions">{rightActions}</div>}
					{stopVisible ? (
						<button className="send-btn stop-btn" onClick={onStop} disabled={stopDisabled} aria-label={stopLabel} title={stopLabel}><span aria-hidden="true">■</span></button>
					) : (
						<button className="send-btn" onClick={submitDraft} disabled={sendDisabled} aria-label="Send" title="Send">↑</button>
					)}
				</div>
			</div>
		</div>
	);
}

export function InRoomChatShellView({
	sidebar,
	withPreview = false,
	activeDisplay,
	ownerSecondary,
	busy,
	usage,
	contextHealth,
	currentModelLabel,
	topbarActions,
	composerRightActions,
	connected,
	items,
	empty,
	messagesRef,
	onSend,
	onStop,
	stopVisible,
	stopDisabled,
	stopLabel,
	textareaRef,
	composerPlaceholder,
	sendUnavailable,
	initialDraftValue,
	draftResetKey,
	onResolveApproval,
	onApprovalPreview,
	previewSlot,
	checkpointPreviewSlot,
	globalOverlaySlot,
	workbenchRef,
	workbenchClassName,
	workbenchStyle,
	beforeMessagesSlot,
	emptySlot,
	renderItem,
	aboveComposerSlot,
}: InRoomChatShellViewProps) {
	const messagesElRef = useRef<HTMLDivElement | null>(null);
	const autoFollowRef = useRef(true);
	const lastItemIdRef = useRef<string | null>(null);
	const lastScrollTopRef = useRef(0);
	const [showJumpToLatest, setShowJumpToLatest] = useState(false);
	const lastItem = items[items.length - 1];
	// Busy spans the whole turn (agent_start -> agent_end). Thinking phases
	// and gaps between tool calls used to read as dead air because the
	// indicator vanished once anything followed the user's message; hide it
	// only while assistant text is actually growing on screen.
	const visiblyStreaming = lastItem?.kind === "assistant" && lastItem.streaming === true && !!lastItem.text;
	const showThinkingIndicator = busy && items.length > 0 && !visiblyStreaming;
	const composerLayoutClass = [
		"composer-layout",
		composerRightActions ? "with-actions" : "",
	].filter(Boolean).join(" ");

	const setMessagesNode = useCallback((node: HTMLDivElement | null) => {
		messagesElRef.current = node;
		assignRef(messagesRef, node);
	}, [messagesRef]);

	const handleMessagesScroll = useCallback(() => {
		const el = messagesElRef.current;
		if (!el) return;
		const previousScrollTop = lastScrollTopRef.current;
		const currentScrollTop = el.scrollTop;
		const scrolledUp = currentScrollTop < previousScrollTop - 3;
		lastScrollTopRef.current = currentScrollTop;

		if (scrolledUp) {
			autoFollowRef.current = false;
			setShowJumpToLatest((wasShowing) => shouldShowJumpToLatest(el, wasShowing, empty));
			return;
		}

		if (isNearBottom(el)) {
			autoFollowRef.current = true;
			setShowJumpToLatest(false);
			return;
		}

		if (!autoFollowRef.current) {
			setShowJumpToLatest((wasShowing) => shouldShowJumpToLatest(el, wasShowing, empty));
		}
	}, [empty]);

	const jumpToLatest = useCallback(() => {
		const el = messagesElRef.current;
		if (!el) return;
		autoFollowRef.current = true;
		el.scrollTop = el.scrollHeight;
		lastScrollTopRef.current = el.scrollTop;
		setShowJumpToLatest(false);
	}, []);

	useLayoutEffect(() => {
		const el = messagesElRef.current;
		if (!el) return;

		const lastItemId = lastItem?.id ?? null;
		const lastItemChanged = lastItemIdRef.current !== lastItemId;
		lastItemIdRef.current = lastItemId;
		if (lastItemChanged && lastItem?.kind === "user") {
			autoFollowRef.current = true;
		}

		if (autoFollowRef.current) {
			el.scrollTop = el.scrollHeight;
			lastScrollTopRef.current = el.scrollTop;
			setShowJumpToLatest(false);
			return;
		}

		setShowJumpToLatest((wasShowing) => shouldShowJumpToLatest(el, wasShowing, empty));
	}, [empty, items, lastItem, showThinkingIndicator]);

	return (
		<div className="app">
			{sidebar}

			<div ref={workbenchRef} className={`workbench ${withPreview ? "with-preview" : ""} ${workbenchClassName ?? ""}`.trim()} style={workbenchStyle}>
				<main className="main">
					<div className="topbar">
						<div className="left">
							<span className="agent-label">talking to</span>
							<div className="title-stack">
								<span className="title">{activeDisplay || "…"}</span>
								{ownerSecondary && <span className="subtitle">{ownerSecondary}</span>}
							</div>
							{busy && <span className="spinner" />}
						</div>
						{topbarActions && <div className="topbar-actions">{topbarActions}</div>}
					</div>

					{beforeMessagesSlot}
					<div className="messages-frame">
						<div className="messages" ref={setMessagesNode} onScroll={handleMessagesScroll} data-has-unseen-latest={showJumpToLatest ? "true" : undefined}>
							<TranscriptItems
								items={items}
								empty={empty}
								emptySlot={emptySlot}
								renderItem={renderItem}
								onResolveApproval={onResolveApproval}
								onApprovalPreview={onApprovalPreview}
								showThinkingIndicator={showThinkingIndicator}
							/>
						</div>
						{showJumpToLatest && (
							<button type="button" className="jump-to-latest" onClick={jumpToLatest} aria-label="Jump to latest message">
								↓ Latest
							</button>
						)}
					</div>
					{aboveComposerSlot}

					<div className="composer">
						<div className={composerLayoutClass}>
							<ComposerInput
								onSend={onSend}
								onStop={onStop}
								stopVisible={stopVisible}
								stopDisabled={stopDisabled}
								stopLabel={stopLabel}
								textareaRef={textareaRef}
								placeholder={composerPlaceholder}
								sendUnavailable={sendUnavailable}
								initialDraftValue={initialDraftValue}
								draftResetKey={draftResetKey}
								statusSlot={contextHealth ? (
									<ContextPill
										status={contextHealth}
										usage={usage}
										currentModelLabel={currentModelLabel}
										connected={connected}
									/>
								) : (
									<div className="composer-status" aria-label="Chat status">
										{currentModelLabel && <span title={`current chat model: ${currentModelLabel}`}>model <strong>{compactModelLabel(currentModelLabel)}</strong></span>}
										<span><strong>{usage.turns}</strong> turn{usage.turns === 1 ? "" : "s"}</span>
										<span>↑ <strong>{fmtTok(usage.input)}</strong></span>
										<span>↓ <strong>{fmtTok(usage.output)}</strong></span>
										{usage.cacheRead > 0 && <span>cache <strong>{fmtTok(usage.cacheRead)}</strong></span>}
										<span><strong>{fmtCost(usage.cost)}</strong></span>
										{usage.totalTokens > 0 && <span title="last assistant context">ctx <strong>{fmtTok(usage.totalTokens)}</strong></span>}
										<span className={`composer-connection ${connected ? "live" : ""}`}>{connected ? "online" : "offline"}</span>
									</div>
								)}
								rightActions={composerRightActions}
							/>
						</div>
					</div>
				</main>
				{previewSlot}
				{checkpointPreviewSlot}
			</div>
			{globalOverlaySlot}
		</div>
	);
}
