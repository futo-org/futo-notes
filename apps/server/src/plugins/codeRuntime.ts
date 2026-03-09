import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import { validateTitle } from '@futo-notes/shared';
import { log } from '../logger.js';
import { upsertNote } from '../db/notes.js';
import {
  deleteNoteFile,
  readNoteFile,
  resolveFilename,
  sanitizeFilename,
  writeNoteFile,
} from '../sync/files.js';
import { contentHash } from '../sync/hash.js';
import type { GenerateFn } from '../transforms/types.js';
import type { LoadedPlugin, PluginResult } from './types.js';

export interface CodePluginConfig {
  [key: string]: unknown;
  maxContentChars?: number;
  fewShotCount?: number;
}

export interface CodePluginHelpers {
  contentHash: typeof contentHash;
  deleteNoteFile: typeof deleteNoteFile;
  log: typeof log;
  readNoteFile: typeof readNoteFile;
  resolveFilename: typeof resolveFilename;
  sanitizeFilename: typeof sanitizeFilename;
  upsertNote: typeof upsertNote;
  validateTitle: typeof validateTitle;
  writeNoteFile: typeof writeNoteFile;
}

export interface CodePluginPendingContext {
  db: Database.Database;
  notesPath: string;
  config: CodePluginConfig;
  force: boolean;
  helpers: CodePluginHelpers;
}

export interface CodePluginExecuteContext {
  db: Database.Database;
  notesPath: string;
  uuids: string[];
  config: CodePluginConfig;
  generate: GenerateFn;
  signal: AbortSignal;
  helpers: CodePluginHelpers;
}

export interface ExecutableCodePlugin {
  getPendingNotes(context: CodePluginPendingContext): string[];
  execute(context: CodePluginExecuteContext): Promise<PluginResult[]>;
}

function getHelpers(): CodePluginHelpers {
  return {
    contentHash,
    deleteNoteFile,
    log,
    readNoteFile,
    resolveFilename,
    sanitizeFilename,
    upsertNote,
    validateTitle,
    writeNoteFile,
  };
}

function buildCodePluginConfig(plugin: LoadedPlugin): CodePluginConfig {
  const runtime = plugin.manifest.runtime ?? {};
  return {
    ...runtime,
    maxContentChars: typeof runtime.max_content_chars === 'number' ? runtime.max_content_chars : undefined,
    fewShotCount: typeof runtime.few_shot_count === 'number'
      ? runtime.few_shot_count
      : typeof runtime.include_recent_titles === 'number'
        ? runtime.include_recent_titles
        : undefined,
  };
}

function isCodePluginModule(value: unknown): value is ExecutableCodePlugin {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as ExecutableCodePlugin).getPendingNotes === 'function'
    && typeof (value as ExecutableCodePlugin).execute === 'function',
  );
}

export async function loadCodePlugin(plugin: LoadedPlugin): Promise<ExecutableCodePlugin> {
  if (!plugin.entrypointPath) {
    throw new Error(`Plugin "${plugin.manifest.id}" has no code entrypoint`);
  }

  const stat = fs.statSync(plugin.entrypointPath);
  const href = `${pathToFileURL(plugin.entrypointPath).href}?mtime=${stat.mtimeMs}`;
  const mod = await import(href);
  const candidate = mod.default ?? mod.plugin ?? mod;
  if (!isCodePluginModule(candidate)) {
    throw new Error(`Plugin "${plugin.manifest.id}" must export getPendingNotes() and execute()`);
  }
  return candidate;
}

export async function getPendingNotesForCodePlugin(
  plugin: LoadedPlugin,
  db: Database.Database,
  notesPath: string,
  force: boolean,
): Promise<string[]> {
  const executable = await loadCodePlugin(plugin);
  return executable.getPendingNotes({
    db,
    notesPath,
    config: buildCodePluginConfig(plugin),
    force,
    helpers: getHelpers(),
  });
}

export async function executeCodePlugin(
  plugin: LoadedPlugin,
  db: Database.Database,
  notesPath: string,
  uuids: string[],
  generate: GenerateFn,
  signal: AbortSignal,
): Promise<PluginResult[]> {
  const executable = await loadCodePlugin(plugin);
  return executable.execute({
    db,
    notesPath,
    uuids,
    config: buildCodePluginConfig(plugin),
    generate,
    signal,
    helpers: getHelpers(),
  });
}
