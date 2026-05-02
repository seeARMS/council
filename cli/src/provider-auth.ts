import { spawn } from 'node:child_process';

export const DEFAULT_AUTH_LOGIN_TIMEOUT_MS = 300_000;
export const SOCIAL_LOGIN_PROVIDERS = ['codex', 'claude', 'gemini'];

const PROVIDER_BINS = {
  codex: {
    envVar: 'COUNCIL_CODEX_BIN',
    defaultBin: 'codex'
  },
  claude: {
    envVar: 'COUNCIL_CLAUDE_BIN',
    defaultBin: 'claude'
  },
  gemini: {
    envVar: 'COUNCIL_GEMINI_BIN',
    defaultBin: 'gemini'
  }
};

export function resolveSocialLoginProviders({
  members = SOCIAL_LOGIN_PROVIDERS,
  auths = {},
  providers = []
}: any = {}) {
  const explicit = normalizeProviderList(providers);
  if (explicit.length > 0) {
    return explicit;
  }

  const socialMembers = members.filter((provider) => auths?.[provider] === 'social-login');
  return socialMembers.length > 0 ? socialMembers : [...members];
}

export function socialLoginCommandForProvider(provider, { deviceCode = false } = {}) {
  if (provider === 'codex') {
    return {
      provider,
      args: deviceCode ? ['login', '--device-auth'] : ['login'],
      launchMode: 'dedicated-login',
      supportsDeviceCode: true,
      supportsBrowserDeeplink: true,
      supportsCodePaste: true,
      instruction: deviceCode
        ? 'Complete the Codex device-code flow in the browser, then paste the code here if prompted.'
        : 'Complete the Codex browser login; local deeplinks and pasted codes are accepted by the Codex CLI.'
    };
  }

  if (provider === 'claude') {
    return {
      provider,
      args: ['auth', 'login'],
      launchMode: 'dedicated-login',
      supportsDeviceCode: false,
      supportsBrowserDeeplink: true,
      supportsCodePaste: true,
      instruction: 'Complete the Claude browser login; if Claude shows a login code, paste it into this terminal.'
    };
  }

  if (provider === 'gemini') {
    return {
      provider,
      args: [],
      launchMode: 'native-interactive',
      supportsDeviceCode: false,
      supportsBrowserDeeplink: true,
      supportsCodePaste: true,
      instruction: 'Gemini CLI opens its native auth selector. Choose Login with Google to open the browser tab, then complete the local callback or paste any shown code.'
    };
  }

  throw new Error(`Unsupported social-login provider: ${provider}`);
}

export async function runProviderSocialLogins({
  providers,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = DEFAULT_AUTH_LOGIN_TIMEOUT_MS,
  openBrowser = true,
  deviceCode = false,
  input = process.stdin,
  output = process.stderr,
  opener = openBrowserUrl,
  stdioMode = 'auto',
  onEvent = () => {}
}: any) {
  const results = [];

  for (const provider of providers) {
    const result = await runProviderSocialLogin({
      provider,
      cwd,
      env,
      timeoutMs,
      openBrowser,
      deviceCode,
      input,
      output,
      opener,
      stdioMode,
      onEvent
    });
    results.push(result);
  }

  return {
    success: results.every((result) => result.status === 'ok'),
    providers: results
  };
}

export function runProviderSocialLogin({
  provider,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = DEFAULT_AUTH_LOGIN_TIMEOUT_MS,
  openBrowser = true,
  deviceCode = false,
  input = process.stdin,
  output = process.stderr,
  opener = openBrowserUrl,
  stdioMode = 'auto',
  onEvent = () => {}
}: any) {
  const commandConfig = socialLoginCommandForProvider(provider, { deviceCode });
  const bin = resolveProviderBinary(provider, env);
  const args = commandConfig.args;
  const command = formatCommand(bin, args);
  const resolvedStdioMode = resolveStdioMode({ requested: stdioMode, input, output });
  const startedAt = Date.now();
  const openedUrls = [];
  const seenUrls = new Set();

  emitAuthEvent(onEvent, 'auth_login_started', {
    provider,
    bin,
    args,
    command,
    stdioMode: resolvedStdioMode,
    launchMode: commandConfig.launchMode,
    openBrowser,
    deviceCode: provider === 'codex' && Boolean(deviceCode),
    supportsCodePaste: commandConfig.supportsCodePaste,
    supportsBrowserDeeplink: commandConfig.supportsBrowserDeeplink,
    instruction: commandConfig.instruction
  });

  output?.write?.(
    `[auth] ${provider}: starting ${command}\n` +
      `[auth] ${provider}: ${commandConfig.instruction}\n`
  );

  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer: any = null;
    let inputWasPiped = false;
    const restoreInput = prepareInputForProviderCli(input);

    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: resolvedStdioMode === 'inherit' ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      windowsHide: false
    });

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (inputWasPiped) {
        try {
          input.unpipe(child.stdin);
        } catch {
          // Ignore unpipe errors after child exit.
        }
      }
      restoreInput();
      emitAuthEvent(onEvent, 'auth_login_completed', result);
      resolve(result);
    };

    child.on('error', (error) => {
      finish({
        provider,
        bin,
        args,
        status: (error as any)?.code === 'ENOENT' ? 'missing' : 'error',
        durationMs: Date.now() - startedAt,
        detail: error instanceof Error ? error.message : String(error),
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        openedUrls,
        stdioMode: resolvedStdioMode
      });
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      output?.write?.(chunk);
      void openDetectedUrls({
        chunk,
        provider,
        enabled: openBrowser,
        seenUrls,
        openedUrls,
        opener,
        onEvent
      });
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
      output?.write?.(chunk);
      void openDetectedUrls({
        chunk,
        provider,
        enabled: openBrowser,
        seenUrls,
        openedUrls,
        opener,
        onEvent
      });
    });

    child.on('close', (code, signal) => {
      const detail = code === 0
        ? ''
        : signal
          ? `Exited with signal ${signal}.`
          : `Exited with code ${code}.`;
      finish({
        provider,
        bin,
        args,
        status: code === 0 ? 'ok' : 'error',
        durationMs: Date.now() - startedAt,
        detail,
        exitCode: code,
        signal,
        stdout,
        stderr,
        openedUrls,
        stdioMode: resolvedStdioMode
      });
    });

    child.stdin?.on('error', () => {
      // Provider CLIs may close stdin once browser/deeplink auth completes.
    });

    if (resolvedStdioMode === 'pipe' && child.stdin && (input?.readableEnded || input?.destroyed)) {
      child.stdin.end();
    } else if (resolvedStdioMode === 'pipe' && input?.pipe && child.stdin) {
      input.pipe(child.stdin, { end: !input.isTTY });
      inputWasPiped = true;
    } else if (resolvedStdioMode === 'pipe' && child.stdin) {
      child.stdin.end();
    }

    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
        finish({
          provider,
          bin,
          args,
          status: 'timeout',
          durationMs: Date.now() - startedAt,
          detail: `Timed out after ${Math.round(timeoutMs / 1_000)}s.`,
          exitCode: null,
          signal: 'SIGTERM',
          stdout,
          stderr,
          openedUrls,
          stdioMode: resolvedStdioMode
        });
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

