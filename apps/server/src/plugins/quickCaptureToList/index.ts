import type { BuiltinPlugin, PluginNoteMeta, PluginRunContext } from '../types.js';
import { UNTITLED_FILENAME_RE } from '../configHelpers.js';
import {
  appendToFirstRegularListBlock,
  buildInsertedListText,
  findFirstRegularListBlock,
  qualifiesAsListNote,
} from '../listNotes.js';

const FALLBACK_LIST_TITLE = 'Inbox';

interface ListNoteCandidate {
  note: PluginNoteMeta;
  content: string;
}

interface RankedCandidate {
  candidate: ListNoteCandidate;
  score: number;
  directMatch: boolean;
}

interface ListNoteSelectionData {
  candidates: ListNoteCandidate[];
  fallbackContent: string | null;
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'from',
  'i',
  'idea',
  'ideas',
  'into',
  'it',
  'my',
  'new',
  'of',
  'on',
  'the',
  'this',
  'that',
  'to',
  'with',
]);

const TOKEN_ALIASES: Record<string, string> = {
  dad: 'father',
  moms: 'mother',
  mom: 'mother',
  pcs: 'computer',
  pc: 'computer',
};

const RECIPIENT_TOKENS = new Set([
  'boyfriend',
  'brother',
  'daughter',
  'family',
  'father',
  'friend',
  'girlfriend',
  'grandfather',
  'grandma',
  'grandmother',
  'grandpa',
  'grandparent',
  'grandson',
  'granddaughter',
  'husband',
  'mother',
  'parent',
  'partner',
  'sister',
  'son',
  'wife',
]);

const GIFT_TOKENS = new Set([
  'birthday',
  'christmas',
  'gift',
  'holiday',
  'idea',
  'present',
  'wishlist',
  'wish',
]);

const SHOPPING_TOKENS = new Set([
  'book',
  'books',
  'buy',
  'computer',
  'find',
  'get',
  'gift',
  'need',
  'order',
  'pick',
  'present',
  'shop',
  'shopping',
  'want',
]);

function normalizeToken(token: string): string {
  const cleaned = token.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!cleaned) return '';
  const aliased = TOKEN_ALIASES[cleaned] ?? cleaned;
  if (aliased.endsWith('ies') && aliased.length > 4) {
    return `${aliased.slice(0, -3)}y`;
  }
  if (aliased.endsWith('s') && aliased.length > 4 && !aliased.endsWith('ss')) {
    return aliased.slice(0, -1);
  }
  return aliased;
}

function tokenize(text: string): string[] {
  const parts = text.split(/[^a-zA-Z0-9]+/g);
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const normalized = normalizeToken(part);
    if (!normalized || normalized.length < 2 || STOP_WORDS.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    tokens.push(normalized);
  }
  return tokens;
}

