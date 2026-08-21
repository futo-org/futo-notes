#!/usr/bin/env node
/**
 * Run this repo's NON-macOS test suites on a Linux box over Tailscale, so they
 * stop competing with the Mac's iOS/desktop work.
 *
 *   node scripts/remote-test.mjs check              # `just check` on jfedora
 *   node scripts/remote-test.mjs --rsync test-rust-full
 *   node scripts/remote-test.mjs --doctor           # remote readiness report
 *
 * The `just remote-*` recipes are the intended entry points; this file is the
 * mechanism. Three properties matter more than convenience:
 *
 *   1. A macOS-only recipe is REFUSED BY NAME (see POLICY below), including
 *      through its justfile alias — not merely documented as a bad idea. A
 *      Linux box cannot run Xcode, and an "it passed on jfedora" for an iOS
 *      recipe would be a lie.
 *   2. The remote exit status is propagated verbatim (M11: no silent green).
 *      Output streams to this terminal as it arrives; nothing is buffered or
 *      piped through anything that could swallow a non-zero status.
 *   3. Every run prints the transfer MODE and the SHA it actually ran, because
 *      the failure this tool invites is trusting a stale remote checkout.
 *
 * WebKit boundary: Linux desktop = WebKitGTK, macOS desktop = WKWebView. Logic
 * and state are equivalent; paint, compositing and timing are not. Suites that
 * drive a browser engine get a caveat banner rather than silent equivalence,
 * and the ones whose whole point IS the engine are refused. Same reasoning as
 * M22 (Playwright cannot prove WebView2). See docs/remote-testing.md.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The justfile recipe parser already exists (the agent-docs gate validates
// every `just <recipe>` reference with it); a second copy here would be drift.
import { parseJustRecipes } from './check-agent-docs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tailscale hostname first; the tailnet IP is only a fallback for when MagicDNS
// is not answering (this is a laptop-adjacent tailnet, so that happens).
export const DEFAULT_HOST = 'jfedora';
export const FALLBACK_HOSTS = ['100.90.52.106'];
export const DEFAULT_USER = 'justin';

// A dedicated CI worktree, NOT the box's own ~/Developer/futo-notes checkout —
// that one is somebody's live working tree and gets `git checkout --force`d
// out from under them otherwise.
export const DEFAULT_REMOTE_DIR = '$HOME/ci/futo-main';
export const DEFAULT_SOURCE_REPO = '$HOME/Developer/futo-notes';
// CARGO_TARGET_DIR is deliberately NOT exported. The remote worktree's own
// `target/` is already a persistent warm cache (git mode never touches it and
// --rsync excludes it), so relocating it buys nothing — and cost real breakage
// twice:
//   1. tests/lib/tauri-instance.mjs resolves the built binary as
//      <repoRoot>/target/debug/futo-notes-tauri, and cross-platform-sync.mjs's
//      pgrep cleanup only kills binaries under it (a deliberate guard). A
//      relocated target dir made `just remote-sync` die with ENOENT AFTER an
//      84-second build.
//   2. scripts/ci-cargo-cache-freshness.mjs reads $CARGO_TARGET_DIR, so its
//      unit tests inherited ours, inspected a directory that did not exist,
//      concluded "no restored cache", and exited 0 where they assert 1 — five
//      failures in `just remote-check` that do not reproduce on the Mac.
// Anything in this repo may reasonably assume the repo-local target/; honouring
// that is cheaper than auditing every consumer.
export const REMOTE_CARGO_TARGET_DIR = null;

// Gradle 8.14.3 (apps/android/gradle/wrapper) cannot run on Java 25, and
// Fedora's default JDK is 25 — gradle fails with a bare "What went wrong:
// 25.0.4", which names neither Java nor the version constraint. The app targets
// jvmTarget 17 and Gradle 8.14 fully supports 21, so pick a 21 (or 17) JDK
// rather than whatever `java` resolves to. Override with $FUTO_REMOTE_JAVA_HOME.
export const GRADLE_JDK_CANDIDATES = [
  '/usr/lib/jvm/java-21-openjdk',
  '/usr/lib/jvm/temurin-21-jdk',
  '/usr/lib/jvm/java-21-temurin-jdk',
  '/usr/lib/jvm/java-17-openjdk',
  '/usr/lib/jvm/temurin-17-jdk',
];

// Distinguishable from any suite's own failure: the run never started.
export const EXIT_REFUSED = 2;
export const EXIT_LOCKED = 75; // EX_TEMPFAIL
// The remote checkout moved mid-run: the result is void, not a test failure.
export const EXIT_MOVED = 76;

// ---------------------------------------------------------------------------
// Policy: what may and may not run on a Linux box
// ---------------------------------------------------------------------------

const REASONS = {
  macos: 'needs Xcode, the iOS simulator, or swift-format — macOS-only tooling. Run it on the Mac.',
  wkwebview:
    'drives the real desktop app, whose web engine is WKWebView on macOS and WebKitGTK on Linux. ' +
    'A green Linux run can neither confirm nor refute a paint/compositing/timing regression in the ' +
    'engine we ship on macOS (the same reasoning as M22 for WebView2). Run it on the Mac.',
  interactive: 'is an interactive dev/QA command, not a suite — it needs a display and a human.',
  sudo: 'installs a system package; jfedora has no passwordless sudo, so it would hang or fail.',
  localMachine:
    'manages THIS machine’s device pool / worktrees. Run remotely it would claim devices and ' +
    'directories you cannot reach.',
};

// Matched against the recipe name AFTER justfile alias resolution, so
// `just remote in` (alias for ios-native) is refused too.
export const REFUSED = [
  // Xcode / iOS simulator / Swift toolchain.
  ['build-rust-ios', 'macos'],
  ['build-ios-native', 'macos'],
  ['test-ios-native', 'macos'],
  ['ios-native', 'macos'],
  ['ios-native-device', 'macos'],
  ['deploy-ios', 'macos'],
  ['lint-swift', 'macos'],
  [/^sim-/, 'macos'],
  // APFS copy-on-write; `cp -Rc` does not exist on Linux.
  ['qa-clone-target', 'macos'],
  // Runs the shipped desktop app or the CM6 editor in a browser engine.
  ['test-desktop-smoke', 'wkwebview'],
  ['perf-course', 'wkwebview'],
  // Interactive.
  ['tauri-dev', 'interactive'],
  ['tauri-prod', 'interactive'],
  ['preview', 'interactive'],
  ['test-headed', 'interactive'],
  ['test-ui', 'interactive'],
  ['updater-localdev', 'interactive'],
  ['android-drive', 'localMachine'],
  ['journal', 'localMachine'],
  // Needs root.
  ['deploy-deb', 'sudo'],
  ['deploy-rpm', 'sudo'],
  // Device-pool bookkeeping for the machine you are sitting at.
  ['qa-claim', 'localMachine'],
  ['qa-release', 'localMachine'],
  ['qa-gc', 'localMachine'],
];

// Allowed, but the reader gets told what a green run does and does not prove.
// `check` is deliberately NOT here: it is tsc + eslint + prettier +
// svelte-check + vitest (jsdom) + vite build + the Rust conformance tests, none
// of which touch a real web engine, so a Linux `check` is equivalent to a macOS
// one. `prepush` IS here, because it adds the full Playwright suite and
// cross-platform sync (both of which boot a browser engine) on top of `check`.
export const CAVEATED = [
  [
    /^(test-e2e|test-e2e-full|test-markdown-spec)$/,
    'Playwright here runs Linux Chromium/WebKit builds. Behavior and state are equivalent; ' +
      'paint, compositing and IME/timing are not (M22).',
  ],
  [
    'test-cross-platform',
    'boots the real Tauri desktop app, which is WebKitGTK on Linux. The assertions are on sync ' +
      'state and files, which are engine-independent — but a rendering regression will not show up here.',
  ],
  [
    'prepush',
    'the maximal gate, minus everything only a Mac can see: no iOS build/tests, no swift-format, ' +
      'and its Playwright + cross-platform legs run on WebKitGTK, not WKWebView. A green remote ' +
      'prepush is NOT a licence to skip the Mac.',
  ],
  [
    /^(test-cross-platform|prepush)$/,
    'derives its ports and its Postgres database from the worktree slot, so two DIFFERENT ' +
      'worktrees can run it at once — but two runs in the same remote worktree are the same ' +
      'slot, and the second now aborts on the busy port instead of adopting the first server. ' +
      'The remote worktree lock is what stops that happening at all.',
  ],
];

function matches(matcher, name) {
  return typeof matcher === 'string' ? matcher === name : matcher.test(name);
}

/** `alias t := test` lines, so a refusal cannot be bypassed via the short name. */
export function parseJustAliases(justfileText) {
  const aliases = new Map();
  for (const line of justfileText.split('\n')) {
    const m = /^alias\s+([a-zA-Z_][a-zA-Z0-9_-]*)\s*:=\s*([a-zA-Z_][a-zA-Z0-9_-]*)/.exec(line);
    if (m) aliases.set(m[1], m[2]);
  }
  return aliases;
}

