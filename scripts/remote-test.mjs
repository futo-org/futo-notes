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
// One shared cargo target dir: the box has 537 GB free and a warm target is the
// difference between a 4-minute and a 25-minute `cargo test --workspace`.
export const REMOTE_CARGO_TARGET_DIR = '$HOME/.cache/futo-target-ci';

// Distinguishable from any suite's own failure: the run never started.
export const EXIT_REFUSED = 2;
export const EXIT_LOCKED = 75; // EX_TEMPFAIL

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
  [/^factory-/, 'wkwebview'],
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
    'uses the box-global Postgres and a fixed server port counter (from 4000) with no ' +
      'per-worktree isolation, so two simultaneous runs would collide. The remote worktree lock ' +
      'prevents that as long as everyone goes through remote-test.',
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
 * reads none of the box's profile — node lives in nvm and is simply absent from
 * PATH without this.
 */
export function remoteEnvPreamble({ ndkVersion }) {
  return [
    'export NVM_DIR="$HOME/.nvm"',
    // shellcheck-style guard: a missing nvm must fail loudly at `node`, not here.
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null',
    'export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"',
    'export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"',
    'export ANDROID_SDK_ROOT="$ANDROID_HOME"',
    `export ANDROID_NDK_HOME="\${FUTO_REMOTE_NDK:-$ANDROID_HOME/ndk/${ndkVersion}}"`,
    `export CARGO_TARGET_DIR="${REMOTE_CARGO_TARGET_DIR}"`,
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

export function buildRunScript({
  remoteDir,
  sourceRepo,
  mode,
  sha,
  recipe,
  recipeArgs = [],
  holder,
  forceLock,
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

${forceLock ? 'rm -rf "$LOCK_DIR"' : ''}
mkdir -p "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "remote-test: the remote worktree is already in use:" >&2
  sed 's/^/    /' "$LOCK_DIR/holder" 2>/dev/null >&2 || echo "    (no holder file)" >&2
  echo "  Wait for it, or break the lock with --force-lock if you know it is stale." >&2
  exit ${EXIT_LOCKED}
fi
printf '%s\\n' ${shQuote(holder)} > "$LOCK_DIR/holder"
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

# pnpm install only when the lockfile actually moved: it is 40s that most runs
# do not need, and skipping it silently would be worse than paying it.
LOCK_HASH="$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)"
STAMP=".remote-test-pnpm-lock-hash"
if [ ! -d node_modules ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$LOCK_HASH" ]; then
  echo "==> pnpm install (lockfile changed or node_modules missing)"
  pnpm install
  printf '%s\\n' "$LOCK_HASH" > "$STAMP"
fi

# M20: cargo needs a repo-root dist/ to exist.
mkdir -p dist

echo "==> node $(node --version) | pnpm $(pnpm --version) | cargo $(cargo --version | cut -d' ' -f2) | $(nproc) cores"
echo "==> ANDROID_NDK_HOME=$ANDROID_NDK_HOME"
echo "==> CARGO_TARGET_DIR=$CARGO_TARGET_DIR"
echo
echo "───────────────────── just ${recipe} ─────────────────────"
set +e
just ${justArgs}
STATUS=$?
set -e
echo "───────────────────── just ${recipe} exited $STATUS ─────────────────────"
exit $STATUS
`;
}

export function buildDoctorScript({ remoteDir, sourceRepo, ndkVersion }) {
  return `
set -uo pipefail
${remoteEnvPreamble({ ndkVersion })}

emit() { printf 'CHECK|%s|%s|%s\\n' "$1" "$2" "$3"; }
have() {
  if p="$(command -v "$1" 2>/dev/null)"; then emit "$2" ok "$($3 2>&1 | head -1) — $p"; else emit "$2" missing ""; fi
}

have node        'node'         'node --version'
have pnpm        'pnpm'         'pnpm --version'
have cargo       'cargo'        'cargo --version'
have rustup      'rustup'       'rustup --version'
have just        'just'         'just --version'
have git         'git'          'git --version'
have rsync       'rsync'        'rsync --version'
have java        'java (gradle)' 'java -version'
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
if [ -n "$BROWSERS" ]; then
  emit 'playwright browsers' ok "$BROWSERS"
else
  emit 'playwright browsers' missing 'no browsers under ~/.cache/ms-playwright'
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
emit 'cargo target cache' ok "$CARGO_TARGET_DIR ($(du -sh "$CARGO_TARGET_DIR" 2>/dev/null | cut -f1 || echo absent))"
`;
}

// Anything a human with sudo has to do, keyed by the check that reports it.
const SUDO_HINTS = {
  '/dev/kvm': 'sudo usermod -aG kvm $USER   # then log out and back in',
  'webkit2gtk-4.1': 'sudo dnf install -y webkit2gtk4.1-devel libsoup3-devel',
  'java (gradle)': 'sudo dnf install -y java-21-openjdk-devel',
  adb: 'sudo dnf install -y android-tools',
  ffmpeg: 'sudo dnf install -y ffmpeg',
  docker: 'sudo dnf install -y docker && sudo systemctl enable --now docker',
  'postgres container':
    "docker start futo-notes-postgres  # or recreate it per futo-notes-server's README",
  'playwright browsers':
    'pnpm exec playwright install chromium webkit   # NOT --with-deps: that needs root',
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
  'factory/captures',
  // The remote's own bookkeeping; deleting it forces a needless pnpm install.
  '.remote-test-pnpm-lock-hash',
];

// A doctor run is only a hard failure when the box cannot run ANY suite.
// Everything else (NDK, KVM, Postgres, browsers) gates a specific suite and is
// reported as WARN/MISS with the command that fixes it.
export const DOCTOR_REQUIRED = ['node', 'pnpm', 'cargo', 'just', 'git', 'rsync'];

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
      default:
        throw new Error(
          `unknown option '${arg}'. Options must come BEFORE the recipe name; ` +
            `everything after it is passed to \`just\`.`,
        );
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
  --doctor, --setup  report what is present/missing on the remote and exit
  --host H           default $FUTO_REMOTE_HOST or '${DEFAULT_HOST}' (falls back to ${FALLBACK_HOSTS[0]})
  --user U           default $FUTO_REMOTE_USER or '${DEFAULT_USER}'
  --dir PATH         remote worktree, default $FUTO_REMOTE_DIR or '${DEFAULT_REMOTE_DIR}'
  --force-lock       break a stale remote worktree lock

Exit status is the remote command's own. ${EXIT_REFUSED} = refused before running,
${EXIT_LOCKED} = the remote worktree was locked by another run.

The justfile wrappers (\`just remote-check\`, \`just remote-rust\`, \`just remote-sync\`,
\`just remote-android\`, \`just remote-doctor\`, \`just remote <recipe>\`) are the
intended entry points. Boundaries and caveats: docs/remote-testing.md.
`;

function runDoctor(target, opts, ndkVersion) {
  const script = buildDoctorScript({
    remoteDir: opts.remoteDir,
    sourceRepo: opts.sourceRepo,
    ndkVersion,
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

  if (opts.help || (!opts.doctor && !opts.recipe)) {
    console.log(HELP);
    return opts.help ? 0 : EXIT_REFUSED;
  }

  const ndkVersion = ndkVersionFromGradle(
    readFileSync(path.join(ROOT, 'apps/android/app/build.gradle.kts'), 'utf8'),
  );

  // Refuse BEFORE touching the network: a refusal should be instant and offline.
  let verdict = null;
  if (!opts.doctor) {
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

  if (opts.mode === 'rsync') {
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
      return rsync.status ?? 1;
    }
  }

  const holder = [
    `who=${userInfo().username}@${hostname()}`,
    `worktree=${ROOT}`,
    `recipe=just ${[verdict.recipe, ...opts.recipeArgs].join(' ')}`,
    `mode=${opts.mode}`,
    `sha=${label}`,
    `started=${new Date().toISOString()}`,
  ].join('\n');

  const script = buildRunScript({
    remoteDir: opts.remoteDir,
    sourceRepo: opts.sourceRepo,
    mode: opts.mode,
    sha,
    recipe: verdict.recipe,
    recipeArgs: opts.recipeArgs,
    holder,
    forceLock: opts.forceLock,
    ndkVersion,
  });

  // stdio inherit: the remote's output goes straight to this terminal as it
  // arrives, and `status` is the remote command's own (M11 — never a pipe).
  const run = spawnSync('ssh', ['-T', target, 'bash -s'], {
    input: script,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  const status = run.status ?? 1;
  const outcome = status === 0 ? 'PASS' : 'FAIL';
  console.log(
    `\n[remote-test] ${outcome} — just ${verdict.recipe} on ${target} at ${label} (${opts.mode} mode), exit ${status}`,
  );
  if (run.signal) console.log(`[remote-test] ssh terminated by signal ${run.signal}`);
  if (status === 0 && verdict.caveats.length > 0) {
    console.log('[remote-test] green here does NOT cover the caveats printed above.');
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
