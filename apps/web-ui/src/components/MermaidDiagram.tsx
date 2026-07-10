import { useCallback, useEffect, useId, useMemo, useState } from "react";

const MAX_MERMAID_CHARS = 12_000;
const VIEWER_DEFAULT_ZOOM = 1.25;
const VIEWER_MIN_ZOOM = 0.75;
const VIEWER_MAX_ZOOM = 3;
const VIEWER_ZOOM_STEP = 0.25;

type MermaidStatus =
	| { state: "loading" }
	| { state: "ready"; svg: string; renderedSource: string; repaired: boolean }
	| { state: "error"; message: string; detail?: string };

// mermaid is heavy; load it lazily on first use so it lands in its own chunk
// and never touches the main bundle. Memoized at module scope so a chat with
// many diagrams shares one initialized instance.
let mermaidLoad: Promise<typeof import("mermaid").default> | null = null;
let renderSeq = 0;

function loadMermaid() {
	if (!mermaidLoad) {
		mermaidLoad = import("mermaid").then((mod) => {
			const mermaid = mod.default;
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				theme: "base",
				deterministicIds: true,
				maxTextSize: MAX_MERMAID_CHARS,
				fontFamily: "Sen, Arial, Helvetica, sans-serif",
				themeVariables: {
					background: "transparent",
					primaryColor: "#ffffff",
					primaryTextColor: "#111111",
					primaryBorderColor: "#111111",
					lineColor: "#111111",
					secondaryColor: "#f4f4f2",
					tertiaryColor: "#fbfbfa",
					textColor: "#111111",
					fontFamily: "Sen, Arial, Helvetica, sans-serif",
				},
			});
			return mermaid;
		});
	}
	return mermaidLoad;
}

async function renderMermaidSvg(renderIdPrefix: string, source: string): Promise<string> {
	const mermaid = await loadMermaid();
	const renderId = `${renderIdPrefix}-${++renderSeq}`;
	const { svg } = await mermaid.render(renderId, source);
	return svg;
}

