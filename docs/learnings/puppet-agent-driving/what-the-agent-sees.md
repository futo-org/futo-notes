## 3. What the agent sees

*What should each call print, and does the agent read it?*

**Every misleading receipt we chased was a tool bug.**
- **The iOS predictive-text bar.** It floated over the web view when the caret sat at the end of a
  word, and swallowed taps: 10 of 10 at one coordinate, zero page events, reported as "no change".
  - One screenshot found it, after rounds of theorising about frame timing.
  - A gesture that reaches no page event now fails and names the likely causes.
- **Snapshots taken too early.** They were taken before Svelte had applied state, so 37/37
  context-menu opens, 17/17 move pickers and 28/28 folder picks read "no change".
  - A synchronous flush before the snapshot fixed it at no cost.
  - A blanket 250 ms wait on every action was rejected.
- **A labelled input** reported its label, not its value, so changing what a field held read "no
  change".
- **Verbs answering before their work landed.** In 14 of 14 runs of one workflow, `OpenNote`
  answered before the switch and the driver chose text from the old note. Verbs now hold until the
  work has settled.

**Wait times were measured, not guessed.** The 400 ms quiet window had no recorded reason. We
measured 20 runs of each, with zero events arriving after a receipt closed:

| Desktop action | Before | After |
|---|---|---|
| Click | 727 ms | 230 ms |
| Scroll 300 px | 626 ms | 226 ms |
| Drag-select | 1400 ms | 235 ms, exact 10/10 |

Desktop now polls every 25 ms and settles after 120 ms of quiet. Phones keep 400 ms, plus a `moving`
flag on iOS: a faster settle had fired in the middle of a sheet animation.

**Receipts show the whole app's change.**
- **Why.** Mason (09-30): "We'd want it so that the click / tap / verb would say what happened
  instead only showing rows that change."
- **Before.** Phone verbs answered `{ok, verb}`: 46 of 109 iOS turns got a receipt that said
  nothing.
- **Now.** The CLI reads `state` and the vault before and after each successful action, and prints
  only the differences. Each read costs 20–60 ms.
- **Cut.** Named receipts for each native handler (about 180 sites) were not worth it.

**Agents filter receipts before they have seen one.** In the 10-01 audit of 84 held-out sessions,
510 of 551 action receipts (92%) went to `head`, `grep` or `/dev/null`. 58 sessions filtered their
very first `do`. It cost goals: on iOS, `| grep status` hid a refusal and the goal failed.

**Telling them not to did nothing; text receipts and a hook did.** The skill already said "read the
receipt" when the 92% was measured.
- **Format.** One line per row, verdict first: receipts became about 16× smaller (median 147 B)
  and 0.40× the tokens of pretty JSON. TOON measured 0.69×.
- **The hook.** `scripts/puppet-receipt-hook.mjs` (PreToolUse) refuses an action whose output is
  piped or redirected. It blocked 27 attempts in about 130 goals.

| Held-out: calls, input tokens a goal | JSON (v1) | Text + hook (v2) | A batch prints its screen once (v3) |
|---|---|---|---|
| Desktop | 8.0, 620k | 7.0, 563k | 7.0, 570k |
| iOS | 8.1, 622k | 8.8, 674k | 7.8–8.5, 605–665k |
| Android | 7.6, 583k | 8.1, 626k | 7.7–7.8, 603–613k |

- **Filtering on desktop** went from 94% to about 0, then 2–3% once batches came back.
- **The phones got worse at v2,** because a batch printed the whole screen for every screen it
  passed through. Printing the net change once fixed that.
- **Before shipping it,** we replayed the last 3,000 real receipts and checked 15 live batches to
  prove nothing was lost.

**An outline, not a dump.** `elements` gives one outline per screen:
- sections in reading order;
- one coordinate space per device;
- a scroll summary ("rows 7–14 of 18 · more above and below");
- only rows a touch can reach, each with `→ Verb`.

The raw iOS tree for the note list alone is 162 KB; outlines are 0.2–3.5 KB. A read takes
50–110 ms on every platform.

**Silent zeros must be loud errors.**
- With the simulator's accessibility switch off (XCUITest leaves it off), the iOS reader returned
  0 elements.
- A production `editor.html` silently dropped the editor from `elements`.

Both now fail with the fix in the message. Mason: "Make the accessibility error very clear and
explicit."

**Search finds notes; a full listing maps folders.**
- **Search wins for single notes.** A bare `notes` lists all 497 notes in 18k characters. Search
  put the right note first for 12 of 13 names, in 100–300 characters.
- **Folder goals still dump.** Telling agents to search the way a person would (v9 → v11) took
  search reads from 21 to 62. Bare listings only fell from 21 to 17, because 13 of those 17 were
  folder goals.
- **A rule that backfired.** "Open the folder and read its rows" broke "my most recent journal
  entry" on both phones: only the rows that fit are drawn, and they all read "Just now".
- **The fix.** Filtering `notes` by the folder fixed it: Android v12 passed, and bare listings fell
  to 15.

**Context is mostly Claude Code's, not ours.**
- **Turn 1** was 42.9k tokens in the 10-06 held-out runs, before the app had printed anything.
  Our instruction files (AGENTS.md, README and MEMORY.md, 26.5k characters) are about 6.5k of that.
- **A turn** averaged about 54k tokens.
- **Everything the app printed over a whole goal** came to about 3–3.5k tokens.

**Some bugs are only visible.**
- **Bug 13 (wikilinks, visual)** could not be reproduced at first:
  - `show` reports geometry, not colour;
  - `qa-shot` returned a blank frame;
  - the screenshot route that worked lived in a skill agents never loaded.
- **`just puppet screenshot`** (10-06) now works on all three platforms and writes a PNG for the
  agent to open. Bug 13 then reproduced 2 of 2.
- **Recording.** A recording of the hidden window was blank, because WebKit stops painting
  occluded windows. A private, debug-only WebKit switch (`_setWindowOcclusionDetectionEnabled:`)
  fixed that, giving about 30 fps on another Space. `just puppet record` was not built.

**The record cannot explain the app.**
- **The 09-24 trace audit.** 25,583 lines in four days, only 24 with arguments, and no run id or
  duration. None of seven investigation stories was fully answerable from it.
- **09-28.** Mason asked for "no mystery after they happen", but nothing recorded handler chains,
  store calls, Rust mutations or errors.
- **Parked.** The proposed test: drive a seeded bug, then ask whether the log alone shows the
  cause.
