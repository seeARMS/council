# Vendored assets

## `tailwindcss.js`

- Path: `web/public/vendor/tailwindcss.js`
- Purpose: browser-side Tailwind utility generation for the landing page without a separate Tailwind build pipeline
- Provenance: vendored standalone Tailwind browser/CDN runtime
- Embedded source marker: the bundle contains the upstream warning string `cdn.tailwindcss.com should not be used in production`
- SHA-256, recorded on 2026-04-30: `176e894661aa9cdc9a5cba6c720044cbbf7b8bd80d1c9a142a7c24b1b6c50d15`

## Update policy

- Do not edit `tailwindcss.js` by hand.
- When refreshing it, record the exact upstream URL or package source, the version or retrieval date, and the new SHA-256 here.
- Update the matching metadata in `web/package.json` `x-vendored-assets.tailwind-browser-runtime` at the same time.
