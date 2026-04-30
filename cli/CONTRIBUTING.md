# Contributing

## Setup

```bash
npm link
npm test
```

`council` is intentionally dependency-light. The test suite uses fake `codex`, `claude`, and `gemini` binaries so it does not depend on real vendor CLIs or credentials.

## Development guidelines

- Keep the CLI scriptable first: stdout should stay clean for primary output and stderr should carry progress or diagnostics.
- Preserve safe defaults. `council` is a consultation wrapper, not an autonomous code mutation tool.
- Add tests with every behavior change, especially around parsing, exit codes, output modes, and failure handling.
- Avoid adding runtime dependencies unless they materially improve portability or maintainability.

## Release checklist

```bash
npm test
node bin/council.js --help
```

Before publishing, confirm the package name, repository metadata, and screenshots/examples in `README.md` match the public repo.
