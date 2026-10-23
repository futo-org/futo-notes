#!/usr/bin/env node
/**
 * Run this repo's NON-macOS test suites on a Linux box over Tailscale, so they
 * stop competing with the Mac's iOS/desktop work.
 *
 *   node scripts/remote-test.mjs check              # `just check` on jfedora
 *   node scripts/remote-test.mjs --rsync test-rust-full
 *   node scripts/remote-test.mjs --doctor           # remote readiness report
 *
 * Run it directly with `node scripts/remote-test.mjs`; `just remote-sync` is the
 * one wrapper kept as a `just` recipe (cross-platform sync is run often enough
 * to earn one). Three properties matter more than convenience:
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
import { pathToFileURL } from 'node:url';

import { readJustCommands } from './lib/justfile.mjs';
import { HELP, parseCliArgs } from './remote-test/cli.mjs';
import {
  SUDO_HINTS,
  buildDoctorScript,
  pinnedPlaywrightBrowsers,
} from './remote-test/doctor-script.mjs';
import { classifyRecipe } from './remote-test/recipe-policy.mjs';
import { ndkVersionFromGradle } from './remote-test/remote-env.mjs';
import {
  buildKillScript,
  buildLockScript,
  buildNodePreflightScript,
  buildRunScript,
  buildUnlockScript,
} from './remote-test/remote-scripts.mjs';
import {
  DEFAULT_HOST,
  EXIT_LOCKED,
  EXIT_MOVED,
  EXIT_REFUSED,
  FALLBACK_HOSTS,
  ROOT,
} from './remote-test/settings.mjs';

export { classifyRecipe } from './remote-test/recipe-policy.mjs';
export { ndkVersionFromGradle } from './remote-test/remote-env.mjs';

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
  '.build-release-compliance',
  'DerivedData',
  '.gradle',
  '.kotlin',
  // Native build products are regenerated on the destination. Keep sources and
  // the Gradle wrapper, while avoiding multi-gigabyte local caches and binaries.
  '/apps/android/build/',
  '/apps/android/**/build/',
  '/apps/android/app/src/main/jniLibs/',
  '/apps/android/app/src/main/java/uniffi/',
  '/apps/android/app/src/main/assets/editor.html',
  '/apps/ios/*.xcframework/',
  '/apps/ios/*.xcodeproj/',
  '/apps/ios/Sources/Generated/',
  '/apps/ios/Resources/editor.html',
  // The remote's own bookkeeping; deleting it forces a needless pnpm install.
  '.remote-test-pnpm-lock-hash',
];

// A doctor run is only a hard failure when the box cannot run ANY suite.
// Everything else (NDK, KVM, Postgres, browsers) gates a specific suite and is
// reported as WARN/MISS with the command that fixes it.
const DOCTOR_REQUIRED = ['fnm', 'node', 'pnpm', 'cargo', 'just', 'git', 'rsync'];

/** `CHECK|name|status|detail` lines → rows, tolerating `|` inside detail. */
function parseDoctorOutput(stdout) {
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

function probeSsh(target) {
  return spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', target, 'true'], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

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
    verdict = classifyRecipe(opts.recipe, readJustCommands(ROOT));
    if (!verdict.allowed) {
      console.error(`\nremote-test REFUSED: ${verdict.reason}\n`);
      return EXIT_REFUSED;
    }
  }

  // Host resolution: Tailscale name first, tailnet IP as a fallback.
  const candidates = opts.host ? [opts.host] : [DEFAULT_HOST, ...FALLBACK_HOSTS];
  let target = null;
  const sshFailures = [];
  for (const host of candidates) {
    const candidate = `${opts.user}@${host}`;
    const probe = probeSsh(candidate);
    if (probe.status === 0) {
      target = candidate;
      if (host !== candidates[0]) console.log(`[remote-test] ${candidates[0]} did not answer`);
      break;
    }
    sshFailures.push({ candidate, diagnostic: probe.stderr ?? '' });
  }
  if (!target) {
    for (const { candidate, diagnostic } of sshFailures) {
      if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(diagnostic)) {
        console.error(
          `remote-test: SSH host-key verification failed for ${candidate}. ` +
            'Verify the host fingerprint with Justin before accepting or replacing a host key. ' +
            `Then connect interactively with ssh ${candidate} true and retry.`,
        );
      } else if (/Permission denied.*publickey/i.test(diagnostic)) {
        console.error(
          `remote-test: SSH public-key authentication failed for ${candidate}; ` +
            'ask Justin to authorize your public key for this account, then retry. ' +
            'Use your own authorized identity through ssh config or ssh-agent.',
        );
      }
    }
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

  const preflight = spawnSync('ssh', ['-T', target, 'bash -s'], {
    input: buildNodePreflightScript({ ndkVersion }),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (preflight.status !== 0) return preflight.status ?? 1;

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
