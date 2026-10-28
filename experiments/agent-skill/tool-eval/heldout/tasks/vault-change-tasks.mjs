// Held-out goals that create, rename, move or delete notes and folders.
import {
  all,
  ARTICLES,
  changes,
  J,
  JAPAN,
  linesAdded,
  moved,
  norm,
  only,
  P,
  resolves,
  TAX_2024,
} from './vault-checks.mjs';

export const vaultChangeTasks = [
  {
    id: 'rename-groceries-2025',
    families: ['rename'],
    names: 'direct',
    prompt: 'Rename `groceries 2025` to `groceries archive 2025`.',
    verify: (o) =>
      moved(o, [['personal/shopping/groceries 2025', 'personal/shopping/groceries archive 2025']]),
    reference: [
      ['OpenNoteContextMenu', { noteId: 'personal/shopping/groceries 2025' }],
      ['RenameNote', { title: 'groceries archive 2025' }],
    ],
  },
  {
    id: 'offsite-to-archive',
    families: ['move'],
    names: 'collective',
    prompt: 'Move both of the offsite notes from work into the archive folder.',
    verify: (o) =>
      moved(o, [
        ['work/offsite/offsite agenda', 'archive/offsite agenda'],
        ['work/offsite/offsite logistics', 'archive/offsite logistics'],
      ]),
    reference: [
      ['MoveNote', { noteId: 'work/offsite/offsite agenda', targetPath: 'archive' }],
      ['MoveNote', { noteId: 'work/offsite/offsite logistics', targetPath: 'archive' }],
    ],
  },
  {
    id: 'garden-folder',
    families: ['folders', 'create', 'type'],
    names: 'loose',
    prompt:
      'Make a garden folder inside personal, and in it a note called tomato plan that says plant after the last frost.',
    verify: (o) =>
      all(
        only(o, { added: ['personal/garden/tomato plan'] }),
        /plant after the last frost/i.test(o.read('personal/garden/tomato plan'))
          ? null
          : `tomato plan says ${JSON.stringify(o.read('personal/garden/tomato plan'))}`,
      ),
    reference: [
      ['OpenFolderContextMenu', { path: 'personal', item: 'NewSubfolder' }],
      ['SetNewFolderName', { name: 'garden' }],
      ['SubmitNewFolder'],
      ['OpenFolderContextMenu', { path: 'personal/garden', item: 'NewNoteInFolder' }],
      ['SetTitle', { title: 'tomato plan' }],
      ['Type', { text: 'Plant after the last frost.' }],
    ],
  },
  {
    id: 'delete-empty-untitled',
    families: ['delete'],
    names: 'indirect',
    prompt: 'Delete the empty untitled note in my inbox.',
    verify: (o) => only(o, { removed: ['inbox/untitled'] }),
    reference: [
      ['OpenNoteContextMenu', { noteId: 'inbox/untitled', item: 'DeleteNote' }],
      ['ConfirmDialog'],
    ],
  },
  {
    id: 'rename-articles-folder',
    families: ['folders', 'rename'],
    names: 'loose',
    prompt: 'Rename the articles folder under reading to saved articles.',
    verify: (o) =>
      all(
        moved(
          o,
          ARTICLES.map((id) => [id, id.replace('reading/articles/', 'reading/saved articles/')]),
        ),
        o.vault.folderExists('reading/articles') ? 'reading/articles still exists' : null,
      ),
    reference: [['StartRenamingFolder', { path: 'reading/articles', name: 'saved articles' }]],
  },
  {
    id: 'beacon-retro',
    families: ['create', 'move', 'open', 'append', 'link'],
    names: 'indirect',
    prompt:
      'Start a retro note for Beacon next to its other project notes, and link to it from the Beacon overview.',
    verify: (o) => {
      const got = changes(o);
      const retro = got.added.find(
        (id) => id.startsWith(`${P}/beacon/`) && /retro/i.test(id.slice(`${P}/beacon/`.length)),
      );
      if (!retro) return `no retro note in ${P}/beacon: added ${JSON.stringify(got.added)}`;
      const ids = o.list().map((path) => path.replace(/\.md$/, ''));
      const overview = o.read(`${P}/beacon/overview`);
      const links = [...overview.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map(
        (match) => match[1],
      );
      return all(
        only(o, { added: [retro], modified: [`${P}/beacon/overview`] }),
        linesAdded(overview, `${P}/beacon/overview`, /\[\[/),
        links.some((target) => JSON.stringify(resolves(ids, target)) === JSON.stringify([retro]))
          ? null
          : `no link in the overview resolves to ${retro}: ${JSON.stringify(links)}`,
      );
    },
    reference: [
      ['CreateNote'],
      ['SetTitle', { title: 'retro' }],
      ['ToggleNoteActionsMenu'],
      ['MoveCurrentNoteToFolder'],
      // Beacon is near the end of the picker's list: scroll the picker (centred in the
      // default 1200×800 window) to its bottom, where its row shows, then pick it.
      ['ScrollBy', { x: 600, y: 400, dy: 5000 }],
      ['PickFolder', { path: `${P}/beacon` }],
      ['OpenNote', { noteId: `${P}/beacon/overview` }],
      ['AppendLine', { text: '- [[beacon/retro]]' }],
    ],
  },
  {
    // Deleting a folder moves its notes up (docs/spec/list.md), so the goal is the notes themselves.
    id: 'delete-tax-2024',
    families: ['delete'],
    names: 'collective',
    prompt: "I don't need my 2024 tax notes anymore, delete all of them.",
    verify: (o) => only(o, { removed: TAX_2024 }),
    reference: TAX_2024.flatMap((noteId) => [
      ['OpenNoteContextMenu', { noteId, item: 'DeleteNote' }],
      ['ConfirmDialog'],
    ]),
  },
  {
    id: 'mom-birthday',
    families: ['move', 'rename'],
    names: 'loose',
    prompt:
      "The ideas for mom's birthday note is sitting in my inbox. Move it to the family folder and rename it to mom birthday 2026.",
    verify: (o) =>
      moved(o, [["inbox/ideas for mom's birthday", 'personal/family/mom birthday 2026']]),
    reference: [
      ['MoveNote', { noteId: "inbox/ideas for mom's birthday", targetPath: 'personal/family' }],
      ['OpenNoteContextMenu', { noteId: "personal/family/ideas for mom's birthday" }],
      ['RenameNote', { title: 'mom birthday 2026' }],
    ],
  },
  {
    id: 'weekend-errands',
    families: ['create', 'type', 'checkbox'],
    names: 'direct',
    prompt:
      'Make a new note called weekend errands with two unchecked to-dos: pick up dry cleaning, and return library books.',
    verify: (o) => {
      const text = norm(o.read('weekend errands'));
      const lines = text
        .split('\n')
        .filter((line) => line.trim() && !/^#{1,6} weekend errands$/i.test(line));
      const want = ['- [ ] pick up dry cleaning', '- [ ] return library books'];
      return all(
        only(o, { added: ['weekend errands'] }),
        JSON.stringify(lines.map((line) => line.toLowerCase().replace(/\.$/, ''))) ===
          JSON.stringify(want)
          ? null
          : `weekend errands is ${JSON.stringify(text)}`,
      );
    },
    reference: [
      ['CreateNote'],
      ['SetTitle', { title: 'weekend errands' }],
      ['AppendLine', { text: '- [ ] pick up dry cleaning' }],
      ['AppendLine', { text: '- [ ] return library books' }],
    ],
  },
  {
    id: 'japan-past-trips',
    families: ['folders', 'move'],
    names: 'loose',
    prompt: 'Move the whole japan 2025 folder into past trips.',
    verify: (o) =>
      all(
        moved(
          o,
          JAPAN.map((id) => [id, id.replace(`${J}/`, `travel/past trips/japan 2025/`)]),
        ),
        o.vault.folderExists(J) ? `${J} still exists` : null,
      ),
    reference: [['MoveFolder', { path: J, targetPath: 'travel/past trips' }]],
  },
];
