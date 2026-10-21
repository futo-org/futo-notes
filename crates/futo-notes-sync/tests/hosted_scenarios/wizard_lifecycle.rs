//! Where the wizard resumes, signing out, and starting to sync.

use super::*;

// ── Where the wizard resumes, and signing out ──

/// The criterion that kills a stored wizard position: quit at each step,
/// reopen with nothing but the secret store, and land on the step the server's
/// own facts imply.
pub async fn quitting_mid_wizard_resumes_at_the_right_step(base: &str) {
    // Quit right after signing in.
    let secrets = DeviceSecrets::new();
    let signing_in = device_signed_in(base, &secrets).await;
    without_a_vault(&signing_in).await;
    unentitled(&signing_in).await;
    drop(signing_in);

    assert_eq!(
        reopened(base, &secrets).current_step().await.expect("step"),
        SetupStep::Subscribe,
        "a signed-in device with no vault and no subscription"
    );

    // Quit right after paying.
    let paying = reopened(base, &secrets);
    subscribe(&paying).await;
    drop(paying);
    assert_eq!(
        reopened(base, &secrets).current_step().await.expect("step"),
        SetupStep::CreateVault,
        "entitled, still no vault"
    );

    // Quit right after creating the vault: it is the device holding the key
    // that decides, and this one does.
    let creating = reopened(base, &secrets);
    creating
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");
    drop(creating);
    assert_eq!(
        reopened(base, &secrets).current_step().await.expect("step"),
        SetupStep::Ready,
        "a cold start on a set-up device asks for nothing"
    );

    // The same account seen by a device that never unlocked.
    secrets.forget_vault_key();
    assert_eq!(
        reopened(base, &secrets).current_step().await.expect("step"),
        SetupStep::Unlock,
        "the vault exists but this device does not hold its key"
    );
}

