# Code blocks

How a block's header fields take typed text, and how a hold selects a block. The block's drawing is in [fenced code](../portable-core/fenced-code.md).

- *(Android)* A block's name and language fields write the fence on every keystroke, with the keyboard's capitals and suggestions, and keep of typed text what `typed_code_block_name` / `typed_code_block_language` keep (no rule of the host's); the name is written trimmed. A picked suggestion and the keyboard's space after it write `Python`: the field holds the trailing space while open and the fence gets the word. → apps/android/app/src/main/java/com/futo/notes/textfirst/CodeHeaderField.kt, `TextFirstCodeHeaderKeyboardTest`
- *(Android)* A hold on a block's header, or a hold inside a block already selected as one object, selects the block and shows Cut, Copy and Paste over it, with no selection handles; a tap on the header selects it with no menu. The menu follows the block as the note scrolls and hides while the block is off screen. → apps/android/app/src/main/java/com/futo/notes/textfirst/CodeBlockCallout.kt, `TextFirstCodeBlockCalloutTest`
