/**
 * pi-session-mention
 *
 * Replaces the editor's `@` behaviour with a layered picker:
 *
 *   Tab / Shift+Tab   cycle mention type: Files (cwd) → Project sessions → All sessions
 *   ↑ / ↓             move focus            PgUp / PgDn  page
 *   →                 open (directory / project / session → turns)
 *   ←                 go back one level
 *   ↩                 insert the focused item as a token
 *   Esc               close the picker (keeps a literal `@`)
 *   any other text    filters the current level (fuzzy; files search recursively)
 *
 * Tokens inserted into the prompt:
 *   @path/to/file  @"path with spaces"  @session:<id8>  @session:<id8>#<turn>
 *
 * Multiple tokens per prompt are supported. On submit, only *metadata* about
 * every mentioned item is attached (path, size, short preview / session title,
 * turn count …). The agent is told to read the real content itself – files via
 * the built-in tools, sessions via the `read_session` tool registered here –
 * so long files or transcripts never flood the context.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, KeybindingsManager, SessionInfo, Theme } from "@earendil-works/pi-coding-agent";
import { CustomEditor, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { decodeKittyPrintable, fuzzyFilter, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";

const CUSTOM_TYPE = "session-mention";
const MAX_VISIBLE = 8;
const FILE_SCAN_LIMIT = 5000;
const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store"]);

// ───────────────────────────── helpers ─────────────────────────────

function shortId(id: string): string {
	return id.replace(/-/g, "").slice(-8).toLowerCase();
}

function ageLabel(d: Date): string {
	const min = Math.floor((Date.now() - d.getTime()) / 60_000);
	if (min < 1) return "just now";
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

function oneLine(text: string, max = 80): string {
	const s = text.replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function tildify(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fileToken(rel: string): string {
	return /\s|"/.test(rel) ? `@"${rel.replace(/"/g, "")}"` : `@${rel}`;
}

function sessionTitle(info: SessionInfo): string {
	return oneLine(info.name || info.firstMessage || "(empty session)", 70);
}

// ─────────────────────────── session access ───────────────────────────

/** Remember sessions we have seen so short ids resolve without a full scan. */
const sessionCache = new Map<string, SessionInfo>();

function remember(infos: SessionInfo[]): SessionInfo[] {
	for (const info of infos) sessionCache.set(shortId(info.id), info);
	return infos;
}

async function resolveSession(ref: string): Promise<SessionInfo | undefined> {
	const key = ref.trim().replace(/^@?session:/, "").split("#")[0]!;
	const match = (i: SessionInfo) =>
		i.path === key || i.id === key || shortId(i.id) === shortId(key) || path.basename(i.path) === key;
	for (const info of sessionCache.values()) if (match(info)) return info;
	const all = remember(await SessionManager.listAll());
	return all.find(match);
}

interface Turn {
	index: number; // 1-based
	user: string;
	parts: string[]; // rendered lines of the turn (user + assistant + tools)
	toolCalls: number;
}

interface ParsedSession {
	turns: Turn[];
	compactions: string[];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b: any) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : ""))
		.filter(Boolean)
		.join("\n");
}

function parseSession(file: string): ParsedSession {
	let entries: any[];
	try {
		entries = SessionManager.open(file).getBranch() as any[];
	} catch {
		entries = fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return undefined;
				}
			})
			.filter(Boolean);
	}
	const turns: Turn[] = [];
	const compactions: string[] = [];
	let cur: Turn | undefined;
	for (const e of entries) {
		if (e?.type === "compaction" && typeof e.summary === "string") {
			compactions.push(e.summary);
			(cur?.parts ?? []).push(`[compaction summary]\n${e.summary}`);
			continue;
		}
		if (e?.type !== "message") continue;
		const m = e.message;
		if (m?.role === "user") {
			const text = textOf(m.content);
			cur = { index: turns.length + 1, user: text, parts: [`## Turn ${turns.length + 1}\n### user\n${text}`], toolCalls: 0 };
			turns.push(cur);
			continue;
		}
		if (!cur) continue;
		if (m?.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b?.type === "text" && b.text?.trim()) cur.parts.push(`### assistant\n${b.text}`);
				else if (b?.type === "toolCall") {
					cur.toolCalls++;
					const args = JSON.stringify(b.arguments ?? {});
					cur.parts.push(`### tool call: ${b.name}\n${args.length > 400 ? `${args.slice(0, 400)}…` : args}`);
				}
			}
		} else if (m?.role === "toolResult") {
			const t = textOf(m.content);
			cur.parts.push(`### tool result (${m.toolName ?? "?"})\n${t.length > 1500 ? `${t.slice(0, 1500)}… [+${t.length - 1500} chars]` : t}`);
		} else if (m?.role === "custom" && m.display !== false) {
			const t = textOf(m.content);
			if (t.trim()) cur.parts.push(`### ${m.customType ?? "custom"}\n${oneLine(t, 600)}`);
		}
	}
	return { turns, compactions };
}

