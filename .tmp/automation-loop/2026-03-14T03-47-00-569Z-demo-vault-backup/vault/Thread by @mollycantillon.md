#reference

---
title: "Thread by @mollycantillon"
source: "https://x.com/mollycantillon/status/2008918474006122936"
author:
  - "[[@mollycantillon]]"
published: 2026-01-07
created: 2026-01-09
description:
tags:
  - "clippings"
---
**Molly Cantillon** @mollycantillon [2026-01-07](https://x.com/mollycantillon/status/2008918474006122936)

THE PERSONAL PANOPTICON.

A few months ago, I started running my life out of Claude Code. Not out of intention to do so, it was just the place where everything met.

And it just kept working.

Empires are won by conquest. What keeps them standing is something much quieter.

Before a king can tax, he must count. Before he can conscript, he must locate. Before he can rule, he must see. Legibility is the precondition for governance.

The pre-modern state was blind. It knew precious little about its subjects, their wealth, their landholdings and yields, their location, their very identity. So it built the apparatus of sight: censuses, surnames, maps. Over centuries, the invisible became visible, the illegible became legible, and populations that could be seen could finally be controlled.

Now, you are one of n: tracked, monitored, studied by systems you cannot access, much less interrogate. Data is siphoned for purposes you will never fully know. The arrangement is brutally asymmetrical: visibility without reciprocity. A panopticon whose gaze travels outward and never back.

The watchtower has multiplied. Today, corporations harvest terabytes of behavioral exhaust, gatekept behind competitive moats, legible only to algorithms optimizing against your interests. Corporate legibility is created by closed joins: they can join your behavior to their ontology, but you can’t join your own behavior across systems.

We are drowning in data about ourselves and yet we remain catastrophically blind.

Thousands of messages across twenty inboxes. Notifications exile you to a perpetual state of Do Not Disturb. A WHOOP recovery score that decides your mood. Commitments that exist in six places and cohere in none. You are the most measured human in history and the most opaque to yourself.

States built legibility infrastructure to govern. Corporations built it to sell. Neither gave you the keys to the tower.

The first thing Claude solved was product blindness. NOX now runs on a cron job: pulling Amplitude, cross-referencing GitHub, and pointing me to what needs building. It handles A/B testing, generates winning copy, and has turned customer support into a fully autonomous department.

Once I saw this was possible, I chased it everywhere. Email, hitting inbox zero for the first time ever, with auto-drafted replies for everything inbound. Workouts, accommodating horrendously erratic travel schedules. Sleep, built a projector wired to my WHOOP after exactly six hours that wakes me with my favorite phrases. Subscriptions, found and returned $2000 I didn’t know I was paying. The dozen SFMTA citations I'd ignored, the action items I'd procrastinated into oblivion. People are using it to, I discovered, run vending machines, home automation systems, and keep plants alive.

The feeling is hard to name. It is the violent gap between how blind you were and how obvious everything feels now with an observer that reads all the feeds, catches what you've unconsciously dropped, notices patterns across domains you'd kept stubbornly separate, and—crucially—tells you what to do about it.

My personal finances are now managed in the terminal. Overnight it picks the locks of brokerages that refuse to talk to each other, pulls congressional and hedge fund disclosures, Polymarket odds, X sentiment, headlines and 10-Ks from my watchlist. Every morning, a brief gets added in ~/𝚝𝚛𝚊𝚍𝚎𝚜. Last month it flagged Rep. Fields buying NFLX shares. Three weeks later, the Warner Bros deal. I don't always trade, sometimes I argue with the thesis. But I'm never tracking fifteen tabs at 6am anymore.

It feels borderline unfair seeing around corners, being in ten places at once, surveilling yourself with the attention span of a thousand clones.

A panopticon still, but the tower belongs to you.

A few weeks ago, five friends and I tore into the Epstein files the night they dropped. Thousands of documents parsed into a searchable index: flights, texts, photos, Amazon purchases, properties. By 4am, sleep deprivation bled into something stranger: the disbelief that it just kept working. We were outpacing entire newsrooms. By 7am we shipped Jmail. 18 million people have since searched an inbox that belonged to a dead man. A decade ago this would have taken a team and a quarter of runway. We did it in one night, on pure adrenaline and tools that finally match the pace of ambition.

Over Christmas, I watched my parents learn the command line. These are people who never migrated off Microsoft Teams, who treat software updates as personal attacks. I didn't pitch it as coding. I set up an alias, just \`𝚌\`, and said:  'Type what you want to happen in plain English.' My mom stared at it for a minute, then typed: 'Show me everyone who hasn't paid an invoice in the last 90 days.' She looked at me like I'd performed a magic trick. Within days, they were running my dad’s accounts receivable through it. For twenty years, software made them feel stupid. Now they tell it what to do.

When you have an entire model of reality around certain things being hard that shifts for the first time, the world unravels.

This is the default now. The bottleneck is no longer ability. The bottleneck is activation energy: who has the nerve to try, and the stubbornness to finish. This favors new entrants. People who question unquestioned assumptions because they don't know any better. The founders who sprint through walls and will their dogged pursuits into existence.

Here’s what my tower looks like mechanically. I run a swarm of eight instances in parallel: ~/𝚗𝚘𝚡, ~/𝚖𝚎𝚝𝚛𝚒𝚌𝚜, ~/𝚎𝚖𝚊𝚒𝚕, ~/𝚐𝚛𝚘𝚠𝚝𝚑, ~/𝚝𝚛𝚊𝚍𝚎𝚜, ~/𝚑𝚎𝚊𝚕𝚝𝚑, ~/𝚠𝚛𝚒𝚝𝚒𝚗𝚐, ~/𝚙𝚎𝚛𝚜𝚘𝚗𝚊𝚕. Each operates in isolation, spawns short-lived subagents, and exchanges context through explicit handoffs. They read and write the filesystem. When an API is absent, they operate the desktop directly, injecting mouse and keystroke events to traverse apps and browsers. 𝚌𝚊𝚏𝚏𝚎𝚒𝚗𝚊𝚝𝚎 -𝚒 keeps the system awake on runs, in airports, while I sleep. On completion, it texts me; I reply to the checkpoint and continue. All thought traces logged and artifacted for recursive self-improvement.

Sometimes the tower has a landlord. Anthropic sees every query you make. The value exchange is explicit: their visibility into your thinking for access to a thousand-clone attention span. In this case, chosen beats imposed. For now, that's enough.

There is a case for productive illegibility. For forgetting, for serendipity, for negative capability—the dark fiber in ourselves that loses something the moment you start measuring its throughput. Goodhart says optimize for a metric and you game your way to hollow victory. High modernism tried to iron the world into a grid, and killed what made it work. These failures share a structure. The map-maker doesn't live in the territory. When WHOOP says recovered and I feel like death, I notice. When the ~/𝚝𝚛𝚊𝚍𝚎𝚜 thesis is wrong, I lose money. Metis, the local knowledge that external schemes delete, is what built the grid here. There's a meta-level outside the system, self-authored and continuously revised, that argues with the brief for days, notices when a metric has become a game, that can delete ~/𝚑𝚎𝚊𝚕𝚝𝚑 tomorrow if it stops serving. Goodhart operates when you can't escape the loop. We must continue to live outside it.

I felt that tension most clearly watching Pluribus, where eight billion minds are joined into one consciousness. Only thirteen remain outside including Carol, the resistant misanthropic protagonist you want to root for, even if the hive offers peace, equity, and the end to all crime. An LLM already feels like that: a lossy compression of humanity speaking in one voice. When your whole life runs inside a Claude Code directory, you feel the pull toward the merge. The price is quiet but total. You trade away what is yours alone, the private texture of emotion, the right to be wrong, your jagged iconoclasm. Opt out and you fall behind. Take the tower early. Do not let it take you.

We are early on a big open secret. Karpathy put it correctly, failing to claim the boost now feels decidedly like a skill issue.

For centuries, legibility flowed one direction: upward. You were the subject. Institutions were the seer. In this quasi-libertarian arbitrage window, that direction has reversed. The tools of synthesis belong to the individual now.

Govern yourself accordingly.
