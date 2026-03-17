import type { BuiltinPlugin, PluginNoteMeta, PluginRunContext } from '../types.js';
import { getBoolean, getNumber, getString, parseLenientJson } from '../configHelpers.js';
import { findHeadingSection } from '../managedBlocks.js';

const DEFAULT_WEEKLY_REGEX = '^(This week \\(|[Ww]eek of ).*\\.md$';
const DEFAULT_HEADING = '## Related Notes';
const DEFAULT_BLOCK_ID = 'weekly-related-notes';
const PHRASE_BOOSTS = [
  'semantic search',
  'graph view',
  'overnight',
  'demo',
  'assistant',
  'smart transforms',
  'plugin',
  'markdown',
];
const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'what', 'when', 'your', 'into', 'they', 'them', 'then',
  'there', 'their', 'would', 'could', 'should', 'about', 'after', 'before', 'while', 'through', 'because', 'just',
  'still', 'also', 'really', 'maybe', 'notes', 'note', 'week', 'file', 'files', 'been',
  'more', 'than', 'some', 'over', 'under', 'like', 'want', 'cool', 'good', 'better', 'make', 'made', 'does', 'did',
  'done', 'were', 'will', 'much', 'very', 'need', 'using', 'used', 'being', 'only', 'same', 'look',
  'back', 'here', 'idea', 'ideas', 'going', 'think', 'thats', 'it', 'its',
]);

interface WeeklyRelatedNotesState {
  sourceHash: string;
  renderedBlock: string | null;
  lastResult: 'proposed' | 'skipped:no_candidates' | 'skipped:unchanged';
  lastRunAt: number;
}

interface Candidate {
  note: PluginNoteMeta;
  content: string;
  excerpt: string;
  score: number;
}

interface RankedLink {
  note: PluginNoteMeta;
  reason: string;
}

function resolveAnchorTimestamp(note: PluginNoteMeta): number {
  // Range format: (M-D-YYYY to M-D) or (M-D-YYYY to M-D-YYYY) — use the END date
  const rangeMatch = note.title.match(/\((\d{1,2})-(\d{1,2})-(\d{4})\s+to\s+(\d{1,2})-(\d{1,2})(?:-(\d{4}))?\)/);
  if (rangeMatch) {
    const [, , , startYear, endMonth, endDay, endYear] = rangeMatch;
    const year = endYear ? Number(endYear) : Number(startYear);
    return Date.UTC(year, Number(endMonth) - 1, Number(endDay), 23, 59, 59, 999);
  }

  // Single date: (M-D-YYYY)
  const singleMatch = note.title.match(/\((\d{1,2})-(\d{1,2})-(\d{4})\b/);
  if (singleMatch) {
    const [, monthRaw, dayRaw, yearRaw] = singleMatch;
    return Date.UTC(Number(yearRaw), Number(monthRaw) - 1, Number(dayRaw), 12, 0, 0, 0);
  }

  const isoMatch = note.title.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    const parsed = Date.parse(`${isoMatch[1]}T12:00:00Z`);
    if (!Number.isNaN(parsed)) return parsed;
  }

  const createdAt = Date.parse(note.createdAt);
  return Number.isNaN(createdAt) ? note.modifiedAt : createdAt;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9-]*/g)
    ?.filter((token) => token.length > 2 && !STOPWORDS.has(token))
    ?? [];
}

function extractExcerpt(text: string, maxChars: number): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function scoreCandidate(targetText: string, candidate: Candidate, anchorModifiedAt: number): number {
  const targetTokens = new Set(tokenize(targetText));
  const candidateTokens = tokenize(`${candidate.note.title}\n${candidate.content}`);
  const uniqueCandidateTokens = new Set(candidateTokens);
  let overlap = 0;
  for (const token of uniqueCandidateTokens) {
    if (targetTokens.has(token)) overlap += 1;
  }

  const targetLower = targetText.toLowerCase();
  const candidateLower = `${candidate.note.title}\n${candidate.content}`.toLowerCase();
  const phraseBoost = PHRASE_BOOSTS.reduce((sum, phrase) => (
    targetLower.includes(phrase) && candidateLower.includes(phrase) ? sum + 3 : sum
  ), 0);
  const recencyBoost = Math.max(0, 14 - ((anchorModifiedAt - candidate.note.modifiedAt) / 86_400_000)) * 0.15;
  return overlap + phraseBoost + recencyBoost;
}

function buildFallbackReason(targetText: string, candidate: Candidate): string {
  const targetTokens = new Set(tokenize(targetText));
  const shared = Array.from(new Set(tokenize(`${candidate.note.title}\n${candidate.content}`)))
    .filter((token) => targetTokens.has(token))
    .slice(0, 3);

  if (shared.length > 0) {
    return `Overlaps on ${shared.join(', ')}.`;
  }

  return 'Related product planning from the same recent window.';
}

function sanitizeReason(reason: string): string {
  const cleaned = reason.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return 'Related product planning from the same recent window.';
  const normalized = cleaned.endsWith('.') ? cleaned : `${cleaned}.`;
  return normalized.length > 120 ? `${normalized.slice(0, 117).trimEnd()}...` : normalized;
}

