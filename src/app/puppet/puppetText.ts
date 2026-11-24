// What the text verbs and reads share: the lines a person sees, and a range of the note.
// A place is acted on only while it is on screen, as a person acts on it: a refusal says how
// to bring it there.
import type { PuppetParams } from './puppetRegistry';

/** Lines `first`–`last`, numbered as `doc` numbers them, show on screen, wholly or in part. */
export interface OnScreen {
  first: number;
  last: number;
}

export interface Range {
  from: number;
  to: number;
}

/** "lines 12–40 show": what is on screen, for a refusal. */
export function whatShows(onScreen: OnScreen | null): string {
  return onScreen ? `lines ${onScreen.first}–${onScreen.last} show` : 'no line of the note shows';
}

/** Whether line `number` is one of the lines on screen. */
export function showsLine(onScreen: OnScreen | null, number: number): boolean {
  return onScreen !== null && number >= onScreen.first && number <= onScreen.last;
}

export const TEXT_PARAMS: PuppetParams = { text: 'string' };
