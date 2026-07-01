# Windows — WebView2 in the qemu VM

Use for **Windows-only behavior on real WebView2** that web/WebKit/Chromium
and the Linux Tauri build cannot exercise: native drag-and-drop (wry's
`dragDropEnabled` swallows HTML5 DnD on WebView2), the NSIS installer,
clean-machine launch (VC++/WebView2 runtime), any `#[cfg(windows)]` path.
Playwright/agent-browser run WebKit/Chromium, **not WebView2** — a green E2E
does not prove Windows behavior.

The harness scripts live in **`scripts/win-vm/`** (`launch-vm.sh`, `vmctl.py`,
`record_drag.py`) — see **`scripts/win-vm/README.md`** for the full
quick-start and tooling decisions. Raw `qemu-system-x86_64` (world-writable
`/dev/kvm`, no libvirt/sudo) with UEFI + emulated TPM 2.0 and a QMP control
socket for screenshots/keyboard/mouse/drag. The heavy data dir (ISOs, disk,
frames) is `$WIN_VM_DIR` (default `~/Developer/win-vm`), kept out of the repo.

## Stage the build under test

CI builds the signed NSIS `.exe` on git tags only (`windows:sign` job in
`.gitlab-ci.yml`). Download that tag's artifact and rebuild the app ISO:

```bash
export WIN_VM_DIR=~/Developer/win-vm
cp "FUTO Notes_<ver>_x64-setup.exe" "$WIN_VM_DIR/appiso/futo-setup.exe"
genisoimage -quiet -o "$WIN_VM_DIR/app.iso" -J -r -V FUTOAPP "$WIN_VM_DIR/appiso/"
```

(The Win11 ISO must be fetched once via a **real browser** — `agent-browser`
works — because Microsoft IP-blocks scripted ISO downloads. virtio + the
quickget `autounattend.xml` are already staged.)

## Run + drive

```bash
scripts/win-vm/launch-vm.sh > "$WIN_VM_DIR/run/qemu.log" 2>&1 &   # Bash run_in_background
for i in $(seq 1 30); do [ -S "$WIN_VM_DIR/run/qmp.sock" ] && break; sleep 1; done
python3 scripts/win-vm/vmctl.py key ret   # one-time "press any key to boot from CD"; tap 2-3x
# Always screenshot first and read pixel coords off it:
python3 scripts/win-vm/vmctl.py shot "$WIN_VM_DIR/run/shots/NN.png"
python3 scripts/win-vm/vmctl.py key meta_l r                 # Win+R
python3 scripts/win-vm/vmctl.py type "G:\\futo-setup.exe /S" # silent NSIS install
python3 scripts/win-vm/vmctl.py drag X1 Y1 X2 Y2             # HTML5-DnD-friendly drag
```

Watch live via VNC on `localhost:5910` (e.g. `vlc vnc://localhost:5910`).

**Procedure:** boot → unattended install (auto-login `Quickemu`/`quickemu`;
the modern 25H2 setup needs one click past the keyboard screen, then
`autounattend.xml` takes over — do NOT press keys on later reboots) → silent
app install from G: → launch → create a folder + a root note → drag the note
onto the folder → screenshot **and** verify on disk
(`C:\Users\Quickemu\Documents\futo-notes\<Folder>\<Note>.md`, gone from root).

**Gotchas:** a clean Win11 lacks the MSVC runtime — without the bundled
vc_redist the app dies on launch with `MSVCP140_1.dll not found`. Win11 25H2
ships the WebView2 runtime, so the editor renders.

## Video recording

QMP has no native capture — `record_drag.py` grabs frames over one
connection, then ffmpeg stitches:

```bash
python3 scripts/win-vm/record_drag.py X1 Y1 X2 Y2
ffmpeg -y -framerate 10 -pattern_type glob -i "$WIN_VM_DIR/run/frames/*.png" \
  -vf "scale=1280:-2,format=yuv420p" "$WIN_VM_DIR/run/verify-drag.mp4"
```
