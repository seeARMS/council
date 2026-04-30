#!/usr/bin/env node

import { main } from '../src/cli.ts';
import { EXIT_CODES } from '../src/exit-codes.js';

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = EXIT_CODES.RUNTIME_ERROR;
});
