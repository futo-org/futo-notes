## Receipts, refusals, exit codes

`do` prints each step as text, verdict first, then what the verb answered, what it did to the
app, and the screen rows that changed (SKILL.md shows one). Nothing is left out: a field with
no rendering of its own prints as `key value`, and only a row that went is shortened, to its
ref, role and text. A batch of two or more steps prints each step's verdict, facts and row
count, then the screen once as the batch left it: the desktop page's diff from before the
first step to the page once it stops moving (`diff {"from":N}` with no `to` is "until now"),
or a phone's first screen against its last. Should that be unavailable (the page no longer
holds the first snapshot), every step prints in full instead. Read it whole; never pipe it
into `head`, `tail` or `grep`.
`{"json":true}` in a step's args prints the receipts raw instead, one element per step:
`verb`, `status`, `result`. A successful in-page verb also carries `action` (the record id — `diff {"action":N}` replays
it), `diff`, `editor` (state after), and `events` (how many DOM events fired).
`diff` covers what changed between the snapshots either side: a `doc` hunk,
`selection` before/after, `elements` added/removed/changed, `screen`, and — on every
target, verbs and gestures alike — `state` and `vault`. `state` is each changed key path
of `state`; `screen`, `selection` and every `state` entry are `[before, after]` pairs —
`"settings.theme_mode": ["AUTO", "DARK"]` reads "was, is now" (an object that appeared is its
whole value; a large one that went is `"{…}"`; the text form of a list that gained or lost
members names just those, `+"ideas"`). `pending` is the moment the receipt closed: on a
phone an edit reaches the native store a beat after the page has it, so `Type`'s own
receipt can show nothing unsaved and the next one the save it is waiting on. `vault` is `notes` `added`/`removed`/
`written` and `folders` `added`/`removed`; `written` leaves out the open note, whose text
is the `doc` hunk and which saves on its own schedule.
It is absent when nothing changed. `changedSinceLast` means the page moved after the previous receipt with no input in between (a timer, a load, a late render): its diff is what that receipt did not see.

| status | meaning                                                                                                                                                                                  | example text                                                                                                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | done                                                                                                                                                                                     |                                                                                                                                                                                        |
| 202    | async verb still running; the CLI polls up to 5 s and prints the settled receipt. Still pending (one awaiting a dialog) prints `still running`, and `diff {"action":N}` fetches it later |                                                                                                                                                                                        |
| 400    | bad argument, checked against `actions` before it is sent — the message ends with what this verb does accept, or the call a lone misnamed argument meant; a note or folder the vault lacks names the ones it has in another case, or of the same name in another folder | `unknown argument "position" — takes {index?: integer, noteId?: string}` · `unknown argument "with"; did you mean "text"? do Replace '{"find":"a","text":"b"}'` · `no such folder: Work; did you mean "work"? do OpenFolder '{"path":"work"}'` |
| 404    | no such verb **on this screen**, followed by the verbs it has                                                                                                                            | `no such verb on this screen: Frobnicate` ⏎ `list has: OpenNote, OpenFolder, …`                                                                                                        |
| 409    | the app is not in that state                                                                                                                                                             | `text at 0-27 is …, expected …` · `2 occurrences of "a" (at 0, 4)` · `nothing to undo` · `the clipboard is empty: Copy first` · `no editor on this screen (home)`                      |
| 501    | this shell cannot answer that query yet                                                                                                                                                  | `this shell does not report the vault`                                                                                                                                                 |
| 503    | not ready                                                                                                                                                                                | `the editor is still loading` · `an editor is open; GoBack before navigating elsewhere`                                                                                                |

Any refusal exits 2 and stops the rest of a batch, a gesture's too (`REFUSED <status> tap: …`:
text not on screen, with `reach it:`; input that produced no page event; `type` into no field;
a touch the app never received). A step that fails after an earlier one ran prints `FAILED
<Verb>: …` and the steps `not run`, and exits 2. A malformed command exits 1 without reaching
the app: bad JSON, an argument too many, a gesture given `ref` and `x`,`y` together, or the
wrong input model (`tap` on desktop, `click` on a phone). Every receipt is appended to
`.puppet/trace.jsonl` in the worktree, so a run can be reconstructed afterwards.
