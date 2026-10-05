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
 * Usage:
 *   eval "$(just qa-claim android)"
 *   just android-native
 *   node tests/android-editor-stories.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  // The title field still owns the keyboard; Back closes it without leaving the note.
  if (client.device.isImeVisible()) client.device.pressBack();
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

async function main() {
  const leg = findAndroidLegDevice();
  if (!leg.available) throw new Error(`no usable Android device: ${leg.reason}`);
  console.log(`Android editor stories on ${leg.serial}:\n`);
  const client = await startAndroidNativeInstance('android-stories', repoRoot, leg.serial);
  try {
    await check('a self-link rename keeps one note and the text typed after it', () =>
      selfLinkRenameThenType(client),
    );
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
