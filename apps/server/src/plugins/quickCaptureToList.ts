import type { PluginNoteMeta } from './types.js';
import type { BuiltinPlugin, PluginRunContext } from './types.js';
import {
  appendToFirstRegularListBlock,
  buildInsertedListText,
  findFirstRegularListBlock,
  qualifiesAsListNote,
} from './listNotes.js';

const UNTITLED_RE = /^Untitled(?: \(\d+\))?\.md$/;
const FALLBACK_LIST_TITLE = 'Quick capture inbox';

interface ListNoteCandidate {
  note: PluginNoteMeta;
  content: string;
}

function normalizeLlmResponse(raw: string): string | null {
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) return null;

  const cleaned = firstLine.replace(/^["']|["']$/g, '').replace(/\.md$/i, '').trim();
  if (cleaned.length === 0 || cleaned.toLowerCase() === 'null') {
    return null;
  }
  return cleaned;
}

async function listListNoteCandidates(context: PluginRunContext): Promise<ListNoteCandidate[]> {
  const notes = await context.sdk.findNotes({
    excludeFilenameRegex: '^Untitled(?: \\(\\d+\\))?\\.md$',
    sort: 'modified_desc',
  });

  const candidates: ListNoteCandidate[] = [];
  for (const note of notes) {
    const content = await context.sdk.readNoteContent(note.uuid);
    if (!content || !qualifiesAsListNote(content) || !findFirstRegularListBlock(content)) {
      continue;
    }
    candidates.push({ note, content });
  }

  return candidates;
}

async function chooseDestinationTitle(
  context: PluginRunContext,
  quickCaptureText: string,
  candidates: ListNoteCandidate[],
): Promise<string | null> {
  if (candidates.length === 0) {
    return null;
  }

  const raw = await context.sdk.runBuiltinLlm({
    purpose: 'quick-capture-to-list-selection',
    userPrompt: [
      'Based on this text, which of these lists does this belong to?',
      '',
      quickCaptureText.trim(),
      '',
      'Reply with exactly one title from this list, or null if none fit:',
      ...candidates.map((candidate) => `- ${candidate.note.title}`),
    ].join('\n'),
    maxTokens: 32,
    temperature: 0,
    timeoutMs: 30_000,
    disableThinking: true,
  });

  const selectedTitle = normalizeLlmResponse(raw);
  if (!selectedTitle) {
    return null;
  }

  return candidates.find((candidate) => candidate.note.title === selectedTitle)?.note.title ?? null;
}

async function processUntitledNote(
  note: PluginNoteMeta,
  context: PluginRunContext,
  candidates: ListNoteCandidate[],
  fallbackContentRef: { value: string | null },
): Promise<'proposed' | 'skipped'> {
  const content = await context.sdk.readNoteContent(note.uuid);
  if (!content || content.trim().length === 0) {
    return 'skipped';
  }

  const selectedTitle = await chooseDestinationTitle(context, content, candidates);
  const destination = selectedTitle
    ? candidates.find((candidate) => candidate.note.title === selectedTitle) ?? null
    : null;
  const fallbackContent = fallbackContentRef.value;
  const fallbackBlock = fallbackContent ? findFirstRegularListBlock(fallbackContent) : null;
  const destinationBlock = destination
    ? findFirstRegularListBlock(destination.content)
    : fallbackBlock;

  const insertedListText = destinationBlock
    ? buildInsertedListText(content, destinationBlock)
    : buildInsertedListText(content, { kind: 'unordered', indent: '', bullet: '-' });
  if (insertedListText.length === 0) {
    return 'skipped';
  }

  const fallbackUsed = !destination || !destinationBlock;
  const destinationTitle = fallbackUsed ? FALLBACK_LIST_TITLE : destination.note.title;
  const destinationNoteUuid = fallbackUsed ? null : destination.note.uuid;

  await context.sdk.proposeChange({
    entityType: 'note',
    entityId: note.uuid,
    changeType: 'merge_note_into_list',
    before: {
      sourceTitle: note.title,
      sourceFilename: note.filename,
      destinationTitle: destinationTitle,
    },
    after: {
      destinationNoteUuid,
      destinationTitle,
      insertedListText,
      fallbackUsed,
    },
    preview: {
      sourceTitle: note.title,
      destinationTitle,
      destinationMode: fallbackUsed ? 'created' : 'existing',
      insertedListText,
      fallbackUsed,
    },
    reason: 'Move quick capture into the best matching list note',
  });

  await context.sdk.log('info', 'Proposed quick capture merge', {
    sourceNoteUuid: note.uuid,
    destinationTitle,
    fallbackUsed,
  });

  if (fallbackUsed) {
    fallbackContentRef.value = fallbackContent
      ? appendToFirstRegularListBlock(fallbackContent, insertedListText, { allowCreateBlock: true })
      : insertedListText;
  } else if (destination) {
    destination.content = appendToFirstRegularListBlock(destination.content, insertedListText);
  }
  return 'proposed';
}

export const quickCaptureToListPlugin: BuiltinPlugin = {
  id: 'quick-capture-to-list',
  name: 'Quick capture to list',
  description: 'Append Untitled quick captures into the best matching list note.',
  defaultEnabled: false,
  defaultSchedule: {
    kind: 'daily',
    time: '03:00',
    day: null,
  },
  defaultAutoApply: false,
  configSchema: [],

  async run(context: PluginRunContext) {
    const candidates = await listListNoteCandidates(context);
    const fallbackContentRef = {
      value: candidates.find((candidate) => candidate.note.title === FALLBACK_LIST_TITLE)?.content ?? null,
    };
    const untitledNotes = (await context.sdk.findNotes({
      filenameGlob: 'Untitled*.md',
      sort: 'modified_asc',
    })).filter((note) => UNTITLED_RE.test(note.filename));

    let proposalsCreated = 0;
    let notesSkipped = 0;
    for (const note of untitledNotes) {
      if (context.signal.aborted) break;
      const result = await processUntitledNote(note, context, candidates, fallbackContentRef);
      if (result === 'proposed') {
        proposalsCreated += 1;
      } else {
        notesSkipped += 1;
      }
    }

    return {
      notesScanned: untitledNotes.length,
      proposalsCreated,
      notesSkipped,
    };
  },
};
