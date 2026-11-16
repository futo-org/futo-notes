import { describe, expect, it } from 'vitest';

import { selectPhysicalDevice } from './ios-device-id.mjs';

// Shapes from a live `devicectl list devices --json-output` (Xcode 27.2):
// lastConnectionDate is CFAbsoluteTime seconds.
const device = (identifier, name, state, lastConnectionDate) => ({
  identifier,
  properties: {
    hardware: { reality: 'physical', udid: `udid-${identifier}` },
    state: { name },
    connection: { state, lastConnectionDate, transportType: 'localNetwork' },
  },
});
const simulator = {
  identifier: 'sim',
  properties: {
    hardware: { reality: 'simulated' },
    state: { name: 'iPhone 17 Pro' },
    connection: { state: 'connected', transportType: 'sameMachine' },
  },
};

// 2026-11-16: an out-of-reach iPad listed first won over the phone on the desk,
// and the install died with CoreDeviceError 4016.
const ipad = device('ipad', 'Justin’s iPad', 'unavailable', 816_344_520);
const oldPhone = device('old', 'Mason’s iPhone', 'disconnected', 816_294_300);
const phone = device('phone', 'aha', 'disconnected', 816_555_840);

describe('selectPhysicalDevice', () => {
  it('skips unreachable devices and prefers the most recently connected', () => {
    const picked = selectPhysicalDevice([simulator, ipad, oldPhone, phone]);
    expect(picked).toMatchObject({ status: 'ok', id: 'phone', name: 'aha' });
    expect(picked.others.map((d) => d.id)).toEqual(['ipad', 'old']);
  });

  it('prefers a live tunnel over a more recent connection', () => {
    const live = device('live', 'live', 'connected', 1);
    expect(selectPhysicalDevice([phone, live]).id).toBe('live');
  });

  it('reports none when every physical device is unavailable', () => {
    expect(selectPhysicalDevice([simulator, ipad])).toMatchObject({ status: 'none' });
  });

  it('honours an explicit choice by name, typed apostrophe included, or UDID', () => {
    expect(selectPhysicalDevice([ipad, phone], "justin's ipad").id).toBe('ipad');
    expect(selectPhysicalDevice([ipad, phone], 'udid-phone').id).toBe('phone');
    expect(selectPhysicalDevice([ipad, phone], 'nope').status).toBe('nomatch');
  });
});
