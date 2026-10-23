#!/usr/bin/env node
/**
 * User-level Android editor stories against one explicitly claimed emulator.
 * The Android counterpart of tests/ios-editor-stories.mjs, driving the real
 * debug app through its own UI and the editor WebView over CDP (the same client
 * the cross-platform sync harness uses), with no desktop client or sync server.
 *
 * The self-link rename story guards RC-71: renaming a note whose body links to
 * itself relinks that body in Rust, but the editor kept the pre-relink draft as
 * its baseline, so the next save parked a conflict copy and the typed text
 * landed in the copy.
 *
 * The task-Enter story guards #275: Enter at the start of a task item's text
 * closed the soft keyboard, so the next keystrokes went nowhere.
 *
 * The camera story guards #1819: declaring CAMERA (for pairing scans) makes
 * Android refuse the editor's photo hand-off with a SecurityException unless the
 * permission is held, and the toolbar's Take photo crashed every install that
 * had never granted it.
 *
 * Usage:
 *   eval "$(just qa-claim android)"
 *   just android-native
 *   node tests/android-editor-stories.mjs
 *   node tests/android-editor-stories.mjs --story self-link-rename   # one story
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEBUG_PACKAGE } from './lib/android-device.mjs';
import { UI_TIMEOUT_MS } from './lib/android-native/constants.mjs';
import {
  findAndroidLegDevice,
  HARNESS_NOTE_PREFIX,
  startAndroidNativeInstance,
} from './lib/android-native-instance.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

async function check(name, fn) {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`  ✓ ${name} (${Date.now() - start}ms)`);
  } catch (error) {
    results.push({ name, pass: false, error: error.message });
    console.log(`  ✗ ${name} (${Date.now() - start}ms) — ${error.message}`);
  }
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const SELF_ID = `${HARNESS_NOTE_PREFIX}selfy`;
const SELF_RENAMED = `${HARNESS_NOTE_PREFIX}selfx`;
const SELF_TYPED = 'qq77';

async function selfLinkRenameThenType(client) {
  await client.reset();
  client.externalWriteNote(SELF_ID, `back to [[${SELF_ID}]]\n`);
  // The write went around the app, which has no filesystem watcher on Android:
  // restart it so the list names the note.
  client.device.restart();
  await client.openNoteList();
  await client.openNoteInEditor(SELF_ID);

  await client.renameOpenNote(SELF_ID, SELF_RENAMED);
  await client.device.waitFor('the rename to relink the note to itself', 20_000, () =>
    client.readNote(SELF_RENAMED).includes(`[[${SELF_RENAMED}]]`),
  );
  // The editor shows what the file now holds: the relinked link text. Recorded,
  // not thrown, so the story still reports the conflict copy that follows.
  const problems = [];
  try {
    await client.device.waitFor('the editor to show the relinked self-link', 10_000, async () =>
      ((await client.readOpenEditorContent()) ?? '').includes(`[[${SELF_RENAMED}]]`),
    );
  } catch {
    problems.push('the editor still shows the pre-relink link text after the rename');
  }

  // The title field still owns the keyboard; Back closes it without leaving the
  // note. Focusing before the keyboard is gone races the app's own focus drop on
  // that dismissal (#274), so wait it out.
  await client.dismissKeyboard();
  await client.focusOpenEditor();
  await client.typeIntoOpenEditor(SELF_TYPED);
  await client.device.waitFor(
    'the typed text to reach the note, or a conflict copy',
    30_000,
    () => {
      const files = client
        .listNoteFilenames()
        .filter((name) => name.startsWith(HARNESS_NOTE_PREFIX));
      if (files.length > 1) return true;
      return client.readNote(SELF_RENAMED).includes(SELF_TYPED);
    },
  );
  // A parked copy is minted on the same save; give it the time to show.
  await sleep(3_000);

  const files = client.listNoteFilenames().filter((name) => name.startsWith(HARNESS_NOTE_PREFIX));
  const body = client.noteExists(SELF_RENAMED) ? client.readNote(SELF_RENAMED) : '';
  if (JSON.stringify(files) !== JSON.stringify([`${SELF_RENAMED}.md`])) {
    problems.push(`the vault holds ${JSON.stringify(files)}, expected only ${SELF_RENAMED}.md`);
  }
  if (!body.includes(SELF_TYPED))
    problems.push(`the renamed note lost the typed text: ${JSON.stringify(body)}`);
  if (!body.includes(`[[${SELF_RENAMED}]]`)) {
    problems.push(`the renamed note lost its relinked self-link: ${JSON.stringify(body)}`);
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
}

const TASK_ID = `${HARNESS_NOTE_PREFIX}tasks`;

/**
 * Enter at the very start of a task item's text (a checked one and an unchecked
 * one), then keep typing. Guards #275: the checkbox <input> sat in the
 * editable's light DOM, Blink's IME offsets counted it as a character, and the
 * caret the keyboard re-asserted after the split resolved inside the uneditable
 * widget. Blink dropped focus, Android took the keyboard down, and what the
 * user typed next went nowhere.
 */
