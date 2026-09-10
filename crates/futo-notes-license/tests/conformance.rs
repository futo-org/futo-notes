//! Golden-driven conformance for the paid client license.
//!
//! Reads the hand-reviewed `tests/conformance/license.json` — the same style
//! `futo-notes-model` reads its goldens — and asserts this crate answers every
//! vector exactly. The fixture carries a test-only RSA key pair, so the v2
//! FUTOpay activation contract is provable here before lib-polar ships it and
//! before any shell has a License row.
//!
//! Every assertion is at the crate's public API. Nothing here reaches into a
//! private field or asserts on internal call order (issue #149, Testing
//! Decisions).

use std::cell::RefCell;
use std::path::PathBuf;

use futo_notes_license::{
    activation_url, buy_url, enter_license_key, evaluate, is_valid_license_key,
    normalize_license_key, parse_deep_link, recognize_input, AcceptedLicense, ActivationTransport,
    EnterKeyError, Environment, HttpResponse, InvalidReason, LicenseConfig, LicenseInput,
    LicensePair, LicenseState, OffsetDateTime, Platform, TransportError, CHECKOUT_PRODUCT_SLUG,
    DEEP_LINK_SCHEME, KEY_ALPHABET, ORG_SLUG, PRODUCT_SLUG, SUPPORT_MAILTO,
};
use serde_json::Value;

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/conformance/license.json")
        .canonicalize()
        .expect("tests/conformance/license.json must exist");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).expect("fixture is valid JSON")
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("fixture case is missing a string `{key}`: {value}"))
}

fn instant(raw: &str) -> OffsetDateTime {
    OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|e| panic!("fixture timestamp {raw:?} is not RFC 3339: {e}"))
}

