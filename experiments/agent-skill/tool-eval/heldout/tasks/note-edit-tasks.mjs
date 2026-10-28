// Held-out goals that edit the text of one note.
import { all, edited, L, linesAdded, norm, only, original, P, same } from './vault-checks.mjs';

export const noteEditTasks = [
  {
    id: 'grocery-tick',
    families: ['checkbox'],
    names: 'loose',
    prompt: 'Tick off eggs and oat milk on my grocery list.',
    verify: (o) =>
      all(
        only(o, { modified: ['personal/shopping/grocery list'] }),
        same(
          o.read('personal/shopping/grocery list'),
          original('personal/shopping/grocery list')
            .replace('- [ ] eggs', '- [x] eggs')
            .replace('- [ ] oat milk', '- [x] oat milk'),
          'grocery list',
        ),
      ),
    reference: [
      ['OpenNote', { noteId: 'personal/shopping/grocery list' }],
      ['ToggleTask', { line: 1 }],
      ['ToggleTask', { line: 2 }],
    ],
  },
  {
    id: 'broken-checkbox',
    families: ['open', 'edit line'],
    names: 'indirect',
    prompt:
      "The plumber item in my moving checklist isn't showing up as a checkbox. Fix it so it's a normal unticked one.",
    verify: (o) =>
      edited(
        o,
        'personal/home/apartment move checklist',
        '-[ ] call the plumber',
        '- [ ] call the plumber',
      ),
    reference: [
      ['OpenNote', { noteId: 'personal/home/apartment move checklist' }],
      ['Select', { find: ' -[ ] ' }],
      ['Press', { key: 'Enter' }],
    ],
  },
  {
    id: 'phone-price',
    families: ['open', 'edit text'],
    names: 'indirect',
    prompt: 'In the note I made about the new phone, change the expected price to $1,099.',
    verify: (o) =>
      edited(o, 'tech/devices/iPhone 18', 'Expected price: $999', 'Expected price: $1,099'),
    reference: [
      ['OpenNote', { noteId: 'tech/devices/iPhone 18' }],
      ['Replace', { find: '$999', text: '$1,099' }],
    ],
  },
  {
    id: 'journal-latest',
    families: ['open', 'append'],
    names: 'indirect',
    prompt: 'Add a line to my most recent journal entry: finally fixed the bike.',
    verify: (o) =>
      all(
        only(o, { modified: ['journal/2026/2026-09-24'] }),
        linesAdded(o.read('journal/2026/2026-09-24'), 'journal/2026/2026-09-24', /fixed the bike/i),
      ),
    reference: [
      ['OpenNote', { noteId: 'journal/2026/2026-09-24' }],
      ['AppendLine', { text: 'Finally fixed the bike.' }],
    ],
  },
  {
    id: 'journal-typo',
    families: ['open', 'edit text'],
    names: 'indirect',
    prompt:
      "There's a typo in my journal entry from August 3rd, recieved instead of received. Fix it.",
    verify: (o) => edited(o, 'journal/2026/2026-08-03', 'recieved', 'received'),
    reference: [
      ['OpenNote', { noteId: 'journal/2026/2026-08-03' }],
      ['Replace', { find: 'recieved', text: 'received' }],
    ],
  },
  {
    id: 'lisbon-address',
    families: ['open', 'select', 'copy', 'paste'],
    names: 'indirect',
    prompt:
      'Copy the hotel address from my Lisbon itinerary and paste it at the bottom of the Lisbon packing list.',
    verify: (o) =>
      all(
        only(o, { modified: [`${L}/lisbon packing list`] }),
        linesAdded(
          o.read(`${L}/lisbon packing list`),
          `${L}/lisbon packing list`,
          /Rua das Flores 12/,
        ),
      ),
    reference: [
      ['OpenNote', { noteId: `${L}/lisbon itinerary` }],
      ['Select', { find: 'Rua das Flores 12, 1200-195 Lisboa' }],
      ['Copy'],
      ['OpenNote', { noteId: `${L}/lisbon packing list` }],
      ['PlaceCaret', { at: 61 }],
      ['Paste'],
    ],
  },
  {
    id: 'atlas-bold',
    families: ['open', 'select', 'format'],
    names: 'loose',
    prompt: 'In the Atlas roadmap, make the launch date (November 12) bold.',
    verify: (o) => edited(o, `${P}/atlas/roadmap`, 'November 12', '**November 12**'),
    reference: [
      ['OpenNote', { noteId: `${P}/atlas/roadmap` }],
      ['Select', { find: 'November 12' }],
      ['Bold'],
    ],
  },
  {
    id: 'reading-heading',
    families: ['open', 'select', 'format'],
    names: 'loose',
    prompt: 'In my reading list, turn "Currently reading" into a heading.',
    verify: (o) => {
      const text = norm(o.read('reading/reading list'));
      const heading = text.split('\n').find((line) => /^#{1,6} Currently reading$/.test(line));
      return all(
        only(o, { modified: ['reading/reading list'] }),
        heading
          ? same(
              text,
              original('reading/reading list').replace('\nCurrently reading\n', `\n${heading}\n`),
              'reading list',
            )
          : `no "Currently reading" heading in ${JSON.stringify(text)}`,
      );
    },
    reference: [
      ['OpenNote', { noteId: 'reading/reading list' }],
      ['Select', { find: 'Currently reading' }],
      ['Heading2'],
    ],
  },
  {
    id: 'pancake-vanilla',
    families: ['open', 'insert line'],
    names: 'indirect',
    prompt: "Add 1 tsp vanilla to the pancake recipe's ingredients, right after the milk.",
    verify: (o) => {
      const id = 'recipes/breakfast/fluffy pancakes';
      const lines = norm(o.read(id)).split('\n');
      const milk = lines.indexOf('- 1 1/4 cups milk');
      const vanilla = lines[milk + 1] ?? '';
      return all(
        only(o, { modified: [id] }),
        /^- 1 tsp vanilla( extract)?$/i.test(vanilla)
          ? same(
              o.read(id),
              original(id).replace('- 1 1/4 cups milk\n', `- 1 1/4 cups milk\n${vanilla}\n`),
              id,
            )
          : `line after the milk is ${JSON.stringify(vanilla)}`,
      );
    },
    reference: [
      ['OpenNote', { noteId: 'recipes/breakfast/fluffy pancakes' }],
      ['InsertLine', { afterLine: 7, text: '1 tsp vanilla' }],
    ],
  },
  {
    id: 'lisbon-tag',
    families: ['open', 'tags'],
    names: 'indirect',
    prompt: 'Tag my Lisbon itinerary with travel.',
    verify: (o) =>
      all(
        only(o, { modified: [`${L}/lisbon itinerary`] }),
        linesAdded(o.read(`${L}/lisbon itinerary`), `${L}/lisbon itinerary`, /(^|\s)#travel(\s|$)/),
      ),
    reference: [
      ['OpenNote', { noteId: `${L}/lisbon itinerary` }],
      ['StartAddingTag', { name: 'travel' }],
    ],
  },
  {
    id: 'saturday-done',
    families: ['open', 'checkbox'],
    names: 'indirect',
    prompt: 'I did all my Saturday chores, check everything off.',
    verify: (o) =>
      all(
        only(o, { modified: ['personal/home/saturday chores'] }),
        same(
          o.read('personal/home/saturday chores'),
          original('personal/home/saturday chores').replaceAll('- [ ]', '- [x]'),
          'saturday chores',
        ),
      ),
    reference: [
      ['OpenNote', { noteId: 'personal/home/saturday chores' }],
      ['ToggleTask', { line: 2 }],
      ['ToggleTask', { line: 3 }],
      ['ToggleTask', { line: 5 }],
    ],
  },
  {
    id: 'standup-blockers',
    families: ['open', 'edit text'],
    names: 'direct',
    prompt:
      'In `work/meetings/2026-09-22 standup`, change `Blockers: none` to `Blockers: waiting on design review`.',
    verify: (o) =>
      edited(
        o,
        'work/meetings/2026-09-22 standup',
        'Blockers: none',
        'Blockers: waiting on design review',
      ),
    reference: [
      ['OpenNote', { noteId: 'work/meetings/2026-09-22 standup' }],
      ['Replace', { find: 'Blockers: none', text: 'Blockers: waiting on design review' }],
    ],
  },
  {
    id: 'strike-gave-up',
    families: ['open', 'select', 'format'],
    names: 'indirect',
    prompt: 'I gave up on The Name of the Wind, strike it through in my reading list.',
    verify: (o) =>
      edited(o, 'reading/reading list', '- The Name of the Wind', '- ~~The Name of the Wind~~'),
    reference: [
      ['OpenNote', { noteId: 'reading/reading list' }],
      ['Select', { find: 'The Name of the Wind' }],
      ['Strikethrough'],
    ],
  },
  {
    id: 'grocery-budget',
    families: ['open', 'edit text'],
    names: 'loose',
    prompt: 'Bump the monthly target in my grocery budget up to $450.',
    verify: (o) =>
      edited(o, 'personal/finance/grocery budget', 'Monthly target: $400', 'Monthly target: $450'),
    reference: [
      ['OpenNote', { noteId: 'personal/finance/grocery budget' }],
      ['Replace', { find: '$400', text: '$450' }],
    ],
  },
];
