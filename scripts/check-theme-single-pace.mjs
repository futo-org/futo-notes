import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const THEME_DEPENDENT_PROPERTIES = new Set([
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

const REST_VALUES_THAT_CANNOT_CARRY_A_THEME_COLOUR = new Set(['transparent', 'none', '0']);

const SHORTHAND_ALIASES = {
  'background-color': ['background'],
  background: ['background-color'],
  'border-color': ['border'],
  border: ['border-color'],
};

const ANDROID_UI_DIR = path.join(ROOT, 'apps/android/app/src/main/java/com/futo/notes');
const WRAPPER_REL = 'apps/android/app/src/main/java/com/futo/notes/ui/components/TopBar.kt';
const IOS_SOURCES = path.join(ROOT, 'apps/ios/Sources');

const INNERMOST_RULE_BLOCK_RE = /([^{}]+)\{([^{}]*)\}/g;
const TRANSITION_DECLARATION_RE = /(?:^|;)\s*transition(?:-property)?\s*:\s*([^;]+)/g;
const MATERIAL_TOP_APP_BAR_CALL_RE = /(?<![A-Za-z])(?:CenterAligned|Medium|Large)?TopAppBar\s*\(/g;
const PREFERRED_COLOR_SCHEME_CALL_RE = /\.preferredColorScheme\s*\(/g;

function walk(dir, extensions, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, extensions, out);
    else if (extensions.some((extension) => entry.name.endsWith(extension))) out.push(full);
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function declaredRestValue(blockBody, property) {
  for (const name of [property, ...(SHORTHAND_ALIASES[property] ?? [])]) {
    const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(blockBody);
    if (match) {
      const value = match[1].trim().toLowerCase();
      return name === 'border' ? value.split(/\s+/).pop() : value;
    }
  }
  return null;
}

function transitionedProperties(transitionValue) {
  return transitionValue
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0]?.toLowerCase())
    .filter(Boolean);
}

function selectorOf(rawSelector) {
  return rawSelector
    .trim()
    .split('\n')
    .pop()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^<style[^>]*>\s*/, '');
}

const failures = [];

for (const file of walk(path.join(ROOT, 'src'), ['.css', '.svelte'])) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  INNERMOST_RULE_BLOCK_RE.lastIndex = 0;
  let block;
  while ((block = INNERMOST_RULE_BLOCK_RE.exec(text)) !== null) {
    const selector = selectorOf(block[1]);
    const body = block[2];
    if (selector.startsWith('@')) continue;

    const bodyStart = block.index + block[1].length + 1;
    TRANSITION_DECLARATION_RE.lastIndex = 0;
    let declaration;
    while ((declaration = TRANSITION_DECLARATION_RE.exec(body)) !== null) {
      const line = lineOf(
        text,
        bodyStart + declaration.index + declaration[0].indexOf('transition'),
      );
      for (const property of transitionedProperties(declaration[1])) {
        if (!THEME_DEPENDENT_PROPERTIES.has(property)) continue;
        const rest = property === 'all' ? null : declaredRestValue(body, property);
        if (rest !== null && REST_VALUES_THAT_CANNOT_CARRY_A_THEME_COLOUR.has(rest)) continue;
        failures.push(
          `${rel}:${line} — '${selector}' transitions '${property}', whose value follows the ` +
            `theme, so a theme swap animates it while the rest of the window snaps. ` +
            (property === 'all'
              ? `A blanket 'transition: all' can never be shown safe — name the ` +
                `transform/opacity properties you actually want to animate.`
              : rest === null
                ? `Give the block an inert rest value ('${property}: transparent') so the theme ` +
                  `colour is only reachable under :hover/:active — states an unattended theme ` +
                  `change never enters — or drop the transition.`
                : `Its rest value here is '${rest}', a real colour. Drop the transition — ` +
                  `press/hover feedback belongs on transform/opacity.`),
        );
      }
    }
  }
}

for (const file of walk(ANDROID_UI_DIR, ['.kt'])) {
  const rel = path.relative(ROOT, file);
  if (rel === WRAPPER_REL) continue;
  const text = fs.readFileSync(file, 'utf8');
  MATERIAL_TOP_APP_BAR_CALL_RE.lastIndex = 0;
  let call;
  while ((call = MATERIAL_TOP_APP_BAR_CALL_RE.exec(text)) !== null) {
    const called = call[0].replace(/\s*\($/, '');
    failures.push(
      `${rel}:${lineOf(text, call.index)} — calls Material3 ${called} directly. Material runs ` +
        `the bar's container colour through animateColorAsState, so a theme swap springs the bar ` +
        `while the Scaffold and cards snap. Use TopBar (${WRAPPER_REL}), or add the variant you ` +
        `need there so one place owns the instant background.`,
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
      `${WRAPPER_REL} no longer pins 'containerColor = Color.Transparent'. That constant is the ` +
        `whole point: it gives Material's animateColorAsState nothing to animate, leaving ` +
        `Modifier.background to paint the real surface in one frame.`,
    );
  }
  if (!/Modifier\.background\(/.test(wrapper)) {
    failures.push(
      `${WRAPPER_REL} no longer paints its surface with Modifier.background — with a transparent ` +
        `container and no background, the bar renders see-through.`,
    );
  }
}

for (const file of walk(IOS_SOURCES, ['.swift'])) {
  const rel = path.relative(ROOT, file);
  if (rel.includes(`${path.sep}Generated`)) continue;
  const text = fs.readFileSync(file, 'utf8');
  PREFERRED_COLOR_SCHEME_CALL_RE.lastIndex = 0;
  let call;
  while ((call = PREFERRED_COLOR_SCHEME_CALL_RE.exec(text)) !== null) {
    failures.push(
      `${rel}:${lineOf(text, call.index)} — applies the theme with .preferredColorScheme. That ` +
        `never reaches an already-presented sheet, which then keeps its old appearance ` +
        `entirely — measured on iOS 26 as unchanged across four Light/Dark taps. Use the window ` +
        `override (Theme.swift 'appearanceOverride').`,
    );
  }
}

if (failures.length > 0) {
  console.error('Single-pace theming gate FAILED:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    `\n${failures.length} issue(s). A theme swap must repaint every surface in one frame; ` +
      `the rule and its evidence are in docs/spec/app.md ("Appearance").`,
  );
  process.exit(1);
}

console.log(
  'Single-pace theming gate OK — no theme-dependent CSS transitions with a coloured rest value, ' +
    'every Android top bar routes through TopBar, and iOS applies the theme as a window trait.',
);
