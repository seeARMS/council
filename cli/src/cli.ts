import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, usageText } from './args.js';
import { exitCodeForResult, EXIT_CODES } from './exit-codes.js';
import {
  runInteractiveSession,
  shouldUseInteractiveDashboard
} from './interactive-ui.js';
import { readPromptFromArgsAndStdin } from './utils.js';
import { runCouncil } from './council.js';
import { renderHumanResult } from './render.js';
import {
  renderBanner,
  renderProgressEvent,
  resolveUiOptions
} from './ui.js';

export function readVersion() {
  const packageJsonPath = new URL('../package.json', import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return packageJson.version;
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;

  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n`
    );
    process.stderr.write(`${usageText(readVersion())}\n`);
    process.exitCode = EXIT_CODES.USAGE_ERROR;
    return;
  }

  if (parsed.help) {
    process.stdout.write(`${usageText(readVersion())}\n`);
    return;
  }

  if (parsed.version) {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  const ui = resolveUiOptions(parsed);
  const interactiveMode = shouldUseInteractiveDashboard(ui);
  const initialPrompt = await readPromptFromArgsAndStdin(parsed.promptParts);

  if (!initialPrompt && !interactiveMode) {
    process.stderr.write('No query provided.\n\n');
    process.stderr.write(`${usageText(readVersion())}\n`);
    process.exitCode = EXIT_CODES.USAGE_ERROR;
    return;
  }

  if (ui.showBanner) {
    process.stderr.write(
      `${renderBanner({ colorEnabled: ui.stderrColor })}\n\n`
    );
  }

  const resolvedCwd = resolve(parsed.cwd);

  if (interactiveMode) {
    const result = await runInteractiveSession({
      initialPrompt,
      members: parsed.members,
      summarizer: parsed.summarizer,
      timeoutMs: parsed.timeoutMs,
      maxMemberChars: parsed.maxMemberChars,
      cwd: resolvedCwd,
      conversation: [],
      onEvent: undefined
    });

    if (result) {
      process.exitCode = exitCodeForResult(result);
    }
    return;
  }

  const result = await runCouncil({
    query: initialPrompt,
    cwd: resolvedCwd,
    members: parsed.members,
    summarizer: parsed.summarizer,
    timeoutMs: parsed.timeoutMs,
    maxMemberChars: parsed.maxMemberChars,
    conversation: [],
    onEvent: (event) => {
      if (ui.outputMode === 'json-stream') {
        process.stdout.write(`${JSON.stringify(event)}\n`);
        return;
      }

      if (ui.showProgress) {
        const line = renderProgressEvent(event, {
          colorEnabled: ui.stderrColor
        });
        if (line) {
          process.stderr.write(`${line}\n`);
        }
      }
    }
  });

  if (ui.outputMode === 'json') {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (ui.outputMode === 'text') {
    process.stdout.write(
      `${renderHumanResult(result, { summaryOnly: ui.summaryOnly })}\n`
    );
  }

  process.exitCode = exitCodeForResult(result);
}