/// Sign out is one action: the session is revoked, both secrets are gone, and
/// this vault's live sync state is demoted exactly as disconnect does — no
/// locked-but-signed-in state left behind (ADR 0003, decision 9).
pub async fn signing_out_forgets_the_key_the_token_and_the_live_state(base: &str) {
    let secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;
    phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");

    let root = live_vault();
    let sync = SyncSession::new();

    phone.sign_out(&sync, &root).await.expect("sign out");

    assert_eq!(secrets.held_vault_key(), None, "the vault key was kept");
    assert_eq!(secrets.held_token(), None, "the session token was kept");
    assert!(
        !root.join(".e2ee-state.json").exists(),
        "live sync state survived a sign out"
    );
    // Demoted, not merely deleted: what was already pushed survives as
    // ancestry, so a later sign-in reconciles against it instead of reading
    // local absence as a fleet-wide delete.
    let ancestry = std::fs::read_to_string(root.join(".e2ee-ancestry.json"))
        .expect("sign out left no ancestry behind");
    assert!(
        ancestry.contains("grocery list.md") && ancestry.contains("hash-of-the-list"),
        "ancestry lost what this vault had already pushed: {ancestry}"
    );
    assert_eq!(
        reopened(base, &secrets).current_step().await.expect("step"),
        SetupStep::SignIn,
        "a signed-out device starts at the beginning"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// The end of the wizard is a running sync, not a set-up vault that sits
/// there: a device holding the vault key and the session token hands both to
/// the sync engine and is connected, with the checkpoint on disk to prove it.
/// Whichever door unlocked the vault, this is the same call.
pub async fn a_set_up_vault_starts_syncing(base: &str) {
    let secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;
    phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");
    assert_eq!(phone.current_step().await.expect("step"), SetupStep::Ready);

    let root = fresh_vault();
    let sync = SyncSession::new();
    assert!(!sync.is_connected().await, "connected before connecting");

    phone
        .connect_sync(&sync, &root)
        .await
        .expect("connect sync");

    assert!(
        sync.is_connected().await,
        "the wizard finished without a session to sync with"
    );
    let state = sync.snapshot().await.expect("a connected session");
    assert_eq!(
        Some(state.collection_id.clone()),
        phone.collection_id(),
        "the sync session is pointed at a different vault than the wizard set up"
    );
    assert_eq!(
        Some(state.vault_key),
        secrets.held_vault_key(),
        "the sync session is not using this device's vault key"
    );
    let checkpoint = std::fs::read_to_string(root.join(".e2ee-state.json"))
        .expect("connecting left no checkpoint, so a restart would lose the collection");
    assert!(checkpoint.contains(&state.collection_id), "{checkpoint}");

    // Calling it again is the same session, not a second one: a shell may call
    // it whenever it notices an unlocked vault.
    phone
        .connect_sync(&sync, &root)
        .await
        .expect("connect again");
    assert!(sync.is_connected().await);

    std::fs::remove_dir_all(&root).ok();
}

/// The cold-start question, end to end: a device that finished the wizard says
/// so from its secret store alone, and a device that signed out says no.
///
/// The read is proved local by asking it through a setup pointed at a port
/// nothing listens on — a `current_step` or a `connect_sync` there would answer
/// `Network`, which is exactly why a shell restoring a session at launch cannot
/// use either.
pub async fn a_finished_wizard_is_recognised_without_the_network(base: &str) {
    let secrets = DeviceSecrets::new();
    let offline = || {
        HostedSetup::at("http://127.0.0.1:9")
            .expect("hosted setup")
            .with_secrets(Arc::clone(&secrets) as Arc<dyn VaultSecrets>)
    };
    assert!(
        !offline().has_saved_vault().await.expect("read"),
        "a device that has never been set up reported a saved vault"
    );

    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;
    phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");

    assert!(
        offline().has_saved_vault().await.expect("read"),
        "a finished wizard left nothing a cold start could recognize"
    );

    let root = fresh_vault();
    phone
        .sign_out(&SyncSession::new(), &root)
        .await
        .expect("sign out");
    assert!(
        !offline().has_saved_vault().await.expect("read"),
        "a signed-out device would try to resume a session it no longer has"
    );
    std::fs::remove_dir_all(&root).ok();
}

/// A device that has not unlocked has nothing to sync with, and says so rather
/// than connecting a session with no key in it.
pub async fn a_locked_device_cannot_start_syncing(base: &str) {
    let secrets = DeviceSecrets::new();
    secrets.hold_sync_password(A_SELF_HOSTED_PASSWORD);
    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;
    phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");
    secrets.forget_vault_key();

    let root = fresh_vault();
    let sync = SyncSession::new();
    assert_eq!(
        reopened(base, &secrets)
            .connect_sync(&sync, &root)
            .await
            .unwrap_err(),
        HostedError::VaultLocked
    );
    assert!(!sync.is_connected().await);
    // Nothing was finished, so the way back to this person's own server is
    // still here. Only a hosted session that actually started may take it.
    assert_eq!(
        secrets.held_sync_password().as_deref(),
        Some(A_SELF_HOSTED_PASSWORD),
        "a hosted connect that refused still threw away the self-hosted password",
    );
    std::fs::remove_dir_all(&root).ok();
}

/// One sync credential at a time. A device that has ever connected to
/// someone's own server keeps that sync password, and it is app-global rather
/// than per-vault — so a shell restoring a session at launch cannot tell from
/// its presence which kind of vault this is. Every shell resolves that by
/// trying the password first, which on a device that later moved to hosted
/// sync meant dialing the old self-hosted server at every launch and never
/// reaching the hosted session at all (device QA, 2026-09-16).
///
/// The rule that removes the ambiguity: finishing hosted setup clears the
/// password, so whichever mode was set up last wins. It lives here, in the one
/// call every shell makes to start a hosted session, rather than three times
/// over in Swift, Kotlin and TypeScript.
pub async fn finishing_hosted_setup_clears_the_self_hosted_password(base: &str) {
    let secrets = DeviceSecrets::new();
    secrets.hold_sync_password(A_SELF_HOSTED_PASSWORD);
    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;
    phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");

    // Reaching the end of the wizard is not yet the moment: someone who opens
    // the hosted screen, signs in and stops there still has their own server
    // to go back to.
    assert_eq!(phone.current_step().await.expect("step"), SetupStep::Ready);
    assert_eq!(
        secrets.held_sync_password().as_deref(),
        Some(A_SELF_HOSTED_PASSWORD),
        "the self-hosted password went away before a hosted session had started",
    );

    let root = fresh_vault();
    let sync = SyncSession::new();
    phone
        .connect_sync(&sync, &root)
        .await
        .expect("connect sync");

    assert!(sync.is_connected().await);
    assert_eq!(
        secrets.held_sync_password(),
        None,
        "a connected hosted device is still holding a self-hosted sync password, \
         so its next launch reconnects to the old server instead of resuming this session",
    );

    // Still gone across the repeat connect every launch makes, and the hosted
    // secrets are untouched by the clearing.
    phone
        .connect_sync(&sync, &root)
        .await
        .expect("connect again");
    assert_eq!(secrets.held_sync_password(), None);
    assert!(secrets.held_vault_key().is_some());
    assert!(secrets.held_token().is_some());

    std::fs::remove_dir_all(&root).ok();
}
