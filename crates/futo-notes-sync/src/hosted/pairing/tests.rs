use super::*;

fn payload(json: &str) -> Result<PairingRequest, HostedError> {
    HostedSetup::at("https://pairing.example")
        .expect("setup")
        .complete_pairing(json)
}

fn a_valid_code() -> String {
    serde_json::to_string(&Payload {
        futo_notes_pairing: PAYLOAD_VERSION,
        id: "koiKEC2jss5UMppDtKLHp5Zal8NhdQG2_plXmsHL0BI".into(),
        public_key: BASE64URL.encode(PairingKeyPair::generate().public),
        device_name: "Kitchen laptop".into(),
        platform: "desktop".into(),
    })
    .expect("payload")
}

#[test]
fn a_code_this_engine_wrote_parses_back_to_what_the_sheet_shows() {
    let request = payload(&a_valid_code()).expect("parse");
    assert_eq!(request.device_name(), "Kitchen laptop");
    assert_eq!(request.platform(), "desktop");
}

/// A scanner points at whatever is in front of it. None of this is a
/// pairing code, and none of it reaches the network.
#[test]
fn anything_that_is_not_a_pairing_code_is_refused() {
    for scanned in [
        "",
        "   ",
        "https://example.com",
        "WIFI:S:cafe;T:WPA;P:hunter2;;",
        "{}",
        r#"{"futo_notes_pairing":1}"#,
    ] {
        assert_eq!(
            payload(scanned).unwrap_err(),
            HostedError::PairingCodeInvalid,
            "scanned: {scanned:?}"
        );
    }
}

/// A payload from a version this build does not speak is refused rather
/// than read field by field and half-understood.
#[test]
fn a_payload_from_another_version_is_refused() {
    let code = a_valid_code().replace(r#""futo_notes_pairing":1"#, r#""futo_notes_pairing":2"#);
    assert_eq!(payload(&code).unwrap_err(), HostedError::PairingCodeInvalid);
}

/// A public key that is not 32 bytes cannot be sealed to, so it is caught
/// here rather than becoming a crypto failure after the confirm sheet.
#[test]
fn a_public_key_of_the_wrong_length_is_refused() {
    for key in ["", "not base64url!!", &BASE64URL.encode([7u8; 31])] {
        let code = serde_json::to_string(&Payload {
            futo_notes_pairing: PAYLOAD_VERSION,
            id: "pairing-1".into(),
            public_key: key.to_owned(),
            device_name: "Kitchen laptop".into(),
            platform: "desktop".into(),
        })
        .expect("payload");
        assert_eq!(
            payload(&code).unwrap_err(),
            HostedError::PairingCodeInvalid,
            "public key: {key:?}"
        );
    }
}

/// The relay refuses a string over 1024 characters, so a payload carrying
/// one is refused here rather than after a round trip.
#[test]
fn an_over_long_field_is_refused() {
    let code = serde_json::to_string(&Payload {
        futo_notes_pairing: PAYLOAD_VERSION,
        id: "pairing-1".into(),
        public_key: BASE64URL.encode(PairingKeyPair::generate().public),
        device_name: "n".repeat(MAX_FIELD_BYTES + 1),
        platform: "desktop".into(),
    })
    .expect("payload");
    assert_eq!(payload(&code).unwrap_err(), HostedError::PairingCodeInvalid);
}

/// The name a device reports is user-visible data, so it is carried
/// through exactly as it arrived — emoji, spaces, other scripts and all
/// (root AGENTS.md M2).
#[test]
fn a_device_name_crosses_the_code_verbatim() {
    let name = "Justin's  MacBook Pro 🖥 (работа)";
    let code = serde_json::to_string(&Payload {
        futo_notes_pairing: PAYLOAD_VERSION,
        id: "pairing-1".into(),
        public_key: BASE64URL.encode(PairingKeyPair::generate().public),
        device_name: name.into(),
        platform: "ios".into(),
    })
    .expect("payload");
    assert_eq!(payload(&code).expect("parse").device_name(), name);
}

#[test]
fn a_device_name_is_trimmed_to_what_the_relay_stores() {
    assert_eq!(bounded("Kitchen laptop"), "Kitchen laptop");
    let long = "é".repeat(MAX_FIELD_BYTES);
    let trimmed = bounded(&long);
    assert!(trimmed.len() <= MAX_FIELD_BYTES);
    assert!(long.starts_with(trimmed));
}

/// This build reports one of the three words a confirmation sheet knows.
#[test]
fn the_platform_is_one_the_other_device_can_render() {
    assert!(["ios", "android", "desktop"].contains(&device_platform()));
}

/// No `expires_at` a server can send turns into an unbounded wait: an
/// unreadable one, and one further out than a pairing may live, both land
/// on the contract's window, and one already past is no wait at all.
#[test]
fn no_expiry_a_server_sends_can_outlast_the_contracts_window() {
    assert_eq!(remaining("whenever"), PAIRING_WINDOW);
    assert_eq!(remaining("1999-01-01T00:00:00Z"), Duration::ZERO);
    assert_eq!(remaining("2999-01-01T00:00:00Z"), PAIRING_WINDOW);
    let soon = time::OffsetDateTime::now_utc() + Duration::from_secs(30);
    let soon = soon
        .format(&time::format_description::well_known::Rfc3339)
        .expect("format");
    let left = remaining(&soon);
    assert!(
        left > Duration::from_secs(25) && left <= Duration::from_secs(30),
        "a readable expiry is the time actually left, got {left:?}"
    );
}

/// Waiting before a code has been shown is its own answer, not a network
/// failure that never happened.
#[tokio::test]
async fn waiting_without_a_pairing_says_so() {
    let setup = HostedSetup::at("https://pairing.example").expect("setup");
    assert_eq!(
        setup.await_pairing().await.unwrap_err(),
        HostedError::PairingNotStarted
    );
}
