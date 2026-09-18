import { describe, expect, it } from 'vitest';

import type { LicenseView } from '$lib/platform/license';

import { licenseAmbientLabel, licenseCardModel } from './licenseCopy';

// Mid-year, midday UTC: the *year* these render is the same in every time zone,
// so the assertions below cannot flake on the runner's TZ. Assertions that would
// depend on a calendar day are deliberately structural instead of exact.
const ISSUED = '2026-06-15T12:00:00Z';
const EXPIRES = '2029-06-15T12:00:00Z';

// Eight hyphenated groups of four, from the key alphabet (no I, L, O or 0), in
// the normalized form the Rust crate stores and hands over: trimmed, uppercase.
const KEY = 'AB12-CD34-EF56-GH78-JK9M-NP2Q-RS3T-6UJV';
const MASKED = '····-····-····-····-····-····-····-6UJV';

const unlicensed: LicenseView = {
  state: 'unlicensed',
  issuedAt: null,
  expiresAt: null,
  key: null,
};
const licensed: LicenseView = {
  state: 'licensed',
  issuedAt: ISSUED,
  expiresAt: EXPIRES,
  key: KEY,
};
const expired: LicenseView = { state: 'expired', issuedAt: ISSUED, expiresAt: EXPIRES, key: KEY };
// What a v1 activation produces: Licensed, with no purchase time and no expiry
// — the format carries neither, and neither may be invented (issue #161).
const licensedV1: LicenseView = {
  state: 'licensed',
  issuedAt: null,
  expiresAt: null,
  key: KEY,
};

describe('the ambient label', () => {
  it('reads Unlicensed with no license', () => {
    expect(licenseAmbientLabel(unlicensed)).toBe('Unlicensed');
  });

  // The full localized date, never a bare year (decision D3): the line the
  // footer shows is the same sentence the card's since row is titled with.
  it('reads Licensed since the purchase date once licensed', () => {
    const label = licenseAmbientLabel(licensed);

    expect(label).toContain('Licensed since');
    expect(label).toContain('2026');
    expect(label).not.toBe('Licensed since 2026');
    expect(label).not.toContain('NaN');
  });

  // The ambient label is the thing a purchase removes — and an expired license
  // no longer removes it. Showing "Licensed since" here would mean an expired
  // license looks exactly like a current one everywhere outside Settings.
  it('goes back to Unlicensed when the license has expired', () => {
    expect(licenseAmbientLabel(expired)).toBe('Unlicensed');
  });

  // A v1 license has no date, and there is no dateless "Licensed since"
  // variant to fall back to. `null` means the footer renders nothing at all —
  // dropping "Unlicensed" is the whole visible reward, and that still happens.
  it('has nothing to show when a license carries no purchase date', () => {
    expect(licenseAmbientLabel(licensedV1)).toBeNull();
    expect(licenseAmbientLabel(licensedV1)).not.toBe('Unlicensed');
  });
});

describe('the license card', () => {
  it('shows the Unlicensed badge and no license of any kind with no license', () => {
    const card = licenseCardModel(unlicensed);

    expect(card.status).toBe('unlicensed');
    expect(card.badge).toBe('Unlicensed');
    expect(card.since).toBeNull();
    expect(card.term).toBe('');
    expect(card.maskedKey).toBeNull();
  });

  it('names the purchase date and the expiry when licensed', () => {
    const card = licenseCardModel(licensed);

    expect(card.status).toBe('licensed');
    // Licensed is the state with no badge: the coin in the well says it.
    expect(card.badge).toBeNull();
    expect(card.since).toContain('2026');
    expect(card.since).not.toBe('2026');
    expect(card.term).toContain('Valid until');
    expect(card.term).toContain('2029');
    expect(card.maskedKey).toBe(MASKED);
  });

  // A perpetual product has no expiry, and the term must not invent one — an
  // empty or "Invalid Date" tail would be worse than saying nothing.
  it('reads a license with no expiry as Perpetual', () => {
    const card = licenseCardModel({ ...licensed, expiresAt: null });

    expect(card.term).toBe('Perpetual');
    expect(card.since).toContain('2026');
    expect(card.term).not.toContain('Valid until');
  });

  // The v1 reality (decision D2): production mints activations with no
  // `issued_at`, so the since row is present and blank. No stand-in, no fetch
  // time, no current year — and the state is still unmistakably Licensed.
  it('leaves the since row blank for a v1 license and calls the term perpetual', () => {
    const card = licenseCardModel(licensedV1);

    expect(card.status).toBe('licensed');
    expect(card.since).toBeNull();
    expect(card.term).toBe('Perpetual');
    expect(card.maskedKey).toBe(MASKED);
    expect(card.badge).toBeNull();
    // Nothing was substituted for the missing date — not this year, not any.
    expect(JSON.stringify(card)).not.toContain(String(new Date().getFullYear()));
  });

  // An expired license is kept on the device and still says when it was bought:
  // the user did pay, and the card is the only place that stays true to it.
  it('badges an expired license and dates its term', () => {
    const card = licenseCardModel(expired);

    expect(card.status).toBe('expired');
    expect(card.badge).toBe('Expired');
    expect(card.since).toContain('2026');
    expect(card.term).toContain('Expired');
    expect(card.term).toContain('2029');
    expect(card.maskedKey).toBe(MASKED);
  });

  // Defensive: an Expired state can only come from a v2 activation whose
  // expiry passed, so it always has both dates. One arriving without them must
  // fall back to the whole Unlicensed card rather than render "since NaN".
  it('falls back to Unlicensed when an expired state arrives without its dates', () => {
    for (const view of [
      { ...expired, expiresAt: null },
      { ...expired, issuedAt: null },
    ]) {
      const card = licenseCardModel(view);

      expect(card.status).toBe('unlicensed');
      expect(card.badge).toBe('Unlicensed');
      expect(card.since).toBeNull();
      expect(card.term).toBe('');
      expect(card.maskedKey).toBeNull();
    }
  });

  // The whole point of the mask: the real last group and nothing else, so a
  // support conversation can name a key without the screen showing it.
  it('masks every group of the key but the last', () => {
    const masked = licenseCardModel(licensed).maskedKey ?? '';

    expect(masked).toBe(MASKED);
    expect(masked.endsWith('6UJV')).toBe(true);
    expect(masked).not.toContain('AB12');
    expect(masked).not.toContain('RS3T');
  });

  // What makes revealing the key an IN-PLACE swap rather than a jump: the mask
  // is the key's own length and keeps its hyphens in the same columns, so in a
  // monospace face every dot is replaced by the character that was under it.
  // The mask this replaced was a fixed 39 characters joined by spaces, so an
  // org-prefixed 42-character key slid three cells right as it appeared.
  it('masks a key to its own length, hyphens included', () => {
    for (const key of [
      'AB12-CD34-EF56-GH78-JK9M-NP2Q-RS3T-6UJV',
      'FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78',
    ]) {
      const masked = licenseCardModel({ ...licensed, key }).maskedKey ?? '';

      expect(masked).toHaveLength(key.length);
      // Every hyphen stays where it was; nothing else survives but the last group.
      for (let i = 0; i < key.length - 4; i += 1) {
        expect(masked[i]).toBe(key[i] === '-' ? '-' : '·');
      }
      expect(masked.slice(-4)).toBe(key.slice(-4));
      expect(masked).not.toContain(' ');
    }
  });
});
