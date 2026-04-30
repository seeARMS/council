#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs, usageText } from '../src/args.js';
import { exitCodeForResult, EXIT_CODES } from '../src/exit-codes.js';
import { createInteractiveDashboard, shouldUseInteractiveDashboard } from '../src/interactive-ui.js';
import { readInteractivePrompt, readPromptFromArgsAndStdin } from '../src/utils.js';
import { runCouncil } from '../src/council.js';
import { renderHumanResult } from '../src/render.js';
import { renderBanner, renderProgressEvent, resolveUiOptions } from '../src/ui.js';

function readVersion() {
  const packageJsonPath = new URL('../package.json', import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return packageJson.version;
}

async function main() {
  let parsed;

  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
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
  let prompt = initialPrompt;

  if (!prompt) {
    if (interactiveMode) {
      prompt = await readInteractivePrompt({
        output: process.stderr
      });
    } else {
      process.stderr.write('No query provided.\n\n');
      process.stderr.write(`${usageText(readVersion())}\n`);
      process.exitCode = EXIT_CODES.USAGE_ERROR;
      return;
    }
  }

  if (!prompt) {
    process.exitCode = EXIT_CODES.OK;
    return;
  }

  if (ui.showBanner) {
    process.stderr.write(`${renderBanner({ colorEnabled: ui.stderrColor })}\n\n`);
  }

  const conversation = [];
  const resolvedCwd = resolve(parsed.cwd);

  try {
    while (prompt) {
      const interactiveDashboard = interactiveMode
        ? createInteractiveDashboard({
            stream: process.stderr,
            input: process.stdin,
            colorEnabled: ui.stderrColor,
            members: parsed.members
          })
        : null;

      interactiveDashboard?.start();

      const result = await runCouncil({
        query: prompt,
        cwd: resolvedCwd,
        members: parsed.members,
        summarizer: parsed.summarizer,
        timeoutMs: parsed.timeoutMs,
        maxMemberChars: parsed.maxMemberChars,
        conversation,
        onEvent: (event) => {
          if (ui.outputMode === 'json-stream') {
            process.stdout.write(`${JSON.stringify(event)}\n`);
            return;
          }

          if (interactiveDashboard) {
            interactiveDashboard.handleEvent(event);
            return;
          }

          if (ui.showProgress) {
            const line = renderProgressEvent(event, { colorEnabled: ui.stderrColor });
            if (line) {
              process.stderr.write(`${line}\n`);
            }
          }
        }
      });

      if (ui.outputMode === 'json') {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (ui.outputMode === 'text') {
        if (interactiveDashboard) {
          const action = await interactiveDashboard.waitForAction();
          conversation.push({
            user: prompt,
            assistant: summaryTextForConversation(result)
          });
          interactiveDashboard.dispose();

          process.exitCode = exitCodeForResult(result);

          if (action.type !== 'continue') {
            break;
          }

          process.stderr.write('\n');
          prompt = await readInteractivePrompt({
            output: process.stderr,
            ignoreInitialEmptyOnce: true,
            initialText: action.seed
          });
          if (!prompt) {
            break;
          }
          process.stderr.write('\n');
          continue;
        }

        process.stdout.write(`${renderHumanResult(result, { summaryOnly: ui.summaryOnly })}\n`);
      }

      process.exitCode = exitCodeForResult(result);
      break;
    }
  } finally {
    process.stdin.setRawMode?.(false);
  }
}

function summaryTextForConversation(result) {
  if (result.summary?.status === 'ok') {
    return result.summary.output;
  }

  if (result.summary?.name) {
    return `Summary failed via ${result.summary.name}: ${result.summary.detail || 'Unknown error.'}`;
  }

  return `Summary failed: ${result.summary?.detail || 'Unknown error.'}`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = EXIT_CODES.RUNTIME_ERROR;
});
