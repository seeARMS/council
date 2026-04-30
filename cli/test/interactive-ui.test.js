import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  applyInteractiveEvent,
  createInteractiveDashboard,
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
  assert.match(lines.join('\n'), /Type a\s+follow-up/);
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

test('interactive snapshot always displays a separated synthesis row', () => {
  const state = createInteractiveState(['codex', 'claude']);

  const lines = renderInteractiveSnapshot(state, {
    width: 80
  });

  assert.match(lines.join('\n'), /\n\n----------- synthesis -----------\n3\. \[sum\] synthesis\n\nWaiting for council members to finish/);
});

test('interactive snapshot keeps synthesis expanded by default once it has output', () => {
  const state = createInteractiveState(['codex']);

  applyInteractiveEvent(state, {
    type: 'summary_started',
    name: 'codex',
    at: '2026-04-30T12:00:00.000Z'
  });
  applyInteractiveEvent(state, {
    type: 'summary_completed',
    at: '2026-04-30T12:00:03.000Z',
    result: {
      name: 'codex',
      status: 'ok',
      durationMs: 3000,
      output: 'Summary line one.\nSummary line two.'
    }
  });

  const lines = renderInteractiveSnapshot(state, {
    width: 80
  });

  assert.match(lines.join('\n'), /\[expanded\]/);
  assert.match(lines.join('\n'), /Summary line one\./);
});

test('interactive snapshot shows hotkeys before completion when some results are expandable', () => {
  const state = createInteractiveState(['codex', 'gemini']);

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
      output: 'Done.'
    }
  });
  applyInteractiveEvent(state, {
    type: 'member_started',
    name: 'gemini',
    at: '2026-04-30T12:00:00.000Z'
  });

  const lines = renderInteractiveSnapshot(state, {
    width: 80
  });

  assert.match(lines.join('\n'), /Hotkeys: 1 codex/);
  assert.match(lines.join('\n'), /Waiting for council members to finish\. Press a number to expand or\s+collapse\s+available results\./);
});

test('interactive dashboard accepts expand hotkeys before the run is complete', () => {
  const writes = [];
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.resume = () => {};
  input.pause = () => {};
  input.setRawMode = (value) => {
    input.isRaw = value;
  };

  const dashboard = createInteractiveDashboard({
    stream: {
      columns: 90,
      write(text) {
        writes.push(text);
      }
    },
    input,
    members: ['codex', 'gemini']
  });

  dashboard.start();
  dashboard.handleEvent({
    type: 'member_started',
    name: 'codex',
    at: '2026-04-30T12:00:00.000Z'
  });
  dashboard.handleEvent({
    type: 'member_completed',
    at: '2026-04-30T12:00:03.000Z',
    result: {
      name: 'codex',
      status: 'ok',
      durationMs: 3000,
      output: 'Line one.\nLine two.'
    }
  });
  dashboard.handleEvent({
    type: 'member_started',
    name: 'gemini',
    at: '2026-04-30T12:00:00.000Z'
  });

  input.emit('data', Buffer.from('1'));
  dashboard.dispose();

  assert.match(writes.at(-1) || '', /\[expanded\]/);
  assert.match(writes.at(-1) || '', /Line one\./);
});

test('rendered lines never exceed the requested width (otherwise terminal soft-wraps drift the redraw)', () => {
  const state = createInteractiveState(['codex', 'claude', 'gemini']);
  const at = '2026-04-30T12:00:00.000Z';

  applyInteractiveEvent(state, { type: 'member_started', name: 'codex', at });
  applyInteractiveEvent(state, {
    type: 'member_completed',
    at,
    result: {
      name: 'codex',
      status: 'ok',
      durationMs: 56_100,
      output:
        'Short answer: no, not on your own. In the U.S., Align says the only whitening product approved for use with Invisalign aligners is the Invisalign Professional Whitening System.'
    }
  });

  const stripAnsi = (s) => s.replace(/\[[0-9;]*[A-Za-z]/g, '');
  for (const width of [60, 80, 100, 120]) {
    const lines = renderInteractiveSnapshot(state, { width, colorEnabled: false });
    for (const line of lines) {
      assert.ok(
        stripAnsi(line).length <= width,
        `line "${line}" exceeds width=${width} (was ${stripAnsi(line).length})`
      );
    }
  }
});

test('interactive snapshot caps frame height to the terminal rows to avoid scrollback duplication', () => {
  const state = createInteractiveState(['codex', 'claude', 'gemini']);
  const at = '2026-04-30T12:00:00.000Z';

  applyInteractiveEvent(state, { type: 'member_started', name: 'codex', at });
  applyInteractiveEvent(state, { type: 'member_started', name: 'claude', at });
  applyInteractiveEvent(state, { type: 'member_started', name: 'gemini', at });
  applyInteractiveEvent(state, {
    type: 'member_completed',
    at: '2026-04-30T12:00:14.800Z',
    result: {
      name: 'claude',
      status: 'ok',
      durationMs: 14_800,
      output: 'A long answer that wraps onto a second collapsed preview line for sure here.'
    }
  });
  applyInteractiveEvent(state, {
    type: 'member_progress',
    name: 'gemini',
    at,
    detail: 'Attempt 1 failed: model capacity exhausted (429). Retrying with backoff...'
  });

  const uncapped = renderInteractiveSnapshot(state, { width: 100 });
  assert.ok(uncapped.length > 8, 'precondition: uncapped frame is taller than the cap we will apply');

  const capped = renderInteractiveSnapshot(state, { width: 100, rows: 8 });
  assert.equal(capped.length, 8);
  assert.match(capped[0], /Council is consulting:/);
  assert.equal(capped[1], '...');
});

test('interactive dashboard does not rewrite an identical frame for a no-op event', () => {
  const writes = [];
  const dashboard = createInteractiveDashboard({
    stream: {
      columns: 80,
      write(text) {
        writes.push(text);
      }
    },
    input: {
      isTTY: false
    },
    members: ['codex']
  });

  dashboard.start();
  dashboard.handleEvent({
    type: 'run_started',
    at: '2026-04-30T12:00:00.000Z',
    members: ['codex'],
    summarizer: 'auto'
  });
  dashboard.dispose();

  assert.equal(writes.length, 1);
});
