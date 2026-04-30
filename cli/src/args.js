import {
  ALL_ENGINES,
  AUTO_SUMMARIZER,
  DEFAULT_MAX_MEMBER_CHARS,
  DEFAULT_TIMEOUT_MS
} from './engines.js';

export function usageText(version) {
  return [
    `council v${version}`,
    '',
    'Ask multiple AI CLIs the same question, then synthesize their answers.',
    '',
    'Usage:',
    '  council [options] <query>',
    '  echo "query" | council [options]',
    '  council help',
    '',
    'Examples:',
    '  council "How should I structure this migration?"',
    '  council --no-gemini --summarizer claude "Review this plan"',
    '  council --headless --json "Summarize the implementation options"',
    '  council --json-stream --codex --claude "Compare these designs"',
    '',
    'Selection:',
    '  --members <list>          Ordered subset of codex,claude,gemini',
    '  --codex / --no-codex      Enable or disable Codex',
    '  --claude / --no-claude    Enable or disable Claude',
    '  --gemini / --no-gemini    Enable or disable Gemini',
    '  --all                     Re-enable all members',
    '  --summarizer <name>       auto, codex, claude, or gemini',
    '',
    'Output:',
    '  --summary-only            Print only the final synthesis',
    '  -q, --quiet               Alias for --summary-only',
    '  --json                    Print structured JSON',
    '  --json-stream             Stream JSONL lifecycle events',
    '  --headless                Automation mode: no banner, no progress, summary-only text by default',
    '  --plain                   Disable decorative UI and color',
    '  --no-banner               Suppress the startup banner',
    '  --color <auto|always|never>',
    '',
    'Execution:',
    '  --timeout <seconds>       Per-CLI timeout in seconds (default: 60)',
    `  --max-member-chars <n>    Cap each member response before summarization (default: ${DEFAULT_MAX_MEMBER_CHARS})`,
    '  --cwd <path>              Working directory for all upstream CLIs',
    '',
    'Other:',
    '  -h, --help                Show help',
    '  -v, --version             Show version',
    '',
    'Environment:',
    '  COUNCIL_CODEX_BIN         Override the codex executable path',
    '  COUNCIL_CLAUDE_BIN        Override the claude executable path',
    '  COUNCIL_GEMINI_BIN        Override the gemini executable path'
  ].join('\n');
}