/**
 * @returns {{ recipe: string, allowed: boolean, reason?: string, caveats: string[] }}
 */
export function classifyRecipe(name, { aliases = new Map(), recipes = null } = {}) {
  const resolved = aliases.get(name) ?? name;
  const via = resolved === name ? '' : ` (alias for \`${resolved}\`)`;

  for (const [matcher, reasonKey] of REFUSED) {
    if (matches(matcher, resolved)) {
      return {
        recipe: resolved,
        allowed: false,
        reason: `\`just ${name}\`${via} ${REASONS[reasonKey]}`,
        caveats: [],
      };
    }
  }

  if (recipes && !recipes.has(resolved)) {
    return {
      recipe: resolved,
      allowed: false,
      reason: `\`just ${name}\` is not a recipe in this checkout's justfile. Check the spelling with \`just --list\`.`,
      caveats: [],
    };
  }

  const caveats = CAVEATED.filter(([matcher]) => matches(matcher, resolved)).map(
    ([, text]) => `\`just ${resolved}\` ${text}`,
  );
  return { recipe: resolved, allowed: true, caveats };
}

// ---------------------------------------------------------------------------
// Remote environment
// ---------------------------------------------------------------------------

/**
 * The NDK AGP is pinned to. cargo-ndk must build the Rust .so with the SAME
 * NDK — apps/android/app/build.gradle.kts warns that a mismatch breaks NDK
 * resolution and silently skips stripping — so read the pin instead of
 * defaulting to "newest installed", which is how the two drift apart.
 */
