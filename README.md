# pi-session-mention

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that lets you `@`-mention a historical session and attach it to the current session as reference material.

## What it does

- While typing `@` in the prompt, the completion list includes your **recent pi sessions** (alongside the built-in file completions).
- Each session item shows its first user message and how long ago it was active.
- When you submit a prompt containing a session mention (e.g. `@2026-10-12T…jsonl`), the extension reads that session's transcript, renders it as readable Markdown (user/assistant turns, truncated to a size cap), and injects it into the prompt as a fenced reference block.

## Install

```sh
pi install git:github.com/jack1582/pi-session-mention
```

## Usage

1. Type `@` and keep typing to fuzzy-filter; your past sessions appear under their first user message (labeled `session:`).
2. Select one — a `@<session-file-name>` token is inserted into the prompt.
3. Add your actual question, e.g. `@2026-10-12T14-27-42…jsonl 总结上次讨论的接口文档要点`.
4. On submit, the extension replaces the token with the session transcript (capped, oldest turns elided) so the model can use it as context.

Only sessions belonging to the current working directory are listed (same scope pi itself uses).
