import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

const ENGINES = ['codex', 'claude', 'gemini'];

export async function createFakeCouncilEnvironment(config = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'council-test-'));
  const bins = {};

  for (const engine of ENGINES) {
    if (!config[engine]) {
      continue;
    }

    const filePath = path.join(dir, engine);
    bins[engine] = filePath;
    await writeFile(filePath, fakeBinarySource(engine, config[engine]), 'utf8');
    await chmod(filePath, 0o755);
  }

  return {
    dir,
    bins,
    env: {
      ...process.env,
      COUNCIL_CODEX_BIN: bins.codex ?? path.join(dir, 'missing-codex'),
      COUNCIL_CLAUDE_BIN: bins.claude ?? path.join(dir, 'missing-claude'),
      COUNCIL_GEMINI_BIN: bins.gemini ?? path.join(dir, 'missing-gemini')
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

export async function runCli(args, { env, cwd, stdinText = '' }) {
  const child = spawn(process.execPath, ['bin/council.js', ...args], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  if (stdinText) {
    child.stdin.write(stdinText);
  }
  child.stdin.end();

  const [code, signal] = await once(child, 'close');
  return {
    code,
    signal,
    stdout,
    stderr
  };
}

function fakeBinarySource(engine, config) {
  return `#!/usr/bin/env node
const fs = require('node:fs');

const engine = ${JSON.stringify(engine)};
const config = ${JSON.stringify(normalizeConfig(config))};

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
  process.stdin.on('end', () => {
    const promptArgIndex = process.argv.indexOf('-p');
    const promptArg = promptArgIndex >= 0 ? process.argv[promptArgIndex + 1] ?? '' : '';
    const prompt = engine === 'gemini'
      ? [promptArg, input].filter(Boolean).join('\\n').trim()
      : input.trim();
    const isSummary = prompt.includes('Council member responses:');
    const behavior = isSummary ? config.summary : config.member;

    if (behavior.mode === 'hang') {
      if (behavior.stderr) {
        process.stderr.write(behavior.stderr);
      }
      if (behavior.stdoutPrefix) {
        process.stdout.write(behavior.stdoutPrefix);
      }
      if (behavior.stdout) {
        process.stdout.write(behavior.stdout);
      }
      setInterval(() => {}, 1000);
      return;
    }

    if (behavior.mode === 'timeout') {
      setInterval(() => {}, 1000);
      return;
    }

  const perform = () => {
    if (behavior.mode === 'error') {
      if (behavior.stderr) {
        process.stderr.write(behavior.stderr);
      }
      if (behavior.stdout) {
        process.stdout.write(behavior.stdout);
      }
      process.exit(behavior.exitCode);
      return;
    }

    if (behavior.mode === 'empty') {
      process.exit(0);
      return;
    }

    if (behavior.mode === 'echo-prompt') {
      if (engine === 'codex') {
        const outputIndex = process.argv.indexOf('-o');
        const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
        if (outputPath) {
          fs.writeFileSync(outputPath, prompt, 'utf8');
        }
        process.exit(0);
        return;
      }

      if (engine === 'claude') {
        process.stdout.write(JSON.stringify({ result: prompt }));
        return;
      }

      process.stdout.write(JSON.stringify({ response: prompt }));
      return;
    }

    if (behavior.mode === 'echo-prompt-sources') {
      const payload = JSON.stringify({
        promptArg,
        stdin: input
      });

      if (engine === 'codex') {
        const outputIndex = process.argv.indexOf('-o');
        const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
        if (outputPath) {
          fs.writeFileSync(outputPath, payload, 'utf8');
        }
        process.exit(0);
        return;
      }

      if (engine === 'claude') {
        process.stdout.write(JSON.stringify({ result: payload }));
        return;
      }

      process.stdout.write(JSON.stringify({ response: payload }));
      return;
    }

    if (engine === 'codex') {
      const outputIndex = process.argv.indexOf('-o');
      const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
      if (behavior.stdoutPrefix) {
        process.stdout.write(behavior.stdoutPrefix);
      }
      if (outputPath) {
        fs.writeFileSync(outputPath, behavior.output, 'utf8');
      }
      process.exit(0);
      return;
    }

    if (engine === 'claude') {
      if (behavior.stdoutPrefix) {
        process.stdout.write(behavior.stdoutPrefix);
      }
      const outputFormatIndex = process.argv.indexOf('--output-format');
      const outputFormat = outputFormatIndex >= 0 ? process.argv[outputFormatIndex + 1] : '';

      if (outputFormat === 'stream-json') {
        process.stdout.write(JSON.stringify({ type: 'result', result: behavior.output }) + '\\n');
        return;
      }

      process.stdout.write(JSON.stringify({ result: behavior.output }));
      return;
    }

    if (behavior.stdoutPrefix) {
      process.stdout.write(behavior.stdoutPrefix);
    }
    process.stdout.write(JSON.stringify({ response: behavior.output }));
  };

  if (behavior.delayMs > 0) {
    setTimeout(perform, behavior.delayMs);
    return;
  }

  perform();
});
`;
}

function normalizeConfig(config) {
  return {
    member: normalizeBehavior(config.member, 'member output'),
    summary: normalizeBehavior(config.summary, 'summary output')
  };
}

function normalizeBehavior(behavior, fallbackOutput) {
  if (!behavior) {
    return {
      mode: 'ok',
      output: fallbackOutput,
      stdoutPrefix: '',
      stdout: '',
      stderr: '',
      exitCode: 1,
      delayMs: 0
    };
  }

  return {
    mode: behavior.mode ?? 'ok',
    output: behavior.output ?? fallbackOutput,
    stdoutPrefix: behavior.stdoutPrefix ?? '',
    stdout: behavior.stdout ?? '',
    stderr: behavior.stderr ?? '',
    exitCode: behavior.exitCode ?? 1,
    delayMs: behavior.delayMs ?? 0
  };
}
