// Disconnect a booted simulator's hardware keyboard so iOS presents the software one.
//
// Every boot, CoreSimulator attaches a built-in US-layout hardware keyboard, and
// while it is attached iOS never presents the software keyboard: its keys stay
// in the accessibility tree parked below the screen ("done" at y=1121 on an
// 874pt iPhone 17 Pro). Simulator.app used to detach it from its per-device
// `ConnectHardwareKeyboard` preference when it attached a window; Xcode 27 ships
// no Simulator.app, and headless QA never attaches a window, so nothing did.
//
// This makes the same call through SimDevice's private
// `setHardwareKeyboardEnabled:keyboardType:error:` (JXA, so nothing is built).
// Measured on iOS 26.5: afterwards the software keyboard presents, and `axe type`
// still types (iOS re-hides the software keyboard after the first key, which
// leaves focus where it was). The keyboard re-attaches on the next boot, so call
// this after EVERY boot; CoreSimulator crashes on a device that is not booted.

import { execFileSync } from 'node:child_process';

const DISCONNECT_HARDWARE_KEYBOARD_JXA = `
ObjC.import('Foundation');
function run([udid, developerDir]) {
  $.NSBundle.bundleWithPath('/Library/Developer/PrivateFrameworks/CoreSimulator.framework').load;
  const context = $.NSClassFromString('SimServiceContext')
    .sharedServiceContextForDeveloperDirError(developerDir, null);
  const device = context.defaultDeviceSetWithError(null).devicesByUDID
    .objectForKey($.NSUUID.alloc.initWithUUIDString(udid));
  if (!device || device.isNil()) throw new Error('no simulator ' + udid);
  const error = Ref();
  if (!device.setHardwareKeyboardEnabledKeyboardTypeError(false, 0, error)) {
    throw new Error(ObjC.unwrap(error[0].localizedDescription));
  }
}
`;

/** Booted devices only. Throws when CoreSimulator refuses, so no caller runs on a hidden keyboard. */
export function disconnectHardwareKeyboard(udid) {
  const developerDir = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
  execFileSync(
    'osascript',
    ['-l', 'JavaScript', '-e', DISCONNECT_HARDWARE_KEYBOARD_JXA, udid, developerDir],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}
