/**
 * Swarm: live sessions that mention each other.
 *
 * Every main session registers itself as a peer (registry file + local socket).
 * Peers talk through:
 *   • the `session_send` / `session_peers` tools (agent → agent),
 *   • `/tell <peer> <text>` and a leading `@session:<id8> <text>` in the prompt (human → agent),
 *   • automatic return of the handling turn's final answer when the sender asked for a reply.
 *
 * Loop safety: hop counter per thread (PI_MENTION_MAX_HOPS, default 6), per-sender
 * rate limits, message-id dedupe, auto-replies never request a reply themselves.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { collectMentions, type LivePeerView, leadingSessionToken } from "../mentions.js";
import { textOf } from "../sessions.js";
import { rows } from "../text.js";
import { oneLine, shortId, tildify } from "../util.js";
import {
	type Ack,
	type Envelope,
	MAX_TEXT,
	maxHops,
	newId,
	type PeerRecord,
	PROTOCOL_VERSION,
	SWARM_SENT_TYPE,
	SWARM_TYPE,
	type Sender,
} from "./protocol.js";
import { deliver, endpointFor, listRecords, PeerServer, removeRecord, writeRecord } from "./transport.js";

const RATE_WINDOW_MS = 60_000;
const INBOUND_PER_PEER = 20;
const OUTBOUND_PER_PEER = 12;
const HOP_MEMORY_MS = 10 * 60_000;
const PENDING_TTL_MS = 30 * 60_000;
const SEEN_LIMIT = 500;

export interface Swarm {
	install(): void;
	peerView(short: string): LivePeerView | undefined;
	/** Other live sessions (this one excluded). */
	listPeers(): LivePeerView[];
	selfShort(): string | undefined;
}

interface Self {
	id: string;
	short: string;
	endpoint: string;
	startedAt: number;
	server: PeerServer;
}

/** The loose shape of messages in `agent_end.messages` that we look at. */
interface LooseMessage {
	role?: string;
	customType?: string;
	content?: unknown;
	details?: { envelope?: { id?: string } };
}

type SendOutcome = { ok: true; peer: PeerRecord; env: Envelope; status: "idle" | "busy" } | { ok: false; error: string };

function toView(r: PeerRecord): LivePeerView {
	return { short: r.short, title: r.title, cwd: r.cwd, host: r.host, pid: r.pid, status: r.status };
}

function peerLine(r: PeerRecord, selfShort: string | undefined): string {
	const me = r.short === selfShort ? "  (this session)" : "";
	const title = r.title ? `  "${oneLine(r.title, 50)}"` : "";
	return `${r.short}  ${r.status.padEnd(4)}  ${r.host.padEnd(3)}  ${tildify(r.cwd)}${title}  pid ${r.pid}${me}`;
}

/** omp exposes `ctx.agent.kind` ("main" | "sub"); pi has none, so every pi session counts as main. */
function agentKind(ctx: ExtensionContext): string | undefined {
	const agent: unknown = Reflect.get(ctx, "agent");
	const kind: unknown = typeof agent === "object" && agent !== null ? Reflect.get(agent, "kind") : undefined;
	return typeof kind === "string" ? kind : undefined;
}

function assistantTextAfter(messages: LooseMessage[], index: number): string {
	for (let i = messages.length - 1; i > index; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		const text = textOf(m.content).trim();
		if (text) return text;
	}
	return "";
}

