## 7c. M8 — store purchases are redeemed for a FUTOpay key (ADOPTED, D29; lib-polar MR + client)

> **Deferred 2026-10-19.** lib-polar!62 and the redeem endpoints are not being built now. Nothing
> in this section is a task; it stays as the record. The paragraph below is as written on
> 2026-10-16.
>
> **Adopted 2026-10-16 (D29), after being rejected the same morning under D19.** This was the
> design; § 7b is the client and store-setup half and points here. [ADR-0008](../../adr/0008-store-purchases-are-redeemed-for-a-key.md)
> records the decision. § 7c.1-7c.4 are the Apple scoping as written before the decision (the
> "if chosen" wording is now "as decided"); **§ 7c.5 adds the Google Play half**, which the
> original scoping did not cover.

The app sends the store's signed proof (StoreKit 2 signed transaction; Play signed purchase) to
**FUTOpay (lib-polar)**, which verifies it (Apple's official Python library; the Play public-key
signature) and answers with an ordinary FUTOpay license key + activation. The client then holds
**only** FUTOpay pairs, on every platform. This supersedes ADR-0007's "No server work", "three
possible proofs", "verified offline in Rust" and "never sent to FUTO" clauses and replaces the Rust
verifier half of the pre-D29 M7. Read for this section
(2026-10-16): ADR-0005/0007; this plan §§ 0, 7, 7b, 8, 9; `crates/futo-notes-license`
(`enter.rs`, `activation.rs`, `config.rs`, `AGENTS.md`); `crates/futo-notes-ffi/src/license/`;
`apps/ios/Sources/License/`; `docs/spec/license.md` (principles, entering a key); lib-polar
`main` (`licensing/key.py`, `utils/org_tools.py` `create_key_func`/`issue_session_license`,
`api/public/pages.py`, `webhooks.py`, `database/dto.py` + `db_manager.py` table registry,
`pyproject.toml`, `.gitlab-ci.yml`) and branch `feat/futo-notes-v2-activation` (read through
`git show`/`diff`, not checked out). Apple library facts are from the
[README](https://github.com/apple/app-store-server-library-python) and
[`signed_data_verifier.py`](https://github.com/apple/app-store-server-library-python/blob/main/appstoreserverlibrary/signed_data_verifier.py)
as fetched 2026-10-16 (a summarizing fetch, not a source checkout).

- [7c.1 The flow](7c-m8-store-purchases-redeemed/7c-1-the-flow.md)
- [7c.2 lib-polar (read-only study; nothing there was changed)](7c-m8-store-purchases-redeemed/7c-2-lib-polar.md)
- [7c.3 FUTO Notes (this repo)](7c-m8-store-purchases-redeemed/7c-3-futo-notes.md)
- [7c.4 Comparison with ADR-0007 (offline proof)](7c-m8-store-purchases-redeemed/7c-4-comparison-with-adr-0007.md)
- [7c.5 Google Play redemption (added with D29, 2026-10-16)](7c-m8-store-purchases-redeemed/7c-5-google-play-redemption.md)
