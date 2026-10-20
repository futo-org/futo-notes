## Dialogs _(desktop)_

- **Escape dismisses the top-most dialog or overlay, from wherever focus is** —
  including from a text field inside it — and never more than one at a time. It
  is a property of dialog composition, not of each dialog: `Modal.svelte` (used
  by every standard modal) and the `use:dismissable` action (used by overlays
  with bespoke chrome — crash report, context menu, search, settings) share one
  document-level handler and a dialog stack. Escape consumed by an open overlay
  does not also reach the editor or the screen behind it. → shared/dialogs/dismissable.ts,
  shared/dialogs/Modal.svelte, shared/dialogs/dismissable.test.ts,
  tests/folder-support.spec.ts
- **A popover anchored to a trigger (the Settings language dropdown, the
  sidebar context menu) also closes on a pointer press outside it**, on the
  press itself, before the click lands on whatever was pressed.
  → shared/dialogs/dismissable.ts, features/sidebar/components/ContextMenu.svelte.test.ts
- Focus moving to an element outside such a popover (Tab past the last item)
  closes it. → shared/dialogs/dismissable.ts,
  features/settings/LanguageSettingsSection.svelte.test.ts
- Pressing the language dropdown's trigger while it is open closes it once and
  returns focus to the trigger; the press itself never moves focus, so the
  listbox cannot close on press and reopen on release. Pressing elsewhere
  leaves focus where the user put it. → features/settings/LanguageSettingsSection.svelte
- **An open overlay covers the scrollbars too.** A context menu or modal that
  straddles a scrolling surface is drawn over its scrollbar, not under it: while
  a portalled overlay is mounted, overlay-style scrollbars (ones that reserve no
  layout width — WebKitGTK, macOS) are hidden, because WebKit paints them after
  the rest of the page and no z-index outranks that pass. Scrollbars that
  reserve width are left alone, so nothing reflows when a menu opens. Reported
  on Ubuntu 2026-09-16: the sidebar scrollbar striped an open note context menu.
  → shared/dom/portal.ts, styles/stacking.css, shared/dom/portal.test.ts
- A standard modal is `role="dialog" aria-modal="true"`, named by its title,
  traps Tab inside the card, dismisses on a backdrop click, and returns focus to
  whatever was focused when it opened. → shared/dialogs/Modal.svelte
- Secondary/cancel buttons in dialogs carry a hover affordance, gated behind
  `@media (hover: hover) and (pointer: fine)` so a touch shell never leaves a
  button stuck in its hover state. → shared/dialogs/modal.css,
  crashReportDialog.css, settingsBlockingOverlay.css
- Confirmation prompts go through `confirmDialog()` (`src/shared/dialogs/confirmDialog.ts`),
  a shared in-app modal host used on every shell — `window.confirm()` /
  `window.alert()` are not application UI and do not block reliably in Tauri's
  webview; concurrent requests queue so prompts cannot overlap. → confirmDialog.ts,
  confirmDialogState.svelte.ts, ConfirmDialogHost.svelte
