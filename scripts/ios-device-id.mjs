#!/usr/bin/env node
// Print the CoreDevice identifier (UUID) of the first connected physical iOS
// device — the value `xcrun devicectl device install/launch` wants. Exits 1
// with a message on stderr when no device is connected.
//
// Single source of the device-detection logic that used to be copy-pasted as
// an inline python3 block across several justfile recipes + apps/ios scripts.
// Consumed by `just deploy-ios` and apps/ios/run-device.sh.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  let data = {};
  try {
    data = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    /* leave data empty → no device */
  }

  const devices = data?.result?.devices ?? [];
  // A physical device has a transportType (wired/wireless); simulators don't.
  const connected = devices.find((d) => d?.connectionProperties?.transportType);
  const id = connected?.identifier;

  if (!id) {
    console.error('No connected iPhone found. Plug one in (and trust this Mac), then retry.');
    process.exit(1);
  }
  process.stdout.write(id);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
