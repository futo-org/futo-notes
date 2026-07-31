#!/usr/bin/env node
/**
 * One-shot driver for the native Android app — the counterpart of
 * scripts/cdp-invoke.mjs, which drives the editor WebView inside it.
 *
 * Exists so an interactive session stops re-deriving `uiautomator dump` pipelines
 * and coordinate arithmetic for every look at the app. `state` in particular
 * replaces a ~2s accessibility dump with the app's own answer, and reports things
 * the accessibility tree cannot show at all (which vault is live, whether a
 * migration is in flight).
 *
 * Honors $ANDROID_SERIAL, so `just qa-claim android` is all the setup needed.
 *
 * Usage:
 *   node scripts/android-drive.mjs state
 *   node scripts/android-drive.mjs tree
 *   node scripts/android-drive.mjs tap 'Settings'
 *   node scripts/android-drive.mjs hook storage-mode mode=DEVICE
 *   node scripts/android-drive.mjs wait shellVisible=true
 *   node scripts/android-drive.mjs logs
 *   node scripts/android-drive.mjs shot android-settings
 */

import { createAndroidDevice } from '../tests/lib/android/device.mjs';
import { STATE_FIELDS } from '../tests/lib/android/testHooks.mjs';

const USAGE = `android-drive — drive the native Android app (debug build)

  state                    the app's own state snapshot as JSON (fast; no UI dump)
  tree                     labelled tap targets from the accessibility tree
  tap <label>              tap the control carrying <label>, scrolling to find it
  text <string>            type into the focused field (not the editor WebView)
  key <code> | back | home send a key event (4 = back, 3 = home)
  hook <name> [k=v ...]    run a named debug hook and wait for its ack
  wait <field>=<value>     wait until the state snapshot reports that field
  logs [tags...]           dump the app's tagged logs
  shot <name>              screenshot to test-screenshots/<name>.png
  launch | relaunch        start, or force-stop and start

Any command needs a booted device with the DEBUG app installed:
  just qa-claim android && just android-native
`;

const DEFAULT_LOG_TAGS = [
  'FutoStartup',
  'FutoSearch',
  'NotesStore',
  'FutoTestHook',
  'FutoToolbarDBG',
  'FutoBridgeDBG',
  'AndroidRuntime',
];

/** `k=v` pairs after the command name. Values may contain `=`. */
function parsePairs(args) {
  return Object.fromEntries(
    args.map((arg) => {
      const at = arg.indexOf('=');
      if (at < 0) throw new Error(`expected key=value, got "${arg}"`);
      return [arg.slice(0, at), arg.slice(at + 1)];
    }),
  );
}

/** Compare a state field against text from the command line. */
const matchesField = (actual, expected) => String(actual) === expected;

async function run(command, args, device) {
  switch (command) {
    case 'state':
      console.log(JSON.stringify(await device.state(), null, 2));
      return;

    case 'tree':
      for (const node of device.uiNodes({ refresh: true })) {
        const flags = [node.clickable ? 'clickable' : null, node.enabled ? null : 'disabled']
          .filter(Boolean)
          .join(' ');
        // A note-preview label carries real newlines; print them escaped so one
        // node stays one line and the coordinate column keeps its meaning.
        const label = node.label.replaceAll('\n', '\\n');
        console.log(
          `${String(node.x).padStart(5)},${String(node.y).padEnd(5)} ${label}${flags ? `  (${flags})` : ''}`,
        );
      }
      return;

    case 'tap': {
      const label = args.join(' ');
      if (!label) throw new Error('tap needs a label');
      const node = await device.tap(label);
      console.log(`tapped "${label}" at ${node.x},${node.y}`);
      return;
    }

    case 'text':
      device.typeText(args.join(' '));
      return;

    case 'key':
      device.adb.keyevent(args[0]);
      device.invalidateUi();
      return;

    case 'back':
      device.back();
      return;

    case 'home':
      device.home();
      return;

    case 'hook': {
      const [name, ...pairs] = args;
      if (!name) throw new Error('hook needs a name');
      const reported = await device.callHook(name, parsePairs(pairs));
      console.log(reported ? JSON.stringify(reported, null, 2) : `${name} ok`);
      return;
    }

    case 'wait': {
      const fields = Object.entries(parsePairs(args));
      if (fields.length === 0) throw new Error('wait needs at least one field=value');
      // A misspelled field would otherwise compare against undefined and time out
      // after 30s looking like the app never got there.
      const unknown = fields.map(([field]) => field).filter((f) => !STATE_FIELDS.includes(f));
      if (unknown.length > 0) {
        throw new Error(
          `no such state field: ${unknown.join(', ')} — known: ${STATE_FIELDS.join(', ')}`,
        );
      }
      const description = fields.map(([field, value]) => `${field}=${value}`).join(' and ');
      const state = await device.waitForState(description, (snapshot) =>
        fields.every(([field, value]) => matchesField(snapshot[field], value)),
      );
      console.log(JSON.stringify(state, null, 2));
      return;
    }

    case 'logs':
      console.log(device.adb.readLogcat(...(args.length > 0 ? args : DEFAULT_LOG_TAGS)));
      return;

    case 'shot':
      console.log(device.screenshot(args[0] ?? 'android'));
      return;

    // Wait for the hooks to come up, so the next command in a shell chain does
    // not race a half-started app.
    case 'launch':
      device.launch();
      console.log(JSON.stringify(await device.waitUntilReady(), null, 2));
      return;

    case 'relaunch':
      device.relaunch();
      console.log(JSON.stringify(await device.waitUntilReady(), null, 2));
      return;

    default:
      throw new Error(`unknown command "${command}"`);
  }
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.log(USAGE);
  process.exit(2);
}

const device = createAndroidDevice();
try {
  device.requireReady();
  await run(command, args, device);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
