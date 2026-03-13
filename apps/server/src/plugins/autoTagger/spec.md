# Auto Tagger

## Purpose

Automatically propose tags for untagged notes using the built-in LLM with example-based few-shot classification. The user manually tags a few notes, and the autotagger discovers those as training data to classify the rest.

## Trigger

- Built-in plugin id: `auto-tagger`
- Enabled by default
- Default schedule: daily at `03:00`
- Default apply mode: auto-apply

## Configuration

- `tags`: ordered tag definitions; each entry includes:
  - `name`: the tag name to add
  - `description`: guidance describing what kinds of notes should receive that tag (used as cold-start fallback when no examples exist)
- `confidenceThreshold`: minimum confidence required to propose a tag, default `0.7`
- `maxContentChars`: max note content sent to the LLM, default `3000`
- `staleMinutes`: skip recently modified notes on scheduled runs, default `5`
- `maxNotesToScan`: only scan this many most recently modified untagged notes, default `5`

## Run Flow

### Phase 1: Scan & Partition

The plugin scans a broad pool of notes (`max(maxNotesToScan * 5, 100)`) sorted by most recently modified and partitions them:

- **Example notes**: have tags matching a configured tag name → collected as few-shot examples
- **Classification targets**: no tags at all → candidates for tagging (limited to `maxNotesToScan`)
- **Other tagged notes**: have tags but not matching configured ones → skipped entirely

### Phase 2: Build Examples

For each tagged example note:
1. Match its tags against configured tag names (case-insensitive)
2. Strip the tag header using `extractHeaderTagBlock()` from `@futo-notes/shared`
3. Take first ~200 chars of remaining content as snippet
4. Collect up to 3 examples per tag (most recent first)

When there are many configured tags (>5), the max examples per tag is reduced dynamically (3→2→1) to stay within the LLM's token budget.

### Phase 3: Classify

For each classification target, the plugin checks skip rules then sends the example-enriched prompt to the LLM.

## Skip Rules

For each classification target, the plugin skips when:

- the run is not manual and the note was modified within `staleMinutes`
- the run is not manual and the note `contentHash` matches stored plugin state

Notes are excluded from the scan entirely when:

- note content is missing or shorter than 20 trimmed characters
- the note title matches `Untitled` or `Untitled (N)` (same pattern as quick-capture)
- the note already contains tags (these become example candidates instead)

If no tags are configured, the plugin auto-discovers tags by scanning notes in the vault and collecting all existing tags. Discovered tags are sorted by frequency (most common first) and used as the tag definitions with empty descriptions. If no tags are found in the vault either, the run is skipped and returns zero counts.

## Prompt Design

**System prompt**: Generic single-line instruction to classify and return JSON.

**User prompt**:
- Tag list (all configured tag names)
- Example block: for each tag, either real examples from user's notes or a cold-start fallback with the tag description
- Note title and content

Tags WITH examples show title + snippet (tag headers stripped from snippets). Tags WITHOUT examples show `(no examples yet — {description})` as fallback.

## LLM Classification

The plugin tries the configured `maxContentChars` budget first, then smaller fallback budgets of `2000`, `1000`, and `500` when needed.

Expected response shape:

```json
{
  "tags": ["tagname"]
}
```

Accepted fallback forms also include:

- `tags` as an array of objects with `tag` and `confidence` fields
- a boolean map like `{ "work": true }` for valid configured tags

Only configured tags are accepted.

## Failure Handling

- Fatal model/load/memory style errors stop the run immediately.
- Other LLM call failures are recorded per note and skipped.
- After 3 consecutive LLM failures, the plugin stops the run with an error.
- Parse failures are recorded per note and skipped.

## Edge Cases

- **Cold start** (no tagged notes): All tags show description fallback — degrades to description-only mode
- **Sparse examples**: Mix of real examples and description fallbacks per tag
- **Short example content** (<20 chars after tag stripping): Skipped as examples
- **Positive feedback loop**: Applied tags make notes become examples on next run

## Proposed Change

When one or more tags pass the threshold, the plugin proposes a `tag_note` change.

The proposal includes:

- `tagsToAdd`
- preview note title
- proposed tags
- confidence per accepted tag

Reason:

`LLM-classified with high confidence`

## Stored State

State is stored per note under:

`note:<note-uuid>`

Stored values:

- `contentHash`
- `lastResult`
- `lastRunAt`

## Run Summary

The plugin returns:

- `notesScanned` (number of classification targets)
- `proposalsCreated`
- `notesSkipped`
