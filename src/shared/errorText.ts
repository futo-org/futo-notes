/** The message of a thrown value: an `Error`'s `message`, anything else stringified. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
