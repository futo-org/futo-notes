//! QR pairing: the new device shows a code, the unlocked device seals the
//! vault key to it, and the relay carries the ciphertext between them.
//!
//! The new device is already signed in but holds no vault key. It mints a
//! one-time X25519 keypair, opens a pairing on the server's account-scoped
//! relay, and shows the pairing id, the public half, and its own name and
//! platform as a QR code. The already-unlocked device scans that code, shows
//! one confirmation naming the new device, seals the vault key to the public
//! key, and posts it. The new device has been polling since it drew the code,
//! so it collects the ciphertext, opens it, and keeps the key (ADR 0003,
//! decision 5; server ADR 0008 is the wire contract).
//!
//! Two properties are structural rather than remembered:
//!
//! * **The private half never leaves this device.** It lives in
//!   [`PendingPairing`], which is private to this module, is never returned,
//!   and dies with the process. Nothing hands it to a shell, and
//!   [`futo_notes_core::e2ee::PairingKeyPair`] redacts it from `Debug`.
//! * **Nothing is posted without the confirm step.** Parsing a scanned code
//!   ([`HostedSetup::complete_pairing`]) touches no network and no crypto; it
//!   answers with a [`PairingRequest`], and [`HostedSetup::confirm_pairing`]
//!   is the only thing that takes one. A `PairingRequest` cannot be built any
//!   other way, so a wrong scan cannot send a vault key.

use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64URL;
use base64::Engine;
use futo_notes_core::e2ee::{
    open_sealed_vault_key, seal_vault_key, PairingKeyPair, PAIRING_KEY_BYTES,
};
use serde::{Deserialize, Serialize};

use super::poll::PollSchedule;
use super::{HostedError, HostedSetup, Waited};

/// The relay's own window, from creation (server ADR 0008). Used only when a
/// server answers with an `expires_at` this client cannot read; the server's
/// value is what a pairing actually lives by.
const PAIRING_WINDOW: Duration = Duration::from_secs(300);

/// How close to the deadline a `404` still counts as expiry.
///
/// The relay enforces expiry when it reads the row, and this device's copy of
/// the deadline came off the same timestamp — but two clocks and a round trip
/// mean the two moments are never exactly the same one. Without this, whether
/// a person is told "that code expired, show a new one" or "that code is no
/// longer valid" would come down to a few milliseconds.
const EXPIRY_GRACE: Duration = Duration::from_secs(5);

/// The relay stores each string at up to 1024 characters and answers `400`
/// over that. A device name from an operating system is never this long, so
/// the bound is a guard rather than a rule anyone meets.
const MAX_FIELD_BYTES: usize = 1024;

/// The QR payload's format tag and version. A scanner points at whatever is
/// in front of it, so a code that is not this is refused rather than
/// half-parsed.
const PAYLOAD_VERSION: u8 = 1;

/// What the new device shows, and how long it has to be scanned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingCode {
    /// The string to render as a QR code. A scanner hands exactly this back
    /// to [`HostedSetup::complete_pairing`] on the other device.
    pub payload: String,
    /// RFC 3339, five minutes from creation, straight from the relay. The
    /// clock is not restarted by the key being posted.
    pub expires_at: String,
}

/// A scanned pairing code, parsed and nothing more.
///
/// Only [`HostedSetup::complete_pairing`] builds one and only
/// [`HostedSetup::confirm_pairing`] takes one, which is what makes the confirm
/// sheet a real gate instead of a convention: there is no way to reach the
/// relay with a scanned string that has not been through it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingRequest {
    id: String,
    public_key: [u8; PAIRING_KEY_BYTES],
    device_name: String,
    platform: String,
}

impl PairingRequest {
    /// What the new device calls itself — the name the confirmation sheet
    /// shows. Self-reported by that device and rendered verbatim.
    pub fn device_name(&self) -> &str {
        &self.device_name
    }

    /// `ios`, `android`, or `desktop`, as the new device reported itself.
    pub fn platform(&self) -> &str {
        &self.platform
    }
}

/// How waiting for the other device ended. Only these two: an expired code and
/// a pairing the relay will not serve are [`HostedError`]s instead, because
/// each is something for a person to do about, and neither of these is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingOutcome {
    /// The key arrived, opened, and is kept. This device is unlocked.
    Paired,
    /// The app stopped waiting — the pairing screen was left. The code is
    /// still live until it expires; showing it again means a new code.
    Cancelled,
}

