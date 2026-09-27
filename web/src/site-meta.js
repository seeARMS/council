export const defaultSiteUrl = "https://council.armstr.ng";
export const siteName = "Council";
export const authorName = "Colin Armstrong";
export const xHandle = "@colinarms";
export const title = "Council: Compare Codex, Claude, and Gemini in One CLI";
export const description =
  "Council is an open-source CLI that runs Codex, Claude, and Gemini in parallel on the same prompt, synthesizes one answer, and highlights disagreements.";
export const examplePrompt = "review this migration plan";
export const ogImagePath = "/og/home.png";
export const ogImageAlt =
  "Council CLI homepage for comparing Codex, Claude, and Gemini on the same prompt.";

// The home page's copy, which the page (index.astro) and its Markdown version
// (index.md.ts) both read. The headline is split where the page breaks it.
export const headline = ["Ask three agents.", "Get one answer."];
export const intro =
  "Council runs Codex, Claude, and Gemini in parallel against the same prompt and synthesizes their responses — using the subscriptions you already pay for.";
export const licenseNote = "Free and open source. MIT licensed.";
export const pitch =
  "Three models, three sets of blind spots. Council runs them in parallel and surfaces where they agree, where they don't, and where one of them is probably wrong.";

export const ogHeadline = headline.join("\n");
