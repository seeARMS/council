# Contributing

This file mirrors the repo-root contributing guide so the published CLI package still includes contribution notes. In the repository, the canonical guide lives at [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

## Setup

```bash
npm install
npm test
```

`council` is intentionally dependency-light. The test suite uses fake `codex`, `claude`, and `gemini` binaries so it does not depend on real vendor CLIs or credentials.

## Development guidelines

- Keep the CLI scriptable first: stdout should stay clean for primary output and stderr should carry progress or diagnostics.
- Preserve safe defaults. `council` is a consultation wrapper, not an autonomous code mutation tool.
- Add tests with every behavior change, especially around parsing, exit codes, output modes, and failure handling.
- Avoid adding runtime dependencies unless they materially improve portability or maintainability.
- Keep explicit member ordering stable. `--members gemini,claude` should stay in that order unless a later flag intentionally appends another member.

## Release checklist

```bash
npm test
node bin/council.js --help
```

Before publishing, confirm the package name, repository metadata, and screenshots/examples in `README.md` match the public repo.
