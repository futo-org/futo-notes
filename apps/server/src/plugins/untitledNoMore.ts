import { validateTitle } from '@futo-notes/shared';
import type { BuiltinPlugin, PluginRunContext } from './types.js';

const UNTITLED_RE = /^Untitled(?: \(\d+\))?\.md$/;

interface UntitledNoMoreState {
  sourceHash: string;
  lastSuggestedTitle: string | null;
  lastResult: string;
  lastRunAt: number;
}

function getNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function getFirstContentLine(raw: string): string {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return (lines[0] ?? '').replace(/^["']|["']$/g, '').replace(/\.md$/i, '').trim();
}

function buildPrompt(content: string, recentTitles: string[], maxContentChars: number): { systemPrompt: string; userPrompt: string } {
  const snippet = content.slice(0, maxContentChars);
  let systemPrompt = 'You suggest short, natural note titles (2-6 words). Reply with only the title, no quotes and no explanation.';
  if (recentTitles.length > 0) {
    systemPrompt += `\n\nRecent titles from this vault:\n${recentTitles.map((title) => `- ${title}`).join('\n')}`;
  }

  return {
    systemPrompt,
    userPrompt: `Suggest a clear title for this note:\n\n${snippet}`,
  };
}

async function processCandidate(
  noteUuid: string,
  context: PluginRunContext,
  recentTitles: string[],
): Promise<'proposed' | 'skipped'> {
  const stateKey = `note:${noteUuid}`;
  const note = await context.sdk.getNote(noteUuid);
  if (!note || !UNTITLED_RE.test(note.filename)) {
    return 'skipped';
  }

  const staleMinutes = getNumber(context.config, 'staleMinutes', 5);
  const minContentChars = getNumber(context.config, 'minContentChars', 10);
  const maxContentChars = getNumber(context.config, 'maxContentChars', 2000);
  const temperature = getNumber(context.config, 'temperature', 0.3);
  const maxTokens = getNumber(context.config, 'maxTokens', 64);

  if (context.triggerType !== 'manual') {
    const cutoff = Date.now() - staleMinutes * 60_000;
    if (note.modifiedAt >= cutoff) {
      await context.sdk.setPluginState(stateKey, {
        sourceHash: note.contentHash,
        lastSuggestedTitle: null,
        lastResult: 'skipped: recently_modified',
        lastRunAt: Date.now(),
      } satisfies UntitledNoMoreState);
      return 'skipped';
    }

    const previous = await context.sdk.getPluginState<UntitledNoMoreState>(stateKey);
    if (previous?.sourceHash === note.contentHash) {
      return 'skipped';
    }
  }

  const content = await context.sdk.readNoteContent(note.uuid);
  if (!content || content.trim().length < minContentChars) {
    await context.sdk.setPluginState(stateKey, {
      sourceHash: note.contentHash,
      lastSuggestedTitle: null,
      lastResult: 'skipped: content_too_short',
      lastRunAt: Date.now(),
    } satisfies UntitledNoMoreState);
    return 'skipped';
  }

  const prompt = buildPrompt(content, recentTitles, maxContentChars);
  const raw = await context.sdk.runBuiltinLlm({
    purpose: 'untitled-no-more-title',
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    maxTokens,
    temperature,
    timeoutMs: 30_000,
  });

  const title = getFirstContentLine(raw);
  if (!title || title.length < 2) {
    await context.sdk.log('warn', 'Skipping empty title suggestion', { noteUuid: note.uuid, raw: raw.slice(0, 120) });
    await context.sdk.setPluginState(stateKey, {
      sourceHash: note.contentHash,
      lastSuggestedTitle: null,
      lastResult: 'skipped: empty_title',
      lastRunAt: Date.now(),
    } satisfies UntitledNoMoreState);
    return 'skipped';
  }

  const issues = validateTitle(title);
  if (issues.length > 0) {
    await context.sdk.log('warn', 'Skipping invalid title suggestion', {
      noteUuid: note.uuid,
      title,
      issues: issues.map((issue) => issue.kind),
    });
    await context.sdk.setPluginState(stateKey, {
      sourceHash: note.contentHash,
      lastSuggestedTitle: title,
      lastResult: 'skipped: invalid_title',
      lastRunAt: Date.now(),
    } satisfies UntitledNoMoreState);
    return 'skipped';
  }

  if (title === note.title) {
    await context.sdk.setPluginState(stateKey, {
      sourceHash: note.contentHash,
      lastSuggestedTitle: title,
      lastResult: 'skipped: unchanged',
      lastRunAt: Date.now(),
    } satisfies UntitledNoMoreState);
    return 'skipped';
  }

  const itemId = await context.sdk.proposeChange({
    entityType: 'note',
    entityId: note.uuid,
    changeType: 'rename_note',
    before: {
      title: note.title,
      filename: note.filename,
    },
    after: {
      newTitle: title,
      rewriteExactWikiLinks: true,
    },
    preview: {
      oldTitle: note.title,
      proposedTitle: title,
      noteUuid: note.uuid,
      rewriteExactWikiLinks: true,
    },
    reason: 'LLM-generated replacement for placeholder untitled note',
  });

  await context.sdk.log('info', 'Proposed rename', { noteUuid: note.uuid, itemId, title });
  await context.sdk.setPluginState(stateKey, {
    sourceHash: note.contentHash,
    lastSuggestedTitle: title,
    lastResult: 'proposed',
    lastRunAt: Date.now(),
  } satisfies UntitledNoMoreState);
  return 'proposed';
}

export const untitledNoMorePlugin: BuiltinPlugin = {
  id: 'untitled-no-more',
  name: 'Untitled No More',
  description: 'Suggest better titles for placeholder Untitled notes.',
  defaultEnabled: false,
  defaultSchedule: {
    kind: 'daily',
    time: '03:00',
    day: null,
  },
  defaultAutoApply: false,
  configSchema: [
    {
      key: 'staleMinutes',
      label: 'Minimum note age (minutes)',
      type: 'number',
      default: 5,
      min: 1,
      max: 1_440,
    },
    {
      key: 'minContentChars',
      label: 'Minimum content length',
      type: 'number',
      default: 10,
      min: 1,
      max: 500,
    },
    {
      key: 'maxContentChars',
      label: 'Max content to analyze',
      type: 'number',
      default: 2_000,
      min: 200,
      max: 8_000,
    },
    {
      key: 'fewShotCount',
      label: 'Recent title examples',
      type: 'number',
      default: 10,
      min: 0,
      max: 30,
    },
    {
      key: 'temperature',
      label: 'Model temperature',
      type: 'number',
      default: 0.3,
      min: 0,
      max: 1,
    },
    {
      key: 'maxTokens',
      label: 'Max output tokens',
      type: 'number',
      default: 64,
      min: 16,
      max: 256,
    },
  ],

  async run(context: PluginRunContext) {
    const staleMinutes = getNumber(context.config, 'staleMinutes', 5);
    const fewShotCount = getNumber(context.config, 'fewShotCount', 10);
    const modifiedBefore = context.triggerType === 'manual'
      ? undefined
      : Date.now() - staleMinutes * 60_000;

    const candidates = await context.sdk.findNotes({
      filenameGlob: 'Untitled*.md',
      modifiedBefore,
      sort: 'modified_asc',
    });

    const filtered = candidates.filter((note) => UNTITLED_RE.test(note.filename));
    const recentTitles = fewShotCount > 0
      ? (await context.sdk.listRecentNotes(fewShotCount, { excludeUntitled: true })).map((note) => note.title)
      : [];

    let proposalsCreated = 0;
    let notesSkipped = 0;
    for (const note of filtered) {
      if (context.signal.aborted) break;
      const result = await processCandidate(note.uuid, context, recentTitles);
      if (result === 'proposed') {
        proposalsCreated += 1;
      } else {
        notesSkipped += 1;
      }
    }

    return {
      notesScanned: filtered.length,
      proposalsCreated,
      notesSkipped,
    };
  },
};
