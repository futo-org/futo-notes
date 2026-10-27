## 2. The mechanism

### D1 — web: `uiState()` derived from ARIA and the hit-test (desktop, and the page on both phones)

It goes in `agentElements.ts`, next to `flagsOf`. It is about 60 lines and needs no component wiring.

```ts
const OVERLAY = '[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[role=tooltip],' +
                '[role=search],[aria-modal=true],dialog[open],:popover-open';
ui = {
  overlays: visible(querySelectorAll(OVERLAY)).map(el => ({
    ref, role, name,          // aria-label ‖ aria-labelledby text ‖ first h1–h3 ‖ component file
    modal,                    // aria-modal=true ‖ role=alertdialog ‖ <dialog> in the top layer
    top,                      // the last overlay whose centre elementFromPoint lands inside itself
    owner,                    // [aria-controls=<id>] or [aria-expanded=true] trigger → its ref
  })),
  focus: activeElement === body ? null
       : inEditor ? { editor: true, caret: "L4:3", composing: view.composing }
       : { ref, role, name, value },            // value masked for type=password
  window: { focused: document.hasFocus(), visible: document.visibilityState === 'visible' },
  notice: text of visible [role=status],[role=alert],[aria-live] ("" when none),
  busy: refs of [aria-busy=true] + (document.getAnimations().some(running) ? ['animating'] : []),
}
```

Row fixes in the same file, each one line:

- `focused` goes only on the active element (and on the `.cm-editor` row when focus is in `.cm-content`), no longer on its ancestors.
- `collapsed` for `aria-expanded="false"`.
- `checked` from `.checked` on checkbox/radio inputs.
- `disabled` also from `aria-disabled`.
- A `value` field beside the label for input, textarea and select.
- `covered:eN` when `elementFromPoint(centre)` is outside the row. That is the hit-test `at` already does, once per row.

**Why ARIA and not the `dismissable` stack.** `dismissable.ts` registers Search, ContextMenu,
Language, Settings, Modal and Crash. It misses NoteActionsMenu, the image menu, the find panel, the
slash menu, autocomplete and toasts. ARIA misses only 4 elements today, and adding their roles
fixes screen readers too:

- SearchPopup has no role.
- The `SidebarImageView` menu has no role.
- The App toast has no role.
- The find panel is not `role=search`.

So there is one rule, and it serves assistive technology and agents together. `top` from the
hit-test is also generic. Order of opening, from the evidence ring, breaks ties between overlays
that do not overlap.

### C1 — desktop OS dialogs: one chokepoint

`confirmDialog.ts` plus the two `open(...)` calls (`SettingsScreen.svelte:187`,
`lib/platform/tauri/images.ts:33`) set a dev-only `pendingNativeDialog = {kind, title, message}`
while awaiting. `uiState` reports it as `overlays: [{role:'os-dialog', name:title, message, modal:true, top:true}]`.
Verbs keep bypassing it. A real click is the only thing that raises it, and that is exactly when the
agent needs to see it.

### C2 — effects: where the app already funnels them

The page trace records `effect` entries in its event ring at these points:

