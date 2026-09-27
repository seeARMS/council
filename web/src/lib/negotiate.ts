// Agents that want Markdown ask for it in Accept. Claude Code sends
// "text/markdown, text/html, */*" (both at q=1); OpenCode and VS Code rank
// text/markdown above text/html; browsers never mention it. Ties go to
// Markdown, so an agent that lists both equally still gets it.
export function prefersMarkdown(accept: string | null | undefined): boolean {
  let markdown = 0;
  let html = 0;
  for (const range of (accept ?? "").toLowerCase().split(",")) {
    const [type, ...params] = range.split(";").map((part) => part.trim());
    const q = params.find((param) => param.startsWith("q="));
    const weight = q ? Number.parseFloat(q.slice(2)) : 1;
    if (Number.isNaN(weight)) continue;
    if (type === "text/markdown" || type === "text/x-markdown") markdown = Math.max(markdown, weight);
    else if (type === "text/html") html = Math.max(html, weight);
  }
  return markdown > 0 && markdown >= html;
}
