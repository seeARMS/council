import test from 'node:test';
import assert from 'node:assert/strict';
import { runCouncil } from '../src/council.js';
import { createFakeCouncilEnvironment } from '../test-support/fake-clis.js';

test('auto summarizer prefers the first successful engine in priority order', async () => {
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
    const result = await runCouncil({
      query: 'How should I name this function?',
      cwd: process.cwd(),
      members: ['codex', 'claude', 'gemini'],
      summarizer: 'auto',
      timeoutMs: 5_000,
      env: fake.env
    });

    assert.equal(result.members.find((member) => member.name === 'gemini')?.status, 'missing');
    assert.equal(result.summary.status, 'ok');
    assert.equal(result.summary.name, 'codex');
    assert.equal(result.summary.output, 'summary via codex');
  } finally {
    await fake.cleanup();
  }
});

test('explicit summarizer can run even when it was not one of the consulted members', async () => {
  const fake = await createFakeCouncilEnvironment({
    codex: {
      member: { output: 'codex member' }
    },
    gemini: {
      summary: {
        output: 'summary via gemini',
        stdoutPrefix: 'Ripgrep is not available. Falling back to GrepTool.\\n'
      }
    }
  });

  try {
    const result = await runCouncil({
      query: 'What is the tradeoff?',
      cwd: process.cwd(),
      members: ['codex'],
      summarizer: 'gemini',
      timeoutMs: 5_000,
      env: fake.env
    });

    assert.equal(result.summary.status, 'ok');
    assert.equal(result.summary.name, 'gemini');
    assert.equal(result.summary.output, 'summary via gemini');
  } finally {
    await fake.cleanup();
  }
});

test('auto summarizer falls back when the preferred summary attempt fails', async () => {
  const fake = await createFakeCouncilEnvironment({
    codex: {
      member: { output: 'codex member' },
      summary: { mode: 'error', stderr: 'codex summary failed', exitCode: 9 }
    },
    claude: {
      member: { output: 'claude member' },
      summary: { output: 'summary via claude' }
    }
  });

  try {
    const result = await runCouncil({
      query: 'Compare the options',
      cwd: process.cwd(),
      members: ['codex', 'claude'],
      summarizer: 'auto',
      timeoutMs: 5_000,
      env: fake.env
    });

    assert.equal(result.summaryAttempts.length, 2);
    assert.equal(result.summaryAttempts[0].name, 'codex');
    assert.equal(result.summaryAttempts[0].status, 'error');
    assert.equal(result.summary.name, 'claude');
    assert.equal(result.summary.status, 'ok');
  } finally {
    await fake.cleanup();
  }
});

test('runCouncil emits lifecycle events for members and synthesis', async () => {
  const fake = await createFakeCouncilEnvironment({
    codex: {
      member: { output: 'codex member' },
      summary: { output: 'summary via codex' }
    }
  });
  const events = [];

  try {
    await runCouncil({
      query: 'Hello',
      cwd: process.cwd(),
      members: ['codex'],
      summarizer: 'auto',
      timeoutMs: 5_000,
      env: fake.env,
      onEvent: (event) => {
        events.push(event.type);
      }
    });

    assert.deepEqual(events, ['run_started', 'member_started', 'member_completed', 'summary_started', 'summary_completed', 'run_completed']);
  } finally {
    await fake.cleanup();
  }
});

test('returns a summary failure when no member is available', async () => {
  const fake = await createFakeCouncilEnvironment({});

  try {
    const result = await runCouncil({
      query: 'Anyone there?',
      cwd: process.cwd(),
      members: ['codex', 'claude', 'gemini'],
      summarizer: 'auto',
      timeoutMs: 5_000,
      env: fake.env
    });

    assert.equal(result.members.every((member) => member.status === 'missing'), true);
    assert.equal(result.summary.status, 'error');
    assert.match(result.summary.detail, /No council member/i);
  } finally {
    await fake.cleanup();
  }
});

test('runCouncil surfaces gemini login errors without blocking synthesis', async () => {
  const fake = await createFakeCouncilEnvironment({
    codex: {
      member: { output: 'codex member' },
      summary: { output: 'summary via codex' }
    },
    gemini: {
      member: {
        mode: 'hang',
        stdoutPrefix: 'Opening authentication page in your browser. Do you want to continue? [Y/n]: '
      }
    }
  });

  try {
    const result = await runCouncil({
      query: 'Can you answer this?',
      cwd: process.cwd(),
      members: ['codex', 'gemini'],
      summarizer: 'auto',
      timeoutMs: 5_000,
      env: fake.env
    });

    const gemini = result.members.find((member) => member.name === 'gemini');
    assert.equal(gemini?.status, 'error');
    assert.match(gemini?.detail || '', /requires login/i);
    assert.equal(result.summary.status, 'ok');
    assert.equal(result.summary.name, 'codex');
  } finally {
    await fake.cleanup();
  }
});

test('returns gemini login guidance when it is the only failed member', async () => {
  const fake = await createFakeCouncilEnvironment({
    gemini: {
      member: {
        mode: 'hang',
        stdoutPrefix: 'Opening authentication page in your browser. Do you want to continue? [Y/n]: '
      }
    }
  });

  try {
    const result = await runCouncil({
      query: 'Can you answer this?',
      cwd: process.cwd(),
      members: ['gemini'],
      summarizer: 'auto',
      timeoutMs: 5_000,
      env: fake.env
    });

    assert.equal(result.summary.status, 'error');
    assert.match(result.summary.detail, /requires login/i);
    assert.match(result.summary.detail, /Run `gemini`/);
  } finally {
    await fake.cleanup();
  }
});

test('runCouncil emits gemini retry progress while the member is still running', async () => {
  const fake = await createFakeCouncilEnvironment({
    gemini: {
      member: {
        mode: 'hang',
        stderr:
          'Attempt 1 failed with status 429. Retrying with backoff...\\n' +
          'No capacity available for model gemini-3.1-pro-preview on the server\\n'
      }
    }
  });
  const events = [];

  try {
    await runCouncil({
      query: 'Hello',
      cwd: process.cwd(),
      members: ['gemini'],
      summarizer: 'auto',
      timeoutMs: 500,
      env: fake.env,
      onEvent: (event) => {
        events.push(event);
      }
    });

    const progressEvent = events.find((event) => event.type === 'member_progress');
    assert.ok(progressEvent);
    assert.equal(progressEvent?.name, 'gemini');
    assert.match(progressEvent?.detail || '', /model capacity exhausted \(429\)/i);
    assert.match(progressEvent?.detail || '', /Retrying with backoff/i);
  } finally {
    await fake.cleanup();
  }
});
