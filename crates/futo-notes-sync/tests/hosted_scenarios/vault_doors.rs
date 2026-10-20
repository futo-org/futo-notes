//! The no-vault and vault-exists shapes: create a vault, or unlock one.

use super::*;

// ── The no-vault shape: subscribe, create a vault, save the recovery key ──

/// The whole of the first wizard shape. Every step the person lands on is
/// computed from what the server says, and the recovery key comes back once.
pub async fn a_fresh_account_creates_a_vault(base: &str) {
    let secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    unentitled(&phone).await;

    assert_eq!(
        phone.current_step().await.expect("step"),
        SetupStep::Subscribe,
        "an account with no vault cannot skip subscribing: writing the vault key is gated"
    );
    subscribe(&phone).await;
    assert_eq!(
        phone.current_step().await.expect("step"),
        SetupStep::CreateVault
    );

    let recovery_key = phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");

    // Seven groups of four, which is what the save screen shows (ADR 0003,
    // decision 6).
    let groups: Vec<&str> = recovery_key.split('-').collect();
    assert_eq!(groups.len(), 7, "recovery key: {recovery_key}");
    assert!(groups.iter().all(|group| group.len() == 4));

    assert_eq!(phone.current_step().await.expect("step"), SetupStep::Ready);
    assert!(
        secrets.held_vault_key().is_some(),
        "the device kept the key"
    );
    assert!(secrets.held_token().is_some(), "the device kept the token");

    // The vault password is typed once and forgotten. Nothing this device
    // wrote to its secret store is it.
    assert!(
        !secrets
            .everything_written()
            .iter()
            .any(|written| written.contains(VAULT_PASSWORD)),
        "the vault password reached the secret store"
    );
}

/// The recovery key is handed over once and there is no second way to ask for
/// it: creating again is refused, because a second vault key would orphan
/// every note already encrypted under the first.
pub async fn the_recovery_key_cannot_be_asked_for_twice(base: &str) {
    let secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;
    phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");

    assert_eq!(
        phone.create_vault(VAULT_PASSWORD).await.unwrap_err(),
        HostedError::VaultAlreadyExists
    );
    // Not even from a fresh setup that has forgotten this attempt entirely.
    assert_eq!(
        reopened(base, &secrets)
            .create_vault(VAULT_PASSWORD)
            .await
            .unwrap_err(),
        HostedError::VaultAlreadyExists
    );
}

/// Writing the vault key is entitlement-gated, so an account that has not paid
/// is told that in as many words rather than meeting a bare `402` later.
pub async fn creating_a_vault_without_a_subscription_is_refused(base: &str) {
    let secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    unentitled(&phone).await;

    assert_eq!(
        phone.create_vault(VAULT_PASSWORD).await.unwrap_err(),
        HostedError::NotEntitled
    );
    assert!(
        secrets.held_vault_key().is_none(),
        "a refused create kept a key for a vault that does not exist"
    );
    assert_eq!(
        phone.current_step().await.expect("step"),
        SetupStep::Subscribe
    );
}

/// The length rule lives in the engine, so three shells cannot each pick their
/// own — and nothing is sent for a password that would be refused.
pub async fn a_short_vault_password_is_refused_before_anything_is_written(base: &str) {
    let secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;

    assert_eq!(
        phone.create_vault("short").await.unwrap_err(),
        HostedError::VaultPasswordTooShort { minimum: 12 }
    );
    assert_eq!(
        phone.current_step().await.expect("step"),
        SetupStep::CreateVault,
        "a refused password left the wizard where it was"
    );
}

// ── The vault-exists shape: a second device unlocks ──

/// A second device on the same account is offered the unlock step, and the
/// vault password opens it. A wrong one is its own answer, and leaves the
/// device exactly where it was.
pub async fn a_second_device_unlocks_with_the_vault_password(base: &str) {
    let (first_secrets, laptop, secrets) = a_vault_and_a_new_device(base).await;

    assert_eq!(
        laptop.current_step().await.expect("step"),
        SetupStep::Unlock
    );
    assert_eq!(
        laptop
            .unlock_with_vault_password("not the vault password")
            .await
            .unwrap_err(),
        HostedError::WrongVaultPassword
    );
    assert_eq!(
        laptop.current_step().await.expect("step"),
        SetupStep::Unlock,
        "a wrong password is not a half-unlocked device"
    );

    laptop
        .unlock_with_vault_password(VAULT_PASSWORD)
        .await
        .expect("unlock");

    assert_eq!(laptop.current_step().await.expect("step"), SetupStep::Ready);
    assert_eq!(
        secrets.held_vault_key(),
        first_secrets.held_vault_key(),
        "both devices hold the same vault key, or they cannot read each other's notes"
    );
}

/// The third door. A device that has lost the vault password gets in with the
/// recovery key, and ends up indistinguishable from one that typed the
/// password.
pub async fn a_second_device_unlocks_with_the_recovery_key(base: &str) {
    let first_secrets = DeviceSecrets::new();
    let phone = device_signed_in(base, &first_secrets).await;
    without_a_vault(&phone).await;
    entitled(&phone).await;
    let recovery_key = phone
        .create_vault(VAULT_PASSWORD)
        .await
        .expect("create the vault");

    let secrets = DeviceSecrets::new();
    let laptop = device_signed_in(base, &secrets).await;
    assert_eq!(
        laptop.current_step().await.expect("step"),
        SetupStep::Unlock
    );

    // A real recovery key — check character and all — for some other vault.
    let someone_elses = another_recovery_key(&recovery_key);
    assert_eq!(
        laptop
            .unlock_with_recovery_key(&someone_elses)
            .await
            .unwrap_err(),
        HostedError::WrongRecoveryKey
    );

    laptop
        .unlock_with_recovery_key(&recovery_key)
        .await
        .expect("unlock with the recovery key");

    assert_eq!(laptop.current_step().await.expect("step"), SetupStep::Ready);
    assert_eq!(secrets.held_vault_key(), first_secrets.held_vault_key());
}
