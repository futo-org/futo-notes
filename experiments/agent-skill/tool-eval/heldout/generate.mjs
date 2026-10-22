// The held-out set's vault: ~500 notes written the way one person's vault grows over two years.
// Deterministic: a fixed seed and no clock, so every run of `generate()` writes the same bytes.
// Hand-written notes (`FIXED`) are the ones goals are about and the distractors around them;
// the generated bulk (journal, meetings, recipes, snippets, books…) is what makes candidate
// choice hard. `node generate.mjs` rewrites `vault/` and prints the stats.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXED } from './generate/fixed-notes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const vaultDir = join(here, 'vault');
const SEED = 20260925;

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { FIXED };

// ── Generated bulk ──
const JOURNAL_LINES = [
  'Slept badly, too hot.',
  'Coffee with Sam downtown.',
  'Worked from the library all day.',
  'Rain all afternoon, stayed in and read.',
  'Ran 5k before breakfast.',
  'Meal prepped for the week.',
  'Called mom, she sounds good.',
  'Finally cleaned the fridge.',
  'Tried the new ramen place, too salty.',
  'Standup ran long again.',
  'Walked to the lake in the evening.',
  'Bought groceries, forgot the eggs.',
  'Watched two episodes of the new show.',
  'Headache most of the day.',
  'Fixed the leaky faucet myself.',
  'Long call about the atlas launch.',
  'Played guitar for an hour, the F chord is getting easier.',
  'Did my Spanish lesson on the train.',
  'The phone battery is dying by 3pm now.',
  'Farmers market: peaches are back.',
  'Read 60 pages of Piranesi.',
  'Went to bed early.',
  'Dinner with Priya and Marcus.',
  'Garden needs weeding.',
  'Thinking about the Lisbon trip.',
  'Lazy Sunday, made pancakes.',
  'The bike chain slipped again on the hill.',
  'Budget check: over on groceries again.',
  'Cleaned up the homelab cables.',
  'Long walk, podcast about sleep.',
];
const MEETING_LINES = [
  'Yesterday: code review',
  'Yesterday: atlas indexing',
  'Yesterday: interviews',
  'Yesterday: bug triage',
  'Today: beacon checks',
  'Today: atlas ranking',
  'Today: write the design doc',
  'Today: on-call handoff',
  'Blockers: waiting on design review',
  'Blockers: none',
  'Blockers: flaky CI',
  'Blockers: none',
];
const RECIPES = {
  breakfast: [
    'overnight oats',
    'shakshuka',
    'french toast',
    'breakfast burritos',
    'granola',
    'crepes',
  ],
  dinner: [
    'chicken tikka masala',
    'mushroom risotto',
    'sheet pan gnocchi',
    'black bean tacos',
    'pad thai',
    'lentil soup',
    'beef stew',
    'miso salmon',
    'chickpea curry',
    'pasta alla vodka',
    'stir fry',
    'fried rice',
    'pho',
    'chili',
    'baked ziti',
    'fish tacos',
    'bibimbap',
    'dal',
    'minestrone',
    'roast chicken',
  ],
  baking: [
    'chocolate chip cookies',
    'focaccia',
    'brownies',
    'apple pie',
    'cinnamon rolls',
    'lemon bars',
    'scones',
  ],
  drinks: ['cold brew', 'chai', 'lemonade', 'hot chocolate'],
};
const INGREDIENTS = [
  '2 cloves garlic',
  '1 onion',
  '1 tbsp olive oil',
  '1 can tomatoes',
  '2 cups rice',
  '1 tsp cumin',
  'salt',
  'pepper',
  '1 lemon',
  'handful of spinach',
  '2 eggs',
  '1 cup milk',
  '1/2 cup butter',
  'fresh basil',
  '1 tbsp soy sauce',
  '400g chicken thighs',
  '1 can coconut milk',
  '2 carrots',
  '1 cup flour',
  '1 tsp paprika',
];
const STEPS = [
  'Chop everything first.',
  'Heat the oil over medium.',
  'Simmer for 20 minutes.',
  'Season to taste.',
  'Bake until golden.',
  'Let it rest for 10 minutes.',
  'Stir in the herbs at the end.',
  'Serve with rice.',
];
const BOOKS = [
  'piranesi',
  'project hail mary',
  'station eleven',
  'the left hand of darkness',
  'dune',
  'the dispossessed',
  'klara and the sun',
  'a psalm for the wild-built',
  'the overstory',
  'educated',
  'thinking fast and slow',
  'atomic habits',
  'the pragmatic programmer',
  'designing data-intensive applications',
  'sapiens',
  'the martian',
  'circe',
  'normal people',
  'the remains of the day',
  'never let me go',
  'gideon the ninth',
  'the three-body problem',
  'recursion',
  'anathem',
];
const ARTICLES = [
  'how to write a good design doc',
  'the case for boring technology',
  'sleep and memory',
  'why sourdough works',
  'the sqlite file format',
  'on writing well summary',
  'local-first software',
  'crdts explained',
  'the tyranny of metrics',
  'how to run a retro',
  'deliberate practice',
  'the zettelkasten method',
  'cold showers are overrated',
  'intro to rust ownership',
  'what is a vector database',
  'the cost of interruptions',
  'managing up',
  'the one-page resume',
];
const SNIPPETS = [
  'git commands',
  'ssh config',
  'bash one-liners',
  'docker cleanup',
  'ffmpeg recipes',
  'jq cheatsheet',
  'postgres tips',
  'vim motions',
  'tmux keys',
  'regex notes',
  'curl examples',
  'rsync backup',
  'python venv',
  'systemd units',
  'nginx snippets',
  'make cheatsheet',
];
const IDEAS = [
  'budgeting app',
  'board game night',
  'newsletter about homelabs',
  'plant watering sensor',
  'recipe scaler',
  'habit tracker',
  'neighbourhood tool library',
  'podcast about old software',
  'photo book of the japan trip',
  'kids coding club',
  'better standup format',
  'bike route planner',
  'learn to bake bread',
  'garden layout',
  'blog post about moving',
  'running a half marathon',
  'weekly review ritual',
  'digital declutter',
  'write a short story',
  'build a bookshelf',
];
const WORDS = (
  'the a to of and for with on at from about this that it is was be will should could maybe really ' +
  'think need want try check look plan write read fix call send buy move make start finish review update ' +
  'week month tomorrow later today morning evening notes list idea thing stuff work home trip book code team'
).split(' ');

