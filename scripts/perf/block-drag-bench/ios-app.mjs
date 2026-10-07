/*
 * `block-drag-bench.mjs --device ios-app`: the block drag in the REAL native iOS
 * app on a physical iPhone, driven by real touches from XCUITest.
 *
 * A network-paired phone has no usbmuxd entry, so the WebKit inspector is out of
 * reach; the measurement runs inside the page instead (ios-probe.js, started by
 * the DEBUG-only BlockDragBenchProbe.swift) and posts JSON lines into the dev
 * app's Documents, which this copies back with devicectl. XCUITest
 * (apps/ios/UITests/BlockDragBenchTests.swift) supplies the finger: the page shows
 * a one-line command, the test performs it, the page records frames while it does.
 *
 * Runs in a throwaway vault of the DEV bundle (com.futo.notes.dev); never the
 * production app. Needs apps/ios/.signing-team (or FUTO_DEV_TEAM) and a
 * connected, unlocked, developer-mode device.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { generateNote } from './note.mjs';

const BUNDLE = 'com.futo.notes.dev';

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });

/** Writes the probe the UI test bundles, from ios-probe.js + the shared note generator. */
export function writeProbe(root, { sizes, repeat, selection }) {
  const config = { sizes, repeat, selection, bootWaitMs: 6000 };
  const gen = generateNote.toString();
  const out = [
    `const CONFIG = ${JSON.stringify(config)};`,
    gen,
    readFileSync(path.join(root, 'scripts/perf/block-drag-bench/ios-probe.js'), 'utf8'),
  ].join('\n');
  writeFileSync(path.join(root, 'apps/ios/UITests/BlockDragBenchProbe.js'), out);
}

export function runInIosApp(opts, { root }) {
  const ios = path.join(root, 'apps/ios');
  const team =
    process.env.FUTO_DEV_TEAM ||
    (existsSync(path.join(ios, '.signing-team'))
      ? readFileSync(path.join(ios, '.signing-team'), 'utf8').trim()
      : '');
  if (!team) throw new Error('no signing team: set FUTO_DEV_TEAM or apps/ios/.signing-team');
  const udid =
    process.env.IOS_UDID ||
    sh('node', [path.join(root, 'scripts/ios-device-id.mjs')], { cwd: root }).trim();
  // Same dev id the xcodebuild destination wants (the CoreDevice id works for both).
  writeProbe(root, { sizes: opts.sizes, repeat: opts.repeat, selection: !opts.noSelection });
  sh('bash', ['scripts/editor-deps.sh'], { cwd: root });
  sh('node_modules/.bin/vite', ['build', '--config', 'vite.editor.config.ts'], { cwd: root });
  sh('xcodegen', ['generate'], { cwd: ios });
  const results = mkdtempSync(path.join(tmpdir(), 'ios-bench-'));
  const xcresult = path.join(results, 'bench.xcresult');
  try {
    sh(
      'xcodebuild',
      [
        'test',
        '-project',
        'FutoNotesNative.xcodeproj',
        '-scheme',
        'FutoNotesNative',
        '-configuration',
        'Debug',
        '-destination',
        `id=${udid}`,
        '-derivedDataPath',
        '.build-device',
        '-only-testing:FutoNotesNativeUITests/BlockDragBenchTests',
        '-resultBundlePath',
        xcresult,
        `DEVELOPMENT_TEAM=${team}`,
        'CODE_SIGN_STYLE=Automatic',
        'CODE_SIGNING_ALLOWED=YES',
        'CODE_SIGNING_REQUIRED=YES',
        'CODE_SIGN_IDENTITY=Apple Development',
        '-allowProvisioningUpdates',
      ],
      { cwd: ios, stdio: ['ignore', 'inherit', 'inherit'] },
    );
  } catch (e) {
    console.error('xcodebuild test failed; results at', results);
  }
  const local = path.join(results, 'futo-bench-results.jsonl');
  sh('xcrun', [
    'devicectl',
    'device',
    'copy',
    'from',
    '--device',
    udid,
    '--domain-type',
    'appDataContainer',
    '--domain-identifier',
    BUNDLE,
    '--source',
    'Documents/futo-bench-results.jsonl',
    '--destination',
    local,
  ]);
  const lines = readFileSync(local, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  console.error('results:', local, ' xcresult:', xcresult);
  return lines;
}
