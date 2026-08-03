//! Stable Tauri command surface for end-to-end encrypted sync.

use tauri::{AppHandle, State};

use super::frontend_contract::{
    E2eeConnectInput, E2eeConnectOutput, E2eeResumeInput, E2eeStatusOutput,
    OpenNoteDispositionOutput, OpenNoteFactsInput, SyncSummary,
};
use crate::application_state::AppState;

#[tauri::command]
pub async fn e2ee_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    input: E2eeConnectInput,
) -> Result<E2eeConnectOutput, String> {
    let root = crate::vault_location::root(&app)?;
    let result = state
        .sync
        .connect(&root, &input.server_url, &input.password)
        .await?;
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
    state
        .sync
        .resume(
            &root,
            futo_notes_sync::ResumeCredentials {
                server_url: input.server_url,
                token: input.token,
                user_id: input.user_id,
                collection_id: input.collection_id,
                password: input.password,
            },
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn e2ee_disconnect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let root = crate::vault_location::root(&app)?;
    state.sync.disconnect(&root).await.map_err(Into::into)
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

/// THE open-note verb (CONTEXT.md: open-note disposition). The frontend gathers
/// the facts — one disk read plus its own editor state — and the engine returns
/// the single verdict it renders. Pure: no vault, no session, no I/O, so it is
/// safe on the sync-completion path and the watcher path alike.
#[tauri::command]
pub fn e2ee_classify_open_note(facts: OpenNoteFactsInput) -> OpenNoteDispositionOutput {
    futo_notes_sync::classify_open_note(facts.into()).into()
}
