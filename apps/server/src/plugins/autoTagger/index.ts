import { extractTags, extractHeaderTagBlock } from '@futo-notes/shared';
import type { BuiltinPlugin, PluginRunContext, PluginNoteMeta, PluginTagDefinition } from '../types.js';

interface AutoTaggerState {
  contentHash: string;
  lastResult: string;
  lastRunAt: number;
}

interface LlmTagResult {
  tags: Array<{ tag: string; confidence: number }>;
}

interface TagExample {
  title: string;
  snippet: string;
}

const DEFAULT_LLM_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_NOTES_TO_SCAN = 5;
const MAX_CONSECUTIVE_LLM_FAILURES = 3;
const DEFAULT_MAX_EXAMPLES_PER_TAG = 3;
const MIN_SNIPPET_LENGTH = 20;
const MAX_SNIPPET_CHARS = 200;

function getNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isTagDefinitionList(value: unknown): value is PluginTagDefinition[] {
  return Array.isArray(value) && value.every((item) => (
    typeof item === 'object'
    && item !== null
    && typeof (item as { name?: unknown }).name === 'string'
    && typeof (item as { description?: unknown }).description === 'string'
  ));
}

function parseLegacyTagDefinitions(raw: string): PluginTagDefinition[] {
  if (!raw.trim()) return [];
  return raw.split(',').map((entry) => {
    const trimmed = entry.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      return {
        name: trimmed.slice(0, colonIdx).trim(),
        description: trimmed.slice(colonIdx + 1).trim(),
      };
    }
    return { name: trimmed, description: '' };
  }).filter((tag) => tag.name.length > 0);
}

function parseTagDefinitions(raw: unknown): PluginTagDefinition[] {
  if (isTagDefinitionList(raw)) {
    return raw
      .map((tag) => ({
        name: tag.name.trim(),
        description: tag.description.trim(),
      }))
      .filter((tag) => tag.name.length > 0);
  }
  if (typeof raw === 'string') {
    return parseLegacyTagDefinitions(raw);
  }
  return [];
}

