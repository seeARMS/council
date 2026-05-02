import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCouncilEnvironment, runCli } from '../test-support/fake-clis.js';

const cwd = process.cwd();

test('CLI help prints examples and exits successfully', async () => {
  const result = await runCli(['--help'], {
    cwd,
    env: process.env
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /\nExamples:\n/);
  assert.match(result.stdout, /Examples:/);
  assert.match(result.stdout, /--json-stream/);
});

test('headless mode prints only the final synthesis and suppresses the banner', async () => {
  const fake = await createFakeCouncilEnvironment({
    codex: {
      member: { output: 'codex member' },
      summary: { output: 'summary via codex' }
    }
  });

  try {
    const result = await runCli(['--headless', '--codex', '--no-claude', '--no-gemini', 'hello'], {
      cwd,
      env: fake.env
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), 'summary via codex');
    assert.equal(result.stderr.includes('consult codex + claude + gemini'), false);
  } finally {
    await fake.cleanup();
  }
});

test('json-stream mode emits JSONL lifecycle events', async () => {
  const fake = await createFakeCouncilEnvironment({
    codex: {
      member: { output: 'codex member' },
      summary: { output: 'summary via codex' }
    }
  });

  try {
    const result = await runCli(['--json-stream', '--codex', '--no-claude', '--no-gemini', 'hello'], {
      cwd,
      env: fake.env
    });

    assert.equal(result.code, 0);
    const eventTypes = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).type);

    assert.deepEqual(eventTypes, [
      'run_started',
      'iteration_started',
      'member_started',
      'member_completed',
      'iteration_completed',
      'summary_started',
      'summary_completed',
      'run_completed'
    ]);
  } finally {
    await fake.cleanup();
  }
});

test('auth-login can run by itself without corrupting JSON output', async () => {
  const fake = await createFakeCouncilEnvironment({
    codex: {
      member: {
        stdoutPrefix: 'Visit https://example.com/auth\\n',
        output: 'unused'
      }
    }
  });

  try {
    const result = await runCli([
      '--json',
      '--auth-login',
      '--auth-login-providers',
      'codex',
      '--no-auth-open-browser',
      '--no-claude',
      '--no-gemini'
    ], {
      cwd,
      env: fake.env
    });

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.success, true);
    assert.equal(parsed.providers[0].provider, 'codex');
    assert.equal(parsed.providers[0].status, 'ok');
    assert.match(result.stderr, /Visit https:\/\/example\.com\/auth/);
  } finally {
    await fake.cleanup();
  }
});

test('per-tool flags disable unselected tools', async () => {
  const fake = await createFakeCouncilEnvironment({
    codex: {
      member: { output: 'codex member' },
      summary: { output: 'summary via codex' }
    },
    claude: {
      member: { output: 'claude member' }
    }
  });

  try {
    const result = await runCli(['--json', '--no-claude', '--no-gemini', 'hello'], {
      cwd,
      env: fake.env
    });

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.membersRequested, ['codex']);
    assert.equal(parsed.members.length, 1);
    assert.equal(parsed.members[0].name, 'codex');
  } finally {
    await fake.cleanup();
  }
});

test('verbose mode shows all member responses, including failures', async () => {
  const fake = await createFakeCouncilEnvironment({
    codex: {
      member: { output: 'codex member' },
      summary: { output: 'summary via codex' }
    },
    claude: {
      member: { mode: 'timeout' }
    }
  });

  try {
    const result = await runCli(['--verbose', '--timeout', '2', '--no-gemini', 'hello'], {
      cwd,
      env: fake.env
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /codex member/);
    assert.match(result.stdout, /claude \(timeout: Timed out after 2s\.\)/);
    assert.match(result.stdout, /\(no output\)/);
    assert.match(result.stdout, /synthesis via codex/);
  } finally {
    await fake.cleanup();
  }
});
