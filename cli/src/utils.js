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