function parseTurnRange(spec: string | undefined, total: number): [number, number] | undefined {
	if (!spec) return undefined;
	const m = spec.trim().match(/^(\d+)(?:\s*-\s*(\d+)?)?$/);
	if (!m) return undefined;
	const a = Math.max(1, Number(m[1]));
	const b = m[2] ? Number(m[2]) : spec.includes("-") ? total : a;
	return [a, Math.min(total, Math.max(a, b))];
}

// ─────────────────────────── picker model ───────────────────────────

interface Item {
	label: string;
	detail?: string;
	/** Text used for fuzzy matching. */
	search: string;
	/** Token inserted on ↩ (undefined → not selectable). */
	token?: string;
	/** Present when → can open a child level. */
	open?: () => Level;
}

interface Level {
	title: string;
	items: Item[] | undefined; // undefined while loading
	error?: string;
	/** Optional deep search used when the query is non-empty (e.g. recursive files). */
	searchAll?: () => Item[];
	query: string;
	selected: number;
}

type ModeId = "files" | "project" | "all";
const MODES: { id: ModeId; label: string }[] = [
	{ id: "files", label: "Files" },
	{ id: "project", label: "Project sessions" },
	{ id: "all", label: "All sessions" },
];

interface PickerEnv {
	cwd: () => string;
	currentSessionFile: () => string | undefined;
	requestRender: () => void;
}

function asyncLevel(title: string, env: PickerEnv, load: () => Promise<Item[]>): Level {
	const level: Level = { title, items: undefined, query: "", selected: 0 };
	load()
		.then((items) => {
			level.items = items;
		})
		.catch((err) => {
			level.items = [];
			level.error = String(err?.message ?? err);
		})
		.finally(env.requestRender);
	return level;
}

// files ----------------------------------------------------------------

function fileItem(abs: string, isDir: boolean, env: PickerEnv, labelBase: string): Item {
	const rel = path.relative(env.cwd(), abs) || ".";
	const label = isDir ? `${labelBase}/` : labelBase;
	return {
		label,
		search: labelBase,
		detail: isDir ? "dir" : undefined,
		token: fileToken(isDir ? `${rel}/` : rel),
		open: isDir ? () => dirLevel(abs, env) : undefined,
	};
}

function dirLevel(dir: string, env: PickerEnv): Level {
	let items: Item[] = [];
	let error: string | undefined;
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !SKIP_DIRS.has(e.name));
		entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
		items = entries.map((e) => fileItem(path.join(dir, e.name), e.isDirectory(), env, e.name));
	} catch (err: any) {
		error = String(err?.message ?? err);
	}
	let deep: Item[] | undefined;
	return {
		title: tildify(dir),
		items,
		error,
		query: "",
		selected: 0,
		searchAll: () => {
			if (deep) return deep;
			deep = [];
			const stack = [dir];
			while (stack.length && deep.length < FILE_SCAN_LIMIT) {
				const d = stack.pop()!;
				let list: fs.Dirent[];
				try {
					list = fs.readdirSync(d, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const e of list) {
					if (SKIP_DIRS.has(e.name)) continue;
					const abs = path.join(d, e.name);
					const isDir = e.isDirectory();
					deep.push(fileItem(abs, isDir, env, path.relative(dir, abs)));
					if (isDir) stack.push(abs);
				}
			}
			return deep;
		},
	};
}

// sessions -------------------------------------------------------------

