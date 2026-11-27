/**
 * pi-mention — `@` for files, sessions, live peer sessions and anything other
 * extensions register, on pi and omp.
 *
 * Layout (this file only wires things together):
 *   src/mentions.ts         token parsing → metadata
 *   src/providers.ts        extension API for new `@scheme:` kinds (pi.events)
 *   src/sessions.ts         session listing / transcript parsing (pi + omp shapes)
 *   src/swarm/              live sessions talking to each other (tools, /tell, sockets)
 *   src/picker/legacy.ts    layered picker via setEditorComponent   (pi, omp ≤ 18)
 *   src/picker/autocomplete.ts  autocomplete provider              (omp ≥ 19)
 *
 * On submit only *metadata* about every mentioned item is attached; the agent reads
 * real content itself (file tools, `read_session`), so context stays small.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { collectMentions } from "../src/mentions.js";
import { type AutocompleteHost, installAutocomplete } from "../src/picker/autocomplete.js";
import type { PickerDeps } from "../src/picker/deps.js";
import { announceReady, bindProviderEvents } from "../src/providers.js";
import { parseSession, parseTurnRange, resolveSession, sessionTitle } from "../src/sessions.js";
import { createSwarm } from "../src/swarm/index.js";
import { rows } from "../src/text.js";
import { CUSTOM_TYPE, oneLine } from "../src/util.js";

interface MentionDetails {
	mentions: { token: string; kind: string; meta: string }[];
}

const LEGACY_PICKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "picker", "legacy.ts");

/** omp's `pi` object carries its schema builders (`zod`); pi's does not. Only used to label peers. */
function hostName(pi: ExtensionAPI): string {
	return Reflect.has(pi, "zod") ? "omp" : "pi";
}

/** omp ≥ 19: composer hooks replaced `setEditorComponent`; autocomplete stacking is the extension point. */
function autocompleteHost(ui: object): AutocompleteHost | undefined {
	const add: unknown = Reflect.get(ui, "addAutocompleteProvider");
	if (typeof add !== "function" || !Reflect.get(ui, "composer")) return undefined;
	return { addAutocompleteProvider: (factory) => add.call(ui, factory) };
}

