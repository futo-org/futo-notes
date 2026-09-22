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
    HostedSessionOutput, PairingCodeOutput, PairingOutcomeOutput, ScannedPairingOutput,
    SetupStepOutput, SignInFlowOutput, SignInHandoffOutput, SignInOutcomeOutput,
};
use super::password_store::KeyringVaultSecrets;
use crate::application_state::AppState;

/// The hosted setup attempt in progress, if any, plus the scanned pairing code
/// waiting on a confirmation.
///
/// The scan is held **here** rather than handed to the frontend, which is what
/// makes the confirmation sheet a real gate on desktop: the frontend learns the
/// device name and nothing else, so there is no pairing id or public key it
/// could post a vault key to (parent spec user story 16).
#[derive(Default)]
pub(crate) struct HostedSetupState {
    setup: Mutex<Option<Arc<HostedSetup>>>,
    scanned: Mutex<Option<futo_notes_sync::PairingRequest>>,
}

impl HostedSetupState {
    fn replace(&self, setup: Arc<HostedSetup>) {
        *self.setup.lock().expect("hosted setup lock") = Some(setup);
    }

    /// The running attempt. The guard is released before the caller awaits
    /// anything, so a long poll never blocks `cancel_wait`.
    fn current(&self) -> Result<Arc<HostedSetup>, HostedErrorOutput> {
        self.setup
            .lock()
            .expect("hosted setup lock")
            .clone()
            .ok_or(HostedErrorOutput::NotSignedIn)
    }

    /// Holds the scan the confirmation sheet is about. A second scan replaces
    /// the first — what pointing the camera somewhere else means.
    fn hold_scan(&self, request: futo_notes_sync::PairingRequest) {
        *self.scanned.lock().expect("scanned pairing lock") = Some(request);
    }

    /// The scan a confirmation is confirming. Absent means the sheet was never
    /// reached, which is the one thing a confirm must not act on.
    fn held_scan(&self) -> Result<futo_notes_sync::PairingRequest, HostedErrorOutput> {
        self.scanned
            .lock()
            .expect("scanned pairing lock")
            .clone()
            .ok_or(HostedErrorOutput::PairingNotStarted)
    }

