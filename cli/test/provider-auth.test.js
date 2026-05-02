import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  renderProviderSocialLoginResult,
  resolveSocialLoginProviders,
  runProviderSocialLogin,
  socialLoginCommandForProvider
} from '../src/provider-auth.js';

test('resolves social-login providers from auth preferences', () => {
  assert.deepEqual(
    resolveSocialLoginProviders({
      members: ['codex', 'claude', 'gemini'],
      auths: {
        codex: 'api-key',
        claude: 'social-login',
        gemini: 'social-login'
      }
    }),
    ['claude', 'gemini']
  );

  assert.deepEqual(
    resolveSocialLoginProviders({
      members: ['codex', 'gemini'],
      auths: {}
    }),
    ['codex', 'gemini']
  );

  assert.deepEqual(
    resolveSocialLoginProviders({
      members: ['codex', 'claude', 'gemini'],
      providers: 'GEMINI,codex'
    }),
    ['gemini', 'codex']
  );
});

test('maps providers to native social-login commands', () => {
  assert.deepEqual(socialLoginCommandForProvider('codex', { deviceCode: true }).args, [
    'login',
    '--device-auth'
  ]);
  assert.deepEqual(socialLoginCommandForProvider('claude').args, ['auth', 'login']);
  assert.deepEqual(socialLoginCommandForProvider('gemini').args, []);
  assert.equal(socialLoginCommandForProvider('gemini').launchMode, 'native-interactive');
});

test('runs provider login with browser URL opening and terminal code paste', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'council-auth-'));
  const fakeAuth = path.join(tempDir, 'fake-auth.mjs');
  await writeFile(
    fakeAuth,
    [
      '#!/usr/bin/env node',
      "process.stdout.write('Visit https://example.com/auth?provider=codex\\n');",
      "process.stdout.write('Deeplink codex://auth/callback?code=test-code\\n');",
      "process.stdout.write('Paste code: ');",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  if (chunk.includes('ABC123')) {",
      "    process.stderr.write('accepted\\n');",
      '    process.exit(0);',
      '  }',
      '});',
      "setTimeout(() => { process.stderr.write('timed out\\n'); process.exit(2); }, 1500);"
    ].join('\n'),
    'utf8'
  );
  await chmod(fakeAuth, 0o755);

  const input = new PassThrough();
  let output = '';
  const outputStream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });
  const openedUrls = [];
  const events = [];

  try {
    const resultPromise = runProviderSocialLogin({
      provider: 'codex',
      cwd: tempDir,
      env: {
        ...process.env,
        COUNCIL_CODEX_BIN: fakeAuth
      },
      input,
      output: outputStream,
      opener: async (url) => {
        openedUrls.push(url);
      },
      stdioMode: 'pipe',
      timeoutMs: 5_000,
      onEvent: (event) => events.push(event)
    });

    setTimeout(() => {
      input.write('ABC123\n');
    }, 50);

    const result = await resultPromise;

    assert.equal(result.status, 'ok');
    assert.deepEqual(openedUrls, [
      'https://example.com/auth?provider=codex',
      'codex://auth/callback?code=test-code'
    ]);
    assert.match(output, /Paste code:/);
    assert.match(output, /accepted/);
    assert.equal(events.at(0)?.type, 'auth_login_started');
    assert.equal(events.at(-1)?.type, 'auth_login_completed');
  } finally {
    input.destroy();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('renders a compact social login result summary', () => {
  const output = renderProviderSocialLoginResult({
    success: true,
    providers: [
      {
        provider: 'codex',
        status: 'ok',
        openedUrls: ['https://example.com/auth']
      }
    ]
  });

  assert.match(output, /Social login: completed/);
  assert.match(output, /codex: ok opened:1/);
});
