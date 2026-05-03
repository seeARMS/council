# council

Native Rust CLI for Council.

```bash
cargo install --path crates/council
council --members codex,claude,gemini "Compare these implementation options"
```

Council shells out to the authenticated provider CLIs already installed on your machine:

- `codex`
- `claude`
- `gemini`

Provider binary paths can be overridden with `COUNCIL_CODEX_BIN`, `COUNCIL_CLAUDE_BIN`, and `COUNCIL_GEMINI_BIN`.

The Rust binary supports the main Council workflow flags for member selection, provider-specific model/effort/auth/permission/capability settings, planner/lead roles, handoff, iterations, real provider sub-agent fanout, prompt file tags, prompt commands, JSON output, headless execution, native Studio, and Linear delivery.

Useful native commands:

```bash
council --auth-status --capabilities-status
council --studio --members codex,claude,gemini
council --members codex,claude,gemini --team-work 2 "Inspect the repo"
council --deliver-linear --linear-project ENG --linear-until-complete --linear-completion-gate review-or-ci
```

Native status:

- Native provider consultation and synthesis: implemented.
- Native prompt file/command context: implemented.
- Native social-login command bootstrap with browser/deeplink detection, provider login modes, and auth status checks: implemented.
- Native provider capability management for inherit/override modes, MCP, skills, tools, agents, plugin dirs, Gemini policies/extensions, and capability status probes: implemented.
- Native `--team-work` / per-provider sub-agent fanout: implemented as real same-provider sub-runs with lead handoff synthesis.
- Native token, tool, command, prompt-command, and sub-agent telemetry in JSON, verbose output, and Studio: implemented.
- Native Studio TUI with editable settings, pane movement, file/command tagging, auth status, Linear, capability management, telemetry, and double-Ctrl+C exit: implemented.
- Native Linear setup/status and autonomous delivery loop with project/epic targeting, issue workspaces, retry/reconciliation state, observability, comments back to Linear, media attachments, optional review-state updates, and review/CI gates: implemented.
