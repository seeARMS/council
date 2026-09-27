// llms.txt (llmstxt.org): what Council is, in brief, for agents, with links to
// the Markdown version of the home page and to the CLI's own docs.

import type { APIRoute } from "astro";
import cliPackage from "../../../cli/package.json";
import { authorName, defaultSiteUrl, description, examplePrompt, siteName } from "../site-meta.js";

export const prerender = true;

export const GET: APIRoute = ({ site }) => {
  const siteUrl = site?.toString().replace(/\/$/, "") ?? defaultSiteUrl;
  const repoUrl = cliPackage.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
  const readmeUrl = `https://raw.githubusercontent.com${new URL(repoUrl).pathname}/main/cli/README.md`;
  const npmUrl = `https://www.npmjs.com/package/${cliPackage.name}`;
  const text = [
    `# ${siteName}`,
    `> ${description}`,
    "Council sends one prompt to the Codex, Claude and Gemini command-line tools at the same time, then has one of them merge their answers into a single response that shows where they disagree. It runs each CLI in its plan or read-only mode, so nothing on disk changes unless you opt in, and it uses the subscriptions you already pay for.",
    [
      "Requirements:",
      "",
      "- Node.js 22 or later.",
      "- At least one of the `codex`, `claude` or `gemini` CLIs, installed and signed in. Council skips any that are missing.",
    ].join("\n"),
    [
      "Install and run:",
      "",
      `- Without installing: \`npx ${cliPackage.name} ${examplePrompt}\``,
      `- Installed globally: \`npm install -g ${cliPackage.name}\`, then \`council ${examplePrompt}\``,
    ].join("\n"),
    [
      "Output modes:",
      "",
      "- An interactive terminal dashboard, the default.",
      "- `--summary-only`: just the merged answer.",
      "- `--json`: one structured JSON result.",
      "- `--json-stream`: JSONL events as they happen.",
      "- `--headless`: for scripts. No banner or progress, and summary-only text unless combined with `--json` or `--json-stream`.",
    ].join("\n"),
    'It also reads a prompt piped to stdin (`echo "..." | council`), and Node programs can import `runCouncil()` from the package.',
    `Council is free and open source under the ${cliPackage.license} license. It's made by ${authorName} (https://armstr.ng).`,
    "Every page on this site has a Markdown version at its address plus `.md` (the home page's is `/index.md`). A page's own address also serves that Markdown to requests whose Accept header prefers `text/markdown`.",
    "## Docs",
    [
      `- [Council home page](${siteUrl}/index.md): what Council does, in Markdown`,
      `- [CLI README](${readmeUrl}): install, flags, output modes, exit codes and environment variables`,
      `- [npm package](${npmUrl}): ${cliPackage.name}`,
      `- [GitHub repository](${repoUrl}): source code and issues`,
    ].join("\n"),
    "## Optional",
    [
      `- [Changelog](${repoUrl}/blob/main/cli/CHANGELOG.md): what changed in each release`,
      `- [${authorName}](https://armstr.ng): who made Council`,
    ].join("\n"),
  ].join("\n\n");
  return new Response(`${text}\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });
};
