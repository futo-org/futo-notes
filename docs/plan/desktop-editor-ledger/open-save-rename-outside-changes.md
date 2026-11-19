# Open, save, rename, reload and outside changes

### OS01

- **Rule:** Opening, reading or selecting a note never changes its bytes or modification time.
- **Why / history:** An editor load is not an edit; old external adoption renumbered 271 corpus notes and pushed the rewrite back to peers.
- **Evidence:** !228; !394; tests/p1-regressions.spec.ts
- **Applies:** `desktop now`. **Check:** p1 no-mtime-bump regression; needs desktop exact-source open story

### OS02

- **Rule:** The desktop host alone owns note identity, exact source, saved baseline and rename outcomes.
- **Why / history:** Mason, 2026-11-03 chose one attachment owner to remove check-then-act races; the Svelte session follows host reports.
- **Evidence:** docs/plan/desktop-editor.md; src/AGENTS.md
- **Applies:** `desktop now`. **Check:** desktop/editing.md; needs identity/save/rename story

### OS03

- **Rule:** The host saves after 500 ms of inactivity and within two seconds of uninterrupted typing.
- **Why / history:** !366's decision 5A fixed endless debounce postponement; source changes must not wait for a pause forever.
- **Evidence:** !366; docs/spec/editor/desktop/editing.md
- **Applies:** `desktop now`. **Check:** needs continuous-typing durability story

### OS04

- **Rule:** Blur, hiding, minimizing, leaving and system exit events flush pending edits.
- **Why / history:** !373 fixed menu Quit, updater relaunch and slow-write losses; the desktop plan includes sleep, lock, logout and shutdown.
- **Evidence:** !373; docs/plan/desktop-editor.md; desktop/editing.md
- **Applies:** `desktop now`. **Check:** needs lifecycle trigger matrix; current quit timeout limits must remain explicit

### OS05

- **Rule:** A failed save retains an editable retryable draft and does not advance the saved baseline.
- **Why / history:** !116/!117 review found silent write failures and immediate navigation discarding the only draft; current desktop retries after two seconds and keeps the note open.
- **Evidence:** !116 discussion; !117 discussion; !299; desktop/editing.md
- **Applies:** `desktop now`. **Check:** needs refused-save/navigation/retry story

### OS06

- **Rule:** A late save completion cannot overwrite a later edit or another note's state.
- **Why / history:** A 2026-03 cursor-to-zero race and !358/!366 wrong-note races share stale completion ownership.
- **Evidence:** d5fe5e57c; !358; !366
- **Applies:** `desktop now`. **Check:** needs edit-during-save and rapid A→B→C→A stories

### OS07

- **Rule:** A note switch flushes the outgoing latest edit before replacing its binding.
- **Why / history:** The 200 ms change debounce and iOS linked-note pop once saved the child's body into the parent.
- **Evidence:** !358; docs/qa/wikilink-pop-large-edited-note.md
- **Applies:** `desktop now`. **Check:** needs exact parent/child body and final-tail story

### OS08

- **Rule:** An editor with no loaded note or a failed serialization never reports an empty editable document as valid content.
- **Why / history:** A remounted component truncated three real notes in 2026-09; !366 replaced empty-string failure fallback with unavailable content.
- **Evidence:** cursor/a-note-the-editor-cannot-hold.md; !366; #244
- **Applies:** `desktop now`. **Check:** needs remount, parse failure and never-emptied desktop stories

### OS09

- **Rule:** A duplicate or invalid title blocks the rename while the body still saves under its current valid identity.
- **Why / history:** !444 fixed duplicate-title body loss and case/NFC collision mismatches; a new note can use an allocated Untitled name.
- **Evidence:** !444; docs/spec/editor/saving-and-rename.md
- **Applies:** `desktop now`. **Check:** tests/duplicate-title.spec.ts; needs desktop story

### OS10

- **Rule:** Editing a focused title preserves every keystroke and its caret position after sanitization.
- **Why / history:** !396 keeps saved-name normalization out of a focused title, fixing grocery + space + pause + list becoming grocerylist; app blur does not end field editing. !408 fixes synchronous caret divergence and !466 a delayed Select All eating the first character.
- **Evidence:** !396; !408; !413; !466; tests/p2-regressions.spec.ts
- **Applies:** `desktop now`. **Check:** p2 title-input tests; needs desktop stories

### OS11

- **Rule:** A parked save keeps the user editing the conflict copy rather than switching to the original peer version.
- **Why / history:** Mason, 2026-11-04 option 1A deliberately reverses main desktop's old display choice and matches native shells.
- **Evidence:** docs/plan/desktop-editor.md; !359
- **Applies:** `desktop now`. **Check:** needs conflict-copy identity, title, caret and continued-save story

### OS12

