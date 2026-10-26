// Shell boundaries for the macOS runner. User values are literals; only HOME
// expansion in a configured repository path is supported.
// Templates contain standalone PY delimiters: use apply_patch or a distinct
// outer heredoc delimiter when editing them from another generated script.
import path from 'node:path';
import { shQuote } from '../remote-test/remote-env.mjs';

export function shellPath(value) {
  if (value.startsWith('$HOME/')) return `"$HOME"/${shQuote(value.slice(6))}`;
  if (value.startsWith('~/')) return `"$HOME"/${shQuote(value.slice(2))}`;
  if (!path.posix.isAbsolute(value))
    throw new Error('Mac repository path must be absolute or start with $HOME/ or ~/');
  return shQuote(value);
}

export function macEnvironment(pin) {
  if (!/^\d+\.\d+\.\d+$/.test(pin)) throw new Error('Invalid Node version pin');
  return `export PATH="$HOME/.nvm/versions/node/v${pin}/bin:/opt/homebrew/bin:$HOME/.cargo/bin:$HOME/bin:$PATH"\n`;
}

export function preflightScript({ pin, repo, id, spaceSource, minFreeGiB }) {
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(spaceSource).toString('base64');
  const checkSpace = `try {
    const { checkIosBuildSpace } = await import(${JSON.stringify(moduleUrl)});
    const r = checkIosBuildSpace({ targetDir: process.argv[1], minFreeGiB: Number(process.argv[2]) });
    console.error('iOS build storage: ' + r.availableGiB.toFixed(1) + ' GiB free at ' + r.probe);
  } catch (error) { console.error(error.message); process.exitCode = 1; }`;
  return `set -euo pipefail
${macEnvironment(pin)}
[ "$(uname -s)" = Darwin ] || { echo 'ios-remote requires a macOS host' >&2; exit 2; }
for tool in node pnpm just git python3 tar xcodegen xcrun; do
  command -v "$tool" >/dev/null || { echo "Missing on Mac: $tool" >&2; exit 2; }
done
[ "$(node --version)" = ${shQuote(`v${pin}`)} ] || { echo 'Install the pinned Node version on the Mac (just setup ios)' >&2; exit 2; }
xcrun --find xcodebuild >/dev/null
SOURCE_REPO=${shellPath(repo)}
PRIMARY=$(dirname "$(git -C "$SOURCE_REPO" rev-parse --path-format=absolute --git-common-dir)")
REMOTE_DIR="$(dirname "$PRIMARY")/$(basename "$PRIMARY")-remote-ios-${id}"
DISK_TARGET="$SOURCE_REPO/target"
[ ! -d "$REMOTE_DIR" ] || DISK_TARGET="$REMOTE_DIR/target"
node --input-type=module --eval ${shQuote(checkSpace)} -- "$DISK_TARGET" ${shQuote(minFreeGiB)}
mkdir -p "$HOME/.cache/futo-ios-remote"
RUN_DIR=$(mktemp -d "$HOME/.cache/futo-ios-remote/run.XXXXXX")
python3 -c 'import json,sys; print(json.dumps(dict(zip(["runDir","remoteDir"],sys.argv[1:]))))' "$RUN_DIR" "$REMOTE_DIR"
`;
}

