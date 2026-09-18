// How a license state reads on the card. Pure: state in, strings out.
//
// This is presentation only — which catalog entry a state selects, which
// timestamps it formats, and how the stored key is masked. Whether a license
// *is* licensed, expired or invalid is decided in Rust (`futo-notes-license`)
// and arrives already judged, so nothing here re-derives it (AGENTS.md M6).

import type { LicenseStateName, LicenseView } from '$lib/platform/license';
import { localizedAbsoluteDate, localizedText } from '$shared/localization';

/** U+00B7 middle dot — one hidden character of the key. */
const MASK_CHARACTER = '·';
/** The card shows the key's last group and masks everything before it. */
const LAST_GROUP_LENGTH = 4;

function date(iso: string): string {
  return localizedAbsoluteDate(Date.parse(iso));
}

/// The stored key with every character before its last group replaced by a
/// middle dot, and its hyphens left where they are:
/// `····-····-····-····-····-····-····-6UJV`.
///
/// The mask is the SAME LENGTH as the key and keeps its separators in the same
/// columns, which is what makes revealing it an in-place swap: the card renders
/// the value in a monospace face, so every dot is replaced by the character
/// that was hiding under it and nothing on the plate moves (@justin
/// 2026-09-18). The first mask was a fixed seven groups of dots joined by
/// SPACES — 39 characters whatever the key, so an org-prefixed 42-character key
/// jumped three cells to the right as it appeared, and the rows below it
/// shifted with it. The key arrives normalized (trimmed, uppercased) from the
/// Rust crate, so it is masked as it stands.
function maskKey(key: string): string {
  if (key.length <= LAST_GROUP_LENGTH) return key;
  const hidden = key.slice(0, -LAST_GROUP_LENGTH).replace(/[^-]/g, MASK_CHARACTER);
  return hidden + key.slice(-LAST_GROUP_LENGTH);
}

/// What the License card renders, once per state.
///
/// Every field is a finished string for the shell to place: the card decides
/// nothing about the license itself, and `status` is Rust's answer carried
/// through (the one exception is the Expired guard below, which falls back to
/// the Unlicensed card rather than rendering a half-built date).
export interface LicenseCardModel {
  status: LicenseStateName;
  /** Unlicensed and Expired name themselves; Licensed is said by the coin. */
  badge: string | null;
  /** The purchase date, or `null` when the activation carried none — the row
   *  is present and blank, and nothing is invented to fill it. */
  since: string | null;
  /** "Perpetual", "Valid until {date}" or "Expired {date}"; empty when there
   *  is no license to have a term. */
  term: string;
  /** The stored key, masked to its last group. `null` with no license. */
  maskedKey: string | null;
}

function unlicensedCard(): LicenseCardModel {
  return {
    status: 'unlicensed',
    badge: localizedText('license.unlicensed'),
    since: null,
    term: '',
    maskedKey: null,
  };
}

/// The ambient label — the thing a purchase removes. "Unlicensed" while
/// Unlicensed *or* Expired; "Licensed since {date}" once Licensed.
///
/// `null` means **render nothing at all**: a v1 activation carries no
/// `issued_at`, so there is no date for "Licensed since" and no dateless
/// variant of that line (decision 2026-09-10, reaffirmed as D2). The footer is
/// then empty — dropping the "Unlicensed" label is the whole visible reward,
/// and it still happens.
export function licenseAmbientLabel(view: LicenseView): string | null {
  if (view.state === 'licensed') {
    return view.issuedAt === null
      ? null
      : localizedText('license.licensedSince', { date: date(view.issuedAt) });
  }
  return localizedText('license.unlicensed');
}

/// The License card's fields.
///
/// A clause is dropped when the activation did not carry its field, never
/// filled in with a stand-in: a v1 activation has no `issued_at`, so `since` is
/// `null` and the row renders blank, and no `expires_at`, so the term is
/// "Perpetual" — which is what a v1 license is by format, not a guess.
export function licenseCardModel(view: LicenseView): LicenseCardModel {
  if (view.state === 'unlicensed') return unlicensedCard();

  if (view.state === 'expired') {
    // Expired is only ever reached by a v2 activation whose `expires_at` has
    // passed, so it always has both dates. The guard stays — and stays
    // identical on all three platforms — so the impossible case cannot render
    // a card dated "NaN" if the contract ever changes.
    if (view.issuedAt === null || view.expiresAt === null) return unlicensedCard();
    return {
      status: 'expired',
      badge: localizedText('license.statusExpired'),
      since: date(view.issuedAt),
      term: localizedText('license.card.termExpired', { date: date(view.expiresAt) }),
      maskedKey: maskedKeyOf(view),
    };
  }

  return {
    status: 'licensed',
    // Licensed wears no badge: the coin in the well is the statement.
    badge: null,
    since: view.issuedAt === null ? null : date(view.issuedAt),
    // A perpetual product has no expiry, and the term must not invent one. A
    // v1 activation lands here too: it is perpetual by format, not by guess.
    term:
      view.expiresAt === null
        ? localizedText('license.card.termPerpetual')
        : localizedText('license.card.termValidUntil', { date: date(view.expiresAt) }),
    maskedKey: maskedKeyOf(view),
  };
}

function maskedKeyOf(view: LicenseView): string | null {
  return view.key === null ? null : maskKey(view.key);
}
