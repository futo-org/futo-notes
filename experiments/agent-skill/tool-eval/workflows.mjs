// Multi-step workflow tasks (anthropic.com/engineering/writing-tools-for-agents): several verbs in
// sequence, one verifiable end state. The oracle is the vault on disk plus `state` after the run,
// never the agent's prose. `holdout` tasks are scored but never shown to the optimiser.
//
// Each verifier gets { vault, read(id), exists(id), list(), state } and returns a string naming what
// is wrong, or null when the end state is right.
//
// `desktopOnly` marks a task about a surface the phones do not have at all: the tab strip, and the
// sidebar's context menu (a phone has no sidebar, and the task forbids the move verb its row menu
// IS). Such a task is not a harder version of the same job — it is a job that does not exist there. The runner skips those off desktop and says so, rather
// than scoring the driver against something no user could do.
const has = (text, part) =>
  text.includes(part) ? null : `missing ${JSON.stringify(part)} in ${JSON.stringify(text)}`;
const gone = (exists, id) => (exists(id) ? `${id} still exists` : null);
const present = (exists, id) => (exists(id) ? null : `${id} does not exist`);
const all = (...checks) => checks.find(Boolean) ?? null;

export const workflows = [
  {
    id: 'rename-and-extend',
    prompt:
      'Rename the note `grocery list` to `shopping`, then add the item `- butter` on its own line directly after the `- eggs` line. Make sure the recipe `recipes/pancakes` still links to the renamed note.',
    verify: ({ read, exists }) =>
      all(
        present(exists, 'shopping'),
        gone(exists, 'grocery list'),
        has(read('shopping'), '- eggs\n- butter\n- bread'),
        has(read('recipes/pancakes'), '[[shopping]]'),
      ),
  },
  {
    id: 'archive-plan',
    prompt:
      'Create a folder named `archive` at the vault root and move the note `work/q3 plan` into it.',
    verify: ({ exists }) => all(present(exists, 'archive/q3 plan'), gone(exists, 'work/q3 plan')),
  },
  {
    id: 'standup-rewrite',
    prompt:
      'In `work/standup`, change the `Today:` line to read exactly `Today: tool loop.` and change the `Blockers:` line to read exactly `Blockers: flaky reset.`',
    verify: ({ read }) =>
      all(
        has(
          read('work/standup'),
          'Yesterday: shipped verbs.\nToday: tool loop.\nBlockers: flaky reset.',
        ),
      ),
  },
  {
    // An agent's goal quotes a line as it reads now beside its one-character fix (tuning goal for
    // the no-op label and `no change` receipt, 2026-09-28).
    id: 'quoted-line-fix',
    prompt:
      'In `work/standup`, line 4 reads `Today: eval harness.` now; replace that line with `Today: Eval harness.`',
    verify: ({ read }) =>
      all(
        has(
          read('work/standup'),
          'Yesterday: shipped verbs.\nToday: Eval harness.\nBlockers: none.',
        ),
      ),
  },
  {
    id: 'tick-and-add',
    prompt:
      'In `grocery list`, mark the `coffee` task as done (`- [x] coffee`) and add an unchecked task `- [ ] tea` on the line after it.',
    verify: ({ read }) => has(read('grocery list'), '- [x] coffee\n- [ ] tea'),
  },
  {
    id: 'note-in-folder',
    prompt:
      'Create a new note titled `retro` inside the `work` folder whose content is exactly `# Retro` on the first line and `- went well: verbs` on the third line, with an empty second line.',
    verify: ({ read, exists }) =>
      all(present(exists, 'work/retro'), has(read('work/retro'), '# Retro\n\n- went well: verbs')),
  },
  {
    id: 'heading-line',
    prompt:
      'In `welcome`, turn the line `A pangram uses every letter.` into a heading with the toolbar verb (`# A pangram uses every letter.`). Leave every other line unchanged.',
    verify: ({ read }) =>
      all(
        has(
          read('welcome'),
          '# Welcome\n\nThe quick brown fox jumps over the lazy dog.\n# A pangram uses every letter.',
        ),
      ),
  },
  {
    id: 'bold-italic',
    prompt:
      'In `welcome`, make the word `quick` bold and the word `lazy` italic, using the toolbar verbs rather than typing asterisks.',
    verify: ({ read }) =>
      has(read('welcome'), 'The **quick** brown fox jumps over the *lazy* dog.'),
  },
  {
    id: 'clear-recipes',
    prompt:
      'Delete the note `recipes/pancakes` and then delete the now-empty `recipes` folder. Report how many folder rows remain in the sidebar.',
    expected: '1',
    verify: ({ exists, vault }) =>
      all(
        gone(exists, 'recipes/pancakes'),
        vault.folderExists('recipes') ? 'recipes folder still exists' : null,
      ),
  },
  {
    id: 'arrange-tabs',
    desktopOnly: true,
    prompt:
      'Open `welcome`, `work/standup` and `grocery list` as three separate tabs in that order, then close the `work/standup` tab and leave `grocery list` as the active tab.',
    verify: ({ state }) =>
      all(
        JSON.stringify(state.tabs) === JSON.stringify(['welcome', 'grocery list'])
          ? null
          : `tabs are ${JSON.stringify(state.tabs)}`,
        state.note?.id === 'grocery list' ? null : `active note is ${state.note?.id}`,
      ),
  },
  {
    id: 'append-link',
    prompt:
      'Append a new last line to `work/standup` reading exactly `See [[q3 plan]].` (after the `Blockers:` line).',
    verify: ({ read }) => has(read('work/standup'), 'Blockers: none.\nSee [[q3 plan]].'),
  },
  {
    id: 'rename-folder',
    prompt: 'Rename the folder `work` to `office`.',
    verify: ({ exists }) =>
      all(
        present(exists, 'office/standup'),
        present(exists, 'office/q3 plan'),
        gone(exists, 'work/standup'),
      ),
  },
  {
    id: 'undo-one',
    prompt:
      'In `grocery list`, replace `milk` with `oat milk`, then replace `eggs` with `tofu`, then undo only the second replacement.',
    verify: ({ read }) => has(read('grocery list'), '- oat milk\n- eggs\n- bread'),
  },
  {
    id: 'context-menu-move',
    desktopOnly: true,
    prompt:
      'Move the note `work/standup` into the `recipes` folder by opening its sidebar context menu, choosing the move item, and picking the folder in the picker that appears, not by calling a move verb directly.',
    verify: ({ exists }) => all(present(exists, 'recipes/standup'), gone(exists, 'work/standup')),
  },

  // ── held out: scored, never shown to the optimiser ──
  {
    id: 'weekly-review',
    holdout: true,
    prompt:
      'Create a folder `reviews` and inside it a note titled `week 38` whose content is exactly `# Week 38`, an empty line, then `- shipped: [[standup]]`.',
    verify: ({ read, exists }) =>
      all(
        present(exists, 'reviews/week 38'),
        has(read('reviews/week 38'), '# Week 38\n\n- shipped: [[standup]]'),
      ),
  },
  {
    id: 'merge-lists',
    holdout: true,
    prompt:
      'Append to the end of `recipes/pancakes` an empty line, a line `## Shopping`, and then every line of `grocery list` in order, unchanged.',
    verify: ({ read }) =>
      has(
        read('recipes/pancakes'),
        'See [[grocery list]].\n\n## Shopping\n- milk\n- eggs\n- bread\n- [ ] coffee',
      ),
  },
  {
    id: 'tidy-work',
    holdout: true,
    prompt:
      'Move both notes in the `work` folder to the vault root, rename the moved `standup` note to `daily`, then delete the empty `work` folder.',
    verify: ({ exists, vault }) =>
      all(
        present(exists, 'daily'),
        present(exists, 'q3 plan'),
        gone(exists, 'work/standup'),
        vault.folderExists('work') ? 'work folder still exists' : null,
      ),
  },
  {
    id: 'title-then-edit',
    holdout: true,
    prompt:
      'Open `grocery list`, change its title to `shopping` through the title field, then in the same note change `- bread` to `- rye bread`.',
    verify: ({ read, exists }) =>
      all(
        present(exists, 'shopping'),
        gone(exists, 'grocery list'),
        has(read('shopping'), '- eggs\n- rye bread\n- [ ] coffee'),
      ),
  },
  {
    id: 'background-tabs',
    holdout: true,
    desktopOnly: true,
    prompt:
      'Open `welcome` in the current tab, then open `work/q3 plan` and `recipes/pancakes` as background tabs (without switching to them), then switch to the second tab. Report the id of the note that is now active.',
    // Tests the driving (current vs background mode, order kept, activate by position), not where the
    // app places a background tab: the spec says "immediately after the active tab", so two background
    // opens land in reverse, and the second tab is whichever note the app put there.
    verify: ({ state }) =>
      all(
        state.tabs?.[0] === 'welcome' ? null : `first tab is ${JSON.stringify(state.tabs?.[0])}`,
        ['work/q3 plan', 'recipes/pancakes'].every((id) => state.tabs?.includes(id)) &&
          state.tabs?.length === 3
          ? null
          : `tabs are ${JSON.stringify(state.tabs)}`,
        state.note?.id === state.tabs?.[1]
          ? null
          : `active note is ${state.note?.id}, second tab is ${state.tabs?.[1]}`,
      ),
  },
  {
    id: 'strike-and-quote',
    holdout: true,
    prompt:
      'In `welcome`, strike through the word `dog` using the toolbar verb, and turn the line `A pangram uses every letter.` into a block quote using the toolbar verb.',
    verify: ({ read }) =>
      has(read('welcome'), 'over the lazy ~~dog~~.\n> A pangram uses every letter.'),
  },
];
