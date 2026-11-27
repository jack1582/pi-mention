/**
 * Local transport for the swarm: a peer registry (one JSON file per live session)
 * plus one Unix-domain socket (named pipe on Windows) per session. Nothing leaves
 * the machine, and on POSIX the directory and sockets are owner-only.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { type Ack, type Envelope, type PeerRecord, parseEnvelope } from "./protocol.js";

const MAX_LINE = 256 * 1024;
const IO_TIMEOUT_MS = 5_000;
const IS_WIN = process.platform === "win32";
/** sockaddr_un.sun_path is ~104 bytes on macOS, 108 on Linux. */
const MAX_SOCKET_PATH = 100;

export function swarmDir(): string {
	return process.env.PI_MENTION_HOME ? path.resolve(process.env.PI_MENTION_HOME) : path.join(os.homedir(), ".pi-mention", "swarm");
}

function ensurePrivateDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (IS_WIN) return;
	const st = fs.statSync(dir);
	if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
		throw new Error(`refusing to use ${dir}: owned by another user`);
	}
	if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

/** Where a session listens. Falls back to the temp dir when the swarm dir would overflow the socket path limit. */
export function endpointFor(short: string): string {
	if (IS_WIN) return `\\\\.\\pipe\\pi-mention-${os.userInfo().username}-${short}`;
	const preferred = path.join(swarmDir(), `${short}.sock`);
	if (preferred.length <= MAX_SOCKET_PATH) return preferred;
	const uid = typeof process.getuid === "function" ? process.getuid() : "u";
	return path.join(os.tmpdir(), `pi-mention-${uid}`, `${short}.sock`);
}

// ─────────────────────────── registry ───────────────────────────

const recordFile = (short: string) => path.join(swarmDir(), `${short}.json`);

export function writeRecord(rec: PeerRecord): void {
	ensurePrivateDir(swarmDir());
	const file = recordFile(rec.short);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export function removeRecord(short: string, endpoint?: string): void {
	fs.rmSync(recordFile(short), { force: true });
	if (endpoint && !IS_WIN) fs.rmSync(endpoint, { force: true });
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function parseRecord(raw: string): PeerRecord | undefined {
	try {
		const r = JSON.parse(raw) as Partial<PeerRecord>;
		if (typeof r.short !== "string" || typeof r.id !== "string" || typeof r.pid !== "number" || typeof r.endpoint !== "string") return undefined;
		return {
			id: r.id,
			short: r.short,
			pid: r.pid,
			cwd: r.cwd ?? "",
			title: r.title,
			host: r.host ?? "?",
			endpoint: r.endpoint,
			startedAt: r.startedAt ?? 0,
			status: r.status === "busy" ? "busy" : "idle",
			updatedAt: r.updatedAt ?? 0,
		};
	} catch {
		return undefined;
	}
}

/** Live peers; records of dead processes are pruned on the way. */
export function listRecords(): PeerRecord[] {
	let names: string[];
	try {
		names = fs.readdirSync(swarmDir());
	} catch {
		return [];
	}
	const out: PeerRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(swarmDir(), name);
		let rec: PeerRecord | undefined;
		try {
			rec = parseRecord(fs.readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		if (!rec) continue;
		if (!pidAlive(rec.pid)) {
			removeRecord(rec.short, rec.endpoint);
			continue;
		}
		out.push(rec);
	}
	return out.sort((a, b) => b.startedAt - a.startedAt);
}

// ─────────────────────────── server ───────────────────────────

export type EnvelopeHandler = (env: Envelope) => Promise<Ack> | Ack;

export class PeerServer {
	private server: net.Server | undefined;

	constructor(private readonly handler: EnvelopeHandler) {}

	async listen(endpoint: string): Promise<void> {
		if (!IS_WIN) {
			ensurePrivateDir(path.dirname(endpoint));
			fs.rmSync(endpoint, { force: true }); // stale socket of a crashed process
		}
		const server = net.createServer((sock) => this.accept(sock));
		server.on("error", () => {}); // runtime errors must never reach the host as uncaught
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(endpoint, () => {
				server.off("error", reject);
				resolve();
			});
		});
		if (!IS_WIN) fs.chmodSync(endpoint, 0o600);
		this.server = server;
	}

	async close(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private accept(sock: net.Socket): void {
		sock.setEncoding("utf8");
		sock.setTimeout(IO_TIMEOUT_MS, () => sock.destroy());
		sock.on("error", () => {});
		let buf = "";
		let handled = false;
		sock.on("data", (chunk: string) => {
			if (handled) return;
			buf += chunk;
			if (buf.length > MAX_LINE) {
				handled = true;
				sock.destroy();
				return;
			}
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			handled = true;
			void this.respond(sock, buf.slice(0, nl));
		});
	}

	private async respond(sock: net.Socket, line: string): Promise<void> {
		let ack: Ack;
		try {
			const env = parseEnvelope(JSON.parse(line));
			ack = typeof env === "string" ? { ok: false, error: env } : await this.handler(env);
		} catch (err) {
			ack = { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		sock.end(`${JSON.stringify(ack)}\n`);
	}
}

// ─────────────────────────── client ───────────────────────────

export interface DeliverResult extends Ack {
	/** The endpoint refused or does not exist: the peer is gone. */
	unreachable?: boolean;
}

export function deliver(endpoint: string, env: Envelope, timeoutMs = IO_TIMEOUT_MS): Promise<DeliverResult> {
	return new Promise((resolve) => {
		let done = false;
		const finish = (r: DeliverResult) => {
			if (done) return;
			done = true;
			sock.destroy();
			resolve(r);
		};
		const sock = net.connect(endpoint);
		sock.setEncoding("utf8");
		sock.setTimeout(timeoutMs, () => finish({ ok: false, error: "timed out waiting for the peer" }));
		let buf = "";
		sock.on("connect", () => sock.write(`${JSON.stringify(env)}\n`));
		sock.on("data", (chunk: string) => {
			buf += chunk;
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			try {
				finish(JSON.parse(buf.slice(0, nl)) as Ack);
			} catch {
				finish({ ok: false, error: "malformed ack" });
			}
		});
		sock.on("error", (err: NodeJS.ErrnoException) => {
			const gone = err.code === "ECONNREFUSED" || err.code === "ENOENT";
			finish({ ok: false, unreachable: gone, error: gone ? "peer is not listening any more" : err.message });
		});
		sock.on("close", () => finish({ ok: false, error: "connection closed before the ack" }));
	});
}
