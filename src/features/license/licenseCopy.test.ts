import { describe, expect, it } from 'vitest';

import type { LicenseView } from '$lib/platform/license';

import { licenseAmbientLabel, licenseRowText } from './licenseCopy';

// Mid-year, midday UTC: the *year* these render is the same in every time zone,
// so the assertions below cannot flake on the runner's TZ. Assertions that would
// depend on a calendar day are deliberately structural instead of exact.
const ISSUED = '2026-06-15T12:00:00Z';
const EXPIRES = '2029-06-15T12:00:00Z';

const unlicensed: LicenseView = { state: 'unlicensed', issuedAt: null, expiresAt: null };
const licensed: LicenseView = { state: 'licensed', issuedAt: ISSUED, expiresAt: EXPIRES };
const expired: LicenseView = { state: 'expired', issuedAt: ISSUED, expiresAt: EXPIRES };
// What a v1 activation produces: Licensed, with no purchase time and no expiry
// — the format carries neither, and neither may be invented (issue #161).
const licensedV1: LicenseView = { state: 'licensed', issuedAt: null, expiresAt: null };

describe('the ambient label', () => {
  it('reads Unlicensed with no license', () => {
    expect(licenseAmbientLabel(unlicensed)).toBe('Unlicensed');
  });

  it('reads Supporter since the purchase year once licensed', () => {
    expect(licenseAmbientLabel(licensed)).toBe('Supporter since 2026');
  });

  // The ambient label is the thing a purchase removes — and an expired license
  // no longer removes it. Showing "Supporter since" here would mean an expired
  // license looks exactly like a current one everywhere outside Settings.
  it('goes back to Unlicensed when the license has expired', () => {
    expect(licenseAmbientLabel(expired)).toBe('Unlicensed');
  });

  // A v1 license has no year, and there is no yearless "Supporter since"
  // variant to fall back to. `null` means the footer renders the version alone
  // — dropping "Unlicensed" is the whole visible reward, and that still happens.
  it('has nothing to show when a license carries no purchase year', () => {
    expect(licenseAmbientLabel(licensedV1)).toBeNull();
    expect(licenseAmbientLabel(licensedV1)).not.toBe('Unlicensed');
  });
});

describe('the License row', () => {
  it('reads Unlicensed with no license', () => {
    expect(licenseRowText(unlicensed)).toBe('Unlicensed');
  });

  it('names the purchase year and the expiry when licensed', () => {
    const row = licenseRowText(licensed);

    expect(row).toContain('Licensed');
    expect(row).toContain('Supporter since 2026');
    expect(row).toContain('Valid until');
    expect(row).toContain('2029');
  });

  // A perpetual product has no expiry, and the row must not invent one — an
  // empty or "Invalid Date" tail would be worse than saying nothing.
  it('omits the expiry entirely for a perpetual license', () => {
    const row = licenseRowText({ state: 'licensed', issuedAt: ISSUED, expiresAt: null });

    expect(row).toBe('Licensed · Supporter since 2026');
    expect(row).not.toContain('Valid until');
  });

  // An expired license is kept on the device and still says "Supporter since":
  // the user did pay, and the row is the only place that stays true to it.
  it('still credits the supporter when expired', () => {
    const row = licenseRowText(expired);

    expect(row).toContain('License expired');
    expect(row).toContain('Supporter since 2026');
  });

  // A v1 license is licensed and says so — but it knows no year, so the whole
  // "Supporter since" clause goes rather than gaining a placeholder.
  it('reads as licensed with no since-clause when there is no purchase year', () => {
    const row = licenseRowText(licensedV1);

    expect(row).toBe('Licensed');
    expect(row).not.toContain('Supporter since');
    expect(row).not.toContain('Valid until');
    expect(row).not.toContain('NaN');
    expect(row).not.toBe('Unlicensed');
  });

  // Defensive: an Expired state can only come from a v2 activation whose
  // expiry passed, so it always has both dates. One arriving without them must
  // fall back rather than render "Supporter since NaN".
  it('falls back to Unlicensed when an expired state arrives without its dates', () => {
    expect(licenseRowText({ state: 'expired', issuedAt: ISSUED, expiresAt: null })).toBe(
      'Unlicensed',
    );
    expect(licenseRowText({ state: 'expired', issuedAt: null, expiresAt: EXPIRES })).toBe(
      'Unlicensed',
    );
  });
});
