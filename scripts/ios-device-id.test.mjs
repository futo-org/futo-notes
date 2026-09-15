import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { selectPhysicalDevice } from './ios-device-id.mjs';

// Hand-built fixtures mirror `xcrun devicectl list devices --json-output` on
// Xcode 27, which gives every simulator a `connectionProperties.transportType`
// of "sameMachine" — the field the old code used, alone, to decide "physical".

function device({ name, id, transportType, tunnelState }) {
  return {
    identifier: id,
    deviceProperties: { name },
    connectionProperties: { transportType, tunnelState },
  };
}

const simulator = (name, id, tunnelState = 'disconnected') =>
  device({ name, id, transportType: 'sameMachine', tunnelState });

const physical = (name, id, tunnelState, transportType = 'wired') =>
  device({ name, id, transportType, tunnelState });

describe('selectPhysicalDevice', () => {
  it('reports none when only simulators are attached', () => {
    const devices = [
      simulator('iPhone 17 Pro', 'sim-1', 'connected'),
      simulator('iPhone 17', 'sim-2'),
    ];
    expect(selectPhysicalDevice(devices)).toEqual({ status: 'none' });
  });

  it('reports none when there are no devices at all', () => {
    expect(selectPhysicalDevice([])).toEqual({ status: 'none' });
    expect(selectPhysicalDevice(undefined)).toEqual({ status: 'none' });
  });

  // A live dump proved tunnelState "disconnected" does NOT mean unreachable
  // for a localNetwork device: `devicectl device install`/`process launch`
  // against exactly this phone worked while it reported disconnected — the
  // tunnel comes up lazily, on demand. So the picker still returns it, just
  // flagged as not-yet-connected; only "no physical device at all" is a
  // hard failure.
  it('returns the only physical device even when its tunnel is disconnected', () => {
    const devices = [physical('iPhone', 'phone-1', 'disconnected', 'localNetwork')];
    expect(selectPhysicalDevice(devices)).toEqual({
      status: 'ok',
      id: 'phone-1',
      name: 'iPhone',
      connected: false,
      transportType: 'localNetwork',
    });
  });

  it('returns a connected physical device', () => {
    const devices = [physical('iPhone', 'phone-1', 'connected', 'wired')];
    expect(selectPhysicalDevice(devices)).toEqual({
      status: 'ok',
      id: 'phone-1',
      name: 'iPhone',
      connected: true,
      transportType: 'wired',
    });
  });

  // The exact regression: a booted, "connected" simulator sitting alongside a
  // disconnected physical phone. The old code's `find` on any transportType
  // picked whichever came first — here, or in production, the simulator —
  // and handed its identifier to `devicectl device install`, which then failed
  // with "com.apple.dt.CoreDeviceError error 1001" instead of a clear message.
  it('never selects a connected simulator over a disconnected physical phone', () => {
    const devices = [
      simulator('iPhone 17 Pro', 'sim-connected', 'connected'),
      physical('iPhone', 'phone-1', 'disconnected', 'localNetwork'),
    ];
    expect(selectPhysicalDevice(devices)).toEqual({
      status: 'ok',
      id: 'phone-1',
      name: 'iPhone',
      connected: false,
      transportType: 'localNetwork',
    });
  });

  it('picks the connected physical device among several physical devices', () => {
    const devices = [
      physical('iPhone SE', 'phone-old', 'disconnected', 'wired'),
      physical('iPhone', 'phone-live', 'connected', 'localNetwork'),
    ];
    expect(selectPhysicalDevice(devices)).toEqual({
      status: 'ok',
      id: 'phone-live',
      name: 'iPhone',
      connected: true,
      transportType: 'localNetwork',
    });
  });

  // The one fixture that is known-true field-for-field: a real
  // `xcrun devicectl list devices --json-output` dump (14 devices: 13
  // simulators plus one real, disconnected iPhone, with an unrelated
  // simulator showing tunnelState "connected" right next to it) — exactly
  // the trap that broke the original picker.
  describe('against a real devicectl dump', () => {
    const fixturePath = fileURLToPath(
      new URL('./__fixtures__/ios-devicectl-list-devices.json', import.meta.url),
    );
    const realDevices = JSON.parse(readFileSync(fixturePath, 'utf8')).result.devices;

    it('has the expected shape (guards against a stale fixture)', () => {
      expect(realDevices.length).toBe(14);
    });

    it('selects the real iPhone, not the connected simulator beside it', () => {
      expect(selectPhysicalDevice(realDevices)).toEqual({
        status: 'ok',
        id: '2BB42BEE-9208-57F6-9423-35E4C1F97F46',
        name: 'iPhone',
        connected: false,
        transportType: 'localNetwork',
      });
    });
  });
});
