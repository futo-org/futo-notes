#!/usr/bin/env bash
# Owned executable fixture for ci-android-sync-leg.test.mjs. Keep each adb
# invocation a real killable process, but do not start a Node interpreter for
# every identity/readiness query: delayed interpreter startups reproduce the
# 5s whole-test timeout seen in pipeline39084, job281701. This does not establish
# the original CI host's exact scheduling conditions.
set -euo pipefail

file="$FAKE_ADB_STATE"
IFS= read -r state < "$file" || [[ -n "$state" ]]
# The test writes this fixed, flat JSON shape; values are numbers, booleans,
# simple phase names and integer arrays. This is not an Android/JSON parser.
field() {
  local tail="${state#*\"$1\":}"
  [[ "$tail" != "$state" ]] || tail=""
  tail="${tail%%,*}"
  tail="${tail%%\}*}"
  tail="${tail#\"}"
  tail="${tail%\"}"
  printf -v "$1" '%s' "$tail"
}
for key in generation pid phase sinceRestart installed installAttempts stallAt pmStalled pmCompleted transportProbesAfterStall failAbandon interruptStateWrite healthyPmDelay; do
  field "$key"
done
booted="${state#*\"booted\":[}"
booted="${booted%%]*}"
restartOnInstall="${state#*\"restartOnInstall\":[}"
restartOnInstall="${restartOnInstall%%]*}"
[[ "${1:-}" != -s ]] || shift 2
sinceRestart=$((sinceRestart + 1))
if [[ "$phase" == down && "$sinceRestart" -gt 2 ]]; then phase=starting; fi
if [[ "$phase" == starting && "$sinceRestart" -gt 5 ]]; then
  phase=up
  booted="$booted,$pid"
fi

# A FIFO opened for reading AND writing stays unreadable without leaving a
# sleep child holding stdout open. Bash's own timed read is killed with adb.
# Use an integer timeout for the system Bash3 on macOS; both faults exceed the
# existing deliberately injected 250ms package-probe deadline.
stall() {
  exec 4<>"$FAKE_ADB_WAIT"
  read -r -t 1 <&4 || :
  exec 4>&-
}
save() {
  local target="$file.$$.next"
  exec 3>"$target"
  if [[ "$interruptStateWrite" == true && "$pmStalled" == true && ! -e "$file.interrupted" ]]; then
    : > "$file.interrupted"
    stall
  fi
  printf '{"generation":%s,"pid":%s,"phase":"%s","sinceRestart":%s,"booted":[%s],"installed":%s,"installAttempts":%s,"restartOnInstall":[%s],"stallAt":"%s","pmStalled":%s,"pmCompleted":%s,"transportProbesAfterStall":%s,"failAbandon":%s,"interruptStateWrite":%s,"healthyPmDelay":%s}' \
    "$generation" "$pid" "$phase" "$sinceRestart" "$booted" "$installed" "$installAttempts" "$restartOnInstall" "$stallAt" "$pmStalled" "$pmCompleted" "$transportProbesAfterStall" "$failAbandon" "$interruptStateWrite" "$healthyPmDelay" >&3
  exec 3>&-
  mv "$target" "$file"
}
out() {
  save
  [[ -z "$1" ]] || printf '%s\n' "$1"
  exit "${2:-0}"
}
gone="cmd: Can't find service: package"
cmd="$*"
if [[ "$cmd" == 'shell pm '* && "$healthyPmDelay" -gt 0 ]]; then
  printf -v pause '%d.%03d' "$((healthyPmDelay / 1000))" "$((healthyPmDelay % 1000))"
  /bin/sleep "$pause"
fi
case "$cmd" in
  get-state)
    if [[ "$pmStalled" == true ]]; then transportProbesAfterStall=$((transportProbesAfterStall + 1)); fi
    out device ;;
  'emu avd name') out $'ci\nOK' ;;
  'emu kill') out '' ;;
  'shell getprop sys.boot_completed') out 1 ;;
  'shell getprop sys.system_server.start_count') out "$generation" ;;
  'shell pidof system_server')
    [[ "$phase" != down ]] || out '' 1
    out "$pid" ;;
  'shell service check package')
    [[ "$phase" != down ]] || out 'Service package: not found'
    out 'Service package: found' ;;
  'shell pm list packages'*)
    if [[ "$pmStalled" == false ]] && { [[ "$stallAt" == framework && "$installed" == false ]] || [[ "$stallAt" == post-install && "$installed" == true ]]; }; then
      pmStalled=true
      save
      stall
      pmCompleted=true
    fi
    [[ "$phase" != down ]] || out "$gone" 1
    [[ "$installed" != true ]] || out $'package:android\npackage:com.futo.notes.dev'
    out package:android ;;
  'shell pm install-create')
    [[ "$phase" != down ]] || out "$gone" 1
    out 'Success: created install session [42]' ;;
  'shell pm install-abandon'*)
    [[ "$failAbandon" != true ]] || out 'Failure: cleanup failed' 1
    out Success ;;
  'logcat -b events -d -v threadtime')
    events=''
    for boot_pid in ${booted//,/ }; do
      printf -v line '10-08 16:10:21.794  %s  %s I boot_progress_enable_screen: 1234' "$boot_pid" "$((boot_pid + 1))"
      events="$events$line"$'\n'
    done
    out "${events%$'\n'}" ;;
  logcat*) out '' ;;
  install*)
    installAttempts=$((installAttempts + 1))
    case ",$restartOnInstall," in
      *",$installAttempts,"*)
        generation=$((generation + 1))
        pid=$((pid + 100))
        phase=down
        sinceRestart=0
        out $'Performing Streamed Install\nadb: failed to install '"${!#}: $gone" 1 ;;
    esac
    [[ "$phase" == up ]] || out "Exception occurred while executing 'install':"$'\n'"java.lang.NullPointerException: Attempt to invoke virtual method 'void android.content.pm.PackageManagerInternal.freeStorage(java.lang.String, long, int)' on a null object reference" 1
    installed=true
    out $'Performing Streamed Install\nSuccess' ;;
esac
out "fake adb: unhandled $cmd" 2
