export const PLUGIN_PERMISSIONS = [
  'read_note_metadata',
  'read_note_content',
  'rename_note',
  'edit_note_content',
  'full_access',
] as const;

export const PLUGIN_FREQUENCIES = ['manual', 'daily', 'weekly'] as const;
export const PLUGIN_KINDS = ['note_automation'] as const;
export const PLUGIN_EXECUTION_MODES = ['declarative', 'full-trust'] as const;

export type PluginPermission = typeof PLUGIN_PERMISSIONS[number];
export type PluginFrequency = typeof PLUGIN_FREQUENCIES[number];
export type PluginKind = typeof PLUGIN_KINDS[number];
export type PluginOrigin = 'builtin' | 'installed';
export type PluginExecutionMode = typeof PLUGIN_EXECUTION_MODES[number];

export interface PluginSelector {
  filename_glob?: string;
  filename_regex?: string;
  exclude_filename_glob?: string;
  exclude_filename_regex?: string;
  stale_minutes?: number;
  min_content_chars?: number;
  reprocess_on_content_change?: boolean;
  max_notes_per_run?: number;
}

export interface PluginRuntimeConfig {
  max_content_chars?: number;
  include_recent_titles?: number;
  few_shot_count?: number;
  temperature?: number;
  max_tokens?: number;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  kind: PluginKind;
  execution?: PluginExecutionMode;
  entrypoint?: string;
  frequency?: PluginFrequency;
  enabled_by_default?: boolean;
  permissions: PluginPermission[];
  selector?: PluginSelector;
  runtime?: PluginRuntimeConfig;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  source: string | null;
  origin: PluginOrigin;
  manifestPath: string;
  entrypointPath: string | null;
  sourceUrl: string | null;
}

export interface PluginInstallRecord {
  plugin_id: string;
  origin: PluginOrigin;
  manifest_url: string | null;
  publisher: string;
  version: string;
  trusted: number;
  enabled: number;
  installed_at: number;
  updated_at: number;
}

export interface PluginActionRename {
  type: 'rename_note';
  new_title: string;
}

export interface PluginActionEditContent {
  type: 'edit_note_content';
  new_content: string;
}

export type PluginAction = PluginActionRename | PluginActionEditContent;

export interface PluginResult {
  noteUuid: string;
  action: 'rename_note' | 'edit_note_content';
  oldFilename?: string;
  newFilename?: string;
}
