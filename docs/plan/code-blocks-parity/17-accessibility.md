# 17. Accessibility

| ID | Do | !300 result | Ref | Applies | Engine today | Target |
| --- | --- | --- | --- | --- | --- | --- |
| P317 | With a screen reader, read a code block. | Known gap: the reader announces the three-backtick fence markers, which an earlier rendering left out. | cb 524-527 | both | unknown | ask Mason |
| P318 | Switch the app to another language and look at a block's chrome. | Known gap: the header placeholders, the copy chip's title, the "add a line above/below" labels, the highlight and lowlight buttons, and the code toolbar's accessibility label stay in English. | l10n 74-81 | both | unknown | ask Mason |
| P319 | Switch the app language and copy with the chip. | The toast is translated. | l10n 79-81 | both | unknown | !300 |
| P320 | In light theme, read syntax-coloured code, with and without a selection over it. | Known gap: the weakest token colour falls from 2.62:1 to 2.13:1 when selected. None of the token colours meets WCAG AA. The dark theme slightly improves (keyword 3.63:1 to 3.72:1). | cb 255-260 | both | unknown | ask Mason |
