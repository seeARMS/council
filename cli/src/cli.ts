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
import {
  getLinearDeliveryStatus,
  renderDeliveryProgressEvent,
  renderDeliveryResult,
  renderLinearDeliveryStatus,
  runLinearDelivery
} from './delivery.js';
import {
  buildPromptContext,
  buildPromptWithContext
} from './prompt-context.js';
import {
  renderProviderSocialLoginResult,
  resolveSocialLoginProviders,
  runProviderSocialLogins
} from './provider-auth.js';
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

  if (parsed.ack) {
    process.stdout.write('ACK\n');
    return;
  }

  const ui = resolveUiOptions(parsed);
  const resolvedCwd = resolve(parsed.cwd);

  if (parsed.delivery.setup || parsed.delivery.status) {
    const status = await getLinearDeliveryStatus({
      cwd: resolvedCwd,
      delivery: parsed.delivery,
      env: process.env
    });

    if (ui.outputMode === 'json') {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderLinearDeliveryStatus(status)}\n`);
    }
    return;
  }

  const interactiveMode = shouldUseInteractiveDashboard(ui);
  const initialPrompt = await readPromptFromArgsAndStdin(parsed.promptParts);

  if (!initialPrompt && !interactiveMode && !parsed.delivery.enabled && !parsed.authLogin.enabled) {
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

  const emitCliEvent = (event) => {
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
  };

  if (parsed.authLogin.enabled) {
    const providers = resolveSocialLoginProviders({
      members: parsed.members,
      auths: parsed.auths,
      providers: parsed.authLogin.providers
    });
    const authResult = await runProviderSocialLogins({
      providers,
      cwd: resolvedCwd,
      env: process.env,
      timeoutMs: parsed.authLogin.timeoutMs,
      openBrowser: parsed.authLogin.openBrowser,
      deviceCode: parsed.authLogin.deviceCode,
      input: process.stdin.isTTY ? process.stdin : null,
      output: process.stderr,
      stdioMode: ui.outputMode === 'text' ? 'auto' : 'pipe',
      onEvent: emitCliEvent
    });

    if (!initialPrompt && !interactiveMode && !parsed.delivery.enabled) {
      if (ui.outputMode === 'json' || ui.outputMode === 'json-stream') {
        if (ui.outputMode === 'json') {
          process.stdout.write(`${JSON.stringify(authResult, null, 2)}\n`);
        }
      } else {
        process.stdout.write(`${renderProviderSocialLoginResult(authResult)}\n`);
      }
      process.exitCode = authResult.success ? EXIT_CODES.OK : EXIT_CODES.RUNTIME_ERROR;
      return;
    }
  }
  const promptContext = await buildPromptContext({
    cwd: resolvedCwd,
    files: parsed.promptContext.files,
    commands: parsed.promptContext.commands,
    env: process.env,
    onEvent: (event) => emitCliEvent({
      at: new Date().toISOString(),
      ...event
    })
  });
  const enrichedPrompt = buildPromptWithContext(initialPrompt, promptContext);

  if (parsed.delivery.enabled) {
    const result = await runLinearDelivery({
      baseQuery: enrichedPrompt,
      cwd: resolvedCwd,
      delivery: parsed.delivery,
      members: parsed.members,
      summarizer: parsed.summarizer,
      timeoutMs: parsed.timeoutMs,
      maxMemberChars: parsed.maxMemberChars,
      effort: parsed.effort,
      models: parsed.models,
      efforts: parsed.efforts,
      permissions: parsed.permissions,
      auths: parsed.auths,
      handoff: parsed.handoff,
      lead: parsed.lead,
      planner: parsed.planner,
      iterations: parsed.iterations,
      teamWork: parsed.teamWork,
      teams: parsed.teams,
      env: process.env,
      onEvent: (event) => {
        if (ui.outputMode === 'json-stream') {
          process.stdout.write(`${JSON.stringify(event)}\n`);
          return;
        }

        if (ui.showProgress) {
          const line = renderDeliveryProgressEvent(event);
          if (line) {
            process.stderr.write(`${line}\n`);
          }
        }
      }
    });

    if (ui.outputMode === 'json' || ui.outputMode === 'json-stream') {
      if (ui.outputMode === 'json') {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
    } else {
      process.stdout.write(`${renderDeliveryResult(result)}\n`);
    }

    process.exitCode = result.success ? EXIT_CODES.OK : EXIT_CODES.RUNTIME_ERROR;
    return;
  }

  if (interactiveMode) {
    const result = await runInteractiveSession({
      initialPrompt,
      members: parsed.members,
      summarizer: parsed.summarizer,
      timeoutMs: parsed.timeoutMs,
      maxMemberChars: parsed.maxMemberChars,
      cwd: resolvedCwd,
      effort: parsed.effort,
      models: parsed.models,
      efforts: parsed.efforts,
      permissions: parsed.permissions,
      auths: parsed.auths,
      handoff: parsed.handoff,
      lead: parsed.lead,
      planner: parsed.planner,
      iterations: parsed.iterations,
      teamWork: parsed.teamWork,
      teams: parsed.teams,
      promptContext,
      studio: parsed.studio,
      conversation: [],
      onEvent: undefined
    });

    if (result) {
      process.exitCode = exitCodeForResult(result);
    }
    return;
  }

  const result = await runCouncil({
    query: enrichedPrompt,
    cwd: resolvedCwd,
    members: parsed.members,
    summarizer: parsed.summarizer,
    timeoutMs: parsed.timeoutMs,
    maxMemberChars: parsed.maxMemberChars,
    effort: parsed.effort,
    models: parsed.models,
    efforts: parsed.efforts,
    permissions: parsed.permissions,
    auths: parsed.auths,
    handoff: parsed.handoff,
    lead: parsed.lead,
    planner: parsed.planner,
    iterations: parsed.iterations,
    teamWork: parsed.teamWork,
    teams: parsed.teams,
    conversation: [],
    onEvent: emitCliEvent
  });

  if (ui.outputMode === 'json') {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (ui.outputMode === 'text') {
    process.stdout.write(`${renderHumanResult(result, ui)}\n`);
  }

  process.exitCode = exitCodeForResult(result);
}
