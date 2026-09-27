// The home page in Markdown, for agents: the page's copy, facts and links,
// without the nav, logos, video or footer. src/worker.ts serves it here and
// at / when a request's Accept header prefers text/markdown.

import type { APIRoute } from "astro";
import cliPackage from "../../../cli/package.json";
import {
  authorName,
  defaultSiteUrl,
  description,
  examplePrompt,
  headline,
  intro,
  licenseNote,
  pitch,
  title,
} from "../site-meta.js";

export const prerender = true;

// On the page these are mixed in with logos and code markup, so index.astro
// spells them out too. Update both.
const agents = ["Codex", "Claude", "Gemini"];
const features = [
  {
    name: "Works with what you've already got",
    text: "Detects `codex`, `claude`, and `gemini` on your `PATH` and runs whichever subset is there. Override with `COUNCIL_*_BIN` if your binaries live somewhere unusual.",
  },
  {
    name: "Won't touch your code",
    text: "Each CLI runs in its plan or read-only mode. Nothing on disk changes unless you opt in.",
  },
  {
    name: "See where they disagree",
    text: "One answer drawn from all three responses, with real disagreements surfaced instead of averaged away. If the lead summarizer is down, the next one takes over.",
  },
  {
    name: "Watch them think, ask follow-ups",
    text: "Each model streams in place, with a heartbeat on the slow ones. Press a number to expand a full answer. Type to ask a follow-up — the next turn carries the prior context.",
  },
  {
    name: "Drops into any pipeline",
    text: 'Pipe stdin with `echo "..." | council`, get structured output with `--json` or `--json-stream`, skip the dashboard with `--headless`, or import `runCouncil()` directly in Node.',
  },
];

export const GET: APIRoute = ({ site }) => {
  const siteUrl = site?.toString().replace(/\/$/, "") ?? defaultSiteUrl;
  const repoUrl = cliPackage.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
  const docsUrl = `${repoUrl}/blob/main/cli/README.md`;
  const npmUrl = `https://www.npmjs.com/package/${cliPackage.name}`;
  const frontMatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(description)}`,
    `url: ${JSON.stringify(`${siteUrl}/`)}`,
    "---",
  ].join("\n");
  const markdown = [
    frontMatter,
    `# ${headline.join(" ")}`,
    intro,
    `Works with: ${agents.join(", ")}`,
    ["```bash", `npx ${cliPackage.name} ${examplePrompt}`, "```"].join("\n"),
    licenseNote,
    pitch,
    "## Features",
    ...features.map(({ name, text }) => `### ${name}\n\n${text}`),
    "## Links",
    [
      `- [Source code on GitHub](${repoUrl})`,
      `- [${cliPackage.name} on npm](${npmUrl})`,
      `- [CLI README](${docsUrl}): install, usage, flags and output modes`,
    ].join("\n"),
    `Made by [${authorName}](https://armstr.ng).`,
  ].join("\n\n");
  return new Response(`${markdown}\n`, { headers: { "content-type": "text/markdown; charset=utf-8" } });
};