- **Rule:** Own-save watcher echoes are compared by exact content and cannot create external-change alerts or new edits.
- **Why / history:** !54 removed sampled equality; !156 replaced event counting because macOS delivers multiple FSEvents.
- **Evidence:** !54; !156; !177
- **Applies:** `slice 8`. **Check:** needs same-length-unsampled-change and repeated-own-echo stories

### OS13

- **Rule:** Outside adoption preserves dirty local text and waits for active composition.
- **Why / history:** !156/!177 preserved dirty drafts; !166/!203 later chose focused-editor deferral on every host. Desktop slice 8 plans in-place merge with mapped selection; retain dirty/composition protection without blindly copying the older focus gate.
- **Evidence:** !40; !156; !166 ruling 3B-ii; !177; !203; !375; docs/plan/desktop-editor.md slice 8
- **Applies:** `slice 8`. **Check:** needs dirty/debounced/inflight/duplicate-title/composition matrix

### OS14

- **Rule:** Independent outside changes merge once while overlapping changes preserve both versions.
- **Why / history:** !574/!576 remove needless paragraph conflict copies; slice 8 adopts a three-way merge as one edit.
- **Evidence:** !574; !576; #322; #323; docs/plan/desktop-editor.md
- **Applies:** `slice 8`. **Check:** needs independent and overlapping merge/Undo stories

### OS15

- **Rule:** A remote rename follows authoritative identity before saving, including a rename to a subsequently deleted target.
- **Why / history:** !113 review fixed ghost stripping hiding a real target deletion; !577 carries attached dirty drafts through renames.
- **Evidence:** !113 discussion; !577; #324
- **Applies:** `slice 8`. **Check:** needs rename/delete/inflight-save identity stories

### OS16

- **Rule:** Deleting the open note closes or preserves its dirty draft according to the store disposition and cannot resurrect a stale clean copy.
- **Why / history:** !66 fixed autosave resurrection; !583 lets a clean native session follow outside edits instead of parking stale content.
- **Evidence:** !66; !583; docs/spec/editor/saving-and-rename.md
- **Applies:** `slice 8`. **Check:** needs clean/dirty delete and retry story

### OS17

- **Rule:** The app remains closable during an expensive clean-note open while pending edits get their documented flush window.
- **Why / history:** !373 added Rust-side clean-page exit when JS is wedged; dirty-page timeout is a limitation, not proof of durability.
- **Evidence:** !373; docs/spec/editor/performance.md; desktop/editing.md
- **Applies:** `desktop now`. **Check:** needs real desktop blocked-page close story; no process manipulation performed here

### OS18

- **Rule:** Changing a note's identity without changing its text retains history only for the same note's rename.
- **Why / history:** !484 distinguishes a real equal-byte note switch from an identity-preserving rename; the 2026-10 ownership plan records the old history reset regression.
- **Evidence:** !484; docs/plan/editor-owns-the-document.md@0fad0917b^
- **Applies:** `desktop now`. **Check:** needs equal-byte-switch and rename-preserves-Undo stories

### OS19

- **Rule:** A clean session follows changed disk content even when its old history cannot be retained.
- **Why / history:** !583 fixes stale conflict copies for notes over 1 MiB, history budgets and ambiguous clean rebases; dropping history may be necessary for front matter.
- **Evidence:** !583; portable-core/recovery.md
- **Applies:** `slice 8`. **Check:** crates/futo-notes-store/src/tests/editor_session/clean_refresh.rs; needs clean-large-note story

### OS20

- **Rule:** A desktop exit captures and durably commits its latest draft before leaving or mutating the note.
- **Why / history:** !167/!168 centralized drains and !180 clarified late input. Current desktop failed-save policy keeps the note open; native Back now leaves first under a retained draft register, so its ordering is deliberately different.
- **Evidence:** !167; !168; !180 discussion; docs/spec/editor/editor-exits.md; saving-and-rename.md.
- **Applies:** `desktop now`. **Check:** needs a story for failed exit, concurrent rename/save and late input.

### OS21

- **Rule:** A converged flush retains the durable draft and marks only the exact flushed snapshot as saved.
- **Why / history:** Justin's !119 review on 2026-07-21 found Converged grouped with Parked, adopting stale peer text; reading live content after an await also marked newer input clean.
- **Evidence:** !119 discussion (F1/F3); docs/spec/sync.md, flush outcomes.
- **Applies:** `desktop now`. **Check:** needs a story; store flush and historical native AdoptFlushOutcome tests pin the disposition.

### OS22