function turnsLevel(info: SessionInfo, env: PickerEnv): Level {
	return asyncLevel(`${sessionTitle(info)} › turns`, env, async () => {
		const { turns } = parseSession(info.path);
		const sid = shortId(info.id);
		return turns
			.slice()
			.reverse()
			.map((t) => ({
				label: `#${t.index} ${oneLine(t.user, 90) || "(no text)"}`,
				search: `${t.index} ${t.user}`,
				detail: t.toolCalls ? `${t.toolCalls} tools` : undefined,
				token: `@session:${sid}#${t.index}`,
			}));
	});
}

function sessionItems(infos: SessionInfo[], env: PickerEnv, showCwd: boolean): Item[] {
	const current = env.currentSessionFile();
	return infos
		.filter((i) => i.path !== current)
		.sort((a, b) => b.modified.getTime() - a.modified.getTime())
		.map((info) => ({
			label: sessionTitle(info),
			search: `${info.name ?? ""} ${info.firstMessage} ${showCwd ? info.cwd : ""}`,
			detail: `${ageLabel(info.modified)} · ${info.messageCount} msgs${showCwd ? ` · ${tildify(info.cwd)}` : ""}`,
			token: `@session:${shortId(info.id)}`,
			open: () => turnsLevel(info, env),
		}));
}

function projectSessionsLevel(env: PickerEnv): Level {
	return asyncLevel(`sessions in ${tildify(env.cwd())}`, env, async () =>
		sessionItems(remember(await SessionManager.list(env.cwd())), env, false),
	);
}

function allProjectsLevel(env: PickerEnv): Level {
	let all: SessionInfo[] = [];
	const level = asyncLevel("all projects", env, async () => {
		all = remember(await SessionManager.listAll());
		const groups = new Map<string, SessionInfo[]>();
		for (const info of all) {
			const key = info.cwd || "(unknown)";
			groups.set(key, [...(groups.get(key) ?? []), info]);
		}
		return [...groups.entries()]
			.map(([cwd, list]) => ({ cwd, list, latest: Math.max(...list.map((i) => i.modified.getTime())) }))
			.sort((a, b) => b.latest - a.latest)
			.map(({ cwd, list, latest }) => ({
				label: `${tildify(cwd)}/`,
				search: cwd,
				detail: `${list.length} sessions · ${ageLabel(new Date(latest))}`,
				open: (): Level => ({
					title: `sessions in ${tildify(cwd)}`,
					items: sessionItems(list, env, false),
					query: "",
					selected: 0,
				}),
			}));
	});
	// Typing at the project level searches every session directly.
	level.searchAll = () => sessionItems(all, env, true);
	return level;
}

function rootLevel(mode: ModeId, env: PickerEnv): Level {
	if (mode === "files") return dirLevel(env.cwd(), env);
	if (mode === "project") return projectSessionsLevel(env);
	return allProjectsLevel(env);
}

// ─────────────────────────── editor ───────────────────────────

