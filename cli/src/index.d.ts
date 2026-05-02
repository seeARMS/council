export type EngineName = 'codex' | 'claude' | 'gemini';
export type SummarizerName = 'auto' | EngineName;
export type ColorMode = 'auto' | 'always' | 'never';
export type EngineStatus = 'ok' | 'missing' | 'timeout' | 'error';
export type EffortLevel = 'low' | 'medium' | 'high';
export type ProviderEffortLevel = EffortLevel | 'xhigh' | 'max';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ClaudePermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan';
export type CouncilRole = 'planner' | 'lead' | 'lead+planner' | 'executor';

export interface ProviderModels {
  codex?: string | null;
  claude?: string | null;
  gemini?: string | null;
}

export interface ProviderEfforts {
  codex?: ProviderEffortLevel | null;
  claude?: ProviderEffortLevel | null;
  gemini?: EffortLevel | null;
}

export interface ProviderPermissions {
  codex?: CodexSandboxMode | null;
  claude?: ClaudePermissionMode | null;
  gemini?: null;
}

export interface ProviderTeamSizes {
  codex?: number | null;
  claude?: number | null;
  gemini?: number | null;
}

export interface CouncilWorkflow {
  handoff: boolean;
  lead: EngineName | null;
  planner: EngineName | null;
  iterations: number;
  teamWork: number;
  teams: ProviderTeamSizes;
}

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
  models: ProviderModels;
  efforts: ProviderEfforts;
  permissions: ProviderPermissions;
  handoff: boolean;
  lead: EngineName | null;
  planner: EngineName | null;
  iterations: number;
  teamWork: number;
  teams: ProviderTeamSizes;
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
  role?: CouncilRole;
  iteration?: number;
  totalIterations?: number;
  teamSize?: number;
}

export interface RunEngineOptions {
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  effort?: ProviderEffortLevel | null;
  model?: string | null;
  permission?: CodexSandboxMode | ClaudePermissionMode | null;
  onProgress?: (progress: EngineProgress) => void;
}

export interface BuildPromptOptions {
  conversation?: ConversationTurn[];
  role?: CouncilRole;
  lead?: EngineName | null;
  planner?: EngineName | null;
  iteration?: number;
  totalIterations?: number;
  handoff?: boolean;
  previousResponses?: CouncilEngineResult[];
  planOutput?: string;
  teamSize?: number;
}

export interface BuildSummaryPromptOptions extends BuildPromptOptions {
  maxMemberChars?: number;
  iterations?: number;
  teams?: ProviderTeamSizes;
}

export interface RunCouncilOptions {
  query: string;
  cwd?: string;
  members?: EngineName[];
  summarizer?: SummarizerName;
  timeoutMs?: number;
  maxMemberChars?: number;
  effort?: EffortLevel | null;
  models?: ProviderModels;
  efforts?: ProviderEfforts;
  permissions?: ProviderPermissions;
  handoff?: boolean;
  lead?: EngineName | null;
  planner?: EngineName | null;
  iterations?: number;
  teamWork?: number;
  teams?: ProviderTeamSizes;
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
  models: ProviderModels;
  efforts: ProviderEfforts;
  permissions: ProviderPermissions;
  workflow: CouncilWorkflow;
  iterations: number;
  iterationResults: Array<{
    iteration: number;
    members: CouncilEngineResult[];
  }>;
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
  models: ProviderModels;
  efforts: ProviderEfforts;
  permissions: ProviderPermissions;
  workflow: CouncilWorkflow;
}

export interface IterationStartedEvent {
  type: 'iteration_started';
  at: string;
  iteration: number;
  totalIterations: number;
  workflow: CouncilWorkflow;
}

export interface IterationCompletedEvent {
  type: 'iteration_completed';
  at: string;
  iteration: number;
  totalIterations: number;
  members: CouncilEngineResult[];
}

export interface MemberStartedEvent {
  type: 'member_started';
  at: string;
  name: EngineName;
  role: CouncilRole;
  iteration: number;
  totalIterations: number;
  teamSize: number;
}

export interface MemberProgressEvent {
  type: 'member_progress' | 'member_heartbeat';
  at: string;
  name: EngineName;
  role?: CouncilRole;
  iteration?: number;
  totalIterations?: number;
  teamSize?: number;
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
  role: CouncilRole;
  iteration: number;
  totalIterations: number;
  teamSize: number;
}

export interface SummaryProgressEvent {
  type: 'summary_progress' | 'summary_heartbeat';
  at: string;
  name: EngineName;
  role?: CouncilRole;
  iteration?: number;
  totalIterations?: number;
  teamSize?: number;
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
  | IterationStartedEvent
  | IterationCompletedEvent
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
export const DEFAULT_ITERATIONS: 1;
export const DEFAULT_TEAM_SIZE: 0;
export const EFFORT_LEVELS: readonly EffortLevel[];
export const PROVIDER_EFFORT_LEVELS: {
  readonly codex: readonly ('low' | 'medium' | 'high' | 'xhigh')[];
  readonly claude: readonly ('low' | 'medium' | 'high' | 'xhigh' | 'max')[];
  readonly gemini: readonly EffortLevel[];
};
export const CODEX_SANDBOX_MODES: readonly CodexSandboxMode[];
export const CLAUDE_PERMISSION_MODES: readonly ClaudePermissionMode[];
export const DEFAULT_PROVIDER_PERMISSIONS: {
  readonly codex: 'read-only';
  readonly claude: 'plan';
  readonly gemini: null;
};
export const DEFAULT_PROVIDER_TEAM_SIZES: {
  readonly codex: 0;
  readonly claude: 0;
  readonly gemini: 0;
};
export const EXIT_CODES: {
  readonly OK: 0;
  readonly RUNTIME_ERROR: 1;
  readonly USAGE_ERROR: 2;
  readonly NO_MEMBER_RESPONSES: 3;
  readonly SUMMARY_FAILED: 4;
};
