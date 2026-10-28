## 3. The lean per-turn payloads

### 3.1 Claude: the action result as text

**Grammar**

```text
<Verb> → <status>[ <error>] · <screen>[ › <top overlay>][ · focus <x>][ · caret L<l>:<c> | sel L<l>:<c>-L<l>:<c> "<text>"] @<after-id>
  <changed lines, one per line:  L<n> <offset>│<text as it now reads>>
  <scalar paths on one line:     path a→b · path a→b>
  <overlay/verbs:                overlay +role "name" (items) · verbs +A +B … −N>
  <vault:                        folders −x +y · notes −a +b>
  late (after previous result): <same grammar>
  no change
```

**Rules**

- The header is always printed and stays under 100 B. The scalar paths drop the `editor.`
  prefix (`find.total`).
- Only what changed follows the header. By default that is at most 4 lines and about 400 B.
- **More detail is printed only in these cases:**
  1. A document opens or is replaced (`screen` changes to an editor, or every line changed). All
     lines are printed, up to 12, then `… +N lines (doc)`.
  2. Otherwise at most 6 changed lines are printed, and deleted lines show as
     `−L5-L6 (now 4 lines)`.
  3. When the document changed, the doc block starts with `doc v<docVersion> · N lines`, so the
     offsets shown carry their proof (rule 6).
  4. A refusal with 404 appends `here: <verb names on this screen>`, at most 20.
  5. Verbs: added names are listed up to 8. Removed verbs are given as a count. When the screen
     itself changes, only the counts are given.
- **Never printed by default:** element rows, rect changes, event counts, action and snapshot ids,
  the `editor` block, and args (Claude sent them; in a batch, each step is `[2/3] Press → 200 …`).
- Hard cap 1.5 KB, then `… (--json)`. `--json` returns the structured `ActionResult`
  `{v, verb, args, status, error?, before, after, changed:{path:[a,b]}, lines, late?, page}`.
  `page` is the raw page record, for harnesses.

**Worked examples.** Each one comes from a real recorded action. The "today" figure is that
receipt's pretty size, and the "lean" figure is the text below.

1. **OpenNote**. Recorded 1790280951098, from `editor:welcome`. Today it is 782 B, and the
   document arrived *after* the receipt (F2); the lean result depends on settle, C3.
   ```text
   OpenNote → 200 · editor:grocery list · caret L1:1 @a41c09e2
     note welcome→grocery list · tabs [welcome]→[grocery list]
     doc v3960651562 · 5 lines
     L1  0│- milk
     L2  7│- eggs
     L3 14│- bread
     L4 22│- [ ] coffee
     L5 35│
   ```
   244 B, and it replaces `do && doc`.
2. **Type with list continuation**. Transcript `01-undo/16-53-19`. Today the receipt was piped to
   `tail -20` and showed only selection JSON, so Claude ran `doc` to see the text.
   ```text
   Type → 200 · editor:new · focus editor · caret L3:17 @5c0e7a13
     doc v3699572111 · 3 lines
     L1  0│1. first step
     L2 14│2. 2. second step
     L3 32│3. 3. third step
   ```
   The doubled markers, which were the bug, are in the result itself.
3. **Toolbar block change: BulletList on `- [ ] coffee`**. Recorded 1790267191985, today 2,659 B
   of element churn. This is bug 02; Claude ran `doc` twice to see it.
   ```text
   BulletList → 200 · editor:grocery list · focus editor · caret L4:7 @0b9d44f1
     doc v… · 5 lines
     L4 22│[ ] coffee
   ```
4. **Open a dropdown: ToggleLanguageOptions**. The recorded close is 4,184 B (4 option rows, and 4
   flag and rect changes). The open, which is the inverse:
   ```text
   ToggleLanguageOptions → 200 · home › listbox "Language" · focus button "System" @77e2c0a9
     overlay +listbox "Language" (System · English · 简体中文) · verbs +SetLanguage
   ```
   The close, which Jev skipped and Claude needed `elements | tail` and `find "System"` to check:
   `ToggleLanguageOptions → 200 · home › dialog "Settings" · focus none @…` followed by
   `overlay −listbox "Language"`.
5. **Find query: SetFindQuery `""` after `fox`**. Drive `2026-09-24T18-48-31`. **Today it says
   `no change`**, and Claude ran `state` after 8 of its 9 find verbs.
   ```text
   SetFindQuery → 200 · editor:welcome · focus find · caret L3:17 @19a0f3d2
     find.query "fox"→"" · find.total 1→0 · find.current 1→0 · selection "fox"→none
   ```
6. **Rename a folder: RenameFolder `work` → `a/b`**. Bug 08, today **6,029 B**: 6 rows added, 3
   removed, 3 rect changes.
   ```text
   RenameFolder → 200 · home @c3d1e905
     folders −work +a +a/b · notes −work/q3 plan −work/standup +a/b/q3 plan +a/b/standup
   ```
   The bug, a slash making a nested folder, shows in one line.
