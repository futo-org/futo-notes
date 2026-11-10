# Engine refusals (next steps, 2026-11-09)

From section 2 of [../next-steps-2026-11-09.md](../next-steps-2026-11-09.md). The open refusals the iOS random input suite found are GitLab issues under the label `ios-text-first`: https://gitlab.futo.org/futo-notes/futo-notes/-/issues?label_name[]=ios-text-first. Each is a named known-issue row in `apps/ios/Tests/Editor/TextFirstRandomInputTests.swift` (`RandomInputRows`), which turns red once the engine fixes it.

- [x] A selection crossing into or out of a code block was always refused: fixed by !634 (`inline/edit/frames.rs`, `session/checked_input.rs`). A cut that keeps one end of a fence's frame gets the other back, accepted only when the whole input's display is exactly the replaced one and every other line keeps its block.
- Rule for the open list half (a selection from a heading or paragraph into a list): a respelling of the lines after the joined text must not change untouched lines, and must respell only item lines, each against its parent, and pass the block check. It must not:
  - turn indented code after the joined text into prose (`para\n\n    a\n    b\n`, `[4,7)`, type `d`);
  - turn an item's continuation paragraph after a blank line into indented code (`para\n\n- p\n    - c\n\n      cp\n`, `[2,7)`, type `x`);
  - take children out of items the selection never touched (`para\n\n- p\n    - c\n- i\n  ```\n  k\n  ```\n`, `[2,7)`, type `x`).
- Awaiting Justin's call: Backspace at a heading's start right after a closing fence joins it onto the code line as code, so a link's destination leaves the source (pinned in `tests/blocks/heading_join.rs`). Keep, refuse joining a link, or move the caret without joining.
