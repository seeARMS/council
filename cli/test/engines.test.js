import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('buildMemberPrompt includes role, iteration, handoff, and team context', () => {
  const prompt = buildMemberPrompt('Ship it', {
    role: 'lead',
    lead: 'claude',
    planner: 'codex',
    iteration: 2,
    totalIterations: 3,
    handoff: true,
    teamSize: 2,
    planOutput: 'Inspect the failing test first.',
    previousResponses: [
      {
        name: 'codex',
        role: 'planner',
        status: 'ok',
        output: 'Use the smallest patch.'
      }
    ]
  });

  assert.match(prompt, /iteration 2 of 3/);
  assert.match(prompt, /Lead model: claude/);
  assert.match(prompt, /Planner model: codex/);
  assert.match(prompt, /Your assigned role: lead/);
  assert.match(prompt, /Team work: you may coordinate up to 2 internal sub-agents/);
  assert.match(prompt, /Planner handoff:\nInspect the failing test first/);
  assert.match(prompt, /Earlier council handoffs:/);
  assert.match(prompt, /### codex \(planner\)/);
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

test('buildSummaryPrompt includes workflow context', () => {
  const prompt = buildSummaryPrompt(
    'What should we do?',
    [
      {
        name: 'claude',
        output: 'ship it'
      }
    ],
    {
      lead: 'claude',
      planner: 'codex',
      iterations: 2,
      handoff: true,
      teams: {
        codex: 1,
        claude: 2,
        gemini: 0
      }
    }
  );

  assert.match(prompt, /2 iterations, handoff enabled/);
  assert.match(prompt, /Lead model: claude/);
  assert.match(prompt, /Planner model: codex/);
  assert.match(prompt, /Team sizes: codex:1, claude:2, gemini:0/);
});

test('parseClaudeOutput extracts the final result from JSON', () => {
  const output = parseClaudeOutput('{"result":"claude answer"}');
  assert.equal(output, 'claude answer');
});

test('parseClaudeOutput extracts the final result from stream-json output', () => {
  const output = parseClaudeOutput(
    [
      '{"type":"system","subtype":"status","status":"requesting"}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}}',
      '{"type":"result","result":"claude streamed answer"}'
    ].join('\n')
  );
  assert.equal(output, 'claude streamed answer');
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

test('runEngine forwards --effort to codex via -c model_reasoning_effort', async () => {
  const fake = await createFakeCouncilEnvironment({
    codex: { member: { mode: 'echo-argv' } }
  });

  try {
    const result = await runEngine('codex', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: fake.env,
      effort: 'high'
    });

    assert.equal(result.status, 'ok');
    const argv = JSON.parse(result.output);
    const idx = argv.indexOf('-c');
    assert.ok(idx >= 0, 'codex did not receive -c');
    assert.equal(argv[idx + 1], 'model_reasoning_effort=high');
  } finally {
    await fake.cleanup();
  }
});

test('runEngine forwards Codex sandbox permissions', async () => {
  const fake = await createFakeCouncilEnvironment({
    codex: { member: { mode: 'echo-argv' } }
  });

  try {
    const result = await runEngine('codex', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: fake.env,
      permission: 'workspace-write'
    });

    assert.equal(result.status, 'ok');
    const argv = JSON.parse(result.output);
    const idx = argv.indexOf('--sandbox');
    assert.ok(idx >= 0, 'codex did not receive --sandbox');
    assert.equal(argv[idx + 1], 'workspace-write');
  } finally {
    await fake.cleanup();
  }
});

test('runEngine forwards --effort to claude via --effort', async () => {
  const fake = await createFakeCouncilEnvironment({
    claude: { member: { mode: 'echo-argv' } }
  });

  try {
    const result = await runEngine('claude', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: fake.env,
      effort: 'medium'
    });

    assert.equal(result.status, 'ok');
    const argv = JSON.parse(result.output);
    const idx = argv.indexOf('--effort');
    assert.ok(idx >= 0, 'claude did not receive --effort');
    assert.equal(argv[idx + 1], 'medium');
  } finally {
    await fake.cleanup();
  }
});

test('runEngine forwards Claude permission mode', async () => {
  const fake = await createFakeCouncilEnvironment({
    claude: { member: { mode: 'echo-argv' } }
  });

  try {
    const result = await runEngine('claude', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: fake.env,
      permission: 'acceptEdits'
    });

    assert.equal(result.status, 'ok');
    const argv = JSON.parse(result.output);
    const idx = argv.indexOf('--permission-mode');
    assert.ok(idx >= 0, 'claude did not receive --permission-mode');
    assert.equal(argv[idx + 1], 'acceptEdits');
  } finally {
    await fake.cleanup();
  }
});

test('runEngine keeps claude --bare for API-key auth', async () => {
  const fake = await createFakeCouncilEnvironment({
    claude: { member: { mode: 'echo-argv' } }
  });

  try {
    const result = await runEngine('claude', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: {
        ...fake.env,
        ANTHROPIC_API_KEY: 'test-api-key'
      }
    });

    assert.equal(result.status, 'ok');
    const argv = JSON.parse(result.output);
    assert.equal(argv.includes('--bare'), true);
  } finally {
    await fake.cleanup();
  }
});

