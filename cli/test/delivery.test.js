import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeliveryPhasePrompt,
  renderDeliveryProgressEvent,
  runLinearDelivery
} from '../src/delivery.js';
import { fetchLinearIssues } from '../src/linear.js';

const issue = {
  id: 'issue-id',
  identifier: 'ENG-123',
  title: 'Fix flaky test',
  description: 'The migration test fails intermittently.',
  priority: 1,
  url: 'https://linear.app/acme/issue/ENG-123',
  branchName: 'eng-123-fix-flaky-test',
  state: 'Todo',
  team: 'ENG',
  assignee: 'Dvir',
  labels: ['bug'],
  createdAt: '2026-05-02T00:00:00Z',
  updatedAt: '2026-05-02T00:00:00Z'
};

test('fetchLinearIssues fetches explicit Linear issue identifiers', async () => {
  const calls = [];
  const issues = await fetchLinearIssues({
    issueIds: ['ENG-123'],
    apiKey: 'test-linear-key',
    fetchFn: async (url, request) => {
      calls.push({ url, request });
      return {
        ok: true,
        json: async () => ({
          data: {
            issue: {
              ...issue,
              state: { name: issue.state },
              team: { key: issue.team, name: 'Engineering' },
              assignee: { name: issue.assignee, email: 'dvir@example.com' },
              labels: { nodes: [{ name: 'bug' }] }
            }
          }
        })
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].request.body, /CouncilLinearIssue/);
  assert.equal(calls[0].request.headers.authorization, 'test-linear-key');
  assert.equal(issues[0].identifier, 'ENG-123');
  assert.deepEqual(issues[0].labels, ['bug']);
});

test('buildDeliveryPhasePrompt includes testing and GitHub delivery expectations', () => {
  const verify = buildDeliveryPhasePrompt({
    phase: 'verify',
    issue,
    members: ['codex', 'claude', 'gemini'],
    planner: 'codex',
    lead: 'gemini'
  });
  const ship = buildDeliveryPhasePrompt({
    phase: 'ship',
    issue,
    members: ['codex', 'claude', 'gemini'],
    planner: 'codex',
    lead: 'codex'
  });

  assert.match(verify, /Run the relevant tests/);
  assert.match(ship, /open or update the GitHub PR/);
  assert.match(ship, /scan for secrets/);
  assert.match(ship, /Linear\/GitHub-ready proof of work/);
});

test('runLinearDelivery runs phase-based council delivery for each issue', async () => {
  const phaseQueries = [];
  const result = await runLinearDelivery({
    cwd: process.cwd(),
    baseQuery: 'Keep it small',
    delivery: {
      issueIds: ['ENG-123'],
      phases: ['plan', 'verify'],
      apiKeyEnv: 'TEST_LINEAR_KEY'
    },
    env: {
      TEST_LINEAR_KEY: 'test-linear-key'
    },
    fetchFn: async () => ({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            ...issue,
            state: { name: issue.state },
            labels: { nodes: [] }
          }
        }
      })
    }),
    runner: async (options) => {
      phaseQueries.push(options.query);
      return {
        summary: {
          status: 'ok',
          name: options.lead,
          output: 'done'
        }
      };
    },
    members: ['codex', 'gemini'],
    planner: 'codex'
  });

  assert.equal(result.success, true);
  assert.equal(result.issueCount, 1);
  assert.equal(phaseQueries.length, 2);
  assert.match(phaseQueries[0], /Council phase: plan/);
  assert.match(phaseQueries[1], /Council phase: verify/);
});

test('runLinearDelivery stops later phases after a failed phase', async () => {
  const phases = [];
  const result = await runLinearDelivery({
    delivery: {
      issueIds: ['ENG-123'],
      phases: ['plan', 'implement', 'verify'],
      apiKeyEnv: 'TEST_LINEAR_KEY'
    },
    env: {
      TEST_LINEAR_KEY: 'test-linear-key'
    },
    fetchFn: async () => ({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            ...issue,
            state: { name: issue.state },
            labels: { nodes: [] }
          }
        }
      })
    }),
    runner: async (options) => {
      const phase = /Council phase: (\w+)/.exec(options.query)?.[1];
      phases.push(phase);
      return {
        summary: {
          status: phase === 'implement' ? 'error' : 'ok',
          name: options.lead,
          output: 'phase result'
        }
      };
    }
  });

  assert.equal(result.success, false);
  assert.deepEqual(phases, ['plan', 'implement']);
  assert.deepEqual(
    result.issues[0].phases.map((phase) => phase.phase),
    ['plan', 'implement']
  );
});

test('renderDeliveryProgressEvent returns readable delivery progress', () => {
  assert.equal(
    renderDeliveryProgressEvent({
      type: 'delivery_phase_completed',
      issue,
      phase: 'verify',
      success: true
    }),
    '[delivery] ENG-123: verify ok'
  );
});
