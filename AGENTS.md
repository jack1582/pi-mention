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
extensions/mention.ts        # the whole extension: picker editor + <mentions> middleware + read_session tool
README.md                    # user-facing docs; kept in the npm tarball
package.json                 # name/version/files/main/peerDependencies, "check" script
tsconfig.json                # strict, noEmit, moduleResolution bundler, include: extensions/**/*.ts
.github/workflows/publish.yml # tag-triggered release via npm OIDC trusted publishing
```

There is no build step. `main` points straight at the TypeScript source (`extensions/mention.ts`) and pi loads it directly; `files` ships only `extensions` + `README.md`. Do not introduce a bundler or `dist/` without a deliberate decision recorded here.

## Public surface (do not break casually)

- **Default export** `mention(pi: ExtensionAPI)` — registered on `session_start` (TUI only), `before_agent_start`, a message renderer, and the `read_session` tool.
- **`read_session` tool signature** — `{ session: string, turns?: string, maxChars?: number }`; no `turns` returns an outline, `turns: "3" | "2-5" | "7-"` returns those turns paginated by a character budget (`maxChars`, default 30000, floor 2000).
- **Mention tokens** — `@path/to/file`, `@"path with spaces"`, `@session:<id8>`, `@session:<id8>#<turn>`.
- **`<mentions>` custom message** (`CUSTOM_TYPE`) — metadata only, deliberately never inlined content, to keep context small.

Behavioural contract worth preserving when editing the trigger logic: `@` fires at the start, mid-sentence, on any line, right after CJK text or an opening bracket, but an `@` glued to an ASCII word (`me@host.com`) stays literal.

## Checks before committing

```sh
npm run check   # tsc --noEmit, must be clean
```

There is no test suite. Manual verification means loading the extension in pi and exercising the picker; if you touched `read_session`, verify both the outline and a ranged read.

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
- The extension only installs the custom editor when `ctx.mode === "tui" && ctx.hasUI`; changes to the picker have no effect in non-TUI modes by design.

## Change log

Append-only. One line per write action: `YYYY-MM-DD — what — why`.

- 2026-10-30 — created `AGENTS.md` — record the release/OIDC flow and the verification pitfalls after the 0.1.1 publish scare, and establish the mandatory doc-update rule.
- 2026-10-30 — released `v0.1.1` (commit `074a4dd`, tag re-pointed to `81517bc` after fixing CI) — ships the "trigger `@` anywhere in the prompt" work that landed after `0.1.0`; first successful OIDC trusted publishing run (`40991004127`).