export function ndkVersionFromGradle(gradleText) {
  const m = /ndkVersion\s*=\s*"([^"]+)"/.exec(gradleText);
  if (!m) throw new Error('no ndkVersion found in apps/android/app/build.gradle.kts');
  return m[1];
}

/**
 * Sourced on EVERY invocation: `ssh host cmd` is a non-interactive shell, so it
 * reads none of the box's profile — node lives in fnm and is simply absent from
 * PATH without this.
 */
export function remoteEnvPreamble({ ndkVersion }) {
  return [
    // .bun/bin is here because the E2EE sync test server is a bun project —
    // tests/lib/sync-test-server.mjs shells out to `bun src/index.ts hash`, and
    // without it the cross-platform suite dies AFTER booting both clients.
    // .local/share/fnm and linuxbrew cover fnm's two install layouts; this must
    // precede the `fnm env` below, which needs fnm itself on PATH.
    'export PATH="$HOME/.local/bin:$HOME/.local/share/fnm:/home/linuxbrew/.linuxbrew/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"',
    // A missing fnm is not fatal here; it fails at `fnm use` in the runner script,
    // which is under `set -e`. remote-doctor lists fnm as required and prints the
    // install command, because the box needs it once.
    'if command -v fnm >/dev/null 2>&1; then eval "$(fnm env --shell bash)"; fi',
    'export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"',
    'export ANDROID_SDK_ROOT="$ANDROID_HOME"',
    `export ANDROID_NDK_HOME="\${FUTO_REMOTE_NDK:-$ANDROID_HOME/ndk/${ndkVersion}}"`,
    // See GRADLE_JDK_CANDIDATES: Fedora's default JDK 25 is too new for the
    // pinned Gradle, so prefer an explicitly supported one when it exists.
    `for candidate in "\${FUTO_REMOTE_JAVA_HOME:-}" ${GRADLE_JDK_CANDIDATES.map((p) => `"${p}"`).join(' ')}; do`,
    '  if [ -n "$candidate" ] && [ -x "$candidate/bin/javac" ]; then',
    '    export JAVA_HOME="$candidate"',
    '    export PATH="$JAVA_HOME/bin:$PATH"',
    '    break',
    '  fi',
    'done',
    // See REMOTE_CARGO_TARGET_DIR: an inherited one must not leak in either.
    'unset CARGO_TARGET_DIR',
    // Deliberately NOT setting CI: `cargo tauri build` maps its `--ci` flag to
    // $CI, and an EMPTY CI makes clap reject the run ("a value is required for
    // '--ci'"). This broke `just remote-sync` before it was caught. vitest also
    // caps workers under CI, which would throw away the box's 32 cores.
    'unset CI',
  ].join('\n');
}

export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Remote scripts
// ---------------------------------------------------------------------------

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
  echo "  Nothing was signalled. Use --force-lock if you are certain it is stale." >&2
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
fnm use --install-if-missing

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
# whole recipe in one group, so 'just remote --kill' signals exactly this run.
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
export function pinnedPlaywrightBrowsers(root = ROOT) {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(root, 'node_modules/playwright-core/browsers.json'), 'utf8'),
    );
    return manifest.browsers
      .filter((b) => ['chromium', 'webkit', 'firefox'].includes(b.name))
      .map((b) => `${b.name}-${b.revision}`)
      .sort();
  } catch {
    return [];
  }
}