export function generate() {
  const random = mulberry32(SEED);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const between = (low, high) => low + Math.floor(random() * (high - low + 1));
  const sentence = () => {
    const words = Array.from({ length: between(5, 14) }, () => pick(WORDS));
    return `${words[0][0].toUpperCase()}${words.join(' ').slice(1)}.`;
  };
  const notes = new Map();
  const add = (id, body) => {
    if (!(id in FIXED) && !notes.has(id)) notes.set(id, body);
  };

  // Journal: most days from 2025-10-01 to 2026-09-23 (the 24th is FIXED, the latest).
  const day = new Date(Date.UTC(2025, 9, 1));
  while (day < Date.UTC(2026, 8, 24)) {
    const id = day.toISOString().slice(0, 10);
    if (random() < 0.47) {
      const lines = Array.from({ length: between(1, random() < 0.15 ? 18 : 5) }, () =>
        random() < 0.8 ? pick(JOURNAL_LINES) : sentence(),
      );
      if (random() < 0.12)
        lines.push(
          `Linked: [[${pick(['grocery list', 'reading list', 'fluffy pancakes', 'bike repair log', 'workout plan'])}]]`,
        );
      add(`journal/${id.slice(0, 4)}/${id}`, `${lines.join('\n')}\n`);
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }

  // Standups and other meetings, mostly work days in the last months.
  const meetingDay = new Date(Date.UTC(2026, 4, 4));
  while (meetingDay < Date.UTC(2026, 8, 24)) {
    const id = meetingDay.toISOString().slice(0, 10);
    const weekday = meetingDay.getUTCDay();
    if (weekday >= 1 && weekday <= 5 && random() < 0.45) {
      add(
        `work/meetings/${id} standup`,
        `# Standup ${id}\n\n${pick(MEETING_LINES.slice(0, 4))}\n${pick(MEETING_LINES.slice(4, 8))}\n${pick(MEETING_LINES.slice(8))}\n`,
      );
    }
    if (weekday === 4 && random() < 0.5)
      add(
        `work/meetings/${id} all hands`,
        `# All hands ${id}\n\n${Array.from({ length: between(2, 9) }, () => `- ${sentence()}`).join('\n')}\n`,
      );
    meetingDay.setUTCDate(meetingDay.getUTCDate() + 1);
  }
  for (const person of ['priya', 'marcus', 'jordan']) {
    for (let n = 1; n <= 4; n++)
      add(
        `work/1on1s/${person} ${n}`,
        `# 1:1 with ${person}\n\n${Array.from({ length: between(2, 8) }, () => `- ${sentence()}`).join('\n')}\n`,
      );
  }
  for (const title of [
    'okrs 2026',
    'performance review self',
    'team contacts',
    'work todo',
    'oncall runbook',
    'expense report',
    'promo packet draft',
  ])
    add(
      `work/${title}`,
      `# ${title}\n\n${Array.from({ length: between(1, 30) }, () => (random() < 0.3 ? `- [ ] ${sentence()}` : sentence())).join('\n')}\n`,
    );
  for (const title of ['backend engineer rubric', 'interview questions', 'candidate pipeline'])
    add(
      `work/hiring/${title}`,
      Array.from({ length: between(3, 15) }, () => `- ${sentence()}`).join('\n') + '\n',
    );
  for (const [project, titles] of Object.entries({
    beacon: ['notes', 'on-call'],
    comet: ['design review', 'user research'],
    drift: ['overview', 'kickoff', 'roadmap'],
  }))
    for (const title of titles)
      add(
        `work/projects/${project}/${title}`,
        `# ${project} ${title}\n\n${Array.from({ length: between(2, 12) }, sentence).join('\n')}\n`,
      );

  // Recipes.
  for (const [course, names] of Object.entries(RECIPES)) {
    for (const name of names) {
      const ingredients = Array.from({ length: between(3, 9) }, () => `- ${pick(INGREDIENTS)}`);
      const steps = Array.from(
        { length: between(2, 6) },
        (_, index) => `${index + 1}. ${pick(STEPS)}`,
      );
      add(
        `recipes/${course}/${name}`,
        `# ${name}\n\n## Ingredients\n${[...new Set(ingredients)].join('\n')}\n\n## Steps\n${steps.join('\n')}\n`,
      );
    }
  }
  add(
    'recipes/recipes to try',
    `- [ ] ${RECIPES.dinner.slice(0, 5).join('\n- [ ] ')}\n- [ ] dutch baby (like a giant pancake)\n`,
  );

  // Reading, learning, tech, ideas, inbox, travel.
  for (const book of BOOKS)
    add(
      `reading/books/${book}`,
      `${Array.from({ length: between(1, 12) }, () => (random() < 0.3 ? `> ${sentence()}` : sentence())).join('\n')}\n`,
    );
  for (const article of ARTICLES)
    add(
      `reading/articles/${article}`,
      `${Array.from({ length: between(1, 6) }, sentence).join('\n')}\n`,
    );
  add('reading/quotes', Array.from({ length: 14 }, () => `> ${sentence()}`).join('\n\n') + '\n');
  for (let n = 1; n <= 16; n++)
    add(
      `learning/spanish/lesson ${n}`,
      `# Lección ${n}\n\n${Array.from({ length: between(3, 10) }, () => `- ${pick(['hola', 'gracias', 'la cuenta', 'dónde está', 'me gustaría', 'el tren', 'mañana', 'la cocina'])} = ${pick(WORDS)}`).join('\n')}\n`,
    );
  for (const song of [
    'wonderwall',
    'blackbird',
    'hallelujah',
    'wish you were here',
    'fast car',
    'chord shapes',
    'strumming patterns',
    'practice log',
  ])
    add(
      `learning/guitar/${song}`,
      `${Array.from({ length: between(2, 10) }, sentence).join('\n')}\n`,
    );
  for (const snippet of SNIPPETS)
    add(
      `tech/snippets/${snippet}`,
      `# ${snippet}\n\n\`\`\`\n${Array.from({ length: between(2, 10) }, () => `${pick(['git', 'ssh', 'docker', 'ls', 'grep', 'curl'])} ${pick(WORDS)} ${pick(WORDS)}`).join('\n')}\n\`\`\`\n`,
    );
  for (const title of ['nas setup', 'pi-hole', 'backup plan', 'ups battery'])
    add(
      `tech/homelab/${title}`,
      `# ${title}\n\n${Array.from({ length: between(3, 20) }, sentence).join('\n')}\n`,
    );
  for (const title of ['headphones', 'kindle', 'old phones to sell', 'smart watch'])
    add(`tech/devices/${title}`, `${Array.from({ length: between(1, 6) }, sentence).join('\n')}\n`);
  add('tech/tech todo', `- [ ] renew domain\n- [ ] update the NAS\n- [ ] back up the phone\n`);
  for (const idea of IDEAS)
    add(`ideas/${idea}`, `${Array.from({ length: between(1, 8) }, sentence).join('\n')}\n`);
  for (const title of [
    'call back',
    'random thoughts',
    'links to read',
    'screenshot notes',
    'meeting follow-ups',
    'voice memo transcript',
  ])
    add(`inbox/${title}`, `${Array.from({ length: between(1, 5) }, sentence).join('\n')}\n`);
  for (const title of ['travel checklist', 'passport renewal', 'points and miles'])
    add(
      `travel/${title}`,
      `${Array.from({ length: between(2, 8) }, () => `- ${sentence()}`).join('\n')}\n`,
    );
  for (const title of ['phrases', 'budget'])
    add(
      `travel/japan 2025/${title}`,
      `${Array.from({ length: between(2, 8) }, sentence).join('\n')}\n`,
    );
  for (const title of ['workout plan', 'doctor visits', 'meal prep', 'sleep log'])
    add(
      `personal/health/${title}`,
      `${Array.from({ length: between(2, 25) }, sentence).join('\n')}\n`,
    );
  for (const title of ['budget 2026', 'subscriptions', 'savings goals'])
    add(
      `personal/finance/${title}`,
      `${Array.from({ length: between(2, 10) }, () => `- ${sentence()}`).join('\n')}\n`,
    );
  for (const title of ['furniture ideas', 'plants', 'utility accounts'])
    add(
      `personal/home/${title}`,
      `${Array.from({ length: between(2, 10) }, sentence).join('\n')}\n`,
    );
  add('personal/car maintenance', `- oil change every 5k miles\n- tires rotated 2026-03\n`);
  for (const title of ['todo', 'scratch', 'quick notes', 'welcome'])
    add(title, `${Array.from({ length: between(1, 6) }, sentence).join('\n')}\n`);

  // A few long ones: a runbook, a log, a brain dump.
  const long = (lines) =>
    `${Array.from({ length: lines }, () => (random() < 0.2 ? `## ${pick(WORDS)} ${pick(WORDS)}` : random() < 0.3 ? `- ${sentence()}` : sentence())).join('\n')}\n`;
  notes.set('work/oncall runbook', `# Oncall runbook\n\n${long(160)}`);
  notes.set('personal/health/sleep log', long(120));
  notes.set('tech/homelab/nas setup', `# NAS setup\n\n${long(85)}`);
  notes.set('inbox/voice memo transcript', long(60));

  for (const [id, body] of Object.entries(FIXED)) notes.set(id, body);
  rmSync(vaultDir, { recursive: true, force: true });
  for (const [id, body] of [...notes].sort()) {
    mkdirSync(dirname(join(vaultDir, id)), { recursive: true });
    writeFileSync(join(vaultDir, `${id}.md`), body);
  }
  return [...notes.keys()].sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ids = generate();
  const folders = new Set(
    ids.flatMap((id) =>
      id
        .split('/')
        .slice(0, -1)
        .map((_, index, parts) => parts.slice(0, index + 1).join('/')),
    ),
  );
  const byTop = {};
  for (const id of ids)
    byTop[id.includes('/') ? id.split('/')[0] : '(root)'] =
      (byTop[id.includes('/') ? id.split('/')[0] : '(root)'] ?? 0) + 1;
  console.log(JSON.stringify({ notes: ids.length, folders: folders.size, byTop }, null, 2));
}
