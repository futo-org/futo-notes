use super::*;
use futo_notes_license::{InvalidReason, LicenseDetails};
use std::sync::atomic::{AtomicU32, Ordering};

fn scratch(label: &str) -> PathBuf {
    static SEQUENCE: AtomicU32 = AtomicU32::new(0);
    let path = std::env::temp_dir().join(format!(
        "futo-notes-license-{label}-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn instant(rfc3339: &str) -> OffsetDateTime {
    OffsetDateTime::parse(rfc3339, &time::format_description::well_known::Rfc3339).unwrap()
}

fn details() -> LicenseDetails {
    LicenseDetails {
        key: "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78".to_string(),
        product: Some("futo-notes".to_string()),
        issued_at: Some(instant("2026-01-15T10:30:00Z")),
        expires_at: Some(instant("2029-01-15T10:30:00Z")),
    }
}

/// The whole point of storage: what was accepted is what comes back, byte
/// for byte. base64url is case-sensitive, so an activation that is
/// "helpfully" normalized on the way through stops verifying.
#[test]
fn a_stored_pair_round_trips_unchanged() {
    let directory = scratch("round-trip");
    let path = directory.join(LICENSE_FILE);
    let pair = LicensePair {
        key: "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78".to_string(),
        activation: "v2.aBcD_-eF.gH-iJ_kL".to_string(),
    };

    write_pair(&path, &pair).unwrap();
    let loaded = read_pair(&path);

    std::fs::remove_dir_all(&directory).unwrap();
    assert_eq!(loaded, Some(pair));
}

/// Reading is the app's very first license question on every launch, so
/// "nothing stored" has to be an answer, not an error.
#[test]
fn a_missing_file_reads_as_no_license() {
    let directory = scratch("missing");
    let path = directory.join(LICENSE_FILE);

    let loaded = read_pair(&path);

    std::fs::remove_dir_all(&directory).unwrap();
    assert_eq!(loaded, None);
}

/// A truncated or hand-edited file must not become a pair that can never
/// verify — that would render as Unlicensed anyway, but only after a
/// pointless RSA check on every read.
#[test]
fn a_half_written_file_reads_as_no_license() {
    let directory = scratch("half-written");
    let path = directory.join(LICENSE_FILE);
    std::fs::write(&path, r#"{"key":"FN-AB12","activation":"  "}"#).unwrap();

    let loaded = read_pair(&path);

    std::fs::remove_dir_all(&directory).unwrap();
    assert_eq!(loaded, None);
}

/// Remove is reversible by re-entering the key and asks for no
/// confirmation, so it must also be idempotent: pressing it twice, or once
/// with nothing stored, is success.
#[test]
fn removing_a_license_that_was_never_stored_succeeds() {
    let directory = scratch("clear-absent");
    let path = directory.join(LICENSE_FILE);

    assert!(clear_pair(&path).is_ok());

    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn removing_a_stored_license_deletes_the_file() {
    let directory = scratch("clear-present");
    let path = directory.join(LICENSE_FILE);
    write_pair(
        &path,
        &LicensePair {
            key: "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78".to_string(),
            activation: "v2.a.b".to_string(),
        },
    )
    .unwrap();

    clear_pair(&path).unwrap();
    let loaded = read_pair(&path);

    std::fs::remove_dir_all(&directory).unwrap();
    assert_eq!(loaded, None);
}

/// Each verdict projects into exactly what the row renders. Dates cross as
/// RFC 3339 so the card can render "Licensed since" and "Valid until"; an
/// expired license is kept, so it keeps both dates and its key; a perpetual
/// license has no expiry and the row must not invent one. A v1 activation
/// carries neither date, and handing the frontend a stand-in (`now`, the
/// fetch time) is how a date nobody bought anything on ends up in "Licensed
/// since" (issue #161). The key crosses in the crate's normalized form, the
/// exact string `write_pair` stored, because the card has no other route to
/// it (§4). `InvalidReason` is diagnostic only: a stored pair that stopped
/// verifying looks exactly like no license and never leaks its key.
#[test]
fn view_of_projects_state_dates_and_key() {
    const KEY: &str = "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78";
    const ISSUED: &str = "2026-01-15T10:30:00Z";
    const EXPIRES: &str = "2029-01-15T10:30:00Z";
    let view = |state: &'static str,
                issued_at: Option<&str>,
                expires_at: Option<&str>,
                key: Option<&str>| LicenseView {
        state,
        // Only a licensed state includes the app icon (the crate's rule,
        // projected as camelCase names).
        includes: if state == "licensed" {
            vec!["appIcon"]
        } else {
            vec![]
        },
        issued_at: issued_at.map(str::to_owned),
        expires_at: expires_at.map(str::to_owned),
        key: key.map(str::to_owned),
    };
    let perpetual = LicenseDetails {
        expires_at: None,
        ..details()
    };
    let v1 = LicenseDetails {
        product: None,
        issued_at: None,
        expires_at: None,
        ..details()
    };

    for (state, expected) in [
        (
            LicenseState::Licensed(details()),
            view("licensed", Some(ISSUED), Some(EXPIRES), Some(KEY)),
        ),
        (
            LicenseState::Expired(details()),
            view("expired", Some(ISSUED), Some(EXPIRES), Some(KEY)),
        ),
        (
            LicenseState::Licensed(perpetual),
            view("licensed", Some(ISSUED), None, Some(KEY)),
        ),
        (
            LicenseState::Licensed(v1),
            view("licensed", None, None, Some(KEY)),
        ),
        (
            LicenseState::Invalid(InvalidReason::KeyMismatch),
            view("unlicensed", None, None, None),
        ),
        (
            LicenseState::Invalid(InvalidReason::SignatureMismatch),
            unlicensed_view(),
        ),
    ] {
        assert_eq!(view_of(&state), expected, "{state:?}");
    }
}

/// These strings are the IPC contract: the shell switches on them to pick a
/// state to render and a toast to show, and a `Record<LicenseOutcome, …>`
/// lookup in TypeScript answers `undefined` for a name that drifted. Every
/// other test here compares against the constants, so renaming a constant's
/// VALUE would leave them all green — this is the one that goes red (M11).
#[test]
fn the_wire_names_the_shell_switches_on_are_pinned() {
    assert_eq!(STATE_UNLICENSED, "unlicensed");
    assert_eq!(STATE_LICENSED, "licensed");
    assert_eq!(STATE_EXPIRED, "expired");
    assert_eq!(OUTCOME_ACTIVATED, "activated");
    assert_eq!(OUTCOME_INVALID, "invalid");
    assert_eq!(OUTCOME_OFFLINE, "offline");
    assert_eq!(LICENSE_LINK_EVENT, "license:link");
}

/// The spec gives 404 and a failed verification the SAME message, and
/// reserves the "connect to the internet" message for a request that did
/// not complete. Getting this mapping backwards would tell a user with a
/// typo'd key to check their network.
#[test]
fn a_rejected_key_and_a_missing_key_share_one_message() {
    assert_eq!(
        outcome_of_error(&EnterKeyError::Invalid(InvalidReason::WrongProduct)),
        OUTCOME_INVALID
    );
    assert_eq!(outcome_of_error(&EnterKeyError::NotFound), OUTCOME_INVALID);
    assert_eq!(
        outcome_of_error(&EnterKeyError::Transport(TransportError::new("dns"))),
        OUTCOME_OFFLINE
    );
}

/// The inbox exists so a cold-start link is toasted exactly once. Two
/// drains returning the same outcome would double-toast; zero would lose it.
/// Draining is the only read: a link handled while the app was running used
/// to stay parked after its toast, so the next launch showed it again (an
/// "isn't valid" toast on a licensed app, QA 2026-09-09).
#[test]
fn a_parked_link_outcome_is_delivered_exactly_once() {
    let inbox = LicenseLinkInbox::default();
    let result = LicenseActionResult {
        outcome: OUTCOME_ACTIVATED,
        view: unlicensed_view(),
    };

    assert_eq!(inbox.take(), None);
    inbox.park(result.clone());
    assert_eq!(inbox.take(), Some(result));
    assert_eq!(inbox.take(), None);
}

/// The most recent link is the one that matters: an outcome nobody drained
/// must not shadow a newer one.
#[test]
fn a_second_link_replaces_an_undrained_outcome() {
    let inbox = LicenseLinkInbox::default();
    inbox.park(LicenseActionResult {
        outcome: OUTCOME_INVALID,
        view: unlicensed_view(),
    });
    inbox.park(LicenseActionResult {
        outcome: OUTCOME_ACTIVATED,
        view: unlicensed_view(),
    });

    assert_eq!(inbox.take().unwrap().outcome, OUTCOME_ACTIVATED);
}
