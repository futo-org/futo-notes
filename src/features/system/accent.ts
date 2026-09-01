import { onLinuxAccentChanged, readLinuxDesktopSettings, type SystemAccent } from '$lib/platform';

const ACCENT_PROPERTIES = [
  '--color-primary',
  '--color-primary-hover',
  '--primary-rgb',
  '--color-selection',
] as const;

let followSystemAccent = false;

export function applySystemAccent(
  accent: SystemAccent | null,
  root: HTMLElement = document.documentElement,
): void {
  if (accent === null) {
    for (const property of ACCENT_PROPERTIES) root.style.removeProperty(property);
    return;
  }

  const channels = [accent.r, accent.g, accent.b].map((channel) =>
    Math.round(Math.min(1, Math.max(0, channel)) * 255),
  );
  const color = `rgb(${channels.join(' ')})`;

  root.style.setProperty('--color-primary', color);
  // --color-text is dark in the light theme and light in the dark theme, so
  // the same expression derives the correct hover direction in both modes.
  root.style.setProperty(
    '--color-primary-hover',
    `color-mix(in srgb, ${color} 82%, var(--color-text))`,
  );
  root.style.setProperty('--primary-rgb', channels.join(', '));
  root.style.setProperty('--color-selection', `color-mix(in srgb, ${color} 24%, transparent)`);
}

export function watchSystemAccentTauri(onChange = applySystemAccent): () => void {
  return onLinuxAccentChanged((accent) => {
    if (followSystemAccent) onChange(accent);
  });
}

export function applySystemAccentPreference(
  follow: boolean,
  onChange: (accent: SystemAccent | null) => void = applySystemAccent,
): void {
  followSystemAccent = follow;
  if (!follow) {
    onChange(null);
    return;
  }

  void readLinuxDesktopSettings()
    .then((settings) => {
      if (followSystemAccent) onChange(settings?.accent ?? null);
    })
    .catch((error) => console.warn('Failed to read the current Linux desktop accent:', error));
}
