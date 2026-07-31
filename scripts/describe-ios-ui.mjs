#!/usr/bin/env node
// Summarize an iOS simulator accessibility tree captured by AXe (`axe
// describe-ui`) into something an agent can actually read, and mark the tap
// targets that would silently fail.
//
// Usage:
//   node scripts/describe-ios-ui.mjs                        # $SIM, whole screen
//   node scripts/describe-ios-ui.mjs --id nav-settings
//   node scripts/describe-ios-ui.mjs --label-contains "Qa-note" --type Button
//   node scripts/describe-ios-ui.mjs --actions-only          # hidden affordances
//   node scripts/describe-ios-ui.mjs --all                   # keep unlabelled nodes
//   node scripts/describe-ios-ui.mjs --file dump.json --json
//
// Three problems this exists to solve, all observed on iOS 26.5 / AXe 1.8.0:
//
//   1. Size. A raw dump is ~254KB on the note list and ~453KB with a sheet
//      open — tens of thousands of tokens, and most of it is unnamed layout
//      Groups. Only nodes carrying identity or a custom action are useful.
//   2. Off-screen taps. `axe tap` resolves an element's activation point and
//      reports success even when that point lies outside the screen, so the
//      tap does nothing. An unscrolled horizontal scroll view reports its
//      off-viewport children at content coordinates — the editor toolbar's
//      trailing items come back at x-centers of 420-523 on a 402pt-wide
//      device. Every row here is marked ON/OFF-SCREEN so a caller can refuse
//      the tap instead. OFF-SCREEN means "not tappable where it is", NOT
//      "unreachable by the user".
//   3. Order. AXe returns the whole window stack, and the covered screen comes
//      FIRST — reading the head or tail of a dump reports the wrong screen.
//      Each row carries its top-level branch index so callers can filter by
//      scope rather than by position.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const LABEL_WIDTH = 34;
const VALUE_WIDTH = 24;

// A row carries the FULL first line: `axe tap --label` is exact-match, callers
// read the label off this tool, and iOS row labels put the body preview past
// any sane column width. Truncation happens only where a line is rendered.
function firstLine(value) {
  if (value == null) return null;
  return String(value).split('\n')[0];
}

