# council

A small open-source CLI that asks multiple AI coding CLIs (`codex`, `claude`, `gemini`) the same question in parallel and synthesizes their answers into one final response.

This repo holds two things:

- [`cli/`](./cli) — the `council` CLI itself, published to npm
- [`web/`](./web) — the landing page hosted at [council.armstr.ng](https://council.armstr.ng)

## Prerequisites

- Node `>=22` for local development
- For the CLI itself: at least one supported upstream CLI installed and authenticated
  Supported CLIs today: `codex`, `claude`, `gemini`

If none of those CLIs are installed or authenticated, `council` cannot produce a real answer.

## Quick start

```bash
npx @armstrng/council "How should I structure this CLI?"
```

See [`cli/README.md`](./cli/README.md) for full usage, flags, and output modes.

The landing page has its own notes in [`web/README.md`](./web/README.md), including how its vendored browser assets are tracked.

## Development

The two subprojects are independent — each has its own `package.json` and is installed separately.

```bash
# CLI
cd cli && npm install && npm run build && npm test

# Site
cd web && npm install && npm run dev
```

If you are working on the CLI from a git checkout, run `npm run build` in `cli/` before invoking `./bin/council.js` directly so the launcher has a local `dist/` build to execute.

## License

[MIT](./LICENSE)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

See [SECURITY.md](./SECURITY.md).

## Releases

The published npm package lives in [`cli/`](./cli). Releases are managed by `release-please`, which opens a release PR from commits on `main`, updates [`cli/CHANGELOG.md`](./cli/CHANGELOG.md), bumps the package version, tags the release, and publishes `@armstrng/council` from GitHub Actions.

One-time maintainer setup is still required on npm: configure a trusted publisher for the `seeARMS/council` repository and the `.github/workflows/release-please.yml` workflow, then restrict token-based publishing once that flow is verified.
