/**
 * Every setting the desktop app persists, as stored: the whole `.app-state.json` and every
 * localStorage key, under their own names. Nothing is picked, so a setting nobody thought to
 * report still shows in a receipt when an action changes it (futo-puppet diffs `state` around
 * every action). A secret shows only whether it is set.
 */
const SECRETS = new Set(['e2eeAuthToken', 'e2eeSalt']);

export function storedSettings(appState: object): Record<string, unknown> {
  const stored: Record<string, unknown> = {};
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key !== null) stored[key] = parsed(localStorage.getItem(key));
  }
  return {
    appState: Object.fromEntries(
      Object.entries(appState).map(([key, value]) => [
        key,
        SECRETS.has(key) ? (value ? 'set' : null) : value,
      ]),
    ),
    localStorage: stored,
  };
}

/** localStorage holds strings; one that is JSON reads as what it encodes. */
function parsed(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
