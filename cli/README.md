# council

> Native CLI migration: Council is moving from this legacy TypeScript/npm package to the Rust crate in [`../crates/council`](../crates/council). New CLI development and CI should target Cargo; this package remains as a reference until full feature parity is retired or archived.

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
- can promote one model to planner, another to lead, and pass handoffs between executor members
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

Run a coordinated workflow with a planner, lead, two iterations, and handoffs:

```bash
council \
  --planner codex \
  --lead claude \
  --handoff \
  --iterations 2 \
  "Plan and implement this change"
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

Interactive workbench:

```bash
council --studio "What is the cleanest implementation?"
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
- press `Ctrl-C` twice to close from the keyboard interrupt path

For a fuller terminal app, use `--studio`. Studio mode opens focusable panes for the command menu, workflow settings, agents, provider capabilities, Linear, results/canvas, help, and prompt. You can move focus with `Tab`, change settings with the arrow keys, toggle providers in the agents pane, mark lead/planner roles, select auth mode per provider, choose whether each provider inherits or overrides Skills/MCP/Tools config, resize the provider teams, configure Linear mode/auth/workspace/retry settings, reorder panes with `[` and `]`, edit the prompt, and run or re-run from inside the UI. The command palette includes actions to launch provider social login, check Linear setup/status, deliver Linear work, edit Linear issue/query/team/state/media fields, tag local files, run shell commands into the prompt context, and open Help. `?` toggles help from anywhere.

## Prompt context, files, and commands

Tag local files into the prompt without pasting them manually:

```bash
council \
  --file README.md \
  --file cli/package.json \
  "Review this package setup"
```

Run command-line tools before the council starts and include their output in the prompt:

```bash
council \
  --cmd "git status --short" \
  --cmd "npm test -- --test-reporter=dot" \
  "Use the repo state and test output to suggest the next patch"
```

`--file`/`--tag-file` and `--cmd`/`--prompt-command` are repeatable. In Studio mode, use the command palette to tag files or run commands while the Node process stays open; the prompt panel shows the active context. Council also streams command progress and provider tool usage so you can see shell commands being executed by prompt context and by upstream providers.

Member rows include token usage as `tok:<n>` and tool usage as `tools:<n>` when available. Provider-reported token usage is used when the upstream CLI exposes it; otherwise Council shows a conservative estimate marked with `~`. In Studio mode, the Canvas pane also has a Telemetry section that lists token totals, input/output split, current progress, and tool/command counts per provider and synthesis agent.

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

## Workflow design

By default, Council still asks every enabled member in parallel and then synthesizes once. The workflow flags turn that into a more structured terminal workbench:

```bash
council \
  --members codex,claude,gemini \
  --planner codex \
  --lead claude \
  --handoff \
  --iterations 3 \
  --team-work 2 \
  "Investigate the flaky test and propose a patch"
```

- `--planner <codex|claude|gemini>` runs that member first and passes its plan to the remaining executor members.
- `--lead <codex|claude|gemini>` marks the lead member and makes it the first auto-synthesis candidate when it succeeds.
- `--handoff` runs members in order and passes earlier member outputs to later members.
- `--iterations <n>` repeats the consultation loop `n` times for the same prompt, feeding the previous round into the next.
- `--team-work <n>` tells each provider it may coordinate up to `n` internal sub-agents or subtasks inside its own CLI.

Use provider-specific team overrides when one model should fan out more or less than the others:

```bash
council \
  --team-work 1 \
  --codex-sub-agents 3 \
  --claude-sub-agents 2 \
  "Review this refactor"
```

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

## Permission selection

Council defaults to read-only consultation modes. Use provider-specific permission flags when a member needs broader local access:

```bash
council \
  --codex-sandbox workspace-write \
  --claude-permission-mode acceptEdits \
  "Review and patch this issue"
```

Codex sandbox modes are `read-only`, `workspace-write`, and `danger-full-access`. Claude permission modes are passed through to Claude Code as `--permission-mode` and may be `plan`, `default`, `acceptEdits`, `auto`, `dontAsk`, or `bypassPermissions`.

## Auth selection

Use provider-specific auth preferences when you want Council or Studio mode to avoid guessing from the current environment:

```bash
council \
  --codex-auth social-login \
  --claude-auth oauth \
  --gemini-auth social-login \
  "Review this plan"
```

Codex auth preferences are `auto`, `social-login`, `login`, and `api-key`. Claude auth preferences are `auto`, `social-login`, `oauth`, `api-key`, and `keychain`; `api-key` forces Claude `--bare`, while `social-login`, `oauth`, and `keychain` omit `--bare`. Gemini auth preferences are `auto`, `social-login`, `login`, and `api-key`. Studio exposes these settings directly in the Settings pane so you can change them before each run.