/// The one-time keypair and the pairing it belongs to, held only in memory for
/// the few minutes between drawing the code and collecting the key.
///
/// No `Debug`: the secret half is in here.
pub(super) struct PendingPairing {
    id: String,
    keys: PairingKeyPair,
    /// When the relay stops serving this pairing, measured on this device's
    /// own clock so a `404` after it can be reported as expiry rather than as
    /// a pairing somebody else spent.
    deadline: Instant,
}

/// The QR payload on the wire. Named and versioned so a QR code that is not a
/// FUTO Notes pairing code is refused outright.
#[derive(Serialize, Deserialize)]
struct Payload {
    futo_notes_pairing: u8,
    id: String,
    /// The one-time X25519 public key, 32 bytes as unpadded base64url.
    public_key: String,
    device_name: String,
    platform: String,
}

/// What this build calls itself on the other device's confirmation sheet.
/// Derived here so three shells cannot each pick their own word for it.
fn device_platform() -> &'static str {
    if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "android") {
        "android"
    } else {
        "desktop"
    }
}

impl HostedSetup {
    /// Opens a pairing and returns the code for this device to show.
    ///
    /// Called on the **new** device, which is signed in and has no vault key.
    /// It mints a one-time keypair, publishes the public half to the relay
    /// with `device_name` and this build's platform, and keeps the private
    /// half here. Follow it with [`HostedSetup::await_pairing`].
    ///
    /// Calling it again abandons the previous pairing — which is what a person
    /// pressing "show a new code" means. The abandoned one ages out on the
    /// relay's own five-minute clock.
    pub async fn begin_pairing(&self, device_name: &str) -> Result<PairingCode, HostedError> {
        let http = self.authorized().await?;
        let keys = PairingKeyPair::generate();
        let public_key = BASE64URL.encode(keys.public);
        let device_name = bounded(device_name);
        let created = http
            .create_pairing(&public_key, device_name, device_platform())
            .await?;

        // The same four values the relay was given, which is what makes the
        // code self-contained: the server stores them and never serves them
        // back, so the QR payload is the only place the scanning device can
        // read the public key and the name from.
        let payload = Payload {
            futo_notes_pairing: PAYLOAD_VERSION,
            id: created.id.clone(),
            public_key,
            device_name: device_name.to_owned(),
            platform: device_platform().to_owned(),
        };
        let payload = serde_json::to_string(&payload)
            .map_err(|error| HostedError::Server(format!("building the pairing code: {error}")))?;

        *self.pairing.lock().expect("pending pairing lock") = Some(PendingPairing {
            id: created.id,
            keys,
            deadline: Instant::now() + remaining(&created.expires_at),
        });
        Ok(PairingCode {
            payload,
            expires_at: created.expires_at,
        })
    }

    /// Reads a scanned pairing code, on the **unlocked** device.
    ///
    /// This is the whole of what a scan does: it parses, and it answers with
    /// the name to put on the confirmation sheet. Nothing is sent, nothing is
    /// read from the secret store, and no vault key is touched — so a scan of
    /// the wrong QR code costs a message and nothing else. The key goes out
    /// only from [`HostedSetup::confirm_pairing`].
    pub fn complete_pairing(&self, scanned: &str) -> Result<PairingRequest, HostedError> {
        let payload: Payload =
            serde_json::from_str(scanned.trim()).map_err(|_| HostedError::PairingCodeInvalid)?;
        if payload.futo_notes_pairing != PAYLOAD_VERSION {
            return Err(HostedError::PairingCodeInvalid);
        }
        let public_key: [u8; PAIRING_KEY_BYTES] = BASE64URL
            .decode(&payload.public_key)
            .map_err(|_| HostedError::PairingCodeInvalid)?
            .try_into()
            .map_err(|_| HostedError::PairingCodeInvalid)?;
        if payload.id.is_empty()
            || payload.device_name.is_empty()
            || payload.platform.is_empty()
            || payload.id.len() > MAX_FIELD_BYTES
            || payload.device_name.len() > MAX_FIELD_BYTES
            || payload.platform.len() > MAX_FIELD_BYTES
        {
            return Err(HostedError::PairingCodeInvalid);
        }
        Ok(PairingRequest {
            id: payload.id,
            public_key,
            device_name: payload.device_name,
            platform: payload.platform,
        })
    }