function countTokenOverlap(source: string[], target: Set<string>): number {
  let overlap = 0;
  for (const token of source) {
    if (target.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}

function looksLikeGiftCapture(tokens: string[]): boolean {
  const hasGiftWord = tokens.some((token) => GIFT_TOKENS.has(token));
  const hasRecipient = tokens.some((token) => RECIPIENT_TOKENS.has(token));
  const hasShoppingIntent = tokens.some((token) => SHOPPING_TOKENS.has(token));
  return hasGiftWord || (hasRecipient && hasShoppingIntent);
}

function isGiftCandidate(candidate: ListNoteCandidate): boolean {
  const titleTokens = tokenize(candidate.note.title);
  if (titleTokens.some((token) => GIFT_TOKENS.has(token))) {
    return true;
  }

  const previewTokens = tokenize(summarizeCandidateContent(candidate.content, 10).join(' '));
  const recipientCount = previewTokens.filter((token) => RECIPIENT_TOKENS.has(token)).length;
  return recipientCount >= 2;
}

function rankCandidatesForSelection(
  quickCaptureText: string,
  candidates: ListNoteCandidate[],
): RankedCandidate[] {
  const captureTokens = tokenize(quickCaptureText);
  const giftCapture = looksLikeGiftCapture(captureTokens);

  return candidates
    .map((candidate) => {
      const titleTokens = new Set(tokenize(candidate.note.title));
      const previewTokens = new Set(tokenize(summarizeCandidateContent(candidate.content, 10).join(' ')));
      const titleOverlap = countTokenOverlap(captureTokens, titleTokens);
      const previewOverlap = countTokenOverlap(captureTokens, previewTokens);
      const giftCandidate = isGiftCandidate(candidate);
      const directMatch = titleOverlap > 0 || previewOverlap > 0;

      let score = (titleOverlap * 5) + (previewOverlap * 2);
      if (giftCapture && giftCandidate) {
        score += 8;
      }
      if (giftCapture && giftCandidate && previewOverlap === 0) {
        score += 2;
      }

      return {
        candidate,
        score,
        directMatch,
      };
    })
    .sort((left, right) => right.score - left.score || Number(right.directMatch) - Number(left.directMatch));
}

function summarizeCandidateContent(content: string, maxLines = 5): string[] {
  const listBlock = findFirstRegularListBlock(content);
  const lines = content.split('\n');
  const previewLines = listBlock
    ? lines.slice(listBlock.startLine, listBlock.endLine + 1)
    : lines;

  return previewLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxLines)
    .map((line) => line.replace(/\s+/g, ' ').slice(0, 140));
}

function formatCandidateForPrompt(candidate: ListNoteCandidate): string {
  const preview = summarizeCandidateContent(candidate.content);
  const previewText = preview.length > 0
    ? preview.map((line) => `   ${line}`).join('\n')
    : '   (empty)';

  return [
    `- ${candidate.note.title}`,
    '  Preview:',
    previewText,
  ].join('\n');
}

function buildSelectionSystemPrompt(): string {
  return [
    'You route quick captures into existing list notes.',
    'Prefer a plausible existing list over Inbox whenever one fits at all.',
    'Inbox is a fallback bucket only when no listed note makes sense.',
    'Recipient-plus-item captures usually belong in gift, wishlist, or ideas lists if one exists.',
    'Think carefully about the candidate contents before answering.',
    'Reply with exactly one candidate title or null.',
  ].join('\n');
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

async function listListNoteCandidates(context: PluginRunContext): Promise<ListNoteSelectionData> {
  const notes = await context.sdk.findNotes({
    excludeFilenameRegex: '^Untitled(?: \\(\\d+\\))?\\.md$',
    sort: 'modified_desc',
  });

  const candidates: ListNoteCandidate[] = [];
  let fallbackContent: string | null = null;
  for (const note of notes) {
    const content = await context.sdk.readNoteContent(note.uuid);
    if (note.title === FALLBACK_LIST_TITLE && content) {
      fallbackContent = content;
    }
    if (note.title === FALLBACK_LIST_TITLE) {
      continue;
    }
    if (!content || !qualifiesAsListNote(content) || !findFirstRegularListBlock(content)) {
      continue;
    }
    candidates.push({ note, content });
  }

  return { candidates, fallbackContent };
}

async function chooseDestinationTitle(
  context: PluginRunContext,
  quickCaptureText: string,
  candidates: ListNoteCandidate[],
): Promise<string | null> {
  if (candidates.length === 0) {
    return null;
  }

  const rankedCandidates = rankCandidatesForSelection(quickCaptureText, candidates);
  const bestCandidate = rankedCandidates[0] ?? null;
  const secondBestScore = rankedCandidates[1]?.score ?? 0;
  if (bestCandidate && bestCandidate.score >= 9 && bestCandidate.score - secondBestScore >= 3) {
    return bestCandidate.candidate.note.title;
  }

  const llmCandidates = rankedCandidates.slice(0, 6).map((entry) => entry.candidate);
  const raw = await context.sdk.runBuiltinLlm({
    purpose: 'quick-capture-to-list-selection',
    systemPrompt: buildSelectionSystemPrompt(),
    userPrompt: [
      'Choose the best existing destination list for this quick capture.',
      'The candidates are ordered from strongest to weakest existing match.',
      'Return null only if none of these existing lists are a plausible fit.',
      '',
      'Quick capture:',
      quickCaptureText.trim(),
      '',
      'Existing list candidates:',
      ...llmCandidates.map((candidate) => formatCandidateForPrompt(candidate)),
    ].join('\n'),
    maxTokens: 96,
    temperature: 0,
    timeoutMs: 30_000,
  });

  const selectedTitle = normalizeLlmResponse(raw);
  if (!selectedTitle) {
    if (bestCandidate && bestCandidate.score >= 8 && bestCandidate.score - secondBestScore >= 2) {
      return bestCandidate.candidate.note.title;
    }
    return null;
  }

  return llmCandidates.find((candidate) => candidate.note.title === selectedTitle)?.note.title
    ?? (bestCandidate && bestCandidate.score >= 8 && bestCandidate.score - secondBestScore >= 2
      ? bestCandidate.candidate.note.title
      : null);
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
      destinationTitle,
      sourceDeletePlanned: true,
    },
    after: {
      destinationNoteUuid,
      destinationTitle,
      insertedListText,
      fallbackUsed,
      sourceDeletePlanned: true,
    },
    preview: {
      sourceTitle: note.title,
      destinationTitle,
      destinationMode: fallbackUsed ? 'created' : 'existing',
      insertedListText,
      fallbackUsed,
      sourceDeletePlanned: true,
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
  description: 'Move Untitled quick captures into the best matching list note, or Inbox when nothing fits.',
  defaultEnabled: true,
  defaultSchedule: {
    kind: 'daily',
    time: '03:00',
    day: null,
  },
  defaultAutoApply: true,
  configSchema: [],

  async run(context: PluginRunContext) {
    const selectionData = await listListNoteCandidates(context);
    const candidates = selectionData.candidates;
    const fallbackContentRef = {
      value: selectionData.fallbackContent,
    };
    const untitledNotes = (await context.sdk.findNotes({
      filenameGlob: 'Untitled*.md',
      sort: 'modified_asc',
    })).filter((note) => UNTITLED_FILENAME_RE.test(note.filename));

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
