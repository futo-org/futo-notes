#!/usr/bin/env node
/**
 * User-level regression for the Android storage-location switch
 * (docs/spec/settings.md — Storage).
 *
 * Drives the REAL native app on a device/emulator and asserts what actually lands
 * on disk:
 *
 *   App storage  → Device storage   (empty target: copied, source removed)
 *   Device storage → App storage    (empty target: copied, Device source RETAINED
 *                                    as a backup — other apps can write it
 *                                    outside our migration gate)
 *   App storage  → Device storage   (target now holds that diverged backup, so it
 *                                    is OPENED after a confirmation: nothing
 *                                    copied, merged, or deleted)
 *
 * Guards two regressions. The "Moving notes…" hang: the pre-migration editor
 * freeze used to await a WebView round-trip that a window-detached, pre-warmed
 * WebView could never dispatch, so every switch stalled on the blocking overlay
 * with no error and no way out. And the dead end after it: an occupied target was
 * refused outright, so the retained Device backup permanently blocked ever
 * switching back to Device storage.
 *
 * Waits are on the app's own reported state or on the filesystem, never on a
 * fixed sleep, so a re-introduced hang fails loudly instead of flaking. The
 * switches run through the debug build's `storage-mode` hook — the same entry
 * point Settings calls — and the last story taps the real Settings path, so a
 * broken picker, permission rationale, or confirmation dialog cannot pass
 * unnoticed. See tests/lib/android/ and the /verify skill's references/android.md.
 *
 * Requires an emulator/device with the DEBUG app installed (`just android-native`)
 * and honors $ANDROID_SERIAL. Not wired into CI: GitLab runners have no emulator.
 *
 * Usage:
 *   just test-android-storage
 *   node tests/android-storage-migration.mjs
 */

import { createAndroidDevice } from './lib/android/device.mjs';
import { parseDirListing } from './lib/android/adbClient.mjs';

const PACKAGE = 'com.futo.notes.dev';
// The debug build's dev/prod split (AGENTS.md M3): "FUTO Notes Dev", not "FUTO Notes".
const DEVICE_VAULT = '/sdcard/Documents/FUTO Notes Dev';
const APP_VAULT = `/sdcard/Android/data/${PACKAGE}/files/futo-notes`;
const SEEDED_NOTE = 'Groceries.md';
const SEEDED_BODY = '# Groceries\n- milk\n- eggs\n';
/** Diverges the two folders so the destination can't be adopted as a match. */
const EDITED_BODY = '# Groceries\n- milk\n- eggs\n- bread\n';

// A migration copies + verifies + fsyncs the whole vault and then relaunches the
// process, so allow real work; the point is that it is BOUNDED.
const MIGRATION_TIMEOUT_MS = 90_000;

const device = createAndroidDevice({ pkg: PACKAGE });
const { adb } = device;

// ── Vault state ─────────────────────────────────────────────────

/** The two facts every migration assertion needs, in one adb round-trip. */
function vaultContents(path) {
  const [listing, note] = adb.shellBatch([
    adb.listDirCommand(path),
    adb.readFileCommand(`${path}/${SEEDED_NOTE}`),
  ]);
  return { entries: parseDirListing(listing), note };
}

/** The migration's own success criteria: both notes present at the destination,
 *  the seeded one byte-for-byte, and the app running on that mode. */
async function waitForVaultAt(path, mode) {
  await device.waitFor(
    `the vault to arrive at ${path} in ${mode} mode`,
    async () => {
      const { entries } = vaultContents(path);
      if (!entries.includes('Welcome.md') || !entries.includes(SEEDED_NOTE)) return false;
      return (await device.state()).storageMode === mode;
    },
    {
      timeoutMs: MIGRATION_TIMEOUT_MS,
      describeFailure: () =>
        `${path} holds: ${vaultContents(path).entries.join(', ') || '(nothing)'}`,
    },
  );
  const { note } = vaultContents(path);
  if (note !== SEEDED_BODY) {
    throw new Error(`migrated note content differs at ${path}: ${JSON.stringify(note)}`);
  }
}

/** The switch finished and left a usable app — not the blocking overlay. */
async function waitForNoteListOn(mode) {
  const state = await device.waitForState(
    `the note list on the ${mode} vault`,
    (snapshot) => snapshot.storageMode === mode && snapshot.shellVisible,
    { timeoutMs: MIGRATION_TIMEOUT_MS },
  );
  if (state.movingNotes) throw new Error('still stuck on the migration overlay');
}

// ── Flows ───────────────────────────────────────────────────────

/** Reset to a first-run install with All-files access already granted, so the
 *  Device-storage leg never needs the system permission screen. */
function resetInstall() {
  adb.clearData();
  adb.shell(`appops set --uid ${PACKAGE} MANAGE_EXTERNAL_STORAGE allow`);
  adb.removeDir(DEVICE_VAULT);
}

/** The first-run picker itself is under test here, so this taps through it. */
async function completeFirstRunOnAppStorage() {
  device.launch();
  await device.waitForLabel('Where should your notes live?');
  await device.tap('App storage');
  await device.tap('Continue');
  // Rust seeds the welcome note during bootstrap; that is the vault existing.
  await device.waitFor('the seeded vault', () =>
    vaultContents(APP_VAULT).entries.includes('Welcome.md'),
  );
}

