#!/usr/bin/env node
// Print the CoreDevice identifier (UUID) of a physical iOS device — the value
// `xcrun devicectl device install/launch` wants. Exits 1 with a message on
// stderr when there is no physical device at all.
//
// Single source of the device-detection logic that used to be copy-pasted as
// an inline python3 block across several justfile recipes + apps/ios scripts.
// Consumed by `just deploy-ios` and apps/ios/run-device.sh.
//
// devicectl's JSON has no `isSimulated` flag on the (deprecated) top-level
// shape this script parses — it is null on both physical and simulated
// entries there — so physical-vs-simulator is inferred from
// `connectionProperties.transportType`: a simulator always reports
// "sameMachine" (it runs on this Mac); a real device reports "wired" or
// "localNetwork". This is a real discriminator, unlike merely checking that
// transportType is present — Xcode 27 gives every simulator a transportType
// too, which is what let a booted simulator get selected as the install
// target. Confirmed against a live `devicectl list devices --json-output`
// dump (scripts/__fixtures__/ios-devicectl-list-devices.json): every
// simulator there is "sameMachine", the one real iPhone is "localNetwork".
//
// `connectionProperties.tunnelState` ("connected" | "disconnected") does NOT
// mean "reachable" for a physical device: the same live dump's iPhone read
// "disconnected" while `devicectl device install`/`process launch` against it
// worked immediately — for a localNetwork device the tunnel comes up lazily,
// on demand. So a disconnected physical device is still returned; `connected`
// is only used to prefer one physical device over another when several are
// present, and to decide whether to print a heads-up note.
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
//   status 'ok'   - a physical device: use `id`. `connected` says whether its
//                   tunnel was already up (informational only — a
//                   "disconnected" localNetwork device still installs fine).
//   status 'none' - no physical device at all; the caller must fail loudly.
export function selectPhysicalDevice(devices) {
  const physical = (devices ?? []).filter(isPhysicalDevice);
  if (physical.length === 0) return { status: 'none' };

  const chosen = physical.find(isConnected) ?? physical[0];
  return {
    status: 'ok',
    id: chosen.identifier,
    name: deviceName(chosen),
    connected: isConnected(chosen),
    transportType: chosen?.connectionProperties?.transportType ?? 'unknown',
  };
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

  if (result.status === 'none') {
    console.error('No connected iPhone found. Plug one in (and trust this Mac), then retry.');
    process.exit(1);
  }

  // The identifier is the only thing on stdout (callers capture it directly),
  // so anything for a human goes to stderr.
  if (!result.connected) {
    console.error(
      `Selected "${result.name}" (${result.transportType}, tunnel not yet up — ` +
        'devicectl will connect on demand).',
    );
  }
  process.stdout.write(result.id);
}

// Run only when invoked directly so the test can import the pure selector.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
