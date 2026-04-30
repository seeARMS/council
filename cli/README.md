# council

`council` is a small, open-source CLI that asks multiple AI coding CLIs the same question and then synthesizes their answers into one final response.

Today it supports:

- `codex`
- `claude`
- `gemini`

If one of them is not installed, `council` skips it and keeps going.

## Why this exists

Agent CLIs are useful, but each one has different strengths, safety controls, and output conventions. `council` gives you one wrapper that:

- fans out a prompt to several tools in parallel
- keeps the primary interaction read-only by default
- synthesizes the responses with one final model
- supports human-friendly interactive output and automation-friendly headless output

## Install

Run it directly with `npx`:

```bash
npx @armstrng/council "How should I structure this TypeScript CLI?"
```

That matches the website examples and does not require a global install.

## Quick start

Ask all available tools and show the full council:

```bash
npx @armstrng/council "How should I structure this TypeScript CLI?"
```

Ask only a subset:

```bash
npx @armstrng/council --no-gemini "Review this migration plan"
```

Pick a specific summarizer:

```bash
npx @armstrng/council --summarizer claude "Compare these two designs"
```

Run against another project directory:

```bash
npx @armstrng/council --cwd ../my-repo "Review the current architecture"
```

## Output modes

Interactive human output:

```bash
npx @armstrng/council "What is the cleanest implementation?"
```

Summary-only output:

```bash
npx @armstrng/council --summary-only "What should we do?"
```

Structured JSON:

```bash
npx @armstrng/council --json "Explain the bug" | jq
```

Streaming JSONL events for automation:

```bash
npx @armstrng/council --json-stream "Compare these approaches"
```

Headless automation mode:

```bash
npx @armstrng/council --headless "Summarize the tradeoffs"
```

`--headless` suppresses the banner and progress UI and defaults to summary-only text unless you also request `--json` or `--json-stream`.

## Interactive terminal behavior

In a real TTY, `council` uses a live dashboard:

- each member row updates in place instead of appending new lines
- running members show a live seconds counter
- completed members show a 2-line preview of their result
- press the number shown next to a row to expand or collapse the full result
- just start typing to ask a follow-up in the same session
- press `q` or `Esc` to exit the interactive view

## Tool selection

Enable or disable members individually:

```bash
npx @armstrng/council --codex --claude --no-gemini "Review this plan"
```

Or use an explicit member list:

```bash
npx @armstrng/council --members codex,gemini "Compare these responses"
```

`--members` preserves the order you pass. If you later re-enable another member with a toggle such as `--claude`, it is appended after that explicit list.

## Safe defaults

`council` intentionally runs the upstream tools in consultation-oriented modes:

- `codex`: `codex exec --skip-git-repo-check --sandbox read-only --ephemeral`
- `claude`: `claude --bare -p --permission-mode plan --output-format json --no-session-persistence`
- `gemini`: `gemini -p "" --skip-trust --approval-mode plan --output-format json`

That keeps the default behavior closer to analysis than autonomous mutation.

## Exit codes

- `0`: at least one member responded and synthesis succeeded
- `2`: usage error
- `3`: no member produced a response
- `4`: synthesis failed after at least one member responded

## Environment variables

- `COUNCIL_CODEX_BIN`: override the `codex` executable path
- `COUNCIL_CLAUDE_BIN`: override the `claude` executable path
- `COUNCIL_GEMINI_BIN`: override the `gemini` executable path

## Programmatic use

The package also exports a small JS API:

```js
import { runCouncil } from '@armstrng/council';

const result = await runCouncil({
  query: 'Compare these two implementation strategies'
});
```

The package ships `d.ts` declarations for this API.

## Development

Run the tests:

```bash
npm test
```

The suite uses fake `codex`, `claude`, and `gemini` binaries, so it does not require real vendor CLIs or credentials.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