test('runEngine omits claude --bare when API-key auth is absent', async () => {
  const fake = await createFakeCouncilEnvironment({
    claude: { member: { mode: 'echo-argv' } }
  });

  try {
    const result = await runEngine('claude', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: {
        ...fake.env,
        ANTHROPIC_API_KEY: ''
      }
    });

    assert.equal(result.status, 'ok');
    const argv = JSON.parse(result.output);
    assert.equal(argv.includes('--bare'), false);
  } finally {
    await fake.cleanup();
  }
});

test('runEngine omits claude --bare when CLAUDE_CODE_OAUTH_TOKEN is present', async () => {
  const fake = await createFakeCouncilEnvironment({
    claude: { member: { mode: 'echo-argv' } }
  });

  try {
    const result = await runEngine('claude', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: {
        ...fake.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token'
      }
    });

    assert.equal(result.status, 'ok');
    const argv = JSON.parse(result.output);
    assert.equal(argv.includes('--bare'), false);
  } finally {
    await fake.cleanup();
  }
});

test('runEngine can force Claude API-key auth mode', async () => {
  const fake = await createFakeCouncilEnvironment({
    claude: { member: { mode: 'echo-argv' } }
  });

  try {
    const result = await runEngine('claude', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: {
        ...fake.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token'
      },
      auth: 'api-key'
    });

    assert.equal(result.status, 'ok');
    const argv = JSON.parse(result.output);
    assert.equal(argv.includes('--bare'), true);
  } finally {
    await fake.cleanup();
  }
});

test('runEngine can force Claude OAuth auth mode', async () => {
  const fake = await createFakeCouncilEnvironment({
    claude: { member: { mode: 'echo-argv' } }
  });

  try {
    const result = await runEngine('claude', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: {
        ...fake.env,
        ANTHROPIC_API_KEY: 'test-api-key'
      },
      auth: 'oauth'
    });

    assert.equal(result.status, 'ok');
    const argv = JSON.parse(result.output);
    assert.equal(argv.includes('--bare'), false);
  } finally {
    await fake.cleanup();
  }
});

test('runEngine can force Claude social-login auth mode', async () => {
  const fake = await createFakeCouncilEnvironment({
    claude: { member: { mode: 'echo-argv' } }
  });

  try {
    const result = await runEngine('claude', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: {
        ...fake.env,
        ANTHROPIC_API_KEY: 'test-api-key'
      },
      auth: 'social-login'
    });

    assert.equal(result.status, 'ok');
    const argv = JSON.parse(result.output);
    assert.equal(argv.includes('--bare'), false);
  } finally {
    await fake.cleanup();
  }
});

test('runEngine forwards CLAUDE_CODE_EFFORT_LEVEL to claude when no effort option is set', async () => {
  const fake = await createFakeCouncilEnvironment({
    claude: { member: { mode: 'echo-argv' } }
  });

  try {
    const result = await runEngine('claude', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: {
        ...fake.env,
        CLAUDE_CODE_EFFORT_LEVEL: 'max'
      }
    });

    assert.equal(result.status, 'ok');
    const argv = JSON.parse(result.output);
    const idx = argv.indexOf('--effort');
    assert.ok(idx >= 0, 'claude did not receive --effort');
    assert.equal(argv[idx + 1], 'max');
  } finally {
    await fake.cleanup();
  }
});

