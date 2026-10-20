// Part of the futoBridge Milkdown suite: scope and input rules are in
// editor-embed-milkdown.spec.ts.

import { expect, type Page } from '@playwright/test';
import { clearMessages, flushFrames } from './lib/editorEmbedHost';
import { hostSetContent } from './lib/editorEmbedMilkdown';
import { gutterHandleTest, mobileDndTest } from './lib/editorEmbedMilkdownDrag';
import {
  scrollableNote,
  editorScroll,
  dragLayout,
  expectDropMatchesPreview,
  blockBoxAt,
  type LiftedBlock,
  liftWithHandle,
  liftWithTouch,
} from './lib/editorEmbedMilkdownDropLayout';

// ---- the drop invariant, across block kinds -------------------------------
//
// The same invariant over every top-level block kind, as the source and as the
// neighbours it slides past, up and down, near and far, on both drag gestures.
// The note is the one the user found the multi-line case with (desktop,
// 2026-10-08: dragging the two-line intro paragraph down past A and B moved
// the other blocks on release; one-line blocks did not). List items are not
// sources here: they drag with the drop line, not the reflow preview.

const DRAG_PLAYGROUND = `# Drag Playground

Short, distinct blocks so it's obvious where each one lands. Long-press (mobile) or use the handle (desktop) and move things around. #editor

Paragraph A — the first plain paragraph.

Paragraph B — the second plain paragraph.

## Heading C

- List item D
- List item E
  - Child of E (should travel with E)
  - Second child of E
- List item F

1. Ordered G
2. Ordered H
3. Ordered I

- [ ] Task J
- [x] Task K
- [ ] Task L

> Quote M

\`\`\`
Code block N
\`\`\`

| Table | O |
|-------|---|
| row | 1 |

---

Paragraph P — after the rule.

![Image Q](sample-image.png)

Paragraph R — the last block.
`;

/** The playground's top-level blocks, by index, as the matrix names them. */
const PLAYGROUND_BLOCKS = [
  'H1',
  'intro (two lines)',
  'Paragraph A',
  'Paragraph B',
  'Heading C',
  'bullet list',
  'ordered list',
  'task list',
  'quote',
  'code',
  'table',
  'rule',
  'Paragraph P',
  'image',
  'Paragraph R',
];

/** Narrow enough that the intro wraps to two lines, as on the user's desktop,
 * and tall enough that the whole note is on screen: no edge auto-scroll. */
const PLAYGROUND_VIEWPORT = { width: 760, height: 1600 };

interface DropCase {
  source: number;
  /** The block the drop lands beside: after it going down, before it going up. */
  target: number;
}

/** Sources × {up, down} × {near, far}, skipping drops off either end. */
const DROP_CASES: DropCase[] = [0, 1, 2, 4, 8, 9, 10, 11, 13, 14].flatMap((source) =>
  [-6, -2, 2, 6]
    .map((offset) => ({ source, target: source + offset }))
    .filter(({ target }) => target >= 0 && target < PLAYGROUND_BLOCKS.length),
);

function dropCaseName({ source, target }: DropCase): string {
  const dir = target > source ? 'down' : 'up';
  const far = Math.abs(target - source) > 2 ? 'far' : 'near';
  return `${PLAYGROUND_BLOCKS[source]} ${dir} ${far} ${target > source ? 'after' : 'before'} ${PLAYGROUND_BLOCKS[target]}`;
}

/** Drags the case's source to its target with `lift`, and holds the drop to
 * the invariant; also checks it landed beside the target. */
async function runDropCase(page: Page, c: DropCase, lift: () => Promise<LiftedBlock>) {
  const target = await blockBoxAt(page, c.target);
  const keys = Object.keys((await dragLayout(page, false)).blocks);
  const lifted = await lift();
  const down = c.target > c.source;
  // The lower quarter of the target is "after it", the upper quarter "before".
  await lifted.move(target.top + (target.bottom - target.top) * (down ? 0.75 : 0.25));
  const real = await expectDropMatchesPreview(page, () => lifted.release());
  // ...and it is the move the case asked for.
  const landed = real.blocks[keys[c.source]].index - real.blocks[keys[c.target]].index;
  expect(landed).toBe(down ? 1 : -1);
}

