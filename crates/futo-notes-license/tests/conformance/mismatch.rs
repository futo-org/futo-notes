//! Comparing a computed state or outcome with the reviewed golden.
use super::*;

pub(super) fn reason_name(reason: InvalidReason) -> &'static str {
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
pub(super) fn state_mismatch(actual: &LicenseState, expected: &Value) -> Option<String> {
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
            // Both fields must be WRITTEN OUT in the golden, `null` included: a
            // v1 activation carries neither, and "the reviewer forgot to say"
            // must not read as "the client may leave it absent".
            let issued = expected
                .get("issuedAt")
                .unwrap_or_else(|| {
                    panic!(
                        "a licensed/expired golden must state issuedAt (null for a v1 activation)"
                    )
                })
                .as_str()
                .map(instant);
            if details.issued_at != issued {
                return Some(format!(
                    "issued_at is {:?}, expected {issued:?}",
                    details.issued_at
                ));
            }
            let expires = expected
                .get("expiresAt")
                .unwrap_or_else(|| {
                    panic!("a licensed/expired golden must state expiresAt (null for a perpetual or v1 license)")
                })
                .as_str()
                .map(instant);
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

pub(super) fn accepted_mismatch(
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
