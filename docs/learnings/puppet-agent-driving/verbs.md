## 2. The verbs

*What should an agent be able to call?*

**Every UI handler is a verb, enforced at build time.**
- **Where verbs live.** They register beside the handlers they call, so `actions` lists exactly
  what is mounted.
- **The gate.** `check-puppet-verbs` fails any Svelte handler, SwiftUI control or Compose control
  that has no verb. Each verb names the label keys of its controls, so every row in `elements`
  shows `→ Verb`.
- **Why build time.** Matching handlers to verbs at runtime had matched 0 of 28 desktop rows,
  because Svelte wraps handlers.
- **What it found.** The per-control check found 370 gaps on its first run (09-30), and 151 more
  after the rebase onto main (10-02). Both were taken to zero.
- **Blind spot.** It cannot see ProseMirror plugin handlers, which were inventoried by hand.

**A verb is one user action; shortcuts are marked.**
- **Composite verbs rejected.** The optimisation loop added `OpenNotes {noteIds}`. Mason rejected
  it: "We want it going through the steps. Speed isn't the only thing." `Insert {"atEnd": true}`
  with a typed `\n` went the same way.
- **`Type` and `Press` replaced them,** with a newline typed as an Enter press. No eval task had
  ever run the real Enter handler, because every task wrote newlines as text.
- **Convenience verbs.** Line-writing verbs came back on 09-23, flagged in `actions` as
  `(convenience, not real input)`, because without them Jev could not compose text (§7). Today they
  are `Insert`, `Replace`, `ReplaceLine`, `InsertLine` and `AppendLine`, plus `ScrollBy` and
  `ScrollToRow` for jumping to a place.
- **The rule since 10-05:** the faithful step by default, with any shortcut as an optional argument
  on the same verb.

**Only what a person could reach.** Mason (09-28): "We are not looking for the fewest calls
necessarily. We are looking for the fewest calls with proper app navigation."
- **Teleports found by the audit:**
  - desktop `OpenNote` opened any note, whether or not it was drawn;
  - Android `OpenNote` did three user actions in one call;
  - `ToggleFolder` inside a collapsed folder silently opened its parents.
- **What the CLI does now.** It refuses a row verb (`OpenNote`, `ToggleFolder`, context menus,
  `MoveNote`, `DeleteNote`, `ScrollToRow` and others) with 409 when the row is not in `elements`.
  Tree verbs refuse inside a collapsed folder.
- **Cost.** The rule broke 24 of the 28 held-out reference solutions, which were rewritten. No goal
  changed.

**A refusal should print the call that works.** The 10-01 audit of 84 held-out sessions found
74 of 587 calls (12.6%) wasted, in 33 tasks:

| Cause | Wasted calls |
|---|---|
| Row not on screen | 26 |
| Wrong or missing argument | 17 |
| Receipt filtered | 13 |
| `type`/`press` with nothing focused | 9 |

The CLI now checks arguments before sending: an unknown one gets a did-you-mean with the whole
corrected call. A row refusal prints the batch that reaches the row. The CLI never runs a
suggestion itself.

| Held-out calls a goal | Before (v3) | After (v4) |
|---|---|---|
| Desktop | 7.0 | 6.9 |
| iOS | 8.1 | 7.0 |
| Android | 7.8 | 6.3 |

Desktop row refusals fell from 0.75 to 0.54 a goal. They reached 0.14 once we fixed the skill's own
example batch, which had taught an order the gate refused. Only 4 of 15 printed batches ran
unchanged, because agents adapt them.

**Spell out argument values.**
- **`mode`.** `OpenNote`'s `mode` was typed as a plain string, so agents did not know a tab could
  open in the background: one goal took 5, 7 and 17 calls in three runs. Listing
  `current|foreground|background` made it 4 calls in all three.
- **One-line `actions`.** Printing each verb on one line
  (`OpenNote {noteId: string, mode?: current|foreground|background}`) cut `actions` from 14–19% of
  all tool output to 9–10%.

**Editor positions are the editor's own.**
- **The problem.** The Milkdown port (10-02 to 10-05) changed what `doc` offsets mean, and agents
  had made 696 `doc` calls in 2,034 goals.
- **Rejected:** a translator back to markdown offsets, as "a hack".
- **Adopted:** ProseMirror positions as the coordinates. `doc` prints them per line, plus an `md│`
  row where the saved markdown differs:
  `L4 39-63│paragraph│Call Sam about the lease`.
- **A probe of the real editor corrected four of our assumptions:** soft breaks, tags, task
  checkboxes, and the serializer rewriting `---` as `***`.
- **Result.** Held-out stayed 80/80. `Select` still takes `expect`, and a stale document version
  refuses.

**Confirmations and the OS.**
- **Confirmations.** Every confirming verb takes an optional `answer: confirm|dismiss`. Without it,
  the verb stops with the real dialog up.
- **Links** really open, in the background, in `FUTO_DEV_BROWSER` (Safari by default), and the
  receipt names the URL.
- **OS UI.** Where a verb cannot press OS UI, an argument stands in: a path for the folder picker,
  a code for the camera.
- **Long phone verbs.** Phone listeners answer one command at a time, so long phone verbs
  (sign-in, pairing) return `started` rather than block everything behind them.

**Names.**
- **Verb names** carry their object, use the UI's own words, and never collide with a CLI command
  (`TapCoin` became `SpinCoin`).
- **The tool's name.** It became `puppet` because "agent" already meant four other things here.
