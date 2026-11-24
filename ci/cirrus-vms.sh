#!/bin/bash
# Disk hygiene for the shared macscript runners (other FUTO teams use them).
#
#   report       df, VM dirs, image cache, Tart/Cirrus dir sizes (read-only, no tart calls)
#   cleanup-job  after_script: delete the VMs THIS job's `cirrus run` cloned
#   sweep        delete our ledger's stopped VMs older than 6 h
#   clean        sweep, with df before and after
#
# A VM counts as ours only if ci/tart-shim/tart recorded its clone in the
# ledger from a futo-notes/futo-notes job. The `cirrus-cli-` name prefix is not
# proof: every Cirrus CLI user on the host gets it. Nothing here runs `tart
# prune` or touches an image. tart runs only for a VM we are deleting (the
# stop/delete the Cirrus CLI makes when it cleans up after itself), via tart_on_our_vm.
set -u

LEDGER="$HOME/.futo-notes-ci/tart-vms"
OUR_PROJECT=futo-notes/futo-notes
TART_DIR="${TART_HOME:-$HOME/.tart}"
# Cirrus CLI keys its cache dir by the checkout's basename (build.go: cache.New),
# so a fork shares it: reported, never deleted.
CIRRUS_CACHE="$HOME/Library/Caches/cirrus/projects/futo-notes"
STALE_MIN=360
VM_NAME_RE='^cirrus-cli-[0-9]+-[0-9A-Fa-f-]{36}$'
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# `tart run` holds a lock on the VM's config.json for its whole life
# (VMDirectory.running); any process holding it open counts as in use.
vm_in_use() {
  [ -n "$(lsof -t "$TART_DIR/vms/$1/config.json" 2>/dev/null)" ]
}

ledger_ok() {
  [ -d "$LEDGER" ] && [ ! -L "$LEDGER" ] && [ ! -L "$(dirname "$LEDGER")" ]
}

# Ledger entries are plain files named after the VM; anything else is skipped.
ledger_entries() {
  ledger_ok || return 0
  find -P "$LEDGER" -mindepth 1 -maxdepth 1 -type f "$@" -print0
}

ledger_field() {
  sed -n "s/^$2=//p" "$1" | head -1
}

# The entry must name a Cirrus clone that one of our jobs made in this Tart home.
recorded_by_us() {
  local f=$1 name
  name=$(basename "$f")
  [[ $name =~ $VM_NAME_RE ]] || { echo "skip $name: not a Cirrus clone name"; return 1; }
  [ "$(ledger_field "$f" project)" = "$OUR_PROJECT" ] || { echo "skip $name: other project"; return 1; }
  [ "$(ledger_field "$f" tart_home)" = "$TART_DIR" ] || { echo "skip $name: other Tart home"; return 1; }
}

# And the VM dir must be the very directory the shim saw `tart clone` create:
# a real directory (not a symlink) with the inode it recorded.
provably_ours() {
  local f=$1 name inode vm
  name=$(basename "$f")
  vm="$TART_DIR/vms/$name"
  inode=$(ledger_field "$f" inode)
  [[ $inode =~ ^[0-9]+$ ]] && [ -d "$vm" ] && [ ! -L "$vm" ] && [ "$(stat -f %i "$vm")" = "$inode" ] ||
    { echo "skip $name: not the VM dir our clone created"; return 1; }
}

# Only a ledger entry whose VM no longer exists may be dropped unproven.
drop_if_gone() {
  local name
  name=$(basename "$1")
  if [ ! -e "$TART_DIR/vms/$name" ] && [ ! -L "$TART_DIR/vms/$name" ]; then
    echo "$name already gone; dropping its ledger entry"
    rm -f "$1"
    return 0
  fi
  return 1
}

# Every tart command but pull/clone first deletes the UNLOCKED entries of
# ~/.tart/tmp, and a clone creates its entry a moment before locking it
# (Config.gc, Clone.swift). So call tart only while no entry is that new; an
# older unlocked entry is one Tart itself already treats as garbage.
tart_tmp_settled() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    [ -z "$(find -P "$TART_DIR/tmp" -mindepth 1 -maxdepth 1 -Btime -30s 2>/dev/null)" ] && return 0
    sleep 5
  done
  echo "skip: ~/.tart/tmp keeps getting new entries" >&2
  return 1
}

# Re-proves ownership after the wait, right before each name-based call.
tart_on_our_vm() {
  local f=$1
  shift
  tart_tmp_settled && provably_ours "$f" && tart "$@"
}