/** Sources that cannot be lifted at all — lifting gaps, not reflow ones. The
 * rule, by either gesture: a press resolves to the position BETWEEN blocks
 * around a top-level leaf, and its line is 1px tall. The table, by the ⠿
 * handle: the table's row grip (table/tableGrips.ts) is drawn over the handle
 * at its first row, so the press goes to the grip. */
const RULE = PLAYGROUND_BLOCKS.indexOf('rule');
const TABLE = PLAYGROUND_BLOCKS.indexOf('table');

for (const c of DROP_CASES) {
  gutterHandleTest(
    `reflow drop matches its preview (handle): ${dropCaseName(c)}`,
    async ({ page }) => {
      gutterHandleTest.fixme(c.source === RULE, 'a horizontal rule cannot be lifted');
      gutterHandleTest.fixme(c.source === TABLE, "the table's row grip covers its ⠿ handle");
      await page.setViewportSize(PLAYGROUND_VIEWPORT);
      await hostSetContent(page, DRAG_PLAYGROUND);
      await clearMessages(page);
      await runDropCase(page, c, () => liftWithHandle(page, c.source));
    },
  );
  mobileDndTest(
    `reflow drop matches its preview (long press): ${dropCaseName(c)}`,
    async ({ page, cdp }) => {
      mobileDndTest.fixme(c.source === RULE, 'a horizontal rule cannot be lifted');
      await page.setViewportSize(PLAYGROUND_VIEWPORT);
      await hostSetContent(page, DRAG_PLAYGROUND);
      await clearMessages(page);
      await runDropCase(page, c, () => liftWithTouch(page, cdp, c.source));
    },
  );
}

/** The playground with enough after it to scroll. */
const SCROLLING_PLAYGROUND = `${DRAG_PLAYGROUND}\n${scrollableNote(60)}`;

/** Lifts `index`, holds the pointer in the bottom (or top) edge zone until the
 * note has scrolled `distance` px, then parks it mid-screen and drops. */
async function runAutoScrollDrop(
  page: Page,
  lift: () => Promise<LiftedBlock>,
  direction: 'down' | 'up',
) {
  const start = await editorScroll(page);
  const lifted = await lift();
  await lifted.move(direction === 'down' ? start.bottomEdge - 12 : start.topEdge + 12);
  await expect
    .poll(async () => Math.abs((await editorScroll(page)).top - start.top), { timeout: 8000 })
    .toBeGreaterThan(700);
  await lifted.move((start.topEdge + start.bottomEdge) / 2);
  await expectDropMatchesPreview(page, () => lifted.release());
}

const AUTO_SCROLL_VIEWPORT = { width: 760, height: 720 };

/** The intro (two lines) going down, and a block from the end going up. */
const AUTO_SCROLL_CASES = [
  { name: 'intro (two lines) down', index: 1, direction: 'down' as const },
  { name: 'Paragraph A down', index: 2, direction: 'down' as const },
  { name: 'Line 55 up', index: PLAYGROUND_BLOCKS.length + 55, direction: 'up' as const },
];

for (const c of AUTO_SCROLL_CASES) {
  const setUp = async (page: Page) => {
    await page.setViewportSize(AUTO_SCROLL_VIEWPORT);
    await hostSetContent(page, SCROLLING_PLAYGROUND);
    await clearMessages(page);
    if (c.direction === 'up') {
      await page.evaluate(() => {
        const dom = document.querySelector('.ProseMirror') as HTMLElement;
        dom.scrollTop = dom.scrollHeight;
      });
      await flushFrames(page);
    }
  };
  gutterHandleTest(
    `reflow drop after auto-scroll matches its preview (handle): ${c.name}`,
    async ({ page }) => {
      await setUp(page);
      await runAutoScrollDrop(page, () => liftWithHandle(page, c.index), c.direction);
    },
  );
  mobileDndTest(
    `reflow drop after auto-scroll matches its preview (long press): ${c.name}`,
    async ({ page, cdp }) => {
      await setUp(page);
      await runAutoScrollDrop(page, () => liftWithTouch(page, cdp, c.index), c.direction);
    },
  );
}
