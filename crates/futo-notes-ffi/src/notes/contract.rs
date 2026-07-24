use futo_notes_store as store;

#[derive(uniffi::Record)]
pub struct NoteMetadata {
    pub id: String,
    pub title: String,
    pub folder: String,
    pub modified_ms: i64,
    pub preview: String,
    pub rich_preview: String,
    pub tags: Vec<String>,
}

impl From<store::NoteMetadata> for NoteMetadata {
    fn from(metadata: store::NoteMetadata) -> Self {
        Self {
            id: metadata.id,
            title: metadata.title,
            folder: metadata.folder,
            modified_ms: metadata.modified_ms,
            preview: metadata.preview,
            rich_preview: metadata.rich_preview,
            tags: metadata.tags,
        }
    }
}

#[derive(uniffi::Record)]
pub struct NoteSnapshot {
    pub notes: Vec<NoteMetadata>,
    pub folders: Vec<String>,
}

impl From<store::Snapshot> for NoteSnapshot {
    fn from(snapshot: store::Snapshot) -> Self {
        Self {
            notes: snapshot.notes.into_iter().map(Into::into).collect(),
            folders: snapshot.folders,
        }
    }
}

#[derive(uniffi::Record)]
pub struct UpsertedNote {
    pub note: NoteMetadata,
    pub position: u32,
}

impl From<store::UpsertedNote> for UpsertedNote {
    fn from(entry: store::UpsertedNote) -> Self {
        Self {
            note: entry.note.into(),
            position: entry.position,
        }
    }
}

#[derive(uniffi::Record)]
pub struct NoteMutation {
    pub upserted: Vec<UpsertedNote>,
    pub removed: Vec<String>,
    pub folders: Vec<String>,
    pub final_id: Option<String>,
    pub final_folder: Option<String>,
    pub warnings: Vec<String>,
}

impl From<store::MutationResult> for NoteMutation {
    fn from(mutation: store::MutationResult) -> Self {
        Self {
            upserted: mutation.upserted.into_iter().map(Into::into).collect(),
            removed: mutation.removed,
            folders: mutation.folders,
            final_id: mutation.final_id,
            final_folder: mutation.final_folder,
            warnings: mutation.warnings,
        }
    }
}

#[derive(uniffi::Record)]
pub struct NoteBootstrap {
    pub snapshot: NoteSnapshot,
    pub seeded: u32,
    pub migrated: u32,
    pub warnings: Vec<String>,
}

impl From<store::BootstrapResult> for NoteBootstrap {
    fn from(bootstrap: store::BootstrapResult) -> Self {
        Self {
            snapshot: bootstrap.snapshot.into(),
            seeded: bootstrap.seeded,
            migrated: bootstrap.migrated,
            warnings: bootstrap.warnings,
        }
    }
}

#[derive(Debug, uniffi::Error, thiserror::Error)]
pub enum NoteError {
    #[error("{0}")]
    Io(String),
}

#[derive(Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FlushOutcome {
    Wrote,
    SkippedMissing,
    SkippedChanged,
}

impl From<store::FlushOutcome> for FlushOutcome {
    fn from(outcome: store::FlushOutcome) -> Self {
        match outcome {
            store::FlushOutcome::Wrote => Self::Wrote,
            store::FlushOutcome::SkippedMissing => Self::SkippedMissing,
            store::FlushOutcome::SkippedChanged => Self::SkippedChanged,
        }
    }
}

#[derive(Debug, PartialEq, Eq, uniffi::Enum)]
pub enum CreateOutcome {
    Created,
    Existed,
}

impl From<store::CreateOutcome> for CreateOutcome {
    fn from(outcome: store::CreateOutcome) -> Self {
        match outcome {
            store::CreateOutcome::Created => Self::Created,
            store::CreateOutcome::Existed => Self::Existed,
        }
    }
}

#[derive(Debug, PartialEq, Eq, uniffi::Enum)]
pub enum VaultMigrationStatus {
    Migrated,
    EmptySource,
    AlreadyAtDestination,
}

impl From<store::VaultMigrationStatus> for VaultMigrationStatus {
    fn from(status: store::VaultMigrationStatus) -> Self {
        match status {
            store::VaultMigrationStatus::Migrated => Self::Migrated,
            store::VaultMigrationStatus::EmptySource => Self::EmptySource,
            store::VaultMigrationStatus::AlreadyAtDestination => Self::AlreadyAtDestination,
        }
    }
}

#[derive(Debug, PartialEq, Eq, uniffi::Enum)]
pub enum VaultMigrationFinalization {
    Finalized,
    SourceRetained,
    DestinationChanged,
}

impl From<store::VaultMigrationFinalization> for VaultMigrationFinalization {
    fn from(finalization: store::VaultMigrationFinalization) -> Self {
        match finalization {
            store::VaultMigrationFinalization::Finalized => Self::Finalized,
            store::VaultMigrationFinalization::SourceRetained => Self::SourceRetained,
            store::VaultMigrationFinalization::DestinationChanged => Self::DestinationChanged,
        }
    }
}

#[derive(uniffi::Record)]
pub struct VaultMigrationOutcome {
    pub status: VaultMigrationStatus,
    pub files: u32,
}

impl From<store::VaultMigrationOutcome> for VaultMigrationOutcome {
    fn from(outcome: store::VaultMigrationOutcome) -> Self {
        Self {
            status: outcome.status.into(),
            files: outcome.files,
        }
    }
}

#[derive(uniffi::Record)]
pub struct ConditionalWrite {
    pub outcome: FlushOutcome,
    pub mutation: Option<NoteMutation>,
}

/// The single outcome of one draft flush (CONTEXT.md: flush disposition).
/// Shells render dispositions; they never decide them (ADR-0001).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum FlushDisposition {
    Wrote,
    Converged,
    Recreated,
    ParkedConflict { parked_id: String },
}

impl From<store::FlushDisposition> for FlushDisposition {
    fn from(disposition: store::FlushDisposition) -> Self {
        match disposition {
            store::FlushDisposition::Wrote => Self::Wrote,
            store::FlushDisposition::Converged => Self::Converged,
            store::FlushDisposition::Recreated => Self::Recreated,
            store::FlushDisposition::ParkedConflict { parked_id } => {
                Self::ParkedConflict { parked_id }
            }
        }
    }
}

/// What a flush committed: one disposition plus the mutation to project
/// (absent when nothing changed on disk — converged, or a park that found
/// its copy already minted).
#[derive(uniffi::Record)]
pub struct FlushDraftResult {
    pub disposition: FlushDisposition,
    pub mutation: Option<NoteMutation>,
}

impl From<store::FlushDraftResult> for FlushDraftResult {
    fn from(result: store::FlushDraftResult) -> Self {
        Self {
            disposition: result.disposition.into(),
            mutation: result.mutation.map(Into::into),
        }
    }
}

#[derive(uniffi::Record)]
pub struct SearchHit {
    pub note_id: String,
    pub score: f64,
    pub source: String,
}

impl From<store::SearchHit> for SearchHit {
    fn from(hit: store::SearchHit) -> Self {
        Self {
            note_id: hit.note_id,
            score: hit.score as f64,
            source: hit.source,
        }
    }
}
