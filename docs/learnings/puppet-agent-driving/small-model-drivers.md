## 7. Small models driving instead of Claude

*Can a fast, cheap model do the driving?*

**Granite 8B, locally (09-14):** five iOS verbs (open, select, bold, close find), on an M5 with
24 GB.

| Variant | Pass | Wall time |
|---|---|---|
| Scripted, no model | 1/1 | 0.77 s |
| Bare verb names | 0/3 | 5–10 s |
| One-sentence descriptions | 3/3 | 6.6 s |
| Thinking on | 1/1 | 188 s |
| Told to batch | 2/2, never batched | 6.3–7.7 s |

The model was 96% of the wall time. Descriptions in `actions` were declined ("Seems like it's
doing fine without one"), and the cloud test that was meant to settle it never ran.

**Jev wins at pure driving.** Jev is TypeSafe's hosted model, at about 0.3 s a request. It never
writes text: it picks among options that code builds from the goal and the screen. On the 20
desktop workflows:

| | Jev alone | Claude alone |
|---|---|---|
| Buffer-write verbs | 19/20, 84 s, $0.04 | 18/20, 523 s, $1.68 |
| `Type`/`Press` only | 11–12/20 | 19/20, 480 s, $1.96 |
| Fast writes marked convenience, plus typing | 17–18/20 | 19/20, 454 s, $1.85 |

- **Fast and cheap, but tuned.** That is about a sixth of the time and a fortieth of the cost, but
  Jev's 19/20 was tuned on these same tasks.
- **Typing defeats it, because it cannot compose text.** Four rounds of extra help went 12 → 12
  → 11: "The driver isn't missing advice, it's missing information."

**What made Jev better:**
- **Telling it the layout.** Jev "picks one step at a time from what the current screen offers, so
  it never plans that detour". A sentence per platform describing the layout made the
  copy-between-notes goal pass everywhere.
- **Deciding hand-off in code.** Jev asked for help in at most 2% of turns, even while looping for
  77 turns. Handing off on a stuck signal (no list can fill an argument, three refusals, a loop)
  cut hand-offs from 8 to 3, and cost from $0.29 to $0.19.
- **Smaller requests.** 94% of a request was question text and about 4% the app. Stating the step
  rule once kept 38/38 with 16–17% fewer tokens. Asking dependent arguments in a second pass cut a
  turn from 11.9k to 7.6k tokens.
- **The 255-choice cap.** TypeSafe takes at most 255 choices per question, and the held-out vault
  has 497 notes, so Jev scored 0/28 until a shortlist from the app's own search (11/28).

**Jev did not pay inside real work.**
- **The pilot.** A 3-goal Opus pilot with Jev on and off was a wash, once a TypeSafe outage
  (requests of 3–28 s) was ruled out.
- **In diagnosis,** with the CLI forcing Jev first:

  | Bug | Claude alone | Jev first |
  |---|---|---|
  | 04 | 132 s, $0.65 | 245 s, $1.06 |
  | 11 | 119 s, $0.56 | 220 s, $0.93 |
  | 03 | 87 s, $0.58 | 60 s, $0.43, after tool fixes |

  Jev's failures there were gaps in the tool: no real click, no empty value, and a false "done".
- **Shelved on 09-28,** with the code kept. Mason: "Can we just shelf the jev stuff for now and
  focus up on making the normal agent driving as good as possible? … Don't remove code or
  anything." The gate is off unless `FUTO_PUPPET_JEV=on`. Its 40 logged drives cost $0.09 in
  total.

**Laya was a no-go (09-22).** Laya is a Core ML decision model. We replayed it on 60 of Jev's
turns, against a bar of 17/20 matching Jev on turn 1, with a working done gate:

| Checkpoint | Turn 1 matches Jev | All turns | Done gate agrees |
|---|---|---|---|
| typed-decisions | 14/20 | 22/60 | 14/60 |
| multilingual | 12/20 | 17/60 | 4/60 |

"Fast enough and the context fits, but it does not read the state": every miss was a keyword match
on the goal's words. Mason: "We do not want to use small instruct llms at all."
