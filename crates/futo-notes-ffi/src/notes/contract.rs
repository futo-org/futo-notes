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
pub struct NoteRename {
    pub from: String,
    pub to: String,
}

#[derive(uniffi::Record)]
pub struct NoteMutation {
    pub upserted: Vec<NoteMetadata>,
    pub removed: Vec<String>,
    pub renamed: Vec<NoteRename>,
    pub warnings: Vec<String>,
}

impl From<store::MutationResult> for NoteMutation {
    fn from(mutation: store::MutationResult) -> Self {
        Self {
            upserted: mutation.upserted.into_iter().map(Into::into).collect(),
            removed: mutation.removed,
            renamed: mutation
                .renamed
                .into_iter()
                .map(|rename| NoteRename {
                    from: rename.from,
                    to: rename.to,
                })
                .collect(),
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

#[derive(uniffi::Record)]
pub struct ConditionalWrite {
    pub outcome: FlushOutcome,
    pub mutation: Option<NoteMutation>,
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
