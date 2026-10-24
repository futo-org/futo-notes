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
  it('finishes a marker after AXe translation errors when the disk oracle proves it landed', async () => {
    typeCharacter.mockImplementationOnce(() => {
      throw new Error('No translation object');
    });
    const confirm = vi.fn(() => true);
    await createIosDevice({ udid: 'claimed' }).typeText('qq77', { keySettleMs: 0, confirm });
    expect(typeCharacter.mock.calls.map(([character]) => character).join('')).toBe('qq77');
    expect(confirm).toHaveBeenCalled();
  });

  it('never turns an unconfirmed translation error into successful input', async () => {
    typeCharacter.mockImplementation(() => {
      throw new Error('No translation object');
    });
    await expect(createIosDevice({ udid: 'claimed' }).typeText('q')).rejects.toThrow(
      'No translation object',
    );
  });

  it('preserves unrelated input errors even with an oracle', async () => {
    typeCharacter.mockImplementation(() => {
      throw new Error('simulator disconnected');
    });
    await expect(
      createIosDevice({ udid: 'claimed' }).typeText('q', { confirm: () => true }),
    ).rejects.toThrow('simulator disconnected');
  });

  it('fails when the oracle never observes the input', async () => {
    const device = createIosDevice({ udid: 'claimed' });
    await expect(
      device.typeText('q', { confirm: () => false, confirmationTimeoutMs: 0 }),
    ).rejects.toThrow('waiting for the typed text to be observed');
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
