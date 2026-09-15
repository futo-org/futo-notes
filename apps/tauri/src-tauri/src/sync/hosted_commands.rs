//! Desktop command surface for hosted sync setup.
//!
//! The engine owns the sequence (`futo_notes_sync::HostedSetup`). These
//! commands hold the one attempt in progress and forward to it, so the
//! frontend's whole job is to open a URL in the system browser and render what
//! comes back — there is no ordering rule on this side to get wrong.

use std::sync::{Arc, Mutex};

use futo_notes_sync::HostedSetup;
use tauri::State;

use super::frontend_contract::{
    BillingStatusOutput, CheckoutOutput, EntitlementOutcomeOutput, HostedErrorOutput,
    HostedSessionOutput, SignInFlowOutput, SignInHandoffOutput, SignInOutcomeOutput,
};
use crate::application_state::AppState;

/// The hosted setup attempt in progress, if any.
#[derive(Default)]
pub(crate) struct HostedSetupState(Mutex<Option<Arc<HostedSetup>>>);

impl HostedSetupState {
    fn replace(&self, setup: Arc<HostedSetup>) {
        *self.0.lock().expect("hosted setup lock") = Some(setup);
    }

    /// The running attempt. The guard is released before the caller awaits
    /// anything, so a long poll never blocks `cancel_wait`.
    fn current(&self) -> Result<Arc<HostedSetup>, HostedErrorOutput> {
        self.0
            .lock()
            .expect("hosted setup lock")
            .clone()
            .ok_or(HostedErrorOutput::NotSignedIn)
    }
}

/// Where hosted sync lives. Compiled in; a debug build can point elsewhere.
#[tauri::command]
pub async fn e2ee_hosted_server_url() -> Result<String, HostedErrorOutput> {
    Ok(futo_notes_sync::hosted_server())
}

/// Which sign-in a server wants — hosted, password, or dev.
#[tauri::command]
pub async fn e2ee_hosted_probe(server_url: String) -> Result<SignInFlowOutput, HostedErrorOutput> {
    futo_notes_sync::probe_sign_in_flow(&server_url)
        .await
        .map(Into::into)
        .map_err(Into::into)
}

/// Starts an attempt and mints a Login Hand-off. Open the returned `url` in
/// the system browser, then call `e2ee_hosted_await_sign_in` with the handoff.
///
/// Calling this again abandons the previous attempt, which is what a person
/// pressing the button a second time means.
#[tauri::command]
pub async fn e2ee_hosted_begin_sign_in(
    state: State<'_, AppState>,
    server_url: Option<String>,
) -> Result<SignInHandoffOutput, HostedErrorOutput> {
    let setup = Arc::new(match server_url {
        Some(url) => HostedSetup::at(&url)?,
        None => HostedSetup::hosted()?,
    });
    state.hosted.replace(Arc::clone(&setup));
    let handoff = setup.begin_sign_in().await?;
    Ok(SignInHandoffOutput {
        url: handoff.url,
        ticket: handoff.ticket,
    })
}

/// Waits for the person to finish in the browser.
#[tauri::command]
pub async fn e2ee_hosted_await_sign_in(
    state: State<'_, AppState>,
    handoff: SignInHandoffOutput,
) -> Result<SignInOutcomeOutput, HostedErrorOutput> {
    let setup = state.hosted.current()?;
    let handoff = futo_notes_sync::SignInHandoff {
        url: handoff.url,
        ticket: handoff.ticket,
    };
    Ok(setup.await_sign_in(&handoff).await?.into())
}

/// Stops whichever wait is running — what closing the browser window means.
#[tauri::command]
pub async fn e2ee_hosted_cancel_wait(state: State<'_, AppState>) -> Result<(), HostedErrorOutput> {
    if let Ok(setup) = state.hosted.current() {
        setup.cancel_wait();
    }
    Ok(())
}

/// Who is signed in on this attempt.
#[tauri::command]
pub async fn e2ee_hosted_session(
    state: State<'_, AppState>,
) -> Result<Option<HostedSessionOutput>, HostedErrorOutput> {
    Ok(state.hosted.current()?.session().map(Into::into))
}

#[tauri::command]
pub async fn e2ee_hosted_billing_status(
    state: State<'_, AppState>,
) -> Result<BillingStatusOutput, HostedErrorOutput> {
    let setup = state.hosted.current()?;
    setup
        .billing_status()
        .await
        .map(Into::into)
        .map_err(Into::into)
}

/// Starts a subscription. An account that may already write gets its billing
/// status back instead of a URL.
#[tauri::command]
pub async fn e2ee_hosted_begin_checkout(
    state: State<'_, AppState>,
) -> Result<CheckoutOutput, HostedErrorOutput> {
    let setup = state.hosted.current()?;
    setup
        .begin_checkout()
        .await
        .map(Into::into)
        .map_err(Into::into)
}

/// Waits for the checkout to make the account entitled.
#[tauri::command]
pub async fn e2ee_hosted_await_entitled(
    state: State<'_, AppState>,
) -> Result<EntitlementOutcomeOutput, HostedErrorOutput> {
    let setup = state.hosted.current()?;
    setup
        .await_entitled()
        .await
        .map(Into::into)
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every step that needs an attempt says so as a variant, rather than
    /// panicking or reporting a network failure that never happened.
    #[test]
    fn a_step_before_sign_in_began_reports_not_signed_in() {
        let state = HostedSetupState::default();
        assert!(matches!(
            state.current().err(),
            Some(HostedErrorOutput::NotSignedIn)
        ));
    }

    /// Pressing "Log in with FUTO" again replaces the attempt rather than
    /// leaving two in flight.
    #[test]
    fn beginning_again_replaces_the_attempt() {
        let state = HostedSetupState::default();
        state.replace(Arc::new(
            HostedSetup::at("https://one.example").expect("setup"),
        ));
        state.replace(Arc::new(
            HostedSetup::at("https://two.example").expect("setup"),
        ));
        assert_eq!(
            state.current().expect("an attempt").server_url(),
            "https://two.example"
        );
    }
}