7. **Phone GoBack (iOS)**. Today it is 95 B, `{"ok":true,"verb":"GoBack"}`, and says nothing.
   ```text
   GoBack → 200 · list @8e61b2c4
     screen editor:work/standup→list · note work/standup→null · verbs 14 (+13 −31)
   ```
8. **OpenSettings (desktop)**. Today 4,894 B: 11 element rows. Claude followed it with `actions`.
   ```text
   OpenSettings → 200 · home › dialog "Settings" · focus button "Close settings" @2f5a9e07
     overlay +dialog "Settings" · verbs +CloseSettings +SetTheme +ToggleLanguageOptions +SetNotesDirectory +ConnectSync +SyncNow +ToggleIssueReporting +TestCrash (+6) −23
   ```

The ids and a few `docVersion`s in these examples are placeholders. The lines are what the
recorded diffs contain. **Budget:** median ≈ 104 B (≈ 27 tokens), p90 ≈ 144 B. That was estimated
over the 9,049 recorded receipts, against a median of 571 B and a p90 of 2,090 B today. It is about
8× less over all verbs and about 11× less for editor verbs. The drive account (`describeChanges`)
prints the same lines.

### 3.2 Jev: one step's state

What Jev needs to choose one step:

- **the task**, and **the history**, as short strings;
- **`app`**, the lean AppState:
  - screen, overlay, focus, note, tabs;
  - editor as `caret`, `selection` only when there is one, `find` only while it is open,
    `clipboard` only when it is set;
  - `lines`, and the vault;
  - nothing that is false, empty, derivable or duplicated;
- **`last`**, the same `ActionResult.changed` Claude gets, as structured dotted paths. For the
  find example: `{"editor.find.query":["fox",""],"editor.find.total":["1","0"]}`. Today Jev's
  `slimReceipt` says nothing there;
- **`computed`**: caret facts, `pasteHere`, spans, counts;
- **`rules.argument`**, sent once.

Changes to the questions. Each was validated offline against every recorded move:

| cut | rule | saves |
|---|---|---|
| **Q1** | `stepRule` goes once into `state.rules.argument`. Each argument question becomes one line: "If the next verb takes `x`, which value does `task` call for now? `rules.argument` applies." | ~40% of the request |
| **Q2** | Premise fan-out (`arg:x@subject`) only over subjects the task names: a span, a note or folder whose last segment is a span, or the note on screen. It is no longer made for every note in the vault. **`fillArguments` then falls back to the plain `arg:x` when no premise question was asked** (today it would read `undefined` and hand back `no-value`). | most of the 27.6 premise questions per turn |
| **Q3** | Drop an integer argument whose candidates are all non-numeric (`x`, `y`, `width` get task spans today, and `fillArguments` drops them as NaN anyway) | ~1k chars |
| **Q4** | `answer` options are the leaves of the lean `app`/`last`/`computed` (no `components`, `docHead`, `settingsOpen`, `sidebar` when unchanged) | ~⅓ of `answer` |

Measured on 317 recorded turns (rebuilt, prototype `lean.mjs`):

| sweep | turns | tokens/turn now → lean (median) | total tokens |
|---|---|---|---|
| jev-desktop-final | 96 | 12,239 → 6,202 | 1.08M → 0.53M (−51%) |
| jev-ios-final | 109 | 9,120 → 4,943 | 0.84M → 0.45M (−46%) |
| jev-workflows-merged-5 | 100 | 12,143 → 5,947 | 1.12M → 0.55M (−51%) |
| drive 09-24 | 12 | 11,298 → 5,282 | −51% |
| **all** | 317 | **9,775 → 5,204** (p90 13,369 → 6,722) | |

Two checks back this up:

- **Safety check.** For each of the 323 argument answers that recorded successful moves actually
  used, the lean request still offers the same question key with the same chosen value, or the
  plain fallback from Q2. Two cases needed that fallback:
  - `tidy-work`, `title@work/q3 plan`: it was a wrong move, since the task renames `standup`, and
    the plain `arg:title` still offers `daily`.
  - The one answer path lost is `app.settingsOpen`, which was the wrong answer to the dropdown
    task. `app.overlay` replaces it.
- **Target budget.** The lean request is at most 6.5k tokens median and 8k at p90. What remains is
  `next` 29%, argument questions 51%, `answer` 8% and state 7%.
- **Next lever (option, not the default): two stages.** Stage 1 asks `next`/`actionsDone`/`answer`
  (2.3k tokens). Stage 2 asks only the chosen verb's argument questions (0.7k), on the 207 of 317
  turns that take arguments. That is **2.8k tokens/turn (−71%)**, at the price of one more
  TypeSafe call (~200–250 ms) on 65% of turns. Take it only if tokens, rather than latency, turn
  out to be what limits Jev after Q1–Q4.
- **The `step` payload itself** drops from 11 KB to about 3 KB. The observation is AppState plus
  visible elements (sibling b), and verb schemas are fetched only when a verb name is new
  (jev-drive caches them per run). This saves process I/O and trace size, not Jev tokens: the
  schemas are never sent to TypeSafe raw.

---
