// editor-bench.mjs's scripted interactions: the fixture notes, the page
// helpers that drive the embed, and the scenario list that is scored.

// ── Fixture: a deterministic note with every common block kind ─────────────

function richNote(blocks, seed) {
  const out = [];
  for (let i = 0; i < blocks; i++) {
    const n = i + seed;
    switch (i % 10) {
      case 0:
        out.push(`## Section ${n}`);
        break;
      case 1:
      case 5:
        out.push(
          `Paragraph ${n} has **bold**, *italic*, \`code\`, a [link](https://example.test/${n}) and #tag${n % 7} in it.`,
        );
        break;
      case 2:
        out.push(`- item ${n}\n- item ${n} two\n  - nested ${n}\n- item ${n} three`);
        break;
      case 3:
        out.push(`- [ ] task ${n}\n- [x] done ${n}`);
        break;
      case 4:
        out.push(`> quoted ${n}\n> second line`);
        break;
      case 6:
        out.push(`1. first ${n}\n2. second ${n}`);
        break;
      case 7:
        out.push('```js\nconst x' + n + ' = ' + n + ';\nconsole.log(x' + n + ');\n```');
        break;
      case 8:
        out.push(`| a | b |\n| --- | --- |\n| ${n} | [[Note ${n}]] |`);
        break;
      default:
        out.push(
          `Plain line ${n} of ordinary prose that wraps on a phone-width screen, more or less.`,
        );
    }
  }
  return out.join('\n\n') + '\n';
}

const NOTE_SMALL = richNote(40, 0);
const NOTE_LARGE = richNote(2000, 0);
const NOTE_OTHER = richNote(400, 5000);

// ── Page helpers ──────────────────────────────────────────────────────────

// One animation frame. A rAF callback runs before that frame's style, layout
// and paint, and the reply to Playwright is only processed after the frame
// finishes, so the next input never lands inside the previous one's frame.
export const frame = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));

// Waits until the editor has nothing queued: four full (50 ms) idle periods in
// a row. The open primes its serializer and streams its tail in idle slices
// sized by wall time, so a scenario that stops measuring while they still run
// counts a load-dependent share of them (switch-note's JS calls moved 17 %
// between two passes before this). Settling before AND after the measured
// step puts all of a step's background work inside its count, however it was
// sliced. Four periods is the editor's own 200 ms idle-callback timeout.
export async function settle(page) {
  await page.evaluate(async () => {
    const start = performance.now();
    let quiet = 0;
    while (quiet < 4) {
      if (performance.now() - start > 10_000) throw new Error('editor never went idle');
      const left = await new Promise((r) => requestIdleCallback((d) => r(d.timeRemaining())));
      quiet = left >= 49 ? quiet + 1 : 0;
    }
  });
}

async function waitOpenComplete(page) {
  await page.waitForFunction(
    () => performance.getEntriesByName('futo:editor-open-complete').length > 0,
    null,
    { timeout: 60_000, polling: 'raf' },
  );
}

async function setContent(page, noteId, markdown) {
  await page.evaluate(
    ([id, md]) => {
      performance.clearMeasures('futo:editor-open-complete');
      window.FutoEditor.setContent(id, md);
    },
    [noteId, markdown],
  );
  await waitOpenComplete(page);
  await frame(page);
}

// Waits for the debounced `change` post that follows an edit: the serialize it
// carries is part of what an edit costs, so it lands inside the measurement.
async function waitChange(page, since) {
  await page.waitForFunction(
    (n) => window.__msgs.filter((m) => m.type === 'change').length > n,
    since,
    { timeout: 10_000, polling: 'raf' },
  );
}
const changeCount = (page) =>
  page.evaluate(() => window.__msgs.filter((m) => m.type === 'change').length);

// Places the caret by a real click on the Nth paragraph's text and waits until
// ProseMirror has read it (see withCaretObserved in editorEmbedHost.ts).
async function clickInto(page, selector, nth) {
  await page.evaluate(() => {
    window.__caretMoves = 0;
    document.addEventListener('selectionchange', () => (window.__caretMoves += 1));
  });
  const el = page.locator(`.ProseMirror ${selector}`).nth(nth);
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
  await page.waitForFunction(() => window.__caretMoves > 0, null, { polling: 'raf' });
  await page.keyboard.press('End');
  await frame(page);
}

// One key per rendered frame: how a human types, and it keeps the style
// recalcs per key from batching differently run to run.
async function typeKeys(page, text) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await frame(page);
  }
}
async function pressKeys(page, key, times) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await frame(page);
  }
}

// ── Block drag ───────────────────────────────────────────────────────────
// The long-press drag both native shells ship (mobileBlockDnd.ts), driven by a
// real CDP touch stream as the editor-embed spec does: DOM-dispatched events
// would miss the gesture's own listeners (AGENTS.md M21).

