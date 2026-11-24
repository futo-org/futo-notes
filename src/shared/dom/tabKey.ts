/** The Tab key, Shift held or not. WebKitGTK names Shift+Tab (GTK's ISO_Left_Tab)
 *  "Unidentified", its code still Tab. An input method's keys are its own: while one
 *  composes, Chromium names the key "Process" with the same code. */
export function isTabKey(event: KeyboardEvent): boolean {
  return !event.isComposing && (event.key === 'Tab' || event.code === 'Tab');
}