test('runEngine forwards provider model flags', async () => {
  const fake = await createFakeCouncilEnvironment({
    codex: { member: { mode: 'echo-argv' } },
    claude: { member: { mode: 'echo-argv' } },
    gemini: { member: { mode: 'echo-argv' } }
  });

  try {
    const codexResult = await runEngine('codex', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: fake.env,
      model: 'gpt-5.2'
    });
    const codexArgv = JSON.parse(codexResult.output);
    const codexModelIdx = codexArgv.indexOf('--model');
    assert.ok(codexModelIdx >= 0, 'codex did not receive --model');
    assert.equal(codexArgv[codexModelIdx + 1], 'gpt-5.2');

    const claudeResult = await runEngine('claude', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: fake.env,
      model: 'opus'
    });
    const claudeArgv = JSON.parse(claudeResult.output);
    const claudeModelIdx = claudeArgv.indexOf('--model');
    assert.ok(claudeModelIdx >= 0, 'claude did not receive --model');
    assert.equal(claudeArgv[claudeModelIdx + 1], 'opus');

    const geminiResult = await runEngine('gemini', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: fake.env,
      model: 'gemini-3-pro-preview'
    });
    const geminiArgv = JSON.parse(geminiResult.output);
    const geminiModelIdx = geminiArgv.indexOf('--model');
    assert.ok(geminiModelIdx >= 0, 'gemini did not receive --model');
    assert.equal(geminiArgv[geminiModelIdx + 1], 'gemini-3-pro-preview');
  } finally {
    await fake.cleanup();
  }
});

test('runEngine forwards --effort to gemini via thinkingBudget settings (no model swap)', async () => {
  const fake = await createFakeCouncilEnvironment({
    gemini: { member: { mode: 'echo-env' } }
  });

  try {
    const result = await runEngine('gemini', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: fake.env,
      effort: 'medium'
    });

    assert.equal(result.status, 'ok');
    const payload = JSON.parse(result.output);
    assert.ok(payload.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'env var not set');
    assert.ok(payload.settingsContent, 'settings file not readable from spawned process');
    const settings = JSON.parse(payload.settingsContent);
    assert.equal(settings.thinkingBudget, 8192);
    // Should NOT have swapped the model.
    assert.equal(payload.argv.includes('-m'), false);
    assert.equal(payload.argv.includes('--model'), false);
  } finally {
    await fake.cleanup();
  }
});

test('runEngine preserves existing gemini settings when adding thinkingBudget', async () => {
  const fake = await createFakeCouncilEnvironment({
    gemini: { member: { mode: 'echo-env' } }
  });
  const settingsDir = await mkdtemp(path.join(tmpdir(), 'council-gemini-settings-'));
  const existingSettingsPath = path.join(settingsDir, 'settings.json');
  const existingSettings = {
    model: 'gemini-2.5-pro',
    proxy: 'http://localhost:8080'
  };
  await writeFile(existingSettingsPath, JSON.stringify(existingSettings), 'utf8');

  try {
    const result = await runEngine('gemini', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: {
        ...fake.env,
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: existingSettingsPath
      },
      effort: 'low'
    });

    assert.equal(result.status, 'ok');
    const payload = JSON.parse(result.output);
    const mergedSettings = JSON.parse(payload.settingsContent);
    assert.equal(mergedSettings.model, existingSettings.model);
    assert.equal(mergedSettings.proxy, existingSettings.proxy);
    assert.equal(mergedSettings.thinkingBudget, 1024);
    assert.notEqual(payload.GEMINI_CLI_SYSTEM_SETTINGS_PATH, existingSettingsPath);

    const originalSettings = JSON.parse(
      await readFile(existingSettingsPath, 'utf8')
    );
    assert.deepEqual(originalSettings, existingSettings);
  } finally {
    await fake.cleanup();
    await rm(settingsDir, { recursive: true, force: true });
  }
});

test('runEngine omits gemini effort settings when no effort is set', async () => {
  const fake = await createFakeCouncilEnvironment({
    gemini: { member: { mode: 'echo-env' } }
  });

  try {
    const result = await runEngine('gemini', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: fake.env
    });

    assert.equal(result.status, 'ok');
    const payload = JSON.parse(result.output);
    assert.equal(payload.GEMINI_CLI_SYSTEM_SETTINGS_PATH, null);
  } finally {
    await fake.cleanup();
  }
});

test('runEngine omits effort flags when no effort is set', async () => {
  const fake = await createFakeCouncilEnvironment({
    codex: { member: { mode: 'echo-argv' } },
    claude: { member: { mode: 'echo-argv' } },
    gemini: { member: { mode: 'echo-argv' } }
  });

  try {
    const codexResult = await runEngine('codex', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: fake.env
    });
    const codexArgv = JSON.parse(codexResult.output);
    assert.equal(
      codexArgv.includes('model_reasoning_effort=low'),
      false
    );

    const claudeResult = await runEngine('claude', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: fake.env
    });
    const claudeArgv = JSON.parse(claudeResult.output);
    assert.equal(claudeArgv.includes('--effort'), false);

    const geminiResult = await runEngine('gemini', {
      prompt: 'hi',
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: fake.env
    });
    const geminiArgv = JSON.parse(geminiResult.output);
    assert.equal(geminiArgv.includes('-m'), false);
  } finally {
    await fake.cleanup();
  }
});
