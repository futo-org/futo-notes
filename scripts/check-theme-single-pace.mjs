// Single-pace theming gate.
//
// A theme swap must repaint every surface in ONE frame. The recurring bug is
// not a bad colour — it is a colour whose UPDATE PATH differs from the rest of
// the screen's, so it fades or springs to its new value while everything else
// snaps. Neither CSS, Compose, nor UIKit can tell a theme-driven colour change
// from the hover/scroll/trait change the path was written for.
//
// Three separate landings fixed three instances of the same law (55478cfc on
// desktop CSS, MR !269 and its follow-up on Compose). Nothing held the rule, so
// each platform surprised us in turn. This gate holds it.
//
//   node scripts/check-theme-single-pace.mjs   (just check-theme-single-pace)
//
// Fails on:
//   (a) a CSS `transition` covering a theme-dependent property whose rest value
//       in the same rule block is a real colour (a transparent/none rest value
//       is fine — the theme-dependent value is then only reachable under
//       :hover/:active, which an unattended theme flip never enters)
//   (b) a Material3 `TopAppBar(` called outside its wrapper — M3 runs the bar's
//       container colour through animateColorAsState, so app code must go
//       through FutoTopBar, which pins that colour to a constant and paints the
//       real surface with Modifier.background
//   (c) the wrapper itself losing the transparent container that makes (b) work
//   (d) a SwiftUI `.preferredColorScheme` applying the theme — it never reaches an
//       already-presented sheet, which then keeps its old appearance entirely

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Properties whose value moves when the theme does. `all` is here because a
// transition that covers everything necessarily covers these.
const THEME_PROPERTIES = new Set([
  'all',
  'background',
  'background-color',
  'border',
  'border-color',
  'box-shadow',
  'color',
  'fill',
  'outline-color',
  'stroke',
  'text-shadow',
]);

// A rest value that cannot carry a theme colour. `0` covers box-shadow: 0.
const INERT_REST_VALUES = new Set(['transparent', 'none', '0']);

const ANDROID_UI_DIR = path.join(ROOT, 'apps/android/app/src/main/java/com/futo/notes');
const WRAPPER_REL = 'apps/android/app/src/main/java/com/futo/notes/ui/components/FutoTopBar.kt';

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// Innermost rule blocks: a body with no braces of its own. An @media wrapper
// therefore does not match, but every rule inside it does.
const RULE_BLOCK_RE = /([^{}]+)\{([^{}]*)\}/g;
const TRANSITION_RE = /(?:^|;)\s*transition(?:-property)?\s*:\s*([^;]+)/g;

// A longhand's rest value can be written via its shorthand, so
// `background: transparent` has to count when the transition names
// `background-color`.
const SHORTHAND_ALIASES = {
  'background-color': ['background'],
  background: ['background-color'],
  'border-color': ['border'],
  border: ['border-color'],
};

// The declared rest value of `property` inside a block body, or null.
function restValue(body, property) {
  for (const name of [property, ...(SHORTHAND_ALIASES[property] ?? [])]) {
    const re = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i');
    const match = re.exec(body);
    if (match) {
      // `border: 1px solid transparent` — the colour is the last token.
      const value = match[1].trim().toLowerCase();
      return name === 'border' ? value.split(/\s+/).pop() : value;
    }
  }
  return null;
}

function propertiesIn(transitionValue) {
  // `background 0.1s ease, color 0.2s` -> ['background', 'color']
  return transitionValue
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0]?.toLowerCase())
    .filter(Boolean);
}

const failures = [];

// --- (a) CSS ---------------------------------------------------------------

for (const file of walk(path.join(ROOT, 'src'), ['.css', '.svelte'])) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  RULE_BLOCK_RE.lastIndex = 0;
  let block;
  while ((block = RULE_BLOCK_RE.exec(text)) !== null) {
    // A .svelte block's "selector" can trail the markup that precedes its
    // <style>; keep the last line, which is the selector itself.
    const selector = block[1]
      .trim()
      .split('\n')
      .pop()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/^<style[^>]*>\s*/, '');
    const body = block[2];
    if (selector.startsWith('@')) continue;

    // +1 for the brace itself; the match can start at the previous
    // declaration's ';', so seek the keyword inside it.
    const bodyStart = block.index + block[1].length + 1;
    TRANSITION_RE.lastIndex = 0;
    let declaration;
    while ((declaration = TRANSITION_RE.exec(body)) !== null) {
      const line = lineOf(
        text,
        bodyStart + declaration.index + declaration[0].indexOf('transition'),
      );
      for (const property of propertiesIn(declaration[1])) {
        if (!THEME_PROPERTIES.has(property)) continue;
        const rest = property === 'all' ? null : restValue(body, property);
        if (rest !== null && INERT_REST_VALUES.has(rest)) continue;
        failures.push(
          `${rel}:${line} — '${selector}' transitions '${property}', whose value follows the ` +
            `theme, so a theme swap animates it while the rest of the window snaps. ` +
            (property === 'all'
              ? `A blanket 'transition: all' can never be shown safe — name the ` +
                `transform/opacity properties you actually want to animate.`
              : rest === null
                ? `Give the block an inert rest value ('${property}: transparent') so the ` +
                  `theme colour is only reachable under :hover/:active, or drop the transition.`
                : `Its rest value here is '${rest}', a real colour. Drop the transition — ` +
                  `press/hover feedback belongs on transform/opacity.`),
        );
      }
    }
  }
}