- **Rule:** A diverged draft keeps its pre-pull baseline so saving cannot silently overwrite the peer's version.
- **Why / history:** !156/!177's local-wins rebase was reversed by !217 (#89): using pulled bytes as the flush comparison made conflict parking unreachable. Converged drafts alone adopt the matching disk baseline.
- **Evidence:** !156 discussion; !177; !215; !217; crates/futo-notes-ffi/tests/open_note_flush.rs.
- **Applies:** `slice 8`. **Check:** needs a story proving local and peer versions survive a dirty pull and subsequent save.

### OS23

- **Rule:** Desktop title input allows overlength text but blocks an invalid rename with a warning while preserving the body.
- **Why / history:** !47 defined invalid-title handling; !189 fixed the C1 gap; !201 review records desktop warning above 200 characters versus native live caps. Filename spelling remains the title.
- **Evidence:** !47; !189; !201 discussion, 2026-08-10; docs/spec/list.md; AGENTS.md M2.
- **Applies:** `desktop now`. **Check:** existing title/conformance cases; needs desktop overlength-title story.

### OS24

- **Rule:** A refused vault-root write locks editing with a persistent recovery banner while leaving the text available to copy.
- **Why / history:** !357 replaced repeated failing saves with read-only body/title/tags and disabled mutations; subfolder-only refusal does not lock the whole app. Its policy discards an unsaved locked draft when leaving, so copy-out must remain possible.
- **Evidence:** !357; docs/qa/windows-controlled-folder-access.md; docs/spec/editor/saving-and-rename.md.
- **Applies:** `desktop now`. **Check:** existing Windows story; needs new editor read-only/copy-out story.

### OS25

- **Rule:** A pending title rename commits on leaving the title or pressing Enter, with a ten-second backstop and no unchanged-title write.
- **Why / history:** !186 restored the body-focus flush, then deferred blur commits until the pointer's click or dragend so sidebar re-sorting cannot change the clicked row; canceled gestures have a 100 ms fallback.
- **Evidence:** !186; docs/spec/editor/saving-and-rename.md.
- **Applies:** `desktop now`. **Check:** needs title Enter, chrome blur, sidebar click and drag-hold stories.

### OS26

- **Rule:** Move and Delete act on the note originally picked and never fall through to whichever note becomes active during a save.
- **Why / history:** !186 found both unsaved-draft and vanished-note races; only the identity change made by that same flush can translate the pick. Otherwise the action refuses visibly.
- **Evidence:** !186; docs/spec/list.md, note actions; !413.
- **Applies:** `desktop now`. **Check:** needs delayed save/rename plus tab switch, vanished pick and never-saved note stories.

### OS27

- **Rule:** A rename updates the note projection and selected identity together without a blank selection frame.
- **Why / history:** !186 measured a render between cache mutation and session retarget, leaving no sidebar row selected until a second render. The final mutation and identity must reach the view together.
- **Evidence:** !186; desktop note mutation projection.
- **Applies:** `desktop now`. **Check:** needs rename projection story; historical MutationObserver trace pins the one-frame defect.

### OS28

- **Rule:** Updating and restarting saves the latest body and pending title before the installer can terminate the process.
- **Why / history:** !626 on desktop/updater-in-rust is open history to integrate: Windows installer std::process::exit bypassed RunEvent::Exit, losing keys received after the JavaScript flush; its Rust hook saves again and locks the title until restart or failure.
- **Evidence:** !626; !373; docs/spec/editor/desktop/editing.md exit saving.
- **Applies:** `desktop now`. **Check:** needs Windows updater/body/title story; current checkout is not claimed to include !626.

### OS29

- **Rule:** Desktop browser-refresh shortcuts do not reload the page and discard unsaved editor state.
- **Why / history:** Open !626 on desktop/updater-in-rust guards F5, Ctrl/Cmd+R and shifted variants after an exit audit found reload could drop an unsaved title; the Refresh key itself remains unverified.
- **Evidence:** !626 (source branch desktop/updater-in-rust).
- **Applies:** `desktop now`. **Check:** needs Windows/WebKitGTK/WKWebView reload-key story including a non-Latin layout.

### OS30

- **Rule:** The editor title shows no word count or other document statistic.
- **Why / history:** The maintainer removed Android's word-count line on 2026-06-10; the intended editor chrome is the title and document, so a replacement must not accidentally restore it.
- **Evidence:** docs/spec/editor/saving-and-rename.md.
- **Applies:** `desktop now`. **Check:** needs a spec line only if this deliberate chrome decision is reconsidered.

### OS31

- **Rule:** The default Untitled title selects fully for easy replacement while an existing chosen title retains ordinary caret placement.
- **Why / history:** The P2 regressions distinguish initial quick deletion from unwanted select-all; !466 separately fixes a deferred selection that consumed the first typed letter.
- **Evidence:** tests/p2-regressions.spec.ts; !466.
- **Applies:** `desktop now`. **Check:** existing P2 title cases; needs new-editor initial-title and rapid-first-keystroke stories.
