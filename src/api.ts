/**
 * Public extension surface of pi-mention (types only; nothing to import at runtime).
 *
 * Any other extension can teach `@` a new kind of reference by emitting on the
 * shared `pi.events` bus:
 *
 * ```ts
 * import type { MentionProvider } from "pi-mention/src/api";
 *
 * export default function (pi: ExtensionAPI) {
 *   const provider: MentionProvider = {
 *     id: "issue",                       // → tokens look like @issue:123
 *     label: "Issues",                   // → picker tab / autocomplete group
 *     list: async (query) => [{ value: "123", label: "#123 Login fails", detail: "open" }],
 *     describe: async (ref) => `GitHub issue ${ref}: …one line of metadata…`,
 *   };
 *   const register = () => pi.events.emit("mention:register", provider);
 *   pi.events.on("mention:ready", register); // pi-mention (re)announces itself on every session start
 *   register();                              // in case pi-mention was loaded first
 * }
 * ```
 *
 * Registration is idempotent per `id`. `describe` returns one short metadata line
 * (never the content itself: the agent fetches the content with its own tools).
 */

export interface MentionOption {
	/** The reference after `@<id>:`; quoted automatically when it contains spaces. */
	value: string;
	label: string;
	detail?: string;
}

export interface MentionContext {
	cwd: string;
}

export interface MentionProvider {
	/** Scheme: `[a-z][a-z0-9-]*`. `session` and `file` are reserved. */
	id: string;
	/** Short human name shown in the picker. */
	label: string;
	/** Suggestions for the picker / autocomplete; `query` is what the user typed after `@<id>:`. */
	list?(query: string, ctx: MentionContext): MentionOption[] | Promise<MentionOption[]>;
	/** One-line metadata for a mentioned reference; `undefined` ignores the token. */
	describe(ref: string, ctx: MentionContext): string | undefined | Promise<string | undefined>;
}

/** Channels on `pi.events`. */
export const MENTION_EVENTS = {
	/** emit a `MentionProvider` */
	register: "mention:register",
	/** emit a provider `id` (string) */
	unregister: "mention:unregister",
	/** pi-mention emits this on every session start; (re)register in response */
	ready: "mention:ready",
} as const;
