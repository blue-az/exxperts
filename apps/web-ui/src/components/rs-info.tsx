// Room settings info mark: hover shows the native tooltip, keyboard users reach
// the same text via focus + aria-label. Clicks are swallowed so a mark inside a
// <label> row never flips the row's switch.
export function RsInfo({ text }: { text: string }) {
	return (
		<span
			className="rs-info"
			title={text}
			aria-label={text}
			role="note"
			tabIndex={0}
			onClick={(e) => e.preventDefault()}
		>
			i
		</span>
	);
}
