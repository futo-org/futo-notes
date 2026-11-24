/** The message of a thrown value: an `Error`'s `message`, an object's `message` (the
 *  editor host's commands reject with `{kind, message}`), anything else stringified. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}
