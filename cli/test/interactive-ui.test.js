import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHotkeyParts,
  buildStaticBlocks,
  createInitialExpanded,
  shouldUseInteractiveDashboard,
  toggleExpanded
} from '../src/interactive-ui.js';

function createResultFixture() {
  return {
    members: [
      {
        name: 'codex',
        status: 'ok',
        durationMs: 1200,
        output: 'Codex member output'
      },
      {
        name: 'claude',
        status: 'ok',
        durationMs: 1500,
        output: 'Claude member output'
      }
    ],
    summary: {
      name: 'gemini',
      status: 'ok',
      durationMs: 1800,
      output: 'Synthesized answer'
    }
  };
}

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

test('createInitialExpanded starts with the synthesis block expanded when text exists', () => {
  const expanded = createInitialExpanded(createResultFixture());

  assert.equal(expanded.has('summary'), true);
});

test('toggleExpanded adds missing ids and removes existing ids', () => {
  const once = toggleExpanded(new Set(), 'member:codex');
  assert.equal(once.has('member:codex'), true);

  const twice = toggleExpanded(once, 'member:codex');
  assert.equal(twice.has('member:codex'), false);
});

test('buildHotkeyParts includes synthesis in the live hotkey legend', () => {
  assert.deepEqual(buildHotkeyParts(['codex', 'claude']), [
    '1 codex',
    '2 claude',
    '3 synthesis'
  ]);
});

test('buildHotkeyParts marks expanded rows in the static hotkey legend', () => {
  const expanded = new Set(['member:codex', 'summary']);

  assert.deepEqual(buildHotkeyParts(['codex', 'claude'], expanded), [
    '1 codex (shown)',
    '2 claude',
    '3 synthesis (shown)'
  ]);
});

test('buildStaticBlocks places expanded member output inline under its row', () => {
  const result = createResultFixture();
  const expanded = toggleExpanded(createInitialExpanded(result), 'member:codex');

  const ids = buildStaticBlocks(result, ['codex', 'claude'], expanded).map(
    (block) => block.id
  );

  assert.deepEqual(ids, [
    'header',
    'row:codex',
    'member:codex',
    'row:claude',
    'divider:summary',
    'row:summary',
    'summary'
  ]);
});

test('buildStaticBlocks removes the synthesis body when the summary hotkey is toggled off', () => {
  const result = createResultFixture();
  const expanded = toggleExpanded(createInitialExpanded(result), 'summary');

  const ids = buildStaticBlocks(result, ['codex', 'claude'], expanded).map(
    (block) => block.id
  );

  assert.deepEqual(ids, [
    'header',
    'row:codex',
    'row:claude',
    'divider:summary',
    'row:summary'
  ]);
});
