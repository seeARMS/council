import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseInteractiveDashboard } from '../src/interactive-ui.js';

test('shouldUseInteractiveDashboard only enables the live dashboard for interactive text mode', () => {
  assert.equal(
    shouldUseInteractiveDashboard(
      {
        outputMode: 'text',
        showProgress: true,
        summaryOnly: false,
        plain: false
      },
      { stdinIsTTY: true }
    ),
    true
  );
});

test('shouldUseInteractiveDashboard is disabled outside text mode', () => {
  assert.equal(
    shouldUseInteractiveDashboard(
      {
        outputMode: 'json',
        showProgress: true,
        summaryOnly: false,
        plain: false
      },
      { stdinIsTTY: true }
    ),
    false
  );
});

test('shouldUseInteractiveDashboard is disabled without a TTY', () => {
  assert.equal(
    shouldUseInteractiveDashboard(
      {
        outputMode: 'text',
        showProgress: true,
        summaryOnly: false,
        plain: false
      },
      { stdinIsTTY: false }
    ),
    false
  );
});

test('shouldUseInteractiveDashboard is disabled in plain mode', () => {
  assert.equal(
    shouldUseInteractiveDashboard(
      {
        outputMode: 'text',
        showProgress: true,
        summaryOnly: false,
        plain: true
      },
      { stdinIsTTY: true }
    ),
    false
  );
});

test('shouldUseInteractiveDashboard is disabled in summary-only mode', () => {
  assert.equal(
    shouldUseInteractiveDashboard(
      {
        outputMode: 'text',
        showProgress: true,
        summaryOnly: true,
        plain: false
      },
      { stdinIsTTY: true }
    ),
    false
  );
});
