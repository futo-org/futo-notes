import type Database from 'better-sqlite3';
import { validateTitle } from '@futo-notes/shared';
import type { SmartTransform, TransformResult, GenerateFn } from './types.js';
import { readNoteFile, deleteNoteFile, writeNoteFile, sanitizeFilename, resolveFilename } from '../sync/files.js';
import { upsertNote } from '../db/notes.js';
import { contentHash } from '../sync/hash.js';
import { log } from '../logger.js';

const UNTITLED_RE = /^Untitled(?: \(\d+\))?\.md$/;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export const untitledNoMore: SmartTransform = {
  id: 'untitled-no-more',
  name: 'Untitled No More',
  description: 'Auto-renames notes with default "Untitled" filenames using content analysis.',
  configSchema: [
    {
      key: 'maxContentChars',
      label: 'Max content to analyze',
      type: 'number',
      default: 2000,
      description: 'Maximum characters of note content to send to the model.',
      min: 500,
      max: 8000,
    },
    {
      key: 'fewShotCount',
      label: 'Example titles count',
      type: 'number',
      default: 10,
      description: 'Number of existing note titles to use as style examples.',
      min: 0,
      max: 30,
    },
  ],

  getPendingNotes(db: Database.Database, opts?: { force?: boolean }): string[] {
    const now = Date.now();
    const cutoff = now - STALE_THRESHOLD_MS;
    const force = opts?.force ?? false;

    // Get untitled notes that haven't been processed (or whose content changed)
    const query = force
      ? `SELECT n.uuid, n.filename, n.content_hash, n.modified_at
         FROM notes n
         LEFT JOIN transform_state ts
           ON ts.transform_id = 'untitled-no-more' AND ts.uuid = n.uuid
         WHERE n.filename GLOB 'Untitled*.md'
           AND (ts.uuid IS NULL OR ts.content_hash != n.content_hash)`
      : `SELECT n.uuid, n.filename, n.content_hash, n.modified_at
         FROM notes n
         LEFT JOIN transform_state ts
           ON ts.transform_id = 'untitled-no-more' AND ts.uuid = n.uuid
         WHERE n.filename GLOB 'Untitled*.md'
           AND n.modified_at < ?
           AND (ts.uuid IS NULL OR ts.content_hash != n.content_hash)`;

    type NoteRow = { uuid: string; filename: string; content_hash: string; modified_at: number };
    const rows = (force ? db.prepare(query).all() : db.prepare(query).all(cutoff)) as NoteRow[];

    // Filter with the strict regex (GLOB is a coarse filter)
    return rows
      .filter((r) => UNTITLED_RE.test(r.filename))
      .map((r) => r.uuid);
  },

  async execute(
    db: Database.Database,
    notesPath: string,
    uuids: string[],
    config: Record<string, unknown>,
    generate: GenerateFn,
    signal: AbortSignal,
  ): Promise<TransformResult[]> {
    const maxContentChars = typeof config.maxContentChars === 'number' ? config.maxContentChars : 2000;
    const fewShotCount = typeof config.fewShotCount === 'number' ? config.fewShotCount : 10;
    const results: TransformResult[] = [];

    // Gather few-shot examples from user's existing named notes
    const examples = db.prepare(`
      SELECT filename FROM notes
      WHERE filename NOT GLOB 'Untitled*.md'
      ORDER BY modified_at DESC
      LIMIT ?
    `).all(fewShotCount) as { filename: string }[];

    const exampleTitles = examples
      .map((e) => e.filename.replace(/\.md$/, ''))
      .map((t) => `- ${t}`)
      .join('\n');

    for (const uuid of uuids) {
      if (signal.aborted) break;

      try {
        // Get current note info
        const note = db.prepare('SELECT filename, content_hash FROM notes WHERE uuid = ?')
          .get(uuid) as { filename: string; content_hash: string } | undefined;
        if (!note) continue;

        // Re-verify it's still untitled
        if (!UNTITLED_RE.test(note.filename)) continue;

        // Read content
        const content = readNoteFile(notesPath, note.filename);
        if (!content || content.trim().length < 10) {
          // Too short to generate a meaningful title — mark as processed to skip next run
          db.prepare(`
            INSERT INTO transform_state (transform_id, uuid, content_hash, processed_at, result)
            VALUES ('untitled-no-more', ?, ?, ?, 'skipped: content too short')
            ON CONFLICT(transform_id, uuid) DO UPDATE SET
              content_hash = excluded.content_hash,
              processed_at = excluded.processed_at,
              result = excluded.result
          `).run(uuid, note.content_hash, Date.now());
          continue;
        }

        // Build system prompt (matching working experiment format)
        const snippet = content.slice(0, maxContentChars);
        let systemPrompt = 'You suggest short, natural note titles (2-6 words, lowercase).';
        if (exampleTitles) {
          systemPrompt += `\nExamples from this user:\n${exampleTitles}`;
        } else {
          systemPrompt += '\nExamples: "Carnitas recipe", "Books I\'ve read", "Learning DynamoDB", "weird but true facts".';
        }
        systemPrompt += '\nReply with ONLY the title, no quotes, no explanation.';

        const userPrompt = `Suggest a title for this note:\n\n${snippet}`;

        // Generate title
        const raw = await generate(userPrompt, {
          systemPrompt,
          maxTokens: 64,
          temperature: 0.3,
          thinking: false,
          signal,
        });

        // Clean generated title: take first non-empty line, strip quotes and extension
        const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
        const title = (lines[0] ?? '').replace(/^["']|["']$/g, '').replace(/\.md$/i, '').trim();

        if (!title || title.length < 2) {
          log.warn(`transforms: untitled-no-more: empty title generated for ${note.filename} (raw=${JSON.stringify(raw.slice(0, 100))}), skipping`);
          continue;
        }

        const titleIssues = validateTitle(title);
        if (titleIssues.length > 0) {
          const details = titleIssues.map((issue) => issue.kind).join(', ');
          log.warn(`transforms: untitled-no-more: invalid title generated for ${note.filename} [${details}], skipping`);
          continue;
        }

        // Sanitize and resolve unique filename
        const sanitized = sanitizeFilename(title + '.md');
        const newFilename = resolveFilename(db, sanitized, uuid);
        const oldFilename = note.filename;

        if (newFilename === oldFilename) continue;

        // Rename: write new → delete old → update DB (write-first so a failure preserves the old file)
        const now = Date.now();
        const hash = contentHash(content);
        writeNoteFile(notesPath, newFilename, content, now);
        deleteNoteFile(notesPath, oldFilename);
        upsertNote(db, uuid, newFilename, hash, now);

        // Record in transform_state
        db.prepare(`
          INSERT INTO transform_state (transform_id, uuid, content_hash, processed_at, result)
          VALUES ('untitled-no-more', ?, ?, ?, ?)
          ON CONFLICT(transform_id, uuid) DO UPDATE SET
            content_hash = excluded.content_hash,
            processed_at = excluded.processed_at,
            result = excluded.result
        `).run(uuid, hash, now, `renamed: ${oldFilename} → ${newFilename}`);

        // Record in transform_history
        db.prepare(`
          INSERT INTO transform_history (transform_id, uuid, action, old_filename, new_filename, executed_at)
          VALUES ('untitled-no-more', ?, 'rename', ?, ?, ?)
        `).run(uuid, oldFilename, newFilename, now);

        results.push({
          noteUuid: uuid,
          action: 'rename',
          oldFilename,
          newFilename,
        });

        log.info(`transforms: untitled-no-more: renamed "${oldFilename}" → "${newFilename}"`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`transforms: untitled-no-more: error processing ${uuid}: ${message}`);
        // Don't mark as processed — will retry next run
      }
    }

    return results;
  },
};
