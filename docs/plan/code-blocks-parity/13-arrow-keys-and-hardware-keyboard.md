# 13. Arrow keys and hardware keyboard

The Mod-Shift-K, Alt-Arrow, Ctrl-T and modified-delete rows are in section 5. The Shift-arrow wall is in section 7. Field keys are in section 8.

| ID | Do | !300 result | Ref | Applies | Engine today | Target |
| --- | --- | --- | --- | --- | --- | --- |
| P297 | On the line above a block, press ArrowDown. | The caret goes into the first code line, never onto the header. | cb 916-919 | hardware keyboard | host's job (fc 30) | !300 |
| P298 | On the first code line of a block with a line above it, press ArrowUp. | The caret leaves the block to the line above, the way it came. | cb 916-918 | hardware keyboard | host's job (fc 30) | !300 |
| P299 | On the line below a block, press ArrowUp. | The caret goes into the last code line. | cb 916-919 | hardware keyboard | host's job (fc 30) | !300 |
| P300 | On the last code line of a block with a line below it, press ArrowDown. | The caret leaves the block to the line below. | cb 916-918 | hardware keyboard | host's job (fc 30) | !300 |
| P301 | Around and inside blocks, press Home, End, PageUp, PageDown, Mod-Home, Mod-End and their Shift variants. | The caret, or the moving end of the selection, never lands on a fence line. | cb 919-928 | hardware keyboard | host's job (fc 30) | !300 |
| P302 | With two blocks touching, press ArrowDown on the upper block's last code line (and ArrowUp on the lower block's first). | The caret passes into the other block's code. It never stops on either hidden fence between them. | cb 929-935 | hardware keyboard | host's job (fc 30) | !300 |
| P303 | In a note that opens with a block, press ArrowUp on its first code line. | The caret stays in the code. It never goes onto the fence. | cb 936-939 | hardware keyboard | host's job (fc 30) | !300 |
| P304 | In a note that opens with a block, press Mod-Home. | The caret goes to the first code line. | cb 936-939 | hardware keyboard | host's job (fc 30) | !300 |
| P305 | In a note that ends with a block, press Mod-End. | The caret goes to the last code line. | cb 936-939 | hardware keyboard | host's job (fc 30) | !300 |
| P306 | In a note that ENDS with a block, press ArrowDown on the last code line. | A paragraph opens below the block and the caret moves there. | cb 940-942 | hardware keyboard | host's job (fc 30 names this rule) | Mason's pick: a trailing block is left by ArrowDown or the "add a line below" target |
| P307 | In a note that STARTS with a block, press ArrowUp on its first code line. | Nothing opens above it. The "add a line above" label covers that edge. | cb 943-945 | hardware keyboard | host's job (fc 30) | !300 |
