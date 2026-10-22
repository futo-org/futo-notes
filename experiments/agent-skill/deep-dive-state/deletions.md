## 6. To delete

- **Page**
  - `state().snapshot` (`agentInspector.ts:476`)
  - the `editor` block and `selected` in receipts (`:176`, `:209`)
  - `docHead` and `docLength` (`:155-156`)
  - `settingsOpen`/`searchOpen` from the shell provider (`NotesShell.svelte:334-335`), replaced by
    `overlay`
- **CLI**
  - `step`'s note-load loop (`main.rs:1578-1597`)
  - `render_diff`'s element sections from the default output (they stay for `diff`)
  - `pretty(receipts)` for `do` (`:1524`)
- **iOS/Android**
  - the page-`state` merge that leaks `snapshot` (`AgentActionServer.swift:582-588`, and the
    Kotlin equivalent at `.kt:598-602`)
  - `sheet` (moves into `overlay`)
  - the `{ok, verb, …}` receipt extras, which become diff paths
- **jev-drive**
  - `slimReceipt`, `describeChanges` + `RECEIPT_PLUMBING` (the account prints the CLI's lines)
  - `computed.overlay` (replaced by `app.overlay`)
  - the hand-built `visits` key (replaced by the state id)
  - `app.components`
  - the per-question `stepRule` copies
  - fan-out over subjects that are not named
- **Docs**: the `state` row in commands.md:11, the "Receipts" section (commands.md:216-225), and
  SKILL.md's "The loop" `state` comment.

---