class MentionEditor extends CustomEditor {
	private picker: { mode: number; stack: Level[] } | undefined;
	private readonly getTheme: () => Theme;
	private readonly env: Omit<PickerEnv, "requestRender">;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		getTheme: () => Theme,
		env: Omit<PickerEnv, "requestRender">,
	) {
		super(tui, editorTheme, keybindings, { embedWorkingStatus: true });
		this.getTheme = getTheme;
		this.env = env;
	}

	private get pickerEnv(): PickerEnv {
		return { ...this.env, requestRender: () => this.tui.requestRender() };
	}

	private openPicker(mode = 0): void {
		this.picker = { mode, stack: [rootLevel(MODES[mode]!.id, this.pickerEnv)] };
	}

	private get level(): Level | undefined {
		return this.picker?.stack[this.picker.stack.length - 1];
	}

	private visibleItems(level: Level): Item[] {
		const q = level.query.trim();
		if (!q) return level.items ?? [];
		const pool = level.searchAll ? level.searchAll() : (level.items ?? []);
		return fuzzyFilter(pool, q, (i) => i.search).slice(0, 200);
	}

	private atTokenBoundary(): boolean {
		const { line, col } = this.getCursor();
		const before = (this.getLines()[line] ?? "").slice(0, col);
		return before.length === 0 || /\s$/.test(before);
	}

	override handleInput(data: string): void {
		const printable = data.length === 1 && data >= " " ? data : decodeKittyPrintable(data);

		if (!this.picker) {
			if (printable === "@" && this.atTokenBoundary()) {
				this.insertTextAtCursor("@"); // insertTextAtCursor does not trigger built-in autocomplete
				this.openPicker(0);
				this.tui.requestRender();
				return;
			}
			super.handleInput(data);
			return;
		}

		const picker = this.picker;
		const level = this.level!;
		const items = this.visibleItems(level);
		const clamp = () => {
			const n = this.visibleItems(level).length;
			level.selected = n === 0 ? 0 : Math.max(0, Math.min(level.selected, n - 1));
		};

		if (matchesKey(data, "escape")) {
			this.picker = undefined;
		} else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			const dir = matchesKey(data, "shift+tab") ? -1 : 1;
			this.openPicker((picker.mode + dir + MODES.length) % MODES.length);
		} else if (matchesKey(data, "up")) {
			level.selected = items.length ? (level.selected - 1 + items.length) % items.length : 0;
		} else if (matchesKey(data, "down")) {
			level.selected = items.length ? (level.selected + 1) % items.length : 0;
		} else if (matchesKey(data, "pageUp")) {
			level.selected = Math.max(0, level.selected - MAX_VISIBLE);
		} else if (matchesKey(data, "pageDown")) {
			level.selected = Math.min(Math.max(0, items.length - 1), level.selected + MAX_VISIBLE);
		} else if (matchesKey(data, "right")) {
			const item = items[level.selected];
			if (item?.open) picker.stack.push(item.open());
		} else if (matchesKey(data, "left")) {
			if (picker.stack.length > 1) picker.stack.pop();
		} else if (matchesKey(data, "enter")) {
			const item = items[level.selected];
			if (item?.token) {
				this.picker = undefined;
				// "@" is already in the buffer right before the cursor.
				this.insertTextAtCursor(`${item.token.slice(1)} `);
			} else if (item?.open) {
				picker.stack.push(item.open());
			}
		} else if (matchesKey(data, "backspace")) {
			if (level.query) {
				level.query = level.query.slice(0, -1);
				clamp();
			} else {
				this.picker = undefined;
				super.handleInput(data); // removes the "@"
			}
		} else if (printable && printable !== "\t") {
			if (printable === " " && !level.query) {
				// "@ " → user just wanted a literal @
				this.picker = undefined;
				super.handleInput(data);
			} else {
				level.query += printable;
				level.selected = 0;
			}
		} else {
			// Unknown key (ctrl combos, etc.): close picker and let the editor handle it.
			this.picker = undefined;
			super.handleInput(data);
		}
		this.tui.requestRender();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.picker) return lines;
		return [...lines, ...this.renderPicker(width)];
	}

	private renderPicker(width: number): string[] {
		const t = this.getTheme();
		const picker = this.picker!;
		const level = this.level!;
		const out: string[] = [];
		const fit = (s: string) => truncateToWidth(s, width);

		const tabs = MODES.map((m, i) =>
			i === picker.mode ? t.bold(t.fg("accent", `[${m.label}]`)) : t.fg("muted", ` ${m.label} `),
		).join(t.fg("dim", " "));
		out.push(fit(` ${t.fg("accent", "@")} ${tabs}  ${t.fg("dim", "(tab)")}`));

		const crumbs = picker.stack.map((l) => l.title).join(t.fg("dim", " › "));
		const query = level.query ? `  ${t.fg("dim", "filter:")} ${t.fg("text", level.query)}` : `  ${t.fg("dim", "type to filter")}`;
		out.push(fit(` ${t.fg("muted", crumbs)}${query}`));

		if (level.items === undefined) {
			out.push(fit(`   ${t.fg("dim", "loading…")}`));
		} else if (level.error) {
			out.push(fit(`   ${t.fg("error", level.error)}`));
		} else {
			const items = this.visibleItems(level);
			if (items.length === 0) out.push(fit(`   ${t.fg("dim", "no matches")}`));
			const start = Math.max(0, Math.min(level.selected - Math.floor(MAX_VISIBLE / 2), items.length - MAX_VISIBLE));
			for (let i = start; i < Math.min(items.length, start + MAX_VISIBLE); i++) {
				const item = items[i]!;
				const focused = i === level.selected;
				const marker = focused ? t.fg("accent", "❯ ") : "  ";
				const arrow = item.open ? t.fg("dim", " ›") : "";
				const label = focused ? t.bold(t.fg("accent", item.label)) : t.fg("text", item.label);
				const detail = item.detail ? `  ${t.fg("dim", item.detail)}` : "";
				out.push(fit(` ${marker}${label}${arrow}${detail}`));
			}
			if (items.length > MAX_VISIBLE) out.push(fit(`   ${t.fg("dim", `${level.selected + 1}/${items.length}`)}`));
		}

		const hint = (k: string, d: string) => `${t.fg("dim", k)} ${t.fg("muted", d)}`;
		out.push(
			fit(
				` ${[
					hint("↑↓", "move"),
					hint("→", "open"),
					hint("←", "back"),
					hint("↩", "select"),
					hint("tab", "type"),
					hint("esc", "cancel"),
				].join(t.fg("dim", "  ·  "))}`,
			),
		);
		return out;
	}
}

