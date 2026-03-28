import { describe, it, expect, vi } from 'vitest';
import { parseJsonBody, errorMessage, validatePassword } from '../../src/routes/helpers.js';

// ---------- parseJsonBody ----------

describe('parseJsonBody', () => {
  it('returns parsed JSON on valid body', async () => {
    const body = { foo: 'bar', n: 42 };
    const c = {
      req: { json: vi.fn().mockResolvedValue(body) },
      json: vi.fn(),
    } as unknown as Parameters<typeof parseJsonBody>[0];

    const result = await parseJsonBody(c);
    expect(result).toEqual(body);
    expect(c.json).not.toHaveBeenCalled();
  });

  it('returns a 400 Response on invalid JSON', async () => {
    const fakeResponse = new Response('', { status: 400 });
    const c = {
      req: { json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')) },
      json: vi.fn().mockReturnValue(fakeResponse),
    } as unknown as Parameters<typeof parseJsonBody>[0];

    const result = await parseJsonBody(c);
    expect(result).toBeInstanceOf(Response);
    expect(c.json).toHaveBeenCalledWith({ error: 'Invalid JSON' }, 400);
  });
});

// ---------- errorMessage ----------

describe('errorMessage', () => {
  it('extracts message from Error instance', () => {
    expect(errorMessage(new Error('something broke'))).toBe('something broke');
  });

  it('converts string to itself', () => {
    expect(errorMessage('plain string')).toBe('plain string');
  });

  it('converts number to string', () => {
    expect(errorMessage(42)).toBe('42');
  });

  it('converts null to string', () => {
    expect(errorMessage(null)).toBe('null');
  });

  it('converts undefined to string', () => {
    expect(errorMessage(undefined)).toBe('undefined');
  });
});

// ---------- validatePassword ----------

describe('validatePassword', () => {
  it('returns error for missing (undefined) password', () => {
    const result = validatePassword(undefined);
    expect(result).toEqual({ error: 'Missing required field: password', status: 400 });
  });

  it('returns error for empty string password', () => {
    const result = validatePassword('');
    expect(result).toEqual({ error: 'Missing required field: password', status: 400 });
  });

  it('returns error for non-string password', () => {
    const result = validatePassword(123);
    expect(result).toEqual({ error: 'Missing required field: password', status: 400 });
  });

  it('returns error for too-short password', () => {
    const result = validatePassword('short');
    expect(result).toEqual({ error: 'Password must be at least 8 characters', status: 422 });
  });

  it('returns error for too-long password', () => {
    const result = validatePassword('a'.repeat(257));
    expect(result).toEqual({ error: 'Password must not exceed 256 characters', status: 422 });
  });

  it('returns null for valid password', () => {
    expect(validatePassword('securepass123')).toBeNull();
  });

  it('returns null for exactly 8 character password', () => {
    expect(validatePassword('12345678')).toBeNull();
  });

  it('uses custom fieldName in missing-field error', () => {
    const result = validatePassword(undefined, 'new_password', 'New password');
    expect(result).toEqual({ error: 'Missing required field: new_password', status: 400 });
  });

  it('uses custom label in min-length error', () => {
    const result = validatePassword('short', 'new_password', 'New password');
    expect(result).toEqual({ error: 'New password must be at least 8 characters', status: 422 });
  });

  it('uses custom label in max-length error', () => {
    const result = validatePassword('a'.repeat(257), 'new_password', 'New password');
    expect(result).toEqual({ error: 'New password must not exceed 256 characters', status: 422 });
  });

  it('skips min-length check with skipMinLength', () => {
    expect(validatePassword('ab', 'password', 'Password', { skipMinLength: true })).toBeNull();
  });

  it('still checks max-length with skipMinLength', () => {
    const result = validatePassword('a'.repeat(257), 'password', 'Password', { skipMinLength: true });
    expect(result).toEqual({ error: 'Password must not exceed 256 characters', status: 422 });
  });

  it('still checks presence with skipMinLength', () => {
    const result = validatePassword('', 'password', 'Password', { skipMinLength: true });
    expect(result).toEqual({ error: 'Missing required field: password', status: 400 });
  });

  it('skips max-length check with skipMaxLength (presence-only)', () => {
    expect(validatePassword('x', 'current_password', 'Current password', { skipMinLength: true, skipMaxLength: true })).toBeNull();
  });
});
