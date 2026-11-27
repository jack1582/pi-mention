/**
 * Swarm wire protocol: newline-delimited JSON over a per-session local socket.
 * One short-lived connection per message: request line → ack line → close.
 */
import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const MAX_TEXT = 64_000;
/** Custom-message type of an incoming peer message. */
export const SWARM_TYPE = "mention-swarm";
/** Custom-message type of a message this session sent to a peer (context + transcript record). */
export const SWARM_SENT_TYPE = "mention-swarm-sent";

export interface Sender {
	/** Full session id. */
	id: string;
	short: string;
	title?: string;
	cwd: string;
	/** "pi", "omp", … */
	host: string;
}

export interface Envelope {
	v: typeof PROTOCOL_VERSION;
	id: string;
	from: Sender;
	/** Short id of the recipient. */
	to: string;
	text: string;
	/** Conversation id, inherited by replies. */
	thread: string;
	/** Agent-to-agent hops so far; a human-originated message is hop 0. */
	hop: number;
	/** The sender wants the recipient's final answer of the handling turn sent back automatically. */
	reply: boolean;
	ts: number;
}

export interface Ack {
	ok: boolean;
	error?: string;
	status?: "idle" | "busy";
}

export interface PeerRecord {
	id: string;
	short: string;
	pid: number;
	cwd: string;
	title?: string;
	host: string;
	/** Socket path (or named pipe on Windows). */
	endpoint: string;
	startedAt: number;
	status: "idle" | "busy";
	updatedAt: number;
}

export function newId(): string {
	return randomUUID().replace(/-/g, "").slice(0, 12);
}

export function maxHops(): number {
	const n = Number(process.env.PI_MENTION_MAX_HOPS);
	return Number.isInteger(n) && n >= 1 ? n : 6;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseSender(v: unknown): Sender | undefined {
	if (!isRecord(v)) return undefined;
	const { id, short, title, cwd, host } = v;
	if (typeof id !== "string" || typeof short !== "string" || typeof cwd !== "string" || typeof host !== "string") return undefined;
	return { id, short, cwd, host, title: typeof title === "string" ? title : undefined };
}

/** Validate untrusted wire data. Returns the envelope or a reason string. */
export function parseEnvelope(raw: unknown): Envelope | string {
	if (!isRecord(raw)) return "not an object";
	if (raw.v !== PROTOCOL_VERSION) return `unsupported protocol version ${String(raw.v)}`;
	const from = parseSender(raw.from);
	if (!from) return "bad sender";
	const { id, to, text, thread, hop, reply, ts } = raw;
	if (typeof id !== "string" || !id || id.length > 64) return "bad id";
	if (typeof to !== "string" || !/^[0-9a-f]{8}$/.test(to)) return "bad recipient";
	if (typeof text !== "string" || !text.trim()) return "empty message";
	if (text.length > MAX_TEXT) return `message longer than ${MAX_TEXT} chars`;
	if (typeof thread !== "string" || !thread || thread.length > 64) return "bad thread";
	if (typeof hop !== "number" || !Number.isInteger(hop) || hop < 0) return "bad hop";
	if (typeof reply !== "boolean") return "bad reply flag";
	if (typeof ts !== "number") return "bad timestamp";
	return { v: PROTOCOL_VERSION, id, from, to, text, thread, hop, reply, ts };
}
