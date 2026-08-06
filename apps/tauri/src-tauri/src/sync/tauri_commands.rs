//! Stable Tauri command surface for end-to-end encrypted sync.

use tauri::{AppHandle, State};

use super::frontend_contract::{
    E2eeConnectInput, E2eeConnectOutput, E2eeResumeInput, E2eeStatusOutput,
    OpenNoteDispositionOutput, OpenNoteRequestInput, SyncSummary,
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

fn classify_open_note_impl(
    store: &futo_notes_store::LocalNoteStore,
    facts: OpenNoteRequestInput,
) -> Result<OpenNoteDispositionOutput, String> {
    let disk = store.read_existing(&facts.id)?;
    Ok(futo_notes_sync::classify_open_note(facts.with_disk(disk)).into())
}

/// THE desktop open-note verb (CONTEXT.md: open-note disposition). It gathers
/// authoritative disk content and classifies it in one frontend round trip.
#[tauri::command]
pub async fn e2ee_classify_open_note(
    app: AppHandle,
    state: State<'_, AppState>,
    facts: OpenNoteRequestInput,
) -> Result<OpenNoteDispositionOutput, String> {
    let store = crate::local_notes::store(&app, &state)?;
    crate::background_tasks::blocking(move || classify_open_note_impl(&store, facts)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "futo-open-note-command-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn facts(id: &str) -> OpenNoteRequestInput {
        OpenNoteRequestInput {
            id: id.to_owned(),
            base: "base".to_owned(),
            draft: "base".to_owned(),
            renamed_to: None,
            editor_focused: false,
            edited_during_cycle: false,
        }
    }

    #[test]
    fn open_note_command_gathers_missing_empty_and_present_disk_states() {
        let root = TestRoot::new();
        fs::write(root.0.join("Empty.md"), "").unwrap();
        fs::write(root.0.join("Changed.md"), "peer").unwrap();
        let store = futo_notes_store::LocalNoteStore::new(root.0.clone());

        assert_eq!(
            classify_open_note_impl(&store, facts("Missing")).unwrap(),
            OpenNoteDispositionOutput::Close
        );
        assert_eq!(
            classify_open_note_impl(&store, facts("Empty")).unwrap(),
            OpenNoteDispositionOutput::Adopt {
                content: String::new()
            }
        );
        assert_eq!(
            classify_open_note_impl(&store, facts("Changed")).unwrap(),
            OpenNoteDispositionOutput::Adopt {
                content: "peer".to_owned()
            }
        );
    }
}
