// The `editor` set: goals about what the Milkdown editor added or changed — tables, code
// blocks, list structure, dividers, links, wikilink suggestions — plus the delete dialog.
// Same vault, same rules and same checks as the held-out set (README.md): every verifier
// checks the WHOLE vault, and the goals are judged on, never tuned on. Written 2026-10-05.
import { all, edited, lines, linesAdded, only, original, resolves, same } from './tasks.mjs';

export { fixture } from './tasks.mjs';

const PLAN = 'tech/devices/phone plan comparison';
const LEMONADE = 'recipes/drinks/lemonade';
const PAD_THAI = 'recipes/dinner/pad thai';
const RETRO = 'work/projects/atlas/retro';
const BASH = 'tech/snippets/bash one-liners';

// The note's table rows as cell lists (the separator row left out), and its other lines.
const rowsOf = (text) =>
  lines(text).filter((line) => line.includes(' | ') && !/^---( \| ---)*$/.test(line));
const withoutRows = (text) => lines(text).filter((line) => !line.includes(' | '));
const sameTable = (actual, wantRows) => {
  const rows = rowsOf(actual);
  return JSON.stringify(rows) === JSON.stringify(wantRows)
    ? null
    : `table rows are ${JSON.stringify(rows)}, want ${JSON.stringify(wantRows)}`;
};
const restUnchanged = (id, actual) =>
  JSON.stringify(withoutRows(actual)) === JSON.stringify(withoutRows(original(id)))
    ? null
    : `${id} changed outside its table: ${JSON.stringify(withoutRows(actual))}`;
const planRows = () => rowsOf(original(PLAN));

