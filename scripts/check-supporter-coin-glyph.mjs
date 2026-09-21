// The FUTO supporter coin glyph is a DERIVED shape, not freehand art — and the
// three platform copies of it must be the same shape.
//
// Both halves of that are why this gate exists. All three copies once carried a
// hand-drawn path that was a pinched figure-eight rather than the FUTO diamond,
// about a quarter of the right width. Desktop draws the three.js coin on top of
// its copy, so the wrong glyph was only ever visible on the two native shells,
// and nothing in the repo could tell. `drift-registry.json` called the concept
// unlocked on the grounds that no gate could compare an inline SVG path, an
// .svg in an .xcassets imageset and an Android <vector> pathData for visual
// equivalence. That is true in general and false here: the three carry the byte
// -identical path string, and the shape itself is computable from the coin's own
// constants, so both claims are checkable.
//
// The geometry is the hole from `src/features/license/supporterCoin.ts`, which is
// in turn ported from lib-polar's `coin-bounce.js`: a disc of radius 22 in a 48
// box, with a rounded square on its point punched through it — half-diagonal
// 0.45 of the disc radius, corners rounded by 0.16 of it. Change those constants
// and this gate tells you the exact path to paste into all three files.
//
//   node scripts/check-supporter-coin-glyph.mjs
//   node scripts/check-supporter-coin-glyph.mjs --print   # just emit the path

import { readFileSync } from 'node:fs';

/// Straight from `supporterCoin.ts`, expressed in the glyph's 48-unit box.
const BOX = 48;
const CENTER = BOX / 2;
const OUTER_RADIUS = 22;
const DIAMOND_HALF_FRACTION = 0.45;
const CORNER_FRACTION = 0.16;

/// Where each copy lives, and how to pull the path out of that file's format.
const COPIES = [
  {
    path: 'src/features/license/SupporterCoin.svelte',
    extract: (s) => s.match(/\n\s*d="([^"]+)"/)?.[1],
  },
  {
    path: 'apps/ios/Assets.xcassets/SupporterCoin.imageset/supporter-coin.svg',
    extract: (s) => s.match(/\n\s*d="([^"]+)"/)?.[1],
  },
  {
    path: 'apps/android/app/src/main/res/drawable/ic_supporter_coin.xml',
    extract: (s) => s.match(/android:pathData="([^"]+)"/)?.[1],
  },
];

/// Trims trailing zeros so `24.000` and `24` are the same token, because the two
/// hand-maintained formats would otherwise differ over nothing.
const round = (n) => Number(n.toFixed(3)).toString();

/// `from` moved `distance` of the way towards `to`. The corners start and end
/// this far back along the two edges meeting at each point.
function towards(from, to, distance) {
  const [dx, dy] = [to[0] - from[0], to[1] - from[1]];
  const length = Math.hypot(dx, dy);
  return [from[0] + (dx / length) * distance, from[1] + (dy / length) * distance];
}

/// The canonical glyph: the disc, then the diamond as a second subpath. Together
/// with `fill-rule="evenodd"` at every call site, the second punches the first.
export function canonicalGlyphPath() {
  const half = OUTER_RADIUS * DIAMOND_HALF_FRACTION;
  const corner = Math.min(OUTER_RADIUS * CORNER_FRACTION, half * 0.7);

  // Shape space has y up; SVG and Android vector paths have y down.
  const toBox = ([x, y]) => `${round(CENTER + x)} ${round(CENTER - y)}`;
  const point = { top: [0, half], right: [half, 0], bottom: [0, -half], left: [-half, 0] };

  const disc =
    `M${CENTER} ${CENTER - OUTER_RADIUS}` +
    `a${OUTER_RADIUS} ${OUTER_RADIUS} 0 1 1 0 ${OUTER_RADIUS * 2}` +
    ` ${OUTER_RADIUS} ${OUTER_RADIUS} 0 0 1 0-${OUTER_RADIUS * 2}Z`;

  const corners = [
    ['top', 'right'],
    ['right', 'bottom'],
    ['bottom', 'left'],
    ['left', 'top'],
  ];
  let diamond = `M${toBox(towards(point.top, point.left, corner))}`;
  corners.forEach(([at, next], index) => {
    diamond += `Q${toBox(point[at])} ${toBox(towards(point[at], point[next], corner))}`;
    // Every corner but the last runs a straight edge on to where the next one
    // starts. The last one's edge ends exactly where the path began, which `Z`
    // already draws, so emitting it would be a duplicated segment.
    if (index < corners.length - 1) {
      diamond += `L${toBox(towards(point[next], point[at], corner))}`;
    }
  });

  return `${disc}${diamond}Z`;
}

function main() {
  const expected = canonicalGlyphPath();

  if (process.argv.includes('--print')) {
    console.log(expected);
    return;
  }

  const failures = [];
  for (const copy of COPIES) {
    let actual;
    try {
      actual = copy.extract(readFileSync(copy.path, 'utf8'));
    } catch (error) {
      failures.push(`${copy.path}: cannot read (${error.message})`);
      continue;
    }
    // A copy whose path cannot be found at all is a failure, not a skip: the
    // file was restructured and this gate silently stopped covering it.
    if (!actual) {
      failures.push(`${copy.path}: no glyph path found — did the file's shape change?`);
    } else if (actual !== expected) {
      failures.push(`${copy.path}:\n    expected ${expected}\n    actual   ${actual}`);
    }
  }

  if (failures.length > 0) {
    console.error('Supporter coin glyph gate FAILED\n');
    for (const failure of failures) console.error(`  ${failure}\n`);
    console.error(
      'The glyph is derived, not drawn. Paste the expected path into every copy\n' +
        '(`node scripts/check-supporter-coin-glyph.mjs --print`), or, if the coin\n' +
        'itself changed, update the constants here AND in supporterCoin.ts together.',
    );
    process.exit(1);
  }

  console.log(`Supporter coin glyph gate OK — ${COPIES.length} copies carry the derived path.`);
}

main();
