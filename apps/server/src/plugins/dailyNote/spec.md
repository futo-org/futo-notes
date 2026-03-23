# Daily Note Plugin

## Purpose

Generate a personalized daily briefing note every day. Summarizes recent activity, surfaces open tasks with source attribution, suggests next steps, asks forward-looking questions, and links to relevant notes.

## Three-Phase Pipeline

The 4B model can't read the whole vault in one call, so the plugin uses a multi-step pipeline:

### Phase 1: Profile Building (LLM, runs only when new notes detected)

- Loads existing user profile via `sdk.getUserProfile()` (shared across all plugins)
- Loads profiled content hashes from private plugin state
- Fetches 20 most recent notes, filters to those not already profiled
- If no new notes, skips to Phase 2
- Reads up to 5 new notes (first 400 chars each)
- LLM call (thinking disabled, temperature 0.2, maxTokens 800): extracts structured facts and merges with existing profile
- Saves updated profile via `sdk.setUserProfile()` (shared namespace)
- Saves profiled hashes to private plugin state

### Phase 2: Context Gathering (no LLM)

- Computes today's date (YYYY-MM-DD) and day of week
- Checks if daily note already exists via `findNotes({ filenameRegex })`
- Finds weekly planning note (most recent "This week" or "Week of" note)
- Fetches notes modified in last `lookbackDays`
- Reads first 400 chars of each as summary (up to `maxRecentNotes`)
- Extracts open tasks: regex `- [ ] (.+)` from recent notes, up to 12
  - Weekly note tasks first (highest priority, max 6)
  - Then backlog tasks from other notes (max 4)
  - Each task includes its source note title
- Extracts blockquotes from recent notes (max 3)
- Finds yearly goals/themes notes
- Builds wikilink title list from all note titles (max 500)

### Phase 3: Note Generation (LLM with thinking enabled)

- Single LLM call with thinking enabled
- Temperature 0.7, maxTokens 8000, timeout 10 minutes
- Post-processing pipeline:
  1. Strip `<think>` tags
  2. Fix malformed wikilink brackets (`[[title))]` → `[[title]]`)
  3. Clean LLM stutters (repeated words after bold/wikilinks)
  4. Fix voice breaks (replace "we/the team/the user" with "you")
  5. Fuzzy wikilink correction (Levenshtein distance ≤ 3, similarity ≥ 60%)
  6. Ensure horizontal rules before headings
  7. Fallback content if generation is empty

### Fuzzy Wikilink Correction

When the LLM generates a wikilink that doesn't exactly match a known title:
1. Compute Levenshtein edit distance against all known titles
2. Skip candidates with length difference > 3 (quick filter)
3. Accept match if distance ≤ 3 AND similarity ≥ 60%
4. Replace typo'd wikilink with correct title
5. If no match found, strip brackets (keep text)

## Generated Note Structure

1. **Opening** — Date greeting + optional day-of-week context
2. **Where things stand** — 2-3 paragraphs synthesizing the week from planning notes and recent activity
3. **Still open** — 4-8 checkbox tasks with source note attribution
4. **What to focus on today** — 2-3 concrete suggestions
5. **The bigger picture** — (if goals/themes note exists) Brief goal check-in
6. **Blockquote** — (if quotes found) Notable quote from recent notes
7. **Closing line** — Short, specific, no clichés
8. **Questions for tomorrow** — 2-3 direct, specific questions about current work that seed the next day's briefing

## Output Decision

- If note for today doesn't exist: propose `create_note`
- If note exists: propose `replace_managed_block` with heading_section strategy
- Same-day reruns with identical content hash are skipped

## Config Schema

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| lookbackDays | number | 7 (1-30) | Days of recent activity to consider |
| maxRecentNotes | number | 10 (3-30) | Max notes to include as context |
| includeOpenTasks | boolean | true | Scan for unchecked tasks |
| tone | string | "professional and warm" | Briefing tone |

## Schedule

Daily at 05:00, auto-apply enabled, disabled by default (opt-in).

## Error Handling

- First run with no profile: skip profile, generate with raw context only
- Profile LLM failure: log warning, proceed with stale/empty profile
- Generation LLM failure: fail the run (critical path)
- Invalid wikilinks in output: fuzzy correct if close match, else strip brackets
- Dynamic budget: if estimated tokens exceed 4500, reduce maxRecentNotes

## Web Context (Stub)

Placeholder for optional web search integration. When implemented, will:
- Extract technology/tool names from recent notes
- Search for notable releases or news
- Only surface genuinely interesting items
- Gated behind config flag (disabled by default)
