# Council Repo Outline

## Overview

This repo contains **Council**, a small developer tool for comparing responses from multiple AI coding assistants and turning them into a single synthesized answer. The project is organized as a lightweight npm workspace with a CLI package and a small marketing site.

## Main Parts

### `cli/`

- The publishable npm package for the `council` command.
- Mostly TypeScript targeting Node.js, with both ESM and CommonJS build artifacts emitted to `dist/`.
- Handles argument parsing, engine orchestration, output rendering, and interactive follow-up sessions.
- Supports text output, JSON, streaming JSON events, and an Ink-based terminal UI.
- Includes tests and fake upstream binaries so the behavior can be exercised locally without real vendor credentials.
- Supports `codex`, `claude`, `gemini`, and `perplexity` as council members.
- There also seems to be a small caching layer for reusing prior model responses across runs.

### `web/`

- The public-facing site for the project.
- Built with Astro and styled as a single-page marketing site.
- Pulls version and repository metadata from the CLI package.
- Uses a few React islands for interactive homepage sections.
- Appears set up for Vercel deployment and standard static-site docs/SEO concerns.

## Root-Level Project Files

- Top-level docs include `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, and `CODE_OF_CONDUCT.md`.
- Release automation is configured at the repo root with `release-please`.
- The root CI/release setup appears to version and publish both subprojects together.
- The repo root mainly ties the CLI and website together rather than containing core runtime logic.

## Short Take

Most of the real implementation lives in `cli/`, while `web/` is the supporting landing page. The overall repo is fairly compact and focused on packaging, shared root tooling, release flow, and a small amount of product marketing around the CLI itself.
