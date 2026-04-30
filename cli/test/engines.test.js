import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMemberPrompt,
  buildSummaryPrompt,
  parseClaudeOutput,
  parseGeminiOutput,
  runEngine
} from '../src/engines.js';
import { createFakeCouncilEnvironment } from '../test-support/fake-clis.js';

test('buildMemberPrompt tells upstream tools to answer directly without self-introductions', () => {
  const prompt = buildMemberPrompt('testing you out');

  assert.match(prompt, /Answer the user query directly/);
  assert.match(prompt, /Do not introduce yourself/);
  assert.match(prompt, /Current user query:\ntesting you out/);
});

test('buildMemberPrompt includes recent conversation context for follow-up turns', () => {
  const prompt = buildMemberPrompt('What about the timeout?', {
    conversation: [
      {
        user: 'Why is it hanging?',
        assistant: 'Claude is hanging because it needs --bare.'
      }
    ]
  });

  assert.match(prompt, /Conversation so far:/);
  assert.match(prompt, /User: Why is it hanging\?/);
  assert.match(prompt, /Council: Claude is hanging because it needs --bare\./);
  assert.match(prompt, /Current user query:\nWhat about the timeout\?/);
});

test('buildSummaryPrompt truncates long member outputs before summarization', () => {
  const prompt = buildSummaryPrompt(
    'What should we do?',
    [
      {
        name: 'codex',
        output: 'a'.repeat(80)
      }
    ],
    {
      maxMemberChars: 20
    }
  );

  assert.match(prompt, /\[truncated by council after 20 characters\]/);
});

test('parseClaudeOutput extracts the final result from JSON', () => {
  const output = parseClaudeOutput('{"result":"claude answer"}');
  assert.equal(output, 'claude answer');
});

test('parseGeminiOutput extracts JSON even with noisy prefixes', () => {
  const output = parseGeminiOutput(
    'Ripgrep is not available. Falling back to GrepTool.\\n{"response":"gemini answer"}'
  );
  assert.equal(output, 'gemini answer');
});

test('runEngine returns timeout for a hanging CLI', async () => {
  const fake = await createFakeCouncilEnvironment({
    codex: {
      member: {
        mode: 'timeout'
      }
    }
  });

  try {
    const result = await runEngine('codex', {
      prompt: 'hello',
      cwd: process.cwd(),
      timeoutMs: 50,
      env: fake.env
    });

    assert.equal(result.status, 'timeout');
    assert.match(result.detail, /Timed out/i);
  } finally {
    await fake.cleanup();
  }
});

test('runEngine returns missing when the binary path is not executable', async () => {
  const fake = await createFakeCouncilEnvironment({});

  try {
    const result = await runEngine('gemini', {
      prompt: 'hello',
      cwd: process.cwd(),
      timeoutMs: 500,
      env: fake.env
    });

    assert.equal(result.status, 'missing');
  } finally {
    await fake.cleanup();
  }
});

test('runEngine fails fast when gemini requires interactive login', async () => {
  const fake = await createFakeCouncilEnvironment({
    gemini: {
      member: {
        mode: 'hang',
        stdoutPrefix: 'Opening authentication page in your browser. Do you want to continue? [Y/n]: '
      }
    }
  });
  const startedAt = Date.now();

  try {
    const result = await runEngine('gemini', {
      prompt: 'hello',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: fake.env
    });

    assert.equal(result.status, 'error');
    assert.match(result.detail, /requires login/i);
    assert.match(result.detail, /Run `gemini`/);
    assert.ok(Date.now() - startedAt < 2_500);
  } finally {
    await fake.cleanup();
  }
});

test('runEngine passes the gemini prompt through -p instead of stdin', async () => {
  const fake = await createFakeCouncilEnvironment({
    gemini: {
      member: {
        mode: 'echo-prompt-sources'
      }
    }
  });

  try {
    const result = await runEngine('gemini', {
      prompt: 'line one\nline two',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: fake.env
    });

    assert.equal(result.status, 'ok');
    const sources = JSON.parse(result.output);
    assert.equal(sources.promptArg, 'line one\nline two');
    assert.equal(sources.stdin, '');
  } finally {
    await fake.cleanup();
  }
});
