# 16. Soft keyboard, autocorrect and IME

| ID | Do | !300 result | Ref | Applies | Engine today | Target |
| --- | --- | --- | --- | --- | --- | --- |
| P312 | On a phone, put the caret on a code line and type a word that autocorrect would change, at the start of a line. | Nothing is autocorrected or auto-capitalised. On Android the keyboard re-reads this on every selection change. iOS: the host applies it to the live keyboard. | cb 996-1004; ed 846-851 | touch | unknown | !300 |
| P313 | Move the caret from code to prose. | Autocorrect and sentence capitalisation come back at once. | cb 997-998 | touch | unknown | !300 |
| P314 | With an Android keyboard, delete (or compose over) a selection that crosses a block's boundary. | The whole block is taken, as with the hardware key. The extent comes from the selection, not from the keyboard's own edit. | cb 194-198 | touch | same (ii 20: composition and text-service runs take the block whole) | !300 |
| P315 | Compose text (for example with a Japanese or Chinese keyboard, or with suggestions) on the first or last code line, next to a fence. | The composition is never corrupted: no caret correction runs while it is live. | cb 503-505; cb 729-730 | touch | unknown | !300 |
| P316 | Use the keyboard (IME) in a way that would damage a fence line. | It is suppressed, as a key would be. | cb 715-716 | touch | unknown | !300 |
