import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, usageText } from '../src/args.js';
import { DEFAULT_TIMEOUT_MS } from '../src/engines.js';

test('parses help subcommand without treating it as a query', () => {
  const parsed = parseArgs(['help']);

  assert.equal(parsed.help, true);
  assert.deepEqual(parsed.members, ['codex', 'claude', 'gemini']);
});

test('keeps help-like and version-like prompt text as prompt input', () => {
  const helpPrompt = parseArgs(['help', 'me', 'debug']);
  const versionPrompt = parseArgs(['version', 'mismatch', 'analysis']);

  assert.equal(helpPrompt.help, false);
  assert.deepEqual(helpPrompt.promptParts, ['help', 'me', 'debug']);

  assert.equal(versionPrompt.version, false);
  assert.deepEqual(versionPrompt.promptParts, ['version', 'mismatch', 'analysis']);
});

test('supports per-tool toggles and explicit summarizer selection', () => {
  const parsed = parseArgs([
    '--no-gemini',
    '--claude',
    '--summarizer',
    'claude',
    '--timeout',
    '42',
    'review',
    'this'
  ]);

  assert.deepEqual(parsed.members, ['codex', 'claude']);
  assert.equal(parsed.summarizer, 'claude');
  assert.equal(parsed.timeoutMs, 42_000);
  assert.deepEqual(parsed.promptParts, ['review', 'this']);
});

