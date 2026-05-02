import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildDeliveryPhasePrompt,
  getLinearDeliveryStatus,
  renderDeliveryProgressEvent,
  renderLinearDeliveryStatus,
  runLinearDelivery
} from '../src/delivery.js';
import {
  attachLinearMedia,
  fetchLinearIssues,
  fetchLinearViewer,
  uploadLinearFile
} from '../src/linear.js';

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

test('fetchLinearIssues filters by Linear project and epic parent issue', async () => {
  const calls = [];
  const issues = await fetchLinearIssues({
    projects: ['Migration Project'],
    epics: ['ENG-1'],
    apiKey: 'test-linear-key',
    fetchFn: async (url, request) => {
      calls.push(JSON.parse(request.body));
      return {
        ok: true,
        json: async () => ({
          data: {
            issues: {
              nodes: [
                {
                  ...issue,
                  project: {
                    id: 'project-id',
                    name: 'Migration Project',
                    slug: 'migration-project',
                    url: 'https://linear.app/acme/project/migration'
                  },
                  parent: {
                    id: 'epic-id',
                    identifier: 'ENG-1',
                    title: 'Migration epic',
                    url: 'https://linear.app/acme/issue/ENG-1'
                  },
                  state: { name: issue.state },
                  team: { key: issue.team, name: 'Engineering' },
                  labels: { nodes: [] }
                }
              ]
            }
          }
        })
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls[0].variables.filter), /Migration Project/);
  assert.match(JSON.stringify(calls[0].variables.filter), /ENG-1/);
  assert.equal(issues[0].project.name, 'Migration Project');
  assert.equal(issues[0].epic.identifier, 'ENG-1');
});

test('fetchLinearIssues paginates when fetchAll is enabled', async () => {
  const calls = [];
  const issues = await fetchLinearIssues({
    projects: ['Migration Project'],
    limit: 1,
    fetchAll: true,
    apiKey: 'test-linear-key',
    fetchFn: async (url, request) => {
      const body = JSON.parse(request.body);
      calls.push(body.variables);
      const secondPage = body.variables.after === 'cursor-1';
      return {
        ok: true,
        json: async () => ({
          data: {
            issues: {
              nodes: [
                {
                  ...issue,
                  identifier: secondPage ? 'ENG-124' : 'ENG-123',
                  title: secondPage ? 'Second task' : issue.title,
                  state: { name: issue.state },
                  labels: { nodes: [] }
                }
              ],
              pageInfo: {
                hasNextPage: !secondPage,
                endCursor: secondPage ? null : 'cursor-1'
              }
            }
          }
        })
      };
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].after, null);
  assert.equal(calls[1].after, 'cursor-1');
  assert.deepEqual(issues.map((item) => item.identifier), ['ENG-123', 'ENG-124']);
});

test('fetchLinearViewer supports OAuth bearer authorization', async () => {
  const viewer = await fetchLinearViewer({
    authorization: 'Bearer test-oauth-token',
    fetchFn: async (url, request) => {
      assert.equal(request.headers.authorization, 'Bearer test-oauth-token');
      return {
        ok: true,
        json: async () => ({
          data: {
            viewer: {
              id: 'user-id',
              name: 'Dvir',
              email: 'dvir@example.com'
            }
          }
        })
      };
    }
  });

  assert.equal(viewer.name, 'Dvir');
});

test('uploadLinearFile requests a signed URL and uploads bytes with returned headers', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'council-linear-upload-'));
  const filePath = path.join(tempDir, 'proof.png');
  const calls = [];
  await writeFile(filePath, 'image-bytes', 'utf8');

  try {
    const uploaded = await uploadLinearFile({
      filePath,
      authorization: 'test-linear-key',
      fetchFn: async (url, request) => {
        calls.push({ url, request });
        if (url === 'https://uploads.example/proof') {
          assert.equal(request.method, 'PUT');
          assert.equal(request.headers['x-upload-token'], 'abc');
          return { ok: true, status: 200 };
        }

        assert.match(request.body, /CouncilLinearFileUpload/);
        return {
          ok: true,
          json: async () => ({
            data: {
              fileUpload: {
                success: true,
                uploadFile: {
                  uploadUrl: 'https://uploads.example/proof',
                  assetUrl: 'https://uploads.linear.app/proof',
                  headers: [{ key: 'x-upload-token', value: 'abc' }]
                }
              }
            }
          })
        };
      }
    });

    assert.equal(uploaded.assetUrl, 'https://uploads.linear.app/proof');
    assert.equal(calls.length, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('attachLinearMedia creates Linear attachments for remote URLs', async () => {
  const attachment = await attachLinearMedia({
    issue,
    media: 'https://example.com/demo.mp4',
    authorization: 'test-linear-key',
    titlePrefix: 'Council proof',
    fetchFn: async (url, request) => {
      assert.match(request.body, /CouncilLinearAttachmentCreate/);
      const body = JSON.parse(request.body);
      assert.equal(body.variables.input.issueId, issue.id);
      assert.equal(body.variables.input.url, 'https://example.com/demo.mp4');
      assert.equal(body.variables.input.title, 'Council proof: demo.mp4');
      return {
        ok: true,
        json: async () => ({
          data: {
            attachmentCreate: {
              success: true,
              attachment: {
                id: 'attachment-id',
                title: body.variables.input.title,
                url: body.variables.input.url
              }
            }
          }
        })
      };
    }
  });

  assert.equal(attachment.attachment.id, 'attachment-id');
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
  const tempDir = await mkdtemp(path.join(tmpdir(), 'council-delivery-'));
  const phaseQueries = [];
  try {
    const result = await runLinearDelivery({
      cwd: tempDir,
      baseQuery: 'Keep it small',
      delivery: {
        issueIds: ['ENG-123'],
        phases: ['plan', 'verify'],
        apiKeyEnv: 'TEST_LINEAR_KEY',
        workspaceStrategy: 'none'
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
        assert.equal(options.env.TEST_LINEAR_KEY, 'test-linear-key');
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
    assert.match(await readFile(result.observabilityLog, 'utf8'), /delivery_started/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runLinearDelivery stops later phases after a failed phase', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'council-delivery-'));
  const phases = [];
  try {
    const result = await runLinearDelivery({
      cwd: tempDir,
      delivery: {
        issueIds: ['ENG-123'],
        phases: ['plan', 'implement', 'verify'],
        apiKeyEnv: 'TEST_LINEAR_KEY',
        workspaceStrategy: 'none'
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
    assert.equal(result.issues[0].status, 'retry_wait');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runLinearDelivery can poll repeatedly with isolated workspaces and retry state', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'council-delivery-'));
  const workspaces = [];
  const events = [];
  const phaseQueries = [];
  try {
    const result = await runLinearDelivery({
      cwd: tempDir,
      delivery: {
        issueIds: ['ENG-123'],
        phases: ['plan'],
        apiKeyEnv: 'TEST_LINEAR_KEY',
        watch: true,
        maxPolls: 2,
        pollIntervalMs: 1,
        maxAttempts: 2,
        retryBaseMs: 1,
        workspaceStrategy: 'worktree'
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
      workspaceFactory: async ({ issue }) => {
        const workspace = path.join(tempDir, 'workspace', issue.identifier);
        workspaces.push(workspace);
        return {
          cwd: workspace,
          strategy: 'worktree',
          branch: `council/linear/${issue.identifier.toLowerCase()}`
        };
      },
      sleepFn: async () => {},
      nowFn: (() => {
        let now = Date.parse('2026-05-02T00:00:00Z');
        return () => {
          now += 1000;
          return now;
        };
      })(),
      onEvent: (event) => events.push(event),
      runner: async (options) => {
        phaseQueries.push(options.query);
        return {
          summary: {
            status: phaseQueries.length === 1 ? 'error' : 'ok',
            name: options.lead,
            output: 'phase result'
          }
        };
      }
    });

    assert.equal(result.watch, true);
    assert.equal(result.pollCount, 2);
    assert.equal(phaseQueries.length, 2);
    assert.equal(result.issues.at(-1).success, true);
    assert.equal(workspaces.length, 2);
    assert.equal(events.some((event) => event.type === 'delivery_retry_scheduled'), true);
    const state = JSON.parse(await readFile(result.stateFile, 'utf8'));
    assert.equal(state.issues['ENG-123'].status, 'delivered');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runLinearDelivery can target projects and epics until human review is ready', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'council-delivery-'));
  const phaseQueries = [];
  try {
    const result = await runLinearDelivery({
      cwd: tempDir,
      delivery: {
        projects: ['Migration Project'],
        epics: ['ENG-1'],
        phases: ['ship'],
        apiKeyEnv: 'TEST_LINEAR_KEY',
        watch: true,
        untilComplete: true,
        maxPolls: 5,
        maxAttempts: null,
        pollIntervalMs: 1,
        completionGate: 'human-review',
        workspaceStrategy: 'none'
      },
      env: {
        TEST_LINEAR_KEY: 'test-linear-key'
      },
      fetchFn: async (url, request) => {
        const body = JSON.parse(request.body);
        assert.match(JSON.stringify(body.variables.filter), /Migration Project/);
        assert.match(JSON.stringify(body.variables.filter), /ENG-1/);
        return {
          ok: true,
          json: async () => ({
            data: {
              issues: {
                nodes: [
                  {
                    ...issue,
                    project: {
                      id: 'project-id',
                      name: 'Migration Project',
                      slug: 'migration-project',
                      url: 'https://linear.app/acme/project/migration'
                    },
                    parent: {
                      id: 'epic-id',
                      identifier: 'ENG-1',
                      title: 'Migration epic',
                      url: 'https://linear.app/acme/issue/ENG-1'
                    },
                    state: { name: issue.state },
                    labels: { nodes: [] }
                  }
                ]
              }
            }
          })
        };
      },
      sleepFn: async () => {
        throw new Error('until-complete should not sleep after target completion');
      },
      runner: async (options) => {
        phaseQueries.push(options.query);
        return {
          summary: {
            status: 'ok',
            name: options.lead,
            output: 'Ready for review: https://github.com/acme/repo/pull/42'
          }
        };
      }
    });

    assert.equal(result.success, true);
    assert.equal(result.pollCount, 1);
    assert.equal(result.untilComplete, true);
    assert.equal(result.completionGate, 'human-review');
    assert.equal(result.issues[0].status, 'review_ready');
    assert.match(phaseQueries[0], /Linear project: Migration Project/);
    assert.match(phaseQueries[0], /Linear epic: ENG-1 - Migration epic/);
    const state = JSON.parse(await readFile(result.stateFile, 'utf8'));
    assert.equal(state.issues['ENG-123'].status, 'review_ready');
    assert.equal(state.issues['ENG-123'].prUrl, 'https://github.com/acme/repo/pull/42');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runLinearDelivery scans the full target while dispatching only the configured batch size', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'council-delivery-'));
  const dispatched = [];
  let sleepCount = 0;
  try {
    const result = await runLinearDelivery({
      cwd: tempDir,
      delivery: {
        projects: ['Migration Project'],
        phases: ['ship'],
        apiKeyEnv: 'TEST_LINEAR_KEY',
        watch: true,
        untilComplete: true,
        maxPolls: 5,
        maxAttempts: null,
        limit: 1,
        pollIntervalMs: 1,
        completionGate: 'human-review',
        workspaceStrategy: 'none'
      },
      env: {
        TEST_LINEAR_KEY: 'test-linear-key'
      },
      fetchFn: async (url, request) => {
        const body = JSON.parse(request.body);
        const secondPage = body.variables.after === 'cursor-1';
        return {
          ok: true,
          json: async () => ({
            data: {
              issues: {
                nodes: [
                  {
                    ...issue,
                    identifier: secondPage ? 'ENG-124' : 'ENG-123',
                    title: secondPage ? 'Second task' : issue.title,
                    project: {
                      id: 'project-id',
                      name: 'Migration Project',
                      slug: 'migration-project',
                      url: 'https://linear.app/acme/project/migration'
                    },
                    state: { name: issue.state },
                    labels: { nodes: [] }
                  }
                ],
                pageInfo: {
                  hasNextPage: !secondPage,
                  endCursor: secondPage ? null : 'cursor-1'
                }
              }
            }
          })
        };
      },
      sleepFn: async () => {
        sleepCount += 1;
      },
      runner: async (options) => {
        const identifier = /Linear task: ([A-Z]+-\d+)/.exec(options.query)?.[1];
        dispatched.push(identifier);
        return {
          summary: {
            status: 'ok',
            name: options.lead,
            output: `Ready for review: https://github.com/acme/repo/pull/${identifier === 'ENG-123' ? '42' : '43'}`
          }
        };
      }
    });

    assert.equal(result.success, true);
    assert.equal(result.pollCount, 2);
    assert.equal(sleepCount, 1);
    assert.deepEqual(dispatched, ['ENG-123', 'ENG-124']);
    const state = JSON.parse(await readFile(result.stateFile, 'utf8'));
    assert.equal(state.issues['ENG-123'].status, 'review_ready');
    assert.equal(state.issues['ENG-124'].status, 'review_ready');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('runLinearDelivery can require GitHub CI success before completion', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'council-delivery-'));
  try {
    const result = await runLinearDelivery({
      cwd: tempDir,
      delivery: {
        issueIds: ['ENG-123'],
        phases: ['ship'],
        apiKeyEnv: 'TEST_LINEAR_KEY',
        completionGate: 'ci-success',
        workspaceStrategy: 'none'
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
      ciChecker: async ({ selector }) => {
        assert.equal(selector, 'https://github.com/acme/repo/pull/42');
        return {
          success: true,
          detail: 'GitHub checks passed.',
          checks: [{ name: 'test', bucket: 'pass' }]
        };
      },
      runner: async (options) => ({
        summary: {
          status: 'ok',
          name: options.lead,
          output: 'PR: https://github.com/acme/repo/pull/42'
        }
      })
    });

    assert.equal(result.success, true);
    assert.equal(result.issues[0].status, 'ci_passed');
    assert.equal(result.issues[0].completion.status, 'ci_passed');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('getLinearDeliveryStatus reports setup, viewer, and state counts', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'council-delivery-'));
  try {
    const status = await getLinearDeliveryStatus({
      cwd: tempDir,
      delivery: {
        authMethod: 'oauth',
        oauthTokenEnv: 'TEST_LINEAR_OAUTH'
      },
      env: {
        TEST_LINEAR_OAUTH: 'oauth-token'
      },
      fetchFn: async () => ({
        ok: true,
        json: async () => ({
          data: {
            viewer: {
              id: 'user-id',
              name: 'Dvir'
            }
          }
        })
      })
    });

    assert.equal(status.configured, true);
    assert.equal(status.viewer.name, 'Dvir');
    assert.match(renderLinearDeliveryStatus(status), /Linear integration status/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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
