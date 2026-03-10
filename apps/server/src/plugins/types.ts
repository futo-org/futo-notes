export const PLUGIN_SCHEDULE_KINDS = ['manual', 'daily', 'weekly'] as const;
export const PLUGIN_RUN_STATUSES = ['queued', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled'] as const;
export const PLUGIN_ITEM_STATUSES = ['suggested', 'approved', 'rejected', 'applied', 'failed'] as const;
export const PLUGIN_TRIGGER_TYPES = ['manual', 'scheduled'] as const;
export const PLUGIN_APPLY_MODES = ['preview', 'auto_apply'] as const;
export const PLUGIN_CHANGE_TYPES = ['rename_note'] as const;
export const PLUGIN_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type PluginScheduleKind = typeof PLUGIN_SCHEDULE_KINDS[number];
export type PluginRunStatus = typeof PLUGIN_RUN_STATUSES[number];
export type PluginRunItemStatus = typeof PLUGIN_ITEM_STATUSES[number];
export type PluginTriggerType = typeof PLUGIN_TRIGGER_TYPES[number];
export type PluginApplyMode = typeof PLUGIN_APPLY_MODES[number];
export type PluginChangeType = typeof PLUGIN_CHANGE_TYPES[number];
export type PluginLogLevel = typeof PLUGIN_LOG_LEVELS[number];

export interface PluginConfigField {
  key: string;
  label: string;
  type: 'boolean' | 'number' | 'string';
  default: boolean | number | string;
  description?: string;
  min?: number;
  max?: number;
}

export interface PluginScheduleConfig {
  kind: PluginScheduleKind;
  time?: string | null;
  day?: number | null;
}

export interface PluginStoredConfig {
  pluginId: string;
  enabled: boolean;
  scheduleKind: PluginScheduleKind;
  scheduleTime: string | null;
  scheduleDay: number | null;
  autoApply: boolean;
  config: Record<string, unknown>;
  lastRunAt: number | null;
  nextRunAt: number | null;
}

export interface PluginNoteMeta {
  uuid: string;
  filename: string;
  title: string;
  contentHash: string;
  modifiedAt: number;
  createdAt: string;
}

export interface PluginFindNotesFilter {
  filenameGlob?: string;
  filenameRegex?: string;
  excludeFilenameGlob?: string;
  excludeFilenameRegex?: string;
  modifiedBefore?: number;
  modifiedAfter?: number;
  limit?: number;
  sort?: 'modified_asc' | 'modified_desc' | 'created_asc' | 'created_desc';
}

export interface RunBuiltinLlmInput {
  purpose: string;
  systemPrompt?: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  jsonSchema?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ProposeChangeInput {
  entityType: 'note';
  entityId: string;
  changeType: PluginChangeType;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  preview: Record<string, unknown>;
  reason: string;
  confidence?: number | null;
}

export interface RenameNoteInput {
  noteUuid: string;
  newTitle: string;
  rewriteExactWikiLinks: boolean;
}

export interface PluginSdk {
  findNotes(filter?: PluginFindNotesFilter): Promise<PluginNoteMeta[]>;
  getNote(uuid: string): Promise<PluginNoteMeta | null>;
  readNoteContent(uuid: string): Promise<string | null>;
  listRecentNotes(limit: number, opts?: { excludeUuid?: string; excludeUntitled?: boolean }): Promise<PluginNoteMeta[]>;
  runBuiltinLlm(input: RunBuiltinLlmInput): Promise<string>;
  proposeChange(input: ProposeChangeInput): Promise<number>;
  renameNote(input: RenameNoteInput): Promise<{ finalTitle: string; finalFilename: string; rewrittenNotes: number }>;
  log(level: PluginLogLevel, message: string, context?: Record<string, unknown>): Promise<void>;
  getPluginState<T = unknown>(key: string): Promise<T | null>;
  setPluginState(key: string, value: unknown): Promise<void>;
}

export interface PluginRunContext {
  runId: string;
  triggerType: PluginTriggerType;
  config: Record<string, unknown>;
  sdk: PluginSdk;
  signal: AbortSignal;
}

export interface PluginRunSummary {
  notesScanned: number;
  proposalsCreated: number;
  notesSkipped: number;
}

export interface BuiltinPlugin {
  id: string;
  name: string;
  description: string;
  defaultEnabled: boolean;
  defaultSchedule: PluginScheduleConfig;
  defaultAutoApply: boolean;
  configSchema: PluginConfigField[];
  run(context: PluginRunContext): Promise<PluginRunSummary>;
}

export interface PluginRunRow {
  run_id: string;
  plugin_id: string;
  trigger_type: PluginTriggerType;
  apply_mode: PluginApplyMode;
  status: PluginRunStatus;
  started_at: number;
  finished_at: number | null;
  error_message: string | null;
  summary_json: string | null;
}

export interface PluginRunItemRow {
  id: number;
  run_id: string;
  entity_type: 'note';
  entity_id: string;
  change_type: PluginChangeType;
  before_json: string;
  after_json: string;
  preview_json: string;
  reason: string;
  confidence: number | null;
  status: PluginRunItemStatus;
  failure_message: string | null;
  created_at: number;
  updated_at: number;
  applied_at: number | null;
}
