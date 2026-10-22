## 4. The gate: new UI cannot be silently invisible

The chain today is: **check-agent-verbs** makes every handler a verb. The missing link is that
every verb, and every overlay, must be something the agent can see.

1. **Static, deny-by-default: `check-agent-visibility`**, in the same shape as `check-agent-verbs`
   and in `check:arch-gate`, with an allowlist that gives a reason for each entry. It fails on:
   - (a) a Svelte element with `use:dismissable`, `use:portal`, or a class matching
     `/overlay|backdrop|menu|dropdown|popover|toast|tooltip|sheet|dialog|picker/` inside an `{#if}`,
     whose block contains no overlay role (`dialog|alertdialog|menu|listbox|tooltip|search|status|alert`)
     and no `<Modal`;
   - (b) a TS DOM builder that sets such a `className` with no `setAttribute('role'`, which catches
     CodeMirror panels and widgets;
   - (c) `Toast.makeText(` outside `AppToast`;
   - (d) `@tauri-apps/plugin-dialog` outside the C1 chokepoint.

   iOS sheets, alerts and covers and Android dialogs and popups need **no** static rule: D2 and D3
   see them whatever the view does. What is left there is S1 in-view surfaces. The gate
   requires a `state:` on a verb scope whose view declares an `@State`/`remember` Bool named
   `*Visible|show*|*Open`. That check is per file, the same ceiling check-agent-verbs has.
2. **Runtime sweep: `tests/agent-visibility.spec.ts`** (Playwright, dev build, `window.__futoAgent`).
   It is generative, so it needs no updating when a component is added:
   - on `home` and on `editor:welcome`, run every verb named `^(Open|Show|Toggle|Start)` whose
     required arguments a fixture can fill (`noteId: welcome`, `path: work`);
   - assert that `ui.overlays` or some `state` path changed, and that the receipt is not `unseen`;
   - `Press Escape` or the overlay's `Close*`/`Cancel*` verb must restore the baseline `ui`;
   - with any modal open, every row outside it must carry `covered`.

   Add it to `release:gate.needs` (M14).
3. **Self-report in every receipt**: `unseen: true` (§2). `reads-after-do.mjs`/trace mining counts
   the verbs that produce it, which turns the "no change" class above into a number that should fall
   to zero.
4. **Native**: Swift Testing and JVM tests of the pure mappers (VC descriptors or semantics
   descriptors → `ui`). The live sweep is the same spec's verb list run through `just agent` on a
   claimed simulator or emulator, as part of `/verify`. It is not in CI, because there are no
   devices there.
5. **Red proofs**: each new gate rule gets a `gate-redproofs` case (a SearchPopup without a role
   must fail).

---
