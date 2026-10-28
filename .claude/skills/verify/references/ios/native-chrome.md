## 3. Native chrome only — what the verbs cannot reach

**Everything the app itself owns — notes, folders, navigation, the editor and the chrome
around it, the search field, the Settings, Sync and Feedback screens — is a verb, and every
native screen is `elements` plus real `tap`/`drag`/`type`/`press`, which `axe` sends: use the
`puppet` skill** (`state.screen` names `settings`, `sync`, `feedback` and `search`; `actions`
lists what each offers). A row's hidden affordances are in its `elements` line: `hold` for a
long-press menu, `actions=…` for its custom actions (the `docs/spec/AGENTS.md` check). The
menus iOS presents itself — a row's long-press menu, its swipe actions, the editor's ⋯ menu
and the sort menu — have no verb: press with `just puppet tap` (`"hold":0.8` for a long press)
and tap the item `elements` lists; what the item opens has verbs again.

Keep a horizontal `drag` above y≈850: at y=852 it hits the home-indicator gesture and leaves
the app (y=845 and y=838 are safe).

### Hold-then-drag: `drag` cannot express it

`MoveBlock` is the block drag as a verb. When the gesture itself is under test — a long press
that then moves, its lift, ghost and drop indicator — `just puppet drag` cannot send it: it is
`axe drag`, which (like its `swipe`) applies `--pre-delay` BEFORE touch-down, so the finger is
already moving when it lands and the app sees an ordinary scroll. Verified on AXe 1.8.0 at
`--pre-delay` up to 1.2s: the editor's 340ms lift never fired.

What works is one `axe touch` per position, because CoreSimulator's digitizer has no distinct
move event — a second `--down` at a new point IS a move:

```bash
axe touch -x 200 -y 300 --down --udid $SIM   # finger lands, nothing else
sleep 0.7                                     # past the app's 340ms lift
axe touch -x 200 -y 360 --down --udid $SIM   # a move, not a second touch
axe touch -x 200 -y 420 --down --udid $SIM
axe touch -x 200 -y 420 --up   --udid $SIM   # release commits
```

Each step is a separate process and the touch survives between them, so `just puppet
screenshot` (or the vault) BETWEEN steps shows the lift, the ghost and the drop indicator as
separate frames. Nothing traces these touches and no receipt says what they did.

### What nothing reaches

Out-of-process system UI — the "Save Password?" sheet, the Photos picker, permission
dialogs — is not in the app's accessibility tree, so `elements` does not list it;
`just puppet screenshot` shows it. Dismiss it by hand or `just puppet relaunch` past it, and
record affected stories as **Blocked (not drivable)**, not as failures.
