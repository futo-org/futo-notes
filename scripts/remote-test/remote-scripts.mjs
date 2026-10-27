// remote-test.mjs remote shell scripts: the lock / run / unlock phases of the two-phase
// protocol, and the kill script.
import { remoteEnvPreamble, shQuote } from './remote-env.mjs';
import { EXIT_LOCKED, EXIT_MOVED, EXIT_REFUSED } from './settings.mjs';

// ---------------------------------------------------------------------------
// Remote scripts
// ---------------------------------------------------------------------------

// Run before locking or transferring: missing fnm is a host setup problem, not
// a failed suite. Node itself is activated from .nvmrc only after checkout.
export function buildNodePreflightScript({ ndkVersion }) {
  return `
set -uo pipefail
${remoteEnvPreamble({ ndkVersion })}
if ! command -v fnm >/dev/null 2>&1; then
  echo "remote-test: fnm is missing; install fnm on the remote host or set FNM_DIR to its install directory." >&2
  echo "  Run node scripts/remote-test.mjs --doctor for the install command before retrying." >&2
  exit ${EXIT_REFUSED}
fi
`;
}

// Phase 1 of the two-phase remote protocol: take the worktree lock in its OWN
// ssh session, BEFORE any transfer.
//
// rsync mode used to push the working tree (with --delete) before the run
// script ran, and the run script was what took the lock. So a run queued behind
// `--wait` deleted and rewrote the checkout that the run in flight was actively
// using. That is not a lost start-up race — it CORRUPTS the running job: a
// sibling agent's transfer removed a file an in-flight 300-doc run depended on,
// vite reported "Failed to resolve import ... Does the file exist?", and the run
// degraded into 100+ failures that all looked like product bugs. Two separate
// runs died that way. The HEAD_BEFORE/HEAD_AFTER guard cannot catch it either,
// because rsync mode never moves HEAD.
//
// The lock is a mkdir lockdir (atomic, no flock needed), so it survives between
// ssh sessions. `nonce` ties it to this run: phase 2 rsyncs, then phase 3 adopts
// the lock only if the nonce still matches, and owns its release. If we die
// between phases the lock leaks — bounded by the holder file, which records
// phase=transfer and a timestamp so the next user can see it is stale and clear
// it with --force-lock.
export function buildLockScript({ remoteDir, holder, forceLock, waitSeconds = 0, nonce }) {
  const lockDir = `${remoteDir}.lock`;
  return `
set -uo pipefail

LOCK_DIR="${lockDir}"
WAIT_SECS=${waitSeconds}

show_holder() {
  if [ -f "$LOCK_DIR/holder" ]; then
    sed 's/^/    /' "$LOCK_DIR/holder" >&2
  else
    echo "    (lock dir exists but has no holder file — probably stale)" >&2
  fi
}

${forceLock ? 'rm -rf "$LOCK_DIR"' : ''}
mkdir -p "$(dirname "$LOCK_DIR")"
# mkdir is the atomic primitive (no flock dependency, works over plain ssh).
DEADLINE=$(( $(date +%s) + WAIT_SECS ))
ANNOUNCED=0
while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  if [ "$ANNOUNCED" -eq 0 ]; then
    echo "remote-test: the remote worktree is already in use:" >&2
    show_holder
    ANNOUNCED=1
  fi
  if [ "$WAIT_SECS" -eq 0 ] || [ "$(date +%s)" -ge "$DEADLINE" ]; then
    if [ "$WAIT_SECS" -eq 0 ]; then
      echo "  Re-run with --wait to queue behind it, or --force-lock if it is stale." >&2
    else
      echo "  Still locked after ${'$'}{WAIT_SECS}s — giving up." >&2
    fi
    exit ${EXIT_LOCKED}
  fi
  echo "  waiting for it to finish (up to ${'$'}{WAIT_SECS}s)..." >&2
  sleep 10
done
printf '%s\\n' ${shQuote(holder)} > "$LOCK_DIR/holder"
printf '%s\\n' ${shQuote(nonce)} > "$LOCK_DIR/nonce"
`;
}

