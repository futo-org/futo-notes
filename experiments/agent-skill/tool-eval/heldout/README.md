# Held-out set for `just puppet`

28 goals written the way people write them, on a vault of 497 notes. Changes to how agents drive
the app are **judged** on this set. They are never **tuned** on it.
The `workflows` set is the one to tune on.

```bash
node heldout/generate.mjs                                  # (re)write vault/ and print its stats
node heldout/tasks.mjs                                     # list the goals
node heldout/check.mjs [--only id,id]                      # prove the set against the running app
node run.mjs --set heldout --label <name>                  # score it: a real session per goal
```

`check.mjs` resets the app to the vault for each goal. It then checks two things: the verifier
fails on the untouched vault, and the reference steps (driven as the harness, no Jev) make the
verifier pass. At the end it puts the `workflows` fixture back.

## The rule

1. Never change the controller to fix one held-out task.
2. Read held-out failures only to classify them: an **app bug**, a **verb gap**, or a
   **generic request-shape problem** (a class of goal wording that also occurs outside this set).
   A fix for a generic problem is proved on `workflows` or on new tuning goals, never here.
3. Report only the aggregate scores when you make a decision (passed/28, cost, time).
4. The goals, the vault, the verifiers and the references are frozen once the first baseline is
   recorded in `runs/`. After that, the only permitted change is to remove a goal that the app
   can no longer do (a removed verb). Record the removal here, with the date.

A goal here is a person's request, so it is scored the way a person's request is handled: a
Claude Code session gets it and drives the app (`../README.md`). The Jev-alone runs of 2026-09-28
(`heldout-base-*`, `heldout-search-*`) fed these words straight to Jev, which no real run does;
they are not baselines.

## What is here

| file | |
|---|---|
| `generate.mjs` | deterministic vault (seed `20260925`, no clock). `FIXED` (`generate/fixed-notes.mjs`) holds the notes that goals are about and their near neighbours. The bulk is generated. |
| `tasks.mjs` | `{id, prompt, families, names, verify, reference}`. `names` is `direct` (exact id or title), `loose` (a near title), `indirect` (a description) or `collective` (a group). The goals are in `tasks/*-tasks.mjs`, the checks in `tasks/vault-checks.mjs`; `tasks.mjs` puts the goals in their order. |
| `check.mjs` | runs the reference steps and the untouched-vault check |
| `vault/` | written by `generate.mjs` (and on importing `tasks.mjs`), so it is gitignored. `reset.mjs` copies it into the app for each task. |

Each verifier diffs the **whole** vault against the generated original. Only the notes that
the goal is about may change, appear or disappear. Thus an edit to the wrong note and a no-op
both fail. `reset(fixture)` also closes every open folder, so each task starts with the same
sidebar rows.

Relative dates are anchored in the vault, not in the clock: "most recent journal entry" is
`journal/2026/2026-09-24`. A standup from the same day is a distractor.

## Found while building (2026-09-25)

- **Folder verbs saw only the folders that the tree draws.** `ToggleFolder`,
  `ShowFolderContextMenu`, `RenameFolder`, `MoveFolder` and the `folderPath` of `MoveNote` refused
  `400 no such folder` for a folder inside a collapsed parent. Fixed 2026-09-25: they take any
  folder in the vault; a toggle or a context menu first opens the row's parents.
- **`SetSearchQuery` answered before the results arrived**, so `OpenSearchResult {index}` opened a
  note from the empty-query list. Fixed 2026-09-25: it answers once the new results are shown.
- **`MoveNote` and `MoveFolder` answered before the move landed**, so a `RenameNote` on the moved id
  refused `400 no such note`. Fixed 2026-09-25: they answer once the note list has the move.
  (The references paused 1 s or opened parent folders to get past these three; those steps are
  gone.)
- `DeleteFolder` moves the notes in the folder up to its parent (as `docs/spec/list.md`
  specifies). Thus "delete the folder and everything in it" is not one verb.
  `delete-tax-2024` asks for the notes to be deleted instead.

## Maintenance after the Milkdown editor (2026-10-05)

No goal changed. The editor became Milkdown/ProseMirror, so:

- **Verifiers compare non-blank lines.** The editor re-spells a note on its first real edit
  (ADR-0002, normalize-once): a blank line appears between a paragraph and the list under it.
  Byte-exact comparisons failed every correct edit; `same`, `changes` and `linesAdded` now
  compare a note's non-blank lines.
- **References follow the new verbs.** Line numbers are the editor's lines (`doc`), not the
  markdown's (`ToggleTask`, `InsertLine`); `PlaceCaret` takes an editor position; `Heading` is
  `Heading2`; `DeleteNote` takes `answer: confirm` (it stops at the dialog otherwise); the
  broken checkbox (a lazy continuation, shown on the item's line) is split with `Press Enter`.
- `check.mjs` reaches rows inside closed folders by running the batch a 409 names, as an agent does.

## The `editor` set (2026-10-05)

`editor-tasks.mjs`: 17 more goals on the same vault, about what the Milkdown editor added —
table cells and rows, code blocks, ordered and task lists, indenting, moving a block, a
divider, a link, a wikilink suggestion — plus a delete through its dialog. Same rules: judged
on, never tuned on; frozen from its first baseline (`runs/editor-s55m-v1-*`).

```bash
node heldout/check.mjs --set editor
node run.mjs --set editor --label <name> --model sonnet --effort medium
```

Proving its references found one tool bug (fixed 2026-10-05): `Press ArrowRight` over a
selection moved the caret one past its end — out of a list item, a code block or a table
cell — where a browser collapses the selection to its end.