function parseSelection(
  raw: string,
  candidates: Candidate[],
  maxLinks: number,
  targetText: string,
): RankedLink[] {
  const byId = new Map(candidates.map((candidate, index) => [`c${index + 1}`, candidate]));
  const parsed = parseLenientJson(raw) as { links?: Array<{ candidateId?: string; reason?: string }> } | null;
  const chosen: RankedLink[] = [];
  const seen = new Set<string>();

  for (const item of parsed?.links ?? []) {
    if (typeof item?.candidateId !== 'string' || seen.has(item.candidateId)) continue;
    const candidate = byId.get(item.candidateId);
    if (!candidate) continue;
    seen.add(item.candidateId);
    chosen.push({
      note: candidate.note,
      reason: sanitizeReason(typeof item.reason === 'string' ? item.reason : buildFallbackReason(targetText, candidate)),
    });
    if (chosen.length >= maxLinks) break;
  }

  if (chosen.length > 0) {
    return chosen;
  }

  return candidates.slice(0, maxLinks).map((candidate) => ({
    note: candidate.note,
    reason: buildFallbackReason(targetText, candidate),
  }));
}

async function rankCandidates(
  context: PluginRunContext,
  weeklyNote: PluginNoteMeta,
  weeklyContent: string,
  candidates: Candidate[],
  maxLinks: number,
  includeReasons: boolean,
): Promise<RankedLink[]> {
  if (candidates.length === 0) return [];
  if (!includeReasons) {
    return candidates.slice(0, maxLinks).map((candidate) => ({ note: candidate.note, reason: '' }));
  }

  const userPrompt = [
    `WEEKLY NOTE "${weeklyNote.title}":`,
    weeklyContent.trim().slice(0, 1200),
    '',
    `Pick exactly ${maxLinks} candidates most relevant to this weekly note.`,
    '',
    'For each reason, briefly describe what the candidate note contains. Be specific. Under 80 chars.',
    'Start each reason with a topic or action word like these examples:',
    '"Architecture plan for overnight skill files and editable prompts"',
    '"To-dos for the week: name the feature, prep demo environment"',
    '"Brainstorm on semantic search as the flagship demo moment"',
    '"Ideas for LLM-powered overnight note processing pipeline"',
    '',
    'Return JSON: {"links":[{"candidateId":"c1","reason":"..."}]}',
    '',
    'CANDIDATES:',
    ...candidates.map((candidate, index) => (
      `[c${index + 1}] ${candidate.note.title}\n${candidate.excerpt}`
    )),
  ].join('\n');

  const raw = await context.sdk.runBuiltinLlm({
    purpose: 'weekly-related-notes-selection',
    systemPrompt: 'You pick relevant past notes and briefly summarize what each one contains. Be specific and concise.',
    userPrompt,
    maxTokens: 500,
    temperature: 0.1,
    timeoutMs: 30_000,
    disableThinking: true,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        links: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              candidateId: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['candidateId', 'reason'],
          },
        },
      },
      required: ['links'],
    },
  });

  return parseSelection(raw, candidates, maxLinks, `${weeklyNote.title}\n${weeklyContent}`);
}

function buildManagedContent(headingText: string, links: RankedLink[], includeReasons: boolean): string {
  return [
    headingText.trim(),
    ...links.map((link) => includeReasons
      ? `- [[${link.note.title}]] - ${link.reason}`
      : `- [[${link.note.title}]]`),
  ].join('\n');
}

