export type EngineName = 'codex' | 'claude' | 'gemini';
export type SummarizerName = 'auto' | EngineName;
export type ColorMode = 'auto' | 'always' | 'never';
export type EngineStatus = 'ok' | 'missing' | 'timeout' | 'error';
export type EffortLevel = 'low' | 'medium' | 'high';

export interface ConversationTurn {
  user: string;
  assistant: string;
}

export interface ParsedArgs {
  help: boolean;
  version: boolean;
  json: boolean;
  jsonStream: boolean;
  headless: boolean;
  plain: boolean;
  verbose: boolean;
  quiet: boolean;
  summaryOnly: boolean;
  noBanner: boolean;
  color: ColorMode;
  summarizer: SummarizerName;
  effort: EffortLevel | null;
  timeoutMs: number;
  maxMemberChars: number;
  cwd: string;
  promptParts: string[];
  members: EngineName[];
}

export interface EngineProgress {
  detail: string;
}

export interface CouncilEngineResult {
  name: EngineName | null;
  bin?: string | null;
  status: EngineStatus;
  durationMs?: number;
  detail: string;
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  output?: string;
}

export interface RunEngineOptions {
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  effort?: EffortLevel | null;
  onProgress?: (progress: EngineProgress) => void;
}

export interface BuildPromptOptions {
  conversation?: ConversationTurn[];
}

export interface BuildSummaryPromptOptions extends BuildPromptOptions {
  maxMemberChars?: number;
}

export interface RunCouncilOptions {
  query: string;
  cwd?: string;
  members?: EngineName[];
  summarizer?: SummarizerName;
  timeoutMs?: number;
  maxMemberChars?: number;
  effort?: EffortLevel | null;
  conversation?: ConversationTurn[];
  env?: Record<string, string | undefined>;
  onEvent?: (event: CouncilEvent) => void;
}

export interface CouncilResult {
  query: string;
  cwd: string;
  membersRequested: EngineName[];
  summarizerRequested: SummarizerName;
  effort: EffortLevel | null;
  members: CouncilEngineResult[];
  summaryAttempts: CouncilEngineResult[];
  summary: CouncilEngineResult;
  summaryContextLimit: number;
}

export interface RenderHumanResultOptions {
  summaryOnly?: boolean;
  verbose?: boolean;
}

export interface RunStartedEvent {
  type: 'run_started';
  at: string;
  cwd: string;
  members: EngineName[];
  summarizer: SummarizerName;
  effort: EffortLevel | null;
}

export interface MemberStartedEvent {
  type: 'member_started';
  at: string;
  name: EngineName;
}

export interface MemberProgressEvent {
  type: 'member_progress' | 'member_heartbeat';
  at: string;
  name: EngineName;
  detail?: string;
  elapsedMs?: number;
}

export interface MemberCompletedEvent {
  type: 'member_completed';
  at: string;
  result: CouncilEngineResult;
}

export interface SummaryStartedEvent {
  type: 'summary_started';
  at: string;
  name: EngineName;
}

export interface SummaryProgressEvent {
  type: 'summary_progress' | 'summary_heartbeat';
  at: string;
  name: EngineName;
  detail?: string;
  elapsedMs?: number;
}

export interface SummaryCompletedEvent {
  type: 'summary_completed';
  at: string;
  result: CouncilEngineResult;
}

export interface RunCompletedEvent {
  type: 'run_completed';
  at: string;
  success: boolean;
  result: CouncilResult;
}

export type CouncilEvent =
  | RunStartedEvent
  | MemberStartedEvent
  | MemberProgressEvent
  | MemberCompletedEvent
  | SummaryStartedEvent
  | SummaryProgressEvent
  | SummaryCompletedEvent
  | RunCompletedEvent;

export function usageText(version: string): string;
export function parseArgs(argv: string[]): ParsedArgs;
export function runCouncil(options: RunCouncilOptions): Promise<CouncilResult>;
export function isCouncilSuccess(result: CouncilResult): boolean;
export function runEngine(name: EngineName, options: RunEngineOptions): Promise<CouncilEngineResult>;
export function buildMemberPrompt(query: string, options?: BuildPromptOptions): string;
export function buildSummaryPrompt(
  query: string,
  responses: Array<Pick<CouncilEngineResult, 'name' | 'output'>>,
  options?: BuildSummaryPromptOptions
): string;
export function exitCodeForResult(result: CouncilResult): number;
export function renderHumanResult(result: CouncilResult, options?: RenderHumanResultOptions): string;
export const EFFORT_LEVELS: readonly EffortLevel[];
export const EXIT_CODES: {
  readonly OK: 0;
  readonly RUNTIME_ERROR: 1;
  readonly USAGE_ERROR: 2;
  readonly NO_MEMBER_RESPONSES: 3;
  readonly SUMMARY_FAILED: 4;
};
