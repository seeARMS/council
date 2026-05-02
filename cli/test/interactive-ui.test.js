import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStudioSetting,
  buildInteractiveBlocks,
  buildStudioSettings,
  createStudioConfig,
  createInitialExpanded,
  moveStudioPane,
  sanitizeImmediateFollowUpChunk,
  shouldUseInteractiveDashboard,
  toggleExpanded
} from '../src/interactive-ui.js';
import { buildHotkeyParts } from '../src/presentation.js';
import { hydrateSessionStateFromResult } from '../src/session-core.js';

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

test('createInitialExpanded starts with all rows collapsed when there is no synthesis body', () => {
  const expanded = createInitialExpanded();

  assert.equal(expanded.size, 0);
});

test('createInitialExpanded expands synthesis when review content exists', () => {
  const expanded = createInitialExpanded('Synthesized answer');

  assert.equal(expanded.has('summary'), true);
});

test('toggleExpanded adds missing ids and removes existing ids', () => {
  const once = toggleExpanded(new Set(), 'member:codex');
  assert.equal(once.has('member:codex'), true);

  const twice = toggleExpanded(once, 'member:codex');
  assert.equal(twice.has('member:codex'), false);
});

test('sanitizeImmediateFollowUpChunk keeps printable text from raw follow-up input chunks', () => {
  assert.equal(sanitizeImmediateFollowUpChunk('paste this'), 'paste this');
  assert.equal(sanitizeImmediateFollowUpChunk('multi\nline\ttext'), 'multi\nline\ttext');
  assert.equal(sanitizeImmediateFollowUpChunk('\u0007beep'), 'beep');
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

test('buildInteractiveBlocks keeps member output on the row when expanded', () => {
  const result = createResultFixture();
  const state = hydrateSessionStateFromResult(result, ['codex', 'claude']);
  const expanded = toggleExpanded(createInitialExpanded(), 'member:codex');

  const blocks = buildInteractiveBlocks({
    phase: 'review',
    state,
    members: ['codex', 'claude'],
    expanded
  });
  const ids = blocks.map((block) => block.id);
  const codexRow = blocks.find((block) => block.id === 'row:codex');
  const summaryRow = blocks.find((block) => block.id === 'row:summary');

  assert.deepEqual(ids, [
    'header',
    'row:codex',
    'row:claude',
    'divider:summary',
    'row:summary'
  ]);
  assert.equal(codexRow?.expanded, true);
  assert.equal(codexRow?.body, 'Codex member output');
  assert.equal(codexRow?.previewText, 'Codex member output');
  assert.equal(summaryRow?.expanded, false);
});

test('buildInteractiveBlocks expands synthesis on its own row without adding a duplicate block', () => {
  const result = createResultFixture();
  const state = hydrateSessionStateFromResult(result, ['codex', 'claude']);
  const expanded = toggleExpanded(createInitialExpanded(), 'summary');

  const blocks = buildInteractiveBlocks({
    phase: 'review',
    state,
    members: ['codex', 'claude'],
    expanded
  });
  const ids = blocks.map((block) => block.id);
  const summaryRow = blocks.find((block) => block.id === 'row:summary');

  assert.deepEqual(ids, [
    'header',
    'row:codex',
    'row:claude',
    'divider:summary',
    'row:summary'
  ]);
  assert.equal(summaryRow?.expanded, true);
  assert.equal(summaryRow?.body, 'Synthesized answer');
  assert.equal(summaryRow?.previewText, null);
});

test('studio config builds editable settings from CLI options', () => {
  const config = createStudioConfig({
    members: ['codex', 'claude'],
    lead: 'claude',
    planner: 'codex',
    handoff: true,
    iterations: 2,
    teamWork: 1,
    teams: {
      claude: 3
    },
    permissions: {
      codex: 'workspace-write',
      claude: 'acceptEdits'
    },
    auths: {
      claude: 'oauth'
    }
  });
  const settings = buildStudioSettings(config);

  assert.deepEqual(config.members, ['codex', 'claude']);
  assert.equal(config.lead, 'claude');
  assert.equal(config.planner, 'codex');
  assert.equal(config.teams.claude, 3);
  assert.equal(config.auths.claude, 'oauth');
  assert.equal(settings.find((setting) => setting.id === 'handoff')?.value, 'on');
  assert.equal(settings.find((setting) => setting.id === 'codexSandbox')?.value, 'workspace-write');
  assert.equal(settings.find((setting) => setting.id === 'claudeAuth')?.value, 'oauth');
});

test('studio settings cycle workflow values and keep roles valid', () => {
  const config = createStudioConfig({
    members: ['codex', 'claude'],
    lead: 'claude'
  });

  const noLead = applyStudioSetting(config, 'lead', 1);
  const nextLead = applyStudioSetting(noLead, 'lead', 1);
  const moreIterations = applyStudioSetting(config, 'iterations', 1);
  const nextClaudeAuth = applyStudioSetting(config, 'claudeAuth', 1);

  assert.equal(noLead.lead, null);
  assert.equal(nextLead.lead, 'codex');
  assert.equal(moreIterations.iterations, 2);
  assert.equal(nextClaudeAuth.auths.claude, 'oauth');
});

test('studio pane movement reorders focused panes', () => {
  assert.deepEqual(
    moveStudioPane(['menu', 'settings', 'agents', 'results'], 'agents', -1),
    ['menu', 'agents', 'settings', 'results']
  );
});