// --- (b) + (c) Compose -----------------------------------------------------

// Every M3 top-bar entry point routes through SingleRowTopAppBar or
// TwoRowsTopAppBar, and both animate the container colour.
const TOP_APP_BAR_CALL_RE = /(?<![A-Za-z])(?:CenterAligned|Medium|Large)?TopAppBar\s*\(/g;

for (const file of walk(ANDROID_UI_DIR, ['.kt'])) {
  const rel = path.relative(ROOT, file);
  if (rel === WRAPPER_REL) continue;
  const text = fs.readFileSync(file, 'utf8');
  TOP_APP_BAR_CALL_RE.lastIndex = 0;
  let call;
  while ((call = TOP_APP_BAR_CALL_RE.exec(text)) !== null) {
    const called = call[0].replace(/\s*\($/, '');
    failures.push(
      `${rel}:${lineOf(text, call.index)} — calls Material3 ${called} directly. M3 runs the ` +
        `bar's container colour through animateColorAsState, so a theme swap springs the bar ` +
        `while the Scaffold and cards snap. Use FutoTopBar (${WRAPPER_REL}), or add the ` +
        `variant you need there so one place owns the instant background.`,
    );
  }
}

const wrapperPath = path.join(ROOT, WRAPPER_REL);
if (!fs.existsSync(wrapperPath)) {
  failures.push(
    `${WRAPPER_REL} is missing — every Android top bar is supposed to route through it.`,
  );
} else {
  const wrapper = fs.readFileSync(wrapperPath, 'utf8');
  if (!/containerColor\s*=\s*Color\.Transparent/.test(wrapper)) {
    failures.push(
      `${WRAPPER_REL} no longer pins 'containerColor = Color.Transparent'. That constant is ` +
        `the whole point: it gives M3's animateColorAsState nothing to animate, leaving ` +
        `Modifier.background to paint the real surface in one frame.`,
    );
  }
  if (!/Modifier\.background\(/.test(wrapper)) {
    failures.push(
      `${WRAPPER_REL} no longer paints its surface with Modifier.background — with a ` +
        `transparent container and no background, the bar renders see-through.`,
    );
  }
}

// --- (d) SwiftUI -----------------------------------------------------------

// Measured on an iPhone 17 Pro simulator (iOS 26): with a root
// `.preferredColorScheme`, tapping Light/Dark in the open Settings sheet moved
// the segmented control but left the sheet's own background on its old
// appearance for all 468 recorded frames. The window override repaints it in a
// single frame. So the theme is a window trait, never a SwiftUI preference.
const IOS_SOURCES = path.join(ROOT, 'apps/ios/Sources');
const PREFERRED_COLOR_SCHEME_RE = /\.preferredColorScheme\s*\(/g;

for (const file of walk(IOS_SOURCES, ['.swift'])) {
  const rel = path.relative(ROOT, file);
  if (rel.includes(`${path.sep}Generated`)) continue;
  const text = fs.readFileSync(file, 'utf8');
  PREFERRED_COLOR_SCHEME_RE.lastIndex = 0;
  let call;
  while ((call = PREFERRED_COLOR_SCHEME_RE.exec(text)) !== null) {
    failures.push(
      `${rel}:${lineOf(text, call.index)} — applies the theme with ` +
        `.preferredColorScheme. That does not reach an already-presented sheet, which then ` +
        `keeps its old appearance entirely. Use the window override ` +
        `(Theme.swift 'appearanceOverride').`,
    );
  }
}

// --- report ----------------------------------------------------------------

if (failures.length > 0) {
  console.error('Single-pace theming gate FAILED:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    `\n${failures.length} issue(s). Background: docs/spec/app.md ` +
      `("Theme changes are single-pace").`,
  );
  process.exit(1);
}

console.log(
  'Single-pace theming gate OK — no theme-dependent CSS transitions with a coloured rest ' +
    'value, every Android top bar routes through FutoTopBar, and iOS applies the theme as a ' +
    'window trait.',
);
