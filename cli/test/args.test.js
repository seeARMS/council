import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';

test('parses help subcommand without treating it as a query', () => {
  const parsed = parseArgs(['help']);

  assert.equal(parsed.help, true);
  assert.deepEqual(parsed.members, ['codex', 'claude', 'gemini']);
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

test('members list replaces previous tool toggles', () => {
  const parsed = parseArgs(['--no-codex', '--members', 'gemini,claude', 'question']);

  assert.deepEqual(parsed.members, ['claude', 'gemini']);
});

test('throws when all engines are disabled', () => {
  assert.throws(
    () => parseArgs(['--no-codex', '--no-claude', '--no-gemini', 'question']),
    /At least one engine must be enabled/
  );
});
