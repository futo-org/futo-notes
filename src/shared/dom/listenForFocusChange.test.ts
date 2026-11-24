// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { listenForFocusChange } from './listenForFocusChange';

function changesFor(types: string[], target?: (element: HTMLElement) => EventTarget): boolean[] {
  const element = document.createElement('div');
  const child = element.appendChild(document.createElement('input'));
  const changes: boolean[] = [];
  listenForFocusChange(element, (focused) => changes.push(focused));
  for (const type of types) {
    const bubbles = type === 'focusin' || type === 'focusout';
    (target?.(child) ?? element).dispatchEvent(new FocusEvent(type, { bubbles }));
  }
  return changes;
}

describe('listenForFocusChange', () => {
  it('changes once for focus then focusin, and blur then focusout', () => {
    expect(changesFor(['focus', 'focusin', 'blur', 'focusout'])).toEqual([true, false]);
  });

  it('changes on focusin and focusout when no focus or blur came (WebKitGTK, page unfocused)', () => {
    expect(changesFor(['focusin', 'focusout'])).toEqual([true, false]);
  });

  it('changes nothing for a descendant taking or losing focus', () => {
    expect(changesFor(['focusin', 'focusout'], (child) => child)).toEqual([]);
  });
});
