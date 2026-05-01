import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultSiteUrl,
  ogHeadline,
  siteName,
} from "../src/site-meta.js";

const rootDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const outputDir = join(rootDir, "public", "og");
const outputPath = join(outputDir, "home.png");
const brandHost = new URL(defaultSiteUrl).host;

async function pngDataUrl(path) {
  const buf = await readFile(path);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

async function rasterizedSvgDataUrl(path, size) {
  const svg = await readFile(path, "utf8");
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  const png = resvg.render().asPng();
  return `data:image/png;base64,${png.toString("base64")}`;
}

function agentPill(label, logoSrc, logoStyle = {}) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "12px 22px 12px 16px",
        borderRadius: "999px",
        border: "1px solid rgba(212, 212, 216, 0.9)",
        backgroundColor: "#ffffff",
        boxShadow:
          "0 1px 2px rgba(15, 23, 42, 0.05), 0 10px 30px rgba(15, 23, 42, 0.06)",
      },
      children: [
        {
          type: "img",
          props: {
            src: logoSrc,
            width: 28,
            height: 28,
            style: { width: "28px", height: "28px", objectFit: "contain", ...logoStyle },
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              color: "#18181b",
              fontSize: "26px",
              fontWeight: 600,
              lineHeight: 1,
            },
            children: label,
          },
        },
      ],
    },
  };
}

function buildMarkup({ councilLogo, codexLogo, claudeLogo, geminiLogo }) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        position: "relative",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        backgroundColor: "#ffffff",
        padding: "56px 64px",
      },
      children: [
        {
          type: "div",
          props: {
            style: {
              position: "absolute",
              top: "-260px",
              left: "50%",
              transform: "translateX(-50%)",
              width: "900px",
              height: "640px",
              borderRadius: "9999px",
              background:
                "radial-gradient(circle at 50% 50%, rgba(84, 111, 181, 0.22), rgba(84, 111, 181, 0.06) 42%, rgba(84, 111, 181, 0) 70%)",
            },
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              position: "relative",
              justifyContent: "space-between",
              alignItems: "center",
              width: "100%",
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: "14px",
                  },
                  children: [
                    {
                      type: "img",
                      props: {
                        src: councilLogo,
                        width: 44,
                        height: 44,
                        style: {
                          width: "44px",
                          height: "44px",
                          borderRadius: "10px",
                        },
                      },
                    },
                    {
                      type: "div",
                      props: {
                        style: {
                          display: "flex",
                          color: "#09090b",
                          fontSize: "30px",
                          fontWeight: 600,
                          letterSpacing: "-0.01em",
                          lineHeight: 1,
                        },
                        children: siteName,
                      },
                    },
                  ],
                },
              },
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    color: "#71717a",
                    fontSize: "22px",
                    fontWeight: 500,
                    letterSpacing: "0.01em",
                    lineHeight: 1,
                  },
                  children: brandHost,
                },
              },
            ],
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              position: "relative",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              flex: 1,
              width: "100%",
              gap: "44px",
              textAlign: "center",
            },
            children: [
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    color: "#09090b",
                    fontSize: "104px",
                    fontWeight: 700,
                    lineHeight: 1.04,
                    letterSpacing: "-0.045em",
                    whiteSpace: "pre-line",
                  },
                  children: ogHeadline,
                },
              },
              {
                type: "div",
                props: {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "16px",
                  },
                  children: [
                    agentPill("Codex", codexLogo, { borderRadius: "6px" }),
                    agentPill("Claude", claudeLogo),
                    agentPill("Gemini", geminiLogo),
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };
}

async function main() {
  const [interMedium, interSemiBold, interBold] = await Promise.all([
    readFile(join(rootDir, "src", "assets", "fonts", "Inter-500.woff")),
    readFile(join(rootDir, "src", "assets", "fonts", "Inter-600.woff")),
    readFile(join(rootDir, "src", "assets", "fonts", "Inter-700.woff")),
  ]);

  const [councilLogo, codexLogo, claudeLogo, geminiLogo] = await Promise.all([
    pngDataUrl(join(rootDir, "src", "assets", "council-256.png")),
    pngDataUrl(join(rootDir, "src", "assets", "agent-logos", "codex.png")),
    pngDataUrl(join(rootDir, "src", "assets", "agent-logos", "claude.png")),
    rasterizedSvgDataUrl(join(rootDir, "public", "agent-logos", "gemini.svg"), 64),
  ]);

  const svg = await satori(
    buildMarkup({ councilLogo, codexLogo, claudeLogo, geminiLogo }),
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Inter", data: interMedium, weight: 500, style: "normal" },
        { name: "Inter", data: interSemiBold, weight: 600, style: "normal" },
        { name: "Inter", data: interBold, weight: 700, style: "normal" },
      ],
    },
  );

  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } });
  const png = resvg.render().asPng();

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, png);
  console.log(`Generated ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
