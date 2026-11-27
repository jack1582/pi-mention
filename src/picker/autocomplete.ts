/**
 * omp ≥ 19 adapter. omp removed `setEditorComponent`; the supported way to extend `@` is to
 * stack an autocomplete provider on top of the built-in one (which already completes files and
 * directory by directory). We keep that and add, in the same popup:
 *
 *   @              live peers ("●") first, then files
 *   @ses…          `session:` entry, matching sessions
 *   @session:      project sessions, then all sessions (fuzzy filter by what you type)
 *   @session:ab12cd34#   turns of that session
 *   @<scheme>:     options of a registered provider (see api.ts)
 */
import { getProvider, listProviders } from "../providers.js";
import { listAllSessions, listProjectSessions, parseSession, type SessionRef, sessionTitle } from "../sessions.js";
import { MENTION_BLOCKER_RE } from "../mentions.js";
import { ageLabel, oneLine, tildify } from "../util.js";
import type { PickerDeps } from "./deps.js";
import { fuzzyRank } from "./fuzzy.js";

interface AcItem {
	value: string;
	label: string;
	description?: string;
	iconName?: string;
	nativeDetail?: string;
}

interface AcResult {
	items: AcItem[];
	prefix: string;
}

interface AcApplied {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

/** omp's built-in provider, as far as we use it. */
interface AcBase {
	getSuggestions(lines: string[], line: number, col: number, opts: unknown, signal: AbortSignal | null): Promise<AcResult | null> | AcResult | null;
	applyCompletion(lines: string[], line: number, col: number, item: AcItem, prefix: string): AcApplied;
}

/** The slice of omp's `ctx.ui` this adapter needs. */
export interface AutocompleteHost {
	addAutocompleteProvider(factory: (base: AcBase) => AcBase): void;
}

const MAX_EXTRA = 30;
/** The `@` token that ends at the cursor; not glued to a preceding word (e-mail addresses stay literal). */
const TOKEN_AT_CURSOR = /(?<![A-Za-z0-9_.+\-@/\\])@([^\s@]*)$/u;

function quoteRef(ref: string): string {
	return /\s|"/.test(ref) ? `"${ref.replace(/"/g, "")}"` : ref;
}

export function installAutocomplete(host: AutocompleteHost, deps: PickerDeps): void {
	const peerItems = (q: string): AcItem[] =>
		fuzzyRank(deps.peers(), q, (p) => `${p.short} ${p.title ?? ""} ${p.cwd}`).map((p) => ({
			value: `@session:${p.short}`,
			label: `● ${p.title ? oneLine(p.title, 50) : p.short}`,
			description: `live ${p.status} · ${p.host} · ${tildify(p.cwd)}`,
			iconName: "file",
		}));

	const sessionItem = (s: SessionRef, live: Set<string>): AcItem => ({
		value: `@session:${s.short}`,
		label: `${live.has(s.short) ? "● " : "◆ "}${sessionTitle(s)}`,
		description: `${s.short} · ${ageLabel(s.modified)} · ${s.messageCount} msgs · ${tildify(s.cwd)} · # for turns`,
		iconName: "file",
	});

	async function sessionItems(query: string, limit: number): Promise<AcItem[]> {
		const self = deps.selfShort();
		const live = new Set(deps.peers().map((p) => p.short));
		const project = await listProjectSessions(deps.cwd());
		const all = await listAllSessions();
		const merged = [...project, ...all.filter((s) => !project.some((p) => p.short === s.short))]
			.filter((s) => s.short !== self && (s.messageCount > 0 || live.has(s.short)))
			.sort(
				(a, b) =>
					Number(live.has(b.short)) - Number(live.has(a.short)) ||
					Number(b.cwd === deps.cwd()) - Number(a.cwd === deps.cwd()) ||
					b.modified.getTime() - a.modified.getTime(),
			);
		return fuzzyRank(merged, query, (s) => `${s.short} ${s.title} ${s.firstMessage} ${s.cwd}`)
			.slice(0, limit)
			.map((s) => sessionItem(s, live));
	}

	async function turnItems(short: string, query: string): Promise<AcItem[]> {
		const info = (await listAllSessions()).find((s) => s.short === short);
		if (!info) return [];
		const turns = parseSession(info.path).turns.slice().reverse();
		return fuzzyRank(turns, query, (t) => `${t.index} ${t.user}`)
			.slice(0, MAX_EXTRA)
			.map((t) => ({
				value: `@session:${short}#${t.index}`,
				label: `#${t.index} ${oneLine(t.user, 80) || "(no text)"}`,
				description: t.toolCalls ? `${t.toolCalls} tools` : undefined,
				iconName: "file",
			}));
	}

	async function providerItems(id: string, query: string): Promise<AcItem[]> {
		const provider = getProvider(id);
		if (!provider?.list) return [];
		const options = await provider.list(query, { cwd: deps.cwd() });
		return fuzzyRank(options, query, (o) => `${o.label} ${o.value}`)
			.slice(0, MAX_EXTRA)
			.map((o) => ({ value: `@${id}:${quoteRef(o.value)}`, label: o.label, description: o.detail, iconName: "file" }));
	}

	/** `session:` and each provider scheme, offered while the user is still typing the scheme. */
	function schemeItems(q: string): AcItem[] {
		if (!q || q.includes(":") || q.includes("/")) return [];
		const schemes = [{ id: "session", hint: "browse sessions" }, ...listProviders().filter((p) => p.list).map((p) => ({ id: p.id, hint: p.label }))];
		return schemes
			.filter((s) => s.id.startsWith(q.toLowerCase()))
			.map((s) => ({ value: `@${s.id}:`, label: `${s.id}:`, description: s.hint, iconName: "folder" }));
	}

	async function ours(q: string): Promise<AcItem[] | undefined> {
		const turn = /^session:([0-9a-fA-F]{8})#(.*)$/.exec(q);
		if (turn) return turnItems(turn[1]!.toLowerCase(), turn[2]!);
		if (q.startsWith("session:")) return sessionItems(q.slice("session:".length), MAX_EXTRA);
		const scheme = /^([a-z][a-z0-9-]*):(.*)$/.exec(q);
		if (scheme && getProvider(scheme[1]!)) return providerItems(scheme[1]!, scheme[2]!.replace(/^"/, ""));
		return undefined; // generic query: the built-in file completion leads
	}

	host.addAutocompleteProvider((base) => {
		const getSuggestions: AcBase["getSuggestions"] = async (lines, line, col, opts, signal) => {
			const before = (lines[line] ?? "").slice(0, col);
			const m = TOKEN_AT_CURSOR.exec(before);
			if (!m || (before.length > m[0].length && MENTION_BLOCKER_RE.test(before.slice(0, before.length - m[0].length)))) {
				return base.getSuggestions(lines, line, col, opts, signal);
			}
			const q = m[1]!;
			const prefix = `@${q}`;
			try {
				const only = await ours(q);
				if (only) return only.length ? { items: only, prefix } : null;
				const files = await base.getSuggestions(lines, line, col, opts, signal);
				const sessions = q.length >= 2 ? await sessionItems(q, 3) : [];
				const items = [...peerItems(q), ...(files?.items ?? []), ...sessions, ...schemeItems(q)];
				return items.length ? { items, prefix: files?.prefix ?? prefix } : null;
			} catch {
				return base.getSuggestions(lines, line, col, opts, signal);
			}
		};

		const applyCompletion: AcBase["applyCompletion"] = (lines, line, col, item, prefix) => {
			const ours = /^@(session|[a-z][a-z0-9-]*):/.test(item.value) && !item.value.startsWith("@/");
			if (!ours) return base.applyCompletion(lines, line, col, item, prefix);
			const text = lines[line] ?? "";
			const head = text.slice(0, col - prefix.length);
			const tail = text.slice(col);
			const partial = item.value.endsWith(":"); // a scheme: keep typing
			const glue = partial || /^\s/.test(tail) ? "" : " ";
			const next = lines.slice();
			next[line] = `${head}${item.value}${glue}${tail}`;
			return { lines: next, cursorLine: line, cursorCol: head.length + item.value.length + glue.length };
		};

		return new Proxy(base, {
			get(target, prop) {
				if (prop === "getSuggestions") return getSuggestions;
				if (prop === "applyCompletion") return applyCompletion;
				const value: unknown = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	});
}
