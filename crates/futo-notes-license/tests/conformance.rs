//! Golden-driven conformance for the paid client license.
//!
//! Reads the hand-reviewed `tests/conformance/license.json` plus its parts in
//! `tests/conformance/license/` (merged by `fixture()`) — the same style
//! `futo-notes-model` reads its goldens — and asserts this crate answers every
//! vector exactly. The fixture carries a test-only RSA key pair, so both
//! FUTOpay activation contracts — the v1 bare signature pay2 issues today and
//! the v2 envelope it can move to with no client release — are provable here,
//! before any shell has a License row.
//!
//! Every assertion is at the crate's public API. Nothing here reaches into a
//! private field or asserts on internal call order (issue #149, Testing
//! Decisions).

use std::cell::RefCell;

use futo_notes_license::{
    activation_url, buy_url, enter_license_key, evaluate, evidence_includes, is_valid_license_key,
    license_link_out, license_plate, license_purchase_surface, normalize_license_key,
    parse_deep_link, recognize_input, AcceptedLicense, ActivationTransport, BuySource,
    Distribution, EnterKeyError, Environment, HttpResponse, InvalidReason, LicenseConfig,
    LicenseEvidence, LicenseInclusion, LicenseInput, LicensePair, LicensePlate, LicenseState,
    LicenseStatus, OffsetDateTime, Platform, PurchaseSurface, TransportError, APP_STORE_PRODUCT_ID,
    CHECKOUT_PRODUCT_SLUG, DEEP_LINK_SCHEME, KEY_ALPHABET, ORG_SLUG, PRODUCT_SLUG, SUPPORT_MAILTO,
};
use serde_json::Value;

#[path = "conformance/enter_key.rs"]
mod enter_key;
#[path = "conformance/evaluation.rs"]
mod evaluation;
#[path = "conformance/fixture.rs"]
mod fixture;
#[path = "conformance/input_rules.rs"]
mod input_rules;
#[path = "conformance/mismatch.rs"]
mod mismatch;
#[path = "conformance/transport.rs"]
mod transport;

use fixture::*;
use mismatch::*;
use transport::*;
