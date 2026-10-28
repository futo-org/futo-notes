// Held-out goals that change nothing on disk: they are checked on what the app shows.
import { active, all, J, only, P, tabsAre } from './vault-checks.mjs';

export const navigationTasks = [
  {
    id: 'japan-tabs',
    families: ['open', 'tabs'],
    names: 'indirect',
    desktopOnly: true,
    prompt:
      'Pull up my Japan packing list and the Japan itinerary in two tabs, and leave the itinerary showing.',
    verify: (o) =>
      all(
        only(o, {}),
        tabsAre(o.state, [`${J}/packing list`, `${J}/itinerary`]),
        active(o.state, `${J}/itinerary`),
      ),
    reference: [
      ['OpenNote', { noteId: `${J}/packing list` }],
      ['OpenNote', { noteId: `${J}/itinerary`, mode: 'foreground' }],
    ],
  },
  {
    id: 'router-find',
    families: ['open', 'find'],
    names: 'indirect',
    prompt: 'Open my router notes and use find to jump to the guest network part.',
    verify: (o) => {
      const find = o.state.editor?.find ?? {};
      return all(
        only(o, {}),
        active(o.state, 'tech/homelab/router setup'),
        find.open && /guest/i.test(find.query ?? '') && find.total >= 1
          ? null
          : `find is ${JSON.stringify(find)}`,
      );
    },
    reference: [
      ['OpenNote', { noteId: 'tech/homelab/router setup' }],
      ['OpenFind'],
      ['SetFindQuery', { query: 'guest network' }],
    ],
  },
  {
    id: 'landlord-search',
    families: ['search', 'open'],
    names: 'indirect',
    prompt: "Which note has my landlord's phone number in it? Open it.",
    verify: (o) => all(only(o, {}), active(o.state, 'personal/home/lease notes')),
    reference: [
      ['OpenSearch'],
      ['SetSearchQuery', { query: 'whitfield' }],
      ['OpenSearchResult', { index: 0 }],
    ],
  },
  {
    id: 'atlas-tabs',
    families: ['open', 'tabs'],
    names: 'loose',
    desktopOnly: true,
    prompt:
      "Open Atlas's kickoff, roadmap and retro notes in tabs, then close the roadmap one and leave the retro in front.",
    verify: (o) =>
      all(
        only(o, {}),
        tabsAre(o.state, [`${P}/atlas/kickoff`, `${P}/atlas/retro`]),
        active(o.state, `${P}/atlas/retro`),
      ),
    reference: [
      ['OpenNote', { noteId: `${P}/atlas/kickoff` }],
      ['OpenNote', { noteId: `${P}/atlas/roadmap`, mode: 'foreground' }],
      ['OpenNote', { noteId: `${P}/atlas/retro`, mode: 'foreground' }],
      ['CloseTabAt', { noteId: `${P}/atlas/roadmap` }],
    ],
  },
];