export function buildDoctorScript({ remoteDir, sourceRepo, ndkVersion, pinnedBrowsers = [] }) {
  return `
set -uo pipefail
${remoteEnvPreamble({ ndkVersion })}

emit() { printf 'CHECK|%s|%s|%s\\n' "$1" "$2" "$3"; }
have() {
  if p="$(command -v "$1" 2>/dev/null)"; then emit "$2" ok "$($3 2>&1 | head -1) — $p"; else emit "$2" missing ""; fi
}

have fnm         'fnm'          'fnm --version'
have node        'node'         'node --version'
have pnpm        'pnpm'         'pnpm --version'
have cargo       'cargo'        'cargo --version'
have rustup      'rustup'       'rustup --version'
have just        'just'         'just --version'
have git         'git'          'git --version'
have bun         'bun (sync server)' 'bun --version'
have rsync       'rsync'        'rsync --version'
if [ -n "\${JAVA_HOME:-}" ]; then
  emit 'gradle JDK' ok "$("$JAVA_HOME/bin/java" -version 2>&1 | head -1) — $JAVA_HOME"
elif command -v java >/dev/null 2>&1; then
  # Gradle 8.14 cannot run on Java 25+, and its error names neither.
  emit 'gradle JDK' warn "only $(java -version 2>&1 | head -1) on PATH; the pinned Gradle needs 17 or 21"
else
  emit 'gradle JDK' missing 'no JDK at all'
fi
have adb         'adb'          'adb --version'
have ffmpeg      'ffmpeg'       'ffmpeg -version'
have docker      'docker'       'docker --version'

if command -v cargo-ndk >/dev/null 2>&1 || cargo ndk --version >/dev/null 2>&1; then
  emit 'cargo-ndk' ok "$(cargo ndk --version 2>&1 | head -1)"
else
  emit 'cargo-ndk' missing ''
fi

TARGETS="$(rustup target list --installed 2>/dev/null | tr '\\n' ' ')"
MISSING_TARGETS=""
for t in aarch64-linux-android armv7-linux-androideabi x86_64-linux-android; do
  case " $TARGETS " in *" $t "*) ;; *) MISSING_TARGETS="$MISSING_TARGETS $t" ;; esac
done
if [ -n "$MISSING_TARGETS" ]; then
  emit 'rust android targets' missing "missing:$MISSING_TARGETS"
else
  emit 'rust android targets' ok 'aarch64 + armv7 + x86_64'
fi

if [ -d "$ANDROID_NDK_HOME" ]; then
  emit 'pinned NDK' ok "$ANDROID_NDK_HOME"
else
  emit 'pinned NDK' missing "$ANDROID_NDK_HOME (installed: $(ls -1 "$ANDROID_HOME/ndk" 2>/dev/null | tr '\\n' ' '))"
fi

if [ -w /dev/kvm ]; then
  emit '/dev/kvm' ok "$(ls -l /dev/kvm)"
elif [ -e /dev/kvm ]; then
  emit '/dev/kvm' warn "present but not writable by $(id -un): $(ls -l /dev/kvm)"
else
  emit '/dev/kvm' missing 'no /dev/kvm — Android emulators will be software-rendered'
fi

if [ -x "$ANDROID_HOME/emulator/emulator" ]; then
  AVDS="$("$ANDROID_HOME/emulator/emulator" -list-avds 2>/dev/null | tr '\\n' ' ')"
  emit 'android emulator' ok "AVDs: $AVDS"
else
  emit 'android emulator' missing "$ANDROID_HOME/emulator/emulator"
fi

PG_STATUS="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}({{.State.Health.Status}}){{end}}' futo-notes-postgres 2>/dev/null)"
if [ -z "$PG_STATUS" ]; then
  emit 'postgres container' missing 'no container named futo-notes-postgres'
elif docker exec futo-notes-postgres pg_isready >/dev/null 2>&1; then
  emit 'postgres container' ok "futo-notes-postgres $PG_STATUS, pg_isready OK"
else
  emit 'postgres container' warn "futo-notes-postgres $PG_STATUS but pg_isready failed"
fi

if pkg-config --modversion webkit2gtk-4.1 >/dev/null 2>&1; then
  emit 'webkit2gtk-4.1' ok "$(pkg-config --modversion webkit2gtk-4.1) (Tauri desktop build deps)"
else
  emit 'webkit2gtk-4.1' missing 'Tauri desktop builds (cross-platform sync) will not link'
fi

BROWSERS="$(ls -1 "$HOME/.cache/ms-playwright" 2>/dev/null | grep -E '^(chromium|webkit|firefox)-' | tr '\\n' ' ')"
PINNED="${pinnedBrowsers.join(' ')}"
if [ -z "$BROWSERS" ]; then
  emit 'playwright browsers' missing 'no browsers under ~/.cache/ms-playwright'
elif [ -z "$PINNED" ]; then
  # No local node_modules to read browsers.json from: report presence only, and
  # say so rather than implying the versions were checked.
  emit 'playwright browsers' ok "$BROWSERS (pinned set unknown — no local node_modules)"
else
  MISSING=""
  for want in $PINNED; do
    case " $BROWSERS " in
      *" $want "*) ;;
      *) MISSING="$MISSING $want" ;;
    esac
  done
  if [ -n "$MISSING" ]; then
    emit 'playwright browsers' warn "installed:$([ -n "$BROWSERS" ] && echo " $BROWSERS") — but this repo pins$MISSING, so a playwright run will ask to install it"
  else
    emit 'playwright browsers' ok "$BROWSERS (matches pinned:$(printf ' %s' $PINNED))"
  fi
fi

for d in "${sourceRepo}" "$HOME/Developer/futo-notes-server"; do
  if [ -d "$d/.git" ] || [ -f "$d/.git" ]; then
    emit "repo $(basename "$d")" ok "$d @ $(git -C "$d" rev-parse --short HEAD 2>&1)"
  else
    emit "repo $(basename "$d")" missing "$d"
  fi
done

if [ -d "${remoteDir}" ]; then
  emit 'ci worktree' ok "${remoteDir} @ $(git -C "${remoteDir}" rev-parse --short HEAD 2>&1)$([ -d "${remoteDir}/node_modules" ] && echo ', node_modules present' || echo ', NO node_modules')"
else
  emit 'ci worktree' warn "${remoteDir} does not exist yet (remote-test creates it on first run)"
fi

if [ -d "${remoteDir}.lock" ]; then
  emit 'worktree lock' warn "HELD: $(tr '\\n' ' ' < "${remoteDir}.lock/holder" 2>/dev/null)"
else
  emit 'worktree lock' ok 'free'
fi

emit 'capacity' ok "$(nproc) cores, $(free -g | awk '/^Mem:/{print $2}') GB RAM, $(df -h "$HOME" | awk 'NR==2{print $4}') free on \\$HOME"
emit 'cargo target cache' ok "${remoteDir}/target ($(du -sh "${remoteDir}/target" 2>/dev/null | cut -f1 || echo 'absent — first cargo run will be cold'))"
`;
}

