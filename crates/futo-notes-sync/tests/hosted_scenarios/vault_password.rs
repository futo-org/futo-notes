//! Changing the vault password, and issuing a new recovery key.

use super::*;

// ── Changing the vault password, and issuing a new recovery key ───────────
//
// Both are ordinary re-wraps of the same vault key, asked for from the account
// card, and neither asks for the current secret: the device holds the key, and
// a device paired by QR never knew the password (ADR 0003, decision 10).

/// A new vault password opens the vault; the old one stops. Nobody was asked
/// for the old one (parent spec user story 31).
pub async fn a_new_vault_password_replaces_the_old_one(base: &str) {
    let secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;
    phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");
    let vault_key = secrets.held_vault_key().expect("a key after create");

    assert_eq!(
        phone.change_vault_password("short").await.unwrap_err(),
        HostedError::VaultPasswordTooShort { minimum: 12 },
        "the engine's own minimum guards the re-wrap too",
    );

    phone
        .change_vault_password(NEW_VAULT_PASSWORD)
        .await
        .expect("change the vault password");

    assert_eq!(
        secrets.held_vault_key(),
        Some(vault_key),
        "changing the password changed the vault key, which would strand every note already stored",
    );
    assert_eq!(
        phone.current_step().await.expect("step"),
        SetupStep::Ready,
        "a password change is not a re-setup of the device that made it",
    );

    // A device that was never here proves which password the vault now takes.
    let laptop = device_signed_in(base, &DeviceSecrets::new()).await;
    assert_eq!(
        laptop
            .unlock_with_vault_password(VAULT_PASSWORD)
            .await
            .unwrap_err(),
        HostedError::WrongVaultPassword,
        "the old vault password still opens the vault",
    );
    laptop
        .unlock_with_vault_password(NEW_VAULT_PASSWORD)
        .await
        .expect("unlock with the new vault password");
    assert_eq!(laptop.current_step().await.expect("step"), SetupStep::Ready);

    assert!(
        !secrets
            .everything_written()
            .iter()
            .any(|written| written == VAULT_PASSWORD || written == NEW_VAULT_PASSWORD),
        "a vault password reached the secret store",
    );
}

/// The recovery door survives a password change. This is the hazard server ADR
/// 0006 spells out: a `PUT` replaces both envelopes, so re-wrapping only the
/// password one without sending the recovery envelope back would silently
/// destroy a working way into the vault.
pub async fn changing_the_vault_password_keeps_the_recovery_key_working(base: &str) {
    let phone = device_signed_in(base, &DeviceSecrets::new()).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;
    let recovery_key = phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");

    phone
        .change_vault_password(NEW_VAULT_PASSWORD)
        .await
        .expect("change the vault password");

    let laptop = device_signed_in(base, &DeviceSecrets::new()).await;
    laptop
        .unlock_with_recovery_key(&recovery_key)
        .await
        .expect("the recovery key still opens the vault after a password change");
    assert_eq!(laptop.current_step().await.expect("step"), SetupStep::Ready);
}

/// A new recovery key works and the old one stops, while the vault password is
/// untouched — the mirror image of the scenario above (parent spec user story
/// 32).
pub async fn a_new_recovery_key_invalidates_the_old_one(base: &str) {
    let secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;
    let first = phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");
    let vault_key = secrets.held_vault_key().expect("a key after create");

    let second = phone
        .new_recovery_key()
        .await
        .expect("issue a new recovery key");
    assert_ne!(second, first, "the same recovery key came back twice");
    assert_eq!(
        secrets.held_vault_key(),
        Some(vault_key),
        "a new recovery key changed the vault key",
    );

    let laptop = device_signed_in(base, &DeviceSecrets::new()).await;
    assert_eq!(
        laptop.unlock_with_recovery_key(&first).await.unwrap_err(),
        HostedError::WrongRecoveryKey,
        "the old recovery key still opens the vault",
    );
    laptop
        .unlock_with_recovery_key(&second)
        .await
        .expect("unlock with the new recovery key");

    // The password envelope went back unchanged in the same write.
    let desktop = device_signed_in(base, &DeviceSecrets::new()).await;
    desktop
        .unlock_with_vault_password(VAULT_PASSWORD)
        .await
        .expect("the vault password still opens the vault");
}