export function parseArgs(argv) {
  const result = {
    help: false,
    version: false,
    json: false,
    jsonStream: false,
    headless: false,
    plain: false,
    quiet: false,
    summaryOnly: false,
    noBanner: false,
    color: 'auto',
    summarizer: AUTO_SUMMARIZER,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxMemberChars: DEFAULT_MAX_MEMBER_CHARS,
    cwd: process.cwd(),
    promptParts: []
  };
  const enabledEngines = Object.fromEntries(ALL_ENGINES.map((engine) => [engine, true]));
  let memberOrder = [...ALL_ENGINES];

  let positionalMode = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (positionalMode) {
      result.promptParts.push(token);
      continue;
    }

    if (token === '--') {
      positionalMode = true;
      continue;
    }

    if (token === '-h' || token === '--help') {
      result.help = true;
      continue;
    }

    if (token === '-v' || token === '--version') {
      result.version = true;
      continue;
    }

    if (token === '--json') {
      result.json = true;
      continue;
    }

    if (token === '--json-stream' || token === '--ndjson') {
      result.jsonStream = true;
      continue;
    }

    if (token === '--headless') {
      result.headless = true;
      continue;
    }

    if (token === '--plain') {
      result.plain = true;
      continue;
    }

    if (token === '--no-banner') {
      result.noBanner = true;
      continue;
    }

    if (token === '--summary-only') {
      result.summaryOnly = true;
      continue;
    }

    if (token === '-q' || token === '--quiet') {
      result.quiet = true;
      continue;
    }

    if (token === '--all') {
      for (const engine of ALL_ENGINES) {
        enabledEngines[engine] = true;
      }
      continue;
    }

    if (token === '--codex' || token === '--claude' || token === '--gemini') {
      enabledEngines[token.slice(2)] = true;
      continue;
    }

    if (token === '--no-codex' || token === '--no-claude' || token === '--no-gemini') {
      enabledEngines[token.slice(5)] = false;
      continue;
    }

    if (token === '--members') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--members requires a value.');
      }
      const members = parseEngineList(value, '--members');
      applyEngineList(enabledEngines, members);
      memberOrder = buildMemberOrder(members);
      index += 1;
      continue;
    }

    if (token.startsWith('--members=')) {
      const members = parseEngineList(token.slice('--members='.length), '--members');
      applyEngineList(enabledEngines, members);
      memberOrder = buildMemberOrder(members);
      continue;
    }

    if (token === '--summarizer') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--summarizer requires a value.');
      }
      result.summarizer = parseSummarizer(value);
      index += 1;
      continue;
    }

    if (token.startsWith('--summarizer=')) {
      result.summarizer = parseSummarizer(token.slice('--summarizer='.length));
      continue;
    }

    if (token === '--timeout') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--timeout requires a value.');
      }
      result.timeoutMs = parseTimeoutMs(value);
      index += 1;
      continue;
    }

    if (token.startsWith('--timeout=')) {
      result.timeoutMs = parseTimeoutMs(token.slice('--timeout='.length));
      continue;
    }

    if (token === '--max-member-chars') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--max-member-chars requires a value.');
      }
      result.maxMemberChars = parsePositiveInteger(value, '--max-member-chars');
      index += 1;
      continue;
    }

    if (token.startsWith('--max-member-chars=')) {
      result.maxMemberChars = parsePositiveInteger(
        token.slice('--max-member-chars='.length),
        '--max-member-chars'
      );
      continue;
    }

    if (token === '--cwd') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--cwd requires a value.');
      }
      result.cwd = value;
      index += 1;
      continue;
    }

    if (token.startsWith('--cwd=')) {
      result.cwd = token.slice('--cwd='.length);
      continue;
    }

    if (token === '--color') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--color requires a value.');
      }
      result.color = parseColor(value);
      index += 1;
      continue;
    }

    if (token.startsWith('--color=')) {
      result.color = parseColor(token.slice('--color='.length));
      continue;
    }

    if (token === '--no-color') {
      result.color = 'never';
      continue;
    }

    if (token.startsWith('-')) {
      throw new Error(`Unknown option: ${token}`);
    }

    result.promptParts.push(token);
  }

  if (result.help || isStandaloneSubcommand(argv, 'help')) {
    result.help = true;
    result.members = [...ALL_ENGINES];
    return result;
  }

  if (result.version || isStandaloneSubcommand(argv, 'version')) {
    result.version = true;
    result.members = [...ALL_ENGINES];
    return result;
  }

  result.members = memberOrder.filter((engine) => enabledEngines[engine]);

  if (result.members.length === 0) {
    throw new Error('At least one engine must be enabled.');
  }

  return result;
}

function parseEngineList(value, flagName) {
  const members = value
    .split(',')
    .map((member) => member.trim())
    .filter(Boolean);

  if (members.length === 0) {
    throw new Error(`${flagName} requires at least one engine.`);
  }

  const invalid = members.filter((member) => !ALL_ENGINES.includes(member));
  if (invalid.length > 0) {
    throw new Error(`Unsupported engine in ${flagName}: ${invalid.join(', ')}`);
  }

  return [...new Set(members)];
}

function applyEngineList(enabledEngines, members) {
  for (const engine of ALL_ENGINES) {
    enabledEngines[engine] = false;
  }

  for (const member of members) {
    enabledEngines[member] = true;
  }
}

function buildMemberOrder(members) {
  return [...members, ...ALL_ENGINES.filter((engine) => !members.includes(engine))];
}

function parseSummarizer(value) {
  if (value === AUTO_SUMMARIZER || ALL_ENGINES.includes(value)) {
    return value;
  }

  throw new Error(`Unsupported summarizer: ${value}`);
}

function parseTimeoutMs(value) {
  const seconds = Number(value);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid timeout value: ${value}`);
  }

  return Math.round(seconds * 1000);
}

function parsePositiveInteger(value, flagName) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} requires a positive integer.`);
  }

  return parsed;
}

function parseColor(value) {
  if (['auto', 'always', 'never'].includes(value)) {
    return value;
  }

  throw new Error(`Unsupported color mode: ${value}`);
}

function isStandaloneSubcommand(argv, target) {
  const positionalTokens = [];

  for (const token of argv) {
    if (token === '--') {
      return false;
    }

    if (!token.startsWith('-')) {
      positionalTokens.push(token);
    }
  }

  return positionalTokens.length === 1 && positionalTokens[0] === target;
}