export function bootstrapScript({
  pin,
  repo,
  id,
  sha,
  digest,
  runDir,
  remoteDir,
  bundle,
  minFreeGiB,
  forwarded = {},
}) {
  return `set -euo pipefail
${macEnvironment(pin)}
SOURCE_REPO=${shellPath(repo)}
RUN_DIR=${shQuote(runDir)}
REMOTE_DIR=${shQuote(remoteDir)}
export FUTO_IOS_MIN_FREE_GIB=${shQuote(minFreeGiB)}
unset FUTO_IOS_TEST_LOCK_FD CARGO_TARGET_DIR
${Object.entries(forwarded)
  .map(([key, value]) => `export ${key}=${shQuote(value)}`)
  .join('\n')}
cleanup() {
${cleanupScript(runDir)}
}
finish() {
  result=$?
  trap - EXIT
  set +e
  cleanup
  cleanup_result=$?
  [ "$result" -ne 0 ] || result=$cleanup_result
  exit "$result"
}
trap finish EXIT
[ "$(shasum -a 256 "$RUN_DIR/source.tar.gz" | awk '{print $1}')" = ${shQuote(digest)} ] || { echo 'Source snapshot checksum mismatch' >&2; exit 1; }
git -C "$SOURCE_REPO" fetch --quiet origin main
${bundle ? 'git -C "$SOURCE_REPO" fetch --quiet "$RUN_DIR/source.bundle" HEAD' : ''}
git -C "$SOURCE_REPO" cat-file -e ${shQuote(`${sha}^{commit}`)}
if [ ! -e "$REMOTE_DIR" ]; then
  node "$RUN_DIR/space.mjs" "$SOURCE_REPO/target"
  (cd "$SOURCE_REPO" && just wt new ${shQuote(`remote-ios-${id}`)} --branch "remote-ios/${id}-$(basename "$RUN_DIR")" --base ${shQuote(sha)} --no-install --no-target)
  OWNER=$(git -C "$REMOTE_DIR" rev-parse --git-path futo-ios-remote-owner)
  case "$OWNER" in /*) ;; *) OWNER="$REMOTE_DIR/$OWNER" ;; esac
  printf '%s\n' ${shQuote(id)} > "$OWNER"
fi
OWNER=$(git -C "$REMOTE_DIR" rev-parse --git-path futo-ios-remote-owner)
case "$OWNER" in /*) ;; *) OWNER="$REMOTE_DIR/$OWNER" ;; esac
[ "$(cat "$OWNER")" = ${shQuote(id)} ] || { echo 'Refusing a remote checkout not owned by this local worktree' >&2; exit 2; }
cd "$REMOTE_DIR"
node "$RUN_DIR/space.mjs" target
RUNNER_PID=''
stop_run() {
  if [ -n "$RUNNER_PID" ]; then kill -TERM "$RUNNER_PID" 2>/dev/null || :; wait "$RUNNER_PID" || :; fi
  exit 143
}
trap stop_run HUP INT TERM
set +e
python3 "$RUN_DIR/session.py" -- bash "$RUN_DIR/run.sh" "$REMOTE_DIR" "$RUN_DIR" "$@" &
RUNNER_PID=$!
wait "$RUNNER_PID"
result=$?
trap - HUP INT TERM
exit "$result"
`;
}

export function cleanupScript(runDir) {
  return `python3 - ${shQuote(runDir)} <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1])
if root.exists():
    for name in ('source.tar.gz','source.bundle','manifest.json','session.py','apply.py','space.mjs','run.sh'):
        (root/name).unlink(missing_ok=True)
    root.rmdir()
PY
`;
}

export function runScript({ sha, id, digest }) {
  return `#!/usr/bin/env bash
set -euo pipefail
REMOTE_DIR="$1"; RUN_DIR="$2"; RECIPE="$3"; shift 3
cd "$REMOTE_DIR"
# Reset only metadata/index: source files are replaced by the allowlisted
# archive below, never by a recursive checkout/clean of generated state.
git reset --mixed ${shQuote(sha)} >/dev/null
python3 "$RUN_DIR/apply.py" "$REMOTE_DIR" "$RUN_DIR/manifest.json" "$RUN_DIR/source.tar.gz"
echo ${shQuote(`[ios-remote] source sha=${sha} snapshot=${digest} worktree=${id}`)}
if ! cmp -s pnpm-lock.yaml node_modules/.pnpm/lock.yaml; then
  pnpm install --frozen-lockfile
fi
node scripts/check-node-modules.mjs
just editor-deps
CLAIMED=0
release_device() {
  result=$?
  trap - EXIT
  if [ "$CLAIMED" -eq 1 ]; then
    if ! just qa-release ios; then [ "$result" -ne 0 ] || result=1; fi
  fi
  exit "$result"
}
trap release_device EXIT
case "$RECIPE" in
  test-ios-*)
    # A failed boot can still leave a pending claim owned by this worktree.
    CLAIMED=1
    claim_exports=$(just qa-claim ios)
    eval "$claim_exports"
    ;;
esac
just "$RECIPE" "$@"
`;
}
