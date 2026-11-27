import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MENTION_EVENTS, type MentionProvider } from "./api.js";

type Bus = ExtensionAPI["events"];

const RESERVED = new Set(["session", "file", "http", "https"]);
const ID_RE = /^[a-z][a-z0-9-]*$/;

const providers = new Map<string, MentionProvider>();
const boundBuses = new WeakSet<object>();

function isProvider(value: unknown): value is MentionProvider {
	if (!value || typeof value !== "object") return false;
	const p = value as Partial<MentionProvider>;
	return (
		typeof p.id === "string" &&
		ID_RE.test(p.id) &&
		!RESERVED.has(p.id) &&
		typeof p.label === "string" &&
		typeof p.describe === "function" &&
		(p.list === undefined || typeof p.list === "function")
	);
}

export function listProviders(): MentionProvider[] {
	return [...providers.values()];
}

export function getProvider(id: string): MentionProvider | undefined {
	return providers.get(id);
}

/** Listen for provider (un)registrations on the shared bus; safe to call once per session binding. */
export function bindProviderEvents(events: Bus): void {
	if (boundBuses.has(events)) return;
	boundBuses.add(events);
	events.on(MENTION_EVENTS.register, (data) => {
		if (isProvider(data)) providers.set(data.id, data);
	});
	events.on(MENTION_EVENTS.unregister, (data) => {
		if (typeof data === "string") providers.delete(data);
	});
}

/** Tell late-loading providers that they can register now. */
export function announceReady(events: Bus): void {
	events.emit(MENTION_EVENTS.ready, { version: 1 });
}
