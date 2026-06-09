# Working on these specs

Conventions live in [README.md](README.md); the gap workflow (`just
spec-gaps` / `spec-gaps-check`) is described there and in the root
AGENTS.md. This file is for verification discipline.

## Before recording a Gap, check the hidden affordances

A feature is not missing just because no button is visible. We once recorded
"desktop has no folder-delete UI" as a Gap while it had been shipping the
whole time — behind right-click (DrawerSidebar's folder context menu, found
2026-06-09 only when a re-verification was explicitly requested).

Before writing `> **Gap:** X has no UI for …`, exhaust the places UIs hide:

- **Right-click / long-press context menus** — on every row type (note,
  folder, tag, tab), not just the first one you try. Desktop and mobile
  often gate the same action behind different gestures.
- **Swipe actions** on list rows (iOS especially; check the accessibility
  tree's `custom_actions` — they list actions with no visible affordance).
- **Overflow (⋮ / …) menus**, including ones that only appear when a note is
  open or a selection exists.
- **Keyboard shortcuts** with no menu equivalent (see tabs.md).
- **Drag and drop** (move/reorder often has no menu item at all).
- **Empty-state and hover-only controls** (buttons that render only when a
  list is empty, or on row hover on desktop).

Verify in the code, not just the UI: grep for the store/core method
(`deleteFolder`, `moveNote`, …) and check whether any component calls it.
"Exists in core but no caller" is a real gap; "no caller I noticed while
clicking around" is not evidence.

When you do record a gap, make it cheap to catch its closure: word it so a
probe can match it, and add the probe to `scripts/spec-gaps.mjs`.
