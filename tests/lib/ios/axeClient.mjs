import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_BUNDLE_ID = 'com.futo.notes.dev';

function outputOf(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

/** Every command addresses one explicit simulator; there is no "booted" fallback. */
export function createAxeClient({ udid, bundleId = DEFAULT_BUNDLE_ID } = {}) {
  if (!udid) {
    throw new Error('no iOS simulator selected — export SIM from: just qa-claim ios');
  }

  const axeBinary = process.env.AXE_BIN || 'axe';
  const axe = (...args) => outputOf(axeBinary, args);
  const simctl = (...args) => outputOf('xcrun', ['simctl', ...args]);

  const describeUiTree = () => JSON.parse(axe('describe-ui', '--udid', udid));

  const tapPoint = (x, y) =>
    axe('tap', '-x', String(Math.round(x)), '-y', String(Math.round(y)), '--udid', udid);

  const touchPoint = (x, y) =>
    axe(
      'touch',
      '-x',
      String(Math.round(x)),
      '-y',
      String(Math.round(y)),
      '--down',
      '--up',
      '--delay',
      '0.05',
      '--udid',
      udid,
    );

  const typeText = (text) => axe('type', text, '--udid', udid);

  const appDataContainer = () => simctl('get_app_container', udid, bundleId, 'data').trim();

  const launch = () => simctl('launch', udid, bundleId);

  const restartSimulator = () => {
    simctl('shutdown', udid);
    simctl('boot', udid);
    simctl('bootstatus', udid, '-b');
  };

  // A stopped process is already in the required state. `simctl terminate`
  // reports that as a non-zero exit, so this one boundary deliberately treats
  // the specific lifecycle operation as idempotent.
  const terminate = () =>
    spawnSync('xcrun', ['simctl', 'terminate', udid, bundleId], {
      encoding: 'utf8',
      stdio: 'ignore',
    });

  const screenshot = (path) => {
    mkdirSync(dirname(path), { recursive: true });
    simctl('io', udid, 'screenshot', path);
    return path;
  };

  const warmDisplay = () => screenshot(join('test-screenshots', 'ios-editor-story-warmup.png'));

  const simulator = () => {
    const listing = JSON.parse(simctl('list', '-j', 'devices'));
    for (const devices of Object.values(listing.devices)) {
      const match = devices.find((device) => device.udid === udid);
      if (match) return match;
    }
    return null;
  };

  const requireTool = () => axe('--version').trim();

  return {
    udid,
    bundleId,
    describeUiTree,
    tapPoint,
    touchPoint,
    typeText,
    appDataContainer,
    launch,
    restartSimulator,
    terminate,
    screenshot,
    warmDisplay,
    simulator,
    requireTool,
  };
}
