# Recovering a parked simulator keyboard

If the keyboard's accessibility rows remain below the screen after `just qa-claim ios --reboot`,
read a new tree and screenshot before treating the app as broken. The hardware-keyboard preference
alone does not prove that software keys are visible. On iOS 27, letter keys may appear as Buttons;
check their frames and rendered input rather than requiring one accessibility type.

For an already claimed, disposable QA simulator, explicit recovery is available:

```bash
just qa-claim ios --erase
just ios-native
```

**Erase removes every app, vault, preference and keychain item on that simulator.** Use it for
state this task created, or obtain approval before discarding preexisting expensive or real data
(root `AGENTS.md` §11). Claim ownership alone does not establish that its data is disposable.

The command requires exactly one existing iOS claim owned by the current worktree. It does not
acquire another pool device for recovery, accepts no personal-device override, and refuses an
ambiguous claim. It rechecks ownership and the original simulator UDID before shutdown/erase,
waits for observed Shutdown, and fails if identity changes. Normal claiming then boots that same
device and disconnects its hardware keyboard. It never erases automatically after a failed retry.

Reinstall the dev app after recovery. Confirm that Done and letter-key frames are inside the
screen, touch a visible key and observe the complete rendered/saved marker before continuing a
story. A successful tap exit code is insufficient evidence. This recovery discards corrupted
simulator state; it does not diagnose an app defect or prove the original corruption is reproducible.