export default function mention(pi: ExtensionAPI) {
	bindProviderEvents(pi.events);
	const swarm = createSwarm(pi, hostName(pi));
	swarm.install();

	let cwd = process.cwd();
	const deps: PickerDeps = { cwd: () => cwd, selfShort: swarm.selfShort, peers: swarm.listPeers };
	const autocompleteHooked = new WeakSet<object>();

	async function installPicker(ctx: ExtensionContext): Promise<void> {
		// Older pi builds report no `ctx.mode`; the capability checks below decide what can be installed.
		if (!ctx.hasUI || (ctx.mode && ctx.mode !== "tui")) return;
		const ac = autocompleteHost(ctx.ui);
		if (ac) {
			if (autocompleteHooked.has(ctx.ui)) return; // provider stacks are re-applied by the host
			autocompleteHooked.add(ctx.ui);
			installAutocomplete(ac, deps);
		} else if (typeof ctx.ui.setEditorComponent === "function") {
			// The specifier is computed on purpose: omp ≥ 19 walks the module graph (literal `import()` included) and
			// refuses to load anything that reaches pi-tui, which only legacy.ts imports.
			const legacy: typeof import("../src/picker/legacy.js") = await import(LEGACY_PICKER);
			legacy.installLegacyPicker(ctx, deps);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		announceReady(pi.events);
		await installPicker(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// pi hands `before_agent_start` for custom messages too (no `prompt`); omp adds `reason`, "revive" has an empty prompt.
		if (Reflect.get(event, "reason") === "revive" || !("prompt" in event)) return;
		const prompt: string = event.prompt;
		if (!prompt.includes("@")) return;
		const mentions = await collectMentions(prompt, { cwd: ctx.cwd, selfShort: swarm.selfShort(), peer: swarm.peerView });
		if (mentions.length === 0) return;
		const body = mentions.map((m, i) => `${i + 1}. ${m.token} → ${m.meta}`).join("\n");
		const live = mentions.some((m) => m.live)
			? "A LIVE session is another agent running right now: send it work with session_send, read what it already did with read_session."
			: "";
		const content = [
			"<mentions>",
			"The user referenced these items with @ in the prompt above. Only metadata is attached to keep the context small.",
			"Read the actual content yourself when it is relevant: files/directories with your file tools (read, ls, grep …),",
			"sessions with the read_session tool (outline first, then only the turns you need).",
			live,
			body,
			"</mentions>",
		]
			.filter(Boolean)
			.join("\n");
		return { message: { customType: CUSTOM_TYPE, content, display: true, details: { mentions } } };
	});

	pi.registerMessageRenderer<MentionDetails>(CUSTOM_TYPE, (message, { expanded }, theme) => {
		const mentions = message.details?.mentions ?? [];
		const lines = [theme.fg("accent", `@ ${mentions.length} mention${mentions.length === 1 ? "" : "s"} attached (metadata only)`)];
		for (const m of mentions) {
			const icon = m.kind === "session" ? "◆" : m.kind === "provider" ? "◇" : "▪";
			lines.push(`  ${theme.fg("dim", icon)} ${theme.fg("text", m.token)}`);
			if (expanded) lines.push(`    ${theme.fg("muted", m.meta)}`);
		}
		return rows(lines);
	});

	pi.registerTool({
		name: "read_session",
		label: "Read session",
		description:
			"Read a past or live agent session transcript referenced as @session:<id>. Without `turns` returns an outline (one line per turn). " +
			'With `turns` (e.g. "3" or "2-5" or "7-") returns those turns: user prompts, assistant text, tool calls and truncated tool results.',
		promptSnippet: "read_session: read a session mentioned as @session:<id> (outline or selected turns)",
		parameters: Type.Object({
			session: Type.String({ description: "Short id (8 hex chars from @session:<id>), full session id, or .jsonl path" }),
			turns: Type.Optional(Type.String({ description: 'Turn or range, e.g. "3", "2-5", "7-". Omit for an outline.' })),
			maxChars: Type.Optional(Type.Number({ description: "Output budget in characters (default 30000)" })),
		}),
		async execute(_id, params) {
			const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} as Record<string, unknown> });
			const info = await resolveSession(params.session);
			if (!info) return text(`Session not found: ${params.session}`);
			const { turns, compactions } = parseSession(info.path);
			const header = `Session ${info.short} "${sessionTitle(info)}" — project ${info.cwd}, ${turns.length} turns, modified ${info.modified.toISOString()}`;
			const range = parseTurnRange(params.turns, turns.length);
			if (!range) {
				const outline = turns.map((t) => `#${t.index} ${oneLine(t.user, 140)}${t.toolCalls ? `  (${t.toolCalls} tool calls)` : ""}`);
				const comp = compactions.length ? `\n\nLatest compaction summary:\n${compactions.at(-1)!.slice(0, 4000)}` : "";
				return {
					content: [{ type: "text" as const, text: `${header}\n\nOutline:\n${outline.join("\n")}${comp}\n\nCall again with turns:"N" or "A-B" for details.` }],
					details: { turns: turns.length },
				};
			}
			const budget = Math.max(2000, params.maxChars ?? 30_000);
			const chunks: string[] = [];
			let used = 0;
			let last = range[0] - 1;
			for (let i = range[0]; i <= range[1]; i++) {
				const body = turns[i - 1]!.parts.join("\n\n");
				if (used + body.length > budget && chunks.length > 0) break;
				const clipped = body.length > budget ? `${body.slice(0, budget)}\n… [turn truncated]` : body;
				chunks.push(clipped);
				used += clipped.length;
				last = i;
			}
			const more = last < range[1] ? `\n\n[budget reached — continue with turns:"${last + 1}-${range[1]}"]` : "";
			return {
				content: [{ type: "text" as const, text: `${header}\n\n${chunks.join("\n\n")}${more}` }],
				details: { from: range[0], to: last },
			};
		},
	});
}