// Anything a human with sudo has to do, keyed by the check that reports it.
const SUDO_HINTS = {
  '/dev/kvm': 'sudo usermod -aG kvm $USER   # then log out and back in',
  'webkit2gtk-4.1': 'sudo dnf install -y webkit2gtk4.1-devel libsoup3-devel',
  'gradle JDK': 'sudo dnf install -y java-21-openjdk-devel   # Gradle 8.14 cannot run on Java 25',
  adb: 'sudo dnf install -y android-tools',
  ffmpeg: 'sudo dnf install -y ffmpeg',
  docker: 'sudo dnf install -y docker && sudo systemctl enable --now docker',
  'postgres container':
    "docker start futo-notes-postgres  # or recreate it per futo-notes-server's README",
  'playwright browsers':
    'pnpm exec playwright install chromium webkit   # NOT --with-deps: that needs root',
  'bun (sync server)': 'curl -fsSL https://bun.sh/install | bash   # the sync test server is bun',
  fnm: "curl -fsSL https://fnm.vercel.app/install | bash   # supplies .nvmrc's exact Node",
};

// ---------------------------------------------------------------------------
// Local side
// ---------------------------------------------------------------------------

export const RSYNC_EXCLUDES = [
  '.git',
  'node_modules',
  'target',
  'dist',
  'test-screenshots',
  'perf-results',
  '.tauri-data',
  '.build',
  '.build-device',
  '.build-device-release',
  // The remote's own bookkeeping; deleting it forces a needless pnpm install.
  '.remote-test-pnpm-lock-hash',
];

// A doctor run is only a hard failure when the box cannot run ANY suite.
// Everything else (NDK, KVM, Postgres, browsers) gates a specific suite and is
// reported as WARN/MISS with the command that fixes it.
export const DOCTOR_REQUIRED = ['fnm', 'node', 'pnpm', 'cargo', 'just', 'git', 'rsync'];

/** `CHECK|name|status|detail` lines → rows, tolerating `|` inside detail. */
export function parseDoctorOutput(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('CHECK|'))
    .map((line) => {
      const parts = line.slice('CHECK|'.length).split('|');
      return { name: parts[0], status: parts[1], detail: parts.slice(2).join('|') };
    });
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function reachable(target) {
  const probe = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', target, 'true'],
    { stdio: 'ignore' },
  );
  return probe.status === 0;
}

