# council

A small open-source CLI that asks multiple AI coding CLIs (`codex`, `claude`, `gemini`) the same question and synthesizes their answers into one final response. It can run the tools in parallel, or coordinate planner/lead/executor workflows with handoffs, iterations, and provider team sizes.

This repo holds two things:

- [`crates/council/`](./crates/council) — the native Rust `council` CLI
- [`web/`](./web) — the landing page hosted at [council.armstr.ng](https://council.armstr.ng)

## Prerequisites

- Rust stable for the native CLI
- Node `>=22` only for the Astro web app
- For the CLI itself: at least one supported upstream CLI installed and authenticated
  Supported CLIs today: `codex`, `claude`, `gemini`

If none of those CLIs are installed or authenticated, `council` cannot produce a real answer.

## Quick start

```bash
cargo run -p council -- "How should I structure this CLI?"
```

Install the native binary from a checkout:

```bash
cargo install --path crates/council
council --members codex,claude,gemini "How should I structure this CLI?"
```

See [`crates/council/README.md`](./crates/council/README.md) for native CLI notes.

The landing page has its own notes in [`web/README.md`](./web/README.md), including how its vendored browser assets are tracked.

## Development

The CLI is a Cargo workspace member. The web app remains an independent Astro project with its own `package.json`.

```bash
# CLI
cargo fmt --all --check
cargo build --workspace
cargo test --workspace

# Site
cd web && npm install && npm run dev
```

If you are working on the CLI from a git checkout, run `cargo run -p council -- --help`, launch the native Studio with `cargo run -p council -- --studio`, or install it locally with `cargo install --path crates/council`.

## License

[MIT](./LICENSE)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Contributors

- [Dviros](https://github.com/Dviros)

## Security

See [SECURITY.md](./SECURITY.md).

## Releases

The native Rust crate lives in [`crates/council/`](./crates/council). Releases are managed by `release-please`, which opens a release PR from commits on `main`, updates the Rust crate changelog, bumps `Cargo.toml`, tags the release, and publishes the crate from GitHub Actions.

One-time maintainer setup is still required on crates.io: publish or reserve the crate name, then configure either crates.io trusted publishing for `.github/workflows/release-please.yml` or provide a scoped `CARGO_REGISTRY_TOKEN` secret.