delete_vm() {
  local f=$1 name
  name=$(basename "$f")
  echo "deleting VM $name ($(du -sh "$TART_DIR/vms/$name" 2>/dev/null | cut -f1))"
  tart_on_our_vm "$f" delete "$name" || return 1
  if [ -e "$TART_DIR/vms/$name" ]; then
    echo "ERROR: $name still exists after delete" >&2
    return 1
  fi
}

report() {
  echo "host=$(hostname) runner=${CI_RUNNER_ID:-?} ${CI_RUNNER_DESCRIPTION:-} TART_HOME=${TART_HOME:-unset}"
  df -h / "$HOME"
  echo "--- VM dirs: logical size (APFS clones share blocks with their image), born, disk last written, name"
  for d in "$TART_DIR"/vms/*; do
    [ -e "$d" ] && echo "$(du -sh "$d" | cut -f1) born $(stat -f '%SB' "$d") written $(stat -f '%Sm' "$d/disk.img" 2>/dev/null) $(basename "$d")"
  done
  echo "--- OCI image cache"
  du -sh "$TART_DIR"/cache/OCIs/*/*/* "$TART_DIR"/cache/OCIs/*/*/*/* 2>/dev/null
  echo "--- totals"
  du -sh "$TART_DIR"/tmp "$TART_DIR"/cache "$TART_DIR"/vms 2>/dev/null
  echo "--- Cirrus CLI cache"
  du -sh "$HOME"/Library/Caches/cirrus/* "$HOME"/Library/Caches/cirrus/projects/* 2>/dev/null
  ls -lT "$CIRRUS_CACHE" 2>/dev/null
  echo "--- our ledger"
  ls -lT "$LEDGER" 2>/dev/null
  echo "--- builds dir: total, checkouts of other projects with a Cirrus config, ours"
  du -sh "${CI_BUILDS_DIR:-/nonexistent}" 2>/dev/null | cut -f1
  local p n=0
  for p in "${CI_BUILDS_DIR:-/nonexistent}"/*/*/*/*; do
    [ -d "$p" ] || continue
    if [ "${p%/"$OUR_PROJECT"}" != "$p" ]; then
      echo "ours: $(du -sh "$p" 2>/dev/null | cut -f1)"
    elif [ -e "$p/.cirrus.yml" ] || [ -e "$p/.cirrus.star" ]; then
      n=$((n + 1))
    fi
  done
  echo "other projects with a Cirrus config: $n"
}

sweep() {
  local f name rc=0
  # Only entries untouched for STALE_MIN: no job outlives its 90 min timeout.
  while IFS= read -r -d '' f; do
    name=$(basename "$f")
    recorded_by_us "$f" || continue
    drop_if_gone "$f" && continue
    provably_ours "$f" || continue
    if vm_in_use "$name" || [ -e "$TART_DIR/vms/$name/state.vzvmsave" ]; then
      echo "sweep: $name is running or suspended; leaving it"
    elif delete_vm "$f"; then # tart delete itself refuses a running VM
      rm -f "$f"
    else
      rc=1
    fi
  done < <(ledger_entries -mmin +"$STALE_MIN")
  return $rc
}

# The shim lists this job's clones in its own checkout as well as the ledger.
cleanup_job() {
  local list="${CI_PROJECT_DIR:-}/.cirrus-vms" name f rc=0
  [ -n "${CI_PROJECT_DIR:-}" ] && [ -f "$list" ] && [ ! -L "$list" ] && ledger_ok || return 0
  while IFS= read -r name; do
    [[ $name =~ $VM_NAME_RE ]] || continue
    f="$LEDGER/$name"
    [ -f "$f" ] && [ ! -L "$f" ] && [ "$(ledger_field "$f" job)" = "${CI_JOB_ID:-}" ] || continue
    recorded_by_us "$f" || continue
    drop_if_gone "$f" && continue
    provably_ours "$f" || continue
    # This job's own VM, and the job is over.
    ! vm_in_use "$name" || tart_on_our_vm "$f" stop --timeout 10 "$name"
    delete_vm "$f" && rm -f "$f" || rc=1
  done < "$list"
  return $rc
}

clean() {
  df -h /
  sweep
  local rc=$?
  df -h /
  return $rc
}

case "${1:-}" in
  report) report ;;
  sweep) sweep ;;
  cleanup-job) cleanup_job ;;
  clean) clean ;;
  *) echo "usage: $0 report|sweep|cleanup-job|clean" >&2; exit 2 ;;
esac
