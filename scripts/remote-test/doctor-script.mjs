// remote-test.mjs --doctor: the remote readiness probe and the fix hints for what it reports.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { PINNED_SERVER_VERSION } from '../lib/sync-server.mjs';
import { remoteEnvPreamble } from './remote-env.mjs';
import { ROOT } from './settings.mjs';

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

SYNC_SERVER_BIN="\${XDG_CACHE_HOME:-$HOME/.cache}/futo-notes/sync-server/${PINNED_SERVER_VERSION}/futo-notes-server"
if [ -x "$SYNC_SERVER_BIN" ]; then
  emit 'sync server' ok "${PINNED_SERVER_VERSION} cached at $SYNC_SERVER_BIN"
else
  emit 'sync server' warn "${PINNED_SERVER_VERSION} not cached — the first sync run downloads it from gitlab.futo.org"
fi

if [ -x "$ANDROID_HOME/emulator/emulator" ]; then
  AVDS="$("$ANDROID_HOME/emulator/emulator" -list-avds 2>/dev/null | tr '\\n' ' ')"
  emit 'android emulator' ok "AVDs: $AVDS"
else
  emit 'android emulator' missing "$ANDROID_HOME/emulator/emulator"
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
export const SUDO_HINTS = {
  '/dev/kvm': 'sudo usermod -aG kvm $USER   # then log out and back in',
  'webkit2gtk-4.1': 'sudo dnf install -y webkit2gtk4.1-devel libsoup3-devel',
  'gradle JDK': 'sudo dnf install -y java-21-openjdk-devel   # Gradle 8.14 cannot run on Java 25',
  adb: 'sudo dnf install -y android-tools',
  ffmpeg: 'sudo dnf install -y ffmpeg',
  'sync server':
    'node scripts/lib/sync-server.mjs path   # pre-downloads the pinned release; the suite does it anyway',
  docker: 'sudo dnf install -y docker && sudo systemctl enable --now docker',
  'playwright browsers':
    'pnpm exec playwright install chromium webkit   # NOT --with-deps: that needs root',
  fnm: "curl -fsSL https://fnm.vercel.app/install | bash   # supplies .nvmrc's exact Node",
};
