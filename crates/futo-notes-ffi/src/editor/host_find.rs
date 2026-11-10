//! The find bar's half of the host helpers: the per-bar landing memory and the two
//! `NativeEditorSession` calls over `futo_notes_editor::host::plan_find` / `FindLanding`.
use std::sync::{Arc, Mutex};

use futo_notes_editor::host::{plan_find, FindLanding, FindStepPlan};
use futo_notes_editor::{DisplayOffset, DisplayRange, Revision};

use super::host::{EditorDisplayMirror, EditorFindSnapshot};
use super::{EditorByteRange, EditorFindReport, EditorSessionError, NativeEditorSession};

/// Whether a Next/Previous press has already landed on the current match since the query last
/// changed. One per find bar; `reset` when the query changes or the bar closes.
#[derive(uniffi::Object, Default)]
pub struct EditorFindLanding {
    inner: Mutex<FindLanding>,
}

#[uniffi::export]
impl EditorFindLanding {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn reset(&self) {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).reset();
    }
}

/// A find press's report and the range to select and scroll to (display bytes), if it landed.
#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorFindStep {
    pub report: EditorFindReport,
    pub landing: Option<EditorByteRange>,
}

#[uniffi::export]
impl NativeEditorSession {
    /// The find state as paintable UTF-16 marks. `mirror` must hold this session's display.
    /// `composing` hides the marks (they would be off by the marked text); `reveal` asks for the
    /// current match as the range to scroll to.
    pub fn find_snapshot(
        &self,
        expected: u64,
        mirror: Arc<EditorDisplayMirror>,
        composing: bool,
        reveal: bool,
    ) -> Result<EditorFindSnapshot, EditorSessionError> {
        self.with_revision(expected, |session| {
            let report = session.find_report()?;
            let matches = if report.open && report.total > 0 {
                let end = mirror.with(|m| m.byte_len());
                session.find_matches(
                    Revision(expected),
                    DisplayRange {
                        start: DisplayOffset(0),
                        end: DisplayOffset(end),
                    },
                )?
            } else {
                Vec::new()
            };
            let snapshot = mirror
                .with(|m| plan_find(&report, &matches, m, composing, reveal))
                .map_err(|_| EditorSessionError::Unavailable)?;
            Ok(snapshot.into())
        })
    }

    /// A Next/Previous press: the first one after the query changed lands on the current match,
    /// later ones step from it; during composition it only reports.
    pub fn find_step_landing(
        &self,
        expected: u64,
        landing: Arc<EditorFindLanding>,
        forward: bool,
        composing: bool,
    ) -> Result<EditorFindStep, EditorSessionError> {
        self.with_revision(expected, |session| {
            let mut landing = landing.inner.lock().unwrap_or_else(|e| e.into_inner());
            let plan = landing.plan(composing, forward, &session.find_report()?);
            let report = if plan == FindStepPlan::Advance {
                let direction = if forward {
                    futo_notes_editor::CaretDirection::Forward
                } else {
                    futo_notes_editor::CaretDirection::Backward
                };
                session.find_step(Revision(expected), direction)?
            } else {
                session.find_report()?
            };
            let range = landing.landing(plan, &report);
            Ok(EditorFindStep {
                report: report.into(),
                landing: range.map(Into::into),
            })
        })
    }
}
