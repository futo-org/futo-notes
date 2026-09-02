import { desktopLocalization } from './desktopLocalization.svelte';
import type { LocalizationArguments } from './localization';

export interface LocalizedMessage {
  readonly path: string;
  readonly arguments?: LocalizationArguments;
}

export { createDesktopLocalization, desktopLocalization } from './desktopLocalization.svelte';

export const localizedText = desktopLocalization.localizedText;
export const localizedFileSize = desktopLocalization.localizedFileSize;
export const localizedRelativeTime = desktopLocalization.localizedRelativeTime;

export function resolveLocalizedMessage(message: LocalizedMessage): string {
  return desktopLocalization.localizedText(message.path, message.arguments);
}

export type { Language, LocalizationArguments } from './localization';
export type {
  DesktopLocalization,
  DesktopLocalizationDependencies,
} from './desktopLocalization.svelte';
