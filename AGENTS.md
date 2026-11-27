# AGENTS.md

Guidance for agents working on `pi-mention`, a [pi](https://github.com/earendil-works/pi-coding-agent) extension that turns `@` into a layered picker for files, project sessions and all sessions.

## ⚠️ Rule 1 — every write action must update this file

**Any write action in this repository must be followed by an update to `AGENTS.md`, in the same change.**

A "write action" means anything that changes repository state, not just source edits:

- creating, editing, renaming or deleting any file (`extensions/mention.ts`, `README.md`, `package.json`, `tsconfig.json`, workflow files, this file)
- changing `package.json` metadata, dependencies, `files`, `version`
- changing the CI/release workflow under `.github/workflows/`
- committing, tagging, publishing, unpublishing, force-pushing
- changing the npm trusted-publisher configuration (record it here, since it lives outside the repo)

Do this *before* you report the task as done. The update must land in the **same commit** as the change when you are committing, so that history stays coherent: a commit that touches the code without touching `AGENTS.md` is an incomplete change.

What to update:

1. **`## Change log`** below — append one line: date, what changed, why. Never rewrite or delete older entries; the log is append-only history.
2. **Any section that went stale** — if you changed the release flow, the file layout, the tool surface, the versioning policy or the known pitfalls, fix that section too. A changelog entry alone is not enough.

If a change genuinely needs no doc update beyond the log, still add the log line.

## Project layout

```
extensions/mention.ts         # entry only: host detection, wiring, <mentions> middleware, renderer, read_session tool
src/util.ts text.ts           # helpers; text.ts = ANSI-aware width/truncate + `rows()` (host-neutral renderer object)
src/sessions.ts               # SessionManager list/listAll normalised (pi vs omp SessionInfo), JSONL transcript parser
src/mentions.ts               # token regex, describeFile/Session/provider, collectMentions, leadingSessionToken
src/providers.ts api.ts       # `@scheme:` provider registry + public types, wired to pi.events
src/swarm/protocol.ts         # envelope/ack/peer record types, validation, limits (MAX_TEXT, PI_MENTION_MAX_HOPS)
src/swarm/transport.ts        # peer registry files + per-session Unix socket server/client (owner-only perms)
src/swarm/index.ts            # swarm wiring: tools, /swarm, /tell, `input` leading-mention, delivery, auto-reply
src/picker/autocomplete.ts    # omp >= 19: stacked autocomplete provider (no pi-tui)
src/picker/legacy.ts          # pi / omp <= 18: layered CustomEditor picker (imports pi-tui!)
src/picker/deps.ts fuzzy.ts   # shared picker deps, fuzzy ranking
README.md                     # user-facing docs; kept in the npm tarball
package.json                  # name/version/files(extensions, src, README)/main + pi.extensions + omp.extensions manifests
tsconfig.json                 # strict, noEmit, moduleResolution bundler, include: extensions/**/*.ts + src/**/*.ts
.github/workflows/publish.yml # tag-triggered release via npm OIDC trusted publishing
```

There is no build step. `main` and the `pi`/`omp` `extensions` manifests point straight at the TypeScript source (`extensions/mention.ts`); `files` ships `extensions`, `src` and `README.md`. Helpers live in `src/` (not `extensions/`) so pi's directory auto-discovery never treats them as extensions. Do not introduce a bundler or `dist/` without a deliberate decision recorded here.

## Host compatibility rules (read before touching imports)

- **omp ≥ 19 refuses to load any module graph that reaches `@earendil-works/pi-tui`** — and its graph walker also sees literal `import()` specifiers. Only `src/picker/legacy.ts` may import pi-tui, and `extensions/mention.ts` reaches it through a *computed* path (`LEGACY_PICKER`) behind a `setEditorComponent` capability check. Never add a static or literal import of pi-tui or legacy.ts anywhere else.
- Choose behaviour by **capability, not version**: `ctx.ui.composer` + `addAutocompleteProvider` → autocomplete adapter; else `setEditorComponent` → legacy picker; else no picker. Older pi has no `ctx.mode`, so never require `ctx.mode === "tui"`.
- Event shapes differ: pi `input` returns `{ action }`, omp `{ handled }` (we return both); pi `before_agent_start` has `messageType`/no `prompt` for custom messages, omp has `reason` (skip `"revive"`); omp still emits `session_switch`.
- `SessionInfo` differs (pi `name`/`Date`, omp `title`/ISO string): always go through `src/sessions.ts` `normalize`. Never open other sessions with `SessionManager.open` (ownership leases); parse the JSONL.
- Message renderers return `rows()` objects (`{ render, invalidate }`), valid on both TUIs; do not use `Text`.
- omp subagents/clones rebind extensions: swarm registers only `kind === "main"` sessions (pi has no `ctx.agent`).

## Public surface (do not break casually)

- **Default export** `mention(pi: ExtensionAPI)` — registers `session_start`, `before_agent_start`, message renderers, `read_session`, and (via `createSwarm`) `session_peers`, `session_send`, `/swarm`, `/tell`, `input`, `agent_start/agent_end`.
- **`read_session` tool signature** — `{ session: string, turns?: string, maxChars?: number }`; no `turns` returns an outline, `turns: "3" | "2-5" | "7-"` returns those turns paginated by a character budget (`maxChars`, default 30000, floor 2000).
- **`session_send` / `session_peers`** — `session_send({ to, message, reply? })` (`to`: id8, unique title fragment or `"all"`; `reply` default true); `session_peers()` lists live peers.
- **Mention tokens** — `@path/to/file`, `@"path with spaces"`, `@session:<id8>`, `@session:<id8>#<turn>`, `@<scheme>:<ref>` / `@<scheme>:"<ref>"` for providers.
- **Provider API** (`src/api.ts`, events on `pi.events`): `mention:register` (a `MentionProvider`), `mention:unregister` (id), `mention:ready` (emitted by us each `session_start`), plus observer event `mention:swarm:message`. Reserved ids: `session`, `file`, `http`, `https`.
- **Swarm wire protocol** (`PROTOCOL_VERSION` 1): newline-delimited JSON, request `Envelope` → `Ack`; registry `~/.pi-mention/swarm/<id8>.json` + `<id8>.sock` (`PI_MENTION_HOME` overrides). A breaking change needs a version bump so old and new sessions refuse each other cleanly.
- **Custom message types**: `mention` (`<mentions>` metadata, never inlined content), `mention-swarm` (incoming peer message), `mention-swarm-sent` (record of what we sent).
- **Swarm loop guards** (hop counter, human-input reset, rate limits, dedupe) are part of the contract; do not remove them without replacing them.

Behavioural contract worth preserving when editing the trigger logic: `@` fires at the start, mid-sentence, on any line, right after CJK text or an opening bracket, but an `@` glued to an ASCII word (`me@host.com`) stays literal. A *leading* `@session:<live id8> text` is a direct message to that peer; anywhere else it is only a reference.

## Checks before committing

```sh
npm run check   # tsc --noEmit, must be clean
```

There is no test suite. Manual verification means loading the extension in **both** hosts and exercising what you touched:

- omp ≥ 19 swarm/mentions (no model needed to see registration): two `omp --mode rpc --no-session -e extensions/mention.ts --cwd /tmp/a|b` processes sharing `PI_MENTION_HOME=/tmp/x`; two records must appear, then send `{"type":"prompt","message":"/tell <b-id8> reply PONG"}` to A and look for the `mention-swarm` messages in both logs.
- omp ≥ 19 autocomplete / pi legacy picker: drive the TUI under a pty (Python `pty.fork`; **set the window size with `TIOCSWINSZ`**, pi renders nothing at 0×0) and read the screen after typing `@`.
- `PI_MENTION_HOME` isolates the registry so tests never see (or message) your real sessions.
- If you touched `read_session`, verify both the outline and a ranged read.

## Release process

Releases are published from CI, not from a laptop. The workflow runs on any `v*` tag push (or manual dispatch) and authenticates with **npm OIDC trusted publishing** — there is no `NPM_TOKEN` secret and none should be added.

1. Make the change, update this file, commit.
2. Bump the version in `package.json` (`npm version patch|minor|major --no-git-tag-version`).
3. Commit, then tag and push:
   ```sh
   git commit -am "chore: release vX.Y.Z"
   git tag vX.Y.Z
   git push origin HEAD --tags
   ```
4. Watch the run: `gh run list --limit 3` / `gh run view <id> --log`.
5. Verify the published artifact, not just the green check (see below).

### OIDC constraints

The workflow depends on these invariants — changing them re-breaks publishing:

- `permissions: id-token: write` must stay.
- `setup-node` with `registry-url` writes `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into the temporary `.npmrc`. Since no such secret exists, the value degrades to a literal placeholder and npm 404s on publish. The `Configure npm for OIDC` step deletes that key so npm falls back to the OIDC id-token. **Do not remove that step** unless you switch to a real token, and do not "simplify" it away.
- npm-side trusted publisher config (not in the repo, currently matching): repository `jack1582/pi-mention`, workflow filename `publish.yml`, environment empty.

### Verifying a release

A green Actions run plus npm metadata is **not** proof the artifact is installable. The registry replicates metadata and tarball blobs on different schedules, so a fresh version can report `200` on `/pi-mention/<version>` while its `.tgz` still `404`s for a few minutes. Confirm all of:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/pi-mention/-/pi-mention-<version>.tgz   # want 200
npm view pi-mention version dist-tags --registry=https://registry.npmjs.org/                               # want <version> + latest
cd /tmp && rm -rf verify && mkdir verify && cd verify && npm init -y >/dev/null
npm install pi-mention@<version> --registry=https://registry.npmjs.org/ --no-audit --no-fund                # want clean install
```

Then diff the installed `extensions/mention.ts` against the local one (`md5`/`md5sum`) to prove the intended code actually shipped.

## Known pitfalls

- **The local `~/.npmrc` points at a mirror** (`registry=https://mirrors.tencent.com/npm/`). Any bare `npm view` / `npm install` reads stale mirror data and will make a failed publish look successful or a successful one look missing. Always pass `--registry=https://registry.npmjs.org/` when checking release state. `cdn.npmmirror.com` lags further behind and is not a usable oracle.
- **`404` from npm on publish is ambiguous** — npm returns it both for "no such package" and "you lack permission", so it says nothing on its own about which side failed.
- **A green job with provenance signed is not a publish success on its own.** Look for the `+ pi-mention@X.Y.Z` line in the log *and* verify the tarball as above.
- **Re-tagging after a workflow fix**: a `v*` tag that pointed at a broken workflow stays broken. Delete and recreate it, do not reuse the old commit:
  ```sh
  git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z && git tag vX.Y.Z && git push origin vX.Y.Z
  ```
- **`.DS_Store` is present and untracked-but-not-ignored** — `.gitignore` only covers `node_modules/`. Do not commit it.
- The pickers only install in the interactive UI (`ctx.hasUI`, `ctx.mode` absent or `"tui"`); no effect in print/rpc by design. The swarm, tools and `<mentions>` work in every mode, including `--mode rpc`.
- `src/picker/autocomplete.ts` targets omp's autocomplete provider contract (`getSuggestions(lines,line,col,opts,signal) → {items,prefix}`, `applyCompletion`), which was observed on omp 19.2.1 through a logging Proxy, not from published types; re-probe after omp upgrades.

## Change log

Append-only. One line per write action: `YYYY-MM-DD — what — why`.

- 2026-10-30 — created `AGENTS.md` — record the release/OIDC flow and the verification pitfalls after the 0.1.1 publish scare, and establish the mandatory doc-update rule.
- 2026-10-30 — released `v0.1.1` (commit `074a4dd`, tag re-pointed to `81517bc` after fixing CI) — ships the "trigger `@` anywhere in the prompt" work that landed after `0.1.0`; first successful OIDC trusted publishing run (`40991004127`).
- 2026-11-27 — omp support + swarm: split the single file into `src/`, added the omp ≥ 19 autocomplete adapter (pi-tui import isolated behind a computed dynamic import because omp refuses to load pi-tui), dual-host event shapes, `SessionInfo` normalisation, `@scheme:` provider API over `pi.events`, and the swarm (peer registry + Unix sockets, `session_send`/`session_peers`, `/swarm`, `/tell`, leading-mention addressing, auto-returned answers, hop/rate/dedupe loop guards); updated README, manifest (`pi`/`omp` extension keys, ships `src`), tsconfig; verified with tsc, a transport script, two-process omp RPC runs, and pty runs of omp 19 and pi 0.74.2. Not released/version-bumped.
