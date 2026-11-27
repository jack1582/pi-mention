import * as os from "node:os";

export const CUSTOM_TYPE = "mention";
export const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store"]);

/** Last 8 hex chars of a session id: random in UUIDv4 and UUIDv7 alike. */
export function shortId(id: string): string {
	return id.replace(/-/g, "").slice(-8).toLowerCase();
}

export function ageLabel(d: Date): string {
	const min = Math.floor((Date.now() - d.getTime()) / 60_000);
	if (min < 1) return "just now";
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

export function oneLine(text: string, max = 80): string {
	const s = text.replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function tildify(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fileToken(rel: string): string {
	return /\s|"/.test(rel) ? `@"${rel.replace(/"/g, "")}"` : `@${rel}`;
}