/// Two devices, one revision token. The second one writes against what it last
/// read, is refused rather than overwriting, and lands on the retry — which is
/// the whole of "retry after re-read" (ADR 0003, decision 10).
pub async fn a_stale_key_revision_is_refused_and_clears_on_retry(base: &str) {
    let (_, laptop, _) = a_vault_and_a_new_device(base).await;
    laptop
        .unlock_with_vault_password(VAULT_PASSWORD)
        .await
        .expect("unlock the second device");

    // Both devices are looking at the same key material now.
    let phone = device_signed_in(base, &DeviceSecrets::new()).await;
    phone
        .unlock_with_vault_password(VAULT_PASSWORD)
        .await
        .expect("unlock the first device");
    assert_eq!(laptop.current_step().await.expect("step"), SetupStep::Ready);

    phone
        .change_vault_password(NEW_VAULT_PASSWORD)
        .await
        .expect("the first device changes the password");

    assert_eq!(
        laptop
            .change_vault_password(THIRD_VAULT_PASSWORD)
            .await
            .unwrap_err(),
        HostedError::VaultKeyChangedElsewhere,
        "the stale write landed, so the first device's change is gone",
    );
    // Nothing half-wrote: the vault still takes what the first device set.
    let bystander = device_signed_in(base, &DeviceSecrets::new()).await;
    bystander
        .unlock_with_vault_password(NEW_VAULT_PASSWORD)
        .await
        .expect("the refused write left the first device's password in place");

    // The same press again, with no re-read asked of the caller.
    laptop
        .change_vault_password(THIRD_VAULT_PASSWORD)
        .await
        .expect("retrying after the conflict lands");
    let after = device_signed_in(base, &DeviceSecrets::new()).await;
    after
        .unlock_with_vault_password(THIRD_VAULT_PASSWORD)
        .await
        .expect("the retry's password opens the vault");
}

/// A new recovery key is guarded the same way, by the same revision token.
pub async fn a_stale_recovery_key_revision_is_refused(base: &str) {
    let (_, laptop, _) = a_vault_and_a_new_device(base).await;
    laptop
        .unlock_with_vault_password(VAULT_PASSWORD)
        .await
        .expect("unlock the second device");
    assert_eq!(laptop.current_step().await.expect("step"), SetupStep::Ready);

    let phone = device_signed_in(base, &DeviceSecrets::new()).await;
    phone
        .unlock_with_vault_password(VAULT_PASSWORD)
        .await
        .expect("unlock the first device");
    let from_the_phone = phone
        .new_recovery_key()
        .await
        .expect("the first device issues a new recovery key");

    assert_eq!(
        laptop.new_recovery_key().await.unwrap_err(),
        HostedError::VaultKeyChangedElsewhere,
    );
    let from_the_laptop = laptop
        .new_recovery_key()
        .await
        .expect("retrying after the conflict lands");

    let fresh = device_signed_in(base, &DeviceSecrets::new()).await;
    assert_eq!(
        fresh
            .unlock_with_recovery_key(&from_the_phone)
            .await
            .unwrap_err(),
        HostedError::WrongRecoveryKey,
        "the refused device's retry did not replace the envelope",
    );
    fresh
        .unlock_with_recovery_key(&from_the_laptop)
        .await
        .expect("the retry's recovery key opens the vault");
}

/// A device that does not hold the vault key has nothing to re-wrap, and says
/// so rather than asking for a password it could not use anyway.
pub async fn a_locked_device_cannot_change_the_vault_password(base: &str) {
    let (_, laptop, _) = a_vault_and_a_new_device(base).await;
    assert_eq!(
        laptop.current_step().await.expect("step"),
        SetupStep::Unlock
    );
    assert_eq!(
        laptop
            .change_vault_password(NEW_VAULT_PASSWORD)
            .await
            .unwrap_err(),
        HostedError::VaultLocked
    );
    assert_eq!(
        laptop.new_recovery_key().await.unwrap_err(),
        HostedError::VaultLocked
    );
}

