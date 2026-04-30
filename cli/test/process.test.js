import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../src/process.js';

test('runCommand resolves after exit even if a descendant keeps stdio open', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'council-process-test-'));
  const scriptPath = path.join(dir, 'exit-with-open-stdio.js');
  const scriptSource = `#!/usr/bin/env node
const { spawn } = require('node:child_process');

const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], {
  detached: true,
  stdio: ['ignore', 1, 2]
});

descendant.unref();
process.stdout.write('ready\\n');
process.exit(0);
`;

  await writeFile(scriptPath, scriptSource, 'utf8');
  await chmod(scriptPath, 0o755);

  const startedAt = Date.now();

  try {
    const result = await runCommand({
      command: scriptPath,
      cwd: process.cwd()
    });

    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stdout.trim(), 'ready');
    assert.equal(result.timedOut, false);
    assert.ok(Date.now() - startedAt < 1_500);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
