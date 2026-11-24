# Table editing — one model on every platform

Design: Figma "FUTO Notes – Mobile App (WIP)", section **Table edit** (node `1588-3757`).
Frames: `Table / Cell Selected` (1588:4108), `Table / Row actions` (1588:3886),
`Table / Table actions` (1588:3979), `Table / Drag` (1588:3758) — each in dark and light.

> Superseded in part (2026-11): the Milkdown implementation this plan named was removed; tables are
> now engine-backed (`crates/futo-notes-editor`, `src/features/editor/desktop/editorTables.ts`). See §4.

Decided with Justin, 2026-09-15. This plan is the contract the implementation lanes build
against; where it and a lane's judgment disagree, this document wins or gets amended first.

## 1. The model

Selection drives everything, identically on desktop and mobile:

1. Tap (or click) a cell → that cell is **selected**: an accent outline around it, a six-dot
   **row grip** at the left edge of its row, a six-dot **column grip** above its column.
2. Tapping a grip opens that grip's action menu — **row actions** or **column actions**.
3. A `…` button at the table's top-right opens **table actions**.
4. `+` affordances on the table's bottom and right edges append a row / a column.
5. Dragging a grip reorders that row or column, with a drop indicator showing the target.

Presentation is the ONLY platform difference:

- **Mobile** (iOS, Android): a native bottom sheet, titled, with a grab handle.
- **Desktop**: a popover anchored to the grip. Same items, same order, same disabled states.

This RETIRES the hover-grip + three-item-menu UI added on 2026-09-11 (`tableGrips.ts`,
`tableGripsGeometry.ts`). Hover is not a model touch can share, and running two table
interactions in one codebase is the drift `check-drift` exists to prevent. Remove it rather
than leaving it beside the new one.

## 2. The three menus

Item order and grouping are from the design; groups render as separated cards.
`destructive` items render in the error color. A disabled item is SHOWN disabled, never
hidden — the design grays "Move up" on the first body row rather than dropping it.

### Row actions — title "Table row actions"

| group | id | label | disabled when |
|---|---|---|---|
| 1 | `table.row.header` | Header row | never (it is a toggle; see §3) |
| 2 | `table.row.addAbove` | Add above | selection is the header row |
| 2 | `table.row.addBelow` | Add below | never |
| 2 | `table.row.moveUp` | Move up | first body row, or the header row |
| 2 | `table.row.moveDown` | Move down | last row, or the header row |
| 3 | `table.row.duplicate` | Duplicate | selection is the header row |
| 3 | `table.row.clear` | Clear contents | never |
| 3 | `table.row.delete` | Delete row (destructive) | header row, or the only body row |

### Column actions — title "Table column actions"

| group | id | label | disabled when |
|---|---|---|---|
| 2 | `table.col.addLeft` | Add to left | never |
| 2 | `table.col.addRight` | Add to right | never |
| 2 | `table.col.moveLeft` | Move to left | first column |
| 2 | `table.col.moveRight` | Move to right | last column |
| 3 | `table.col.duplicate` | Duplicate | never |
| 3 | `table.col.clear` | Clear contents | never |
| 3 | `table.col.delete` | Delete column (destructive) | only column |

The design's **Header column** toggle is NOT built — see §3.

### Table actions — title "Table actions"

| group | id | label | disabled when |
|---|---|---|---|
| 1 | `table.header` | Header row | never (toggle) |
| 2 | `table.addRow` | Add row | never |
| 2 | `table.addColumn` | Add column | never |
| 3 | `table.duplicate` | Duplicate | never |
| 3 | `table.clear` | Clear contents | never |
| 3 | `table.delete` | Delete table (destructive) | never |

## 3. Markdown fidelity — the hard constraint

The note on disk is GFM. The design has two toggles; the format supports one.

- **Header row ON** (the default): an ordinary GFM table — header row plus the `|---|`
  delimiter.
- **Header row OFF**: written as an EMPTY header row plus the delimiter, because a GFM table
  without a delimiter row is not a table. Every cell the user typed is preserved; the table
  simply gains a blank first row when read anywhere else. This is the agreed cost.
- **Header column is NOT BUILT.** GFM has no header-column concept, so the toggle could not
  round-trip: it would be lost on the next save, or need a sidecar that makes the note
  non-portable. Justin's call, 2026-09-15: drop it. Do not add it to the manifest, and record
  it in `docs/spec/editor.md` as a deliberate omission, not a gap to close later.

Every mutation round-trips: save → reopen → save is byte-identical, column alignment included.

## 4. Status (2026-11)

The implementation this plan first described — verbs in the Milkdown editor, a
`packages/editor/src/tableActions.ts` manifest, a `tableMenu` bridge message and the T1–T3 lanes
— went with Milkdown and the mobile web editor. Tables are now engine-backed
(`crates/futo-notes-editor`): desktop draws hover grips (`src/features/editor/desktop/tableGrips.ts`,
docs/spec/editor/desktop/tables.md), Android opens native popup menus at its grips
(docs/spec/editor/mobile/tables.md), and the iOS editor has no row or column menus yet. §1–3 stay
the decided model and menu contents; any new table command belongs in the engine, reached from
each shell's editor session.

## 7. Out of scope

Column alignment picker; cell merge; CSV import/export; formulas; multi-cell range selection
(the design shows a `range-handle`, but no frame specifies its behavior — ask before building
it). Full Obsidian Advanced Tables parity remains a deliberate product decision, not a gap.
