import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildPromptContext,
  buildPromptWithContext,
  loadTaggedFile,
  runPromptCommand
} from '../src/prompt-context.js';

test('loadTaggedFile reads local text files for prompt context', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'council-prompt-context-'));
  try {
    await writeFile(path.join(dir, 'notes.md'), '# Notes\nShip it\n', 'utf8');

    const file = await loadTaggedFile({
      cwd: dir,
      filePath: 'notes.md'
    });

    assert.equal(file.status, 'ok');
    assert.equal(file.displayPath, 'notes.md');
    assert.match(file.content, /Ship it/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runPromptCommand captures command output for prompt context', async () => {
  const result = await runPromptCommand({
    command: 'printf hello',
    cwd: process.cwd(),
    timeoutMs: 5_000
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.stdout, 'hello');
});

test('buildPromptWithContext appends tagged files and command outputs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'council-prompt-context-'));
  try {
    await writeFile(path.join(dir, 'notes.md'), 'context', 'utf8');
    const context = await buildPromptContext({
      cwd: dir,
      files: ['notes.md'],
      commands: ['printf command-output']
    });
    const prompt = buildPromptWithContext('Question?', context);

    assert.match(prompt, /Question\?/);
    assert.match(prompt, /Tagged local files:/);
    assert.match(prompt, /### notes\.md/);
    assert.match(prompt, /command-output/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