fn report(what: &str, failures: Vec<String>, total: usize) {
    assert!(
        failures.is_empty(),
        "{} of {total} {what} vectors in tests/conformance/license.json failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// `@name` in a fixture case stands for the activation generated under
/// `namedActivations.name`, so a 350-character base64 blob is written once.
fn resolve(fixture: &Value, raw: &str) -> String {
    let mut out = raw.to_string();
    for (_, named) in fixture["namedActivations"]
        .as_object()
        .expect("namedActivations object")
        .iter()
        .filter(|(name, _)| *name != "$comment")
    {
        out = out.replace(text(named, "name"), text(named, "activation"));
    }
    out
}

// --- the injected transport -------------------------------------------------

enum Outcome {
    /// Any request at all is a test failure: these vectors prove the crate is
    /// offline outside the one explicit bare-key path.
    Unavailable,
    Response {
        status: u16,
        body: String,
    },
    Failure {
        message: String,
    },
}

struct FakeTransport {
    outcome: Outcome,
    requests: RefCell<Vec<String>>,
}

impl ActivationTransport for FakeTransport {
    fn get(&self, url: &str) -> Result<HttpResponse, TransportError> {
        self.requests.borrow_mut().push(url.to_string());
        match &self.outcome {
            Outcome::Unavailable => {
                panic!("the license crate made a network request it must never make: GET {url}")
            }
            Outcome::Response { status, body } => Ok(HttpResponse {
                status: *status,
                body: body.clone(),
            }),
            Outcome::Failure { message } => Err(TransportError::new(message)),
        }
    }
}

fn transport_for(fixture: &Value, spec: &Value) -> FakeTransport {
    let outcome = match text(spec, "kind") {
        "unavailable" => Outcome::Unavailable,
        "response" => Outcome::Response {
            status: spec["status"].as_u64().expect("status") as u16,
            body: resolve(fixture, text(spec, "body")),
        },
        "failure" => Outcome::Failure {
            message: text(spec, "message").to_string(),
        },
        other => panic!("unknown transport kind {other:?}"),
    };
    FakeTransport {
        outcome,
        requests: RefCell::new(Vec::new()),
    }
}

// --- the vectors ------------------------------------------------------------

#[test]
fn constants_match_the_fixture() {
    let fixture = fixture();
    let constants = &fixture["constants"];

    assert_eq!(PRODUCT_SLUG, text(constants, "productSlug"));
    // A separate constant on purpose: what an activation payload calls the
    // product and what the storefront calls it are different strings, and the
    // fixture carries both so neither can be tidied into the other.
    assert_eq!(
        CHECKOUT_PRODUCT_SLUG,
        text(constants, "checkoutProductSlug")
    );
    assert_ne!(PRODUCT_SLUG, CHECKOUT_PRODUCT_SLUG);
    assert_eq!(DEEP_LINK_SCHEME, text(constants, "deepLinkScheme"));
    assert_eq!(KEY_ALPHABET, text(constants, "keyAlphabet"));
    assert_eq!(SUPPORT_MAILTO, text(constants, "supportMailto"));

    assert_eq!(ORG_SLUG, text(constants, "orgSlug"));

    // The Buy destination is environment-split like the key and the activation
    // host (M3): a `.dev` build must reach staging checkout, never production.
    let buy = &constants["buyUrls"];
    for (name, environment) in [
        ("production", Environment::Production),
        ("staging", Environment::Staging),
    ] {
        let expected = &buy[name];
        let config = environment.config();
        assert_eq!(
            buy_url(config, Platform::Desktop),
            text(expected, "desktop"),
            "{name} desktop buy URL"
        );
        assert_eq!(
            buy_url(config, Platform::Ios),
            text(expected, "ios"),
            "{name} iOS buy URL"
        );
        assert_eq!(
            buy_url(config, Platform::Android),
            text(expected, "android"),
            "{name} Android buy URL"
        );
    }

    let environments = &constants["environments"];
    // The dev/prod split is data here, not a compile flag, so a shell cannot
    // land a `.dev` build on the production key (M3).
    for (name, environment) in [
        ("production", Environment::Production),
        ("staging", Environment::Staging),
    ] {
        for bundle_id in environments[name]["bundleIds"]
            .as_array()
            .expect("bundleIds array")
        {
            let bundle_id = bundle_id.as_str().expect("bundle id");
            assert_eq!(
                Environment::for_bundle_id(bundle_id),
                environment,
                "{bundle_id} must resolve to the {name} environment"
            );
        }
    }
    assert_eq!(
        Environment::Production.config().pay2_base_url,
        text(&environments["production"], "pay2BaseUrl")
    );
    assert_eq!(
        Environment::Staging.config().pay2_base_url,
        text(&environments["staging"], "pay2BaseUrl")
    );
    // Every environment must carry a parseable key, or a dev build would fail
    // in a way no test covers.
    for environment in [Environment::Production, Environment::Staging] {
        let pair = LicensePair {
            key: "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78".into(),
            activation: "v2.cGF5bG9hZA.c2lnbmF0dXJl".into(),
        };
        assert_eq!(
            evaluate(&pair, environment.config(), instant("2026-09-09T12:00:00Z")),
            LicenseState::Invalid(InvalidReason::SignatureMismatch),
            "{environment:?} public key must parse — a key that cannot be read \
             would report every license as malformed instead"
        );
    }
}

#[test]
fn license_key_grammar() {
    let fixture = fixture();
    let cases = fixture["licenseKey"].as_array().expect("licenseKey array");
    let mut failures = Vec::new();
    for case in cases {
        let name = text(case, "name");
        let input = text(case, "input");
        let normalized = normalize_license_key(input);
        if normalized != text(case, "normalized") {
            failures.push(format!(
                "  {name}: normalize({input:?}) = {normalized:?}, expected {:?}",
                text(case, "normalized")
            ));
        }
        let valid = is_valid_license_key(input);
        let expected = case["valid"].as_bool().expect("valid bool");
        if valid != expected {
            failures.push(format!(
                "  {name}: is_valid_license_key({input:?}) = {valid}, expected {expected}"
            ));
        }
    }
    report("licenseKey", failures, cases.len());
}

#[test]
fn input_shape_recognition() {
    let fixture = fixture();
    let cases = fixture["recognizeInput"]
        .as_array()
        .expect("recognizeInput array");
    let mut failures = Vec::new();
    for case in cases {
        let name = text(case, "name");
        let input = text(case, "input");
        let actual = recognize_input(input);
        let expected = &case["expected"];
        let matches = match (&actual, expected) {
            (None, Value::Null) => true,
            (Some(LicenseInput::BareKey(key)), Value::Object(_)) => {
                expected["shape"] == "bareKey" && expected["key"] == key.as_str()
            }
            (Some(LicenseInput::Pair(pair)), Value::Object(_)) => {
                expected["shape"] == "pair"
                    && expected["key"] == pair.key.as_str()
                    && expected["activation"] == pair.activation.as_str()
            }
            _ => false,
        };
        if !matches {
            failures.push(format!(
                "  {name}: recognize_input({input:?}) = {actual:?}, expected {expected}"
            ));
        }
    }
    report("recognizeInput", failures, cases.len());
}

#[test]
fn deep_link_parsing() {
    let fixture = fixture();
    let cases = fixture["deepLink"].as_array().expect("deepLink array");
    let mut failures = Vec::new();
    for case in cases {
        let name = text(case, "name");
        let input = text(case, "input");
        let actual = parse_deep_link(input);
        let expected = &case["expected"];
        let matches = match (&actual, expected) {
            (None, Value::Null) => true,
            (Some(pair), Value::Object(_)) => {
                expected["key"] == pair.key.as_str()
                    && expected["activation"] == pair.activation.as_str()
            }
            _ => false,
        };
        if !matches {
            failures.push(format!(
                "  {name}: parse_deep_link({input:?}) = {actual:?}, expected {expected}"
            ));
        }
    }
    report("deepLink", failures, cases.len());
}

/// The fixture's `sign.payload` is the cleartext a reviewer reads. Prove the
/// generated activation really carries it, so a stale or hand-edited blob
/// cannot quietly make a case pass for the wrong reason.
#[test]
fn generated_activations_carry_the_payload_the_fixture_shows() {
    use base64::Engine as _;
    let fixture = fixture();
    let mut failures = Vec::new();
    let mut total = 0usize;
    let mut check = |case: &Value| {
        let sign = &case["sign"];
        if !sign.is_object() || sign["format"] != "v2" {
            return;
        }
        let shown = if sign["payloadOverride"].is_object() {
            &sign["payloadOverride"]
        } else if sign["payload"].is_object() {
            &sign["payload"]
        } else {
            return;
        };
        total += 1;
        let name = text(case, "name");
        let activation = text(case, "activation");
        let Some(segment) = activation.split('.').nth(1) else {
            failures.push(format!("  {name}: activation has no payload segment"));
            return;
        };
        let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(segment) else {
            failures.push(format!("  {name}: payload segment is not base64url"));
            return;
        };
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(decoded) if &decoded == shown => {}
            Ok(decoded) => failures.push(format!(
                "  {name}: signed payload is {decoded}, but the fixture shows {shown}"
            )),
            Err(e) => failures.push(format!("  {name}: payload segment is not JSON: {e}")),
        }
    };
    for case in fixture["evaluate"].as_array().expect("evaluate array") {
        check(case);
    }
    for (_, case) in fixture["namedActivations"]
        .as_object()
        .expect("namedActivations")
        .iter()
        .filter(|(name, _)| *name != "$comment")
    {
        check(case);
    }
    report("signed-payload", failures, total);
}

#[test]
fn evaluate_vectors() {
    let fixture = fixture();
    let config = fixture_config(&fixture);
    let cases = fixture["evaluate"].as_array().expect("evaluate array");
    let mut failures = Vec::new();
    for case in cases {
        let name = text(case, "name");
        let pair = LicensePair {
            key: text(case, "key").to_string(),
            activation: text(case, "activation").to_string(),
        };
        let actual = evaluate(&pair, config, instant(text(case, "now")));
        if let Some(problem) = state_mismatch(&actual, &case["expected"]) {
            failures.push(format!("  {name}: {problem}"));
        }
    }
    report("evaluate", failures, cases.len());
}

#[test]
fn enter_key_vectors() {
    let fixture = fixture();
    let config = fixture_config(&fixture);
    let cases = fixture["enterKey"].as_array().expect("enterKey array");
    let mut failures = Vec::new();
    for case in cases {
        let name = text(case, "name");
        let input = resolve(&fixture, text(case, "input"));
        let transport = transport_for(&fixture, &case["transport"]);
        let outcome = enter_license_key(&input, config, instant(text(case, "now")), &transport);

        let expected = &case["expected"];
        if let Some(problem) = accepted_mismatch(&fixture, &outcome, expected) {
            failures.push(format!("  {name}: {problem}"));
        }

        let expected_requests: Vec<&str> = case["requests"]
            .as_array()
            .expect("requests array")
            .iter()
            .map(|url| url.as_str().expect("request url"))
            .collect();
        let actual_requests = transport.requests.borrow().clone();
        if actual_requests != expected_requests {
            failures.push(format!(
                "  {name}: requests were {actual_requests:?}, expected {expected_requests:?}"
            ));
        }
    }
    report("enterKey", failures, cases.len());
}

#[test]
fn activation_url_is_built_from_the_environment() {
    let key = "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78";
    assert_eq!(
        activation_url(Environment::Production.config(), key),
        format!("https://pay2.futo.org/api/v1/activate/{key}")
    );
    assert_eq!(
        activation_url(Environment::Staging.config(), key),
        format!("https://staging-pay2.futo.org/api/v1/activate/{key}")
    );
}

// --- helpers ----------------------------------------------------------------

fn fixture_config(fixture: &Value) -> LicenseConfig<'_> {
    LicenseConfig {
        public_key_base64: text(&fixture["keys"]["org"], "publicKeySpkiBase64"),
        pay2_base_url: text(fixture, "testPayBaseUrl"),
    }
}

