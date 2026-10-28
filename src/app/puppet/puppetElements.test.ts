// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { localizedText } from '../../shared/localization';
import { collectElements, verbsFor } from './puppetElements';
import { puppetVerb, clearPuppetVerbs, registerPuppetVerbs } from './puppetRegistry';

afterEach(() => {
  clearPuppetVerbs();
  document.body.innerHTML = '';
});

describe('a row names the verb that does what clicking it does', () => {
  it('by its label: whole, or leading a toggle row with its description', () => {
    const byLabel = new Map([
      ['Share crash reports', ['ToggleIssueReporting']],
      ['Share', ['ShareNote']],
      ['Delete', ['DeleteNote', 'DeleteFolder']],
    ]);
    expect(verbsFor('Share crash reports Reports stay on this device', byLabel)).toBe(
      'ToggleIssueReporting',
    );
    expect(verbsFor('Delete', byLabel)).toBe('DeleteNote|DeleteFolder');
    expect(verbsFor('Sharepoint', byLabel)).toBeUndefined();
  });

  it('from the registered verbs, in the app language, a field by its placeholder', () => {
    registerPuppetVerbs(() => [
      puppetVerb('CloseFind', {}, () => {}, { controls: ['editor.find.close'] }),
      puppetVerb('SetTitle', {}, () => {}, { controls: ['notes.untitledPlaceholder'] }),
    ]);
    const close = document.createElement('button');
    close.setAttribute('aria-label', localizedText('editor.find.close'));
    const title = document.createElement('input');
    title.value = 'grocery list';
    title.setAttribute('placeholder', localizedText('notes.untitledPlaceholder'));
    document.body.append(close, title);
    const verbs = collectElements({ all: true }).map((row) => row.verb);
    expect(verbs).toEqual(['CloseFind', 'SetTitle']);
  });

  it('by selector, before any label, for a row the user named: a note row reads OpenNote', () => {
    registerPuppetVerbs(() => [
      puppetVerb('OpenNote', { noteId: 'string' }, () => {}, {
        controlsMatching: '[data-note-id]',
      }),
      puppetVerb('CloseFind', {}, () => {}, { controls: ['editor.find.close'] }),
    ]);
    const note = document.createElement('button');
    note.dataset.noteId = 'work/retro';
    // A note titled like a control still opens the note.
    note.textContent = localizedText('editor.find.close');
    document.body.append(note);
    expect(collectElements({ all: true }).map((row) => [row.note, row.verb])).toEqual([
      ['work/retro', 'OpenNote'],
    ]);
  });

  it('not a dialog, whose text opens with its title rather than naming what it does', () => {
    registerPuppetVerbs(() => [
      puppetVerb('DeleteCurrentNote', {}, () => {}, { controls: ['notes.actions.deleteNote'] }),
    ]);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('tabindex', '-1');
    dialog.textContent = `${localizedText('notes.actions.deleteNote')} Are you sure?`;
    document.body.append(dialog);
    const row = collectElements({ all: true }).find((candidate) => candidate.role === 'dialog');
    expect(row).toBeDefined();
    expect(row!.verb).toBeUndefined();
  });
});
