# 12. Tab and indent

| ID | Do | !300 result | Ref | Applies | Engine today | Target |
| --- | --- | --- | --- | --- | --- | --- |
| P292 | With the caret in the middle of a code line, press Tab. | The line is indented ("Tab keeps indent/outdent everywhere else"). The spec does not state the unit, or whether text is inserted at the caret or at the line start. | cb 969-970 | hardware keyboard | differs: two spaces are written AT THE CARET (fc 23) | ask Mason |
| P293 | Select several code lines and press Tab. | Each line is indented (unit not stated). | cb 969-970 | hardware keyboard | same: two spaces are written at the start of each selected line (fc 23) | !300 |
| P294 | On an indented code line, press Shift-Tab. | The line is outdented. | cb 969-970 | hardware keyboard | same (fc 23: takes off a leading tab, else up to two leading spaces) | !300 |
| P295 | On a phone, with the caret in code, use the toolbar's Indent and Outdent. | Ambiguous. ed 841-842 says "Indent/Outdent stay live inside code (indenting code is real work)", but ed 782 says the toolbar shows "Indent/Outdent (shown when the cursor is on a list line)". | ed 841-842; ed 780-784 | touch | same (fc 23: Indent is offered on code lines and writes one tab; Outdent is offered where there is something to take off) | ask Mason |
| P296 | Indent or outdent with a selection that touches a fence line. | The fence lines are never changed. | ed 841-842 | both | unknown | !300 |