/// Two devices, both set up, one of them then holding a live sync session.
async fn a_vault_on_two_devices(
    base: &str,
) -> (
    Arc<DeviceSecrets>,
    Arc<HostedSetup>,
    Arc<DeviceSecrets>,
    Arc<HostedSetup>,
) {
    let phone_secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &phone_secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;
    phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");

    let laptop_secrets = DeviceSecrets::new();
    let laptop = device_signed_in(base, &laptop_secrets).await;
    laptop
        .unlock_with_vault_password(VAULT_PASSWORD)
        .await
        .expect("unlock the second device");
    (phone_secrets, phone, laptop_secrets, laptop)
}

/// User story 33: changing the vault password on one device reaches no other
/// one. The second device's key, its step, and its live session are all
/// exactly where they were, and nobody told it anything happened.
pub async fn changing_the_vault_password_leaves_another_device_untouched(base: &str) {
    let (phone_secrets, phone, laptop_secrets, laptop) = a_vault_on_two_devices(base).await;

    let root = fresh_vault();
    let sync = SyncSession::new();
    laptop
        .connect_sync(&sync, &root)
        .await
        .expect("connect the second device's sync");
    let before = sync.snapshot().await.expect("a connected session");

    phone
        .change_vault_password(NEW_VAULT_PASSWORD)
        .await
        .expect("the other device changes the vault password");

    assert_eq!(
        laptop_secrets.held_vault_key(),
        phone_secrets.held_vault_key(),
        "the vault key moved out from under a device that was not asked",
    );
    assert!(sync.is_connected().await, "the running session was demoted");
    let after = sync.snapshot().await.expect("still a connected session");
    assert_eq!(
        after.vault_key, before.vault_key,
        "the live session's vault key changed under it",
    );
    assert_eq!(after.collection_id, before.collection_id);
    assert_eq!(
        laptop.current_step().await.expect("step"),
        SetupStep::Ready,
        "a password change on another device sent this one back to the wizard",
    );

    std::fs::remove_dir_all(&root).ok();
}

/// The same story with the part a person would actually notice: the untouched
/// device still pushes a note after the change. Real-server only — the hosted
/// stub mounts the setup routes and nothing else, so there is no object API on
/// it to sync against.
#[allow(
    dead_code,
    reason = "registered by the real-server runner alone; see the doc comment"
)]
pub async fn changing_the_vault_password_leaves_another_device_syncing(base: &str) {
    let (phone_secrets, phone, laptop_secrets, laptop) = a_vault_on_two_devices(base).await;

    // The second device syncs, the way a real one does.
    let root = fresh_vault();
    let sync = SyncSession::new();
    laptop
        .connect_sync(&sync, &root)
        .await
        .expect("connect the second device's sync");
    std::fs::write(root.join("before.md"), "written before the change").expect("write a note");
    let before = sync_once(&sync, &root).await;
    assert_eq!(before.uploaded, 1, "{before:?}");

    phone
        .change_vault_password(NEW_VAULT_PASSWORD)
        .await
        .expect("the other device changes the vault password");

    // Nothing reached this device: same key, same session, same step.
    assert_eq!(
        laptop_secrets.held_vault_key(),
        phone_secrets.held_vault_key(),
        "the vault key moved out from under a device that was not asked",
    );
    assert!(sync.is_connected().await, "the running session was demoted");
    assert_eq!(
        laptop.current_step().await.expect("step"),
        SetupStep::Ready,
        "a password change on another device sent this one back to the wizard",
    );

    // And it still syncs, which is the part a person would notice.
    std::fs::write(root.join("after.md"), "written after the change").expect("write a note");
    let after = sync_once(&sync, &root).await;
    assert_eq!(after.uploaded, 1, "{after:?}");
    assert!(after.failures.is_empty(), "{after:?}");

    std::fs::remove_dir_all(&root).ok();
}

/// One ordinary sync cycle, with the progress and pre-write hooks a shell
/// passes doing nothing.
async fn sync_once(sync: &SyncSession, root: &std::path::Path) -> futo_notes_sync::SyncSummary {
    let progress: &futo_notes_sync::Progress = &|_| {};
    let pre_write: &futo_notes_sync::PreWrite = &|_| {};
    sync.sync(root, progress, pre_write)
        .await
        .expect("a sync cycle")
}