async function processWeeklyNote(
  context: PluginRunContext,
  weeklyNote: PluginNoteMeta,
): Promise<'proposed' | 'skipped'> {
  const lookbackDays = Math.max(1, getNumber(context.config, 'lookbackDays', 30));
  const maxLinks = Math.max(1, getNumber(context.config, 'maxLinks', 2));
  const includeReasons = getBoolean(context.config, 'includeReasons', true);
  const maxCandidateNotes = Math.max(maxLinks, getNumber(context.config, 'maxCandidateNotes', 40));
  const headingText = getString(context.config, 'headingText', DEFAULT_HEADING);
  const stateKey = `note:${weeklyNote.uuid}`;
  const anchorTimestamp = resolveAnchorTimestamp(weeklyNote);

  const weeklyContent = await context.sdk.readNoteContent(weeklyNote.uuid);
  if (!weeklyContent) {
    await context.sdk.setPluginState(stateKey, {
      sourceHash: weeklyNote.contentHash,
      renderedBlock: null,
      lastResult: 'skipped:no_candidates',
      lastRunAt: Date.now(),
    } satisfies WeeklyRelatedNotesState);
    return 'skipped';
  }

  const candidatesRaw = await context.sdk.findNotes({
    modifiedAfter: anchorTimestamp - (lookbackDays * 86_400_000),
    modifiedBefore: anchorTimestamp,
    sort: 'modified_desc',
  });

  const candidates: Candidate[] = [];
  const targetText = `${weeklyNote.title}\n${weeklyContent}`;
  for (const note of candidatesRaw) {
    if (note.uuid === weeklyNote.uuid) continue;
    const content = await context.sdk.readNoteContent(note.uuid);
    if (!content || content.trim().length === 0) continue;
    const candidate: Candidate = {
      note,
      content,
      excerpt: extractExcerpt(content, 260),
      score: 0,
    };
    candidate.score = scoreCandidate(targetText, candidate, anchorTimestamp);
    candidates.push(candidate);
  }

  const topCandidates = candidates
    .sort((a, b) => b.score - a.score || b.note.modifiedAt - a.note.modifiedAt || a.note.title.localeCompare(b.note.title))
    .slice(0, maxCandidateNotes);

  if (topCandidates.length === 0) {
    await context.sdk.setPluginState(stateKey, {
      sourceHash: weeklyNote.contentHash,
      renderedBlock: null,
      lastResult: 'skipped:no_candidates',
      lastRunAt: Date.now(),
    } satisfies WeeklyRelatedNotesState);
    return 'skipped';
  }

  const links = await rankCandidates(context, weeklyNote, weeklyContent, topCandidates, maxLinks, includeReasons);
  if (links.length === 0) {
    await context.sdk.setPluginState(stateKey, {
      sourceHash: weeklyNote.contentHash,
      renderedBlock: null,
      lastResult: 'skipped:no_candidates',
      lastRunAt: Date.now(),
    } satisfies WeeklyRelatedNotesState);
    return 'skipped';
  }

  const content = buildManagedContent(headingText, links, includeReasons);
  const renderedBlock = content;
  const existingBlock = findHeadingSection(weeklyContent, headingText);
  const previous = await context.sdk.getPluginState<WeeklyRelatedNotesState>(stateKey);
  if (existingBlock === renderedBlock || (previous?.sourceHash === weeklyNote.contentHash && previous.renderedBlock === renderedBlock)) {
    await context.sdk.setPluginState(stateKey, {
      sourceHash: weeklyNote.contentHash,
      renderedBlock,
      lastResult: 'skipped:unchanged',
      lastRunAt: Date.now(),
    } satisfies WeeklyRelatedNotesState);
    return 'skipped';
  }

  await context.sdk.proposeChange({
    entityType: 'note',
    entityId: weeklyNote.uuid,
    changeType: 'replace_managed_block',
    before: {
      title: weeklyNote.title,
      filename: weeklyNote.filename,
      blockId: DEFAULT_BLOCK_ID,
    },
    after: {
      blockId: DEFAULT_BLOCK_ID,
      content,
      replaceStrategy: 'heading_section',
      headingText,
    },
    preview: {
      title: weeklyNote.title,
      anchorModifiedAt: anchorTimestamp,
      candidateCount: topCandidates.length,
      selectedTitles: links.map((link) => link.note.title),
      renderedBlock,
    },
    reason: `Surface related notes from the prior ${lookbackDays} days`,
  });

  await context.sdk.log('info', 'Proposed weekly related notes block', {
    weeklyNoteUuid: weeklyNote.uuid,
    selectedTitles: links.map((link) => link.note.title),
  });
  await context.sdk.setPluginState(stateKey, {
    sourceHash: weeklyNote.contentHash,
    renderedBlock,
    lastResult: 'proposed',
    lastRunAt: Date.now(),
  } satisfies WeeklyRelatedNotesState);
  return 'proposed';
}

export const weeklyRelatedNotesPlugin: BuiltinPlugin = {
  id: 'weekly-related-notes',
  name: 'Weekly related notes',
  description: 'Surface prior notes from the last two weeks into a weekly note block.',
  defaultEnabled: true,
  defaultSchedule: {
    kind: 'weekly',
    time: '03:00',
    day: 1,
  },
  defaultAutoApply: true,
  configSchema: [
    { key: 'lookbackDays', label: 'Lookback days', type: 'number', default: 30, min: 1, max: 90 },
    { key: 'maxLinks', label: 'Max links', type: 'number', default: 2, min: 1, max: 12 },
    { key: 'maxCandidateNotes', label: 'Max candidates', type: 'number', default: 40, min: 4, max: 80 },
    { key: 'targetFilenameRegex', label: 'Weekly filename regex', type: 'string', default: DEFAULT_WEEKLY_REGEX },
    { key: 'headingText', label: 'Heading text', type: 'string', default: DEFAULT_HEADING },
    { key: 'includeReasons', label: 'Include reasons', type: 'boolean', default: true },
  ],

  async run(context) {
    const targetFilenameRegex = getString(context.config, 'targetFilenameRegex', DEFAULT_WEEKLY_REGEX);
    const weeklyNotes = await context.sdk.findNotes({
      filenameRegex: targetFilenameRegex,
      sort: 'modified_desc',
    });

    let proposalsCreated = 0;
    let notesSkipped = 0;
    for (const weeklyNote of weeklyNotes) {
      if (context.signal.aborted) break;
      const result = await processWeeklyNote(context, weeklyNote);
      if (result === 'proposed') {
        proposalsCreated += 1;
      } else {
        notesSkipped += 1;
      }
    }

    return {
      notesScanned: weeklyNotes.length,
      proposalsCreated,
      notesSkipped,
    };
  },
};
