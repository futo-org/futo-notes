//! The enter-key vectors and the activation URL.
use super::*;

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
