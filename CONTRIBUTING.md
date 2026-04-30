# Contributing

This repo has two subprojects:

- `cli/` is the published `council` npm package.
- `web/` is the landing page deployed separately.

## Setup

CLI:

```bash
cd cli
npm install
npm run build
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

## Releases

The published npm artifact is `cli/`.

- Versioning, changelog updates, Git tags, and GitHub releases are managed by `release-please`.
- The release workflow is defined in [release-please.yml](./.github/workflows/release-please.yml).
- The release metadata files live at [release-please-config.json](./release-please-config.json) and [.release-please-manifest.json](./.release-please-manifest.json).
- Changelog entries are written to [cli/CHANGELOG.md](./cli/CHANGELOG.md).
- Release notes are derived from Conventional Commit messages, so squash-merge titles and direct commits to `main` should follow that format when possible.
- npm publishing assumes npm trusted publishing has been configured for `.github/workflows/release-please.yml`.

Before merging release-affecting changes, confirm:

- CLI tests still pass with `cd cli && npm test`
- the CLI still builds with `cd cli && npm run build`
- the web app still builds with `cd web && npm run build`
- README examples and package metadata still match the current implementation
