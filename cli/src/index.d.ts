export type EngineName = 'codex' | 'claude' | 'gemini';
export type SummarizerName = 'auto' | EngineName;
export type ColorMode = 'auto' | 'always' | 'never';
export type EngineStatus = 'ok' | 'missing' | 'timeout' | 'error';
export type EffortLevel = 'low' | 'medium' | 'high';
export type ProviderEffortLevel = EffortLevel | 'xhigh' | 'max';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ClaudePermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan';
export type CodexAuthMethod = 'auto' | 'social-login' | 'login' | 'api-key';
export type ClaudeAuthMethod = 'auto' | 'social-login' | 'oauth' | 'api-key' | 'keychain';
export type GeminiAuthMethod = 'auto' | 'social-login' | 'login' | 'api-key';
export type ProviderCapabilityMode = 'inherit' | 'override';
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

export interface ProviderAuths {
  codex?: CodexAuthMethod | null;
  claude?: ClaudeAuthMethod | null;
  gemini?: GeminiAuthMethod | null;
}

export interface CodexCapabilities {
  mode?: ProviderCapabilityMode;
  config?: string[];
  mcpProfile?: string | null;
}

export interface ClaudeCapabilities {
  mode?: ProviderCapabilityMode;
  mcpConfig?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface GeminiCapabilities {
  mode?: ProviderCapabilityMode;
  settings?: string | null;
  toolsProfile?: string[];
}

export type ProviderCapability =
  | CodexCapabilities
  | ClaudeCapabilities
  | GeminiCapabilities;

export interface ProviderCapabilities {
  codex?: CodexCapabilities;
  claude?: ClaudeCapabilities;
  gemini?: GeminiCapabilities;
}

export interface AuthLoginOptions {
  enabled: boolean;
  providers: EngineName[];
  deviceCode: boolean;
  openBrowser: boolean;
  timeoutMs: number;
}

export interface ProviderTeamSizes {
  codex?: number | null;
  claude?: number | null;
  gemini?: number | null;
}

export interface DeliveryOptions {
  enabled: boolean;
  provider: 'linear' | null;
  issueIds: string[];
  query?: string | null;
  team?: string | null;
  state?: string | null;
  assignee?: string | null;
  limit: number;
  endpoint?: string | null;
  apiKeyEnv: string;
  authMethod: 'api-key' | 'oauth';
  oauthTokenEnv: string;
  phases: string[];
  setup: boolean;
  status: boolean;
  watch: boolean;
  pollIntervalMs: number;
  maxPolls: number | null;
  maxConcurrency: number;
  maxAttempts: number;
  retryBaseMs: number;
  stateFile?: string | null;
  workspaceRoot?: string | null;
  observabilityDir?: string | null;
  workspaceStrategy: 'worktree' | 'copy' | 'none';
  workflowFile?: string | null;
  attachMedia?: string[];
  attachmentTitle?: string | null;
}

export interface PromptContextOptions {
  files: string[];
  commands: string[];
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
  studio: boolean;
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
  auths: ProviderAuths;
  capabilities: ProviderCapabilities;
  authLogin: AuthLoginOptions;
  promptContext: PromptContextOptions;
  handoff: boolean;
  lead: EngineName | null;
  planner: EngineName | null;
  iterations: number;
  teamWork: number;
  teams: ProviderTeamSizes;
  delivery: DeliveryOptions;
  timeoutMs: number;
  maxMemberChars: number;
  cwd: string;
  promptParts: string[];
  members: EngineName[];
}

export interface EngineProgress {
  detail: string;
  tool?: ToolUsage | null;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  estimated: boolean;
  source: string;
}

export interface ToolUsage {
  type: 'tool' | 'command' | string;
  name: string;
  command?: string;
  description?: string;
  provider?: string;
  count?: number;
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
  command?: string;
  tokenUsage?: TokenUsage;
  toolUsage?: ToolUsage[];
  role?: CouncilRole;
  iteration?: number;
  totalIterations?: number;
  teamSize?: number;
  auth?: string | null;
  capability?: ProviderCapability | null;
}

export interface RunEngineOptions {
  prompt: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  effort?: ProviderEffortLevel | null;
  model?: string | null;
  permission?: CodexSandboxMode | ClaudePermissionMode | null;
  auth?: string | null;
  capability?: ProviderCapability | null;
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
  auths?: ProviderAuths;
  capabilities?: ProviderCapabilities;
  promptContext?: any;
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
  auths: ProviderAuths;
  capabilities: ProviderCapabilities;
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
  auths: ProviderAuths;
  capabilities: ProviderCapabilities;
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
  auth?: string | null;
  tokenUsage?: TokenUsage;
}

export interface MemberProgressEvent {
  type: 'member_progress' | 'member_heartbeat';
  at: string;
  name: EngineName;
  role?: CouncilRole;
  iteration?: number;
  totalIterations?: number;
  teamSize?: number;
  auth?: string | null;
  detail?: string;
  tool?: ToolUsage | null;
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
  auth?: string | null;
  tokenUsage?: TokenUsage;
}

export interface SummaryProgressEvent {
  type: 'summary_progress' | 'summary_heartbeat';
  at: string;
  name: EngineName;
  role?: CouncilRole;
  iteration?: number;
  totalIterations?: number;
  teamSize?: number;
  auth?: string | null;
  detail?: string;
  tool?: ToolUsage | null;
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

export interface AuthLoginStartedEvent {
  type: 'auth_login_started';
  at: string;
  provider: EngineName;
  bin: string;
  args: string[];
  command: string;
  stdioMode: 'pipe' | 'inherit';
  launchMode: 'dedicated-login' | 'native-interactive';
  openBrowser: boolean;
  deviceCode: boolean;
  supportsCodePaste: boolean;
  supportsBrowserDeeplink: boolean;
  instruction: string;
}

export interface AuthLoginUrlOpenedEvent {
  type: 'auth_login_url_opened';
  at: string;
  provider: EngineName;
  url: string;
}

export interface AuthLoginUrlOpenFailedEvent {
  type: 'auth_login_url_open_failed';
  at: string;
  provider: EngineName;
  url: string;
  detail: string;
}

export interface AuthLoginCompletedEvent {
  type: 'auth_login_completed';
  at: string;
  provider: EngineName;
  bin: string;
  args: string[];
  status: EngineStatus | 'timeout';
  durationMs: number;
  detail: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  openedUrls: string[];
  stdioMode: 'pipe' | 'inherit';
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
  | RunCompletedEvent
  | AuthLoginStartedEvent
  | AuthLoginUrlOpenedEvent
  | AuthLoginUrlOpenFailedEvent
  | AuthLoginCompletedEvent;

export interface ProviderSocialLoginCommand {
  provider: EngineName;
  args: string[];
  launchMode: 'dedicated-login' | 'native-interactive';
  supportsDeviceCode: boolean;
  supportsBrowserDeeplink: boolean;
  supportsCodePaste: boolean;
  instruction: string;
}

export interface ProviderSocialLoginResult {
  provider: EngineName;
  bin: string;
  args: string[];
  status: EngineStatus | 'timeout';
  durationMs: number;
  detail: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  openedUrls: string[];
  stdioMode: 'pipe' | 'inherit';
}

export interface ProviderSocialLoginsResult {
  success: boolean;
  providers: ProviderSocialLoginResult[];
}

export function usageText(version: string): string;
export function parseArgs(argv: string[]): ParsedArgs;
export function runCouncil(options: RunCouncilOptions): Promise<CouncilResult>;
export function resolveSocialLoginProviders(options?: {
  members?: EngineName[];
  auths?: ProviderAuths;
  providers?: EngineName[] | string;
}): EngineName[];
export function socialLoginCommandForProvider(
  provider: EngineName,
  options?: { deviceCode?: boolean }
): ProviderSocialLoginCommand;
export function runProviderSocialLogins(options: {
  providers: EngineName[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  openBrowser?: boolean;
  deviceCode?: boolean;
  input?: NodeJS.ReadableStream | null;
  output?: NodeJS.WritableStream;
  opener?: (url: string) => Promise<void> | void;
  stdioMode?: 'auto' | 'pipe' | 'inherit';
  onEvent?: (event: CouncilEvent) => void;
}): Promise<ProviderSocialLoginsResult>;
export function runProviderSocialLogin(options: {
  provider: EngineName;
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  openBrowser?: boolean;
  deviceCode?: boolean;
  input?: NodeJS.ReadableStream | null;
  output?: NodeJS.WritableStream;
  opener?: (url: string) => Promise<void> | void;
  stdioMode?: 'auto' | 'pipe' | 'inherit';
  onEvent?: (event: CouncilEvent) => void;
}): Promise<ProviderSocialLoginResult>;
export function renderProviderSocialLoginResult(result: ProviderSocialLoginsResult): string;
export function openBrowserUrl(url: string): Promise<void>;
export function runLinearDelivery(options?: any): Promise<any>;
export function getLinearDeliveryStatus(options?: any): Promise<any>;
export function renderLinearDeliveryStatus(status: any): string;
export function renderDeliveryResult(result: any): string;
export function renderDeliveryProgressEvent(event: any): string;
export function buildDeliveryPhasePrompt(options: any): string;
export function buildPromptContext(options?: any): Promise<any>;
export function buildPromptWithContext(query: string, context?: any): string;
export function loadTaggedFile(options: any): Promise<any>;
export function runPromptCommand(options: any): Promise<any>;
export function summarizePromptContext(context?: any): any;
export function fetchLinearIssues(options?: any): Promise<any[]>;
export function fetchLinearViewer(options?: any): Promise<any | null>;
export function uploadLinearFile(options: any): Promise<any>;
export function createLinearAttachment(options: any): Promise<any>;
export function attachLinearMedia(options: any): Promise<any>;
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
export const PROVIDER_AUTH_METHODS: {
  readonly codex: readonly ('auto' | 'social-login' | 'login' | 'api-key')[];
  readonly claude: readonly ('auto' | 'social-login' | 'oauth' | 'api-key' | 'keychain')[];
  readonly gemini: readonly ('auto' | 'social-login' | 'login' | 'api-key')[];
};
export const PROVIDER_CAPABILITY_MODES: readonly ProviderCapabilityMode[];
export const CODEX_SANDBOX_MODES: readonly CodexSandboxMode[];
export const CLAUDE_PERMISSION_MODES: readonly ClaudePermissionMode[];
export const DEFAULT_PROVIDER_PERMISSIONS: {
  readonly codex: 'read-only';
  readonly claude: 'plan';
  readonly gemini: null;
};
export const DEFAULT_PROVIDER_AUTHS: {
  readonly codex: 'auto';
  readonly claude: 'auto';
  readonly gemini: 'auto';
};
export const DEFAULT_PROVIDER_CAPABILITIES: {
  readonly codex: {
    readonly mode: 'inherit';
    readonly config: readonly [];
    readonly mcpProfile: null;
  };
  readonly claude: {
    readonly mode: 'inherit';
    readonly mcpConfig: readonly [];
    readonly allowedTools: readonly [];
    readonly disallowedTools: readonly [];
  };
  readonly gemini: {
    readonly mode: 'inherit';
    readonly settings: null;
    readonly toolsProfile: readonly [];
  };
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
