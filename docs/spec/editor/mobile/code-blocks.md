# Code blocks

How a block's header fields take typed text. The block's drawing is in [fenced code](../portable-core/fenced-code.md).

- *(Android)* A block's name and language fields write the fence on every keystroke, with the keyboard's capitals and suggestions, and keep of typed text what `typed_code_block_name` / `typed_code_block_language` keep (no rule of the host's); the name is written trimmed. → apps/android/app/src/main/java/com/futo/notes/textfirst/CodeHeaderField.kt, `TextFirstCodeHeaderKeyboardTest`
  > **Gap:** *(Android)* A picked suggestion in the language field writes `Python-`: the keyboard adds a space after the word and the engine writes a trailing space as `-`.
