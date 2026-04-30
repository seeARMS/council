import { spawn } from 'node:child_process';

const CLOSE_GRACE_MS = 250;
const SIGKILL_GRACE_MS = 2_000;

export function runCommand(options: any = {}) {
  const {
  command,
  args = [],
  cwd,
  env,
  stdinText = '',
  timeoutMs,
  interruptWhen = null,
  onChunk = null
  } = options;

  return new Promise<any>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timer = null;
    let closeFallbackTimer = null;
    let timedOut = false;
    let spawnedError = null;
    let interruption = null;
    const useProcessGroup = process.platform !== 'win32';

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: useProcessGroup,
      windowsHide: true
    });

    const buildResult = ({ code, signal }) => ({
      command,
      args,
      code,
      signal,
      stdout,
      stderr,
      timedOut,
      interruption,
      timeoutMs,
      error: spawnedError
    });

    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (closeFallbackTimer) {
        clearTimeout(closeFallbackTimer);
      }
      resolve(result);
    };

    child.on('error', (error) => {
      spawnedError = error;
      finish(buildResult({ code: null, signal: null }));
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      onChunk?.({
        command,
        args,
        stdout,
        stderr,
        source: 'stdout',
        chunk
      });
      maybeInterrupt({
        command,
        args,
        stdout,
        stderr,
        source: 'stdout',
        chunk
      });
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      onChunk?.({
        command,
        args,
        stdout,
        stderr,
        source: 'stderr',
        chunk
      });
      maybeInterrupt({
        command,
        args,
        stdout,
        stderr,
        source: 'stderr',
        chunk
      });
    });

    child.on('exit', (code, signal) => {
      closeFallbackTimer = setTimeout(() => {
        // Some CLIs spawn descendants that inherit stdout/stderr. If the main
        // process exits but those pipes stay open, the close event may never fire.
        child.stdout.destroy();
        child.stderr.destroy();
        finish(buildResult({ code, signal }));
      }, CLOSE_GRACE_MS);
      closeFallbackTimer.unref?.();
    });

    child.on('close', (code, signal) => {
      finish(buildResult({ code, signal }));
    });

    child.stdin.on('error', () => {
      // Some CLIs close stdin eagerly after consuming the prompt.
    });

    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();

    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateChild(child, { useProcessGroup, signal: 'SIGTERM' });
        setTimeout(() => {
          terminateChild(child, { useProcessGroup, signal: 'SIGKILL' });
        }, SIGKILL_GRACE_MS).unref();
      }, timeoutMs);
    }

    function maybeInterrupt(context) {
      if (settled || interruption || typeof interruptWhen !== 'function') {
        return;
      }

      const nextInterruption = interruptWhen(context);
      if (!nextInterruption) {
        return;
      }

      interruption = nextInterruption;
      terminateChild(child, { useProcessGroup, signal: 'SIGTERM' });
      setTimeout(() => {
        terminateChild(child, { useProcessGroup, signal: 'SIGKILL' });
      }, SIGKILL_GRACE_MS).unref();
    }
  });
}

function terminateChild(child, { useProcessGroup, signal }) {
  if (useProcessGroup && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to killing the direct child if the process group is gone.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // Ignore kill errors for already-exited children.
  }
}

export function extractJsonObject(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      return null;
    }

    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
}