    /// The confirm step: seals this device's vault key to the scanned public
    /// key and posts it to the relay. This is the only thing that sends a
    /// vault key anywhere, and the only way to reach it is with a
    /// [`PairingRequest`] that [`HostedSetup::complete_pairing`] produced.
    ///
    /// The server relays ciphertext it cannot open and deletes it the moment
    /// the new device collects it.
    pub async fn confirm_pairing(&self, request: &PairingRequest) -> Result<(), HostedError> {
        let vault_key = self
            .stored_vault_key()
            .await?
            .ok_or(HostedError::VaultLocked)?;
        let sealed = seal_vault_key(&request.public_key, &vault_key)
            .map_err(|error| HostedError::Crypto(error.to_string()))?;
        self.authorized()
            .await?
            .deliver_pairing_key(&request.id, &BASE64URL.encode(sealed))
            .await
    }

    /// Waits on the **new** device for the other one to answer, then opens the
    /// sealed key and keeps it. When this returns [`PairingOutcome::Paired`]
    /// the vault is unlocked: the key and the session token are in this
    /// device's secret store, and [`HostedSetup::current_step`] answers
    /// `Ready`.
    ///
    /// A person who declines on the other device sends nothing, so declining
    /// and walking away are the same thing seen from here: the wait ends at
    /// the code's expiry with [`HostedError::PairingExpired`].
    pub async fn await_pairing(&self) -> Result<PairingOutcome, HostedError> {
        let (id, secret, deadline) = {
            let pending = self.pairing.lock().expect("pending pairing lock");
            let pending = pending.as_ref().ok_or(HostedError::PairingNotStarted)?;
            (pending.id.clone(), pending.keys.secret, pending.deadline)
        };
        let http = self.authorized().await?;
        // The wait never outlives what it is waiting on: the relay stops
        // serving this pairing at its own five-minute mark.
        let schedule = PollSchedule {
            give_up_after: deadline.saturating_duration_since(Instant::now()),
            ..PollSchedule::PAIRING
        };

        let waited = self
            .wait(schedule, || async {
                match http.collect_pairing(&id).await? {
                    crate::server::PairingPoll::Pending => Ok(None),
                    crate::server::PairingPoll::Delivered(ciphertext) => Ok(Some(ciphertext)),
                    // Unknown, expired, already collected, or another
                    // account's — the relay answers all four alike, and this
                    // client does not pretend to tell them apart. Past our own
                    // copy of the deadline it can only be expiry.
                    crate::server::PairingPoll::Gone => {
                        Err(if Instant::now() + EXPIRY_GRACE >= deadline {
                            HostedError::PairingExpired
                        } else {
                            HostedError::PairingRefused
                        })
                    }
                }
            })
            .await?;

        let ciphertext = match waited {
            Waited::Got(ciphertext) => ciphertext,
            Waited::Cancelled => return Ok(PairingOutcome::Cancelled),
            Waited::GaveUp => return Err(HostedError::PairingExpired),
        };

        let sealed = BASE64URL.decode(&ciphertext).map_err(|error| {
            HostedError::Crypto(format!("the sealed vault key is not base64url: {error}"))
        })?;
        let vault_key = open_sealed_vault_key(&secret, &sealed)
            .map_err(|error| HostedError::Crypto(error.to_string()))?;
        self.keep(vault_key).await?;
        // Spent: the relay deleted it when it served the key, and the secret
        // half has no second use.
        *self.pairing.lock().expect("pending pairing lock") = None;
        Ok(PairingOutcome::Paired)
    }
}

/// How long this pairing has left, from the relay's own `expires_at`. A
/// timestamp this client cannot read falls back to the window the contract
/// states, so an unreadable answer is a bounded wait rather than an endless
/// one; an expiry already in the past is no wait at all.
fn remaining(expires_at: &str) -> Duration {
    let Ok(expiry) =
        time::OffsetDateTime::parse(expires_at, &time::format_description::well_known::Rfc3339)
    else {
        return PAIRING_WINDOW;
    };
    let nanos =
        expiry.unix_timestamp_nanos() - time::OffsetDateTime::now_utc().unix_timestamp_nanos();
    if nanos <= 0 {
        return Duration::ZERO;
    }
    // Capped at the contract's own window either way: a timestamp far enough
    // out to overflow the arithmetic, or simply further out than a pairing may
    // live, must not turn into a wait that never ends.
    u64::try_from(nanos)
        .map(Duration::from_nanos)
        .unwrap_or(PAIRING_WINDOW)
        .min(PAIRING_WINDOW)
}

/// Trims a string to what the relay will store, on a character boundary.
fn bounded(value: &str) -> &str {
    if value.len() <= MAX_FIELD_BYTES {
        return value;
    }
    let mut end = MAX_FIELD_BYTES;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

#[cfg(test)]
mod tests {
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
}
