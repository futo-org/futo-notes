// A Back key can be ignored by gesture navigation. Drive the active navigation
// mode, and fail if the device cannot report it rather than claim a false tap.
export function readDisplaySize(adb) {
  const match = [...adb.shell('wm size').matchAll(/(\d+)x(\d+)/g)].at(-1);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) {
    throw new Error('cannot read Android display size; refusing coordinate input');
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

// Resolve potentially slow metadata before a timed input sequence starts.
export function prepareBack(adb, { durationMs = 180 } = {}) {
  let mode = adb.shell('settings get secure navigation_mode', { allowFailure: true }).trim();
  if (!['0', '1', '2'].includes(mode)) {
    mode = adb
      .shell('cmd overlay lookup android android:integer/config_navBarInteractionMode', {
        allowFailure: true,
      })
      .trim();
  }
  if (mode === '2') {
    const { width, height } = readDisplaySize(adb);
    const span = Math.min(width, height);
    const y = Math.round(span / 2);
    return () => adb.swipe(2, y, Math.round(span * 0.7), y, durationMs);
  } else if (mode === '0' || mode === '1') {
    return () => adb.keyevent(4);
  } else {
    throw new Error('cannot determine Android navigation mode; refusing an unverified Back key');
  }
}

export const navigateBack = (adb) => prepareBack(adb)();