    fn forget_scan(&self) {
        *self.scanned.lock().expect("scanned pairing lock") = None;
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
        let mut slot = self.setup.lock().expect("hosted setup lock");
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

/// A URL for the payment provider's customer portal — what "Manage
/// subscription" and the "Vault is full" banner's button open. Minted per
/// press, so it is asked for at the moment the button is pressed rather than
/// carried alongside the billing status.
#[tauri::command]
pub async fn e2ee_hosted_billing_portal(
    state: State<'_, AppState>,
) -> Result<String, HostedErrorOutput> {
    let setup = state.hosted.current()?;
    setup.billing_portal().await.map_err(Into::into)
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

/// Sets a new vault password, from the account card. Asks for no current
/// secret: this device already holds the vault key, and a device paired by QR
/// never knew the old password. The vault key itself does not change, so every
/// other device carries on untouched.
///
/// `vaultKeyChangedElsewhere` means another device re-wrapped in between;
/// nothing was overwritten, and calling this again lands.
#[tauri::command]
pub async fn e2ee_hosted_change_vault_password(
    state: State<'_, AppState>,
    new_password: String,
) -> Result<(), HostedErrorOutput> {
    let setup = state.hosted.current()?;
    setup
        .change_vault_password(&new_password)
        .await
        .map_err(Into::into)
}

/// Issues a new recovery key and answers with it, for the same save screen the
/// wizard uses. **The old key stops working**, and like `e2ee_hosted_create_vault`
/// nothing here keeps a copy of what it returns.
#[tauri::command]
pub async fn e2ee_hosted_new_recovery_key(
    state: State<'_, AppState>,
) -> Result<String, HostedErrorOutput> {
    let setup = state.hosted.current()?;
    setup.new_recovery_key().await.map_err(Into::into)
}

/// What this computer calls itself on the other device's confirmation sheet.
///
/// The shell's job, not the engine's: iOS and Android read a name a person set
/// in Settings, and a desktop's equivalent is its hostname. A machine with no
/// readable hostname still has to say something, because the sheet names the
/// device it is about to hand a vault key to.
fn this_computer() -> String {
    gethostname::gethostname()
        .into_string()
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Desktop".to_owned())
}

/// Opens a pairing and returns the code for this device to show as a QR.
/// Called on the **new** device; follow it with `e2ee_hosted_await_pairing`.
///
/// `device_name` is optional because the desktop frontend has no way to know
/// what this computer is called — omitting it means "this computer's own name".
///
/// The one-time keypair's private half never leaves Rust.
#[tauri::command]
pub async fn e2ee_hosted_begin_pairing(
    state: State<'_, AppState>,
    device_name: Option<String>,
) -> Result<PairingCodeOutput, HostedErrorOutput> {
    let setup = state.hosted.current()?;
    let device_name = device_name
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(this_computer);
    let code = setup.begin_pairing(&device_name).await?;
    Ok(PairingCodeOutput {
        payload: code.payload,
        expires_at: code.expires_at,
    })
}

/// Reads what a scanner returned, on the **unlocked** device. Parsing only:
/// nothing is sent and no vault key is touched. Rust keeps the scan; the
/// frontend gets the name for the confirmation sheet and calls
/// `e2ee_hosted_confirm_pairing` if the person says yes.
#[tauri::command]
pub async fn e2ee_hosted_complete_pairing(
    state: State<'_, AppState>,
    scanned: String,
) -> Result<ScannedPairingOutput, HostedErrorOutput> {
    let setup = state.hosted.current()?;
    let request = setup.complete_pairing(&scanned)?;
    let shown = ScannedPairingOutput::from(&request);
    state.hosted.hold_scan(request);
    Ok(shown)
}

/// The confirm step: seals this device's vault key to the held scan and posts
/// it to the relay. The only call that sends a vault key anywhere.
#[tauri::command]
pub async fn e2ee_hosted_confirm_pairing(
    state: State<'_, AppState>,
) -> Result<(), HostedErrorOutput> {
    let setup = state.hosted.current()?;
    let request = state.hosted.held_scan()?;
    let sent = setup.confirm_pairing(&request).await;
    // One key per pairing either way: a delivered scan has nothing left to
    // send, and a refused one must not be retried from a stale sheet.
    state.hosted.forget_scan();
    sent.map_err(Into::into)
}

/// Waits on the **new** device for the other one to answer, then keeps the
/// key. `paired` means the vault is unlocked and `e2ee_hosted_current_step`
/// answers `ready`. `e2ee_hosted_cancel_wait` ends it.
#[tauri::command]
pub async fn e2ee_hosted_await_pairing(
    state: State<'_, AppState>,
) -> Result<PairingOutcomeOutput, HostedErrorOutput> {
    let setup = state.hosted.current()?;
    setup
        .await_pairing()
        .await
        .map(Into::into)
        .map_err(Into::into)
}

/// Hands this vault's hosted secrets to the sync engine, so a cycle can run.
/// The step after the wizard reaches `ready`, whichever door got it there.
///
/// Like the step and sign out, this builds an attempt when the process has
/// none: the frontend calls it the moment it sees an unlocked vault, which on
/// a restart is before anything else has begun one.
#[tauri::command]
pub async fn e2ee_hosted_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    server_url: Option<String>,
) -> Result<(), HostedErrorOutput> {
    let root = vault_root(&app)?;
    let setup = state.hosted.adopt_or_build(&app, server_url.as_deref())?;
    setup
        .connect_sync(&state.sync, &root)
        .await
        .map_err(Into::into)
}

/// Whether this vault has hosted secrets to resume, read from the OS secret
/// store with **no request of any kind**.
///
/// What the frontend asks at boot, before it is willing to spend a round trip
/// and while it may have no network at all. `e2ee_hosted_current_step` is not
/// it — that validates the saved token and resolves the collection over the
/// wire, so offline it answers a transport failure rather than "this vault is
/// hosted".
#[tauri::command]
pub async fn e2ee_hosted_has_saved_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    server_url: Option<String>,
) -> Result<bool, HostedErrorOutput> {
    let setup = state.hosted.adopt_or_build(&app, server_url.as_deref())?;
    setup.has_saved_vault().await.map_err(Into::into)
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

    /// Confirming without having scanned anything has nothing to post, and is
    /// refused rather than reaching the relay with whatever was last there.
    #[test]
    fn confirming_before_a_scan_has_nothing_to_send() {
        let state = HostedSetupState::default();
        assert!(matches!(
            state.held_scan().err(),
            Some(HostedErrorOutput::PairingNotStarted)
        ));
    }

    /// A scan is held for exactly one confirmation. Pointing the camera
    /// somewhere else replaces it, and a confirmation spends it — so a stale
    /// sheet cannot re-post a vault key.
    #[test]
    fn a_held_scan_is_replaced_by_the_next_one_and_spent_by_a_confirm() {
        let state = HostedSetupState::default();
        let setup = HostedSetup::at("https://pairing.example").expect("setup");
        let code = |name: &str| {
            format!(
                concat!(
                    r#"{{"futo_notes_pairing":1,"id":"pairing-1","#,
                    r#""public_key":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc","#,
                    r#""device_name":"{}","platform":"desktop"}}"#,
                ),
                name
            )
        };

        state.hold_scan(
            setup
                .complete_pairing(&code("Kitchen laptop"))
                .expect("scan"),
        );
        assert_eq!(
            state.held_scan().expect("held").device_name(),
            "Kitchen laptop"
        );

        state.hold_scan(setup.complete_pairing(&code("Studio iMac")).expect("scan"));
        assert_eq!(
            state.held_scan().expect("held").device_name(),
            "Studio iMac"
        );

        state.forget_scan();
        assert!(state.held_scan().is_err());
    }
}