async function enterAtTaskTextStartKeepsTyping(client) {
  const { device } = client;
  await client.reset();
  // A line above the list, so a task text start is never IME offset 0: on the
  // first line the miscounted offset still landed on the text.
  client.externalWriteNote(TASK_ID, 'Tasks\n\n- [x] done\n- [ ] todo\n');
  device.restart();
  await client.openNoteInEditor(TASK_ID);
  await client.focusOpenEditor();

  const problems = [];
  for (const text of ['done', 'todo']) {
    await client.placeCaretAtStartOf(text);
    device.shell('input keyevent KEYCODE_ENTER');
    // The split itself is right either way; give a dropped focus time to show.
    await sleep(1_000);
    if (!(await client.isOpenEditorFocused()))
      problems.push(`Enter before "${text}" blurred the editor`);
    if (!device.isImeVisible()) problems.push(`Enter before "${text}" closed the keyboard`);
    device.shell(`input text '${text[0]}x'`);
  }
  const expected = 'Tasks\n\n- [ ]\n- [x] dxdone\n- [ ]\n- [ ] txtodo\n';
  try {
    await client.waitForNoteContent(TASK_ID, expected, 10_000);
  } catch {
    problems.push(
      `the note holds ${JSON.stringify(client.readNote(TASK_ID))}, expected ${JSON.stringify(expected)}`,
    );
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
}

const PHOTO_ID = `${HARNESS_NOTE_PREFIX}photo`;
const PHOTO_BODY = 'a note to attach a photo to\n';
const CAMERA = 'android.permission.CAMERA';

/** The system permission prompt's refuse button, found by id so neither its
 *  wording nor which permission controller ships on the image matters. The
 *  second ask labels it "don't ask again". */
function permissionPromptDenyButton(device) {
  const xml = device.adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { allowFailure: true });
  const [, x1, y1, x2, y2] =
    xml.match(
      /resource-id="[\w.]*permissioncontroller:id\/permission_deny(?:_and_dont_ask_again)?_button"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/,
    ) ?? [];
  if (x1 === undefined) return null;
  return { x: (Number(x1) + Number(x2)) >> 1, y: (Number(y1) + Number(y2)) >> 1 };
}

