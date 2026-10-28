# iOS app data and sync verification

Read [the iOS playbook](ios.md) first for device claims, builds and UI driving.
This reference owns fixture seeding, saved-content oracles, preferences and sync.

## App data: seeding and verification

The debug app's vault is plain files in the app container — use it in both
directions (fixtures in, verification out):

```bash
NOTES="$(xcrun simctl get_app_container "$SIM" com.futo.notes.dev data)/Documents/fake-notes"
ls "$NOTES"
cat "$NOTES/grocery list.md"

# Seed fixtures, then relaunch so the scan picks them up:
mkdir -p "$NOTES/QA Folder"
printf '# Seeded\n\n- [ ] task\n' > "$NOTES/QA Folder/Seeded Note.md"
FUTO_PUPPET_TARGET=ios just puppet relaunch
```

**Empty-vault Welcome seed**: launching into a completely empty vault
auto-seeds `Welcome.md` — wipe-and-relaunch can never show the bare
"No notes yet" state. To reach true-empty, delete the last note **in-app**
(row long-press → Delete → confirm) and don't relaunch afterward.

### Preferences and device-container safety

Change preferences through the app UI when possible. Otherwise terminate the
debug app **before** `xcrun simctl spawn "$SIM" defaults write ...`, then launch
it again: a running app can retain a different cached value even while
`defaults read` shows your new one. Editing the container's preferences plist
directly is unreliable even after termination because `cfprefsd` caches it;
`plutil -replace` is not a substitute. In plutil keypaths, literal dots need
escaping (`futo\.serverURL`), whereas `defaults` takes the literal key.

For physical-device fixtures, `devicectl device copy to` must not use
`--remove-existing-content true`: it can remove the app's whole Documents tree,
even when the destination names one subdirectory and the command exits nonzero.
Copy into a dedicated fixture directory without that option and retain a backup
of any container holding data you did not create.

### Reading what landed (editor content verification)

`just puppet doc` reads the editor's lines on screen, and `state`'s `pending.unsaved` lists
the notes whose edits are not on disk yet. Once it is empty, the file is the oracle:

```bash
FUTO_PUPPET_TARGET=ios just puppet state    # pending.unsaved is [] once the save landed
cat "$NOTES/<note>.md"
```

**IME mangles typed text in note fields**: under `just puppet type`,
autocapitalize/predictive-text rewrite things like `para-1-ios` → `Para-1-iOS` (the
Sync settings fields suppress this; note fields don't), and typing into a prefilled
field appends to it (clear it with `press {"key":"Backspace","count":N}`). `type` is
the simulator's HID keys, which on iOS 27 can deliver nothing while reporting success.
For exact text use the verbs, which no keyboard rewrites (`do Type`, `SetTitle`,
`SetSearchQuery`), or markers autocorrect can't rewrite (digits/hyphens), and verify
byte-for-byte on disk.

### The editor toolbar is verbs, not taps

Every accessory-toolbar item is a verb — `Bold`, `Italic`, `Strikethrough`,
`Link`, `Heading`, `Quote`, `BulletList`, `OrderedList`, `TaskList` — and they
act on the selection exactly as the button does, with a receipt:

```bash
export FUTO_PUPPET_TARGET=ios
just puppet do '[["Select",{"from":0,"to":8}],["Bold"]]'
just puppet doc                                  # → **boldtext**
```

That reaches every item wherever it sits. On a 402pt-wide iPhone only the first eight sit
inside the bar's viewport; `checklist`, `camera` and `photo` start past the right edge, where a
tap does nothing. `axe drag` across the row with `--steps 30` scrolls it; `just puppet drag`
passes no step count and has not been shown to. An item off screen is evidence to scroll, not
that it is broken.

## Sync features

The simulator shares the Mac's network — `http://127.0.0.1:<port>` reaches a
host server directly (unlike Android's `10.0.2.2`; a **physical** iPhone needs
the Mac's LAN IP instead). Native shells have no `__testSync` hook — connect
through Settings → Sync in the app UI. Server setup: see "Features that need a
sync server" in SKILL.md; when this machine cannot reach the package registry
and `~/.cache/futo-notes` is cold, record sync happy-path stories as
**Blocked**, not failed.

A simulator keychain `reset` does **not** reliably remove a root installed with
`keychain add-root-cert`. For a negative TLS-trust test, present a certificate
from a second CA that was never installed; do not infer untrusted state from a
successful reset command. The claim handoff resets app credentials, but that
is not proof of a clean trust store.
