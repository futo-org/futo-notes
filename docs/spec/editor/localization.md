## Localization

- The editor receives the host's effective language during initialization and
  whenever it changes. It reconfigures FUTO-authored labels and accessibility
  text without reloading the note or changing its content. →
  [localization.md](../localization.md)
- Editor UI text resolves through the shared language catalog. The toolbar
  manifest carries semantic localization paths instead of English labels, and
  generated Swift and Kotlin toolbar specifications carry those paths without
  changing command identity, order, visibility, icons, or behavior. →
  [localization.md](../localization.md), packages/editor/src/toolbar.ts,
  scripts/gen-toolbar-spec.ts
