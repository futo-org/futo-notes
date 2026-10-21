//! What went wrong with one file, and why the server refused a cycle's writes.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    Upload,
    Delete,
    Checkpoint,
    Download,
    Decrypt,
    Rejected,
    /// The server's change arrived intact and applying it to the vault failed.
    /// A write (no permission, a read-only mount, a full disk, a symlink or a
    /// plain file standing where a folder belongs, a local edit that landed
    /// mid-pull) or a remote deletion that could not be carried out locally.
    /// Kept apart from [`Self::Download`] because github#44 spent an entire
    /// issue auditing a healthy server and a healthy nginx: the engine produced
    /// the real reason and the caller refiled it as a download fault.
    LocalApply,
    /// The vault folder itself is not there. One condition that explains every
    /// note in the cycle, so it is reported once, by path, with the way out —
    /// not as one bullet per note.
    VaultMissing,
}

impl FailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::Delete => "delete",
            Self::Checkpoint => "checkpoint",
            Self::Download => "download",
            Self::Decrypt => "decrypt",
            Self::Rejected => "rejected",
            Self::LocalApply => "local_apply",
            Self::VaultMissing => "vault_missing",
        }
    }
}

/// Why the server would not take this cycle's writes.
///
/// Two HTTP statuses, named once. `402 subscription_required` and `507
/// quota_exceeded` are not ordinary sync faults — nothing is broken, the
/// account simply may not write — so the shells answer them with a banner and
/// an action rather than the red failure line (ADR 0003 decision 8).
///
/// Deriving it here is the point: three shells reading `failures` for a status
/// code would be the same sync rule written three times, which is the
/// duplicate class the root AGENTS.md forbids (M6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteRefusal {
    /// `402` — the subscription lapsed. Reads keep working; writes do not.
    SubscriptionRequired,
    /// `507` — the vault is at its plan's ceiling.
    QuotaExceeded,
}

impl WriteRefusal {
    /// Stable wire identifier, for the shell contracts that carry a string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SubscriptionRequired => "subscriptionRequired",
            Self::QuotaExceeded => "quotaExceeded",
        }
    }
}

/// THE precedence, decided here and nowhere else: a lapsed subscription wins
/// over a full vault, because it refuses the write whatever the quota says —
/// telling someone to buy more storage would be the wrong instruction.
///
/// Only the write half of the cycle can be refused, so only [`FailureKind::Upload`]
/// and [`FailureKind::Delete`] are read. A 402 arriving on a download would mean
/// something else entirely and must not raise "Sync paused"; reads are never
/// gated (docs/spec/sync.md).
pub(super) fn derive_write_refusal(failures: &[SyncFailure]) -> Option<WriteRefusal> {
    let write_statuses = || {
        failures
            .iter()
            .filter(|failure| matches!(failure.kind, FailureKind::Upload | FailureKind::Delete))
            .filter_map(|failure| failure.status_code)
    };
    if write_statuses().any(|status| status == 402) {
        return Some(WriteRefusal::SubscriptionRequired);
    }
    write_statuses()
        .any(|status| status == 507)
        .then_some(WriteRefusal::QuotaExceeded)
}

#[derive(Debug, Clone)]
pub struct SyncFailure {
    pub filename: String,
    pub kind: FailureKind,
    pub status_code: Option<u16>,
    /// The engine's own error text, for the instance journal only — never the
    /// user-facing string, and deliberately NOT projected into either shell
    /// contract (see `every_failure_field_is_either_projected_or_deliberately_internal`).
    /// `HttpError` keeps a full `source()` chain precisely so a failure can be
    /// told apart after the fact (see `server/mod.rs` `transport_error`), and
    /// every per-item failure used to drop it here — so the one channel built to
    /// answer "why is that note not on this device" was silent for the two
    /// causes it was most needed for (github#44).
    ///
    /// `pub` only because the shells' contract tests construct failures; treat
    /// it as engine-internal and route it to the journal, not to a user.
    pub detail: Option<String>,
}
