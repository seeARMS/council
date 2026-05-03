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

The Rust binary supports the main Council workflow flags for member selection, provider-specific model/effort/auth/permission/capability settings, planner/lead roles, handoff, iterations, prompt file tags, prompt commands, JSON output, headless execution, native Studio, and Linear delivery.

Native status:

- Native provider consultation and synthesis: implemented.
- Native prompt file/command context: implemented.
- Native social-login command bootstrap with browser/deeplink detection: implemented.
- Native Studio TUI with editable settings, pane movement, file/command tagging, auth, Linear, capability, telemetry, and double-Ctrl+C exit: implemented.
- Native Linear setup/status and autonomous delivery loop with project/epic targeting, issue workspaces, retry/reconciliation state, observability, media attachments, and review/CI gates: implemented.
