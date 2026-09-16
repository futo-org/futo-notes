//! The hosted setup flow against an in-test stub of the server's hosted
//! routes. This is the run CI gets; the identical scenarios also run against a
//! real server in `server_integration.rs` when `FUTO_TEST_SERVER` points at
//! one in stand-in test mode.
//!
//! Each test gets its own stub, so the account state one scenario leaves
//! behind cannot reach the next.

mod hosted_scenarios;
mod hosted_stub;

use hosted_scenarios as scenarios;
use hosted_stub::HostedStub;

macro_rules! against_the_stub {
    ($($name:ident,)+) => {
        $(
            #[tokio::test]
            async fn $name() {
                let stub = HostedStub::start().await;
                scenarios::$name(&stub.url()).await;
            }
        )+
    };
}

against_the_stub! {
    the_probe_offers_hosted_sign_in,
    sign_in_then_subscribe,
    a_dismissed_sheet_cancels_the_wait,
    a_spent_ticket_is_reported_as_expired,
    an_entitled_account_is_not_sent_to_pay_again,
    the_account_card_can_open_the_billing_portal,
    a_lapsed_subscription_is_readable_and_not_a_sign_out,
    a_fresh_account_creates_a_vault,
    the_recovery_key_cannot_be_asked_for_twice,
    creating_a_vault_without_a_subscription_is_refused,
    a_short_vault_password_is_refused_before_anything_is_written,
    a_second_device_unlocks_with_the_vault_password,
    a_second_device_unlocks_with_the_recovery_key,
    quitting_mid_wizard_resumes_at_the_right_step,
    signing_out_forgets_the_key_the_token_and_the_live_state,
    a_set_up_vault_starts_syncing,
    a_locked_device_cannot_start_syncing,
    pairing_hands_the_vault_key_to_a_new_device,
    a_scanned_code_sends_nothing_until_the_person_confirms,
    a_scan_that_is_not_a_pairing_code_sends_nothing,
    a_pairing_this_account_cannot_reach_is_refused,
    a_pairing_can_only_be_answered_once,
    collecting_the_key_spends_the_pairing,
    leaving_the_pairing_screen_cancels_the_wait,
    // Stub-only: a stand-in server has one identity and a fixed five-minute
    // window, so neither of these can be reached against one. Everything else
    // about pairing runs both ways.
    an_expired_pairing_code_is_its_own_error,
    another_accounts_live_pairing_is_refused,
}
