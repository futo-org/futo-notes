# Table editing — one model on every platform

Design: Figma "FUTO Notes – Mobile App (WIP)", section **Table edit** (node `1588-3757`).
Frames: `Table / Cell Selected` (1588:4108), `Table / Row actions` (1588:3886),
`Table / Table actions` (1588:3979), `Table / Drag` (1588:3758) — each in dark and light.

Decided with Justin, 2026-09-15. This plan is the contract the implementation lanes build
against; where it and a lane's judgement disagree, this document wins or gets amended first.

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
`destructive` items render in the error colour. A disabled item is SHOWN disabled, never
hidden — the design greys "Move up" on the first body row rather than dropping it.

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

## 4. Where the code goes

- **Verbs** — `src/features/editor/milkdown/table/tableCommands.ts`. One command per menu id,
  plus the predicate that answers "is this id disabled for this selection". Pure, unit-tested,
  no DOM.
- **Manifest** — `packages/editor/src/tableActions.ts`, the single source of truth for the
  three menus: ids, labels, grouping, order, destructive flag, and per-platform icon names
  (lucide / SF Symbol / Material), exactly as `toolbar.ts` does for the formatting toolbar.
  Native specs are GENERATED from it; never hand-edit a generated spec.
- **Selection + overlay** — a new module under `table/`: selection state, the outline, both
  grips, the edge `+` affordances, the `…` button, drag-to-reorder and its drop indicator.
- **Menu presentation** — desktop popover in the editor; mobile sheets rendered natively by
  each shell from the generated spec.
- Behavior NEVER lives in a shell. A shell renders the manifest and dispatches the id back.

## 5. Bridge

A new outbound message when a grip or the `…` button is tapped:

    { type: 'tableMenu', kind: 'row' | 'column' | 'table', disabled: string[], headerRow: boolean }

`disabled` carries the manifest ids that are inert for the current selection, computed by the
editor — the shells never re-derive table rules. The shell renders the matching sheet and
dispatches the chosen id through the existing `exec(id)` path.

Additive, and a host without a case for it simply shows no sheet — exactly today's behavior,
which is no mobile table editing at all. That is the same reasoning `bridge.ts` records for
`formatState`, `haptic`, `blockDrag` and `blockPress`, all of which shipped unversioned.
**No `BRIDGE_VERSION` bump.** Both native hosts must land it in the same commit (M10).

## 6. Lanes

- **T1 — verbs.** Every command in §2 plus the disabled predicate, in `tableCommands.ts`, with
  markdown round-trip tests including header-row-off and reordering. No UI. Everything else
  depends on this, so it lands first.
- **T2 — selection and overlay.** The §1 interaction in the shared editor, the desktop popover,
  and the removal of the hover-grip UI.
- **T3 — manifest, bridge and native sheets.** `tableActions.ts`, its generator and check
  recipe, the `tableMenu` message, and the SwiftUI + Compose sheets.

T2 and T3 both consume T1's ids, and T3's manifest is what T2's popover renders, so the ids in
§2 are fixed by this document rather than negotiated between lanes.

## 7. Out of scope

Column alignment picker; cell merge; CSV import/export; formulas; multi-cell range selection
(the design shows a `range-handle`, but no frame specifies its behavior — ask before building
it). Full Obsidian Advanced Tables parity remains a deliberate product decision, not a gap.
