# 14. Undo and redo

!300's spec states nothing else about undo in code blocks. The engine states that each code-block command, and each action on a selected block, is one Undo step that restores the exact bytes and the selection (fc 19, 24-25, 29).

| ID | Do | !300 result | Ref | Applies | Engine today | Target |
| --- | --- | --- | --- | --- | --- | --- |
| P308 | In a marked block, add a line (so that a mark moves), then Undo once. | The text change and the mark change are undone together: one undo step, and one document change for sync. Per the spec; confirm on the !300 build. | cb 226-229 | both | differs: there is no mark remap to undo (fc 9) | Mason's pick: line marks follow their lines |
| P309 | Do an undo (or a paste) whose result would leave the caret on a fence line. | The caret is moved into the block afterwards. It never sits invisible on a fence, where the next key would be refused. | cb 499-506; cb 726-731 | both | unknown | !300 |
