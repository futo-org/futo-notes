/** Call `onChange` once each time `element` itself takes or loses focus: on `focus` and `blur`,
 *  and on `focusin` and `focusout` when those come alone. WebKitGTK sends no `focus` or `blur`
 *  while its page lacks focus (a window never activated); where it sends them, WebKit sends
 *  `focusin` and `focusout` after them, so those then change nothing. Returns the remover. */
export function listenForFocusChange(
  element: HTMLElement,
  onChange: (focused: boolean, event: FocusEvent) => void,
): () => void {
  let focusEventSent = false;
  const focusEvent = (event: FocusEvent): void => {
    focusEventSent = true;
    onChange(event.type === 'focus', event);
  };
  const focusEventMissed = (event: FocusEvent): void => {
    if (event.target !== element) return;
    if (focusEventSent) {
      focusEventSent = false;
      return;
    }
    onChange(event.type === 'focusin', event);
  };
  element.addEventListener('focus', focusEvent);
  element.addEventListener('blur', focusEvent);
  element.addEventListener('focusin', focusEventMissed);
  element.addEventListener('focusout', focusEventMissed);
  return () => {
    element.removeEventListener('focus', focusEvent);
    element.removeEventListener('blur', focusEvent);
    element.removeEventListener('focusin', focusEventMissed);
    element.removeEventListener('focusout', focusEventMissed);
  };
}
