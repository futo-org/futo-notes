// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { runPuppetCommand } from './puppetInspector';
import './puppetInspector.fixture';

// jsdom does no layout: give one element a scrollable box whose offset stops at its ends.
function scrollBox(content: number, viewport: number): HTMLDivElement {
  const box = document.createElement('div');
  box.style.overflowY = 'auto';
  Object.defineProperty(box, 'scrollHeight', { value: content });
  Object.defineProperty(box, 'clientHeight', { value: viewport });
  let offset = 0;
  Object.defineProperty(box, 'scrollTop', {
    get: () => offset,
    set: (top: number) => (offset = Math.max(0, Math.min(content - viewport, top))),
  });
  const row = document.createElement('button');
  box.appendChild(row);
  document.body.appendChild(box);
  // jsdom has no elementFromPoint at all.
  Object.defineProperty(document, 'elementFromPoint', { value: () => row, configurable: true });
  return box;
}

afterEach(() => {
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  document.body.innerHTML = '';
});

describe('ScrollBy', () => {
  it('scrolls what is under the point at once and answers once the browser fires scroll', async () => {
    const box = scrollBox(2000, 400);

    const reply = runPuppetCommand('do', { verb: 'ScrollBy', args: { x: 10, y: 10, dy: 300 } });

    expect(box.scrollTop).toBe(300);
    // Until the page's rendering update fires `scroll`, WebKit's scrolling thread still
    // holds the old offset, and a real wheel sent now would lose a notch.
    expect(reply.status).toBe(202);
    const action = (reply.body as { action: number }).action;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runPuppetCommand('diff', { action }).body).toMatchObject({ pending: true });

    box.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runPuppetCommand('diff', { action }).body).not.toMatchObject({ pending: true });
  });

  it('refuses a scroll that moves nothing, and a zero distance', () => {
    scrollBox(2000, 400);
    const up = runPuppetCommand('do', { verb: 'ScrollBy', args: { x: 10, y: 10, dy: -50 } });
    expect(up.status).toBe(409);
    expect((up.body as { error: string }).error).toContain('already at its end');
    expect(runPuppetCommand('do', { verb: 'ScrollBy', args: { x: 10, y: 10 } }).status).toBe(400);
  });

  it('is offered on every screen, marked as not real input', () => {
    const { actions } = runPuppetCommand('actions', {}).body as {
      actions: Array<{ name: string; convenience?: boolean }>;
    };
    expect(actions.find((action) => action.name === 'ScrollBy')?.convenience).toBe(true);
  });
});