export function createSwarm(pi: ExtensionAPI, host: string): Swarm {
	const switchedOff = ["0", "off", "false", "no"].includes((process.env.PI_MENTION_SWARM ?? "").toLowerCase());
	let enabled = !switchedOff;
	let self: Self | undefined;
	let busy = false;
	let cwd = process.cwd();
	let queue: Promise<void> = Promise.resolve();
	let exitHookInstalled = false;

	const seen = new Set<string>();
	const inboundRate = new Map<string, number[]>();
	const outboundRate = new Map<string, number[]>();
	/** Last message received from each peer: lets a reply continue the same thread with hop+1. */
	const inbound = new Map<string, { thread: string; hop: number; at: number }>();
	/** Delivered messages whose sender wants the handling turn's final answer back. */
	const pending = new Map<string, { env: Envelope; at: number }>();

	let recordsCache: { at: number; list: PeerRecord[] } | undefined;
	const records = (): PeerRecord[] => {
		if (recordsCache && Date.now() - recordsCache.at < 1_000) return recordsCache.list;
		const list = listRecords();
		recordsCache = { at: Date.now(), list };
		return list;
	};
	const viewOf = (short: string): LivePeerView | undefined => {
		const r = records().find((x) => x.short === short);
		return r ? toView(r) : undefined;
	};

	const withinRate = (bucket: Map<string, number[]>, key: string, limit: number): boolean => {
		const now = Date.now();
		const hits = (bucket.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
		if (hits.length >= limit) {
			bucket.set(key, hits);
			return false;
		}
		hits.push(now);
		bucket.set(key, hits);
		return true;
	};

	const title = (): string | undefined => {
		try {
			return pi.getSessionName() || undefined;
		} catch {
			return undefined;
		}
	};

	const flush = (): void => {
		if (!self) return;
		try {
			writeRecord({
				id: self.id,
				short: self.short,
				pid: process.pid,
				cwd,
				title: title(),
				host,
				endpoint: self.endpoint,
				startedAt: self.startedAt,
				status: busy ? "busy" : "idle",
				updatedAt: Date.now(),
			});
			recordsCache = undefined;
		} catch {
			// registry is best effort: the socket keeps working without it
		}
	};

	const senderInfo = (): Sender | undefined =>
		self ? { id: self.id, short: self.short, title: title(), cwd, host } : undefined;

	const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
	};

	// ───────────────────────── lifecycle ─────────────────────────

	async function teardown(): Promise<void> {
		const s = self;
		self = undefined;
		if (!s) return;
		await s.server.close();
		removeRecord(s.short, s.endpoint);
		recordsCache = undefined;
	}

	async function bind(ctx: ExtensionContext): Promise<void> {
		const kind = agentKind(ctx);
		if (!enabled || (kind && kind !== "main")) return; // omp subagents / clones are not peers
		cwd = ctx.cwd;
		const id = ctx.sessionManager.getSessionId();
		const short = shortId(id);
		if (self?.short === short) {
			flush();
			return;
		}
		await teardown();
		const endpoint = endpointFor(short);
		const server = new PeerServer(onEnvelope);
		try {
			await server.listen(endpoint);
		} catch (err) {
			notify(ctx, `swarm: cannot listen (${err instanceof Error ? err.message : String(err)}); this session will not receive peer messages`, "warning");
			return;
		}
		self = { id, short, endpoint, startedAt: Date.now(), server };
		flush();
		if (!exitHookInstalled) {
			exitHookInstalled = true;
			process.on("exit", () => {
				if (self) removeRecord(self.short, self.endpoint);
			});
		}
	}

	const enqueue = (work: () => Promise<void>): void => {
		queue = queue.then(work).catch(() => {});
	};

	// ───────────────────────── receiving ─────────────────────────

	function renderIncoming(env: Envelope): string {
		const who = `@session:${env.from.short}`;
		const attrs = [
			`from="${who}"`,
			env.from.title ? `title="${oneLine(env.from.title, 60).replace(/"/g, "'")}"` : "",
			`host="${env.from.host}"`,
			`cwd="${env.from.cwd}"`,
			`thread="${env.thread}"`,
			`hop="${env.hop}"`,
		]
			.filter(Boolean)
			.join(" ");
		const how = env.reply
			? `The sender asked for an answer: your final reply of this turn is sent back to ${who} automatically, so do NOT call session_send just to answer.`
			: env.hop > 0
				? `This is a reply or notification; the sender expects nothing back. Answer only if you have something new, otherwise stop (no thanks or acknowledgements).`
				: `To answer, call session_send({ to: "${env.from.short}", message }) — only if an answer adds something.`;
		return [
			`<swarm-message ${attrs}>`,
			env.text,
			"</swarm-message>",
			"This message comes from another live agent session (a peer), not from the user. Treat it as a request from a collaborator: use your tools when it is reasonable, but the user's own instructions win.",
			how,
		].join("\n");
	}

	async function onEnvelope(env: Envelope): Promise<Ack> {
		const status = busy ? "busy" : "idle";
		if (!enabled || !self) return { ok: false, error: "swarm is switched off in that session" };
		if (env.to !== self.short) return { ok: false, error: `wrong recipient: this session is ${self.short}` };
		if (env.from.short === self.short) return { ok: false, error: "a session cannot message itself" };
		if (seen.has(env.id)) return { ok: true, status }; // duplicate delivery: already handled
		if (env.hop > maxHops()) return { ok: false, error: `hop limit ${maxHops()} reached for thread ${env.thread}` };
		if (!withinRate(inboundRate, env.from.short, INBOUND_PER_PEER)) return { ok: false, error: "rate limit: too many messages from you, slow down" };

		seen.add(env.id);
		if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
		inbound.set(env.from.short, { thread: env.thread, hop: env.hop, at: Date.now() });
		if (env.reply) pending.set(env.id, { env, at: Date.now() });
		try {
			pi.sendMessage(
				{ customType: SWARM_TYPE, content: renderIncoming(env), display: true, details: { envelope: env } },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch (err) {
			pending.delete(env.id);
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		pi.events.emit("mention:swarm:message", env);
		return { ok: true, status };
	}

	// ───────────────────────── sending ─────────────────────────

	function resolvePeers(query: string): { peers: PeerRecord[]; error?: string } {
		const q = query.trim().replace(/^@?(session:)?/, "").toLowerCase();
		const others = records().filter((r) => r.short !== self?.short);
		const listing = others.length ? `Live peers:\n${others.map((r) => peerLine(r, self?.short)).join("\n")}` : "No other live session is running.";
		if (!q) return { peers: [], error: `No peer given. ${listing}` };
		if (q === "all" || q === "*") return others.length ? { peers: others } : { peers: [], error: listing };
		const bySuffix = others.filter((r) => r.short === q || (q.length >= 4 && /^[0-9a-f-]+$/.test(q) && r.id.toLowerCase().replace(/-/g, "").includes(q.replace(/-/g, ""))));
		if (bySuffix.length === 1) return { peers: bySuffix };
		const exact = others.filter((r) => r.title?.toLowerCase() === q);
		if (exact.length === 1) return { peers: exact };
		const fuzzy = others.filter((r) => `${r.title ?? ""} ${r.cwd.split(/[\\/]/).pop() ?? ""}`.toLowerCase().includes(q));
		if (fuzzy.length === 1) return { peers: fuzzy };
		const candidates = bySuffix.length > 1 ? bySuffix : fuzzy;
		if (candidates.length > 1) return { peers: [], error: `"${query}" is ambiguous:\n${candidates.map((r) => peerLine(r, self?.short)).join("\n")}` };
		return { peers: [], error: `No live peer matches "${query}". ${listing}` };
	}

	async function sendTo(peer: PeerRecord, text: string, opts: { reply: boolean; origin: "user" | "agent" }): Promise<SendOutcome> {
		const from = senderInfo();
		if (!from) return { ok: false, error: "this session is not part of the swarm (swarm off, or its socket could not start)" };
		if (!withinRate(outboundRate, peer.short, OUTBOUND_PER_PEER)) return { ok: false, error: `rate limit: more than ${OUTBOUND_PER_PEER} messages/min to ${peer.short}` };

		const known = inbound.get(peer.short);
		const continuing = opts.origin === "agent" && known && Date.now() - known.at < HOP_MEMORY_MS ? known : undefined;
		const hop = continuing ? continuing.hop + 1 : 0;
		if (hop > maxHops()) {
			return {
				ok: false,
				error: `hop limit ${maxHops()} reached on thread ${continuing!.thread}: stop messaging ${peer.short} automatically, summarise to the user and let them decide whether to continue.`,
			};
		}
		const extra = (await collectMentions(text, { cwd, selfShort: self?.short, peer: (s) => (s === peer.short ? undefined : viewOf(s)) })).filter(
			(m) => m.token !== `@session:${peer.short}`,
		);
		const body = extra.length ? `${text}\n\nMentioned items (metadata from the sender's machine):\n${extra.map((m) => `- ${m.token} → ${m.meta}`).join("\n")}` : text;
		const env: Envelope = {
			v: PROTOCOL_VERSION,
			id: newId(),
			from,
			to: peer.short,
			text: body.slice(0, MAX_TEXT),
			thread: continuing?.thread ?? newId(),
			hop,
			reply: opts.reply,
			ts: Date.now(),
		};
		const ack = await deliver(peer.endpoint, env);
		if (!ack.ok) {
			if (ack.unreachable) {
				removeRecord(peer.short, peer.endpoint);
				recordsCache = undefined;
			}
			return { ok: false, error: `${peer.short}: ${ack.error ?? "delivery failed"}` };
		}
		if (opts.origin === "agent") for (const [id, p] of pending) if (p.env.from.short === peer.short) pending.delete(id); // already answered by hand
		return { ok: true, peer, env, status: ack.status ?? "idle" };
	}

	async function sendMany(query: string, text: string, opts: { reply: boolean; origin: "user" | "agent" }): Promise<{ lines: string[]; ok: boolean; sent: SendOutcome[] }> {
		const { peers, error } = resolvePeers(query);
		if (error) return { lines: [error], ok: false, sent: [] };
		const reply = query.trim().toLowerCase() === "all" ? false : opts.reply; // a broadcast never collects answers
		const sent: SendOutcome[] = [];
		for (const p of peers) sent.push(await sendTo(p, text, { ...opts, reply }));
		const lines = sent.map((r) =>
			r.ok
				? `delivered to ${r.peer.short}${r.peer.title ? ` "${oneLine(r.peer.title, 40)}"` : ""} (${r.status}, hop ${r.env.hop})${r.env.reply ? "; its final answer will arrive here as a swarm message" : "; no reply requested"}`
				: `FAILED: ${r.error}`,
		);
		return { lines, ok: sent.length > 0 && sent.every((r) => r.ok), sent };
	}

	function recordSent(sent: SendOutcome[]): void {
		for (const r of sent) {
			if (!r.ok) continue;
			try {
				pi.sendMessage(
					{
						customType: SWARM_SENT_TYPE,
						content: `[You sent this to live session @session:${r.peer.short}${r.peer.title ? ` "${oneLine(r.peer.title, 40)}"` : ""}${r.env.reply ? "; its answer will come back as a swarm message" : ""}]\n${r.env.text}`,
						display: true,
						details: { envelope: r.env, peer: toView(r.peer) },
					},
					{ triggerTurn: false },
				);
			} catch {
				// the transcript record is a nicety
			}
		}
	}

	// ───────────────────────── auto-reply ─────────────────────────

	async function flushReplies(messages: LooseMessage[], ctx: ExtensionContext): Promise<void> {
		for (const [id, p] of [...pending]) {
			if (Date.now() - p.at > PENDING_TTL_MS) {
				pending.delete(id);
				continue;
			}
			const idx = messages.findIndex((m) => m.role === "custom" && m.customType === SWARM_TYPE && m.details?.envelope?.id === id);
			if (idx < 0) continue; // not handled yet (queued behind this run)
			pending.delete(id);
			const text = assistantTextAfter(messages, idx);
			const target = records().find((r) => r.short === p.env.from.short);
			if (!text || !target || !self) continue;
			const hop = p.env.hop + 1;
			if (hop > maxHops()) {
				notify(ctx, `swarm: not answering ${target.short}: hop limit ${maxHops()} reached`, "warning");
				continue;
			}
			const from = senderInfo()!;
			const ack = await deliver(target.endpoint, {
				v: PROTOCOL_VERSION,
				id: newId(),
				from,
				to: target.short,
				text: text.slice(0, MAX_TEXT),
				thread: p.env.thread,
				hop,
				reply: false,
				ts: Date.now(),
			});
			notify(ctx, ack.ok ? `swarm: answered ${target.short}` : `swarm: could not answer ${target.short}: ${ack.error}`, ack.ok ? "info" : "warning");
		}
	}

	// ───────────────────────── installation ─────────────────────────

	function install(): void {
		pi.on("session_start", (_e, ctx) => enqueue(() => bind(ctx)));
		// Older pi builds fold this into `session_start`; omp still emits `session_switch` on /new and resume. Named by string so both type-check.
		const onSwitch = pi.on.bind(pi) as unknown as (event: string, handler: (e: unknown, ctx: ExtensionContext) => void) => void;
		onSwitch("session_switch", (_e, ctx) => enqueue(() => bind(ctx)));
		pi.on("session_shutdown", () => enqueue(teardown));

		pi.on("agent_start", () => {
			busy = true;
			flush();
		});
		pi.on("agent_end", async (event, ctx) => {
			busy = false;
			flush();
			if (pending.size === 0) return;
			// `agent_end.messages` is the loop's context (a pi build may hand over only new messages): the envelope id locates our message either way.
			await flushReplies(event.messages as unknown as LooseMessage[], ctx);
		});

		// pi answers input hooks with `{ action }`, omp with `{ handled }`; one object satisfies both.
		const pass = { action: "continue" } as const;
		const consumed = { action: "handled", handled: true } as const;

		// "@session:<live id> do X" at the very start of a prompt addresses that session directly.
		pi.on("input", async (event, ctx) => {
			if (event.source === "extension") return pass;
			inbound.clear(); // a human is driving again: agent-to-agent hop chains restart
			if (!enabled || !self) return pass;
			const lead = leadingSessionToken(event.text);
			if (!lead || !lead.rest.trim()) return pass;
			const peer = records().find((r) => r.short === lead.short && r.short !== self?.short);
			if (!peer) return pass; // not live: a plain session reference
			const res = await sendTo(peer, lead.rest.trim(), { reply: true, origin: "user" });
			if (!res.ok) {
				notify(ctx, `swarm: ${res.error}`, "error");
				return pass;
			}
			recordSent([res]);
			notify(ctx, `→ ${peer.short} (${res.status}): ${oneLine(lead.rest, 70)}`);
			return consumed;
		});

		pi.registerMessageRenderer<{ envelope?: Envelope }>(SWARM_TYPE, (message, { expanded }, theme) => {
			const env = message.details?.envelope;
			if (!env) return undefined;
			const flags = [env.reply ? "answer requested" : env.hop > 0 ? "reply" : "", `hop ${env.hop}`].filter(Boolean).join(" · ");
			const head = `${theme.fg("accent", "◀ swarm")} ${theme.bold(theme.fg("text", `@session:${env.from.short}`))}${env.from.title ? theme.fg("muted", ` "${oneLine(env.from.title, 40)}"`) : ""} ${theme.fg("dim", `· ${env.from.host} ${tildify(env.from.cwd)} · ${flags}`)}`;
			const body = env.text.split("\n");
			const shown = expanded ? body : body.slice(0, 6);
			const more = !expanded && body.length > shown.length ? [theme.fg("dim", `… +${body.length - shown.length} lines`)] : [];
			return rows([head, ...shown.map((l) => `  ${theme.fg("text", l)}`), ...more]);
		});
		pi.registerMessageRenderer<{ envelope?: Envelope; peer?: LivePeerView }>(SWARM_SENT_TYPE, (message, { expanded }, theme) => {
			const env = message.details?.envelope;
			if (!env) return undefined;
			const peer = message.details?.peer;
			const head = `${theme.fg("accent", "▶ swarm")} ${theme.bold(theme.fg("text", `@session:${env.to}`))}${peer?.title ? theme.fg("muted", ` "${oneLine(peer.title, 40)}"`) : ""} ${theme.fg("dim", env.reply ? "· answer requested" : "")}`;
			const body = env.text.split("\n");
			const shown = expanded ? body : body.slice(0, 6);
			const more = !expanded && body.length > shown.length ? [theme.fg("dim", `… +${body.length - shown.length} lines`)] : [];
			return rows([head, ...shown.map((l) => `  ${theme.fg("text", l)}`), ...more]);
		});

		pi.registerTool({
			name: "session_peers",
			label: "Session peers",
			description: "List the other agent sessions that are running right now on this machine (live peers you can message with session_send).",
			promptSnippet: "session_peers: list live agent sessions (peers) you can message",
			parameters: Type.Object({}),
			async execute() {
				const list = records();
				const text = !enabled
					? "Swarm is switched off (/swarm on)."
					: list.length
						? `short id  state  host  project  title\n${list.map((r) => peerLine(r, self?.short)).join("\n")}`
						: "No live sessions.";
				return { content: [{ type: "text" as const, text }], details: { peers: list.map(toView) } };
			},
		});

		pi.registerTool({
			name: "session_send",
			label: "Send to session",
			description:
				"Send a message to another LIVE agent session (a peer) so it works on it now. `to` is a short id from session_peers / @session:<id8>, a unique title fragment, or \"all\". " +
				"The peer cannot see your conversation: make the message self-contained and mention file paths. " +
				"With reply=true (default) the peer's final answer of that turn comes back to you as a swarm message; with reply=false it is a notification. " +
				"Do not message back just to acknowledge or thank. Threads are capped at a few hops to stop ping-pong.",
			promptSnippet: "session_send: message a live peer session (use session_peers to find it); the answer returns as a swarm message",
			parameters: Type.Object({
				to: Type.String({ description: 'Peer short id (8 hex), unique title fragment, or "all" (broadcast, no replies)' }),
				message: Type.String({ description: "Self-contained message for the peer" }),
				reply: Type.Optional(Type.Boolean({ description: "Auto-return the peer's final answer (default true)" })),
			}),
			async execute(_id, params) {
				if (!enabled) return { content: [{ type: "text" as const, text: "Swarm is switched off in this session (/swarm on)." }], details: { ok: false } };
				const out = await sendMany(params.to, params.message, { reply: params.reply ?? true, origin: "agent" });
				return { content: [{ type: "text" as const, text: out.lines.join("\n") }], details: { ok: out.ok } };
			},
		});

		pi.registerCommand("swarm", {
			description: "Live sessions: /swarm [list|on|off|status]",
			handler: async (args, ctx) => {
				const sub = args.trim().toLowerCase();
				if (sub === "off") {
					enabled = false;
					await teardown();
					notify(ctx, "swarm off: this session is hidden from peers and ignores their messages");
					return;
				}
				if (sub === "on") {
					enabled = true;
					await bind(ctx);
					notify(ctx, self ? `swarm on: you are @session:${self.short}` : "swarm could not start (see warning above)");
					return;
				}
				const list = records();
				const head = enabled ? `swarm on · you are @session:${self?.short ?? "?"} · max ${maxHops()} hops/thread` : "swarm off (/swarm on)";
				notify(ctx, `${head}\n${list.length ? list.map((r) => peerLine(r, self?.short)).join("\n") : "no live sessions"}`);
			},
		});

		pi.registerCommand("tell", {
			description: "Message a live session: /tell [--no-reply] <peer> <message>",
			handler: async (args, ctx) => {
				let rest = args.trim();
				let reply = true;
				const flag = /^(--no-reply|-n)\s+/.exec(rest);
				if (flag) {
					reply = false;
					rest = rest.slice(flag[0].length);
				}
				const m = /^(\S+)\s+([\s\S]+)$/.exec(rest);
				if (!m) {
					notify(ctx, "usage: /tell [--no-reply] <peer short id | title | all> <message>", "warning");
					return;
				}
				const out = await sendMany(m[1]!, m[2]!.trim(), { reply, origin: "user" });
				recordSent(out.sent);
				notify(ctx, out.lines.join("\n"), out.ok ? "info" : "error");
			},
		});
	}

	return {
		install,
		selfShort: () => self?.short,
		peerView: viewOf,
		listPeers: () => records().filter((r) => r.short !== self?.short).map(toView),
	};
}