function truncate(text, width) {
  if (text == null) return null;
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function describeNode(node) {
  const name = node.AXLabel || node.AXUniqueId;
  return name
    ? `${node.type ?? '?'} "${truncate(firstLine(name), LABEL_WIDTH)}"`
    : (node.type ?? '?');
}

/**
 * Pick the root whose frame is the device's point size (402x874 on an iPhone 17
 * Pro). Deriving it beats a flag that can disagree with reality — but NOT by
 * taking the first framed root: axe returns the whole window stack and a small
 * window can come first (a keyboard window is ~402x314), which would report the
 * screen as 402x314 and mark every row below y=314 OFF-SCREEN. Prefer the
 * `Application` root, then the largest frame by area.
 */
function screenBoundsOf(tree) {
  const framed = tree.filter((node) => node?.frame?.width && node?.frame?.height);
  if (!framed.length) return { bounds: null, source: null };

  const application = framed.find((node) => node.type === 'Application');
  const root =
    application ??
    framed.reduce((largest, node) =>
      node.frame.width * node.frame.height > largest.frame.width * largest.frame.height
        ? node
        : largest,
    );

  return {
    bounds: { width: root.frame.width, height: root.frame.height },
    source: describeNode(root),
  };
}

function sameActions(actions, other) {
  return actions.length === other.length && actions.every((action, i) => action === other[i]);
}

function isOnScreen(frame, bounds) {
  if (!frame || !bounds) return true;
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  return centerX >= 0 && centerX <= bounds.width && centerY >= 0 && centerY <= bounds.height;
}

/**
 * Flatten the nested tree to the nodes worth looking at. A node earns a row
 * when it carries an identifier, a label, a value, or a custom action;
 * `options.includeAll` keeps the identity-less ones too. Discarded nodes are
 * COUNTED either way: "not in the summary" must not be ambiguous between
 * "absent from the tree" and "present but unlabelled" — unlabelled is exactly
 * how the nav controls looked to `idb`, and a regression back to that shape
 * would otherwise read as "missing" again.
 */
export function summarizeAccessibilityTree(tree, options = {}) {
  const roots = Array.isArray(tree) ? tree : [tree];
  const derived = screenBoundsOf(roots);
  const bounds = options.screenBounds ?? derived.bounds;
  const boundsSource = options.screenBounds ? 'caller-supplied' : derived.source;
  const rows = [];

  let nextActionOwnerId = 0;
  let droppedCount = 0;

  const pushRow = (node, depth, branch, actions, actionOwnerId) => {
    const identity = node.AXUniqueId || node.AXLabel || node.AXValue;
    if (!identity && !actions.length && !options.includeAll) {
      droppedCount += 1;
      return;
    }
    rows.push({
      branch,
      depth,
      type: node.type ?? null,
      id: node.AXUniqueId ?? null,
      label: firstLine(node.AXLabel),
      value: firstLine(node.AXValue),
      frame: node.frame ?? null,
      customActions: actions,
      actionOwnerId,
      onScreen: isOnScreen(node.frame, bounds),
    });
  };

  const visit = (node, depth, branch, parentActions, parentOwnerId) => {
    if (!node) return;
    const actions = node.custom_actions ?? [];
    // A node that carries an action set its parent did not starts a new owning
    // subtree — that is how two adjacent note rows with identical
    // ['Delete', 'Move'] sets stay distinguishable after flattening.
    let ownerId = parentOwnerId;
    if (!actions.length) ownerId = null;
    else if (!sameActions(actions, parentActions)) ownerId = ++nextActionOwnerId;

    pushRow(node, depth, branch, actions, ownerId);
    for (const child of node.children ?? []) visit(child, depth + 1, branch, actions, ownerId);
  };

  for (const root of roots) {
    if (!root) continue;
    pushRow(root, 0, 0, root.custom_actions ?? [], null);
    // Number the root's direct children so a row can be traced back to a
    // structural branch. This is a reading aid, NOT a way to tell the covered
    // screen from a presented sheet: in a real Settings-sheet dump every row
    // including the sheet's landed in branch 1. Confirm which screen is
    // frontmost with a label predicate, never with position or branch.
    let branch = 1;
    for (const child of root.children ?? []) {
      visit(child, 1, branch, root.custom_actions ?? [], null);
      branch += 1;
    }
  }

  return {
    screenBounds: bounds,
    screenBoundsSource: boundsSource,
    droppedCount,
    rows: creditActionOwners(rows),
  };
}

/**
 * Custom actions are echoed onto a whole subtree: a note row's
 * ['Delete', 'Move'] reappears on the unnamed Groups above it and on its
 * title, date, preview, and chevron below. Keep the set on the first labelled
 * row of each owning subtree so an affordance is listed once, against
 * something a reader can act on.
 */
function creditActionOwners(rows) {
  const creditedRuns = new Set();

  return rows.map((row) => {
    if (!row.customActions.length) return row;
    const runKey = row.actionOwnerId;
    if (creditedRuns.has(runKey)) return { ...row, customActions: [] };
    if (!row.label && !row.id) return { ...row, customActions: [] };
    creditedRuns.add(runKey);
    return row;
  });
}

export function filterRows(rows, filters = {}) {
  return rows.filter((row) => {
    if (filters.id && row.id !== filters.id) return false;
    if (filters.type && row.type !== filters.type) return false;
    // Only an action set's credited owner still carries it here, so this lists
    // each hidden affordance once (see creditActionOwners).
    if (filters.actionsOnly && !row.customActions.length) return false;
    if (filters.onScreenOnly && !row.onScreen) return false;
    if (filters.labelContains) {
      const needle = filters.labelContains.toLowerCase();
      const haystack = `${row.label ?? ''} ${row.id ?? ''}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

export function formatSummaryLines({ screenBounds, screenBoundsSource, droppedCount = 0, rows }) {
  const lines = [];
  const offScreen = rows.filter((row) => !row.onScreen).length;
  lines.push(
    `screen ${screenBounds ? `${screenBounds.width}x${screenBounds.height}pt` : 'unknown'} ` +
      `(from ${screenBoundsSource ?? 'no framed root'}) — ` +
      `${rows.length} rows, ${offScreen} off-screen, ` +
      `${droppedCount} dropped (no id/label/value/action; --all keeps them)`,
  );

  for (const row of rows) {
    const frame = row.frame
      ? `${Math.round(row.frame.x)},${Math.round(row.frame.y)} ` +
        `${Math.round(row.frame.width)}x${Math.round(row.frame.height)}`
      : '-';
    const parts = [
      `b${row.branch}`,
      (row.type ?? '?').padEnd(14),
      `id=${(row.id ?? '-').padEnd(22)}`,
      `label=${(truncate(row.label, LABEL_WIDTH) ?? '-').padEnd(LABEL_WIDTH)}`,
      frame.padEnd(18),
      row.onScreen ? '' : 'OFF-SCREEN',
    ];
    lines.push(parts.join(' ').trimEnd());
    if (row.value) lines.push(`${' '.repeat(4)}value=${truncate(row.value, VALUE_WIDTH)}`);
    if (row.customActions.length) {
      lines.push(`${' '.repeat(4)}actions=[${row.customActions.join(', ')}]`);
    }
  }

  if (offScreen > 0) {
    lines.push('');
    lines.push(
      `NOTE: ${offScreen} element(s) resolve outside the screen. ` +
        '`axe tap` reports success on those and does nothing.',
    );
  }
  return lines;
}

function parseArgs(argv) {
  const options = { udid: process.env.SIM, filters: {} };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--udid':
        options.udid = argv[++i];
        break;
      case '--file':
        options.file = argv[++i];
        break;
      case '--id':
        options.filters.id = argv[++i];
        break;
      case '--label-contains':
        options.filters.labelContains = argv[++i];
        break;
      case '--type':
        options.filters.type = argv[++i];
        break;
      case '--actions-only':
        options.filters.actionsOnly = true;
        break;
      case '--on-screen-only':
        options.filters.onScreenOnly = true;
        break;
      case '--all':
        options.includeAll = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return options;
}

function captureTree({ file, udid }) {
  if (file) return JSON.parse(readFileSync(file, 'utf8'));
  if (!udid) {
    throw new Error('no simulator: pass --udid or export SIM (see `just qa-claim ios`)');
  }
  // `axe` is not installed system-wide on every machine; honor an explicit
  // path so a tarball checkout works without touching Homebrew.
  const axe = process.env.AXE_BIN || 'axe';
  return JSON.parse(
    execFileSync(axe, ['describe-ui', '--udid', udid], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const summary = summarizeAccessibilityTree(captureTree(options), {
      includeAll: options.includeAll,
    });
    const rows = filterRows(summary.rows, options.filters);
    const rendered = {
      screenBounds: summary.screenBounds,
      screenBoundsSource: summary.screenBoundsSource,
      droppedCount: summary.droppedCount,
      rows,
    };
    if (options.json) {
      console.log(JSON.stringify(rendered, null, 2));
    } else {
      console.log(formatSummaryLines(rendered).join('\n'));
    }
  } catch (error) {
    console.error(String(error.message || error));
    process.exit(1);
  }
}
