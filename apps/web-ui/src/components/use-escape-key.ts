import { useEffect, useRef } from "react";

/** Close a transient surface (dialog, overlay) when Escape is pressed. */
export function useEscapeKey(onEscape: () => void, enabled = true): void {
	const handlerRef = useRef(onEscape);
	handlerRef.current = onEscape;
	useEffect(() => {
		if (!enabled) return;
		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") handlerRef.current();
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [enabled]);
}
