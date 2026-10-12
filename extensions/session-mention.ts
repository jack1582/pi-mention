/**
 * pi-session-mention
 *
 * Wraps the built-in autocomplete provider so `@` also lists recent pi
 * sessions for the current working directory. Selecting one inserts a
 * `@<session-file-name>` token. On input, the token is replaced with the
 * session transcript rendered as a fenced reference block.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_SESSIONS = 12;
/** Cap on the rendered transcript injected into the prompt (characters). */
const MAX_TRANSCRIPT_CHARS = 60_000;
/** Cap per message when rendering. */
const MAX_MESSAGE_CHARS = 8_000;

interface SessionChoice {
	fileName: string;
	fullPath: string;
	firstMessage: string;
	ageLabel: string;
}

function ageLabel(modified: Date): string {
	const ms = Date.now() - modified.getTime();
	const min = Math.floor(ms / 60_000);
	if (min < 1) return "just now";
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
}

function firstLine(text: string, max = 80): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

export default function sessionMentionExtension(pi: ExtensionAPI) {
	let choices: SessionChoice[] = [];
	let choicesPromise: Promise<SessionChoice[]> | null = null;
	let warned = false;

	async function loadSessions(): Promise<SessionChoice[]> {
		if (choicesPromise) return choicesPromise;
		choicesPromise = (async () => {
			try {
				const sessions = await SessionManager.list(process.cwd());
				return sessions.slice(0, MAX_SESSIONS).map((s) => ({
					fileName: path.basename(s.path),
					fullPath: s.path,
					firstMessage: firstLine(s.firstMessage || "(empty session)"),
					ageLabel: ageLabel(s.modified),
				}));
			} catch (err) {
				if (!warned) {
					warned = true;
					pi.appendEntry?.("session-mention", {
						reason: `failed to list sessions: ${err}`,
					});
				}
				return [];
			}
		})();
		return choicesPromise;
	}

	/** Render a session jsonl file into readable transcript text. */
	function renderTranscript(fullPath: string): string {
		const raw = fs.readFileSync(fullPath, "utf8");
		const lines = raw.split("\n");
		const parts: string[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type !== "message" || !entry.message) continue;
			const { role, content } = entry.message;
			if (role !== "user" && role !== "assistant") continue;
			let text = "";
			if (typeof content === "string") {
				text = content;
			} else if (Array.isArray(content)) {
				const chunks: string[] = [];
				for (const block of content) {
					if (block?.type === "text" && typeof block.text === "string") chunks.push(block.text);
				}
				text = chunks.join("\n");
			}
			text = text.trim();
			if (!text) continue;
			if (text.length > MAX_MESSAGE_CHARS) text = text.slice(0, MAX_MESSAGE_CHARS) + " …[truncated]";
			parts.push(`### ${role}\n${text}`);
		}
		let out = parts.join("\n\n");
		if (out.length > MAX_TRANSCRIPT_CHARS) {
			// Keep the head; note the elision.
			out = out.slice(0, MAX_TRANSCRIPT_CHARS) + "\n\n…[older turns elided]";
		}
		return out;
	}

	/** Find a @<name>.jsonl token referencing a known session file. */
	function findSessionToken(text: string): { token: string; choice: SessionChoice } | null {
		const byName = new Map(choices.map((c) => [c.fileName, c]));
		const re = /(?:^|\s)@([^\s]+\.jsonl)/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			const token = m[1];
			const choice = byName.get(token);
			if (choice) return { token: "@" + token, choice };
		}
		return null;
	}

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => ({
			async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
				if (current?.getSuggestions) {
					const existing = await current.getSuggestions(lines, cursorLine, cursorCol, options);
					if (existing) return existing;
				}
				// Extract an @token at the cursor.
				const line = lines[cursorLine] || "";
				const before = line.slice(0, cursorCol);
				const m = before.match(/@([^\s@]*)$/);
				if (!m) return null;
				const query = m[1];
				const list = await loadSessions();
				if (list.length === 0) return null;
				const items: AutocompleteItem[] = fuzzyFilter(list, query, (c) => `${c.fileName} ${c.firstMessage}`)
					.slice(0, 8)
					.map((c) => ({
						value: `@${c.fileName}`,
						label: `session: ${c.firstMessage}`,
						description: `${c.ageLabel} · ${c.fileName}`,
					}));
				return { items, prefix: `@${query}` };
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				if (current?.applyCompletion) {
					return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				}
				const line = lines[cursorLine] || "";
				const newLine = line.slice(0, cursorCol - prefix.length) + item.value + " " + line.slice(cursorCol);
				const newLines = [...lines];
				newLines[cursorLine] = newLine;
				return { lines: newLines, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length + 1 };
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current?.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
		// Reset cache per session so newly created sessions show up.
		choicesPromise = null;
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const hit = findSessionToken(event.text);
		if (!hit) return { action: "continue" };

		let transcript: string;
		try {
			transcript = renderTranscript(hit.choice.fullPath);
		} catch (err) {
			ctx.ui.notify(`session-mention: failed to read session: ${err}`, "error");
			return { action: "continue" };
		}
		if (!transcript.trim()) {
			ctx.ui.notify("session-mention: session has no readable messages", "error");
			return { action: "continue" };
		}

		const block = [
			"<session_reference>",
			`The following is the transcript of a previous pi session (${hit.choice.fileName}).`,
			"Use it as background/reference material when answering the rest of this prompt.",
			"",
			"```markdown",
			transcript,
			"```",
			"</session_reference>",
		].join("\n");

		const newText = event.text.split(hit.token).join(block);
		return { action: "transform", text: newText };
	});
}