const touch = (cdp, type, x, y) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
  });
const hapticCount = (page) =>
  page.evaluate(() => window.__msgs.filter((m) => m.type === 'haptic').length);

// Centres of the source block and of the block to drop below, read in setup so
// the measured gesture does no layout reads of its own.
async function dragPlan(page, from, to) {
  return page.evaluate(
    ([a, b]) => {
      const blocks = document.querySelectorAll('.ProseMirror > *');
      const r = (i) => blocks[i].getBoundingClientRect();
      const src = r(a);
      const dst = r(b);
      return {
        from: { x: src.left + src.width / 2, y: src.top + src.height / 2 },
        // Just above the target's bottom edge: the slot after it.
        to: { x: dst.left + dst.width / 2, y: dst.bottom - 2 },
      };
    },
    [from, to],
  );
}

// Hold until the lift (its haptic post, not a fixed sleep), then 12 moves one
// frame apart, release, and wait for the moved note's `change`. No autoscroll:
// its speed is time-based, which would make the count depend on the machine.
async function longPressDrag(page, plan) {
  const cdp = await page.context().newCDPSession(page);
  const haptics = await hapticCount(page);
  const changes = await changeCount(page);
  await touch(cdp, 'touchStart', plan.from.x, plan.from.y);
  await page.waitForFunction(
    (n) => window.__msgs.filter((m) => m.type === 'haptic').length > n,
    haptics,
    {
      polling: 'raf',
    },
  );
  const MOVES = 12;
  for (let i = 1; i <= MOVES; i++) {
    const t = i / MOVES;
    await touch(
      cdp,
      'touchMove',
      plan.from.x + (plan.to.x - plan.from.x) * t,
      plan.from.y + (plan.to.y - plan.from.y) * t,
    );
    await frame(page);
  }
  await touch(cdp, 'touchEnd', plan.to.x, plan.to.y);
  await waitChange(page, changes);
  await cdp.detach();
}

function dragScenario(name, note, noteText) {
  let plan;
  return {
    name,
    note,
    setup: async (page) => {
      await setContent(page, name, noteText);
      await settle(page);
      // Block 1 (a paragraph) to below block 7 (a code fence): both on screen.
      plan = await dragPlan(page, 1, 7);
    },
    run: async (page) => longPressDrag(page, plan),
  };
}

// ── Scenarios ────────────────────────────────────────────────────────────
// `setup` runs untimed; `run` is measured. Each starts from a fresh page.

export const SCENARIOS = [
  {
    name: 'open-large',
    note: '2000-block note, setContent → open complete',
    setup: async () => {},
    run: async (page) => setContent(page, 'large', NOTE_LARGE),
  },
  {
    name: 'switch-note',
    note: 'large note open, switch to a 400-block note',
    setup: async (page) => setContent(page, 'large', NOTE_LARGE),
    run: async (page) => setContent(page, 'other', NOTE_OTHER),
  },
  {
    name: 'type-small',
    note: '40-block note, 10 chars at the end of a paragraph',
    setup: async (page) => {
      await setContent(page, 'small', NOTE_SMALL);
      await clickInto(page, 'p', 1);
    },
    run: async (page) => {
      const n = await changeCount(page);
      await typeKeys(page, ' typed in.');
      await waitChange(page, n);
    },
  },
  {
    name: 'type-large',
    note: '2000-block note, 10 chars at the end of a paragraph',
    setup: async (page) => {
      await setContent(page, 'large', NOTE_LARGE);
      await clickInto(page, 'p', 1);
    },
    run: async (page) => {
      const n = await changeCount(page);
      await typeKeys(page, ' typed in!');
      await waitChange(page, n);
    },
  },
  {
    name: 'enter-list-large',
    note: '2000-block note, Enter + 2 chars ×3 in a list',
    setup: async (page) => {
      await setContent(page, 'large', NOTE_LARGE);
      await clickInto(page, 'li p', 0);
    },
    run: async (page) => {
      const n = await changeCount(page);
      for (let i = 0; i < 3; i++) {
        await pressKeys(page, 'Enter', 1);
        await typeKeys(page, `n${i}`);
      }
      await waitChange(page, n);
    },
  },
  {
    name: 'backspace-join-large',
    note: '2000-block note, Backspace ×6 across a block boundary',
    setup: async (page) => {
      await setContent(page, 'large', NOTE_LARGE);
      await clickInto(page, 'p', 2);
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await frame(page);
    },
    run: async (page) => {
      const n = await changeCount(page);
      await pressKeys(page, 'Backspace', 6);
      await waitChange(page, n);
    },
  },
  dragScenario('drag-small', '40-block note, long-press block 1 to below block 7', NOTE_SMALL),
  dragScenario('drag-large', '2000-block note, long-press block 1 to below block 7', NOTE_LARGE),
];
