//! Desktop command surface for hosted sync setup.
//!
//! The engine owns the sequence (`futo_notes_sync::HostedSetup`). These
//! commands hold the one attempt in progress and forward to it, so the
//! frontend's whole job is to open a URL in the system browser and render what
//! comes back — there is no ordering rule on this side to get wrong.

use std::sync::{Arc, Mutex};

use futo_notes_sync::HostedSetup;
use tauri::{AppHandle, State};

use super::frontend_contract::{
    BillingStatusOutput, CheckoutOutput, EntitlementOutcomeOutput, HostedErrorOutput,
    HostedSessionOutput, SetupStepOutput, SignInFlowOutput, SignInHandoffOutput,
    SignInOutcomeOutput,
};
use super::password_store::KeyringVaultSecrets;
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

    /// The running attempt, or a fresh one over this vault's keyring entries.
    ///
    /// A cold start has no attempt and no session in memory, yet must be able
    /// to answer which screen to show — so asking for the step builds the
    /// attempt rather than refusing. The saved session token does the rest.
    fn adopt_or_build(
        &self,
        app: &AppHandle,
        server_url: Option<&str>,
    ) -> Result<Arc<HostedSetup>, HostedErrorOutput> {
        let mut slot = self.0.lock().expect("hosted setup lock");
        if let Some(setup) = slot.clone() {
            return Ok(setup);
        }
        let setup = Arc::new(build(app, server_url)?);
        *slot = Some(Arc::clone(&setup));
        Ok(setup)
    }
}

/// Which vault this hosted setup is for. Everything the setup keeps is scoped
/// to it, so a failure to resolve it is a failure to reach the secret store —
/// there is nowhere for a key to go, and nothing was kept.
fn vault_root(app: &AppHandle) -> Result<std::path::PathBuf, HostedErrorOutput> {
    crate::vault_location::root(app).map_err(|reason| HostedErrorOutput::SecretStore {
        reason: format!("this vault's location could not be resolved: {reason}"),
    })
}

/// A setup over this vault's keyring entries, so what it keeps survives a
/// restart and stays scoped to one notes root (M3).
fn build(app: &AppHandle, server_url: Option<&str>) -> Result<HostedSetup, HostedErrorOutput> {
    let root = vault_root(app)?;
    let setup = match server_url {
        Some(url) => HostedSetup::at(url)?,
        None => HostedSetup::hosted()?,
    };
    Ok(setup.with_secrets(Arc::new(KeyringVaultSecrets::for_vault(root))))
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
    app: AppHandle,
    state: State<'_, AppState>,
    server_url: Option<String>,
) -> Result<SignInHandoffOutput, HostedErrorOutput> {
    let setup = Arc::new(build(&app, server_url.as_deref())?);
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

/// Which screen the wizard is on. Safe as the very first call on a cold
/// start: it adopts this vault's saved session token rather than needing a
/// sign-in in this process, and nothing about where the person got to last
/// time is read, because nothing is written.
#[tauri::command]
pub async fn e2ee_hosted_current_step(
    app: AppHandle,
    state: State<'_, AppState>,
    server_url: Option<String>,
) -> Result<SetupStepOutput, HostedErrorOutput> {
    let setup = state.hosted.adopt_or_build(&app, server_url.as_deref())?;
    setup
        .current_step()
        .await
        .map(Into::into)
        .map_err(Into::into)
}

/// The shortest vault password the engine will create a vault with, so the
/// strength meter and the Continue button agree with what Rust does.
#[tauri::command]
pub async fn e2ee_hosted_min_vault_password_length() -> Result<u32, HostedErrorOutput> {
    Ok(futo_notes_sync::MIN_VAULT_PASSWORD_CHARS as u32)
}

/// Creates the vault and answers with its recovery key, formatted for the save
/// screen. **This is the only time it exists** — nothing here keeps a copy,
/// and a second call is refused.
#[tauri::command]
pub async fn e2ee_hosted_create_vault(
    state: State<'_, AppState>,
    vault_password: String,
) -> Result<String, HostedErrorOutput> {
    let setup = state.hosted.current()?;
    setup
        .create_vault(&vault_password)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub async fn e2ee_hosted_unlock_with_vault_password(
    state: State<'_, AppState>,
    vault_password: String,
) -> Result<(), HostedErrorOutput> {
    let setup = state.hosted.current()?;
    setup
        .unlock_with_vault_password(&vault_password)
        .await
        .map_err(Into::into)
}

/// A mistyped character is reported as a typo without anything leaving the
/// device.
#[tauri::command]
pub async fn e2ee_hosted_unlock_with_recovery_key(
    state: State<'_, AppState>,
    typed: String,
) -> Result<(), HostedErrorOutput> {
    let setup = state.hosted.current()?;
    setup
        .unlock_with_recovery_key(&typed)
        .await
        .map_err(Into::into)
}

/// One action: revoke the session, forget both secrets, and demote this
/// vault's sync state exactly as `e2ee_disconnect` does. The notes stay.
///
/// Like the step, this builds an attempt when the process has none. Sign out
/// is offered from the account card at any time, including as the first thing
/// after a restart, and refusing it there would leave the key and the token on
/// a device whose owner asked for them to be gone.
#[tauri::command]
pub async fn e2ee_hosted_sign_out(
    app: AppHandle,
    state: State<'_, AppState>,
    server_url: Option<String>,
) -> Result<(), HostedErrorOutput> {
    let root = vault_root(&app)?;
    let setup = state.hosted.adopt_or_build(&app, server_url.as_deref())?;
    setup.sign_out(&state.sync, &root).await.map_err(Into::into)
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