// ─────────────────────────── mention resolution ───────────────────────────

const TOKEN_RE = /(^|\s)@(session:([0-9a-fA-F]{8})(?:#(\d+))?|"([^"]+)"|([^\s@"]+))/g;

interface Mention {
	token: string;
	kind: "file" | "session";
	meta: string;
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
				const text = buf.toString("utf8");
				const lines = text.split("\n");
				const first = lines.find((l) => l.trim()) ?? "";
				info += `, ${lines.length} lines; starts with: "${oneLine(first, 100)}"`;
			}
		} catch {}
	}
	return { token, kind: "file", meta: info };
}

async function describeSession(short: string, turn: number | undefined): Promise<Mention | undefined> {
	const info = await resolveSession(short);
	const token = `@session:${short}${turn ? `#${turn}` : ""}`;
	if (!info) return { token, kind: "session", meta: "pi session (not found on disk)" };
	let parsed: ParsedSession = { turns: [], compactions: [] };
	try {
		parsed = parseSession(info.path);
	} catch {}
	const head = `pi session "${sessionTitle(info)}" (project ${tildify(info.cwd)}, ${parsed.turns.length} turns, last active ${info.modified.toISOString()}, file ${info.path})`;
	if (turn) {
		const t = parsed.turns[turn - 1];
		const what = t ? `turn #${turn}; the user asked: "${oneLine(t.user, 160)}"` : `turn #${turn} (out of range)`;
		return { token, kind: "session", meta: `${what} — in ${head}. Read it with read_session({ session: "${short}", turns: "${turn}" }).` };
	}
	const last = parsed.turns.at(-1);
	const lastNote = last ? ` Last request: "${oneLine(last.user, 120)}".` : "";
	return {
		token,
		kind: "session",
		meta: `whole ${head}.${lastNote} Get an outline with read_session({ session: "${short}" }), then read specific turns.`,
	};
}

async function collectMentions(prompt: string, cwd: string): Promise<Mention[]> {
	const seen = new Set<string>();
	const out: Mention[] = [];
	for (const m of prompt.matchAll(TOKEN_RE)) {
		const [, , , sid, turn, quoted, bare] = m;
		const key = m[2]!;
		if (seen.has(key)) continue;
		seen.add(key);
		const mention = sid
			? await describeSession(sid.toLowerCase(), turn ? Number(turn) : undefined)
			: describeFile((quoted ?? bare ?? "").replace(/[.,;:!?)]+$/, ""), cwd);
		if (mention) out.push(mention);
	}
	return out;
}

// ─────────────────────────── extension ───────────────────────────

