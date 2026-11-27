/**
 * Host-neutral session access. pi and omp both expose `SessionManager.list/listAll`
 * but disagree on the shape of `SessionInfo` (pi: `name`, `modified: Date`;
 * omp: `title`, `modified: ISO string`), so everything is normalised to `SessionRef`.
 * Transcripts are parsed straight from the JSONL file: opening another session
 * through `SessionManager.open` would touch ownership leases of live sessions.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { oneLine, shortId } from "./util.js";

export interface SessionRef {
	id: string;
	short: string;
	path: string;
	cwd: string;
	title: string;
	firstMessage: string;
	modified: Date;
	messageCount: number;
}

/** The fields of pi's and omp's `SessionInfo` that we read (both are structurally assignable). */
interface RawInfo {
	id: string;
	path?: string;
	cwd?: string;
	name?: string;
	title?: string;
	firstMessage?: string;
	modified?: Date | string | number;
	messageCount?: number;
}

function normalize(info: RawInfo): SessionRef {
	const modified = info.modified instanceof Date ? info.modified : new Date(info.modified ?? 0);
	return {
		id: String(info.id),
		short: shortId(String(info.id)),
		path: info.path ?? "",
		cwd: info.cwd ?? "",
		title: info.name ?? info.title ?? "",
		firstMessage: info.firstMessage ?? "",
		modified: Number.isNaN(modified.getTime()) ? new Date(0) : modified,
		messageCount: info.messageCount ?? 0,
	};
}

export function sessionTitle(info: Pick<SessionRef, "title" | "firstMessage">): string {
	return oneLine(info.title || info.firstMessage || "(empty session)", 70);
}

// Listing is expensive on big histories: keep results briefly.
const LIST_TTL_MS = 10_000;
let allCache: { at: number; list: SessionRef[] } | undefined;
const byShort = new Map<string, SessionRef>();

function remember(list: SessionRef[]): SessionRef[] {
	for (const s of list) byShort.set(s.short, s);
	return list;
}

export async function listAllSessions(): Promise<SessionRef[]> {
	if (allCache && Date.now() - allCache.at < LIST_TTL_MS) return allCache.list;
	const list = remember((await SessionManager.listAll()).map(normalize));
	allCache = { at: Date.now(), list };
	return list;
}

export async function listProjectSessions(cwd: string): Promise<SessionRef[]> {
	try {
		return remember((await SessionManager.list(cwd)).map(normalize));
	} catch {
		// the host's `list` signature differs: fall back to the global listing
		return (await listAllSessions()).filter((s) => s.cwd === cwd);
	}
}

export async function resolveSession(ref: string): Promise<SessionRef | undefined> {
	const key = ref.trim().replace(/^@?session:/, "").split("#")[0]!;
	const match = (s: SessionRef) =>
		s.path === key || s.id === key || s.short === shortId(key) || path.basename(s.path) === key;
	for (const s of byShort.values()) if (match(s)) return s;
	return (await listAllSessions()).find(match);
}

// ─────────────────────────── transcript parsing ───────────────────────────

export interface Turn {
	index: number; // 1-based
	user: string;
	parts: string[]; // rendered lines of the turn (user + assistant + tools)
	toolCalls: number;
}

export interface ParsedSession {
	turns: Turn[];
	compactions: string[];
}

interface Block {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
}

interface Message {
	role?: string;
	content?: unknown;
	toolName?: string;
	customType?: string;
	display?: boolean;
}

/** One JSONL line of a session file. */
interface Entry {
	type?: string;
	id?: string;
	parentId?: string | null;
	summary?: string;
	customType?: string;
	content?: unknown;
	display?: boolean;
	message?: Message;
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Block[])
		.map((b) => {
			if (b?.type === "text") return b.text ?? "";
			return b?.type === "image" ? "[image]" : "";
		})
		.filter(Boolean)
		.join("\n");
}

function readEntries(file: string): Entry[] {
	const entries: Entry[] = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line) as Entry);
		} catch {
			// a torn last line of a live session: ignore
		}
	}
	return entries;
}

/** The active branch (leaf → root) of a tree-shaped session; file order when it is not a tree. */
function activeBranch(entries: Entry[]): Entry[] {
	const byId = new Map<string, Entry>();
	for (const e of entries) if (typeof e?.id === "string") byId.set(e.id, e);
	const leaf = [...entries].reverse().find((e) => typeof e?.id === "string");
	if (!leaf) return entries;
	const chain: Entry[] = [];
	const seen = new Set<string>();
	for (let cur: Entry | undefined = leaf; cur?.id && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
		seen.add(cur.id);
		chain.push(cur);
	}
	return chain.length ? chain.reverse() : entries;
}

export function parseSession(file: string): ParsedSession {
	const turns: Turn[] = [];
	const compactions: string[] = [];
	let cur: Turn | undefined;
	for (const e of activeBranch(readEntries(file))) {
		if (e.type === "compaction" && typeof e.summary === "string") {
			compactions.push(e.summary);
			cur?.parts.push(`[compaction summary]\n${e.summary}`);
			continue;
		}
		if (e.type === "custom_message" && e.display !== false) {
			const t = textOf(e.content);
			if (t.trim() && cur) cur.parts.push(`### ${e.customType ?? "custom"}\n${oneLine(t, 600)}`);
			continue;
		}
		if (e.type !== "message" || !e.message) continue;
		const m = e.message;
		if (m.role === "user") {
			const text = textOf(m.content);
			cur = { index: turns.length + 1, user: text, parts: [`## Turn ${turns.length + 1}\n### user\n${text}`], toolCalls: 0 };
			turns.push(cur);
			continue;
		}
		if (!cur) continue;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content as Block[]) {
				if (b?.type === "text" && b.text?.trim()) cur.parts.push(`### assistant\n${b.text}`);
				else if (b?.type === "toolCall") {
					cur.toolCalls++;
					const args = JSON.stringify(b.arguments ?? {});
					cur.parts.push(`### tool call: ${b.name}\n${args.length > 400 ? `${args.slice(0, 400)}…` : args}`);
				}
			}
		} else if (m.role === "toolResult") {
			const t = textOf(m.content);
			cur.parts.push(`### tool result (${m.toolName ?? "?"})\n${t.length > 1500 ? `${t.slice(0, 1500)}… [+${t.length - 1500} chars]` : t}`);
		} else if (m.role === "custom" && m.display !== false) {
			const t = textOf(m.content);
			if (t.trim()) cur.parts.push(`### ${m.customType ?? "custom"}\n${oneLine(t, 600)}`);
		}
	}
	return { turns, compactions };
}

export function parseTurnRange(spec: string | undefined, total: number): [number, number] | undefined {
	if (!spec) return undefined;
	const m = spec.trim().match(/^(\d+)(?:\s*-\s*(\d+)?)?$/);
	if (!m) return undefined;
	const a = Math.max(1, Number(m[1]));
	let b = spec.includes("-") ? total : a;
	if (m[2]) b = Number(m[2]);
	return [a, Math.min(total, Math.max(a, b))];
}
