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
    '--json-stream',
    '--plain',
    '--no-banner',
    '--color=never',
    '--max-member-chars=2048',
    'hello'
  ]);

  assert.equal(parsed.headless, true);
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
