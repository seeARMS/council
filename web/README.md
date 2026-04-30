# council-web

Astro landing page for `council`.

## Development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

## Dependency notes

- The Astro and Cloudflare adapter dependencies are declared in `package.json`.
- The page styling currently relies on a vendored Tailwind browser runtime at `public/vendor/tailwindcss.js`.
- Provenance, checksum, and refresh notes for that vendored asset live in `public/vendor/README.md`.
