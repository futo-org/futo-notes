## 3. What the agent would see (real interactions; text lines in the audit C1 style)

These lines are illustrative, but every field comes from something the page or shell already has.
The "today" lines are measured.

1. **OpenSettings** (desktop)
   - today: 13 `+` rows, and `+ "Reset to default"` turns up late on the *next* receipt. Nothing had
     focus.
   - with this:
     ```
     #38 OpenSettings → 200 · ui.overlays +dialog "Settings" modal top · focus none (window unfocused)
       busy "Storage" settled 180ms · covered: sidebar, editor (24 rows) by e33
     ```
     "focus none" is now an explicit finding: the dialog does not take focus.
2. **ToggleLanguageOptions ×2**, the drive that Jev got wrong
   - Open:
     ```
     ui.overlays +listbox "Language" owner e40 top · focus option "System" (selected) · e40 collapsed→expanded
     ```
   - Close:
     ```
     ui.overlays -listbox "Language" · focus → button "System" · e40 expanded→collapsed
     ```
   - Jev's "is the dropdown open?" becomes `ui.top.role == "listbox"`, not `settingsOpen`.
3. **SetFindQuery `""`**, which is audit F2's "no change"
   ```
   editor.find.query "the"→"" total 3→0 · focus text "Find in note" value "the"→""
   ```
4. **ShowNoteContextMenu `{noteId: welcome}`**, then **CloseContextMenu**
   - `ui.overlays +menu (Rename, Move to folder, Delete) top`. Today `find {"role":"menu"}` finds
     nothing.
   - then `ui.overlays -menu · focus → none`.
5. **A real `click` on the context menu's "Delete"** (desktop)
   - today: the receipt shows the menu row removed, and then the app waits on a dialog nobody can
     see.
   - with this: `ui.overlays -menu +os-dialog "Delete note?" modal top`
6. **Copy**, then **MoveNote `{noteId:"grocery list", folderPath:"work"}`**
   - today: both "no change" (50/50 and 115/115 in the trace).
   - with this:
     ```
     clipboard null → "- milk\n- eggs…"
     effect moved "grocery list" → "work/grocery list" · notice "Moved to work"
     ```
7. **iOS `OpenNote {"noteId":"work/standup"}`**
   - today: `{ok:true, verb}`.
   - with this: `screen list→editor:work/standup · focus → editor L1:1 · keyboard shown 336pt`.
   - Later, when a person opens the ⋯ menu's Move: `ui.overlays +sheet "Move to folder"`.
8. **Android, after `TestCrash` and a relaunch**
   ```
   ui.overlays +dialog "FUTO Notes crashed" modal (window 2) · focus text "Describe what happened" value ""
   ```
   A background sync that deletes the open note shows up as
   `since last: effect removed "work/standup" · notice "Note deleted on another device"`.

---