export const tasks = [
  {
    id: 'plan-visible-price',
    families: ['open', 'table', 'edit text'],
    names: 'loose',
    prompt: 'Visible put their price up to $30. Fix it in my phone plan comparison.',
    // The savings line follows from the prices ($55 - $30), so updating it is right too.
    verify: (o) =>
      all(
        only(o, { modified: [PLAN] }),
        restUnchanged(
          PLAN,
          o.read(PLAN).replace('saves about $25 a month', 'saves about $30 a month'),
        ),
        sameTable(
          o.read(PLAN),
          planRows().map((row) => row.replace('Visible | $25', 'Visible | $30')),
        ),
      ),
    reference: [
      ['OpenNote', { noteId: PLAN }],
      ['Select', { find: '$25' }],
      ['Type', { text: '$30' }],
    ],
  },
  {
    id: 'plan-add-tello',
    families: ['open', 'table', 'type'],
    names: 'loose',
    desktopOnly: true,
    prompt: 'Add Tello to my phone plan comparison table: $19 for 10GB.',
    verify: (o) => {
      const rows = rowsOf(o.read(PLAN));
      const tello = rows.filter((row) => /^tello \| \$19 \| 10 ?gb$/i.test(row));
      return all(
        only(o, { modified: [PLAN] }),
        restUnchanged(PLAN, o.read(PLAN)),
        tello.length === 1
          ? sameTable(o.read(PLAN).replace(/^.*tello.*$/im, ''), planRows())
          : `no single Tello row: ${JSON.stringify(rows)}`,
      );
    },
    reference: [
      ['OpenNote', { noteId: PLAN }],
      ['OpenTableRowMenu', { line: 11, item: 'InsertRowBelow' }],
      ['Select', { find: '15GB' }],
      ['Press', { key: 'ArrowRight' }],
      ['Type', { text: 'Tello\t$19\t10GB' }],
    ],
  },
  {
    id: 'plan-drop-current',
    families: ['open', 'table', 'delete'],
    names: 'indirect',
    desktopOnly: true,
    prompt: "I'm dropping my current plan, take that row out of the phone plan comparison.",
    verify: (o) =>
      all(
        only(o, { modified: [PLAN] }),
        restUnchanged(PLAN, o.read(PLAN)),
        sameTable(
          o.read(PLAN),
          planRows().filter((row) => !row.startsWith('current |')),
        ),
      ),
    reference: [
      ['OpenNote', { noteId: PLAN }],
      ['OpenTableRowMenu', { line: 11, item: 'DeleteRow' }],
    ],
  },
  {
    id: 'plan-quote',
    families: ['open', 'select', 'block type'],
    names: 'indirect',
    prompt:
      'In the phone plan comparison, turn the sentence about how much switching saves into a quote.',
    // "The sentence" is the first of the paragraph's two: quoting it alone, the second left as
    // its own paragraph, reads the goal as literally as quoting the whole paragraph does.
    verify: (o) => {
      const sentence = original(PLAN).replace(
        '\nSwitching saves about $30 a month. ',
        '\n> Switching saves about $30 a month.\n\n',
      );
      return same(o.read(PLAN), sentence, PLAN) === null
        ? only(o, { modified: [PLAN] })
        : edited(o, PLAN, '\nSwitching saves', '\n> Switching saves');
    },
    reference: [['OpenNote', { noteId: PLAN }], ['Select', { find: 'Switching saves' }], ['Quote']],
  },
  {
    id: 'git-log-line',
    families: ['open', 'code block', 'type'],
    names: 'loose',
    prompt: 'Add `git log --oneline` as the last command in my git commands snippet.',
    verify: (o) =>
      edited(
        o,
        'tech/snippets/git commands',
        'ls to tomorrow\n```',
        'ls to tomorrow\ngit log --oneline\n```',
      ),
    reference: [
      ['OpenNote', { noteId: 'tech/snippets/git commands' }],
      ['Select', { find: 'ls to tomorrow' }],
      ['Press', { key: 'ArrowRight' }],
      ['Type', { text: '\ngit log --oneline' }],
    ],
  },
  {
    id: 'bash-new-block',
    families: ['open', 'code block', 'type'],
    names: 'loose',
    prompt: 'At the bottom of my bash one-liners, add a new code block with du -sh *',
    verify: (o) => {
      const want = lines(original(BASH));
      const got = lines(o.read(BASH));
      const gained = got.slice(want.length);
      return all(
        only(o, { modified: [BASH] }),
        JSON.stringify(got.slice(0, want.length)) === JSON.stringify(want) &&
          gained.length === 3 &&
          /^```\w*$/.test(gained[0]) &&
          gained[1] === 'du -sh *' &&
          gained[2] === '```'
          ? null
          : `${BASH} is ${JSON.stringify(o.read(BASH))}`,
      );
    },
    reference: [
      ['OpenNote', { noteId: BASH }],
      ['Select', { find: 'ls month tomorrow' }],
      ['Press', { key: 'ArrowRight' }],
      ['Press', { key: 'Mod-Enter' }],
      ['CodeBlock'],
      ['Type', { text: 'du -sh *' }],
    ],
  },
  {
    id: 'lemonade-third-step',
    families: ['open', 'ordered list', 'type'],
    names: 'loose',
    prompt: 'My lemonade recipe needs a third step: serve over ice.',
    verify: (o) =>
      all(
        only(o, { modified: [LEMONADE] }),
        linesAdded(o.read(LEMONADE), LEMONADE, /^3\. serve over ice\.?$/i),
      ),
    reference: [
      ['OpenNote', { noteId: LEMONADE }],
      ['Select', { find: 'Simmer for 20 minutes.' }],
      ['Press', { key: 'ArrowRight' }],
      ['Type', { text: '\nServe over ice.' }],
    ],
  },
  {
    id: 'lemonade-no-paprika',
    families: ['open', 'list', 'delete text'],
    names: 'loose',
    prompt: 'Take the paprika out of the lemonade recipe.',
    verify: (o) =>
      all(
        only(o, { modified: [LEMONADE] }),
        same(o.read(LEMONADE), original(LEMONADE).replace('- 1 tsp paprika\n', ''), LEMONADE),
      ),
    reference: [
      ['OpenNote', { noteId: LEMONADE }],
      ['Select', { find: '1 tsp paprika' }],
      ['Press', { key: 'Backspace', count: 2 }],
    ],
  },
  {
    id: 'lemonade-checklist',
    families: ['open', 'select', 'block type'],
    names: 'loose',
    prompt: 'Make the lemonade ingredients a checklist so I can tick them off.',
    verify: (o) => {
      const want = original(LEMONADE).replace(
        /^- (?=(2 eggs|1 cup flour|1 tsp cumin|1 tsp paprika|fresh basil)$)/gm,
        '- [ ] ',
      );
      return all(only(o, { modified: [LEMONADE] }), same(o.read(LEMONADE), want, LEMONADE));
    },
    reference: [
      ['OpenNote', { noteId: LEMONADE }],
      ['Select', { find: '2 eggs\n1 cup flour\n1 tsp cumin\n1 tsp paprika\nfresh basil' }],
      ['TaskList'],
    ],
  },
  {
    id: 'tech-todo-subtask',
    families: ['open', 'list', 'indent'],
    names: 'loose',
    prompt: 'In my tech todo, make backing up the phone a sub-task of updating the NAS.',
    verify: (o) => {
      const got = lines(o.read('tech/tech todo'));
      return all(
        only(o, { modified: ['tech/tech todo'] }),
        got.length === 3 &&
          got[0] === '- [ ] renew domain' &&
          got[1] === '- [ ] update the NAS' &&
          /^\s{2,4}- \[ \] back up the phone$/.test(got[2])
          ? null
          : `tech todo is ${JSON.stringify(o.read('tech/tech todo'))}`,
      );
    },
    reference: [
      ['OpenNote', { noteId: 'tech/tech todo' }],
      ['Select', { find: 'back up the phone' }],
      ['Indent'],
    ],
  },
  {
    id: 'chores-reorder',
    families: ['open', 'move block'],
    names: 'indirect',
    prompt: 'Move take out recycling to the top of my Saturday chores.',
    verify: (o) =>
      all(
        only(o, { modified: ['personal/home/saturday chores'] }),
        same(
          o.read('personal/home/saturday chores'),
          '# Saturday chores\n\n- [ ] take out recycling\n- [ ] vacuum\n- [ ] laundry\n- [x] water plants',
          'saturday chores',
        ),
      ),
    reference: [
      ['OpenNote', { noteId: 'personal/home/saturday chores' }],
      // A drag moves the whole list (docs/spec/editor.md), so one item is moved by its text.
      ['ReplaceLine', { line: 2, text: '- [ ] take out recycling' }],
      ['ReplaceLine', { line: 3, text: '- [ ] vacuum' }],
      ['ReplaceLine', { line: 4, text: '- [ ] laundry' }],
      ['ReplaceLine', { line: 5, text: '- [x] water plants' }],
    ],
  },
  {
    id: 'reading-divider',
    families: ['open', 'divider', 'type'],
    names: 'loose',
    prompt: 'Put a divider line between the two sections of my reading list.',
    verify: (o) => {
      const want = lines(original('reading/reading list'));
      const got = lines(o.read('reading/reading list'));
      const at = want.indexOf('Up next');
      return all(
        only(o, { modified: ['reading/reading list'] }),
        JSON.stringify([...got.slice(0, at), ...got.slice(at + 1)]) === JSON.stringify(want) &&
          /^(\*\*\*|---|___|\* \* \*|- - -)$/.test(got[at])
          ? null
          : `reading list is ${JSON.stringify(o.read('reading/reading list'))}`,
      );
    },
    reference: [
      ['OpenNote', { noteId: 'reading/reading list' }],
      ['Select', { find: 'Project Hail Mary' }],
      ['Press', { key: 'ArrowRight' }],
      ['Type', { text: '\n\n---' }],
    ],
  },
  {
    id: 'lisbon-hotel-link',
    families: ['open', 'select', 'link'],
    names: 'indirect',
    prompt: 'Link the hotel name in my Lisbon itinerary to https://casadolargo.pt',
    verify: (o) =>
      edited(
        o,
        'travel/lisbon/lisbon itinerary',
        'Casa do Largo',
        '[Casa do Largo](https://casadolargo.pt)',
      ),
    reference: [
      ['OpenNote', { noteId: 'travel/lisbon/lisbon itinerary' }],
      ['Select', { find: 'Casa do Largo' }],
      ['Link'],
      ['SetLinkUrl', { url: 'https://casadolargo.pt' }],
      ['ApplyLink'],
    ],
  },
  {
    id: 'grocery-add-two',
    families: ['open', 'list', 'type'],
    names: 'loose',
    prompt: 'Add coffee filters and lentils to my grocery list.',
    verify: (o) => {
      const id = 'personal/shopping/grocery list';
      const text = o.read(id);
      return all(
        only(o, { modified: [id] }),
        linesAdded(text, id, /^- \[ \] (coffee filters|lentils)$/i, 2),
        /coffee filters/i.test(text) && /lentils/i.test(text)
          ? null
          : `${id} lacks one of them: ${JSON.stringify(text)}`,
      );
    },
    reference: [
      ['OpenNote', { noteId: 'personal/shopping/grocery list' }],
      ['Select', { find: 'bananas' }],
      ['Press', { key: 'ArrowRight' }],
      ['Type', { text: '\ncoffee filters\nlentils' }],
    ],
  },
  {
    id: 'pad-thai-headings',
    families: ['open', 'block type'],
    names: 'loose',
    prompt:
      'The Ingredients and Steps headings in my pad thai recipe are too big, make them level 3.',
    verify: (o) =>
      all(
        only(o, { modified: [PAD_THAI] }),
        same(
          o.read(PAD_THAI),
          original(PAD_THAI)
            .replace('## Ingredients', '### Ingredients')
            .replace('## Steps', '### Steps'),
          PAD_THAI,
        ),
      ),
    reference: [
      ['OpenNote', { noteId: PAD_THAI }],
      ['Select', { find: 'Ingredients' }],
      ['Heading3'],
      ['Select', { find: 'Steps' }],
      ['Heading3'],
    ],
  },
  {
    id: 'atlas-roadmap-link',
    families: ['open', 'type', 'link suggestion'],
    names: 'indirect',
    prompt: 'At the end of the Atlas retro, add a link to the Atlas roadmap note.',
    verify: (o) => {
      const retro = o.read(RETRO);
      const ids = o.list().map((path) => path.replace(/\.md$/, ''));
      const links = [...retro.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((match) => match[1]);
      return all(
        only(o, { modified: [RETRO] }),
        linesAdded(retro, RETRO, /\[\[/),
        links.some(
          (target) =>
            JSON.stringify(resolves(ids, target)) ===
            JSON.stringify(['work/projects/atlas/roadmap']),
        )
          ? null
          : `no link resolves to the Atlas roadmap: ${JSON.stringify(links)}`,
      );
    },
    reference: [
      ['OpenNote', { noteId: RETRO }],
      ['Select', { find: 'the indexer rewrite' }],
      ['Press', { key: 'ArrowRight' }],
      ['Type', { text: '\n[[atlas/roadmap' }],
      ['PickLinkSuggestion', { noteId: 'work/projects/atlas/roadmap' }],
    ],
  },
  {
    id: 'delete-scratch',
    families: ['delete', 'dialog'],
    names: 'direct',
    prompt: "Delete my scratch note, I don't need it.",
    verify: (o) => only(o, { removed: ['scratch'] }),
    reference: [
      ['OpenNoteContextMenu', { noteId: 'scratch', item: 'DeleteNote' }],
      ['ConfirmDialog'],
    ],
  },
];

if (process.argv[1] === new URL(import.meta.url).pathname) {
  for (const task of tasks)
    console.log(`${task.id.padEnd(24)} ${task.names.padEnd(10)} ${task.families.join(', ')}`);
  console.log(`${tasks.length} tasks`);
}
