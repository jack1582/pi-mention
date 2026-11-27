/**
 * Terminal-width helpers with no TUI dependency, so the same row renderers work
 * under pi (pi-tui) and omp (its own TUI) without importing either.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y;

function cellWidth(cp: number): number {
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
	if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f || cp === 0x20e3) return 0;
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	)
		return 2;
	return 1;
}

export function visibleWidth(s: string): number {
	let w = 0;
	for (let i = 0; i < s.length; ) {
		ANSI_RE.lastIndex = i;
		const m = ANSI_RE.exec(s);
		if (m) {
			i += m[0].length;
			continue;
		}
		const cp = s.codePointAt(i)!;
		w += cellWidth(cp);
		i += cp > 0xffff ? 2 : 1;
	}
	return w;
}

/** Cut `s` to `width` cells, keeping ANSI styling intact and closing it with a reset. */
export function truncate(s: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(s) <= width) return s;
	const limit = width - 1; // room for the ellipsis
	let out = "";
	let w = 0;
	for (let i = 0; i < s.length; ) {
		ANSI_RE.lastIndex = i;
		const m = ANSI_RE.exec(s);
		if (m) {
			out += m[0];
			i += m[0].length;
			continue;
		}
		const cp = s.codePointAt(i)!;
		const cw = cellWidth(cp);
		if (w + cw > limit) break;
		const ch = String.fromCodePoint(cp);
		out += ch;
		w += cw;
		i += ch.length;
	}
	return `${out}…\x1b[0m`;
}

/** A `{ render }` rows object: understood by pi-tui as a Component and by omp as a rows node. */
export function rows(lines: string[] | ((width: number) => string[])): {
	render(width: number): string[];
	invalidate(): void;
} {
	return {
		render: (width) => (typeof lines === "function" ? lines(width) : lines).map((l) => truncate(l, width)),
		invalidate() {},
	};
}
