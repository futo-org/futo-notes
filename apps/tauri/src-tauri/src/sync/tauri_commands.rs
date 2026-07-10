//! Stable Tauri command surface for end-to-end encrypted sync.

use tauri::{AppHandle, State};

use super::frontend_contract::{
    E2eeConnectInput, E2eeConnectOutput, E2eeResumeInput, E2eeStatusOutput, SyncSummary,
};
use crate::application_state::AppState;

#[tauri::command]
pub async fn e2ee_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    input: E2eeConnectInput,
) -> Result<E2eeConnectOutput, String> {
    let root = crate::vault_location::root(&app)?;
    let (connected, result) =
        futo_notes_sync::connect(&root, &input.server_url, &input.password).await?;
    state.sync.set_connected(connected).await;
    Ok(E2eeConnectOutput {
        user_id: result.user_id,
        collection_id: result.collection_id,
        token: result.token,
        auth_mode: result.auth_mode.to_owned(),
    })
}

#[tauri::command]
pub async fn e2ee_resume(
    app: AppHandle,
    state: State<'_, AppState>,
    input: E2eeResumeInput,
) -> Result<(), String> {
    let root = crate::vault_location::root(&app)?;
    let connected = futo_notes_sync::resume(
        &root,
        &input.server_url,
        &input.token,
        &input.user_id,
        &input.collection_id,
        &input.password,
    )
    .await?;
    state.sync.set_connected(connected).await;
    Ok(())
}

#[tauri::command]
pub async fn e2ee_disconnect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let root = crate::vault_location::root(&app)?;
    state.sync.stop_live();
    state.sync.clear().await;
    // Preserve object/hash ancestry so reconnect can fast-forward unchanged
    // notes instead of manufacturing conflict copies.
    futo_notes_sync::state::demote_state_to_ancestry(&root)
}

#[tauri::command]
pub async fn e2ee_status(state: State<'_, AppState>) -> Result<E2eeStatusOutput, String> {
    Ok(E2eeStatusOutput::from_snapshot(state.sync.snapshot().await))
}

#[tauri::command]
pub async fn e2ee_sync_run(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SyncSummary, String> {
    super::cycle_runner::run_manual(&app, &state).await
}

#[tauri::command]
pub async fn e2ee_start_live(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    super::cycle_runner::start_live(&app, &state).await
}

#[tauri::command]
pub async fn e2ee_stop_live(_app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.sync.stop_live();
    Ok(())
}

#[tauri::command]
pub async fn e2ee_note_changed(state: State<'_, AppState>) -> Result<(), String> {
    state.sync.note_changed();
    Ok(())
}
