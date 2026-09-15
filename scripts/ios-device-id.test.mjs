import { describe, expect, it } from 'vitest';

import { selectPhysicalDevice } from './ios-device-id.mjs';

// Fixtures mirror `xcrun devicectl list devices --json-output` on Xcode 27,
// which gives every simulator a `connectionProperties.transportType` of
// "sameMachine" — the field the old code used, alone, to decide "physical".

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

  it('fails with the device name when the only physical device is disconnected', () => {
    const devices = [physical('iPhone', 'phone-1', 'disconnected', 'localNetwork')];
    expect(selectPhysicalDevice(devices)).toEqual({
      status: 'disconnected',
      names: ['iPhone'],
    });
  });

  it('returns a connected physical device', () => {
    const devices = [physical('iPhone', 'phone-1', 'connected', 'wired')];
    expect(selectPhysicalDevice(devices)).toEqual({
      status: 'ok',
      id: 'phone-1',
      name: 'iPhone',
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
      status: 'disconnected',
      names: ['iPhone'],
    });
  });

  // Full real-world fixture from the affected Mac (`xcrun devicectl list
  // devices --json-output`): six devices, only one of them physical, and that
  // one disconnected while an unrelated simulator shows tunnelState connected.
  it('reproduces the real-machine dump: one disconnected phone among five simulators', () => {
    const devices = [
      simulator('futo-qa-6', 'sim-a', 'disconnected'),
      simulator('iPad Pro 13-inch(M5)', 'sim-b', 'disconnected'),
      physical('iPhone', 'phone-real', 'disconnected', 'localNetwork'),
      simulator('iPhone 17', 'sim-c', 'disconnected'),
      simulator('iPhone 17 Pro', 'sim-d', 'connected'),
      simulator('iPhone 17 Pro Max', 'sim-e', 'disconnected'),
    ];
    expect(selectPhysicalDevice(devices)).toEqual({
      status: 'disconnected',
      names: ['iPhone'],
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
    });
  });
});
