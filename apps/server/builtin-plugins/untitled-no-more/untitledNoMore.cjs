const UNTITLED_RE = /^Untitled(?: \(\d+\))?\.md$/;
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

module.exports = {
  getPendingNotes({ db, force }) {
    const now = Date.now();
    const cutoff = now - STALE_THRESHOLD_MS;

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

    const rows = force ? db.prepare(query).all() : db.prepare(query).all(cutoff);

    return rows
      .filter((row) => UNTITLED_RE.test(row.filename))
      .map((row) => row.uuid);
  },

  async execute({ db, notesPath, uuids, config, generate, signal, helpers }) {
    const maxContentChars = typeof config.maxContentChars === 'number' ? config.maxContentChars : 2000;
    const fewShotCount = typeof config.fewShotCount === 'number' ? config.fewShotCount : 10;
    const results = [];

    const examples = db.prepare(`
      SELECT filename FROM notes
      WHERE filename NOT GLOB 'Untitled*.md'
      ORDER BY modified_at DESC
      LIMIT ?
    `).all(fewShotCount);

    const exampleTitles = examples
      .map((entry) => entry.filename.replace(/\.md$/, ''))
      .map((title) => `- ${title}`)
      .join('\n');

    for (const uuid of uuids) {
      if (signal.aborted) {
        break;
      }

      try {
        const note = db.prepare('SELECT filename, content_hash FROM notes WHERE uuid = ?')
          .get(uuid);
        if (!note || !UNTITLED_RE.test(note.filename)) {
          continue;
        }

        const content = helpers.readNoteFile(notesPath, note.filename);
        if (!content || content.trim().length < 10) {
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

        const snippet = content.slice(0, maxContentChars);
        let systemPrompt = 'You suggest short, natural note titles (2-6 words, lowercase).';
        if (exampleTitles) {
          systemPrompt += `\nExamples from this user:\n${exampleTitles}`;
        } else {
          systemPrompt += '\nExamples: "Carnitas recipe", "Books I\'ve read", "Learning DynamoDB", "weird but true facts".';
        }
        systemPrompt += '\nReply with ONLY the title, no quotes, no explanation.';

        const raw = await generate(`Suggest a title for this note:\n\n${snippet}`, {
          systemPrompt,
          maxTokens: 64,
          temperature: 0.3,
          thinking: false,
          signal,
        });

        const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
        const title = (lines[0] ?? '').replace(/^["']|["']$/g, '').replace(/\.md$/i, '').trim();

        if (!title || title.length < 2) {
          helpers.log.warn(`plugins: untitled-no-more: empty title generated for ${note.filename} (raw=${JSON.stringify(raw.slice(0, 100))}), skipping`);
          continue;
        }

        const titleIssues = helpers.validateTitle(title);
        if (titleIssues.length > 0) {
          const details = titleIssues.map((issue) => issue.kind).join(', ');
          helpers.log.warn(`plugins: untitled-no-more: invalid title generated for ${note.filename} [${details}], skipping`);
          continue;
        }

        const newFilename = helpers.resolveFilename(db, helpers.sanitizeFilename(`${title}.md`), uuid);
        const oldFilename = note.filename;
        if (newFilename === oldFilename) {
          continue;
        }

        const now = Date.now();
        const hash = helpers.contentHash(content);
        helpers.writeNoteFile(notesPath, newFilename, content, now);
        helpers.deleteNoteFile(notesPath, oldFilename);
        helpers.upsertNote(db, uuid, newFilename, hash, now);

        db.prepare(`
          INSERT INTO transform_state (transform_id, uuid, content_hash, processed_at, result)
          VALUES ('untitled-no-more', ?, ?, ?, ?)
          ON CONFLICT(transform_id, uuid) DO UPDATE SET
            content_hash = excluded.content_hash,
            processed_at = excluded.processed_at,
            result = excluded.result
        `).run(uuid, hash, now, `renamed: ${oldFilename} -> ${newFilename}`);

        db.prepare(`
          INSERT INTO transform_history (transform_id, uuid, action, old_filename, new_filename, executed_at)
          VALUES ('untitled-no-more', ?, 'rename_note', ?, ?, ?)
        `).run(uuid, oldFilename, newFilename, now);

        results.push({
          noteUuid: uuid,
          action: 'rename_note',
          oldFilename,
          newFilename,
        });

        helpers.log.info(`plugins: untitled-no-more: renamed "${oldFilename}" -> "${newFilename}"`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        helpers.log.warn(`plugins: untitled-no-more: error processing ${uuid}: ${message}`);
      }
    }

    return results;
  },
};
