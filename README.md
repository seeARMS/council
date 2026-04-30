# council

A small open-source CLI that asks multiple AI coding CLIs (`codex`, `claude`, `gemini`) the same question in parallel and synthesizes their answers into one final response.

This repo holds two things:

- [`cli/`](./cli) — the `council` CLI itself, published to npm
- [`web/`](./web) — the landing page hosted at [council.armstr.ng](https://council.armstr.ng)

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
cd cli && npm install && npm test

# Site
cd web && npm install && npm run dev
```

## License

[MIT](./LICENSE)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
