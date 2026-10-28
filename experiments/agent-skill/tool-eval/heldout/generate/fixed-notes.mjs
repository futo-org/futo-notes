// ── The notes goals are about, and their near neighbours. Exact bytes matter here. ──
export const FIXED = {
  // shopping: three "grocery" titles, eggs in all of them
  'personal/shopping/grocery list': `- [ ] eggs
- [ ] oat milk
- [ ] spinach
- [x] coffee beans
- [ ] pancake mix
- [ ] dish soap
- [ ] bananas
`,
  'personal/shopping/groceries 2025': `# Groceries 2025

What I actually bought most weeks last year, for the budget.

- eggs (every week)
- oat milk
- rice, 5kg bag monthly
- coffee beans
- frozen berries

Average was about $96 a week. See [[grocery budget]].
`,
  'personal/finance/grocery budget': `# Grocery budget

Monthly target: $400
Last month: $438

- cut down on takeout lunches
- buy coffee beans in bulk
- check [[grocery list]] before going out
`,
  'personal/shopping/wishlist': `# Wishlist

- new phone case (wait for the iPhone 18?)
- rain jacket
- cast iron pan
- noise cancelling headphones
`,
  'personal/shopping/costco run': `- [ ] paper towels
- [ ] olive oil
- [ ] eggs (5 dozen)
- [ ] coffee beans
`,

  // tech: one note about the phone, others that mention phones
  'tech/devices/iPhone 18': `# iPhone 18

Rumoured for September. Thinking about upgrading from the 14.

Expected price: $999
- under-display Face ID?
- better battery, supposedly
- keep the old one as a backup

Trade-in value for the 14 is around $250.
`,
  'tech/devices/phone plan comparison': `# Phone plan comparison

| carrier | price | data |
|---|---|---|
| Mint | $15 | 5GB |
| Visible | $25 | unlimited |
| current | $55 | 15GB |

Switching saves about $30 a month. The phone itself is fine for now.
`,
  'tech/devices/laptop comparison': `# Laptop comparison

- framework 13: repairable, battery meh
- macbook air: battery great, no linux
- thinkpad x1: keyboard is the best

Leaning framework.
`,
  'tech/homelab/router setup': `# Router setup

Model: Archer AX55

## Main network
- SSID: moth-5g
- WPA3 only
- DHCP range 192.168.1.100-200

## Guest network
- SSID: moth-guest
- isolated from LAN
- bandwidth cap 50 Mbps

## Firmware
Updated 2026-06-02. Check again in the fall.
`,

  // home
  'personal/home/apartment move checklist': `# Apartment move checklist

- [x] give notice to landlord
- [x] book movers for the 14th
- [ ] forward mail
-[ ] call the plumber about the leak
- [ ] cancel old internet
- [ ] return the parking fob
`,
  'personal/home/lease notes': `# Lease notes

Lease ends July 31. Rent is $1,850.
Landlord: Dana Whitfield, 555-0147
Deposit: $1,850, due back within 30 days of move-out.

Pets allowed with a $300 deposit.
`,
  'personal/home/saturday chores': `# Saturday chores

- [ ] vacuum
- [ ] laundry
- [x] water plants
- [ ] take out recycling
`,
  'personal/home/sunday chores': `# Sunday chores

- [ ] meal prep
- [ ] clean bathroom
- [ ] call mom
`,

  // finance: two tax folders
  'personal/finance/tax 2024/w2 and 1099s': `- [x] W-2 from work
- [x] 1099-INT from the bank
- [x] 1099-B brokerage
`,
  'personal/finance/tax 2024/deductions': `# Deductions 2024

- charity: $620
- home office: no
`,
  'personal/finance/tax 2024/filed': `Filed 2025-04-02 with FreeTaxUSA. Refund $412.
`,
  'personal/finance/tax 2025/documents': `- [ ] W-2
- [ ] 1099-INT
- [ ] HSA form
`,
  'personal/finance/tax 2025/questions for accountant': `- does the move count for anything?
- HSA contributions over the limit?
`,

  // inbox: two untitleds, one empty
  'inbox/untitled': ``,
  'inbox/untitled idea': `app that tells you when the farmers market has peaches
`,
  "inbox/ideas for mom's birthday": `- pottery class together
- the blue scarf from the market
- dinner at Lucia's
`,
  'personal/family/family contacts': `# Family contacts

- Mom: 555-0112
- Dad: 555-0190
- Aunt Rose: 555-0133
`,
  'personal/family/dad birthday 2025': `Got him the fly fishing book. He loved it.
`,

  // work: a folder with exactly two notes, an archive, projects with the same note names
  'work/offsite/offsite agenda': `# Offsite agenda

Day 1: roadmap review, team dinner
Day 2: hack day, retro
`,
  'work/offsite/offsite logistics': `# Offsite logistics

- venue: the Grange, 40 min north
- carpool sign-up in the team channel
- dietary list due Friday
`,
  'archive/old onboarding doc': `# Onboarding (2024)

Superseded by the wiki.
`,
  'archive/2024 goals': `- ship atlas v1
- learn rust
`,
  'work/projects/atlas/overview': `# Atlas

Internal search for the support team. Owner: me. See [[work/projects/atlas/roadmap]].
`,
  'work/projects/atlas/kickoff': `# Atlas kickoff

- scope: support tickets only
- first milestone end of Q3
`,
  'work/projects/atlas/roadmap': `# Atlas roadmap

- Q3: indexing, basic ranking
- Q4: launch date is November 12, rollout to all support staff
- Q1: feedback loop
`,
  'work/projects/atlas/retro': `# Atlas retro

- went well: small PRs
- went badly: the indexer rewrite
`,
  'work/projects/atlas/risks': `- indexer memory on big tenants
- support team adoption
`,
  'work/projects/beacon/overview': `# Beacon

Status page for the public API. Kicked off in August.

Notes:
- [[work/projects/beacon/kickoff]]
- [[work/projects/beacon/roadmap]]
`,
  'work/projects/beacon/kickoff': `# Beacon kickoff

- who owns on-call? still open
`,
  'work/projects/beacon/roadmap': `# Beacon roadmap

- v0: static page
- v1: live checks
`,
  'work/projects/comet/overview': `# Comet

Mobile onboarding redesign. Paused until Q1.
`,
  'work/projects/comet/roadmap': `- research
- prototype
- test with 5 users
`,
  'work/projects/comet/retro': `# Comet retro

We stopped too early.
`,
  'work/meetings/2026-09-22 standup': `# Standup 2026-09-22

Yesterday: atlas ranking tweaks
Today: beacon checks
Blockers: none
`,
  'work/meetings/2026-09-24 standup': `# Standup 2026-09-24

Yesterday: beacon checks
Today: offsite prep
Blockers: none
`,

  // recipes: one pancake recipe; other notes mention pancakes
  'recipes/breakfast/fluffy pancakes': `# Fluffy pancakes

Serves 3.

## Ingredients
- 1 1/2 cups flour
- 3 1/2 tsp baking powder
- 1 tbsp sugar
- 1 1/4 cups milk
- 1 egg
- 3 tbsp melted butter

## Steps
1. Whisk the dry ingredients.
2. Add milk, egg and butter; stir until just combined.
3. Cook on a medium pan, flip when bubbles form.
`,
  'recipes/breakfast/waffles': `# Waffles

Same batter as the pancakes but with an extra egg and more butter.

- 2 cups flour
- 2 eggs
- 1/2 cup butter
`,
  'recipes/baking/banana bread': `# Banana bread

## Ingredients
- 3 ripe bananas
- 1/3 cup melted butter
- 3/4 cup sugar
- 1 egg
- 1 1/2 cups flour
- 1 tsp baking soda

Bake 60 min at 350F.
`,
  'recipes/baking/sourdough starter': `# Sourdough starter

Feed 1:1:1 every 12 hours. Name: Doughbi.
`,

  // travel: two packing lists and a camping one
  'travel/japan 2025/itinerary': `# Japan itinerary

- Day 1-4: Tokyo (Shinjuku hotel)
- Day 5-7: Kyoto
- Day 8: Nara day trip
- Day 9-10: Osaka
`,
  'travel/japan 2025/packing list': `- [ ] passport
- [ ] JR pass voucher
- [ ] power adapter
- [ ] comfy shoes
`,
  'travel/japan 2025/restaurants': `- Fuunji (tsukemen)
- Ichiran
- Nishiki market
`,
  'travel/lisbon/lisbon itinerary': `# Lisbon itinerary

Flights: TP 208, Oct 10.
Hotel: Casa do Largo, Rua das Flores 12, 1200-195 Lisboa

- Belém on day 2
- Sintra day trip
- fado night in Alfama
`,
  'travel/lisbon/lisbon packing list': `- [ ] passport
- [ ] light jacket
- [ ] walking shoes
- [ ] euro cash
`,
  'travel/packing list - camping': `- [ ] tent
- [ ] headlamp
- [ ] stove + fuel
`,
  'travel/past trips/iceland 2023': `Ring road in 9 days. Too much driving.
`,
  'travel/past trips/portland 2024': `Powell's, Voodoo doughnuts, rain.
`,

  // reading
  'reading/reading list': `# Reading list

Currently reading
- Piranesi
- The Name of the Wind
- Project Hail Mary

Up next
- The Left Hand of Darkness
- Station Eleven
`,
  'reading/books/the name of the wind': `Started in August. Slow first 100 pages.
`,

  // journal: the latest entry, and the one with the typo
  'journal/2026/2026-09-24': `Long day. Offsite prep took all afternoon.
Went for a run after work, legs were dead.
`,
  'journal/2026/2026-08-03': `Sunday. Made pancakes with the new recipe.
I recieved the package from Aunt Rose, a whole box of books.
Walked to the lake in the evening.
`,
  'journal/template': `## Mood

## What happened

## Grateful for
`,
  'personal/bike repair log': `- 2026-05-10: new chain
- 2026-07-02: back tire flat, patched
- 2026-09-20: shifting is off again, need to fix
`,
};
