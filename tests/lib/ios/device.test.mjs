import { beforeEach, describe, expect, it, vi } from 'vitest';

const { typeCharacter, describeUiTree, tapPoint, touchPoint, warmDisplay } = vi.hoisted(() => ({
  typeCharacter: vi.fn(),
  describeUiTree: vi.fn(),
  tapPoint: vi.fn(),
  touchPoint: vi.fn(),
  warmDisplay: vi.fn(),
}));
vi.mock('./axeClient.mjs', () => ({
  createAxeClient: () => ({
    typeText: typeCharacter,
    describeUiTree,
    tapPoint,
    touchPoint,
    warmDisplay,
  }),
}));

import { createIosDevice } from './device.mjs';

beforeEach(() => vi.clearAllMocks());

describe('observed iOS typing', () => {
  it.each([
    ['confirmed translation error', 'No translation object', true, null],
    ['unconfirmed translation error', 'No translation object', undefined, 'No translation object'],
    ['unrelated error with an oracle', 'simulator disconnected', true, 'simulator disconnected'],
    ['unobserved input', null, false, 'waiting for the typed text to be observed'],
  ])('handles %s', async (_name, error, observed, expected) => {
    if (error)
      typeCharacter.mockImplementationOnce(() => {
        throw new Error(error);
      });
    const confirm = observed === undefined ? undefined : vi.fn(() => observed);
    const typing = createIosDevice({ udid: 'claimed' }).typeText('qq77', {
      keySettleMs: 0,
      confirmationTimeoutMs: 0,
      confirm,
    });
    if (expected) await expect(typing).rejects.toThrow(expected);
    else {
      await typing;
      expect(typeCharacter.mock.calls.map(([character]) => character).join('')).toBe('qq77');
      expect(confirm).toHaveBeenCalled();
    }
  });
});

it('focuses the body using fresh geometry after the title keyboard changes the layout', async () => {
  let keyboard = false;
  let focused = false;
  describeUiTree.mockImplementation(() => [
    {
      type: 'Application',
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        { type: 'Button', AXLabel: 'BackButton', frame: { x: 0, y: 0, width: 40, height: 40 } },
        {
          type: 'TextField',
          AXValue: 'Note',
          frame: { x: 0, y: keyboard ? 20 : 100, width: 200, height: 40 },
        },
        {
          type: 'TextArea',
          AXLabel: 'body',
          frame: { x: 0, y: keyboard ? 60 : 150, width: 402, height: 400 },
        },
        ...(keyboard
          ? [{ type: 'Button', AXLabel: 'done', frame: { x: 0, y: 500, width: 40, height: 40 } }]
          : []),
        ...(focused
          ? [{ type: 'Button', AXLabel: 'Bold', frame: { x: 0, y: 450, width: 40, height: 40 } }]
          : []),
      ],
    },
  ]);
  tapPoint.mockImplementation(() => {
    keyboard = true;
  });
  touchPoint.mockImplementation(() => {
    focused = true;
  });
  await createIosDevice({ udid: 'claimed' }).focusEditorBody();
  expect(touchPoint).toHaveBeenCalledWith(36, 96);
});
