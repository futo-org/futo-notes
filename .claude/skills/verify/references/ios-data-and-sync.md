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
xcrun simctl terminate "$SIM" com.futo.notes.dev; xcrun simctl launch "$SIM" com.futo.notes.dev
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

### The flush-and-read trick (editor content verification)

The editor WKWebView is not reachable via CDP or JS from outside (no
`window.__testSync`, no MCP bridge on iOS). To verify what the editor holds:
background the app — backgrounding flushes pending edits to disk — then read
the file:

```bash
axe button home --udid $SIM
sleep 1
cat "$NOTES/<note>.md"
```

Type into the editor with `axe type` after tapping the title/body to focus;
verify the result on disk, not by screenshot-squinting.

Two things the a11y tree _does_ give you without a disk read: the note title is
the editor's `TextField` `AXValue`, and the editor's accessory toolbar only
exists while the keyboard is up — so its presence is itself the evidence that a
field is focused.

**IME mangles typed text in note fields**: autocapitalize/predictive-text
rewrite things like `para-1-ios` → `Para-1-iOS` (the Sync settings fields
suppress this; note fields don't). `axe type` also APPENDS to prefilled
fields — clear them first (tap the field's right edge, then `axe key --keycode
42` backspaces). For exact text, `xcrun simctl pbcopy $SIM` + long-press →
Paste usually works but has silently no-op'd in some fields. The robust
patterns are: use markers autocorrect can't rewrite (digits/hyphens) and verify
byte-for-byte on disk, or tap the on-screen keyboard's own keys — they are in
the a11y tree with their letters as labels, so the IME never gets a say.

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
