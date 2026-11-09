# Local change to pulldown-cmark 0.13.6

Upstream source is unmodified except in `src/firstpass.rs`, `parse_paragraph`:
a line that is only a list marker (`-`, `*`, `+`, `1.`, `1)`, trailing spaces
allowed), indented as a child of the list item whose paragraph it follows,
ends that paragraph as an empty nested item. CommonMark reads such a `-` as a
setext underline (and `1.` as paragraph text). Editors built on CodeMirror 6
(Lezer) and Obsidian read an empty nested item, and Indent on an empty list
item writes exactly that shape. See docs/spec/editor/portable-core/list-indent.md.
Outside list items (`Foo\n-`) nothing changes.
