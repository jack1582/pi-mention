# pi-mention

`@` for **files, sessions and live peer sessions** in [pi](https://github.com/earendil-works/pi-coding-agent) and [omp](https://omp.sh). What you mention is attached as lightweight *metadata* the agent can follow up on, and sessions that are running side by side in different terminals can **message each other like a swarm**. Other extensions can add their own `@scheme:` kinds.

| Host | `@` UI |
| --- | --- |
| pi, omp ≤ 18 | layered picker (Tab between types, →/← to go deeper/back) |
| omp ≥ 19 | native autocomplete popup, extended with sessions, live peers and providers |

The mention metadata, `read_session`, the swarm and the provider API are identical on every host.

## Install

```sh
pi install git:github.com/jack1582/pi-mention      # pi
omp install pi-mention                              # omp (npm spec; a local path works too: omp install ./pi-mention)
```

## Mentions

Type `@` anywhere in the prompt (start, mid-sentence, any line, right after CJK text or an opening bracket). An `@` glued to an ASCII word (`me@host.com`) stays literal.

| Token | Meaning |
| --- | --- |
| `@path/to/file`, `@"path with spaces"` | file or directory |
| `@session:<id8>` | a session (past or **live**) |
| `@session:<id8>#<turn>` | one turn of a session |
| `@<scheme>:<ref>`, `@<scheme>:"<ref with spaces>"` | anything a registered provider describes |

### pi / omp ≤ 18: layered picker

```
 @ [Files]  Live   Project sessions   All sessions   (tab)
 ~/my-project  type to filter
 ❯ src/ ›  dir
   README.md
 ↑↓ move  ·  → open  ·  ← back  ·  ↩ select  ·  tab type  ·  esc cancel
```

`Tab`/`Shift+Tab` cycles Files → Live → Project sessions → All sessions → one tab per provider. `→` opens a directory, project or session (→ its turns), `←` goes back, `↩` inserts, typing fuzzy-filters (Files search recursively). `Esc`, `Space` on an empty filter, or `Backspace` on an empty filter closes it and keeps a literal `@`.

### omp ≥ 19: autocomplete

omp removed `setEditorComponent`, so the extension stacks an autocomplete provider on the built-in `@` completion (which already walks files directory by directory):

- `@` – live peers (`●`) first, then files
- `@ses…` – sessions matching what you type, and a `session:` entry
- `@session:` – project sessions, then all sessions, fuzzy-filtered by what you type next
- `@session:ab12cd34#` – turns of that session
- `@issue:` – options of the `issue` provider (any registered provider)

## Small context

On submit nothing is pasted into the prompt. One short `<mentions>` message carries metadata per item (path/size/first line, session title/turn count/last request, provider line). The agent reads real content itself: files with its normal tools, sessions with **`read_session`**:

- `read_session({ session: "1a2b3c4d" })` → outline (one line per turn + latest compaction summary)
- `read_session({ session: "1a2b3c4d", turns: "3-5", maxChars: 20000 })` → those turns, paginated by a character budget

## Swarm: live sessions that mention each other

Every main session registers as a peer when it starts (`~/.pi-mention/swarm/<id8>.json` plus a Unix socket; a named pipe on Windows [untested]). Sessions on pi and on omp see each other. Nothing leaves the machine; the directory and sockets are owner-only.

Talk to a peer three ways:

| How | Who | Effect |
| --- | --- | --- |
| `@session:<id8> do X` at the **start** of a prompt | you | direct message, your agent does not run; the answer comes back into your session |
| `/tell [--no-reply] <peer> <message>` | you | same, explicit; `<peer>` = id8, a unique title fragment, or `all` |
| `session_send({ to, message, reply? })` | the agent | the agent messages a peer by itself; `session_peers` lists who is live |

A mention that is *not* at the start (`look at @session:ab12cd34`) is only a reference: the agent is told that session is live and may use `session_send` if you asked it to.

The receiving session gets a `<swarm-message>`, handles it as a normal turn (even while busy: it queues as a follow-up), and when the sender asked for a reply (default) its **final answer of that turn is sent back automatically** — no tool call needed. Mentions inside the message are resolved on the sender's side and attached as metadata with absolute paths. `/swarm` lists live peers and toggles participation (`/swarm off|on`).

Loop safety (it is the model's choice to answer, so cycles are bounded by the extension):

- every reply increments a **hop counter** on the thread; past `PI_MENTION_MAX_HOPS` (default 6) the message is refused and the agent is told to hand back to you
- any human input resets the chain
- auto-returned answers never ask for a reply themselves
- per-peer rate limits in and out, message-id dedupe, 64 000-char message cap

Settings (environment): `PI_MENTION_SWARM=0` starts with the swarm off, `PI_MENTION_MAX_HOPS`, `PI_MENTION_HOME` (registry directory, default `~/.pi-mention/swarm`).

> Peer messages are prompts: a peer's agent can ask yours to run tools. The receiving agent is told the content is from a peer and that your own instructions win, but only run sessions you trust on one machine. `/swarm off` opts out.

## Extending: your own `@scheme:`

Any extension can register a provider on the shared event bus (types in `src/api.ts`):

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MentionProvider } from "pi-mention/src/api";

export default function (pi: ExtensionAPI) {
  const issues: MentionProvider = {
    id: "issue",                     // tokens: @issue:123
    label: "Issues",                 // picker tab
    list: async (query) => [{ value: "123", label: "#123 Login fails", detail: "open" }],
    describe: async (ref) => `GitHub issue ${ref}: …one line of metadata…`,
  };
  const register = () => pi.events.emit("mention:register", issues);
  pi.events.on("mention:ready", register); // pi-mention announces itself on every session start
  register();                              // in case pi-mention loaded first
}
```

`describe` returns one metadata line (the agent fetches content with its own tools). Registration is idempotent per `id`; `session`, `file`, `http`, `https` are reserved. Observers can listen to `mention:swarm:message` for incoming peer envelopes.

## Limits

- omp ≥ 19 autocomplete has no `→` drill-down; use `@session:` / `#` instead.
- Peer discovery is per machine (and per `PI_MENTION_HOME`).