To authenticate the provider CLIs before a run, use `--auth-login`. Council launches each selected provider's native social-login flow, lets the provider open browser tabs for local deeplinks, opens detected auth URLs when they are printed, and keeps terminal input connected so paste-back codes work:

```bash
council \
  --auth-login \
  --auth-login-providers codex,claude,gemini \
  --codex-auth social-login \
  --claude-auth social-login \
  --gemini-auth social-login \
  "Review this plan"
```

`--auth-login-providers` defaults to members configured for `social-login`, then all enabled members. `--auth-device-code` asks Codex to use its device-code paste flow where available. Claude uses `claude auth login`; Gemini uses Gemini CLI's native interactive auth selector because current Gemini CLI releases open "Login with Google" from the normal interactive entrypoint rather than a dedicated `auth login` subcommand. In Studio, choose Social login from the command menu; it runs the same provider flows while preserving code paste and browser deeplink callbacks.

## Provider capabilities, Skills, MCP, and tools

Council inherits each upstream provider's normal config by default. That means Codex, Claude, and Gemini can still use the Skills, MCP servers, extensions, hooks, and tool settings already configured in those CLIs, subject to the selected sandbox or permission mode.

Use provider capability overrides when a run needs a specific config/profile/tool allowlist without changing your global provider setup:

```bash
council \
  --codex-capabilities override \
  --codex-config tools.web_search=true \
  --codex-mcp-profile repo \
  --claude-capabilities override \
  --claude-mcp-config .mcp.json \
  --claude-allowed-tools "Read,Bash(git:*)" \
  --claude-disallowed-tools Write \
  --gemini-capabilities override \
  --gemini-settings .gemini/settings.json \
  --gemini-tools-profile repo-tools \
  "Review this change with the repo tool profile"
```

Passing `--codex-config`, `--codex-mcp-profile`, `--claude-mcp-config`, `--claude-allowed-tools`, `--claude-disallowed-tools`, `--gemini-settings`, or `--gemini-tools-profile` automatically switches that provider to `override` unless you explicitly set `<provider>-capabilities inherit`. In inherit mode, Council keeps the values visible in configuration but does not pass them to the provider.

Provider mapping:

- Codex: `--codex-config` becomes repeatable Codex `-c <key=value>` overrides. `--codex-mcp-profile` becomes Codex `--profile <name>`.
- Claude: `--claude-mcp-config` maps to Claude `--mcp-config`; `--claude-allowed-tools` and `--claude-disallowed-tools` map to Claude's tool allow/deny options.
- Gemini: `--gemini-settings` sets `GEMINI_CLI_SYSTEM_SETTINGS_PATH` for the run, and still merges with `--gemini-effort` thinking-budget settings when effort is selected. `--gemini-tools-profile` maps to Gemini CLI `--extensions`.

In Studio, use the Capabilities pane to toggle `inherit`/`override` per provider and edit Codex config/profile, Claude MCP/tool lists, and Gemini settings/tool profiles without restarting Node. The Settings pane also includes quick capability-mode rows.

## Linear setup and delivery

Council can connect to Linear with either a personal API key or an OAuth token. Check setup and local state without running any task:

```bash
council --linear-setup
council --linear-status
```

Set `LINEAR_API_KEY` for API-key auth, or set `LINEAR_OAUTH_TOKEN` and pass `--linear-auth oauth`. Linear status reports whether auth is configured, the authenticated viewer when available, the persistent state file, the per-issue workspace root, and the JSONL observability log.

In Studio mode, Linear is managed from the Settings, Linear, and Command Palette panes:

- Settings: cycle `Linear mode` (`off`, `deliver`, `watch`), `Linear loop`, `Linear gate`, `Linear auth` (`api-key`, `oauth`), workspace strategy, issue limit, concurrency, and retry attempts.
- Linear pane: press `Enter` while focused to refresh setup/status, viewer, state counts, workspace root, and observability log.
- Command Palette: use `Linear status`, `Deliver Linear`, `Set Linear issue`, `Set Linear query`, `Set Linear project`, `Set Linear epic`, `Set Linear team`, `Set Linear state`, and `Attach Linear media` without restarting Node.
- In a real TTY, `--studio --linear-status`, `--studio --deliver-linear`, and the other Linear flags pre-populate those Studio controls instead of bypassing the TUI.

Council can fetch Linear work and run each issue through delivery phases:

```bash
council \
  --deliver-linear \
  --linear-issue ENG-123 \
  --planner codex \
  --lead claude \
  --team-work 2 \
  "Keep the patch small and open a PR when tests pass"
```

