use super::*;
use serde::{Deserialize, Serialize};

/// Produced only after the page's ordinary ready guard, which then freezes
/// Full callbacks until this dedicated mode handshake completes or is canceled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedModeRequest {
    pub token: SessionToken,
    pub sequence: u64,
    pub revision: Revision,
    pub body_caret: DisplayOffset,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedModeReady {
    pub request: BoundedModeRequest,
    /// Host source authority, independent of the page's core cursor counter.
    pub incarnation: u64,
    pub durable: Revision,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BoundedHostOperation {
    Append {
        edit: SourceEdit,
        operation: BoundedSourceOperation,
    },
    Flush,
    Resume,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedHostRequest {
    pub token: SessionToken,
    pub incarnation: u64,
    pub sequence: u64,
    pub operation: BoundedHostOperation,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedHostAck {
    pub token: SessionToken,
    pub incarnation: u64,
    pub sequence: u64,
    pub accepted: Revision,
    pub durable: Revision,
    pub paused: bool,
    pub reset_required: bool,
    pub error: Option<String>,
    pub work: BoundedWork,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BoundedFrame {
    Literal(BoundedChange),
    Progress(BoundedProgress),
}
impl BoundedFrame {
    pub(super) fn revision(&self) -> Revision {
        match self {
            Self::Literal(change) => change.cursor.revision,
            Self::Progress(BoundedProgress::Change(change)) => change.cursor.revision,
            Self::Progress(BoundedProgress::Status(change)) => change.cursor.revision,
        }
    }
}

pub struct PortableBoundedEntryError {
    pub session: Box<PortableSession>,
    pub error: PortableError,
}
pub struct PortableBoundedExitError {
    pub session: Box<PortableBoundedSession>,
    pub error: PortableError,
}
impl std::fmt::Debug for PortableBoundedEntryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(f)
    }
}
impl std::fmt::Debug for PortableBoundedExitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(f)
    }
}
