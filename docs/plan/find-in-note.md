# Find in note — implementation decisions

The native-bar decision was made on 2026-08-25: iOS and Android use SwiftUI/Compose
find chrome; the shared editor owns matching, navigation, and reveal behavior.
The implementation is present in `src/features/editor/find/`, with the version-8
find messages documented in `packages/editor/src/bridge.ts`. Current behavior lives
in the “Find in note” section of `docs/spec/editor.md` and the shortcuts in
`docs/spec/tabs.md`.

## Constraints worth retaining

- Native bars project editor state; they do not implement a second search engine.
- The native bar can hold keyboard focus while the editor reveals a match. Ordinary
  cursor decorations must not reveal hidden Markdown just because a WebView lost focus.
- Find state dies with the note identity, including note switches and screen teardown.
- Keep the native bridge consumers in lockstep; a contract change requires both hosts.
- Deduplicate CodeMirror dependencies after changes: two instances can blank the editor.
- Desktop shortcut handling must account for the find input owning focus.

## Question retained from the original plan

A match inside a widget-replaced region (notably an interactive table) can lose its
selection when the widget takes focus. Verify that behavior in the real editor before
claiming complete coverage. If it diverges from the spec, record a verified Gap;
do not silently relax the intended reveal behavior.


## Original plan and evidence

```bash
git show 3b1c43c139181b91b7384b478b5edec454b80190:docs/plan/find-in-note.md
```
