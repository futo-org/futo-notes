# For You Page

Replace the blank launch screen with a personalized home page that surfaces the 3 notes you're most likely to open.

## V1

### Engagement Tracking

New persistence layer: `.engagement-v1.json` stored via `readAppData`/`writeAppData`.

```typescript
interface EngagementRecord {
  lastOpenedAt: number;
  openCount: number;
  lastEditedAt: number;
  editCount: number;
}

interface EngagementData {
  version: 1;
  notes: Record<string, EngagementRecord>;  // keyed by note id
}
```

**Hooks:**
- **Opens**: `NotesShell.svelte` `loadNote()` — increment `openCount`, set `lastOpenedAt`
- **Edits**: `notes.ts` `updateNote()` — increment `editCount`, set `lastEditedAt`
- **Persistence**: Keep in memory (`$state` rune), debounce writes to disk (~30s or on app background/close)
- **Cleanup**: Prune records on note delete, migrate on rename

### Scoring Algorithm

```
score = w1 * decay(lastOpenedAt)
      + w2 * decay(lastEditedAt)
      + w3 * normalize(openCount)
      + w4 * normalize(editCount)
```

- `decay(timestamp)` = `exp(-daysSince / halfLife)`. Half-life ~7 days for opens, ~14 days for edits.
- `normalize(count)` = `count / maxCountAcrossAllNotes` (0–1 range)
- Initial weights: `w1=0.35, w2=0.20, w3=0.25, w4=0.20`

### UI

Show 3 note cards on the home page (replaces "Select a note" empty state in `NotesShell.svelte`).

**Cold start**: No engagement data yet — fall back to `modificationTime` ranking from the existing notes list.

### Files

```
src/lib/engagement.ts              — EngagementData types, load/save/flush, tracking functions
src/lib/forYou.ts                  — Scoring algorithm
src/components/ForYouPage.svelte   — 3-card UI
```

## V2 (backlog)

- **View time tracking**: Start timer on note open, stop on close/switch/background. Accumulate `totalViewTimeMs`. Use `avgViewTime = totalViewTimeMs / openCount` as engagement signal.
- **More cards / sections**: "Recently opened" (pure recency list), "Revisit" (high historical engagement but low recent activity).
- **Note length / richness signal**: Boost longer, more structured notes (headings, lists, links). Derivable from existing search index.
- **Time-of-day patterns**: If you always open "standup" at 9am, boost it in the morning. Requires bucketing opens by hour.
- **Co-access patterns**: If notes A and B are always opened in the same session, opening A boosts B.
- **Sync engagement data**: Include engagement metadata in the sync payload so suggestions carry across devices.
- **Greeting text**: Time-aware greeting ("Good morning", "Good evening").
