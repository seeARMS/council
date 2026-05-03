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

The Rust binary supports the main Council workflow flags for member selection, provider-specific model/effort/auth/permission/capability settings, planner/lead roles, handoff, iterations, prompt file tags, prompt commands, JSON output, and headless execution.

Migration status:

- Native provider consultation and synthesis: implemented.
- Native prompt file/command context: implemented.
- Native social-login command bootstrap: implemented.
- Native Linear setup/status flags: implemented.
- Native Studio TUI and full Linear delivery loop: being ported from the legacy TypeScript implementation.
