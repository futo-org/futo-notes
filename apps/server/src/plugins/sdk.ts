import type Database from 'better-sqlite3';
import { validateTitle } from '@futo-notes/shared';
import { contentHash } from '../sync/hash.js';
import { deleteNoteFile, readNoteFile, resolveFilename, sanitizeFilename, writeNoteFile } from '../sync/files.js';
import { getNote, type NoteRow, upsertNote } from '../db/notes.js';
import type {
  PluginFindNotesFilter,
  PluginLogLevel,
  PluginNoteMeta,
  PluginSdk,
  ProposeChangeInput,
  RenameNoteInput,
  RunBuiltinLlmInput,
} from './types.js';

function stripMd(filename: string): string {
  return filename.replace(/\.md$/i, '');
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toPluginNoteMeta(row: NoteRow): PluginNoteMeta {
  return {
    uuid: row.uuid,
    filename: row.filename,
    title: stripMd(row.filename),
    contentHash: row.content_hash,
    modifiedAt: row.modified_at,
    createdAt: row.created_at,
  };
}

function sortRows(rows: NoteRow[], sort: PluginFindNotesFilter['sort']): NoteRow[] {
  const sorted = [...rows];
  switch (sort) {
    case 'modified_asc':
      sorted.sort((a, b) => a.modified_at - b.modified_at);
      break;
    case 'created_asc':
      sorted.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      break;
    case 'created_desc':
      sorted.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      break;
    case 'modified_desc':
    default:
      sorted.sort((a, b) => b.modified_at - a.modified_at);
      break;
  }
  return sorted;
}

export function createPluginSdk(
  db: Database.Database,
  notesPath: string,
  pluginId: string,
  runId: string,
  llmRunner: (input: RunBuiltinLlmInput) => Promise<string>,
): PluginSdk {
  async function findNotes(filter: PluginFindNotesFilter = {}): Promise<PluginNoteMeta[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (typeof filter.modifiedBefore === 'number') {
      clauses.push('modified_at < ?');
      params.push(filter.modifiedBefore);
    }
    if (typeof filter.modifiedAfter === 'number') {
      clauses.push('modified_at > ?');
      params.push(filter.modifiedAfter);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT uuid, filename, content_hash, modified_at, created_at
      FROM notes
      ${where}
    `).all(...params) as NoteRow[];

    const filenameGlob = filter.filenameGlob ? globToRegExp(filter.filenameGlob) : null;
    const filenameRegex = filter.filenameRegex ? new RegExp(filter.filenameRegex) : null;
    const excludeFilenameGlob = filter.excludeFilenameGlob ? globToRegExp(filter.excludeFilenameGlob) : null;
    const excludeFilenameRegex = filter.excludeFilenameRegex ? new RegExp(filter.excludeFilenameRegex) : null;

    const filtered = sortRows(rows, filter.sort).filter((row) => {
      if (filenameGlob && !filenameGlob.test(row.filename)) return false;
      if (filenameRegex && !filenameRegex.test(row.filename)) return false;
      if (excludeFilenameGlob && excludeFilenameGlob.test(row.filename)) return false;
      if (excludeFilenameRegex && excludeFilenameRegex.test(row.filename)) return false;
      return true;
    });

    const limited = typeof filter.limit === 'number' && filter.limit >= 0
      ? filtered.slice(0, filter.limit)
      : filtered;
    return limited.map(toPluginNoteMeta);
  }

  return {
    findNotes,

    async getNote(uuid: string): Promise<PluginNoteMeta | null> {
      const note = getNote(db, uuid);
      return note ? toPluginNoteMeta(note) : null;
    },

    async readNoteContent(uuid: string): Promise<string | null> {
      const note = getNote(db, uuid);
      if (!note) return null;
      return readNoteFile(notesPath, note.filename);
    },

    async listRecentNotes(limit: number, opts?: { excludeUuid?: string; excludeUntitled?: boolean }): Promise<PluginNoteMeta[]> {
      const rows = db.prepare(`
        SELECT uuid, filename, content_hash, modified_at, created_at
        FROM notes
        ORDER BY modified_at DESC
        LIMIT ?
      `).all(Math.max(limit * 3, limit)) as NoteRow[];

      const result: PluginNoteMeta[] = [];
      for (const row of rows) {
        if (opts?.excludeUuid && row.uuid === opts.excludeUuid) continue;
        if (opts?.excludeUntitled && /^Untitled(?: \(\d+\))?\.md$/.test(row.filename)) continue;
        result.push(toPluginNoteMeta(row));
        if (result.length >= limit) break;
      }
      return result;
    },

    async runBuiltinLlm(input: RunBuiltinLlmInput): Promise<string> {
      return llmRunner(input);
    },

    async proposeChange(input: ProposeChangeInput): Promise<number> {
      const now = Date.now();
      const result = db.prepare(`
        INSERT INTO plugin_run_items (
          run_id, entity_type, entity_id, change_type,
          before_json, after_json, preview_json, reason, confidence,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'suggested', ?, ?)
      `).run(
        runId,
        input.entityType,
        input.entityId,
        input.changeType,
        JSON.stringify(input.before),
        JSON.stringify(input.after),
        JSON.stringify(input.preview),
        input.reason,
        input.confidence ?? null,
        now,
        now,
      );
      return Number(result.lastInsertRowid);
    },

    async renameNote(input: RenameNoteInput): Promise<{ finalTitle: string; finalFilename: string; rewrittenNotes: number }> {
      const note = getNote(db, input.noteUuid);
      if (!note) {
        throw new Error(`Unknown note: ${input.noteUuid}`);
      }

      const desiredTitle = input.newTitle.trim().replace(/\.md$/i, '');
      const titleIssues = validateTitle(desiredTitle);
      if (titleIssues.length > 0) {
        throw new Error(`Invalid title: ${titleIssues.map((issue) => issue.kind).join(', ')}`);
      }

      const oldTitle = stripMd(note.filename);
      const finalFilename = resolveFilename(db, sanitizeFilename(`${desiredTitle}.md`), note.uuid);
      const finalTitle = stripMd(finalFilename);
      const now = Date.now();
      const linkPattern = input.rewriteExactWikiLinks && oldTitle !== finalTitle
        ? new RegExp(`\\[\\[${escapeRegExp(oldTitle)}\\]\\]`, 'g')
        : null;

      const rows = db.prepare(`
        SELECT uuid, filename, content_hash, modified_at, created_at
        FROM notes
      `).all() as NoteRow[];

      let rewrittenNotes = 0;
      for (const row of rows) {
        const originalContent = readNoteFile(notesPath, row.filename);
        if (originalContent === null) continue;

        let nextContent = originalContent;
        if (linkPattern) {
          nextContent = nextContent.replace(linkPattern, `[[${finalTitle}]]`);
        }

        const contentChanged = nextContent !== originalContent;
        const isTarget = row.uuid === note.uuid;
        const nextFilename = isTarget ? finalFilename : row.filename;
        const filenameChanged = isTarget && nextFilename !== row.filename;

        if (!contentChanged && !filenameChanged) {
          continue;
        }

        writeNoteFile(notesPath, nextFilename, nextContent, now);
        if (filenameChanged) {
          deleteNoteFile(notesPath, row.filename);
        }
        upsertNote(db, row.uuid, nextFilename, contentHash(nextContent), now);

        if (contentChanged) {
          rewrittenNotes += 1;
        }
      }

      if (finalFilename === note.filename && rewrittenNotes === 0) {
        return { finalTitle, finalFilename, rewrittenNotes };
      }

      return { finalTitle, finalFilename, rewrittenNotes };
    },

    async log(level: PluginLogLevel, message: string, context?: Record<string, unknown>): Promise<void> {
      db.prepare(`
        INSERT INTO plugin_run_logs (run_id, timestamp, level, message, context_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(runId, Date.now(), level, message, context ? JSON.stringify(context) : null);
    },

    async getPluginState<T = unknown>(key: string): Promise<T | null> {
      const row = db.prepare(`
        SELECT value_json
        FROM plugin_state
        WHERE plugin_id = ? AND state_key = ?
      `).get(pluginId, key) as { value_json: string } | undefined;

      if (!row) return null;
      return JSON.parse(row.value_json) as T;
    },

    async setPluginState(key: string, value: unknown): Promise<void> {
      db.prepare(`
        INSERT INTO plugin_state (plugin_id, state_key, value_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(plugin_id, state_key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(pluginId, key, JSON.stringify(value), Date.now());
    },
  };
}