export default function sessionMention(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		ctx.ui.setEditorComponent(
			(tui, editorTheme, keybindings) =>
				new MentionEditor(tui, editorTheme, keybindings, () => ctx.ui.theme, {
					cwd: () => ctx.cwd,
					currentSessionFile: () => ctx.sessionManager.getSessionFile(),
				}),
		);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user" || !event.prompt.includes("@")) return;
		const mentions = await collectMentions(event.prompt, ctx.cwd);
		if (mentions.length === 0) return;
		const body = mentions.map((m, i) => `${i + 1}. ${m.token} → ${m.meta}`).join("\n");
		const content = [
			"<mentions>",
			"The user referenced these items with @ in the prompt above. Only metadata is attached to keep the context small.",
			"Read the actual content yourself when it is relevant: files/directories with your file tools (read, ls, grep …),",
			"pi sessions with the read_session tool (outline first, then only the turns you need).",
			body,
			"</mentions>",
		].join("\n");
		return {
			message: { customType: CUSTOM_TYPE, content, display: true, details: { mentions } },
		};
	});

	pi.registerMessageRenderer<{ mentions: Mention[] }>(CUSTOM_TYPE, (message, { expanded }, theme) => {
		const mentions = message.details?.mentions ?? [];
		const header = theme.fg("accent", `@ ${mentions.length} mention${mentions.length === 1 ? "" : "s"} attached (metadata only)`);
		const lines = mentions.map((m) => {
			const icon = m.kind === "session" ? "◆" : "▪";
			return `  ${theme.fg("dim", icon)} ${theme.fg("text", m.token)}${expanded ? `\n    ${theme.fg("muted", m.meta)}` : ""}`;
		});
		return new Text([header, ...lines].join("\n"), 1, 0);
	});

	pi.registerTool({
		name: "read_session",
		label: "Read session",
		description:
			"Read a past pi session transcript referenced as @session:<id>. Without `turns` returns an outline (one line per turn). " +
			"With `turns` (e.g. \"3\" or \"2-5\" or \"7-\") returns those turns: user prompts, assistant text, tool calls and truncated tool results.",
		promptSnippet: "read_session: read a past pi session mentioned as @session:<id> (outline or selected turns)",
		parameters: Type.Object({
			session: Type.String({ description: "Short id (8 hex chars from @session:<id>), full session id, or .jsonl path" }),
			turns: Type.Optional(Type.String({ description: 'Turn or range, e.g. "3", "2-5", "7-". Omit for an outline.' })),
			maxChars: Type.Optional(Type.Number({ description: "Output budget in characters (default 30000)" })),
		}),
		async execute(_id, params): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
			const info = await resolveSession(params.session);
			if (!info) {
				return { content: [{ type: "text", text: `Session not found: ${params.session}` }], details: {} };
			}
			const { turns, compactions } = parseSession(info.path);
			const header = `Session ${shortId(info.id)} "${sessionTitle(info)}" — project ${info.cwd}, ${turns.length} turns, modified ${info.modified.toISOString()}`;
			const range = parseTurnRange(params.turns, turns.length);
			if (!range) {
				const outline = turns.map(
					(t) => `#${t.index} ${oneLine(t.user, 140)}${t.toolCalls ? `  (${t.toolCalls} tool calls)` : ""}`,
				);
				const comp = compactions.length ? `\n\nLatest compaction summary:\n${compactions.at(-1)!.slice(0, 4000)}` : "";
				return {
					content: [{ type: "text", text: `${header}\n\nOutline:\n${outline.join("\n")}${comp}\n\nCall again with turns:"N" or "A-B" for details.` }],
					details: { turns: turns.length },
				};
			}
			const budget = Math.max(2000, params.maxChars ?? 30_000);
			const chunks: string[] = [];
			let used = 0;
			let last = range[0] - 1;
			for (let i = range[0]; i <= range[1]; i++) {
				const text = turns[i - 1]!.parts.join("\n\n");
				if (used + text.length > budget && chunks.length > 0) break;
				const clipped = text.length > budget ? `${text.slice(0, budget)}\n… [turn truncated]` : text;
				chunks.push(clipped);
				used += clipped.length;
				last = i;
			}
			const more = last < range[1] ? `\n\n[budget reached — continue with turns:"${last + 1}-${range[1]}"]` : "";
			return {
				content: [{ type: "text", text: `${header}\n\n${chunks.join("\n\n")}${more}` }],
				details: { from: range[0], to: last },
			};
		},
	});
}
