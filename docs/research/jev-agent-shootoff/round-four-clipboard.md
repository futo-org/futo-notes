### Round four: a clipboard, the way a person has one

`merge-lists` needs the lines of one note copied into another. Jev's own instinct in every run
was right (it opened the source note), but it had no way to carry what it saw. The fix is not a
controller buffer but three verbs the user already has: `PlaceCaret {at}`, `Copy` (the selection
into the agent's clipboard, 409 with nothing selected) and `Paste` (literal, over the selection or
at the caret, 409 when empty). The clipboard is one variable in the page, shown as
`state.editor.clipboard`, survives switching notes, and never touches the OS clipboard, which
belongs to the person at the machine. `clipboard {"clear":true}` empties it, which the harness
does between tasks after one run pasted the previous run's copy. `Select` also gained whole-line
and whole-document ranges as candidates, so Copy has a target without a word from the goal.

Both Jev arms now do the whole thing unaided in eight turns, about 5 s: open the source, Copy,
open the target, Paste. The task still fails on one character: Jev pastes at the end of the
heading line instead of pressing Enter first, so the list is glued to `## Shopping`. A line break
is offered as an Insert candidate and the Paste rubric says a person presses Enter before pasting
onto a new line; Jev took Paste at 0.7 confidence anyway, so no handoff fired either. That is the
honest residue: a literal paste, exactly as asked for, and a judgement about where the caret
should be that the model does not make. The cycle detector also learned that `Select` and `Copy`
change no document: its key now includes the selection and the clipboard, after it stopped a
correct copy flow as a loop.

Observed on the way: reopening a note restores its last selection, so a note whose whole text
was once selected opens selected. A real Copy on open then works with nothing chosen. Not a bug
in the tool; worth knowing when reading a trace.
