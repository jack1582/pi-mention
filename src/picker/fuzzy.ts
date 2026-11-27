/** Subsequence fuzzy score (higher is better, -1 = no match); favours consecutive runs and word starts. */
function score(query: string, text: string): number {
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	let ti = 0;
	let total = 0;
	let run = 0;
	for (const ch of q) {
		const at = t.indexOf(ch, ti);
		if (at < 0) return -1;
		run = at === ti ? run + 1 : 0;
		const wordStart = at === 0 || /[\s/_.:#-]/.test(t[at - 1]!);
		total += 1 + run * 2 + (wordStart ? 3 : 0) - Math.min(at - ti, 5) * 0.2;
		ti = at + 1;
	}
	return total - t.length * 0.01;
}

/** Items matching `query` best-first; everything (original order) for an empty query. */
export function fuzzyRank<T>(items: T[], query: string, text: (item: T) => string): T[] {
	const q = query.trim();
	if (!q) return items;
	return items
		.map((item, i) => ({ item, i, s: score(q, text(item)) }))
		.filter((x) => x.s >= 0)
		.sort((a, b) => b.s - a.s || a.i - b.i)
		.map((x) => x.item);
}