test('uses a 10 minute timeout by default', () => {
  const parsed = parseArgs(['review', 'this']);

  assert.equal(parsed.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(parsed.timeoutMs, 600_000);
});

test('help text documents the 10 minute default timeout', () => {
  const help = usageText('0.0.0');

  assert.match(help, /\nExamples:\n/);
  assert.match(help, /default: 600 \/ 10 minutes/);
});

test('supports headless automation flags and response caps', () => {
  const parsed = parseArgs([
    '--headless',
    '--studio',
    '--json-stream',
    '--plain',
    '--no-banner',
    '--color=never',
    '--max-member-chars=2048',
    'hello'
  ]);

  assert.equal(parsed.headless, true);
  assert.equal(parsed.studio, true);
  assert.equal(parsed.jsonStream, true);
  assert.equal(parsed.plain, true);
  assert.equal(parsed.noBanner, true);
  assert.equal(parsed.color, 'never');
  assert.equal(parsed.maxMemberChars, 2048);
});

test('members list replaces previous tool toggles and preserves the requested order', () => {
  const parsed = parseArgs(['--no-codex', '--members', 'gemini,claude', 'question']);

  assert.deepEqual(parsed.members, ['gemini', 'claude']);
});

test('later per-tool toggles append after an explicit members list', () => {
  const parsed = parseArgs(['--members', 'gemini,claude', '--codex', 'question']);

  assert.deepEqual(parsed.members, ['gemini', 'claude', 'codex']);
});

test('throws when all engines are disabled', () => {
  assert.throws(
    () => parseArgs(['--no-codex', '--no-claude', '--no-gemini', 'question']),
    /At least one engine must be enabled/
  );
});

test('parses --effort and validates allowed values', () => {
  assert.equal(parseArgs(['question']).effort, null);
  assert.equal(parseArgs(['--effort', 'low', 'q']).effort, 'low');
  assert.equal(parseArgs(['--effort', 'medium', 'q']).effort, 'medium');
  assert.equal(parseArgs(['--effort', 'high', 'q']).effort, 'high');

  assert.throws(
    () => parseArgs(['--effort', 'turbo', 'q']),
    /Unsupported --effort value/
  );
});

test('parses provider-specific model and effort flags', () => {
  const parsed = parseArgs([
    '--codex-model',
    'gpt-5.2',
    '--claude-model=opus',
    '--gemini-model',
    'gemini-3-pro-preview',
    '--codex-effort',
    'xhigh',
    '--claude-effort',
    'max',
    '--gemini-effort',
    'high',
    'question'
  ]);

  assert.deepEqual(parsed.models, {
    codex: 'gpt-5.2',
    claude: 'opus',
    gemini: 'gemini-3-pro-preview'
  });
  assert.deepEqual(parsed.efforts, {
    codex: 'xhigh',
    claude: 'max',
    gemini: 'high'
  });
});

test('validates provider-specific effort values against each provider', () => {
  assert.throws(
    () => parseArgs(['--gemini-effort', 'max', 'q']),
    /Unsupported --gemini-effort value/
  );
  assert.throws(
    () => parseArgs(['--claude-effort', 'turbo', 'q']),
    /Unsupported --claude-effort value/
  );
});

test('parses provider-specific permission flags', () => {
  const parsed = parseArgs([
    '--codex-sandbox',
    'workspace-write',
    '--claude-permission-mode',
    'acceptEdits',
    'question'
  ]);

  assert.deepEqual(parsed.permissions, {
    codex: 'workspace-write',
    claude: 'acceptEdits',
    gemini: null
  });
});

test('parses provider-specific auth flags', () => {
  const parsed = parseArgs([
    '--codex-auth',
    'social-login',
    '--claude-auth',
    'social-login',
    '--gemini-auth',
    'social-login',
    'question'
  ]);

  assert.deepEqual(parsed.auths, {
    codex: 'social-login',
    claude: 'social-login',
    gemini: 'social-login'
  });
});

test('validates provider-specific auth values', () => {
  assert.throws(
    () => parseArgs(['--claude-auth', 'saml', 'q']),
    /Unsupported --claude-auth value/
  );
});

test('parses social-login bootstrap flags', () => {
  const parsed = parseArgs([
    '--auth-login',
    '--auth-login-providers',
    'codex,GEMINI',
    '--auth-device-code',
    '--no-auth-open-browser',
    '--auth-timeout',
    '12',
    'question'
  ]);

  assert.deepEqual(parsed.authLogin, {
    enabled: true,
    providers: ['codex', 'gemini'],
    deviceCode: true,
    openBrowser: false,
    timeoutMs: 12_000
  });
});

test('validates provider-specific permission values', () => {
  assert.throws(
    () => parseArgs(['--codex-sandbox', 'auto', 'q']),
    /Unsupported --codex-sandbox value/
  );
  assert.throws(
    () => parseArgs(['--claude-permission-mode', 'root', 'q']),
    /Unsupported --claude-permission-mode value/
  );
});

test('parses repeatable prompt file and command context flags', () => {
  const parsed = parseArgs([
    '--file',
    'README.md',
    '--tag-file',
    'cli/README.md,cli/package.json',
    '--cmd',
    'git status --short',
    '--prompt-command',
    'npm test',
    'question'
  ]);

  assert.deepEqual(parsed.promptContext.files, [
    'README.md',
    'cli/README.md',
    'cli/package.json'
  ]);
  assert.deepEqual(parsed.promptContext.commands, [
    'git status --short',
    'npm test'
  ]);
});

test('parses Linear delivery options', () => {
  const parsed = parseArgs([
    '--deliver-linear',
    '--linear-issue',
    'ABC-1,ABC-2',
    '--linear-team',
    'ENG',
    '--linear-state',
    'Todo',
    '--linear-assignee',
    'Dvir',
    '--linear-limit',
    '2',
    '--linear-api-key-env',
    'TEST_LINEAR_KEY',
    '--linear-auth',
    'oauth',
    '--linear-oauth-token-env',
    'TEST_LINEAR_OAUTH',
    '--linear-watch',
    '--linear-poll-interval',
    '5',
    '--linear-max-polls',
    '4',
    '--linear-max-concurrency',
    '2',
    '--linear-max-attempts',
    '5',
    '--linear-retry-base',
    '10',
    '--linear-state-file',
    '.state.json',
    '--linear-workspace-root',
    '.workspaces',
    '--linear-observability-dir',
    '.events',
    '--linear-workspace-strategy',
    'copy',
    '--linear-workflow-file',
    'WORKFLOW.md',
    '--linear-attach-media',
    'out.png,https://example.com/demo.mp4',
    '--linear-attach-media',
    'proof.pdf',
    '--linear-attachment-title',
    'Council proof',
    '--delivery-phases',
    'plan,verify',
    'ship it'
  ]);

  assert.equal(parsed.delivery.enabled, true);
  assert.deepEqual(parsed.delivery.issueIds, ['ABC-1', 'ABC-2']);
  assert.equal(parsed.delivery.team, 'ENG');
  assert.equal(parsed.delivery.state, 'Todo');
  assert.equal(parsed.delivery.assignee, 'Dvir');
  assert.equal(parsed.delivery.limit, 2);
  assert.equal(parsed.delivery.apiKeyEnv, 'TEST_LINEAR_KEY');
  assert.equal(parsed.delivery.authMethod, 'oauth');
  assert.equal(parsed.delivery.oauthTokenEnv, 'TEST_LINEAR_OAUTH');
  assert.equal(parsed.delivery.watch, true);
  assert.equal(parsed.delivery.pollIntervalMs, 5_000);
  assert.equal(parsed.delivery.maxPolls, 4);
  assert.equal(parsed.delivery.maxConcurrency, 2);
  assert.equal(parsed.delivery.maxAttempts, 5);
  assert.equal(parsed.delivery.retryBaseMs, 10_000);
  assert.equal(parsed.delivery.stateFile, '.state.json');
  assert.equal(parsed.delivery.workspaceRoot, '.workspaces');
  assert.equal(parsed.delivery.observabilityDir, '.events');
  assert.equal(parsed.delivery.workspaceStrategy, 'copy');
  assert.equal(parsed.delivery.workflowFile, 'WORKFLOW.md');
  assert.deepEqual(parsed.delivery.attachMedia, [
    'out.png',
    'https://example.com/demo.mp4',
    'proof.pdf'
  ]);
  assert.equal(parsed.delivery.attachmentTitle, 'Council proof');
  assert.deepEqual(parsed.delivery.phases, ['plan', 'verify']);
});

test('parses Linear setup and status without delivery prompt text', () => {
  assert.equal(parseArgs(['--linear-setup']).delivery.setup, true);
  assert.equal(parseArgs(['--linear-status']).delivery.status, true);
});

test('parses workflow, iteration, and team-work flags', () => {
  const parsed = parseArgs([
    '--planner',
    'codex',
    '--lead',
    'claude',
    '--handoff',
    '--iterations',
    '3',
    '--team-work',
    '2',
    '--codex-sub-agents',
    '4',
    'question'
  ]);

  assert.equal(parsed.planner, 'codex');
  assert.equal(parsed.lead, 'claude');
  assert.equal(parsed.handoff, true);
  assert.equal(parsed.iterations, 3);
  assert.equal(parsed.teamWork, 2);
  assert.deepEqual(parsed.teams, {
    codex: 4,
    claude: null,
    gemini: null
  });
});

test('validates workflow role and numeric flags', () => {
  assert.throws(
    () => parseArgs(['--lead', 'llama', 'q']),
    /Unsupported --lead value/
  );
  assert.throws(
    () => parseArgs(['--no-claude', '--lead', 'claude', 'q']),
    /--lead must be one of the enabled members/
  );
  assert.throws(
    () => parseArgs(['--iterations', '0', 'q']),
    /--iterations requires a positive integer/
  );
  assert.throws(
    () => parseArgs(['--team-work=-1', 'q']),
    /--team-work requires a non-negative integer/
  );
});
