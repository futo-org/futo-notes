### Round six: the account shows the result, and Enter

Reading the `merge-lists` account, an agent could not tell the run had failed: `outcome: answered`
is Jev's claim, the glue between `## Shopping` and `- milk` was only visible as "pasted at 64,
where the heading ended at 64", and the empty-line step returned 200 having written nothing
(`AppendLine {"text":""}` filled the blank last line with nothing). Three changes:

- The account ends with **changed lines**: the lines of the final document that were not in the
  first look at that note, as they now read. The result is in the account; `doc` is not needed.
- A 200 that moved only the caret says **no change** unless moving it was the verb.
- `AppendLine` with empty text always adds a blank line. An **`Enter`** verb presses Enter through
  the editor's own key handling (list continuation runs), the move before `Paste` when the caret
  ends a line. Jev takes it once `computed.caret.atLineEnd` is in the state to match the rubric
  against; offered unconditionally it became Jev's blank-line tool, and the next line verb filled
  the line it opened, so the controller lists it only while the clipboard holds text.

`outcome: answered` keeps its name: the changed lines make it a claim the agent verifies by reading
on, at no extra turn.

| run                    | passed | calls | wall |
| ---------------------- | ------ | ----- | ---- |
| jev-workflows-merged-2 | 18/20  | 80    | 84 s |
| jev-workflows-merged-5 | 19/20  | 81    | 84 s |

`merge-lists` passes (Enter at p=0.85, then Paste). `two-untitled` remains.
