/**
 * Mention tokens → metadata. Nothing here knows about the host UI.
 *
 * Tokens: `@path/to/file`, `@"path with spaces"`, `@session:<id8>`,
 * `@session:<id8>#<turn>`, and `@<scheme>:<ref>` / `@<scheme>:"<ref>"` for
 * registered providers (see api.ts).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProvider } from "./providers.js";
import { type ParsedSession, parseSession, resolveSession, sessionTitle } from "./sessions.js";
import { fileToken, formatSize, oneLine, SKIP_DIRS, tildify } from "./util.js";

/** Chars that may not end a mention (CJK / full-width punctuation). */
const CJK_PUNCT = "，。、；：！？（）【】《》「」『』“”‘’…—～";

/** A `@` glued to one of these (e.g. `me@host`, `a.b@c`) is not a mention. */
export const MENTION_BLOCKER_RE = /[A-Za-z0-9_.+\-@/\\]$/;

// `@` must not follow an ASCII word char, so mentions work mid-prompt and right
// after CJK text ("看看@src/a.ts") while e-mail addresses stay ignored.
const TOKEN_RE = new RegExp(
	`(?<![A-Za-z0-9_.+\\-@/\\\\])@(?<key>session:(?<sid>[0-9a-fA-F]{8})(?:#(?<turn>\\d+))?|(?<scheme>[a-z][a-z0-9-]*):"(?<qref>[^"]+)"|"(?<quoted>[^"]+)"|(?<bare>[^\\s@"${CJK_PUNCT}]+))`,
	"gu",
);

export interface LivePeerView {
	short: string;
	title?: string;
	cwd: string;
	host: string;
	pid: number;
	status: "idle" | "busy";
}

export interface MentionEnv {
	cwd: string;
	/** Short id of the session the prompt is typed into. */
	selfShort?: string;
	/** Live swarm peer for a short id, if that session is running right now. */
	peer?: (short: string) => LivePeerView | undefined;
}

export interface Mention {
	token: string;
	kind: "file" | "session" | "provider";
	meta: string;
	/** Set for a mention of a live peer session. */
	live?: boolean;
}

function describeFile(rel: string, cwd: string): Mention | undefined {
	const abs = path.resolve(cwd, rel.replace(/^~(?=\/|$)/, os.homedir()));
	let st: fs.Stats;
	try {
		st = fs.statSync(abs);
	} catch {
		return undefined; // not a path → probably an email / handle, ignore
	}
	const token = fileToken(rel);
	if (st.isDirectory()) {
		let names: string[] = [];
		try {
			names = fs.readdirSync(abs).filter((n) => !SKIP_DIRS.has(n));
		} catch {}
		const preview = names.slice(0, 12).join(", ") + (names.length > 12 ? ", …" : "");
		return { token, kind: "file", meta: `directory ${abs} — ${names.length} entries: ${preview}` };
	}
	let info = `file ${abs} — ${formatSize(st.size)}`;
	if (st.size <= 2 * 1024 * 1024) {
		try {
			const buf = fs.readFileSync(abs);
			if (buf.includes(0)) info += ", binary";
			else {
				const lines = buf.toString("utf8").split("\n");
				const first = lines.find((l) => l.trim()) ?? "";
				info += `, ${lines.length} lines; starts with: "${oneLine(first, 100)}"`;
			}
		} catch {}
	}
	return { token, kind: "file", meta: info };
}

function liveClause(short: string, peer: LivePeerView): string {
	return (
		`LIVE right now (${peer.host}, pid ${peer.pid}, ${peer.status}, ${tildify(peer.cwd)}). ` +
		`To talk to it call session_send({ to: "${short}", message }); to read its history use read_session.`
	);
}

async function describeSession(short: string, turn: number | undefined, env: MentionEnv): Promise<Mention> {
	const token = `@session:${short}${turn ? `#${turn}` : ""}`;
	const peer = short === env.selfShort ? undefined : env.peer?.(short);
	const live = peer ? ` ${liveClause(short, peer)}` : "";
	if (short === env.selfShort) {
		return { token, kind: "session", meta: "this very session (the one you are running in)" };
	}
	const info = await resolveSession(short);
	if (!info) {
		return { token, kind: "session", live: Boolean(peer), meta: `session (not found on disk).${live}` };
	}
	let parsed: ParsedSession = { turns: [], compactions: [] };
	try {
		parsed = parseSession(info.path);
	} catch {}
	const head = `session "${sessionTitle(info)}" (project ${tildify(info.cwd)}, ${parsed.turns.length} turns, last active ${info.modified.toISOString()}, file ${info.path})`;
	if (turn) {
		const t = parsed.turns[turn - 1];
		const what = t ? `turn #${turn}; the user asked: "${oneLine(t.user, 160)}"` : `turn #${turn} (out of range)`;
		return {
			token,
			kind: "session",
			live: Boolean(peer),
			meta: `${what} — in ${head}. Read it with read_session({ session: "${short}", turns: "${turn}" }).${live}`,
		};
	}
	const last = parsed.turns.at(-1);
	const lastNote = last ? ` Last request: "${oneLine(last.user, 120)}".` : "";
	return {
		token,
		kind: "session",
		live: Boolean(peer),
		meta: `whole ${head}.${lastNote} Get an outline with read_session({ session: "${short}" }), then read specific turns.${live}`,
	};
}

async function describeProvided(scheme: string, ref: string, token: string, env: MentionEnv): Promise<Mention | undefined> {
	const provider = getProvider(scheme);
	if (!provider) return undefined;
	try {
		const meta = await provider.describe(ref, { cwd: env.cwd });
		return meta ? { token, kind: "provider", meta: oneLine(meta, 600) } : undefined;
	} catch (err) {
		return { token, kind: "provider", meta: `${scheme} provider failed: ${err instanceof Error ? err.message : String(err)}` };
	}
}

export async function collectMentions(prompt: string, env: MentionEnv): Promise<Mention[]> {
	const seen = new Set<string>();
	const out: Mention[] = [];
	for (const m of prompt.matchAll(TOKEN_RE)) {
		const g = m.groups!;
		const key = g.key!;
		if (seen.has(key)) continue;
		seen.add(key);
		let mention: Mention | undefined;
		if (g.sid) {
			mention = await describeSession(g.sid.toLowerCase(), g.turn ? Number(g.turn) : undefined, env);
		} else if (g.scheme) {
			mention = await describeProvided(g.scheme, g.qref!, `@${key}`, env);
		} else {
			const raw = (g.quoted ?? g.bare ?? "").replace(/[.,;:!?)]+$/, "");
			const scheme = g.bare ? /^([a-z][a-z0-9-]*):(.+)$/.exec(raw) : null;
			mention =
				scheme && getProvider(scheme[1]!)
					? await describeProvided(scheme[1]!, scheme[2]!, `@${raw}`, env)
					: describeFile(raw, env.cwd);
		}
		if (mention) out.push(mention);
	}
	return out;
}

/** The first mention of the prompt when it is a live-peer session token at the very start ("@session:ab12cd34 do X"). */
export function leadingSessionToken(prompt: string): { short: string; rest: string } | undefined {
	const m = /^\s*@session:([0-9a-fA-F]{8})(?![#\w])[\s:,]*/.exec(prompt);
	return m ? { short: m[1]!.toLowerCase(), rest: prompt.slice(m[0].length) } : undefined;
}
