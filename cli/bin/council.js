#!/usr/bin/env node

import { existsSync } from 'node:fs';

const entry = existsSync(new URL('../dist/cli.js', import.meta.url))
  ? '../dist/cli.js'
  : '../src/cli.ts';
const exitCodesEntry = existsSync(new URL('../dist/exit-codes.js', import.meta.url))
  ? '../dist/exit-codes.js'
  : '../src/exit-codes.js';

const [{ main }, { EXIT_CODES }] = await Promise.all([
  import(entry),
  import(exitCodesEntry)
]);

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = EXIT_CODES.RUNTIME_ERROR;
});
