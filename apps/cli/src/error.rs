//! Stable error codes and the exit status each one carries.
//!
//! The code is the contract: scripts branch on `error.code` and the exit
//! status, never on the translated message. Codes come from typed engine
//! outcomes, never from matching message text.

use serde_json::Value;

use crate::i18n::tf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    InvalidArgument,
    VaultNotConfigured,
    VaultMissing,
    NoteNotFound,
    VaultBusy,
    DraftParked,
    AuthFailed,
    NetworkError,
    SyncIncomplete,
    IoError,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidArgument => "invalid_argument",
            Self::VaultNotConfigured => "vault_not_configured",
            Self::VaultMissing => "vault_missing",
            Self::NoteNotFound => "note_not_found",
            Self::VaultBusy => "vault_busy",
            Self::DraftParked => "draft_parked",
            Self::AuthFailed => "auth_failed",
            Self::NetworkError => "network_error",
            Self::SyncIncomplete => "sync_incomplete",
            Self::IoError => "io_error",
        }
    }

    /// 2 for invalid usage, 1 for every other failure.
    pub fn exit_status(self) -> i32 {
        match self {
            Self::InvalidArgument => 2,
            _ => 1,
        }
    }
}

/// A failed command: a stable code, a human sentence from the catalog, and —
/// when some work was already committed — what that work was.
#[derive(Debug)]
pub struct CliError {
    pub code: Code,
    pub message: String,
    pub data: Option<Value>,
}

impl CliError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn io(detail: impl std::fmt::Display) -> Self {
        Self::new(
            Code::IoError,
            tf("cli.errors.io", &[("detail", &detail.to_string())]),
        )
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new(Code::InvalidArgument, message)
    }

    pub fn note_not_found(id: &str) -> Self {
        Self::new(
            Code::NoteNotFound,
            tf("cli.errors.noteNotFound", &[("id", id)]),
        )
    }

    /// A store workflow's error, classified by the identifier the store owns.
    pub fn from_store(id: &str, error: String) -> Self {
        if error == futo_notes_store::NOTE_NOT_FOUND {
            Self::note_not_found(id)
        } else {
            Self::io(error)
        }
    }
}

pub type CliResult<T> = Result<T, CliError>;