export function parseCliArgs(argv) {
  const opts = {
    doctor: false,
    mode: 'git',
    host: process.env.FUTO_REMOTE_HOST || null,
    user: process.env.FUTO_REMOTE_USER || DEFAULT_USER,
    remoteDir: process.env.FUTO_REMOTE_DIR || DEFAULT_REMOTE_DIR,
    sourceRepo: process.env.FUTO_REMOTE_REPO || DEFAULT_SOURCE_REPO,
    forceLock: false,
    waitSeconds: 0,
    help: false,
    recipe: null,
    recipeArgs: [],
  };

  let i = 0;
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      i += 1;
      break;
    }
    if (!arg.startsWith('-')) break;
    switch (arg) {
      case '--doctor':
      case '--setup':
        opts.doctor = true;
        break;
      case '--rsync':
        opts.mode = 'rsync';
        break;
      case '--force-lock':
        opts.forceLock = true;
        break;
      case '--kill':
        opts.kill = true;
        break;
      case '--wait': {
        // Accept `--wait 600` as well as `--wait=600`. Only consume the next
        // argument when it actually looks like a duration: bare `--wait` is
        // valid and is normally followed by the recipe name, which must not be
        // swallowed. Before this, `--wait 600 <recipe>` ate the recipe slot with
        // "600" and died with an unhelpful is-not-a-recipe error
        // (pc_8082388d5c53).
        const next = argv[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) {
          opts.waitSeconds = Number(next);
          i += 1;
        } else {
          opts.waitSeconds = 1800;
        }
        break;
      }
      case '--host':
        opts.host = argv[++i];
        break;
      case '--user':
        opts.user = argv[++i];
        break;
      case '--dir':
        opts.remoteDir = argv[++i];
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default: {
        // --wait=600 / --host=box, alongside the space-separated forms.
        const eq = arg.indexOf('=');
        if (eq > 0) {
          const [flag, value] = [arg.slice(0, eq), arg.slice(eq + 1)];
          if (flag === '--wait') {
            const seconds = Number(value);
            if (!Number.isInteger(seconds) || seconds < 0) {
              throw new Error(`--wait takes a whole number of seconds, got '${value}'`);
            }
            opts.waitSeconds = seconds;
            break;
          }
          if (flag === '--host') {
            opts.host = value;
            break;
          }
          if (flag === '--user') {
            opts.user = value;
            break;
          }
          if (flag === '--dir') {
            opts.remoteDir = value;
            break;
          }
        }
        throw new Error(
          `unknown option '${arg}'. Options must come BEFORE the recipe name; ` +
            `everything after it is passed to \`just\`.`,
        );
      }
    }
  }
  if (i < argv.length) {
    opts.recipe = argv[i];
    opts.recipeArgs = argv.slice(i + 1);
  }
  return opts;
}

const HELP = `remote-test — run this repo's non-macOS suites on a Linux box over Tailscale

  node scripts/remote-test.mjs [options] <just-recipe> [recipe args...]
  node scripts/remote-test.mjs --doctor

Options (must precede the recipe name):
  --rsync            push the working tree as-is instead of checking out a pushed sha
  --kill             reap THIS worktree's remote run (its process group only) and
                     release the lock — never a pattern kill, so a sibling agent's
                     processes on the shared box are untouched
  --doctor, --setup  report what is present/missing on the remote and exit
  --host H           default $FUTO_REMOTE_HOST or '${DEFAULT_HOST}' (falls back to ${FALLBACK_HOSTS[0]})
  --user U           default $FUTO_REMOTE_USER or '${DEFAULT_USER}'
  --dir PATH         remote worktree, default $FUTO_REMOTE_DIR or '${DEFAULT_REMOTE_DIR}'
  --wait[=SECONDS]   queue behind a run in progress instead of failing (default 1800s)
  --force-lock       break a stale remote worktree lock

Exit status is the remote command's own. ${EXIT_REFUSED} = refused before running,
${EXIT_LOCKED} = the remote worktree was locked by another run, ${EXIT_MOVED} = the remote
checkout moved mid-run, so the result is void rather than a real failure.

The remote worktree is the runner's OWN working area. Do not cd into it and run
suites by hand: that bypasses the lock and produces phantom failures.

The justfile wrappers (\`just remote-check\`, \`just remote-rust\`, \`just remote-sync\`,
\`just remote-android\`, \`just remote-doctor\`, \`just remote <recipe>\`) are the
intended entry points. Boundaries and caveats: docs/remote-testing.md.
`;

