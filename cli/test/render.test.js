import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHumanResult } from '../src/render.js';
import { renderBanner, renderProgressEvent, resolveUiOptions } from '../src/ui.js';

test('resolveUiOptions makes headless runs summary-only and suppresses the banner', () => {
  const ui = resolveUiOptions(
    {
      json: false,
      jsonStream: false,
      headless: true,
      plain: false,
      summaryOnly: false,
      quiet: false,
      noBanner: false,
      color: 'auto'
    },
    {
      stdoutIsTTY: true,
      stderrIsTTY: true,
      env: {}
    }
  );

  assert.equal(ui.headless, true);
  assert.equal(ui.summaryOnly, true);
  assert.equal(ui.showBanner, false);
});

test('renderBanner includes the council title art', () => {
  const banner = renderBanner();
  assert.match(banner, /____/);
  assert.match(banner, /consult codex \+ claude \+ gemini/i);
});

test('renderProgressEvent describes member completion', () => {
  const line = renderProgressEvent({
    type: 'member_completed',
    result: {
      name: 'claude',
      status: 'ok',
      durationMs: 1200
    }
  });

  assert.match(line, /\[ok\]/);
  assert.match(line, /claude/);
});

test('renderHumanResult shows summary failure details in summary-only mode', () => {
  const output = renderHumanResult(
    {
      members: [],
      summary: {
        name: 'gemini',
        status: 'error',
        detail: 'API failure'
      }
    },
    {
      summaryOnly: true
    }
  );

  assert.equal(output, 'Summary failed via gemini: API failure');
});

test('renderHumanResult uses actual newlines in text output', () => {
  const output = renderHumanResult({
    members: [
      {
        name: 'codex',
        status: 'ok',
        durationMs: 1_000,
        output: 'member output'
      }
    ],
    summary: {
      name: 'codex',
      status: 'ok',
      durationMs: 2_000,
      output: 'summary output'
    }
  });

  assert.match(output, /\n=== codex \(1\.0s\) ===\nmember output/);
  assert.match(output, /\n=== synthesis via codex \(2\.0s\) ===\nsummary output$/);
});
