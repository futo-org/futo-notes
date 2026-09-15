#!/usr/bin/env node
// Print the CoreDevice identifier (UUID) of a connected physical iOS device —
// the value `xcrun devicectl device install/launch` wants. Exits 1 with a
// message on stderr when there is no reachable physical device.
//
// Single source of the device-detection logic that used to be copy-pasted as
// an inline python3 block across several justfile recipes + apps/ios scripts.
// Consumed by `just deploy-ios` and apps/ios/run-device.sh.
//
// devicectl's JSON has no `isSimulated` flag (checked on real output: it is
// null on both physical and simulated entries), so physical-vs-simulator is
// inferred from `connectionProperties.transportType`: a simulator always
// reports "sameMachine" (it runs on this Mac); a real device reports "wired"
// or "localNetwork". This is a real discriminator, unlike merely checking that
// transportType is present — Xcode 27 gives every simulator a transportType
// too, which is what let a booted simulator get selected as the install
// target. `connectionProperties.tunnelState` ("connected" | "disconnected")
// then says whether devicectl can actually reach that physical device right
// now — a paired-but-disconnected phone must not be handed back either, since
// `devicectl device install` on it fails with a misleading
// "com.apple.dt.CoreDeviceError error 1001" that reads like a device fault
// instead of "plug it in".
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SIMULATOR_TRANSPORT = 'sameMachine';

function isPhysicalDevice(device) {
  const transportType = device?.connectionProperties?.transportType;
  return Boolean(transportType) && transportType !== SIMULATOR_TRANSPORT;
}

function isConnected(device) {
  return device?.connectionProperties?.tunnelState === 'connected';
}

function deviceName(device) {
  return (
    device?.deviceProperties?.name ||
    device?.hardwareProperties?.udid ||
    device?.identifier ||
    '<unknown device>'
  );
}

// Pure selection over the parsed `result.devices` array from
// `xcrun devicectl list devices --json-output`. Must never return a
// simulator, whatever its tunnelState (see the transportType note above).
//
//   status 'ok'           - a connected physical device: use `id`.
//   status 'disconnected' - physical device(s) exist but devicectl can't
//                           reach any of them right now; the caller must fail
//                           loudly and name them, never hand back an
//                           identifier devicectl cannot install to.
//   status 'none'         - no physical device at all.
export function selectPhysicalDevice(devices) {
  const physical = (devices ?? []).filter(isPhysicalDevice);
  if (physical.length === 0) return { status: 'none' };

  const connected = physical.find(isConnected);
  if (connected) {
    return { status: 'ok', id: connected.identifier, name: deviceName(connected) };
  }

  return { status: 'disconnected', names: physical.map(deviceName) };
}

function listDevices() {
  const dir = mkdtempSync(join(tmpdir(), 'futo-ios-dev-'));
  const out = join(dir, 'devices.json');
  try {
    // devicectl can exit non-zero when nothing is attached; ignore and parse
    // whatever JSON it managed to write.
    try {
      execFileSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', out], {
        stdio: 'ignore',
      });
    } catch {
      /* fall through to parse */
    }

    try {
      const data = JSON.parse(readFileSync(out, 'utf8'));
      return data?.result?.devices ?? [];
    } catch {
      return []; // leave devices empty -> no device
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const result = selectPhysicalDevice(listDevices());

  if (result.status === 'ok') {
    process.stdout.write(result.id);
    return;
  }

  if (result.status === 'disconnected') {
    const isSingle = result.names.length === 1;
    console.error(
      `Found ${isSingle ? 'a physical device' : `${result.names.length} physical devices`} ` +
        `(${result.names.join(', ')}) but devicectl cannot reach ${isSingle ? 'it' : 'any of them'} ` +
        'right now. Plug it in with a cable (or make sure it is on the same network), unlock it, ' +
        'and tap "Trust This Computer" if prompted, then retry.',
    );
    process.exit(1);
  }

  console.error('No connected iPhone found. Plug one in (and trust this Mac), then retry.');
  process.exit(1);
}

// Run only when invoked directly so the test can import the pure selector.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