function runDoctor(target, opts, ndkVersion) {
  const script = buildDoctorScript({
    remoteDir: opts.remoteDir,
    sourceRepo: opts.sourceRepo,
    ndkVersion,
    pinnedBrowsers: pinnedPlaywrightBrowsers(),
  });
  const res = spawnSync('ssh', ['-T', target, 'bash -s'], {
    input: script,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const rows = parseDoctorOutput(res.stdout || '');
  if (rows.length === 0) {
    console.error(`remote-test: doctor produced no results (ssh exit ${res.status}).`);
    return 1;
  }

  const glyph = { ok: 'ok  ', warn: 'WARN', missing: 'MISS' };
  const width = Math.max(...rows.map((row) => row.name.length));
  console.log(`\nremote-test doctor — ${target}\n`);
  for (const { name, status, detail } of rows) {
    console.log(`  [${glyph[status] ?? status}] ${name.padEnd(width)}  ${detail}`.trimEnd());
  }

  const problems = rows.filter((row) => row.status !== 'ok');
  const hints = problems.map((row) => SUDO_HINTS[row.name]).filter(Boolean);
  if (hints.length > 0) {
    console.log(`\nRun these ON ${target} (some need sudo, which is NOT passwordless there):\n`);
    for (const hint of hints) console.log(`  ${hint}`);
  }

  const blocking = problems.filter(
    (row) => DOCTOR_REQUIRED.includes(row.name) && row.status === 'missing',
  );
  if (problems.length === 0) console.log('\nAll checks green.');
  else
    console.log(
      `\n${problems.length} check(s) need attention` +
        (blocking.length > 0
          ? `, ${blocking.length} of them blocking (${blocking.map((r) => r.name).join(', ')}).`
          : ' — none of them block a run; each gates one suite.'),
    );

  // Only a box that cannot run anything is an error; per-suite gaps are reported.
  return blocking.length > 0 ? 1 : 0;
}

function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`remote-test: ${err.message}`);
    return EXIT_REFUSED;
  }

  if (opts.help || (!opts.doctor && !opts.kill && !opts.recipe)) {
    console.log(HELP);
    return opts.help ? 0 : EXIT_REFUSED;
  }

  const ndkVersion = ndkVersionFromGradle(
    readFileSync(path.join(ROOT, 'apps/android/app/build.gradle.kts'), 'utf8'),
  );

  // Refuse BEFORE touching the network: a refusal should be instant and offline.
  let verdict = null;
  if (!opts.doctor && !opts.kill) {
    const justfile = readFileSync(path.join(ROOT, 'justfile'), 'utf8');
    verdict = classifyRecipe(opts.recipe, {
      aliases: parseJustAliases(justfile),
      recipes: parseJustRecipes(justfile),
    });
    if (!verdict.allowed) {
      console.error(`\nremote-test REFUSED: ${verdict.reason}\n`);
      return EXIT_REFUSED;
    }
  }

  // Host resolution: Tailscale name first, tailnet IP as a fallback.
  const candidates = opts.host ? [opts.host] : [DEFAULT_HOST, ...FALLBACK_HOSTS];
  let target = null;
  for (const host of candidates) {
    const candidate = `${opts.user}@${host}`;
    if (reachable(candidate)) {
      target = candidate;
      if (host !== candidates[0]) console.log(`[remote-test] ${candidates[0]} did not answer`);
      break;
    }
  }
  if (!target) {
    console.error(
      `\nremote-test: cannot reach ${candidates.map((h) => `${opts.user}@${h}`).join(' or ')} over ssh.\n\n` +
        '  Check, in order:\n' +
        '    1. Is this Mac on the tailnet?   tailscale status\n' +
        `    2. Is the box up and on it?      tailscale ping ${candidates[0]}\n` +
        `    3. Does ssh key auth work?       ssh ${opts.user}@${candidates[0]} true\n` +
        '    4. Different box? Set $FUTO_REMOTE_HOST / $FUTO_REMOTE_USER, or pass --host/--user.\n',
    );
    return 1;
  }

  if (opts.doctor) return runDoctor(target, opts, ndkVersion);

  if (opts.kill) {
    const res = spawnSync('ssh', ['-T', target, 'bash -s'], {
      input: buildKillScript({ remoteDir: opts.remoteDir }),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    return res.status ?? 1;
  }

  const sha = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean);

  if (opts.mode === 'git') {
    const containing = git(['branch', '-r', '--contains', sha]).split('\n').filter(Boolean);
    if (containing.length === 0) {
      console.error(
        `\nremote-test: ${sha.slice(0, 9)} is not on any remote branch this checkout knows about, ` +
          'so the remote cannot fetch it.\n\n' +
          '    git push -u origin HEAD            # then re-run\n' +
          '    node scripts/remote-test.mjs --rsync ...   # or push the tree as-is\n',
      );
      return EXIT_REFUSED;
    }
    if (dirty.length > 0) {
      console.log(
        `[remote-test] WARNING: ${dirty.length} uncommitted local change(s) will NOT be tested — ` +
          'git mode runs the pushed sha. Use --rsync to test the working tree.',
      );
    }
  }

  const label = opts.mode === 'rsync' ? `${sha.slice(0, 9)}+working-tree` : sha.slice(0, 9);
  console.log(
    `\n[remote-test] host=${target} mode=${opts.mode} sha=${label} recipe=just ${verdict.recipe}`,
  );
  for (const caveat of verdict.caveats) console.log(`[remote-test] CAVEAT: ${caveat}`);
  console.log('');

  const holder = [
    `who=${userInfo().username}@${hostname()}`,
    `worktree=${ROOT}`,
    `recipe=just ${[verdict.recipe, ...opts.recipeArgs].join(' ')}`,
    `mode=${opts.mode}`,
    `sha=${label}`,
    `started=${new Date().toISOString()}`,
    'phase=transfer',
  ].join('\n');

  // PHASE 1 — take the lock before anything touches the remote checkout.
  const nonce = randomUUID();
  const lock = spawnSync('ssh', ['-T', target, 'bash -s'], {
    input: buildLockScript({
      remoteDir: opts.remoteDir,
      holder,
      forceLock: opts.forceLock,
      waitSeconds: opts.waitSeconds,
      nonce,
    }),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (lock.status !== 0) {
    const lockStatus = lock.status ?? 1;
    console.log(
      `\n[remote-test] ${lockStatus === EXIT_LOCKED ? 'BLOCKED' : 'FAIL'} — could not take the remote worktree lock, exit ${lockStatus}`,
    );
    return lockStatus;
  }

  // Any failure from here to the run must release the lock we just took.
  const releaseLock = () => {
    spawnSync('ssh', ['-T', target, 'bash -s'], {
      input: buildUnlockScript({ remoteDir: opts.remoteDir, nonce }),
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  };

  if (opts.mode === 'rsync') {
    // PHASE 2 — transfer, now safely under the lock.
    // The remote dir has to exist before rsync can fill it; the run script
    // creates the worktree, so seed it with a git-mode-shaped bootstrap first.
    const bootstrap = spawnSync('ssh', ['-T', target, 'bash -s'], {
      input: [
        'set -e',
        `if [ ! -d "${opts.remoteDir}" ]; then`,
        `  git -C "${opts.sourceRepo}" fetch --quiet origin`,
        `  git -C "${opts.sourceRepo}" worktree add --detach "${opts.remoteDir}" origin/main`,
        'fi',
        '',
      ].join('\n'),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    if (bootstrap.status !== 0) {
      console.error('remote-test: could not create the remote worktree.');
      releaseLock();
      return bootstrap.status ?? 1;
    }

    const rsyncArgs = [
      '-az',
      '--delete',
      ...RSYNC_EXCLUDES.flatMap((e) => ['--exclude', e]),
      `${ROOT}/`,
      // `~` is expanded by the remote shell rsync starts, so $HOME-relative
      // remoteDir values need the shell form spelled out.
      `${target}:${opts.remoteDir.replace(/^\$HOME/, '~')}/`,
    ];
    const rsync = spawnSync('rsync', rsyncArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
    if (rsync.status !== 0) {
      console.error('remote-test: rsync failed.');
      releaseLock();
      return rsync.status ?? 1;
    }
  }

  // PHASE 3 — run, adopting the lock taken in phase 1.
  const script = buildRunScript({
    remoteDir: opts.remoteDir,
    sourceRepo: opts.sourceRepo,
    mode: opts.mode,
    sha,
    recipe: verdict.recipe,
    recipeArgs: opts.recipeArgs,
    nonce,
    ndkVersion,
  });

  // stdio inherit: the remote's output goes straight to this terminal as it
  // arrives, and `status` is the remote command's own (M11 — never a pipe).
  const run = spawnSync('ssh', ['-T', target, 'bash -s'], {
    input: script,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  const status = run.status ?? 1;
  // Neither a lock rejection nor a moved checkout is a suite result — calling
  // either FAIL would read as "the tests failed" when they never ran, or ran
  // against a tree that changed underneath them.
  const outcome =
    status === 0
      ? 'PASS'
      : status === EXIT_LOCKED
        ? 'BLOCKED'
        : status === EXIT_MOVED
          ? 'VOID'
          : 'FAIL';
  console.log(
    `\n[remote-test] ${outcome} — just ${verdict.recipe} on ${target} at ${label} (${opts.mode} mode), exit ${status}`,
  );
  if (status === EXIT_MOVED) {
    console.log(
      '[remote-test] the remote checkout changed mid-run: the result above proves nothing. Re-run.',
    );
  }
  if (run.signal) console.log(`[remote-test] ssh terminated by signal ${run.signal}`);
  if (status === 0 && verdict.caveats.length > 0) {
    console.log('[remote-test] green here does NOT cover the caveats printed above.');
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
