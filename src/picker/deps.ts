import type { LivePeerView } from "../mentions.js";

/** What a picker needs from the running session; both host adapters share it. */
export interface PickerDeps {
	cwd(): string;
	/** Short id of the current session (excluded from session lists). */
	selfShort(): string | undefined;
	/** Other live sessions. */
	peers(): LivePeerView[];
}
