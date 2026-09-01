/**
 * What a link tap or click was, as the shell needs to hear it.
 *
 * Engine-neutral on purpose: the editor decides that a link was activated, and
 * the shell decides where that goes (same tab, new tab, external browser).
 * Only the modifier state and the button travel between them.
 */
export interface EditorLinkGesture {
  readonly button: 0 | 1;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}
