## 5. M5 — land on the reward after activation

Native only. When an activation succeeds (deep link, cold or warm; or a bare key / pair entered
on the card) **and** the new `includes` contains `AppIcon` **and** the shell has a picker:

1. The existing toast `license.activated` still shows.
2. Settings is presented if it is not already (the deep link can arrive on the list), and the
   picker is opened over it, with a one-time header above the grid: the coin,
   `license.explanationLicensed` in bold, `settings.appIcon.license.landing` under it
   (`04-after-activation.png`, left). The coin badges are already on the tiles (D13).
3. The header exists only for this presentation. Dismissing the picker and reopening it shows
   today's plain grid. Nothing is persisted; there is no "seen" flag.
4. If the picker is already open (the user went Buy from the sheet, or typed a key after
   "I already paid"), the sheet dismisses itself and the grid re-renders licensed, with the
   same header.
5. M1 rule: the shell has already rendered before a cold-start link is applied; the picker is
   presented after, never gating the shell.
6. Android's "FUTO Notes may close" confirm stays on the first tap. An interrupted alias
   transition is reconciled by the existing startup observation; nothing new.
7. If the OS cannot change icons (iOS `supportsAlternateIcons == false`), skip the landing
   entirely: the picker would only show `settings.appIcon.unavailable`.

Tests: iOS `LicenseModelTests` + a UI test driving `futonotes://license/…` with the staging
fixture and asserting the picker is on screen with the header; Android `LicenseLinkActivity`
→ `MainActivity` path with the same assertion in `AppIconSystemTest`. Spec lines in
`license.md` § Deep link and `settings.md` § Native app icons.
