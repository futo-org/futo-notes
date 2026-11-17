# 4. Typing and Enter

| ID | Do | !300 result | Ref | Applies | Engine today | Target |
| --- | --- | --- | --- | --- | --- | --- |
| P081 | Press Enter on any code line: middle, last, a blank line above the closing fence, and twice on a blank last line. | A plain newline is inserted inside the block every time. Blank lines are legitimate code, so Enter never leaves the block. | cb 988-989 | both | same (fc 20) | Mason's pick: Enter in code is always a line break and never leaves the block |
| P082 | With the caret at the end of an indented code line (`    return x`), press Enter. | "a plain newline". The spec does not say whether the new line gets the leading spaces. | cb 988-989 | both | differs: the new line gets the line's leading spaces and tabs up to the caret (fc 20) | ask Mason |
| P083 | In code, press Enter at the end of a line that starts `- `, `1. ` or `> `. | A plain new line. No marker is continued: in code these are text. | cb 990-991 | both | same (fc 5; fc 20) | !300 |
| P084 | Type letters, punctuation and Markdown markers on a code line. | They land exactly as typed. | cb 996 | both | same (ii 17) | !300 |
| P085 | Inside a block, type a line holding only three backticks (the block's own fence characters). | The spec does not state what happens. | — | both | same (fc 20: a line break that leaves the fence on its own line closes the block there) | Mason's pick: a typed closing fence ends the block |
| P086 | Inside a block, type one, two and three backticks at a caret. | Each backtick is typed as a plain character. The ladder (pair, then block) does not run in a rendered block, where pairing once stacked a second block under the first. | ed 702-706 | both | same (pt 12) | Mason's pick: no backtick typing conveniences inside a code block |
| P087 | Inside a block, type `*` and `~`. | Plain characters, no pair. | ed 702-703 | both | same (ii 17; pt covers backticks only) | !300 |
| P088 | Select exactly all of one block's code text (an ordinary selection, not the block), then press Enter. | The spec does not state what happens. | — | both | same (fc 22: the code is removed and the block keeps one empty code line, the caret on it) | Mason's pick: Enter removes the code and leaves the block with one empty line |
| P089 | Press Enter in code and watch the caret. | The caret is on the new line in the same frame. It is never drawn a line high for a frame against the closing fence. | ed 324-330 | both | unknown | !300 |
| P090 | On a code line, press Mod-Enter. | A blank line opens BELOW the current line and the caret moves there. The indentation comes from the language's indent service, and no list or quote marker is added. | ed 308-315 | hardware keyboard | unknown | !300 |
| P091 | On a code line, press Mod-Shift-Enter. | A blank line opens ABOVE the current line and the caret moves there, with the same indent rule. | ed 308-315 | hardware keyboard | unknown | !300 |