/** A second note so a migration moves real user content, not just the seed. */
function seedSecondNote(path) {
  adb.writeFile(`${path}/${SEEDED_NOTE}`, SEEDED_BODY);
  if (!vaultContents(path).entries.includes(SEEDED_NOTE)) {
    throw new Error(`failed to seed ${SEEDED_NOTE} in ${path}`);
  }
}

/**
 * Ask for the switch the way Settings does. Waiting for the app to be listening
 * first matters: this hook must be sent exactly once — the previous story ended in
 * a process restart, and a re-sent switch could run twice.
 */
async function switchStorageTo(mode) {
  await device.waitUntilReady();
  await device.callHook('storage-mode', { mode });
}

/** Accept the open-existing-folder confirmation once it is actually up. */
async function confirmOpeningExistingFolder() {
  await device.waitForState(
    'the switch to await confirmation',
    (snapshot) => snapshot.awaitingStorageConfirmation,
  );
  await device.callHook('confirm-storage');
}

/** Settings → Storage location → <label> → Continue, through the real UI. */
async function tapThroughStoragePicker(label) {
  await device.tap('Folders', { scroll: false });
  await device.tap('Settings');
  await device.tap('Storage location');
  await device.waitForLabel('Where should your notes live?');
  await device.tap(label);
  await device.tap('Continue');
  if (label === 'Device storage') {
    await device.waitForLabel('Allow access to your files');
    await device.tap('Continue');
  }
}

// ── Checks ──────────────────────────────────────────────────────

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

async function main() {
  device.requireReady();
  console.log(`Storage-migration stories on ${device.serial ?? 'the connected device'}:\n`);

  await check('first run picks App storage', async () => {
    resetInstall();
    await completeFirstRunOnAppStorage();
    await device.waitForState(
      'the app to come up on App storage',
      (snapshot) => snapshot.storageMode === 'APP' && snapshot.shellVisible,
    );
  });

  await check('App storage → Device storage moves the vault and removes the source', async () => {
    seedSecondNote(APP_VAULT);
    await switchStorageTo('DEVICE');
    await waitForVaultAt(DEVICE_VAULT, 'DEVICE');
    if (adb.exists(APP_VAULT)) {
      throw new Error('the App-storage source survived a finalized migration');
    }
  });

  await check('the app relaunches on the Device vault without stalling', async () => {
    await waitForNoteListOn('DEVICE');
  });

  await check('Device storage → App storage moves the vault and retains the source', async () => {
    await switchStorageTo('APP');
    await waitForVaultAt(APP_VAULT, 'APP');
    // Policy: a Device source is never deleted — other apps can write it
    // outside FUTO Notes' migration gate (docs/spec/settings.md).
    if (!vaultContents(DEVICE_VAULT).entries.includes('Welcome.md')) {
      throw new Error('the Device source must be retained as a backup, not deleted');
    }
  });

  // The round trip the old "destination already contains different files"
  // refusal made impossible: the retained Device backup permanently blocked
  // ever switching back to Device storage.
  await check(
    'switching back to a diverged Device folder opens it instead of refusing',
    async () => {
      adb.writeFile(`${APP_VAULT}/${SEEDED_NOTE}`, EDITED_BODY);
      await switchStorageTo('DEVICE');
      await confirmOpeningExistingFolder();
      await waitForNoteListOn('DEVICE');
      // Opened, not copied: the Device folder still holds its own older note...
      if (vaultContents(DEVICE_VAULT).note !== SEEDED_BODY) {
        throw new Error('opening a folder must not overwrite what it already holds');
      }
      // ...and nothing was deleted: the edit is still in the App folder.
      if (vaultContents(APP_VAULT).note !== EDITED_BODY) {
        throw new Error('the previous folder must keep its notes, including the newer edit');
      }
    },
  );

  // Everything above drives the hook, which posts to the same entry point the
  // picker calls. This one walks the real Settings taps, so a broken picker,
  // permission rationale, or confirmation dialog cannot pass unnoticed.
  await check('the real Settings path switches storage and states both sides', async () => {
    const before = await device.waitUntilReady();
    await tapThroughStoragePicker('App storage');
    await device.waitForLabel('Open the notes already there?');
    const shown = device
      .uiNodes()
      .map((node) => node.label)
      .join(' ');
    // Derived from the app's own state, not hardcoded: which folder is "current"
    // depends on where the previous story left it.
    for (const expected of [`${before.notes} notes`, 'not moved or deleted', before.vaultPath]) {
      if (!shown.includes(expected)) {
        throw new Error(`the confirmation never stated ${JSON.stringify(expected)}`);
      }
    }
    // Once only: a dialog that closes between the look and the tap would leave a
    // retry landing on the Settings screen underneath, where the Danger zone is.
    await device.tap('Open that folder', { scroll: false });
    await waitForNoteListOn('APP');
  });

  const failed = results.filter((result) => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const result of failed) console.log(`  ${result.name}: ${result.error}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
