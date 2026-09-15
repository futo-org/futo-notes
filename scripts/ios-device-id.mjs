#!/usr/bin/env node
// Print the CoreDevice identifier (UUID) of a physical iOS device — the value
// `xcrun devicectl device install/launch` wants. Exits 1 with a message on
// stderr when there is no physical device at all.
//
// Single source of the device-detection logic that used to be copy-pasted as
// an inline python3 block across several justfile recipes + apps/ios scripts.
// Consumed by `just deploy-ios` and apps/ios/run-device.sh.
//
// Every device in a live `devicectl list devices --json-output` dump
// (scripts/__fixtures__/ios-devicectl-list-devices.json) carries this once:
//
//   "_deprecationNotice": {
//     "deprecatedFields": ["hardwareProperties", "deviceProperties", "connectionProperties"],
//     "message": "The 'hardwareProperties', 'deviceProperties', 'connectionProperties' fields
//                 are deprecated and will be removed in a future release. Use the
//                 'properties' dictionary instead."
//   }
//
// So this reads the newer `properties` dict FIRST and only falls back to the
// deprecated trio when `properties` is absent (an older Xcode/devicectl) —
// that fallback is deliberate, not redundant; do not delete it before the
// deprecated fields are actually gone.
//
// `properties.hardware.reality` ("physical" | "simulated") is the direct
// physical/simulator discriminator devicectl actually offers on this newer
// path. The deprecated path has no such flag (it is null on both physical and
// simulated entries there), so the fallback instead infers it from
// `connectionProperties.transportType`: a simulator always reports
// "sameMachine" (it runs on this Mac); a real device reports "wired" or
// "localNetwork" — this is a real discriminator, unlike merely checking that
// transportType is present, which Xcode 27 gives every simulator too (that gap
// is what let a booted simulator get selected as the install target).
// Confirmed against the live dump: the one real iPhone there has
// reality "physical" / transportType "localNetwork"; every simulator has
// reality "simulated" / transportType "sameMachine" — including one showing
// connection.state "connected" sitting right next to the disconnected phone.
//
// Neither path's "connected" flag means "reachable" for a physical device:
// that same live dump's iPhone read connection.state "disconnected" while
// `devicectl device install`/`process launch` against it worked immediately —
// for a localNetwork device the tunnel comes up lazily, on demand. So a
// disconnected physical device is still returned; connectedness is only used
// to prefer one physical device over another when several are present, and to
// decide whether to print a heads-up note.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SIMULATOR_TRANSPORT = 'sameMachine';

function isPhysicalDevice(device) {
  const reality = device?.properties?.hardware?.reality;
  if (reality) return reality === 'physical';

  const transportType = device?.connectionProperties?.transportType;
  return Boolean(transportType) && transportType !== SIMULATOR_TRANSPORT;
}

function isConnected(device) {
  const state = device?.properties?.connection?.state;
  if (state) return state === 'connected';

  return device?.connectionProperties?.tunnelState === 'connected';
}

function transportTypeOf(device) {
  return (
    device?.properties?.connection?.transportType ??
    device?.connectionProperties?.transportType ??
    'unknown'
  );
}

function deviceName(device) {
  return (
    device?.properties?.state?.name ||
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
    transportType: transportTypeOf(chosen),
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
