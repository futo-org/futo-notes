# Windows / WebView2 verification harness

A sudo-free Windows 11 VM for verifying **Windows-only behavior on real WebView2**
that the Linux/WebKit/Chromium test suites cannot exercise: native drag-and-drop
into folders (wry's `dragDropEnabled` swallows HTML5 DnD on WebView2), the NSIS
installer, clean-machine launch (VC++/WebView2 runtime), and any `#[cfg(windows)]`
path. Playwright/`agent-browser` run in WebKit/Chromium — **not** WebView2 — so a
green E2E does not prove Windows behavior. First used to verify the v1.5.1
drag-drop-into-folders fix (and it surfaced the missing-VC++-runtime bug).

The procedure is also written up in the `/verify` skill ("Windows (WebView2 — qemu VM)").

## Files (this dir = the tooling, version-controlled)

| File | What |
|---|---|
| `launch-vm.sh` | Boots the VM with raw qemu (UEFI + TPM + the drive layout). |
| `vmctl.py` | QMP driver: `shot` (PNG), `key`/`type`, `move`/`click`/`drag`. |
| `record_drag.py` | Records a drag as PNG frames (one QMP connection) for ffmpeg. |

## Data dir (NOT in the repo)

Heavy artifacts live in `$WIN_VM_DIR` (default `~/Developer/win-vm`), kept out of git:
`Win11.iso`, `virtio-win.iso`, `app.iso`, `windows-11-English-United-States/unattended.iso`,
and the generated `run/` (qcow2 disk, swtpm state, QMP socket, screenshots, frames).
Override with `WIN_VM_DIR=/path` (and `QMP_SOCK` / `OVMF_CODE` / `OVMF_VARS_SRC` as needed).

## Tooling decisions (why it's built this way)

- **Raw qemu, not libvirt/virt-install/gnome-boxes.** `/dev/kvm` is world-writable
  and `swtpm`/OVMF are user-runnable, so the whole thing needs **no sudo**. QMP gives
  fully scriptable screenshot + keyboard + mouse/**drag** control — exactly what an
  automated GUI drag test needs. libvirt/gnome-boxes would need a package install
  (sudo) and don't expose scripted input as cleanly.
- **SATA system disk (not virtio).** Lets the unattended install proceed without
  depending on virtio storage-driver injection succeeding mid-install. `virtio-win.iso`
  is still attached (E:) for completeness but isn't on the critical path.
- **Drive order D:/E:/F:/G:** mirrors the quickemu `autounattend.xml` expectations
  (D=Win11 ISO, E=virtio, F=unattended ISO with the answer file + spice agents,
  G=`app.iso` with the installer). Unattended install auto-logs-in as **`Quickemu`/`quickemu`**.
- **Win11 ISO fetched via a real browser.** Microsoft IP-blocks scripted ISO
  downloads (quickget's API hit gets refused), but serves the ISO fine to a real
  browser — `agent-browser` drives the download page and extracts the CDN link.
- **Video = QMP screendump frames → ffmpeg.** QMP has no native screen capture, so
  `record_drag.py` grabs a frame per mouse step over a single connection (avoids QMP
  contention from a parallel grabber) and ffmpeg stitches them.
- **App build comes from CI.** CI builds the signed NSIS `.exe` on git tags only
  (`windows:sign` job in `.gitlab-ci.yml`); download that artifact rather than building
  Windows locally.

## Quick start

```bash
export WIN_VM_DIR=~/Developer/win-vm        # data dir (default; override if you like)

# Stage the build under test into app.iso (from a tag's windows:sign artifact):
cp "FUTO Notes_<ver>_x64-setup.exe" "$WIN_VM_DIR/appiso/futo-setup.exe"
genisoimage -quiet -o "$WIN_VM_DIR/app.iso" -J -r -V FUTOAPP "$WIN_VM_DIR/appiso/"

# Boot (background); tap Enter 2-3x in the first ~10s for "press any key to boot from CD":
scripts/win-vm/launch-vm.sh > "$WIN_VM_DIR/run/qemu.log" 2>&1 &
python3 scripts/win-vm/vmctl.py key ret

# Drive (always screenshot first and read pixel coords off it). Watch: vlc vnc://localhost:5910
python3 scripts/win-vm/vmctl.py shot "$WIN_VM_DIR/run/shots/01.png"
python3 scripts/win-vm/vmctl.py key meta_l r                  # Win+R
python3 scripts/win-vm/vmctl.py type "G:\\futo-setup.exe /S"  # silent NSIS install
python3 scripts/win-vm/vmctl.py drag 70 308 70 208            # note row -> folder row

# Record the drag to mp4:
python3 scripts/win-vm/record_drag.py 70 308 70 208
ffmpeg -y -framerate 10 -pattern_type glob -i "$WIN_VM_DIR/run/frames/*.png" \
  -vf "scale=1280:-2,format=yuv420p" "$WIN_VM_DIR/run/verify-drag.mp4"
```

## Gotchas / findings

- The modern Win11 **25H2 setup** needs one click past the "Select keyboard settings"
  screen before `autounattend.xml` takes over; do **not** press keys at the CD-boot
  prompt on later reboots (let it fall through to the installed disk).
- A **clean Win11 lacks the MSVC runtime** — without the bundled vc_redist the app dies
  on launch with `MSVCP140_1.dll not found` (fix on branch `fix/windows-vcredist`).
  Win11 25H2 *does* ship the WebView2 runtime, so the editor renders.
- QEMU left-modifier qcodes are `shift`/`ctrl`/`alt` (not `shift_l`/`alt_l`); the
  Windows key is `meta_l`.
