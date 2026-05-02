# council

`council` is a tiny CLI that asks multiple coding CLIs the same question and then synthesizes their answers into one final response.

Today it supports:

- `codex`
- `claude`
- `gemini`

If one of them is not installed, `council` skips it and keeps going.

## Prerequisites

- Node `>=22`
- At least one of `codex`, `claude`, or `gemini` installed locally
- At least one installed CLI already authenticated in a normal terminal session

If every configured CLI is missing or unauthenticated, `council` can still run but it will return a failure result rather than a synthesized answer.

## Why this exists

Agent CLIs are useful, but each one has different strengths, safety controls, and output conventions. `council` gives you one wrapper that:

- fans out a prompt to several tools in parallel
- keeps the primary interaction read-only by default
- synthesizes the responses with one final model
- supports human-friendly interactive output and automation-friendly headless output

## Install

Install globally to get a `council` command on your `PATH`:

```bash
npm install -g @armstrng/council
council "How should I structure this TypeScript CLI?"
```

Or run it directly without installing via npx:

```bash
npx @armstrng/council "How should I structure this TypeScript CLI?"
```

The rest of this README uses the bare `council` command. If you prefer not to install globally, swap any example for `npx @armstrng/council`.

If you are developing from a git checkout instead of using the published npm package:

```bash
npm install
npm run build
./bin/council.js "How should I structure this TypeScript CLI?"
```

## Quick start

Ask all available tools and show the full council:

```bash
council "How should I structure this TypeScript CLI?"
```

Ask only a subset:

```bash
council --no-gemini "Review this migration plan"
```

Pick a specific summarizer:

```bash
council --summarizer claude "Compare these two designs"
```

Run against another project directory:

```bash
council --cwd ../my-repo "Review the current architecture"
```

## Output modes

Interactive human output:

```bash
council "What is the cleanest implementation?"
```

Summary-only output:

```bash
council --summary-only "What should we do?"
```

Structured JSON:

```bash
council --json "Explain the bug" | jq
```

Streaming JSONL events for automation:

```bash
council --json-stream "Compare these approaches"
```

Headless automation mode:

```bash
council --headless "Summarize the tradeoffs"
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
council --codex --claude --no-gemini "Review this plan"
```

Or use an explicit member list:

```bash
council --members codex,gemini "Compare these responses"
```

`--members` preserves the order you pass. If you later re-enable another member with a toggle such as `--claude`, it is appended after that explicit list.

## Model and effort selection

Use provider-specific flags when each upstream CLI should run a different model or reasoning level:

```bash
council \
  --codex-model gpt-5.2 --codex-effort high \
  --claude-model opus --claude-effort max \
  --gemini-model gemini-3-pro-preview --gemini-effort high \
  "Review this plan"
```

`--effort low|medium|high` remains available as a common default for all members. Provider-specific effort flags override the common value for that provider.

## Safe defaults

`council` intentionally runs the upstream tools in consultation-oriented modes:

- `codex`: `codex exec --skip-git-repo-check --sandbox read-only --ephemeral`
- `claude`: `claude -p --permission-mode plan --verbose --output-format stream-json --include-partial-messages --no-session-persistence`
- `gemini`: `gemini -p "" --skip-trust --approval-mode plan --output-format json`

For Claude, Council keeps `--bare` only when `ANTHROPIC_API_KEY` is set and `CLAUDE_CODE_OAUTH_TOKEN` is not set. OAuth-token auth and normal logged-in Claude Code auth omit `--bare` because Claude Code bare mode does not read OAuth or keychain credentials. The rest of the non-interactive plan-mode Claude invocation is preserved.

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
- `CLAUDE_CODE_OAUTH_TOKEN`: enables Claude Code OAuth-token auth and disables Claude's incompatible `--bare` mode
- `CLAUDE_CODE_EFFORT_LEVEL`: used as Claude's `--effort` value when no Council effort flag is provided for Claude

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

Build the distributable JS output:

```bash
npm run build
```

Run the TypeScript check:

```bash
npm run typecheck
```

The suite uses fake `codex`, `claude`, and `gemini` binaries, so it does not require real vendor CLIs or credentials.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Releases

`@armstrng/council` releases are automated with `release-please`. The release workflow watches commits merged to `main`, updates [`CHANGELOG.md`](./CHANGELOG.md), bumps [`package.json`](./package.json), creates the GitHub release tag, and publishes the package from GitHub Actions.

Before the first automated publish, configure npm trusted publishing for the `seeARMS/council` repository and the `.github/workflows/release-please.yml` workflow.
