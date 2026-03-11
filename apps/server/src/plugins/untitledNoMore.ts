import { validateTitle } from '@futo-notes/shared';
import type { BuiltinPlugin, PluginRunContext } from './types.js';

const UNTITLED_RE = /^Untitled(?: \(\d+\))?\.md$/;
const DEFAULT_TITLE_EXAMPLES = [
  'Carnitas recipe',
  "Books I've read",
  'Learning DynamoDB',
  'weird but true facts',
];

type PromptMode = 'default' | 'retry';

interface UntitledNoMoreState {
  sourceHash: string;
  lastSuggestedTitle: string | null;
  lastResult: string;
  lastRunAt: number;
}

interface TitleAttempt {
  promptMode: PromptMode;
  raw: string;
  title: string;
  issues: ReturnType<typeof validateTitle>;
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

function buildPrompt(
  content: string,
  recentTitles: string[],
  maxContentChars: number,
  promptMode: PromptMode,
): { systemPrompt: string; userPrompt: string } {
  const snippet = content.slice(0, maxContentChars);
  let systemPrompt = 'You suggest short, natural note titles (2-6 words, lowercase).';
  if (recentTitles.length > 0) {
    systemPrompt += `\nExamples from this user:\n${recentTitles.map((title) => `- ${title}`).join('\n')}`;
  } else {
    systemPrompt += `\nExamples: ${DEFAULT_TITLE_EXAMPLES.map((title) => `"${title}"`).join(', ')}.`;
  }
  systemPrompt += '\nReply with ONLY the title, no quotes and no explanation.';
  if (promptMode === 'retry') {
    systemPrompt += '\nDo not return an empty response. If you are unsure, make your best guess.';
  }

  return {
    systemPrompt,
    userPrompt: promptMode === 'retry'
      ? `Suggest a title for this note. Return exactly one short title.\n\n${snippet}`
      : `Suggest a clear title for this note:\n\n${snippet}`,
  };
}

async function generateTitleAttempts(
  context: PluginRunContext,
  noteTitle: string,
  content: string,
  recentTitles: string[],
  maxContentChars: number,
  maxTokens: number,
  temperature: number,
): Promise<TitleAttempt[]> {
  const attempts: TitleAttempt[] = [];

  for (const promptMode of ['default', 'retry'] as const) {
    const prompt = buildPrompt(content, recentTitles, maxContentChars, promptMode);
    const raw = await context.sdk.runBuiltinLlm({
      purpose: 'untitled-no-more-title',
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      maxTokens,
      temperature,
      timeoutMs: 30_000,
      disableThinking: true,
    });
    const title = getFirstContentLine(raw);
    const issues = title.length > 0 ? validateTitle(title) : [];

    attempts.push({
      promptMode,
      raw,
      title,
      issues,
    });

    if (title.length >= 2 && issues.length === 0 && title !== noteTitle) {
      break;
    }
  }

  return attempts;
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

  const attempts = await generateTitleAttempts(
    context,
    note.title,
    content,
    recentTitles,
    maxContentChars,
    maxTokens,
    temperature,
  );
  const accepted = attempts.find((attempt) => attempt.title.length >= 2 && attempt.issues.length === 0 && attempt.title !== note.title);
  const invalid = attempts.find((attempt) => attempt.title.length >= 2 && attempt.issues.length > 0);
  const unchanged = attempts.find((attempt) => attempt.title.length >= 2 && attempt.title === note.title);
  const lastAttempt = attempts[attempts.length - 1];

  if (!accepted && invalid) {
    await context.sdk.log('warn', 'Skipping invalid title suggestion', {
      noteUuid: note.uuid,
      title: invalid.title,
      issues: invalid.issues.map((issue) => issue.kind),
    });
    await context.sdk.setPluginState(stateKey, {
      sourceHash: note.contentHash,
      lastSuggestedTitle: invalid.title,
      lastResult: 'skipped: invalid_title',
      lastRunAt: Date.now(),
    } satisfies UntitledNoMoreState);
    return 'skipped';
  }

  if (!accepted && unchanged) {
    await context.sdk.setPluginState(stateKey, {
      sourceHash: note.contentHash,
      lastSuggestedTitle: unchanged.title,
      lastResult: 'skipped: unchanged',
      lastRunAt: Date.now(),
    } satisfies UntitledNoMoreState);
    return 'skipped';
  }

  if (!accepted) {
    await context.sdk.log('warn', 'Skipping empty title suggestion', {
      noteUuid: note.uuid,
      raw: lastAttempt?.raw.slice(0, 120) ?? '',
      attempts: attempts.map((attempt) => ({
        promptMode: attempt.promptMode,
        rawLength: attempt.raw.length,
      })),
    });
    await context.sdk.setPluginState(stateKey, {
      sourceHash: note.contentHash,
      lastSuggestedTitle: null,
      lastResult: 'skipped: empty_title',
      lastRunAt: Date.now(),
    } satisfies UntitledNoMoreState);
    return 'skipped';
  }

  const title = accepted.title;

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
  configSchema: [],

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
