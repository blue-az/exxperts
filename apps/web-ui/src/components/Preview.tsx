import { useMemo } from "react";
import type { ApprovalPreviewType } from "../approval-preview";
import { MarkdownRenderer } from "./Markdown";

interface Props {
	content: string;
	title: string;
	type: ApprovalPreviewType;
	onClose: () => void;
}

export function Preview({ content, title, type, onClose }: Props) {
	const iframeKey = useMemo(() => `${title}:${content.length}:${content.slice(0, 128)}`, [content, title]);

	return (
		<aside className="preview-pane" aria-label="Approval preview">
			<header className="preview-head">
				<div>
					<div className="preview-kicker">approval preview</div>
					<div className="preview-title" title={title}>{title}</div>
				</div>
				<button className="preview-close" onClick={onClose} aria-label="Close preview">×</button>
			</header>
			<div className={type === "html" ? "preview-body preview-body-html" : "preview-body"}>
				{type === "html" ? (
					<iframe
						key={iframeKey}
						className="preview-iframe"
						sandbox=""
						srcDoc={content}
						title={title}
						loading="eager"
						referrerPolicy="no-referrer"
					/>
				) : (
					<div className="md preview-markdown">
						<MarkdownRenderer>{content}</MarkdownRenderer>
					</div>
				)}
			</div>
		</aside>
	);
}
