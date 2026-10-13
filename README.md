# pi-session-mention

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that turns `@` into a layered picker for **files, project sessions and all sessions**, and attaches what you mention as lightweight *metadata* the agent can follow up on.

## Install

```sh
pi install git:github.com/jack1582/pi-session-mention
```

## Picker

Type `@` at the start of a word (in interactive/TUI mode) and a picker opens below the editor:

```
 @ [Files]  Project sessions   All sessions   (tab)
 ~/my-project  type to filter
 ❯ src/ ›  dir
   README.md
 ↑↓ move  ·  → open  ·  ← back  ·  ↩ select  ·  tab type  ·  esc cancel
```

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` | cycle type: **Files** (cwd) → **Project sessions** → **All sessions** |
| `↑` `↓` (`PgUp` `PgDn`) | move focus |
| `→` | go one level down (directory · project · session → turns) |
| `←` | go one level up |
| `↩` | insert the focused item |
| typing | fuzzy-filter the current level (Files: searches recursively) |
| `Esc` / `Backspace` on empty filter / `Space` | close, keep a literal `@` |

Levels:

- **Files**: directories → files. Inserts `@path/to/file` (or `@"path with spaces"`); directories can be mentioned too.
- **Project sessions**: sessions of the current cwd → their turns.
- **All sessions**: projects → sessions → turns. Typing at the project level searches all sessions at once.

Sessions insert `@session:<id8>`; a single turn inserts `@session:<id8>#<turn>`.

## Multiple mentions, small context

A prompt can contain any number of mentions. On submit, the extension does **not** paste contents into the prompt. It attaches one short `<mentions>` message with metadata per item:

- file: absolute path, size, line count, first non-empty line
- directory: entry count and the first few names
- session / turn: title, project, turn count, last activity, file path, and the user request of that turn

The agent is instructed to read the real content itself when relevant: files with its normal tools, sessions with the bundled **`read_session`** tool:

- `read_session({ session: "1a2b3c4d" })` → outline (one line per turn + latest compaction summary)
- `read_session({ session: "1a2b3c4d", turns: "3-5", maxChars: 20000 })` → those turns (user, assistant text, tool calls, truncated tool results), paginated by a character budget

This keeps long files and transcripts out of the context until the agent actually needs them.
