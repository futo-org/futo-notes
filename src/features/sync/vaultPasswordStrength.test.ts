import { describe, expect, it } from 'vitest';

import { vaultPasswordStrength } from './vaultPasswordStrength';

const MINIMUM = 12;

describe('vaultPasswordStrength', () => {
  it('calls anything under the minimum too short, however varied', () => {
    expect(vaultPasswordStrength('aB3$aB3$aB', MINIMUM)).toBe('tooShort');
    expect(vaultPasswordStrength('', MINIMUM)).toBe('tooShort');
  });

  it('measures the minimum in characters, not UTF-16 units', () => {
    // Twelve emoji are twelve characters, even though `.length` says 24.
    expect(vaultPasswordStrength('🙂'.repeat(12), MINIMUM)).not.toBe('tooShort');
    expect(vaultPasswordStrength('🙂'.repeat(11), MINIMUM)).toBe('tooShort');
  });

  it('refuses to call a long repeated character anything but weak', () => {
    // The trap this exists for: long enough to pass the minimum, worthless.
    expect(vaultPasswordStrength('aaaaaaaaaaaaaaaa', MINIMUM)).toBe('weak');
    expect(vaultPasswordStrength('abababababababab', MINIMUM)).toBe('weak');
  });

  it('rates a long, varied password strong', () => {
    expect(vaultPasswordStrength('Tr0ubadour&Horse!', MINIMUM)).toBe('strong');
    expect(vaultPasswordStrength('correct horse battery staple', MINIMUM)).toBe('strong');
  });

  it('rates a bare-minimum single-case password in between', () => {
    expect(vaultPasswordStrength('rhubarbcrumb', MINIMUM)).toBe('fair');
  });

  it('never rates anything below the minimum, even a very strong one', () => {
    expect(vaultPasswordStrength('Tr0ub4&or', MINIMUM)).toBe('tooShort');
  });
});
