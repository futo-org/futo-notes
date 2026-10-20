use std::sync::Mutex;

use futo_notes_license::HttpResponse;

use super::*;

/// A real, verifiable staging license: signed by the FUTO Notes staging org
/// key that `STAGING_PUBLIC_KEY_BASE64` bakes in, so it is Licensed on any
/// `.dev` build and Unlicensed on a release one — which is what
/// `the_bundle_id_is_the_dev_prod_split` below exists to prove. Product
/// futo-notes, issued 2026-01-15, expiring 2029-01-15.
///
/// It is deliberately NOT the conformance fixture's pair. That fixture's
/// key is test-only and lives in `tests/conformance/license.json`, where the
/// conformance suite reads it; nothing that has to behave like a real
/// staging license can be signed by it. Re-mint these (and the identical
/// pair in the two native `LicenseFixture` files) with
/// `FUTO_NOTES_STAGING_KEY=… node scripts/gen-license-fixture.mjs --staging`;
/// the staging private key is never in this repo. If the staging key is
/// rotated without re-minting, every test below that expects Licensed goes
/// red — which is the correct red.
const KEY: &str = "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78";
const ACTIVATION: &str = "v2.eyJrZXkiOiJGTi1BQjEyLUNEMzQtRUY1Ni1HSDc4LUpLMTItTU4zNC1QUTU2LVJTNzgiLCJwcm9kdWN0IjoiZnV0by1ub3RlcyIsImlzc3VlZF9hdCI6IjIwMjYtMDEtMTVUMTA6MzA6MDBaIiwiZXhwaXJlc19hdCI6IjIwMjktMDEtMTVUMTA6MzA6MDBaIn0.FGk9lAe8Bh-RumaXsq5guBjWK_CnwZK1UI2qwyiA7_P1j5T-XnX9FJmPZGgaxbALE5vAJO4wqLbJwPduYQMJwQekUfHnh_wo5i4leOzaspS2NlUltCc7kDmB0--BVuWuxU5TWqHfmBop49MFfIZ4zysQ9WSvh8DQ77cJeOv8QI5Sg1y1ThMEeColOxM8QSITNMr3Zo1vAhZxYv4chJw1YQYjop_EAD18L-_oqrlk48v_9EeS-OoQar46Q0hoGR-TKP03TgZs18dVZIeJOZ_k9eQTHaE2vkNXvG59lTDvKyZSKouOJ2rgiyoZV0a65BujEN-rNOyatiauydFjCb2FSw";
/// The same staging key, `expires_at: null` — the perpetual vector.
const PERPETUAL_ACTIVATION: &str = "v2.eyJrZXkiOiJGTi1BQjEyLUNEMzQtRUY1Ni1HSDc4LUpLMTItTU4zNC1QUTU2LVJTNzgiLCJwcm9kdWN0IjoiZnV0by1ub3RlcyIsImlzc3VlZF9hdCI6IjIwMjYtMDEtMTVUMTA6MzA6MDBaIiwiZXhwaXJlc19hdCI6bnVsbH0.bHkw2cpKuILrZGtqVJwe9-wZmQ6z8seiQQZDvzqoJWyw3AU0WWpnH6JTxrfIUZbG8Pwf7sQ7ztT6nckFcLLz1cTTFLQnYeksSLEKdeCuDRKQN-a9x3zNGODXo2Y4fx2iuYl7PJZeclwJYqVuiGfVbYeUrWUv34HQ7hsuhXJZslfRVF-iY-2h1F1dzH5gvhNxe6T-DuW-ccbHqFX3pPbqUN95MFimMK_gnw2ViMkiGmPVjSSh6Ey2J-BC9vVqW2Sjw05TRQqztLhjjsUdjcTvo9JPBpvyxeVoYiiCwkNqih0NEIEY2McI2oFHvAKMeep2jTMsLeRrwDcT2NSr_QOSEg";

/// The same staging key in the **v1** format — a bare base64url signature
/// over the license key, with no envelope and no payload. This is what
/// `pay2.futo.org` issues today, so it is the activation a real staging
/// purchase would hand a `.dev` build. Accepted alongside v2 (decision
/// 2026-09-10, issue #161); it carries no product, no purchase time and no
/// expiry, and none of those may be invented on its behalf.
const V1_ACTIVATION: &str = "bCGCpEu8pHvonpu0PS70awp-0mrKwow7FPDy583H8nAeqLc5_t7VjzyQzpKumfOX5sYQf9l2qjaGw5_LBdrBVjTYGi3sQhzHcIY2_s8SNZ5yGsFmWlDZjLrrp7yBY3l8GtV-kIoEpp9qfn3M5BNRcLtXzifP4Vqhn39H4czjimEpV_8yAeTVSOKoZC7icSTsucZ_0JdQuTCNVHJ6rkKd8UDnKsJiPreAymEFcXTSjKtGpLpMIf1TZELV_GkjRlg7cJF9uoneudD9rgPQM5j09kYmKSDnE8TarePm5JyCIM5HCXrBwOJGNh3qOhuediQb8yYu6u3cr06q6ZTqqeAIvw";

/// A `.dev` bundle id — what both native dev builds run under (M3).
const DEV_BUNDLE_ID: &str = "com.futo.notes.dev";
const RELEASE_BUNDLE_ID: &str = "com.futo.notes";

/// The fixture license's two instants, as the epoch milliseconds a shell
/// receives: 2026-01-15T10:30:00Z and 2029-01-15T10:30:00Z.
const ISSUED_AT_MILLIS: i64 = 1_768_473_000_000;
const EXPIRES_AT_MILLIS: i64 = 1_863_167_400_000;

fn instant(unix_seconds: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(unix_seconds).unwrap()
}

/// Inside the license's term (2026-09-09T12:00:00Z).
fn during_term() -> OffsetDateTime {
    instant(1_757_419_200)
}

/// Well past it (2030-02-01T00:00:00Z).
fn after_term() -> OffsetDateTime {
    instant(1_895_097_600)
}

fn pair(activation: &str) -> LicensePair {
    LicensePair {
        key: KEY.to_string(),
        activation: activation.to_string(),
    }
}

/// Records every URL it is asked for, so a test can assert not just the
/// answer but that the network was reached exactly as often as the spec
/// allows — which for every path except a bare key is zero times.
struct RecordingTransport {
    requests: Mutex<Vec<String>>,
    response: Result<HttpResponse, String>,
}

impl RecordingTransport {
    fn answering(status: u16, body: &str) -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            response: Ok(HttpResponse {
                status,
                body: body.to_string(),
            }),
        }
    }

    fn failing(message: &str) -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            response: Err(message.to_string()),
        }
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

impl ActivationTransport for RecordingTransport {
    fn get(&self, url: &str) -> Result<HttpResponse, TransportError> {
        self.requests.lock().unwrap().push(url.to_string());
        self.response.clone().map_err(TransportError::new)
    }
}

mod activation_flow;
mod crate_rule_mapping;
mod evaluation;
mod row_actions;
mod v1_activation;
