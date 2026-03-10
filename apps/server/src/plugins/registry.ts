import type { BuiltinPlugin } from './types.js';
import { untitledNoMorePlugin } from './untitledNoMore.js';

const BUILTIN_PLUGINS: BuiltinPlugin[] = [untitledNoMorePlugin];

export function listBuiltinPlugins(): BuiltinPlugin[] {
  return BUILTIN_PLUGINS;
}

export function getBuiltinPlugin(pluginId: string): BuiltinPlugin | undefined {
  return BUILTIN_PLUGINS.find((plugin) => plugin.id === pluginId);
}
