/**
 * Scenarios: parking a draft inside a keyboard note switch.
 */

import { sleep } from '../lib/mcp-client.mjs';
import { conflictCopiesOf } from './peer-edit-copy-scenarios.mjs';
import {
  assert,
  assertEqual,
  waitForEditorContent,
  waitForOpenNoteState,
  waitForSaveIdle,
} from './waits-and-assertions.mjs';

async function tabTitles(client) {
  return client.readWebview(
    `[...document.querySelectorAll('.tab-pill .tab-title')].map((e) => e.textContent.trim())`,
    'tab titles',
  );
}

/** Press a shell shortcut (primary = Cmd on macOS, Ctrl elsewhere), typing
 * `text` first in the SAME page task when given, so the switch's own flush is
 * the first save of that typing. */
async function pressShellShortcut(client, shortcut, text = null) {
  return client._executeMutation(
    `(() => {
      const mac = /Mac|iPhone|iPad/i.test(navigator.userAgent);
      const { primary, ...init } = ${JSON.stringify(shortcut)};
      if (primary) Object.assign(init, mac ? { metaKey: true } : { ctrlKey: true });
      const text = ${JSON.stringify(text)};
      if (text !== null) window.__notesShellTest.typeInEditor(text);
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
      return true;
    })()`,
    'shell shortcut',
  );
}

async function switchWhoseFlushParks(a, b, variant) {
  const id = `switch park ${variant}`;
  const other = `switch park ${variant} other`;
  await a.writeNote(other, '# Other');
  await a.writeNote(id, '# Base');
  await a.syncNow();
  await b.syncNow();

  // new tab: [.., id] -> Ctrl+T -> a Home tab.
  // close tab: [.., other, id] -> Ctrl+W -> other.
  // next tab: [.., id, other] with id active -> Ctrl+Tab -> other.
  let shortcut;
  await b.openNote(variant === 'close tab' ? other : id);
  if (variant === 'new tab') {
    shortcut = { key: 't', primary: true };
  } else {
    await waitForEditorContent(b, variant === 'next tab' ? '# Base' : '# Other');
    await pressShellShortcut(b, { key: 't', primary: true });
    await waitForOpenNoteState(b, 'open a new tab', (state) => state.originalId === null);
    await b.openNote(variant === 'next tab' ? other : id);
    if (variant === 'next tab') {
      await waitForEditorContent(b, '# Other');
      await pressShellShortcut(b, { key: 'Tab', ctrlKey: true, shiftKey: true });
      shortcut = { key: 'Tab', ctrlKey: true };
    } else {
      shortcut = { key: 'w', primary: true };
    }
  }
  await waitForEditorContent(b, '# Base');
  await b.focusEditor();

  await a.writeNote(id, '# Base\nPeer edit');
  await a.syncNow();
  const pulled = await b.syncNow();
  assertEqual(pulled.summary.downloaded, 1, `[${variant}] B downloaded`);
  assertEqual(
    (await b.getOpenNoteState()).editorContent,
    '# Base',
    `[${variant}] a focused editor defers the peer edit`,
  );
  const tabsBefore = await tabTitles(b);

  await pressShellShortcut(b, shortcut, ' zulu');
  const expectedOpen = variant === 'new tab' ? null : other;
  const arrived = await waitForOpenNoteState(
    b,
    `[${variant}] complete the switch to ${JSON.stringify(expectedOpen)}`,
    (state) => state.originalId === expectedOpen,
  );
  await waitForSaveIdle(b);
  await sleep(1000); // a late re-park would land in this window
  const tabsAfter = await tabTitles(b);
  const copies = await conflictCopiesOf(b, id);
  console.log(
    `    [${variant}] open=${JSON.stringify(arrived.originalId)} tabs ${JSON.stringify(tabsBefore)} -> ` +
      `${JSON.stringify(tabsAfter)} copies=${JSON.stringify(copies)}`,
  );

  assert(
    !tabsAfter.some((title) => title.includes('(conflict')),
    `[${variant}] no tab may be retargeted to the copy: ${JSON.stringify(tabsAfter)}`,
  );
  if (variant === 'new tab') {
    assertEqual(tabsAfter.length, tabsBefore.length + 1, `[${variant}] one tab opens`);
    for (const title of tabsBefore) {
      assert(
        tabsAfter.includes(title),
        `[${variant}] tab ${title} survives: ${JSON.stringify(tabsAfter)}`,
      );
    }
  } else {
    const expectedTabs = [...tabsBefore];
    if (variant === 'close tab') expectedTabs.splice(expectedTabs.lastIndexOf(id), 1);
    assertEqual(JSON.stringify(tabsAfter), JSON.stringify(expectedTabs), `[${variant}] tab strip`);
  }
  assertEqual(
    copies.length,
    1,
    `[${variant}] one conflict mints ONE copy: ${JSON.stringify(copies)}`,
  );
  const copyBody = await b.readNote(copies[0].replace(/\.md$/, ''));
  assert(copyBody.includes('zulu'), `[${variant}] the copy holds the typed word: ${copyBody}`);
  assertEqual(await b.readNote(id), '# Base\nPeer edit', `[${variant}] peer bytes at the id`);
}

export async function parkInsideAKeyboardSwitchLeavesTheSwitchAlone(a, b, server) {
  // The first save after a deferred peer edit parks the draft as a conflict
  // copy. When that save is the flush of a keyboard note switch (the editor
  // keeps DOM focus through Ctrl+T / Ctrl+W / Ctrl+Tab), the tab store has
  // already moved to the destination. Following the copy there retargeted the
  // DESTINATION tab: the new tab showed the copy, the closed tab's neighbor
  // was rewritten to the copy, Ctrl+Tab rewrote the tab it landed on. The
  // user is leaving the note, so the switch completes untouched and the copy
  // is only listed (editor.md, desktop parked disposition).
  await a.connectSync(server.url, server.password);
  await b.connectSync(server.url, server.password);
  await a.pauseAutoSync();
  await b.pauseAutoSync();

  // Each variant reports on its own, so one failure does not hide the others.
  const failures = [];
  for (const variant of ['new tab', 'close tab', 'next tab']) {
    try {
      await switchWhoseFlushParks(a, b, variant);
    } catch (error) {
      console.log(`    [${variant}] FAIL ${error.message}`);
      failures.push(`[${variant}] ${error.message}`);
    }
  }
  assertEqual(failures.length, 0, `switch variants failed: ${failures.join(' | ')}`);
}
