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

test('resolveUiOptions suppresses the banner in studio mode', () => {
  const ui = resolveUiOptions(
    {
      json: false,
      jsonStream: false,
      headless: false,
      studio: true,
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

  assert.equal(ui.studio, true);
  assert.equal(ui.showBanner, false);
  assert.equal(ui.showProgress, true);
});

test('renderBanner includes the council title art', () => {
  const banner = renderBanner();
  assert.match(banner, /Council Studio/);
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

test('renderProgressEvent handles auth login commands without arguments', () => {
  const line = renderProgressEvent({
    type: 'auth_login_started',
    provider: 'gemini',
    bin: 'gemini',
    args: []
  });

  assert.equal(line, '[auth] gemini: opening social login (gemini)');
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
    workflow: {
      handoff: true,
      lead: 'codex',
      planner: 'claude',
      iterations: 2,
      teamWork: 1,
      teams: {
        codex: 1,
        claude: 0,
        gemini: 0
      }
    },
    members: [
      {
        name: 'codex',
        status: 'ok',
        durationMs: 1_000,
        output: 'member output',
        role: 'lead',
        teamSize: 1
      }
    ],
    summary: {
      name: 'codex',
      status: 'ok',
      durationMs: 2_000,
      output: 'summary output'
    }
  });

  assert.match(output, /Workflow: lead:codex \| planner:claude \| handoff:on \| iterations:2 \| team:codex:1/);
  assert.match(output, /\n=== codex \[lead,team:1\] \(1\.0s\) ===\nmember output/);
  assert.match(output, /\n=== synthesis via codex \(2\.0s\) ===\nsummary output$/);
});
