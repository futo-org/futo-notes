import type { Context } from 'hono';
import { MAX_PASSWORD_LENGTH } from '../auth/password.js';

/** Parse JSON body, returning parsed value or a 400 Response on failure. */
export async function parseJsonBody<T = unknown>(c: Context): Promise<T | Response> {
  try {
    return await c.req.json() as T;
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
}

/** Extract a string message from an unknown error value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Validate a password field. Returns null if valid, or {error, status} if invalid.
 *
 * @param password - The value to validate
 * @param fieldName - Used in "Missing required field: <fieldName>" error
 * @param label - Human-readable label for min/max messages (e.g. "Password", "New password")
 * @param opts.skipMinLength - Skip the 8-char minimum check (e.g. for login)
 * @param opts.skipMaxLength - Skip the max-length check (for presence-only validation)
 */
export function validatePassword(
  password: unknown,
  fieldName = 'password',
  label = 'Password',
  opts?: { skipMinLength?: boolean; skipMaxLength?: boolean },
): { error: string; status: 400 | 422 } | null {
  if (!password || typeof password !== 'string') {
    return { error: `Missing required field: ${fieldName}`, status: 400 };
  }
  if (!opts?.skipMinLength && password.length < 8) {
    return { error: `${label} must be at least 8 characters`, status: 422 };
  }
  if (!opts?.skipMaxLength && password.length > MAX_PASSWORD_LENGTH) {
    return { error: `${label} must not exceed ${MAX_PASSWORD_LENGTH} characters`, status: 422 };
  }
  return null;
}
