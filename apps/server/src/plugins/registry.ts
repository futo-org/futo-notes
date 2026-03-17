import type { BuiltinPlugin, PluginRegistration } from './types.js';
import { autoTaggerPlugin } from './autoTagger/index.js';
import { quickCaptureToListPlugin } from './quickCaptureToList/index.js';
import { weeklyRelatedNotesPlugin } from './weeklyRelatedNotes/index.js';

const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  autoTaggerPlugin,
  quickCaptureToListPlugin,
  weeklyRelatedNotesPlugin,
];
const LOCAL_PLUGIN_REGISTRATIONS = new Map<string, PluginRegistration>();

function toBuiltinRegistration(plugin: BuiltinPlugin): PluginRegistration {
  return {
    plugin,
    sourceKind: 'builtin',
    sourceLabel: 'Built-in',
    sourcePath: null,
    compiledPath: null,
    loadStatus: 'ready',
    loadError: null,
    canEdit: false,
    canDelete: false,
    updatedAt: null,
  };
}

export function listBuiltinPlugins(): BuiltinPlugin[] {
  return BUILTIN_PLUGINS;
}

export function getBuiltinPlugin(pluginId: string): BuiltinPlugin | undefined {
  return BUILTIN_PLUGINS.find((plugin) => plugin.id === pluginId);
}

export function listPluginRegistrations(): PluginRegistration[] {
  const builtins = BUILTIN_PLUGINS.map(toBuiltinRegistration);
  const locals = Array.from(LOCAL_PLUGIN_REGISTRATIONS.values())
    .sort((a, b) => a.plugin.name.localeCompare(b.plugin.name) || a.plugin.id.localeCompare(b.plugin.id));
  return [...builtins, ...locals];
}

export function listPlugins(): BuiltinPlugin[] {
  return listPluginRegistrations().map((entry) => entry.plugin);
}

export function getPlugin(pluginId: string): BuiltinPlugin | undefined {
  return getPluginRegistration(pluginId)?.plugin;
}

export function getPluginRegistration(pluginId: string): PluginRegistration | undefined {
  const builtin = getBuiltinPlugin(pluginId);
  if (builtin) {
    return toBuiltinRegistration(builtin);
  }
  return LOCAL_PLUGIN_REGISTRATIONS.get(pluginId);
}

export function upsertLocalPluginRegistration(registration: PluginRegistration): void {
  LOCAL_PLUGIN_REGISTRATIONS.set(registration.plugin.id, registration);
}

export function removeLocalPluginRegistration(pluginId: string): void {
  LOCAL_PLUGIN_REGISTRATIONS.delete(pluginId);
}

export function resetLocalPluginRegistrations(): void {
  LOCAL_PLUGIN_REGISTRATIONS.clear();
}