fn reason_name(reason: InvalidReason) -> &'static str {
    match reason {
        InvalidReason::UnrecognizedInput => "unrecognizedInput",
        InvalidReason::VerificationKeyUnusable => "verificationKeyUnusable",
        InvalidReason::MalformedKey => "malformedKey",
        InvalidReason::MalformedActivation => "malformedActivation",
        InvalidReason::UnsupportedVersion => "unsupportedVersion",
        InvalidReason::MalformedBase64 => "malformedBase64",
        InvalidReason::SignatureMismatch => "signatureMismatch",
        InvalidReason::MalformedPayload => "malformedPayload",
        InvalidReason::KeyMismatch => "keyMismatch",
        InvalidReason::WrongProduct => "wrongProduct",
    }
}

/// `None` when the state matches the golden; a human-readable difference
/// otherwise.
fn state_mismatch(actual: &LicenseState, expected: &Value) -> Option<String> {
    let wanted = expected["state"].as_str().expect("expected.state");
    match (actual, wanted) {
        (LicenseState::Invalid(reason), "invalid") => {
            let wanted_reason = expected["reason"].as_str().expect("expected.reason");
            (reason_name(*reason) != wanted_reason).then(|| {
                format!(
                    "invalid for reason {:?}, expected {wanted_reason:?}",
                    reason_name(*reason)
                )
            })
        }
        (LicenseState::Licensed(details), "licensed")
        | (LicenseState::Expired(details), "expired") => {
            let issued = instant(expected["issuedAt"].as_str().expect("expected.issuedAt"));
            if details.issued_at != issued {
                return Some(format!(
                    "issued_at is {:?}, expected {issued:?}",
                    details.issued_at
                ));
            }
            let expires = expected["expiresAt"].as_str().map(instant);
            if details.expires_at != expires {
                return Some(format!(
                    "expires_at is {:?}, expected {expires:?}",
                    details.expires_at
                ));
            }
            None
        }
        _ => Some(format!("state is {actual:?}, expected {wanted:?}")),
    }
}

