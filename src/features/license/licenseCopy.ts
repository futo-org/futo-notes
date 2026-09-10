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
export function licenseAmbientLabel(view: LicenseView): string {
  if (view.state === 'licensed' && view.issuedAt !== null) {
    return localizedText('license.supporterSince', { year: year(view.issuedAt) });
  }
  return localizedText('license.unlicensed');
}

/// The License row's status line.
export function licenseRowText(view: LicenseView): string {
  if (view.issuedAt === null) return localizedText('license.unlicensed');

  if (view.state === 'licensed') {
    // A perpetual product has no expiry, and the row must not invent one.
    return view.expiresAt === null
      ? localizedText('license.licensedPerpetual', { year: year(view.issuedAt) })
      : localizedText('license.licensed', {
          year: year(view.issuedAt),
          date: date(view.expiresAt),
        });
  }

  if (view.state === 'expired' && view.expiresAt !== null) {
    return localizedText('license.expired', {
      year: year(view.issuedAt),
      date: date(view.expiresAt),
    });
  }

  return localizedText('license.unlicensed');
}
