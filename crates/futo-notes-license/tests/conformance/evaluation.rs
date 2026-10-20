//! Activation payloads and the evaluate vectors.
use super::*;

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