function extractSnippet(content: string): string {
  const { endOffset } = extractHeaderTagBlock(content);
  const stripped = content.slice(endOffset).trim();
  if (stripped.length <= MAX_SNIPPET_CHARS) return stripped;
  const truncated = stripped.slice(0, MAX_SNIPPET_CHARS);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > MAX_SNIPPET_CHARS * 0.5 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

function collectExamples(
  taggedNotes: Array<{ note: PluginNoteMeta; tags: string[]; content: string }>,
  tagDefinitions: PluginTagDefinition[],
  maxPerTag: number,
): Map<string, TagExample[]> {
  const configuredTagNames = new Set(tagDefinitions.map((t) => t.name.toLowerCase()));
  const examples = new Map<string, TagExample[]>();

  for (const def of tagDefinitions) {
    examples.set(def.name.toLowerCase(), []);
  }

  for (const { note, tags, content } of taggedNotes) {
    const snippet = extractSnippet(content);
    if (snippet.length < MIN_SNIPPET_LENGTH) continue;

    for (const tag of tags) {
      const tagName = tag.replace(/^#/, '').toLowerCase();
      if (!configuredTagNames.has(tagName)) continue;
      const pool = examples.get(tagName)!;
      if (pool.length >= maxPerTag) continue;
      pool.push({ title: note.title, snippet });
    }
  }

  return examples;
}

function buildExampleBlock(
  tagDefinitions: PluginTagDefinition[],
  examples: Map<string, TagExample[]>,
): string {
  const lines: string[] = [];

  for (const def of tagDefinitions) {
    const pool = examples.get(def.name.toLowerCase()) || [];
    lines.push(`Examples of #${def.name}:`);
    if (pool.length > 0) {
      for (const ex of pool) {
        lines.push(`- "${ex.title}": ${ex.snippet}`);
      }
    } else {
      const desc = def.description.length > 0
        ? def.description
        : `Notes that should be tagged ${def.name}.`;
      lines.push(`(no examples yet — ${desc})`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function buildContentBudgets(maxContentChars: number): number[] {
  const normalized = Math.max(100, Math.floor(maxContentChars));
  const budgets = [normalized];
  for (const candidate of [2000, 1000, 500]) {
    if (candidate < normalized) budgets.push(candidate);
  }
  return Array.from(new Set(budgets));
}

function parseLlmTagResult(raw: string, tagDefinitions: PluginTagDefinition[]): LlmTagResult | null {
  const parseTagNamesFromArraySnippet = (text: string): string[] => {
    const match = text.match(/"tags"\s*:\s*\[([^\]]*)\]/s);
    if (!match) return [];
    return Array.from(match[1].matchAll(/"([^"]+)"/g)).map((entry) => entry[1]);
  };

  const parseJson = (text: string): unknown => {
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
  };

  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object') return null;

  const validTagNames = new Set(tagDefinitions.map((definition) => definition.name.toLowerCase()));
  if (Array.isArray((parsed as { tags?: unknown }).tags)) {
    return {
      tags: ((parsed as { tags: unknown[] }).tags).flatMap((entry) => {
        if (typeof entry === 'string' && validTagNames.has(entry.toLowerCase())) {
          return [{ tag: entry, confidence: 1 }];
        }
        if (!entry || typeof entry !== 'object') return [];
        const candidate = entry as { tag?: unknown; confidence?: unknown };
        if (typeof candidate.tag !== 'string' || typeof candidate.confidence !== 'number') return [];
        return [{ tag: candidate.tag, confidence: candidate.confidence }];
      }),
    };
  }

  const booleanMapTags = Object.entries(parsed as Record<string, unknown>).flatMap(([tag, value]) => {
    if (!validTagNames.has(tag.toLowerCase()) || value !== true) return [];
    return [{ tag, confidence: 1 }];
  });
  if (booleanMapTags.length > 0) {
    return { tags: booleanMapTags };
  }

  const fallbackTags = parseTagNamesFromArraySnippet(raw)
    .filter((tag) => validTagNames.has(tag.toLowerCase()))
    .map((tag) => ({ tag, confidence: 1 }));
  if (fallbackTags.length > 0) {
    return { tags: fallbackTags };
  }

  return {
    tags: [],
  };
}

function isFatalLlmError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return /built-in llm is unavailable|download|loading|load model|failed to load|memory|alloc|gpu|node-llama-cpp/.test(message);
}

function buildSystemPrompt(): string {
  return 'Classify the note into exactly one tag based on the examples. Return JSON: {"tags":["tagname"]}';
}

function buildUserPrompt(exampleBlock: string, tagNames: string, noteTitle: string, content: string): string {
  return [
    `Tags: ${tagNames}`,
    '',
    exampleBlock,
    '',
    'Note title:',
    noteTitle,
    content,
  ].join('\n');
}

async function classifyNote(
  context: PluginRunContext,
  noteTitle: string,
  tagDefinitions: PluginTagDefinition[],
  exampleBlock: string,
  tagNames: string,
  content: string,
  maxContentChars: number,
): Promise<string> {
  let lastError: unknown = null;
  for (const budget of buildContentBudgets(maxContentChars)) {
    try {
      return await context.sdk.runBuiltinLlm({
        purpose: 'auto-tagger-classify',
        systemPrompt: buildSystemPrompt(),
        userPrompt: buildUserPrompt(exampleBlock, tagNames, noteTitle, content.slice(0, budget)),
        temperature: 0.1,
        maxTokens: 64,
        timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
        disableThinking: true,
        jsonSchema: {
          type: 'object',
          properties: {
            tags: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['tags'],
        },
      });
    } catch (err) {
      lastError = err;
      if (isFatalLlmError(err)) {
        throw err;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'LLM classification failed'));
}

export const autoTaggerPlugin: BuiltinPlugin = {
  id: 'auto-tagger',
  name: 'Auto Tagger',
  description: 'Automatically tag untagged notes using AI.',
  defaultEnabled: true,
  defaultSchedule: {
    kind: 'daily',
    time: '03:00',
    day: null,
  },
  defaultAutoApply: true,
  configSchema: [
    {
      key: 'tags',
      label: 'Tags',
      type: 'tag_list',
      default: [],
      description: 'Define each tag and describe what kinds of notes should receive it.',
    },
    {
      key: 'confidenceThreshold',
      label: 'Confidence threshold',
      type: 'number',
      default: 0.7,
      description: 'Minimum confidence (0-1) to propose a tag',
      min: 0,
      max: 1,
    },
    {
      key: 'maxContentChars',
      label: 'Max content chars',
      type: 'number',
      default: 3000,
      description: 'Maximum characters of note content to send to LLM',
      min: 100,
      max: 10000,
    },
    {
      key: 'staleMinutes',
      label: 'Stale minutes',
      type: 'number',
      default: 5,
      description: 'Skip notes modified within this many minutes',
      min: 1,
    },
    {
      key: 'maxNotesToScan',
      label: 'Recent notes to scan',
      type: 'number',
      default: DEFAULT_MAX_NOTES_TO_SCAN,
      description: 'Only scan this many most recently modified notes for auto-tagging',
      min: 1,
      max: 1000,
    },
  ],

  async run(context: PluginRunContext) {
    let tagDefinitions = parseTagDefinitions(context.config.tags);

    const confidenceThreshold = getNumber(context.config, 'confidenceThreshold', 0.7);
    const maxContentChars = getNumber(context.config, 'maxContentChars', 3000);
    const staleMinutes = getNumber(context.config, 'staleMinutes', 5);
    const maxNotesToScan = Math.max(1, Math.floor(getNumber(context.config, 'maxNotesToScan', DEFAULT_MAX_NOTES_TO_SCAN)));

    // Phase 1: Scan & Partition
    const scanPool = Math.max(maxNotesToScan * 5, 100);
    const allNotes = await context.sdk.findNotes({ sort: 'modified_desc', limit: scanPool });

    // First pass: read content and extract tags; discover vault tags if none configured
    const discovering = tagDefinitions.length === 0;
    const discoveredTagCounts = discovering ? new Map<string, number>() : null;
    const noteData: Array<{ note: PluginNoteMeta; content: string; existingTags: string[] }> = [];

    for (const note of allNotes) {
      if (/^Untitled(?: \(\d+\))?$/.test(note.title)) continue;

      const content = await context.sdk.readNoteContent(note.uuid);
      if (!content || content.trim().length < 20) continue;

      const existingTags = extractTags(content);
      noteData.push({ note, content, existingTags });

      if (discoveredTagCounts) {
        for (const tag of existingTags) {
          const name = tag.replace(/^#/, '').toLowerCase();
          discoveredTagCounts.set(name, (discoveredTagCounts.get(name) ?? 0) + 1);
        }
      }
    }

    if (discovering && discoveredTagCounts) {
      tagDefinitions = Array.from(discoveredTagCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => ({ name, description: '' }));
      if (tagDefinitions.length > 0) {
        await context.sdk.log('info', `Auto-discovered ${tagDefinitions.length} tags from vault: ${tagDefinitions.map((t) => t.name).join(', ')}`);
      }
    }

    if (tagDefinitions.length === 0) {
      await context.sdk.log('info', 'No tags configured or found in vault — skipping auto-tagger run');
      return { notesScanned: 0, proposalsCreated: 0, notesSkipped: 0 };
    }

    const configuredTagNames = new Set(tagDefinitions.map((t) => t.name.toLowerCase()));
    const taggedExampleNotes: Array<{ note: PluginNoteMeta; tags: string[]; content: string }> = [];
    const classificationTargets: Array<{ note: PluginNoteMeta; content: string }> = [];

    for (const { note, content, existingTags } of noteData) {
      if (existingTags.length > 0) {
        const matchingTags = existingTags.filter((t) => configuredTagNames.has(t.replace(/^#/, '').toLowerCase()));
        if (matchingTags.length > 0) {
          taggedExampleNotes.push({ note, tags: matchingTags, content });
        }
      } else if (classificationTargets.length < maxNotesToScan) {
        classificationTargets.push({ note, content });
      }
    }

    // Phase 2: Build Examples
    const maxPerTag = tagDefinitions.length > 8 ? 1 : tagDefinitions.length > 5 ? 2 : DEFAULT_MAX_EXAMPLES_PER_TAG;
    const examples = collectExamples(taggedExampleNotes, tagDefinitions, maxPerTag);
    const exampleBlock = buildExampleBlock(tagDefinitions, examples);
    const tagNames = tagDefinitions.map((t) => t.name).join(', ');

    // Phase 3: Classify
    let proposalsCreated = 0;
    let notesSkipped = 0;
    let consecutiveLlmFailures = 0;

    for (const { note, content } of classificationTargets) {
      if (context.signal.aborted) break;

      const stateKey = `note:${note.uuid}`;

      if (context.triggerType !== 'manual') {
        const cutoff = Date.now() - staleMinutes * 60_000;
        if (note.modifiedAt >= cutoff) {
          notesSkipped++;
          continue;
        }
      }

      if (context.triggerType !== 'manual') {
        const previous = await context.sdk.getPluginState<AutoTaggerState>(stateKey);
        if (previous?.contentHash === note.contentHash) {
          notesSkipped++;
          continue;
        }
      }

      let rawResponse: string;
      try {
        rawResponse = await classifyNote(context, note.title, tagDefinitions, exampleBlock, tagNames, content, maxContentChars);
        consecutiveLlmFailures = 0;
      } catch (err) {
        await context.sdk.log('warn', `LLM call failed for note ${note.uuid}`, { error: String(err) });
        await context.sdk.setPluginState(stateKey, {
          contentHash: note.contentHash,
          lastResult: 'error: llm_failed',
          lastRunAt: Date.now(),
        } satisfies AutoTaggerState);
        notesSkipped++;
        consecutiveLlmFailures += 1;
        if (isFatalLlmError(err) || consecutiveLlmFailures >= MAX_CONSECUTIVE_LLM_FAILURES) {
          throw new Error(`Auto Tagger stopped after repeated LLM failures: ${String(err)}`);
        }
        continue;
      }

      const result = parseLlmTagResult(rawResponse, tagDefinitions);
      if (!result) {
        await context.sdk.log('warn', `Failed to parse LLM response for note ${note.uuid}`, { raw: rawResponse.slice(0, 200) });
        await context.sdk.setPluginState(stateKey, {
          contentHash: note.contentHash,
          lastResult: 'error: parse_failed',
          lastRunAt: Date.now(),
        } satisfies AutoTaggerState);
        notesSkipped++;
        continue;
      }

      const validTagNames = new Set(tagDefinitions.map((t) => t.name.toLowerCase()));
      const passingTags = [...new Set(
        (result.tags || [])
          .filter((t) => t.confidence >= confidenceThreshold && validTagNames.has(t.tag.toLowerCase()))
          .map((t) => t.tag.toLowerCase()),
      )];

      if (passingTags.length === 0) {
        await context.sdk.setPluginState(stateKey, {
          contentHash: note.contentHash,
          lastResult: 'skipped: no_tags_above_threshold',
          lastRunAt: Date.now(),
        } satisfies AutoTaggerState);
        notesSkipped++;
        continue;
      }

      const confidences: Record<string, number> = {};
      for (const t of result.tags) {
        if (passingTags.includes(t.tag.toLowerCase())) {
          confidences[t.tag.toLowerCase()] = t.confidence;
        }
      }

      await context.sdk.proposeChange({
        entityType: 'note',
        entityId: note.uuid,
        changeType: 'tag_note',
        before: { tags: [] },
        after: { tagsToAdd: passingTags },
        preview: {
          noteTitle: note.title,
          proposedTags: passingTags,
          confidences,
        },
        reason: 'LLM-classified with high confidence',
      });

      await context.sdk.log('info', 'Proposed tags', { noteUuid: note.uuid, tags: passingTags });
      await context.sdk.setPluginState(stateKey, {
        contentHash: note.contentHash,
        lastResult: 'proposed',
        lastRunAt: Date.now(),
      } satisfies AutoTaggerState);
      proposalsCreated++;
    }

    return {
      notesScanned: classificationTargets.length,
      proposalsCreated,
      notesSkipped,
    };
  },
};
