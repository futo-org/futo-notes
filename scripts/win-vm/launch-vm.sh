#!/usr/bin/env bash
# FUTO Notes — Windows 11 test VM (raw qemu, NO sudo / NO libvirt).
#
# Verifies Windows/WebView2 behavior the Linux/Chromium suites can't exercise
# (native drag-drop into folders, the NSIS installer, clean-machine launch).
# See README.md in this dir for the full tooling decisions.
#
# Scripts live in the repo (scripts/win-vm/); the heavy artifacts (ISOs, disk,
# frames) live in the DATA dir $WIN_VM_DIR (default ~/Developer/win-vm), kept
# OUT of the repo. Stage there: Win11.iso, virtio-win.iso, app.iso, and the
# quickget `windows-11-English-United-States/unattended.iso`.
#
# UEFI (OVMF) + emulated TPM 2.0 (swtpm). SATA system disk so the unattended
# install doesn't depend on virtio driver-injection. Drive order matches the
# quickemu autounattend.xml: D:=Win11.iso E:=virtio-win F:=unattended G:=app.
# Control via QMP at $WIN_VM_DIR/run/qmp.sock; watch via VNC on :10 (port 5910).
set -euo pipefail
DIR="${WIN_VM_DIR:-$HOME/Developer/win-vm}"
RUN="$DIR/run"; mkdir -p "$RUN"
DISK="$RUN/win11.qcow2"
VARS="$RUN/OVMF_VARS.fd"
TPMSOCK="$RUN/swtpm-sock"
TPMSTATE="$RUN/tpm"; mkdir -p "$TPMSTATE"
QMP="$RUN/qmp.sock"
WIN_ISO="$DIR/Win11.iso"
VIRTIO_ISO="$DIR/virtio-win.iso"
UNATTEND_ISO="$DIR/windows-11-English-United-States/unattended.iso"
APP_ISO="$DIR/app.iso"
# OVMF firmware paths below are Fedora's (edk2-ovmf package); override
# OVMF_CODE / OVMF_VARS_SRC for other distros (e.g. /usr/share/OVMF/).
OVMF_CODE="${OVMF_CODE:-/usr/share/edk2/ovmf/OVMF_CODE.fd}"
OVMF_VARS_SRC="${OVMF_VARS_SRC:-/usr/share/edk2/ovmf/OVMF_VARS.fd}"

[ -f "$DISK" ] || qemu-img create -f qcow2 "$DISK" 64G >/dev/null
[ -f "$VARS" ] || cp "$OVMF_VARS_SRC" "$VARS"

# swtpm (TPM 2.0) socket — start once.
if [ ! -S "$TPMSOCK" ]; then
  swtpm socket --tpmstate dir="$TPMSTATE" --ctrl type=unixio,path="$TPMSOCK" \
    --tpm2 --flags startup-clear --daemon
fi

exec qemu-system-x86_64 \
  -name futo-win11 \
  -machine q35,smm=on,accel=kvm \
  -cpu host -smp 4 -m 8192 \
  -drive if=pflash,format=raw,readonly=on,file="$OVMF_CODE" \
  -drive if=pflash,format=raw,file="$VARS" \
  -chardev socket,id=chrtpm,path="$TPMSOCK" \
  -tpmdev emulator,id=tpm0,chardev=chrtpm \
  -device tpm-crb,tpmdev=tpm0 \
  -device ich9-ahci,id=sata \
  -drive id=hdd,if=none,file="$DISK",format=qcow2 \
  -device ide-hd,drive=hdd,bus=sata.0,bootindex=2 \
  -drive id=win,if=none,media=cdrom,readonly=on,file="$WIN_ISO" \
  -device ide-cd,drive=win,bus=sata.1,bootindex=1 \
  -drive id=virtio,if=none,media=cdrom,readonly=on,file="$VIRTIO_ISO" \
  -device ide-cd,drive=virtio,bus=sata.2 \
  -drive id=unatt,if=none,media=cdrom,readonly=on,file="$UNATTEND_ISO" \
  -device ide-cd,drive=unatt,bus=sata.3 \
  -drive id=app,if=none,media=cdrom,readonly=on,file="$APP_ISO" \
  -device ide-cd,drive=app,bus=sata.4 \
  -device qemu-xhci,id=xhci \
  -device usb-tablet,bus=xhci.0 \
  -device usb-kbd,bus=xhci.0 \
  -netdev user,id=net0 -device e1000e,netdev=net0 \
  -vga std \
  -vnc :10 \
  -qmp unix:"$QMP",server,nowait \
  -monitor none -serial null \
  -rtc base=localtime