async function photoWithoutCameraPermission(client) {
  const { device } = client;
  await client.reset();
  client.externalWriteNote(PHOTO_ID, PHOTO_BODY);
  // Never asked: no grant, and no refusal remembered from an earlier run.
  // Revoking kills the app, so it happens before the restart.
  device.shell(`pm revoke ${DEBUG_PACKAGE} ${CAMERA}`, { allowFailure: true });
  device.shell(`pm clear-permission-flags ${DEBUG_PACKAGE} ${CAMERA} user-set user-fixed`);
  device.restart();
  await client.openNoteInEditor(PHOTO_ID);
  const pid = device.shell(`pidof ${DEBUG_PACKAGE}`).trim();
  const stillRunning = () => {
    if (device.shell(`pidof ${DEBUG_PACKAGE}`, { allowFailure: true }).trim() !== pid) {
      throw new Error('the app died after Take photo');
    }
  };

  // Take photo sits past the toolbar's right edge on a phone-width screen:
  // swipe the toolbar row left (found by its fixed Dismiss keyboard button).
  const takePhoto = async (which) => {
    await client.focusOpenEditor();
    const button = await device.waitFor(`the ${which} "Take photo"`, UI_TIMEOUT_MS, () => {
      const screen = device.screen();
      const hit = screen.node('Take photo');
      if (hit) return hit;
      const row = screen.node('Dismiss keyboard');
      if (row) {
        const { width } = device.screenSize();
        device.shell(
          `input swipe ${Math.round(width * 0.75)} ${row.y} ${Math.round(width * 0.05)} ${row.y} 300`,
        );
      }
      return null;
    });
    device.tapPoint(button.x, button.y);
  };
  const refuse = async (which) => {
    const deny = await device.waitFor(
      `the ${which} camera permission prompt`,
      UI_TIMEOUT_MS,
      () => {
        stillRunning();
        return permissionPromptDenyButton(device);
      },
    );
    device.tapPoint(deny.x, deny.y);
    await device.waitFor('the app to return to the foreground', UI_TIMEOUT_MS, () =>
      device.isForeground(),
    );
  };

  const cameraOff = async (when) => {
    await device.waitFor(`the camera-off dialog offering Settings ${when}`, UI_TIMEOUT_MS, () => {
      stillRunning();
      return device.isVisible('Open Settings');
    });
    await device.tap('Cancel', { scroll: false });
  };

  // Asked at the moment of use rather than crashing, and asked again after
  // one refusal. The second refusal is final, so it gets the way to Settings
  // at once, and so does every later tap, with no prompt in between.
  await takePhoto('first');
  await refuse('first');
  await takePhoto('second');
  await refuse('second');
  await cameraOff('after the final refusal');
  await takePhoto('third');
  await cameraOff('on the next tap');

  stillRunning();
  const content = await client.readOpenEditorContent();
  if (content !== PHOTO_BODY) {
    throw new Error(`the editor no longer holds the note: ${JSON.stringify(content)}`);
  }
}

const STORIES = [
  {
    id: 'self-link-rename',
    name: 'a self-link rename keeps one note and the text typed after it',
    run: selfLinkRenameThenType,
  },
  {
    id: 'enter-task-start-keyboard',
    name: 'Enter at the start of a task item keeps the keyboard up for typing',
    run: enterAtTaskTextStartKeepsTyping,
  },
  {
    id: 'camera-permission',
    name: 'Take photo without the camera permission asks, then points to Settings',
    run: photoWithoutCameraPermission,
  },
];

/** Every story by default; `--story <id>` (repeatable) runs only those. An id
 *  that names no story is an error, not an empty green run (M11). */
function selectedStories(argv) {
  const wanted = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--story' && argv[i + 1]) wanted.push(argv[(i += 1)]);
    else throw new Error(`unknown argument ${JSON.stringify(argv[i])}; usage: [--story <id>]...`);
  }
  if (wanted.length === 0) return STORIES;
  const known = STORIES.map((story) => story.id);
  const unknown = wanted.filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    throw new Error(`no story named ${unknown.join(', ')}; stories: ${known.join(', ')}`);
  }
  return STORIES.filter((story) => wanted.includes(story.id));
}

async function main() {
  const stories = selectedStories(process.argv.slice(2));
  const leg = findAndroidLegDevice();
  if (!leg.available) throw new Error(`no usable Android device: ${leg.reason}`);
  console.log(`Android editor stories on ${leg.serial}:\n`);
  const client = await startAndroidNativeInstance('android-stories', repoRoot, leg.serial);
  try {
    for (const story of stories) await check(story.name, () => story.run(client));
  } finally {
    client.stop();
  }

  const failed = results.filter((result) => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const result of failed) console.log(`  ${result.name}: ${result.error}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
