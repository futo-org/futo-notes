// Feed a PNG to the camera of one explicitly claimed QA emulator. The process
// restart changes runtime camera flags only; the AVD config and app data remain.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assertAndroidTarget, assertAndroidClaim } from './android-target.mjs';
import { ensureAvd, runningEmus } from './android-emulators.mjs';
import { EMULATOR, sleep, tryRun } from './pool.mjs';

async function validatePoster(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`poster file does not exist: ${file}`);
  }
  const { default: sharp } = await import('sharp');
  try {
    const image = sharp(file, { limitInputPixels: 4096 * 4096, failOn: 'warning' });
    if ((await image.metadata()).format !== 'png') throw new Error('not PNG');
    await image.stats(); // Decode before stopping a device, including malformed PNG data.
  } catch (error) {
    throw new Error(`poster must be a decodable PNG up to 4096×4096: ${file}`, { cause: error });
  }
}

function emulatorProcess(name, execFile) {
  const prefix = path.join(path.dirname(EMULATOR), 'qemu') + path.sep;
  const avd = new RegExp(`(?:^|\\s)-avd\\s+${name}(?:\\s|$)`);
  const output = execFile('ps', ['-axww', '-o', 'pid=,command='], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const matches = output
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.+)$/.exec(line))
    .filter((match) => match && match[2].startsWith(prefix) && avd.test(match[2]));
  if (matches.length !== 1)
    throw new Error(`cannot uniquely identify the host process for ${name}`);
  return { pid: matches[0][1], command: matches[0][2].trim() };
}

export async function showCameraPoster(
  posterFile,
  {
    macroPath = path.join(path.dirname(EMULATOR), 'resources/macros/Walk_to_image_room'),
    execFile = execFileSync,
  } = {},
) {
  const poster = path.resolve(posterFile);
  await validatePoster(poster);
  if (!fs.existsSync(macroPath) || !fs.statSync(macroPath).isFile())
    throw new Error(`Android SDK camera-room macro is missing: ${macroPath}`);
  const serial = assertAndroidTarget();
  const name = Object.entries(runningEmus()).find(([, current]) => current === serial)?.[0];
  if (!name)
    throw new Error('camera posters require a claimed QA emulator; run just qa-claim android');
  assertAndroidClaim(name);
  const hostProcess = emulatorProcess(name, execFile);
  assertAndroidTarget({ serial, expectedAvd: name });
  if (tryRun('adb', ['-s', serial, 'emu', 'kill'], { timeout: 5000 }) === null) {
    throw new Error(`could not stop the owned emulator ${name}`);
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    let current = '';
    try {
      current = execFile('ps', ['-p', hostProcess.pid, '-ww', '-o', 'command='], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    if (current !== hostProcess.command) break;
    if (Date.now() >= deadline) throw new Error(`host emulator ${name} did not exit`);
    await sleep(250);
  }
  assertAndroidClaim(name);
  const next = await ensureAvd(name, {
    preserveConfig: true,
    emulatorArgs: [
      '-no-snapshot-load',
      '-camera-back',
      'virtualscene',
      '-virtualscene-poster',
      `wall=${poster}`,
      '-virtualscene-poster',
      `table=${poster}`,
    ],
  });
  assertAndroidTarget({ serial: next, expectedAvd: name });
  const output = tryRun('adb', ['-s', next, 'emu', 'automation', 'play', macroPath], {
    timeout: 10_000,
  });
  if (!output || !/^OK\r?$/m.test(output) || /^KO:/m.test(output))
    throw new Error(`camera-room macro failed on ${name}`);
  return { name, serial: next };
}
