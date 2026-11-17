# 18. Performance promises

| ID | Do | !300 result | Ref | Applies | Engine today | Target |
| --- | --- | --- | --- | --- | --- | --- |
| P321 | Type in a long block. | Nothing extra runs per keystroke for the line-number column. Its width is set while the block is drawn. | cb 332-334 | both | unknown | !300 |
| P322 | Type in code. | Plain typing never pays a layout flush. Only an edit that adds or removes a line does. | ed 324-330 | both | unknown | !300 |
| P323 | Fling-scroll past touching blocks. | Momentum scrolling does not jerk: the gap between blocks is height on the closing row, not a margin. | cb 825-829 | both | unknown | !300 |
| P324 | Scroll through a note with many blocks. | The scroll position does not jump. The card wrapper adds no height, so the measured line heights stay exact. | cb 476-480 | both | unknown | !300 |
| P325 | Paste thousands of lines that hold fenced code. | The cost is flat, the same as plain lines. | ed 1273-1276 | both | same (clip 21: paste work is proportional to the pasted text and the lines it lands on) | !300 |
