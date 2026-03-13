import { extractTags } from '@futo-notes/shared';
import type { BuiltinPlugin, PluginRunContext } from './types.js';

interface TagDefinition {
  name: string;
  description?: string;
}

interface AutoTaggerState {
  contentHash: string;
  lastResult: string;
  lastRunAt: number;
}

interface LlmTagResult {
  tags: Array<{ tag: string; confidence: number }>;
}

function getNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function getString(config: Record<string, unknown>, key: string, fallback: string): string {
  const value = config[key];
  return typeof value === 'string' ? value : fallback;
}

function parseTagDefinitions(raw: string): TagDefinition[] {
  if (!raw.trim()) return [];
  return raw.split(',').map((entry) => {
    const trimmed = entry.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      return {
        name: trimmed.slice(0, colonIdx).trim(),
        description: trimmed.slice(colonIdx + 1).trim() || undefined,
      };
    }
    return { name: trimmed };
  }).filter((t) => t.name.length > 0);
}

export const autoTaggerPlugin: BuiltinPlugin = {
  id: 'auto-tagger',
  name: 'Auto Tagger',
  description: 'Automatically tag untagged notes using AI.',
  defaultEnabled: false,
  defaultSchedule: {
    kind: 'daily',
    time: '03:00',
    day: null,
  },
  defaultAutoApply: false,
  configSchema: [
    {
      key: 'tags',
      label: 'Available tags',
      type: 'string',
      default: '',
      description: 'Comma-separated tag definitions. Format: "tag-name: description" or just "tag-name". Example: "recipes: cooking and food, journal: daily reflections, work"',
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
  ],

  async run(context: PluginRunContext) {
    const tagsRaw = getString(context.config, 'tags', '');
    const tagDefinitions = parseTagDefinitions(tagsRaw);

    if (tagDefinitions.length === 0) {
      await context.sdk.log('warn', 'No tags configured — skipping auto-tagger run');
      return { notesScanned: 0, proposalsCreated: 0, notesSkipped: 0 };
    }

    const confidenceThreshold = getNumber(context.config, 'confidenceThreshold', 0.7);
    const maxContentChars = getNumber(context.config, 'maxContentChars', 3000);
    const staleMinutes = getNumber(context.config, 'staleMinutes', 5);

    const allNotes = await context.sdk.findNotes({ sort: 'modified_desc' });

    let proposalsCreated = 0;
    let notesSkipped = 0;

    for (const note of allNotes) {
      if (context.signal.aborted) break;

      const stateKey = `note:${note.uuid}`;

      // Skip recently modified (unless manual trigger)
      if (context.triggerType !== 'manual') {
        const cutoff = Date.now() - staleMinutes * 60_000;
        if (note.modifiedAt >= cutoff) {
          notesSkipped++;
          continue;
        }
      }

      const content = await context.sdk.readNoteContent(note.uuid);
      if (!content || content.trim().length < 20) {
        notesSkipped++;
        continue;
      }

      // Skip notes that already have tags
      const existingTags = extractTags(content);
      if (existingTags.length > 0) {
        notesSkipped++;
        continue;
      }

      // Check if content has changed since last run
      if (context.triggerType !== 'manual') {
        const previous = await context.sdk.getPluginState<AutoTaggerState>(stateKey);
        if (previous?.contentHash === note.contentHash) {
          notesSkipped++;
          continue;
        }
      }

      // Call LLM
      const tagList = tagDefinitions
        .map((t) => t.description ? `- ${t.name}: ${t.description}` : `- ${t.name}`)
        .join('\n');

      let rawResponse: string;
      try {
        rawResponse = await context.sdk.runBuiltinLlm({
          purpose: 'auto-tagger-classify',
          systemPrompt: 'You classify notes with tags. Given a note and available tags, return which tags apply. Only assign tags you are confident about. Return valid JSON only.',
          userPrompt: `Available tags:\n${tagList}\n\nNote content:\n${content.slice(0, maxContentChars)}`,
          temperature: 0.2,
          maxTokens: 256,
          disableThinking: true,
          jsonSchema: {
            type: 'object',
            properties: {
              tags: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    tag: { type: 'string' },
                    confidence: { type: 'number' },
                  },
                  required: ['tag', 'confidence'],
                },
              },
            },
            required: ['tags'],
          },
        });
      } catch (err) {
        await context.sdk.log('warn', `LLM call failed for note ${note.uuid}`, { error: String(err) });
        await context.sdk.setPluginState(stateKey, {
          contentHash: note.contentHash,
          lastResult: 'error: llm_failed',
          lastRunAt: Date.now(),
        } satisfies AutoTaggerState);
        notesSkipped++;
        continue;
      }

      let result: LlmTagResult;
      try {
        result = JSON.parse(rawResponse);
      } catch {
        await context.sdk.log('warn', `Failed to parse LLM response for note ${note.uuid}`, { raw: rawResponse.slice(0, 200) });
        await context.sdk.setPluginState(stateKey, {
          contentHash: note.contentHash,
          lastResult: 'error: parse_failed',
          lastRunAt: Date.now(),
        } satisfies AutoTaggerState);
        notesSkipped++;
        continue;
      }

      // Filter by confidence and valid tag names
      const validTagNames = new Set(tagDefinitions.map((t) => t.name.toLowerCase()));
      const passingTags = (result.tags || [])
        .filter((t) => t.confidence >= confidenceThreshold && validTagNames.has(t.tag.toLowerCase()))
        .map((t) => t.tag.toLowerCase());

      if (passingTags.length === 0) {
        await context.sdk.setPluginState(stateKey, {
          contentHash: note.contentHash,
          lastResult: 'skipped: no_tags_above_threshold',
          lastRunAt: Date.now(),
        } satisfies AutoTaggerState);
        notesSkipped++;
        continue;
      }

      // Propose the change
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
      notesScanned: allNotes.length,
      proposalsCreated,
      notesSkipped,
    };
  },
};
