import type { PluginTagDefinition } from './types.js';

export function getNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function getString(config: Record<string, unknown>, key: string, fallback: string): string {
  const value = config[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

export function getBoolean(config: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = config[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function isTagDefinitionList(value: unknown): value is PluginTagDefinition[] {
  return Array.isArray(value) && value.every((item) => (
    typeof item === 'object'
    && item !== null
    && typeof (item as { name?: unknown }).name === 'string'
    && typeof (item as { description?: unknown }).description === 'string'
  ));
}

export function parseLenientJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

/** Regex matching Untitled note filenames: "Untitled.md", "Untitled (2).md", etc. */
export const UNTITLED_FILENAME_RE = /^Untitled(?: \(\d+\))?\.md$/;

/** Regex matching Untitled note titles (without .md extension). */
export const UNTITLED_TITLE_RE = /^Untitled(?: \(\d+\))?$/;