- `_applyLocalMutation` (`notes.svelte.ts:81`, the single projection point for every committed
  mutation, sync's included): `{upserted ids, removed, folders}`.
- A dev wrapper on `navigator.clipboard.writeText`: `{clipboard: text}`.
- The `app-menu` listener: `{menu: id}`.

iOS `NotesStore.applyMutation` (`:499`) and Android `NotesStore.applyMutation` (`:869`) record the
same entries into the listener's ring. The agent clipboard also goes into the snapshot, so `Copy`
diffs. Upgrade path: once sibling (b) gets the Rust store to journal, the store's own ring replaces
these three hooks.

### D4 — notices and errors: continuous, not only at action boundaries

`installTrace` adds:

- a `MutationObserver`, coalesced to one per frame, that ignores mutations inside `.cm-content`
  (typing is sacred, M5). It recomputes `uiState()` and pushes a `ui` entry `{t, diff}` whenever the
  result changes, so overlays that open or close on a timer, a late render or a toast are recorded
  with a time;
- `error`/`unhandledrejection` listeners and a `console.error`/`warn` wrapper that push `error`
  entries `{message, stack head, source}`.

A receipt lists the entries inside its window. Entries that arrive after the receipt show up as
`since last:` on the next receipt, from the ring rather than from a snapshot that may already be
evicted, which fixes the F2 loss.

### D5 — settle before the `after` snapshot (visibility half of audit C3)

After the verb's promise resolves, wait until no `[aria-busy=true]` remains and
`document.getAnimations()` has nothing running, then 2 rAF. Cap the wait at about 300 ms. If the cap
is hit, the receipt says `busy: […]` rather than pretending to be complete. Settings' storage row
sets `aria-busy` while it shows "Loading…".

### D2 — iOS native: UIKit already knows

This goes in `AgentActionServer.swift`, debug only, as a pure `Contract.overlays(from:)` mapper plus
a gatherer.

- **overlays**: walk the key window's `rootViewController.presentedViewController` chain. That one
  walk sees every `.sheet`, `.fullScreenCover`, `.alert`, `.confirmationDialog`, `ShareLink`
  (`UIActivityViewController`) and `UIImagePickerController`.
  - `UIAlertController` gives `{role: alert|actionSheet, name: title, message, actions: [titles]}`.
  - A hosting controller gives `{role: sheet|cover}` from `modalPresentationStyle`, named by the
    known `navigation.sheet` case or by a nested `UINavigationController`'s title.
  - The existing `sheet` field stays as the first entry's name.
- **focus**: the first responder, found with the `sendAction(#selector(captureFirstResponder), to: nil…)`
  trick. A `UITextField` gives `{role:text, name: placeholder/label, value: text}`. `WKContentView`
  gives `{editor:true, …page focus}`.
- **keyboard**: `{shown, height}` from `keyboardWillChangeFrame`.
- **S1, declared**: an in-view surface such as the find bar or the transient banner cannot be
  derived without a spike on in-process SwiftUI accessibility. The screen passes it on the verb
  scope it already has, `.agentVerbs(state: { ["find": ["open": findVisible, "query": findQuery]] }) { … }`,
  and the listener merges those into `ui.surfaces`. The scope already exists (check-agent-verbs
  forces it), so this adds no machinery.
- A 250 ms debug sampler compares `ui` and pushes changes into a ring, so a sheet that appears
  between calls is still recorded. `ponytail:` it misses flashes shorter than 250 ms; hook
  `present`/`dismiss` if that ever matters.

### D3 — Android native: Compose semantics and windows

This goes in `agent/`, debug only.

- **overlays**: every app window's root view. This is `WindowManagerGlobal.mViews` by reflection,
  a hidden API that works on current Android; squareup/curtains is the upgrade path. For each
  `ViewRootForTest`, read `semanticsOwner`. Nodes with `IsDialog`, `IsPopup` or `PaneTitle` become
  overlays; `Dialog`, `AlertDialog`, `ModalBottomSheet` and `DropdownMenu` set these themselves. A
  non-main window counts as modal.
- **focus**: `activity.currentFocus`. The WebView means the page. A Compose view means the node with
  `Focused=true`, with its `EditableText` as `value`. `ToggleableState`/`Selected`/`Disabled` become
  flags.
- **keyboard**: `WindowInsetsCompat.isVisible(ime())` and its height.
- **C3**: route the 39 `Toast.makeText` calls through one `AppToast.show()`, which records a
  `notice`. Gate: `Toast.makeText(` outside it is refused.
- S1: `AgentVerbScope(state = { … })`, as on iOS.

### How `ui` surfaces

1. **Full `state`**: a top-level `ui` on all three platforms. Desktop keeps `settingsOpen`/`searchOpen`
   until `ui` has been proven, then deletes them, because they become redundant. Jev's
   `computed.overlay` (`jev-drive.mjs:509-514`) is deleted: `ui.overlays`/`ui.top` are answer paths.
2. **Action result / diff**: the page snapshot stores `ui`, `editor.find` and `clipboard`, so
   `diffSnapshots` diffs them by path. For native verbs the CLI diffs `state` before and after
   (audit C5), and `ui` comes along. A 200 whose diff is empty after settling is marked
   `unseen: true`. The house rule is already "nothing to do is a 409" (Undo, CreateNote), so an
   unseen 200 is either a real no-op or a visibility gap, and it is flagged either way.
3. **Evidence records**: the `ui`, `notice`, `error` and `effect` entries in the page event ring,
   and the native rings (D2/D3). Each receipt carries the ids of its window. The trace line format
   belongs to sibling (b).

---
