// How a license state reads. Pure: state in, string out.
//
// This is presentation only — which catalog entry a state selects and which
// timestamps it formats. Whether a license *is* licensed, expired or invalid is
// decided in Rust (`futo-notes-license`) and arrives already judged, so nothing
// here re-derives it (AGENTS.md M6).

import type { LicenseView } from '$lib/platform/license';
import { localizedAbsoluteDate, localizedText, localizedYear } from '$shared/localization';

function year(iso: string): string {
  return localizedYear(Date.parse(iso));
}

function date(iso: string): string {
  return localizedAbsoluteDate(Date.parse(iso));
}

/// The ambient label — the thing a purchase removes. "Unlicensed" while
/// Unlicensed *or* Expired; "Supporter since {year}" once Licensed.
///
/// `null` means **render nothing at all**: a v1 activation carries no
/// `issued_at`, so there is no year for "Supporter since" and no yearless
/// variant of that line (decision 2026-09-10). The footer then shows the app
/// version alone — dropping the "Unlicensed" label is the whole visible reward,
/// and it still happens.
export function licenseAmbientLabel(view: LicenseView): string | null {
  if (view.state === 'licensed') {
    return view.issuedAt === null
      ? null
      : localizedText('license.supporterSince', { year: year(view.issuedAt) });
  }
  return localizedText('license.unlicensed');
}

/// The License row's status line.
///
/// Each clause is dropped when the activation did not carry its field, never
/// filled in with a stand-in: a v1 activation has no `issued_at` and no
/// `expires_at`, so the row is the single word "Licensed" — still unmistakably
/// the licensed state, with no year invented to keep the sentence long.
export function licenseRowText(view: LicenseView): string {
  if (view.state === 'licensed') {
    if (view.issuedAt === null) return localizedText('license.licensedUndated');
    // A perpetual product has no expiry, and the row must not invent one.
    return view.expiresAt === null
      ? localizedText('license.licensedPerpetual', { year: year(view.issuedAt) })
      : localizedText('license.licensed', {
          year: year(view.issuedAt),
          date: date(view.expiresAt),
        });
  }

  // Expired is only ever reached by a v2 activation whose `expires_at` has
  // passed, so it always has both dates. The guard stays — and stays identical
  // on all three platforms — so the impossible case cannot render "Supporter
  // since NaN" if the contract ever changes.
  if (view.state === 'expired' && view.issuedAt !== null && view.expiresAt !== null) {
    return localizedText('license.expired', {
      year: year(view.issuedAt),
      date: date(view.expiresAt),
    });
  }

  return localizedText('license.unlicensed');
}
