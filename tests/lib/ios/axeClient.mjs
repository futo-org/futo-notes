import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { disconnectHardwareKeyboard } from '../../../scripts/lib/simulator-keyboard.mjs';

const DEFAULT_BUNDLE_ID = 'com.futo.notes.dev';

function outputOf(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

/** Every command addresses one explicit simulator; there is no "booted" fallback. */
export function createAxeClient({ udid, bundleId = DEFAULT_BUNDLE_ID, textInput = 'hid' } = {}) {
  if (!udid) {
    throw new Error('no iOS simulator selected — export SIM from: just qa-claim ios');
  }

  const axeBinary = process.env.AXE_BIN || 'axe';
  const axe = (...args) => outputOf(axeBinary, args);
  const simctl = (...args) => outputOf('xcrun', ['simctl', ...args]);

  const describeUiTree = () => JSON.parse(axe('describe-ui', '--udid', udid));

  // AXe tap can report success without delivering input on iOS 27.
  const tapPoint = (x, y) => touchPoint(x, y);

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

  const typeText = (text) => {
    if (textInput === 'hid') return axe('type', text, '--udid', udid);
    if (textInput !== 'softwareKeyboard') throw new Error(`unknown text input: ${textInput}`);
    const keyboardKeys = () => {
      const find = (nodes) => {
        for (const node of nodes) {
          if (node.AXUniqueId?.startsWith('UIKeyboardLayout')) return node.children ?? [];
          const found = find(node.children ?? []);
          if (found) return found;
        }
        return null;
      };
      const keys = find(describeUiTree());
      if (!keys) throw new Error('no visible software keyboard');
      return keys;
    };
    const press = (key) => {
      if (!key?.frame) throw new Error('software keyboard key is unavailable');
      const { x, y, width, height } = key.frame;
      return touchPoint(x + width / 2, y + height / 2);
    };
    for (const character of text) {
      const label = character === ' ' ? 'space' : character === '\n' ? 'return' : character;
      let keys = keyboardKeys();
      let key = keys.find((node) => node.AXLabel === label);
      if (!key && /[a-z]/i.test(character)) {
        const control =
          keys.find((node) => node.AXLabel === 'letters') ??
          keys.find((node) => node.AXLabel === 'shift');
        press(control);
        keys = keyboardKeys();
        key = keys.find((node) => node.AXLabel === label);
      } else if (!key && /[0-9]/.test(character)) {
        press(keys.find((node) => node.AXLabel === 'numbers'));
        key = keyboardKeys().find((node) => node.AXLabel === label);
      }
      if (!key) throw new Error(`software keyboard has no key for ${JSON.stringify(character)}`);
      press(key);
    }
  };

  // The Home button: the app goes `.inactive` then `.background`, as it does
  // for the app switcher.
  const pressHome = () => axe('button', 'home', '--udid', udid);

  const appDataContainer = () => simctl('get_app_container', udid, bundleId, 'data').trim();

  const launch = () => launchUntilRunning(() => simctl('launch', udid, bundleId));

  // Every boot re-attaches the hardware keyboard that hides the software one.
  const restartSimulator = () => {
    simctl('shutdown', udid);
    simctl('boot', udid);
    simctl('bootstatus', udid, '-b');
    disconnectHardwareKeyboard(udid);
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
    pressHome,
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

/** iOS 27 can reject a launch while the previous process is still tearing down.
 * Wait on the returned process handle; other launch errors remain immediate failures. */
export function launchUntilRunning(launch, now = Date.now) {
  const deadline = now() + 5_000;
  for (;;) {
    try {
      return launch();
    } catch (error) {
      const details = `${error.message} ${error.stderr ?? ''}`;
      if (
        !/(?:FBSOpenApplicationServiceErrorDomain|NSPOSIXErrorDomain), code=3/.test(details) ||
        now() >= deadline
      )
        throw error;
    }
  }
}