fn accepted_mismatch(
    fixture: &Value,
    outcome: &Result<AcceptedLicense, EnterKeyError>,
    expected: &Value,
) -> Option<String> {
    match (outcome, expected.get("ok"), expected.get("error")) {
        (Ok(accepted), Some(ok), None) => {
            let key = ok["key"].as_str().expect("ok.key");
            if accepted.pair.key != key {
                return Some(format!(
                    "stored key is {:?}, expected {key:?}",
                    accepted.pair.key
                ));
            }
            let activation = resolve(fixture, ok["activation"].as_str().expect("ok.activation"));
            if accepted.pair.activation != activation {
                return Some("stored activation is not the one the fixture expects".to_string());
            }
            let wanted = ok["state"].as_str().expect("ok.state");
            match (&accepted.state, wanted) {
                (LicenseState::Licensed(_), "licensed") | (LicenseState::Expired(_), "expired") => {
                    None
                }
                _ => Some(format!(
                    "state is {:?}, expected {wanted:?}",
                    accepted.state
                )),
            }
        }
        (Err(error), None, Some(wanted)) => {
            let name = match error {
                EnterKeyError::Invalid(_) => "invalid",
                EnterKeyError::NotFound => "notFound",
                EnterKeyError::Transport(_) => "transport",
            };
            if name != wanted.as_str().expect("error name") {
                return Some(format!("failed with {name:?}, expected {wanted:?}"));
            }
            // An `invalid` golden that does not say WHY can pass for any of the
            // ten reasons, which is the accident InvalidReason exists to stop.
            match (error, expected["reason"].as_str()) {
                (EnterKeyError::Invalid(reason), Some(wanted_reason)) => {
                    (reason_name(*reason) != wanted_reason).then(|| {
                        format!(
                            "failed for reason {:?}, expected {wanted_reason:?}",
                            reason_name(*reason)
                        )
                    })
                }
                (EnterKeyError::Invalid(_), None) => {
                    Some("an `invalid` case must name the expected reason".to_string())
                }
                _ => None,
            }
        }
        (Ok(_), None, Some(wanted)) => Some(format!("succeeded, expected failure {wanted:?}")),
        (Err(error), Some(_), None) => Some(format!("failed with {error:?}, expected success")),
        _ => Some("fixture case must carry exactly one of `ok` or `error`".to_string()),
    }
}
