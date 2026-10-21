import { expect, type Page } from '@playwright/test';

// Fixtures and helpers shared by the license-card*.spec.ts suites, moved here
// verbatim from license-card.spec.ts.
// The Steel Ledger plate, one test per state (docs/spec/license.md § States and
// copy).
//
// The license *rules* live in Rust and the browser never reaches them: off
// Tauri `src/lib/platform/license.ts` answers "Unlicensed" for everything, so
// the only way to see the other states in a browser is to replace that module.
// The dev server serves it as a plain ESM module, so the mock is a route
// fulfillment — no product-code test hook, and nothing here re-implements a
// rule: the fixture *is* what Rust would have answered.
export interface LicenseViewFixture {
  state: 'unlicensed' | 'licensed' | 'expired';
  issuedAt: string | null;
  expiresAt: string | null;
  key: string | null;
  includes: 'appIcon'[];
}

export const KEY = 'AB12-CD34-EF56-GH78-JK9M-NP2Q-RS3T-6UJV';
/** Seven masked groups of four U+00B7, then the real last four. */
export const MASKED_KEY = '····-····-····-····-····-····-····-6UJV';

export const UNLICENSED: LicenseViewFixture = {
  state: 'unlicensed',
  issuedAt: null,
  expiresAt: null,
  key: null,
  includes: [],
};
export const LICENSED_V2: LicenseViewFixture = {
  state: 'licensed',
  issuedAt: '2026-06-15T12:00:00Z',
  expiresAt: '2029-06-15T12:00:00Z',
  key: KEY,
  includes: ['appIcon'],
};
/** A v1 activation: no issue date and no expiry, which is what production
 *  mints today. It renders the same card as a v2 one — since 2026-09-17 the
 *  card shows neither a purchase date nor a term, so the two differ in nothing
 *  the user can see. */
export const LICENSED_V1: LicenseViewFixture = {
  state: 'licensed',
  issuedAt: null,
  expiresAt: null,
  key: KEY,
  includes: ['appIcon'],
};
export const EXPIRED: LicenseViewFixture = {
  state: 'expired',
  issuedAt: '2024-01-02T12:00:00Z',
  expiresAt: '2025-01-02T12:00:00Z',
  key: KEY,
  includes: [],
};

/** When set, any key the user submits activates and lands on this view — which
 *  is the only way to reach the *moment* of activation from a browser. */
export async function mockLicense(
  page: Page,
  view: LicenseViewFixture,
  activatesTo?: LicenseViewFixture,
): Promise<void> {
  await page.route('**/src/lib/platform/license.ts*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: `
        export const UNLICENSED = { state: 'unlicensed', issuedAt: null, expiresAt: null, key: null, includes: [] };
        const VIEW = ${JSON.stringify(view)};
        const ACTIVATED = ${JSON.stringify(activatesTo ?? null)};
        export async function readLicenseStatus() { return VIEW; }
        export async function submitLicenseKey() {
          return ACTIVATED === null
            ? { outcome: 'invalid', view: VIEW }
            : { outcome: 'activated', view: ACTIVATED };
        }
        export async function clearLicense() { return UNLICENSED; }
        export async function readLicenseLinks() { return { buy: '', support: '' }; }
        export async function takePendingLicenseLink() { return null; }
        export async function subscribeLicenseLinks() { return () => {}; }
      `,
    });
  });
}

export async function openLicenseSettings(
  page: Page,
  view: LicenseViewFixture,
  activatesTo?: LicenseViewFixture,
): Promise<void> {
  await mockLicense(page, view, activatesTo);
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.sidebar-settings-btn').click();
  await expect(page.locator('.settings-title')).toBeVisible();
  await expect(page.locator('.license-plate')).toBeVisible();
}

/** The `dd` of the plate row whose `dt` is exactly this label. */
export function rowValue(page: Page, label: string) {
  return page
    .locator('.license-row')
    .filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })
    .locator('dd');
}

export function buyButton(page: Page) {
  return page.locator('.license-plate').getByRole('button', { name: 'Buy a license' });
}

export function removeButton(page: Page) {
  return page.locator('.license-plate').getByRole('button', { name: 'Remove license' });
}