If you do not pass explicit issue IDs, use `--linear-query`, `--linear-project`, `--linear-epic`, `--linear-team`, `--linear-state`, `--linear-assignee`, and `--linear-limit` to fetch candidate tasks. `--linear-project` matches Linear project id/name/slug values. `--linear-epic` matches the parent epic issue id/key/title. Delivery phases default to `plan,implement,verify,ship`; override with `--delivery-phases`.

Each Linear issue is normalized into a task prompt. Council then runs phase-specific prompts:

- `plan`: produce a concrete implementation and validation plan.
- `implement`: make the scoped code changes.
- `verify`: run tests, typechecks, builds, linters, or targeted checks and fix in-scope failures.
- `ship`: inspect git state, scan for secrets, commit, push, open or update a GitHub PR, and leave Linear/GitHub-ready proof of work.

For Symphony-style operation, run Council as a long-running Linear worker:

```bash
council \
  --deliver-linear \
  --linear-watch \
  --linear-until-complete \
  --linear-project "Migration Project" \
  --linear-epic ENG-1 \
  --linear-team ENG \
  --linear-state Todo \
  --linear-completion-gate review-or-ci \
  --linear-poll-interval 60 \
  --linear-max-concurrency 2 \
  --linear-workspace-strategy worktree \
  --planner codex \
  --lead claude \
  --handoff \
  --team-work 2 \
  "Deliver each eligible Linear issue end to end"
```

Long-running Linear mode includes:

- polling: `--linear-watch` keeps fetching eligible issues until interrupted; `--linear-max-polls` bounds a run for CI or testing.
- target completion: `--linear-until-complete` keeps watch mode alive until the current target has no unfinished work. It is meant to be paired with `--linear-project`, `--linear-epic`, explicit issue IDs, or other Linear filters. Council scans every matching Linear page for completion, while `--linear-limit` remains the per-poll dispatch batch size.
- completion gates: `--linear-completion-gate delivered` preserves the old behavior of completing after all phases pass. `human-review` requires PR/branch evidence or a matching `--linear-review-state`. `ci-success` waits for `gh pr checks` to pass. `review-or-ci` accepts either human-review readiness or passing GitHub checks.
- isolated workspaces: each issue gets a workspace under `.council/linear-workspaces` by default. `worktree` creates a Git worktree and falls back to `copy`; `copy` clones the files without `.git`, `.council`, `node_modules`, or `dist`; `none` keeps the current `--cwd`.
- retry and reconciliation: Council persists `.council/linear-delivery-state.json`, tracks attempts, schedules exponential backoff, skips delivered/review-ready/CI-passed/running issues, and marks watched issues ineligible when they stop matching the current Linear query. With `--linear-until-complete`, attempts are unlimited unless you explicitly pass `--linear-max-attempts`.
- observability: every delivery event is appended as JSONL to `.council/linear-observability/events.jsonl`; `--json-stream` also streams lifecycle events to stdout.
- workflow policy: if `WORKFLOW.md` exists, Council includes it in each phase prompt; override with `--linear-workflow-file`.

Use `--linear-state-file`, `--linear-workspace-root`, and `--linear-observability-dir` to relocate the state, workspace, and event-log paths.

For CI-gated delivery, Council uses the GitHub CLI from the issue workspace. `--linear-ci-timeout` controls how long `ci-success` waits for checks, and `--linear-ci-poll-interval` controls the check polling interval.

Attach media back to Linear after a task is delivered:

```bash
council \
  --deliver-linear \
  --linear-issue ENG-123 \
  --linear-attach-media proof.png \
  --linear-attach-media https://example.com/demo.mp4 \
  --linear-attachment-title "Council proof" \
  "Deliver the issue and attach the proof artifacts"
```

Local files are uploaded to Linear storage first, then attached to the issue as Linear resources. Remote `http`/`https` URLs are attached directly. This is useful when a provider creates screenshots, videos, diagrams, or other proof files in the issue workspace during implementation or verification.

## Safe defaults

`council` intentionally runs the upstream tools in consultation-oriented modes:

- `codex`: `codex exec --skip-git-repo-check --sandbox read-only --ephemeral`
- `claude`: `claude -p --permission-mode plan --verbose --output-format stream-json --include-partial-messages --no-session-persistence`
- `gemini`: `gemini -p "" --skip-trust --approval-mode plan --output-format json`

For Claude, Council keeps `--bare` only when `ANTHROPIC_API_KEY` is set and OAuth/social/keychain auth is not selected or detected. OAuth-token auth, social-login auth, and normal logged-in Claude Code auth omit `--bare` because Claude Code bare mode does not read OAuth or keychain credentials. The rest of the non-interactive plan-mode Claude invocation is preserved.

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
- `LINEAR_API_KEY`: Linear API key used by `--deliver-linear`
- `LINEAR_OAUTH_TOKEN`: Linear OAuth token used by `--linear-auth oauth`
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