// Reap ONLY the run recorded in this worktree's lock: signal its process group,
// never a pattern match. `--kill` is for a run that is genuinely wedged; it
// leaves the lock in place if the group is already gone so a normal exit can
// still clean up after itself.
export function buildKillScript({ remoteDir }) {
  const lockDir = `${remoteDir}.lock`;
  return `
set -u
LOCK_DIR="${lockDir}"
if [ ! -d "$LOCK_DIR" ]; then
  echo "remote-test: no run is holding the lock — nothing to kill." >&2
  exit 0
fi
echo "remote-test: lock holder:" >&2
sed 's/^/    /' "$LOCK_DIR/holder" 2>/dev/null || echo "    (no holder file)" >&2
PGID="$(cat "$LOCK_DIR/pgid" 2>/dev/null || true)"
if [ -z "$PGID" ]; then
  echo "remote-test: the holder recorded no process group (it may still be transferring)." >&2
  echo "  Nothing was signaled. Use --force-lock if you are certain it is stale." >&2
  exit 0
fi
if ! kill -0 "-$PGID" 2>/dev/null; then
  echo "remote-test: process group $PGID is already gone; leaving the lock alone." >&2
  exit 0
fi
echo "remote-test: sending TERM to process group $PGID" >&2
kill -TERM "-$PGID" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "-$PGID" 2>/dev/null || break
  sleep 1
done
if kill -0 "-$PGID" 2>/dev/null; then
  echo "remote-test: still alive after 10s — sending KILL" >&2
  kill -KILL "-$PGID" 2>/dev/null || true
fi
rm -rf "$LOCK_DIR"
echo "remote-test: killed process group $PGID and released the lock." >&2
`;
}

// Release a lock we still own (nonce match). Used when we fail between phases,
// so a transfer error does not strand the worktree locked.
export function buildUnlockScript({ remoteDir, nonce }) {
  const lockDir = `${remoteDir}.lock`;
  return `
set -u
LOCK_DIR="${lockDir}"
if [ "$(cat "$LOCK_DIR/nonce" 2>/dev/null)" = ${shQuote(nonce)} ]; then
  rm -rf "$LOCK_DIR"
fi
`;
}