// Models often emit flowchart labels with raw <br/> or double quotes that
// mermaid rejects unless the label is quoted. Wrap such labels in quotes and
// normalize the markup so a well-intentioned-but-malformed diagram still renders.
function repairFlowchartLabels(source: string): string {
	if (!/^\s*(flowchart|graph)\s+/m.test(source)) return source;
	return source.replace(/(^|\s)([A-Za-z][\w-]*)\[([^\]\n]*(?:<br\s*\/?>|"|'|&quot;)[^\]\n]*)\]/g, (match, prefix: string, id: string, label: string) => {
		const trimmed = label.trim();
		if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return match;
		const normalized = trimmed
			.replace(/<br\s*\/?>/gi, "<br/>")
			.replace(/&quot;/g, "'")
			.replace(/"/g, "'");
		return `${prefix}${id}["${normalized}"]`;
	});
}

async function renderMermaidWithRepair(renderIdPrefix: string, source: string): Promise<{ svg: string; renderedSource: string; repaired: boolean }> {
	try {
		return { svg: await renderMermaidSvg(renderIdPrefix, source), renderedSource: source, repaired: false };
	} catch (error) {
		const repairedSource = repairFlowchartLabels(source);
		if (repairedSource === source) throw error;
		try {
			return { svg: await renderMermaidSvg(`${renderIdPrefix}-repaired`, repairedSource), renderedSource: repairedSource, repaired: true };
		} catch {
			throw error;
		}
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message.trim();
	if (typeof error === "string" && error.trim()) return error.trim();
	return "Could not render this Mermaid diagram.";
}

function clampZoom(value: number): number {
	return Math.min(VIEWER_MAX_ZOOM, Math.max(VIEWER_MIN_ZOOM, value));
}

export function MermaidDiagram({ chart }: { chart: string }) {
	const reactId = useId();
	const source = useMemo(() => chart.trim(), [chart]);
	const baseId = useMemo(() => `mermaid-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`, [reactId]);
	const [status, setStatus] = useState<MermaidStatus>({ state: "loading" });
	const [viewerOpen, setViewerOpen] = useState(false);
	const [viewerZoom, setViewerZoom] = useState(VIEWER_DEFAULT_ZOOM);
	const [viewerStatus, setViewerStatus] = useState<MermaidStatus>({ state: "loading" });

	useEffect(() => {
		let cancelled = false;
		async function render() {
			if (!source) {
				setStatus({ state: "error", message: "Mermaid diagram is empty." });
				return;
			}
			if (source.length > MAX_MERMAID_CHARS) {
				setStatus({ state: "error", message: `Mermaid diagram is too large (${source.length} chars).` });
				return;
			}
			setStatus({ state: "loading" });
			try {
				const result = await renderMermaidWithRepair(baseId, source);
				if (!cancelled) setStatus({ state: "ready", ...result });
			} catch (error) {
				if (!cancelled) setStatus({ state: "error", message: "The assistant generated invalid Mermaid syntax.", detail: errorMessage(error) });
			}
		}
		void render();
		return () => {
			cancelled = true;
		};
	}, [baseId, source]);

	useEffect(() => {
		if (!viewerOpen || status.state !== "ready") return;
		let cancelled = false;
		const renderedSource = status.renderedSource;
		const repaired = status.repaired;
		setViewerStatus({ state: "loading" });
		async function renderViewer() {
			try {
				const svg = await renderMermaidSvg(`${baseId}-viewer`, renderedSource);
				if (!cancelled) setViewerStatus({ state: "ready", svg, renderedSource, repaired });
			} catch (error) {
				if (!cancelled) setViewerStatus({ state: "error", message: "Could not render the expanded diagram.", detail: errorMessage(error) });
			}
		}
		void renderViewer();
		return () => {
			cancelled = true;
		};
	}, [baseId, source, status.state, viewerOpen]);

	useEffect(() => {
		if (!viewerOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setViewerOpen(false);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [viewerOpen]);

	const openViewer = useCallback(() => {
		setViewerZoom(VIEWER_DEFAULT_ZOOM);
		setViewerStatus({ state: "loading" });
		setViewerOpen(true);
	}, []);

	const zoomOut = useCallback(() => {
		setViewerZoom((value) => clampZoom(value - VIEWER_ZOOM_STEP));
	}, []);

	const zoomIn = useCallback(() => {
		setViewerZoom((value) => clampZoom(value + VIEWER_ZOOM_STEP));
	}, []);

	if (status.state === "ready") {
		const zoomPercent = Math.round(viewerZoom * 100);
		return (
			<figure className="mermaid-diagram" aria-label="Rendered Mermaid diagram">
				<button
					type="button"
					className="mermaid-diagram-canvas mermaid-diagram-canvas-button"
					onClick={openViewer}
					aria-label="Open expanded diagram"
					title="Open expanded diagram"
				>
					<span className="mermaid-diagram-open-indicator" aria-hidden="true">⤢</span>
					<span className="mermaid-diagram-svg" dangerouslySetInnerHTML={{ __html: status.svg }} />
				</button>
				{status.repaired && <div className="mermaid-diagram-repaired">Mermaid syntax was auto-corrected for display.</div>}
				<details className="mermaid-diagram-source">
					<summary>Mermaid source</summary>
					<pre><code>{status.renderedSource}</code></pre>
				</details>
				{viewerOpen && (
					<div className="mermaid-viewer-overlay" role="dialog" aria-modal="true" aria-label="Expanded Mermaid diagram" onClick={() => setViewerOpen(false)}>
						<div className="mermaid-viewer-modal" onClick={(event) => event.stopPropagation()}>
							<div className="mermaid-viewer-head">
								<h2>Diagram</h2>
								<div className="mermaid-viewer-actions">
									<button className="icon-btn" type="button" onClick={zoomOut} disabled={viewerZoom <= VIEWER_MIN_ZOOM} aria-label="Zoom out" title="Zoom out">−</button>
									<button className="icon-btn mermaid-viewer-zoom-value" type="button" onClick={() => setViewerZoom(1)} aria-label="Reset zoom" title="Reset zoom">{zoomPercent}%</button>
									<button className="icon-btn" type="button" onClick={zoomIn} disabled={viewerZoom >= VIEWER_MAX_ZOOM} aria-label="Zoom in" title="Zoom in">+</button>
									<button className="icon-btn" type="button" onClick={() => setViewerOpen(false)} aria-label="Close">✕</button>
								</div>
							</div>
							<div className="mermaid-viewer-body">
								<div className="mermaid-viewer-stage" style={{ width: `${zoomPercent}%` }}>
									{viewerStatus.state === "ready" && <div className="mermaid-viewer-svg" dangerouslySetInnerHTML={{ __html: viewerStatus.svg }} />}
									{viewerStatus.state === "loading" && <div className="mermaid-viewer-loading">Rendering expanded diagram...</div>}
									{viewerStatus.state === "error" && (
										<div className="mermaid-viewer-error">
											<div className="mermaid-diagram-error-title">Could not render expanded diagram</div>
											<p>{viewerStatus.message}</p>
										</div>
									)}
								</div>
							</div>
						</div>
					</div>
				)}
			</figure>
		);
	}

	if (status.state === "error") {
		// Render failure degrades to the plain code block the fence would have
		// produced anyway — never a broken or blank box. The source stays
		// visible and conversationally editable.
		return (
			<pre className="mermaid-fallback">
				<code className="language-mermaid">{source}</code>
			</pre>
		);
	}

	return (
		<figure className="mermaid-diagram mermaid-diagram-loading" aria-label="Rendering Mermaid diagram">
			<div className="mermaid-diagram-loading-text">Rendering diagram...</div>
		</figure>
	);
}
