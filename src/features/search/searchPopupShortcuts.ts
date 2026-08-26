import { isMac } from '$lib/platform';

type ModifierChord = Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>;

export function isSearchPopupFindShortcut(event: ModifierChord, applePlatform = isMac): boolean {
  if (event.altKey) return false;
  const primaryModifier = applePlatform ? event.metaKey : event.ctrlKey;
  if (!primaryModifier) return false;

  const key = event.key.toLowerCase();
  return (key === 'f' && !event.shiftKey) || key === 'g';
}
