# Contributing

This repo has two subprojects:

- `cli/` is the published `council` npm package.
- `web/` is the landing page deployed separately.

## Setup

CLI:

```bash
cd cli
npm install
npm test
```

Web:

```bash
cd web
npm install
npm run build
```

## Development guidelines

- Keep the CLI scriptable first. Primary output belongs on stdout; progress and diagnostics belong on stderr.
- Preserve safe defaults. `council` is a consultation wrapper, not an autonomous code-mutation tool.
- Add tests with behavior changes, especially around parsing, failure isolation, output modes, and exit codes.
- Keep dependency provenance explicit. If the web app vendors browser assets, document their source and checksum under `web/public/vendor/`.
- Avoid runtime dependencies unless they materially improve portability or maintainability.

## Release checklist

CLI:

```bash
cd cli
npm test
node bin/council.js --help
```

Web:

```bash
cd web
npm run build
```

Before publishing or deploying, confirm package metadata, README examples, and any vendored asset documentation still match what is in the repo.
