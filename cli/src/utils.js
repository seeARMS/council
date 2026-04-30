export async function readPromptFromArgsAndStdin(promptParts) {
  const parts = [];

  if (promptParts.length > 0) {
    parts.push(promptParts.join(' ').trim());
  }

  const stdinText = await readStdinIfPresent();
  if (stdinText) {
    parts.push(stdinText.trim());
  }

  return parts.join('\n\n').trim();
}

export async function readInteractivePrompt({
  input = process.stdin,
  output = process.stderr,
  label = 'you> ',
  ignoreInitialEmptyOnce = false,
  initialText = ''
} = {}) {
  if (!input.isTTY || !input.setRawMode) {
    return '';
  }

  const previousRawMode = input.isRaw;
  let buffer = initialText;
  output.write(label);
  if (initialText) {
    output.write(initialText);
  }

  return new Promise((resolve) => {
    const cleanup = () => {
      input.off('data', onData);
      input.setRawMode(previousRawMode);
      input.pause();
    };

    const onData = (chunk) => {
      for (const key of chunk.toString('utf8')) {
        if (key === '\u0003') {
          cleanup();
          process.exitCode = 130;
          output.write('\n');
          resolve('');
          return;
        }

        if (key === '\u001b') {
          cleanup();
          output.write('\n');
          resolve('');
          return;
        }

        if (key === '\r' || key === '\n') {
          const trimmed = buffer.trim();
          output.write('\n');

          if (!trimmed && ignoreInitialEmptyOnce) {
            buffer = '';
            output.write(label);
            continue;
          }

          cleanup();
          resolve(trimmed);
          return;
        }

        if (key === '\u0008' || key === '\u007f') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }

        if (key < ' ' && key !== '\t') {
          continue;
        }

        buffer += key;
        output.write(key);
      }
    };

    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

async function readStdinIfPresent() {
  if (process.stdin.isTTY) {
    return '';
  }

  let input = '';
  process.stdin.setEncoding('utf8');

  for await (const chunk of process.stdin) {
    input += chunk;
  }

  return input;
}
