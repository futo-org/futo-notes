import { describe, expect, it } from 'vitest';

import { filterRows, formatSummaryLines, summarizeAccessibilityTree } from './describe-ios-ui.mjs';

// Field names, frames, and identifiers below are taken from real `axe
// describe-ui` output on an iPhone 17 Pro simulator (iOS 26.5, AXe 1.8.0).
// The device is 402x874pt, which is what makes the clipped toolbar items
// resolve outside the screen.

function noteListTree() {
  return [
    {
      type: 'Application',
      AXLabel: 'FUTO Notes Dev',
      AXUniqueId: null,
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        {
          type: 'Group',
          AXLabel: 'Settings',
          AXUniqueId: 'nav-settings',
          frame: { x: 20, y: 66, width: 41.33, height: 36 },
          children: [
            {
              type: 'Button',
              AXLabel: 'Settings',
              AXUniqueId: 'nav-settings',
              frame: { x: 20, y: 66, width: 41.33, height: 36 },
              children: [],
            },
          ],
        },
        {
          type: 'Button',
          AXLabel: 'Qa-note-1, 2 weeks ago, Body-token-88991 alpha bravo-77',
          AXUniqueId: null,
          frame: { x: 16, y: 255, width: 370, height: 76.33 },
          custom_actions: ['Delete', 'Move'],
          children: [
            {
              type: 'Image',
              AXLabel: null,
              AXUniqueId: 'chevron.forward',
              frame: { x: 360, y: 280, width: 8, height: 12 },
              custom_actions: ['Delete', 'Move'],
              children: [],
            },
          ],
        },
        // Unnamed layout container: the bulk of a real dump, and never useful.
        {
          type: 'Group',
          AXLabel: null,
          AXUniqueId: null,
          frame: { x: 0, y: 0, width: 402, height: 874 },
          children: [],
        },
      ],
    },
  ];
}

function editorToolbarTree() {
  return [
    {
      type: 'Application',
      AXLabel: 'FUTO Notes Dev',
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        {
          type: 'TextField',
          AXLabel: null,
          AXValue: 'Qa-note-1',
          frame: { x: 16, y: 120, width: 370, height: 44 },
          children: [],
        },
        {
          type: 'Button',
          AXLabel: 'Bold',
          AXUniqueId: 'bold',
          frame: { x: 8, y: 834, width: 44, height: 36 },
          children: [],
        },
        {
          type: 'Button',
          AXLabel: 'Task list',
          AXUniqueId: 'checklist',
          frame: { x: 398, y: 834, width: 44, height: 36 },
          children: [],
        },
        {
          type: 'Button',
          AXLabel: 'Choose from library',
          AXUniqueId: 'photo',
          frame: { x: 501, y: 834, width: 44, height: 36 },
          children: [],
        },
      ],
    },
  ];
}

describe('summarizeAccessibilityTree', () => {
  it('derives the screen bounds from the application root frame', () => {
    const { screenBounds } = summarizeAccessibilityTree(noteListTree());

    expect(screenBounds).toEqual({ width: 402, height: 874 });
  });

  it('drops unnamed layout containers and keeps nodes carrying identity', () => {
    const { rows } = summarizeAccessibilityTree(noteListTree());

    expect(rows.map((row) => row.id)).toEqual([
      null, // Application, kept for its label
      'nav-settings',
      'nav-settings',
      null, // the note row Button, kept for its label
      'chevron.forward',
    ]);
  });

  it('visits every node exactly once', () => {
    const { rows } = summarizeAccessibilityTree(noteListTree());
    const navSettingsRows = rows.filter((row) => row.id === 'nav-settings');

    // The Group and the Button are genuinely distinct nodes; neither repeats.
    expect(navSettingsRows.map((row) => row.type)).toEqual(['Group', 'Button']);
  });

  it('numbers the structural branches a row belongs to', () => {
    const { rows } = summarizeAccessibilityTree(noteListTree());

    expect(rows.find((row) => row.type === 'Application').branch).toBe(0);
    expect(rows.find((row) => row.id === 'nav-settings').branch).toBe(1);
    expect(rows.find((row) => row.label?.startsWith('Qa-note-1')).branch).toBe(2);
  });

  it('reports custom actions, which name affordances with no visible control', () => {
    const { rows } = summarizeAccessibilityTree(noteListTree());
    const noteRow = rows.find((row) => row.label?.startsWith('Qa-note-1'));

    expect(noteRow.customActions).toEqual(['Delete', 'Move']);
  });

  it('exposes a text field value, which is how the note title is readable', () => {
    const { rows } = summarizeAccessibilityTree(editorToolbarTree());

    expect(rows.find((row) => row.type === 'TextField').value).toBe('Qa-note-1');
  });

  it('truncates a multi-line label to its first line', () => {
    const [root] = noteListTree();
    root.children[1].AXLabel = 'Long Scroll Note\nParagraph 1: the quick brown fox';

    const { rows } = summarizeAccessibilityTree([root]);

    expect(rows.find((row) => row.label?.startsWith('Long Scroll'))?.label).toBe(
      'Long Scroll Note',
    );
  });
});

