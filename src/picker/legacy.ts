/**
 * Layered `@` picker for hosts that still have `ctx.ui.setEditorComponent` (pi, omp ≤ 18).
 * Imports pi-tui, which omp ≥ 19 refuses to load: this module is only ever imported dynamically
 * after the entry point has seen `setEditorComponent`.
 *
 *   Tab / Shift+Tab   cycle type: Files → Live → Project sessions → All sessions → provider tabs
 *   ↑ / ↓ (PgUp/PgDn) move        → open (directory / project / session → turns)   ← back
 *   ↩                 insert the focused item as a token        Esc  close (keeps a literal `@`)
 *   any other text    filters the current level (fuzzy; files search recursively)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { decodeKittyPrintable, fuzzyFilter, matchesKey } from "@earendil-works/pi-tui";
import { MENTION_BLOCKER_RE } from "../mentions.js";
import { listProviders } from "../providers.js";
import { listAllSessions, listProjectSessions, parseSession, type SessionRef, sessionTitle } from "../sessions.js";
import { truncate } from "../text.js";
import { ageLabel, fileToken, oneLine, SKIP_DIRS, tildify } from "../util.js";
import type { PickerDeps } from "./deps.js";

const MAX_VISIBLE = 8;
const FILE_SCAN_LIMIT = 5000;

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

interface Mode {
	label: string;
	root(env: PickerEnv): Level;
}

interface PickerEnv extends PickerDeps {
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
	return {
		label: isDir ? `${labelBase}/` : labelBase,
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
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
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

function turnsLevel(info: SessionRef, env: PickerEnv): Level {
	return asyncLevel(`${sessionTitle(info)} › turns`, env, async () =>
		parseSession(info.path)
			.turns.slice()
			.reverse()
			.map((t) => ({
				label: `#${t.index} ${oneLine(t.user, 90) || "(no text)"}`,
				search: `${t.index} ${t.user}`,
				detail: t.toolCalls ? `${t.toolCalls} tools` : undefined,
				token: `@session:${info.short}#${t.index}`,
			})),
	);
}

function sessionItems(infos: SessionRef[], env: PickerEnv, showCwd: boolean): Item[] {
	const self = env.selfShort();
	const live = new Set(env.peers().map((p) => p.short));
	return infos
		.filter((i) => i.short !== self)
		.sort((a, b) => Number(live.has(b.short)) - Number(live.has(a.short)) || b.modified.getTime() - a.modified.getTime())
		.map((info) => ({
			label: `${live.has(info.short) ? "● " : ""}${sessionTitle(info)}`,
			search: `${info.title} ${info.firstMessage} ${showCwd ? info.cwd : ""}`,
			detail: `${live.has(info.short) ? "live · " : ""}${ageLabel(info.modified)} · ${info.messageCount} msgs${showCwd ? ` · ${tildify(info.cwd)}` : ""}`,
			token: `@session:${info.short}`,
			open: () => turnsLevel(info, env),
		}));
}

function livePeersLevel(env: PickerEnv): Level {
	const items: Item[] = env.peers().map((p) => ({
		label: `● ${p.title ? oneLine(p.title, 60) : p.short}`,
		search: `${p.short} ${p.title ?? ""} ${p.cwd}`,
		detail: `${p.status} · ${p.host} · ${tildify(p.cwd)}`,
		token: `@session:${p.short}`,
	}));
	return { title: "live sessions", items, query: "", selected: 0 };
}

function projectSessionsLevel(env: PickerEnv): Level {
	return asyncLevel(`sessions in ${tildify(env.cwd())}`, env, async () => sessionItems(await listProjectSessions(env.cwd()), env, false));
}

function allProjectsLevel(env: PickerEnv): Level {
	let all: SessionRef[] = [];
	const level = asyncLevel("all projects", env, async () => {
		all = await listAllSessions();
		const groups = new Map<string, SessionRef[]>();
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
				open: (): Level => ({ title: `sessions in ${tildify(cwd)}`, items: sessionItems(list, env, false), query: "", selected: 0 }),
			}));
	});
	// Typing at the project level searches every session directly.
	level.searchAll = () => sessionItems(all, env, true);
	return level;
}

function providerLevel(id: string, label: string, env: PickerEnv): Level {
	const provider = listProviders().find((p) => p.id === id);
	return asyncLevel(label, env, async () =>
		((await provider?.list?.("", { cwd: env.cwd() })) ?? []).map((o) => ({
			label: o.label,
			search: `${o.label} ${o.value}`,
			detail: o.detail,
			token: `@${id}:${/\s|"/.test(o.value) ? `"${o.value.replace(/"/g, "")}"` : o.value}`,
		})),
	);
}

function buildModes(): Mode[] {
	return [
		{ label: "Files", root: (env) => dirLevel(env.cwd(), env) },
		{ label: "Live", root: livePeersLevel },
		{ label: "Project sessions", root: projectSessionsLevel },
		{ label: "All sessions", root: allProjectsLevel },
		...listProviders()
			.filter((p) => p.list)
			.map((p) => ({ label: p.label, root: (env: PickerEnv) => providerLevel(p.id, p.label, env) })),
	];
}

// ─────────────────────────── editor ───────────────────────────

class MentionEditor extends CustomEditor {
	private picker: { mode: number; modes: Mode[]; stack: Level[] } | undefined;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly getTheme: () => Theme,
		private readonly deps: PickerDeps,
	) {
		super(tui, editorTheme, keybindings, { embedWorkingStatus: true });
	}

	private get env(): PickerEnv {
		return {
			cwd: () => this.deps.cwd(),
			selfShort: () => this.deps.selfShort(),
			peers: () => this.deps.peers(),
			requestRender: () => this.tui.requestRender(),
		};
	}

	private openPicker(mode = 0, modes = buildModes()): void {
		this.picker = { mode, modes, stack: [modes[mode]!.root(this.env)] };
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

	/**
	 * Whether an `@` typed at the cursor should open the picker: anywhere in the prompt, only
	 * skipped when glued to a preceding ASCII word so e-mail addresses / handles stay literal.
	 */
	private atTokenBoundary(): boolean {
		const { line, col } = this.getCursor();
		const before = (this.getLines()[line] ?? "").slice(0, col);
		return before.length === 0 || !MENTION_BLOCKER_RE.test(before);
	}

	/** Insert the picked token, adding a separating space only when needed. */
	private insertToken(token: string): void {
		const { line, col } = this.getCursor();
		const next = (this.getLines()[line] ?? "").charAt(col);
		this.insertTextAtCursor(next && /\s/.test(next) ? token : `${token} `);
	}

	override handleInput(data: string): void {
		const printable = data.length === 1 && data >= " " ? data : decodeKittyPrintable(data);

		if (!this.picker) {
			if (printable === "@" && this.atTokenBoundary()) {
				this.insertTextAtCursor("@"); // does not trigger the built-in autocomplete
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
			this.openPicker((picker.mode + dir + picker.modes.length) % picker.modes.length, picker.modes);
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
				this.insertToken(item.token.slice(1)); // "@" is already in the buffer
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
				this.picker = undefined; // "@ " → a literal @
				super.handleInput(data);
			} else {
				level.query += printable;
				level.selected = 0;
			}
		} else {
			this.picker = undefined; // unknown key (ctrl combos, …): close and let the editor handle it
			super.handleInput(data);
		}
		this.tui.requestRender();
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		return this.picker ? [...lines, ...this.renderPicker(width)] : lines;
	}

	private renderPicker(width: number): string[] {
		const t = this.getTheme();
		const picker = this.picker!;
		const level = this.level!;
		const out: string[] = [];
		const fit = (s: string) => truncate(s, width);

		const tabs = picker.modes
			.map((m, i) => (i === picker.mode ? t.bold(t.fg("accent", `[${m.label}]`)) : t.fg("muted", ` ${m.label} `)))
			.join(t.fg("dim", " "));
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
		out.push(fit(` ${[hint("↑↓", "move"), hint("→", "open"), hint("←", "back"), hint("↩", "select"), hint("tab", "type"), hint("esc", "cancel")].join(t.fg("dim", "  ·  "))}`));
		return out;
	}
}

export function installLegacyPicker(ctx: ExtensionContext, deps: PickerDeps): void {
	ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new MentionEditor(tui, editorTheme, keybindings, () => ctx.ui.theme, deps));
}
