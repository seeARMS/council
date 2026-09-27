// Worker entry: Astro's handler, plus Markdown for agents. Each page has a
// Markdown version built beside it (/ → /index.md). It's served at that
// address, and at the page's own address when the request's Accept header
// prefers text/markdown. Only the paths in wrangler.jsonc's
// assets.run_worker_first come through here; every other file is served
// straight from the built files.

import { handle } from "@astrojs/cloudflare/handler";
import { prefersMarkdown } from "./lib/negotiate";

// There are no generated Workers types here, so this types the one binding it
// uses and takes the rest from Astro's handler.
type Env = { ASSETS: { fetch: typeof fetch } };
type Context = Parameters<typeof handle>[2];

export default {
  async fetch(request: Request, env: Env, ctx: Context) {
    const url = new URL(request.url);
    const reading = request.method === "GET" || request.method === "HEAD";
    const md = reading ? markdownFor(url.pathname, request.headers.get("accept")) : undefined;
    if (md) {
      const file = await env.ASSETS.fetch(new URL(md.file, url));
      if (file.ok) {
        const headers = new Headers(file.headers);
        headers.set("content-type", "text/markdown; charset=utf-8");
        headers.set("vary", "Accept");
        headers.set("link", `<${new URL(md.page, url).href}>; rel="canonical"`);
        return new Response(request.method === "HEAD" ? null : file.body, { headers });
      }
    }
    // The page's built file, fetched with the request as it came in (its
    // redirect mode is "manual"), so redirects and conditional requests still
    // work; Astro's handler refetches by URL and would follow them. Astro
    // renders whatever isn't a file.
    const response = reading ? await page(request, env, ctx) : await handle(request, env, ctx);
    if (!response.headers.get("content-type")?.startsWith("text/html")) return response;
    // Pages vary by Accept now; say so, so no cache hands a browser the Markdown.
    const html = new Response(response.body, response);
    html.headers.append("vary", "Accept");
    return html;
  },
};

/** A page's built file, or Astro's response when there's no such file. */
async function page(request: Request, env: Env, ctx: Context) {
  const file = await env.ASSETS.fetch(request);
  return file.status === 404 ? handle(request, env, ctx) : file;
}

/** The Markdown file for a request, and the page it stands for. */
function markdownFor(path: string, accept: string | null) {
  if (path.endsWith(".md")) return { file: path, page: path === "/index.md" ? "/" : path.slice(0, -3) };
  if (!prefersMarkdown(accept)) return undefined;
  if (path === "/") return { file: "/index.md", page: "/" };
  const page = path.replace(/\/$/, "");
  // Page addresses only, not files.
  if (/\.[^/]*$/.test(page)) return undefined;
  return { file: `${page}.md`, page: path };
}