describe('off-screen detection', () => {
  it('marks elements whose activation point lies outside the screen', () => {
    const { rows } = summarizeAccessibilityTree(editorToolbarTree());
    const byId = Object.fromEntries(rows.filter((row) => row.id).map((row) => [row.id, row]));

    // bold's centre is 30pt; checklist 420pt and photo 523pt on a 402pt screen.
    expect(byId.bold.onScreen).toBe(true);
    expect(byId.checklist.onScreen).toBe(false);
    expect(byId.photo.onScreen).toBe(false);
  });

  it('warns in the rendered summary so a caller does not trust a tap', () => {
    const summary = summarizeAccessibilityTree(editorToolbarTree());
    const output = formatSummaryLines(summary).join('\n');

    expect(output).toContain('OFF-SCREEN');
    expect(output).toContain('reports success on those and does nothing');
  });

  it('treats a node without a frame as on-screen rather than failing', () => {
    const { rows } = summarizeAccessibilityTree([
      { type: 'Button', AXLabel: 'Frameless', children: [] },
    ]);

    expect(rows[0].onScreen).toBe(true);
  });
});

describe('filterRows', () => {
  it('selects by identifier', () => {
    const { rows } = summarizeAccessibilityTree(editorToolbarTree());

    expect(filterRows(rows, { id: 'bold' })).toHaveLength(1);
  });

  it('selects by element type, which is required when a Group shadows a Button', () => {
    const { rows } = summarizeAccessibilityTree(noteListTree());

    const matches = filterRows(rows, { id: 'nav-settings', type: 'Button' });
    expect(matches).toHaveLength(1);
    expect(matches[0].type).toBe('Button');
  });

  it('matches a label substring, since AXe itself only matches exact labels', () => {
    const { rows } = summarizeAccessibilityTree(noteListTree());

    expect(filterRows(rows, { labelContains: 'qa-note' })).toHaveLength(1);
  });

  it('lists custom actions once per identifiable owner, not per descendant', () => {
    const [root] = noteListTree();
    // A real dump repeats the row's actions on every unnamed child.
    root.children[1].children.push({
      type: 'Group',
      AXLabel: null,
      AXUniqueId: null,
      frame: { x: 16, y: 255, width: 370, height: 76 },
      custom_actions: ['Delete', 'Move'],
      children: [],
    });

    const { rows } = summarizeAccessibilityTree([root]);
    const actionRows = filterRows(rows, { actionsOnly: true });

    // The row Button owns the set; its chevron and the extra unnamed Group
    // only echo it, so neither is listed again.
    expect(actionRows.map((row) => row.label ?? row.id)).toEqual([
      'Qa-note-1, 2 weeks ago, Body-toke…',
    ]);
  });

  it('can exclude the untappable off-screen rows', () => {
    const { rows } = summarizeAccessibilityTree(editorToolbarTree());

    const tappable = filterRows(rows, { onScreenOnly: true, type: 'Button' });
    expect(tappable.map((row) => row.id)).toEqual(['bold']);
  });
});