export function buildRunScript({
  remoteDir,
  sourceRepo,
  mode,
  sha,
  recipe,
  recipeArgs = [],
  nonce,
  ndkVersion,
}) {
  const lockDir = `${remoteDir}.lock`;
  const justArgs = [recipe, ...recipeArgs].map(shQuote).join(' ');
  return `
set -uo pipefail
${remoteEnvPreamble({ ndkVersion })}

REMOTE_DIR="${remoteDir}"
SOURCE_REPO="${sourceRepo}"
LOCK_DIR="${lockDir}"
LOCK_NONCE="${nonce}"

show_holder() {
  # Redirections apply left to right, so silencing stderr BEFORE aiming stdout
  # at it points fd1 into the void and swallows the holder — the one thing a
  # blocked user needs. Test it, don't remember it.
  if [ -f "$LOCK_DIR/holder" ]; then
    sed 's/^/    /' "$LOCK_DIR/holder" >&2
  else
    echo "    (lock dir exists but has no holder file — probably stale)" >&2
  fi
}

# The lock is acquired by buildLockScript() in a SEPARATE ssh session before
# this one, so that an rsync-mode transfer happens UNDER the lock. Adopt it
# here (verifying it is still ours via the nonce) and own its release.
if [ ! -d "$LOCK_DIR" ] || [ "$(cat "$LOCK_DIR/nonce" 2>/dev/null)" != "$LOCK_NONCE" ]; then
  echo "remote-test: lost the worktree lock before the run started." >&2
  show_holder
  exit ${EXIT_LOCKED}
fi
trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM HUP

set -e
if [ ! -d "$REMOTE_DIR" ]; then
  echo "==> creating remote worktree $REMOTE_DIR from $SOURCE_REPO"
  git -C "$SOURCE_REPO" fetch --quiet origin
  git -C "$SOURCE_REPO" worktree add --detach "$REMOTE_DIR" ${shQuote(sha)}
fi
cd "$REMOTE_DIR"

${
  mode === 'git'
    ? `echo "==> git mode: fetch + detach at ${sha}"
git fetch --quiet origin
git -c advice.detachedHead=false checkout --force --detach ${shQuote(sha)}`
    : `echo "==> rsync mode: using the tree rsync just pushed (local HEAD ${sha})"`
}

# The lock only binds users who go through remote-test. A human (or an agent)
# who cd's into the worktree and checks out something else corrupts the run in a
# way that looks EXACTLY like a real test failure — it happened: a concurrent
# main-health check reported 5 phantom failures and two "Cannot find module"
# suites purely because HEAD moved underneath it. So pin HEAD now and re-check
# it after, turning that class of corruption into an explicit error.
HEAD_BEFORE="$(git rev-parse HEAD)"
${
  mode === 'git'
    ? `if [ "$HEAD_BEFORE" != ${shQuote(sha)} ]; then
  echo "remote-test: FATAL — checkout landed on $HEAD_BEFORE, not the requested ${sha}." >&2
  exit ${EXIT_MOVED}
fi`
    : ''
}

# .nvmrc exists only once the worktree is checked out, so this cannot live in the
# preamble (whose CWD is $HOME). It must precede the install below, or native
# modules compile against the box default and the pin buys nothing.
if ! fnm use --install-if-missing; then
  echo "remote-test: could not activate the Node version in .nvmrc; repair fnm on the remote host and run node scripts/remote-test.mjs --doctor." >&2
  exit ${EXIT_REFUSED}
fi
if ! command -v node >/dev/null 2>&1; then
  echo "remote-test: node is missing after fnm activation; repair the remote fnm installation and run node scripts/remote-test.mjs --doctor." >&2
  exit ${EXIT_REFUSED}
fi

# pnpm install only when the lockfile actually moved: it is 40s that most runs
# do not need, and skipping it silently would be worse than paying it. The stamp
# lives OUTSIDE the checkout so it can never dirty the tree or confuse a
# \`git status\` check.
STAMP_DIR="$HOME/.cache/futo-remote-test"
mkdir -p "$STAMP_DIR"
STAMP="$STAMP_DIR/pnpm-lock-$(basename "$REMOTE_DIR")"
LOCK_HASH="$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)"
if [ ! -d node_modules ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$LOCK_HASH" ]; then
  echo "==> pnpm install (lockfile changed or node_modules missing)"
  pnpm install
  printf '%s\\n' "$LOCK_HASH" > "$STAMP"
fi
rm -f .remote-test-pnpm-lock-hash  # legacy in-tree stamp; do not leave it lying around

# M20: cargo needs a repo-root dist/ to exist.
mkdir -p dist

echo "==> node $(node --version) | pnpm $(pnpm --version) | cargo $(cargo --version | cut -d' ' -f2) | $(nproc) cores"
echo "==> ANDROID_NDK_HOME=$ANDROID_NDK_HOME"
echo "==> JAVA_HOME=\${JAVA_HOME:-<unset: gradle will use whatever java is on PATH>}"
echo "==> cargo target: $REMOTE_DIR/target (repo-local, warm across runs)"
echo
echo "───────────────────── just ${recipe} ─────────────────────"
set +e
# Own process group, with its pgid recorded next to the lock.
#
# Cleaning up a hung remote run used to mean a broad pattern kill
# (pkill -f chrome-headless-shell), which on a box several agents share would
# also kill a SIBLING's browsers -- the lock stops two runs colliding but gave
# no way to reap just this run's processes (pc_6b79075ff9ba). setsid puts the
# whole recipe in one group, so 'node scripts/remote-test.mjs --kill' signals exactly this run.
#
# 'set -m' (job control), NOT setsid: setsid is not installed everywhere --
# macOS has no such binary -- and a missing one here would break EVERY remote
# run, not just cleanup. With job control on, bash puts a background job in its
# own process group whose pgid equals the job leader's pid, using nothing
# external.
set -m
just ${justArgs} &
RECIPE_PID=$!
set +m
echo "$RECIPE_PID" > "$LOCK_DIR/pgid" 2>/dev/null || true
wait "$RECIPE_PID"
STATUS=$?
rm -f "$LOCK_DIR/pgid" 2>/dev/null || true
set -e
echo "───────────────────── just ${recipe} exited $STATUS ─────────────────────"

HEAD_AFTER="$(git rev-parse HEAD)"
if [ "$HEAD_BEFORE" != "$HEAD_AFTER" ]; then
  echo "remote-test: FATAL — $REMOTE_DIR moved from $HEAD_BEFORE to $HEAD_AFTER DURING the run." >&2
  echo "  Something outside remote-test checked this worktree out mid-suite, so the result above" >&2
  echo "  is VOID — do not read it as a pass or a failure." >&2
  echo "  $REMOTE_DIR is the runner's own working area; drive it only through remote-test." >&2
  exit ${EXIT_MOVED}
fi
exit $STATUS
`;
}

// The browser builds THIS repo pins, as directory names under
// ~/.cache/ms-playwright ("chromium-1208", "webkit-2248").
//
// The doctor used to list whatever browsers existed on the remote and call that
// [ok]. A green doctor therefore promised a playwright run that then failed
// asking for `playwright install chromium`, because the installed build was not
// the pinned one (pc_cb1c3886bd09). playwright-core ships the revisions it wants
// in browsers.json, so compare against that instead of merely counting
// directories. Returns [] when node_modules is absent, in which case the check
// degrades to the old presence-only report rather than lying in the other
// direction.
