# Weekly Related Notes

## Purpose

Surface a small set of recent prior notes into each weekly note so the weekly note has lightweight context links.

## Trigger

- Built-in plugin id: `weekly-related-notes`
- Enabled by default
- Default schedule: weekly, Monday (`day: 1`) at `03:00`
- Default apply mode: auto-apply

## Target Notes

The plugin scans notes whose filename matches a configurable regex.

Default:

`^(This week \(|[Ww]eek of ).*\.md$`

## Anchor Date

Each weekly note gets an anchor timestamp used for the lookback window:

1. If the title contains a range like `(M-D-YYYY to M-D)`, use the **end date** (end of day). This ensures notes modified during the week are included as candidates.
2. Else if the title contains a single `(M-D-YYYY` date, use that date.
3. Else use an ISO `YYYY-MM-DD` date in the title if present.
4. Else fall back to `createdAt`, then `modifiedAt`.

## Candidate Pool

The plugin looks for notes modified before the anchor and within the recent lookback window.

Defaults:

- `lookbackDays = 30`
- `maxCandidateNotes = 40`

Rules:

- exclude the weekly note itself
- exclude empty notes
- keep the top scored candidates by lexical overlap, phrase boosts, and recency

## Selection

Defaults:

- `maxLinks = 6`
- `includeReasons = true`

If reasons are enabled, the built-in LLM chooses up to `maxLinks` candidates and returns a short reason for each.

If the LLM output is missing or invalid, the plugin falls back to the top scored candidates and generates simple overlap-based reasons.

If reasons are disabled, the plugin skips the LLM call and uses the top scored candidates directly.

## Rendered Content

Default heading:

`## Related Notes`

Rendered content is a heading followed by wiki-link bullets:

```md
## Related Notes
- [[Some note]] - Short reason.
- [[Another note]] - Short reason.
```

If reasons are disabled:

```md
## Related Notes
- [[Some note]]
- [[Another note]]
```

The plugin writes plain markdown only. It does not wrap the section in hidden marker comments.

## Apply Behavior

The plugin proposes a `replace_managed_block` change against the weekly note.

- In preview mode, the run waits for approval.
- In auto-apply mode, the scheduler applies the proposed block replacement automatically.
- On reruns, the plugin treats the configured heading section as owned content and replaces that section in place.
- If the heading section is absent, the plugin appends a fresh section at the end of the note.

## Skip Conditions

The plugin skips a weekly note when:

- note content cannot be read
- no candidates are found
- no links are selected
- the newly rendered content matches the existing managed block
- the note content hash and previously rendered block match stored plugin state

## Stored State

State is stored per weekly note under:

`note:<weekly-note-uuid>`

Stored values:

- `sourceHash`
- `renderedBlock`
- `lastResult`
- `lastRunAt`