export function renderProviderSocialLoginResult(result: any = {}) {
  const lines = [
    `Social login: ${result.success ? 'completed' : 'needs attention'}`
  ];

  for (const provider of result.providers || []) {
    const opened = provider.openedUrls?.length
      ? ` opened:${provider.openedUrls.length}`
      : '';
    lines.push(
      `- ${provider.provider}: ${provider.status}${opened}${provider.detail ? ` (${provider.detail})` : ''}`
    );
  }

  return lines.join('\n');
}

export async function openBrowserUrl(url) {
  const command = browserOpenCommand(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function browserOpenCommand(url) {
  if (process.platform === 'darwin') {
    return { command: 'open', args: [url] };
  }

  if (process.platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', url] };
  }

  return { command: 'xdg-open', args: [url] };
}

async function openDetectedUrls({
  chunk,
  provider,
  enabled,
  seenUrls,
  openedUrls,
  opener,
  onEvent
}: any) {
  if (!enabled) {
    return;
  }

  for (const url of extractAuthUrls(chunk)) {
    if (seenUrls.has(url)) {
      continue;
    }
    seenUrls.add(url);
    openedUrls.push(url);
    emitAuthEvent(onEvent, 'auth_login_url_opened', {
      provider,
      url
    });
    try {
      await opener(url);
    } catch (error) {
      emitAuthEvent(onEvent, 'auth_login_url_open_failed', {
        provider,
        url,
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function extractAuthUrls(text) {
  const matches = String(text || '').match(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"')]+/gi) || [];
  return matches
    .map((url) => url.replace(/[.,;:]+$/, ''))
    .filter((url) => /^(https?|codex|openai|claude|anthropic|gemini|google):\/\//i.test(url));
}

function normalizeProviderList(providers) {
  const values = Array.isArray(providers)
    ? providers
    : String(providers || '')
        .split(',')
        .map((provider) => provider.trim())
        .filter(Boolean);
  const unique = [...new Set(values.map((provider) => provider.toLowerCase()))];
  const invalid = unique.filter((provider) => !SOCIAL_LOGIN_PROVIDERS.includes(provider));

  if (invalid.length > 0) {
    throw new Error(`Unsupported social-login provider: ${invalid.join(', ')}`);
  }

  return unique;
}

function resolveProviderBinary(provider, env) {
  const config = PROVIDER_BINS[provider];
  const override = env?.[config.envVar];
  return override && override.trim() ? override.trim() : config.defaultBin;
}

function emitAuthEvent(onEvent, type, payload) {
  onEvent({
    type,
    at: new Date().toISOString(),
    ...payload
  });
}

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

function resolveStdioMode({ requested, input, output }) {
  if (requested === 'inherit' || requested === 'pipe') {
    return requested;
  }

  return input?.isTTY && output?.isTTY ? 'inherit' : 'pipe';
}

function prepareInputForProviderCli(input) {
  if (!input) {
    return () => {};
  }

  const hadRawMode = Boolean(input.isRaw);
  if (typeof input.setRawMode === 'function' && input.isTTY) {
    try {
      input.setRawMode(false);
    } catch {
      // Some terminals report raw-mode support but reject transitions.
    }
  }

  try {
    input.resume?.();
  } catch {
    // Ignore resume errors; child stdio will still determine interactivity.
  }

  return () => {
    if (typeof input.setRawMode === 'function' && input.isTTY) {
      try {
        input.setRawMode(hadRawMode);
      } catch {
        // Leave stdin as-is when the terminal refuses restoration.
      }
    }
  };
}
