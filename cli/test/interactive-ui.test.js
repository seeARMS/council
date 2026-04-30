import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyInteractiveEvent,
  createInteractiveState,
  renderInteractiveSnapshot,
  shouldUseInteractiveDashboard,
  toggleInteractiveItem
} from '../src/interactive-ui.js';

test('shouldUseInteractiveDashboard only enables the live dashboard for interactive text mode', () => {
  assert.equal(
    shouldUseInteractiveDashboard(
      {
        outputMode: 'text',
        showProgress: true,
        summaryOnly: false,
        plain: false
      },
      {
        stdinIsTTY: true
      }
    ),
    true
  );

  assert.equal(
    shouldUseInteractiveDashboard(
      {
        outputMode: 'json',
        showProgress: true,
        summaryOnly: false,
        plain: false
      },
      {
        stdinIsTTY: true
      }
    ),
    false
  );
});

test('interactive snapshot shows a two-line truncated preview for completed items', () => {
  const state = createInteractiveState(['codex']);

  applyInteractiveEvent(state, {
    type: 'member_started',
    name: 'codex',
    at: '2026-04-30T12:00:00.000Z'
  });
  applyInteractiveEvent(state, {
    type: 'member_completed',
    at: '2026-04-30T12:00:03.000Z',
    result: {
      name: 'codex',
      status: 'ok',
      durationMs: 3000,
      output: 'This is a longer result from codex that should wrap onto multiple lines and get truncated cleanly.'
    }
  });

  const lines = renderInteractiveSnapshot(state, {
    width: 50
  });
  const itemLines = lines.filter((line) => line.includes('1. [ok]') || line.startsWith('                    '));

  assert.equal(itemLines.length, 2);
  assert.match(itemLines[0], /1\. \[ok\].*codex \(3\.0s\): "This is a/);
  assert.match(itemLines[1], /\.\.\.$/);
});

test('interactive snapshot can expand a completed item through its hotkey mapping', () => {
  const state = createInteractiveState(['codex']);

  applyInteractiveEvent(state, {
    type: 'member_started',
    name: 'codex',
    at: '2026-04-30T12:00:00.000Z'
  });
  applyInteractiveEvent(state, {
    type: 'member_completed',
    at: '2026-04-30T12:00:03.000Z',
    result: {
      name: 'codex',
      status: 'ok',
      durationMs: 3000,
      output: 'Line one.\nLine two.\nLine three.'
    }
  });
  applyInteractiveEvent(state, {
    type: 'run_completed',
    at: '2026-04-30T12:00:05.000Z',
    success: true
  });

  assert.equal(toggleInteractiveItem(state, '1'), true);

  const lines = renderInteractiveSnapshot(state, {
    width: 60
  });

  assert.match(lines.join('\n'), /\[expanded\]/);
  assert.match(lines.join('\n'), /Line one\./);
  assert.match(lines.join('\n'), /Hotkeys:/);
  assert.match(lines.join('\n'), /Type a follow-up/);
});

test('interactive snapshot shows retry progress for a running member', () => {
  const state = createInteractiveState(['gemini']);
  const startedAt = new Date().toISOString();

  applyInteractiveEvent(state, {
    type: 'member_started',
    name: 'gemini',
    at: startedAt
  });
  applyInteractiveEvent(state, {
    type: 'member_progress',
    name: 'gemini',
    at: startedAt,
    detail: 'Attempt 1 failed: model capacity exhausted (429). Retrying with backoff...'
  });

  const lines = renderInteractiveSnapshot(state, {
    width: 90
  });

  assert.match(lines.join('\n'), /\[run\] gemini \(\d+\.\d+s\): "Attempt 1 failed: model capacity exhausted \(429\)\./);
  assert.match(lines.join('\n'), /Retrying with\s+backoff/);
});
