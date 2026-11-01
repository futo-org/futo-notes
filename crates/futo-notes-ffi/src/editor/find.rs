//! Thin byte-coordinate find projection. Matching, stepping and stale-scan
//! rejection live in the canonical editor; scans run off the session lock.
use super::*;
use futo_notes_editor as editor;

#[derive(Debug, PartialEq, Eq, uniffi::Record)]
pub struct EditorFindReport {
    pub revision: u64,
    pub open: bool,
    pub query: String,
    pub total: u64,
    /// One-based; zero when there is no current match.
    pub current: u64,
    pub current_range: Option<EditorByteRange>,
    pub current_source: Option<EditorByteRange>,
    /// Set only when this call moved the current match.
    pub reveal: Option<EditorByteRange>,
    pub stale: bool,
}

impl From<editor::FindReport> for EditorFindReport {
    fn from(value: editor::FindReport) -> Self {
        Self {
            revision: value.revision.0,
            open: value.open,
            query: value.query,
            total: value.total as u64,
            current: value.current as u64,
            current_range: value.current_range.map(Into::into),
            current_source: value.current_source.map(|range| EditorByteRange {
                start: range.start.0 as u64,
                end: range.end.0 as u64,
            }),
            reveal: value.reveal.map(Into::into),
            stale: value.stale,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EditorFindScanRequest {
    pub generation: u64,
    pub revision: u64,
    pub query: String,
    pub text: String,
    pub soft_breaks: Vec<EditorByteRange>,
    pub barriers: Vec<EditorByteRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct EditorFindScanResult {
    pub generation: u64,
    pub revision: u64,
    pub matches: Vec<EditorByteRange>,
    pub scanned_bytes: u64,
}

fn ranges(values: Vec<EditorByteRange>) -> Result<Vec<editor::DisplayRange>, EditorSessionError> {
    values.into_iter().map(TryInto::try_into).collect()
}

/// Pure scan of a request snapshot; safe to call from any worker without the
/// session lock. Hand the result to `find_apply_scan`.
#[uniffi::export]
pub fn editor_find_scan(
    request: EditorFindScanRequest,
) -> Result<EditorFindScanResult, EditorSessionError> {
    let result = editor::FindScanRequest {
        generation: request.generation,
        revision: Revision(request.revision),
        query: request.query,
        text: request.text,
        soft_breaks: ranges(request.soft_breaks)?,
        barriers: ranges(request.barriers)?,
    }
    .run();
    Ok(EditorFindScanResult {
        generation: result.generation,
        revision: result.revision.0,
        matches: result.matches.into_iter().map(Into::into).collect(),
        scanned_bytes: result.scanned_bytes,
    })
}

#[uniffi::export]
impl NativeEditorSession {
    pub fn find_set_query(
        &self,
        expected: u64,
        query: String,
    ) -> Result<EditorFindReport, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session.find_set_query(Revision(expected), &query)?.into())
        })
    }

    pub fn find_step(
        &self,
        expected: u64,
        forward: bool,
    ) -> Result<EditorFindReport, EditorSessionError> {
        self.with_revision(expected, |session| {
            let direction = if forward {
                editor::CaretDirection::Forward
            } else {
                editor::CaretDirection::Backward
            };
            Ok(session.find_step(Revision(expected), direction)?.into())
        })
    }

    pub fn find_close(&self) -> Result<EditorFindReport, EditorSessionError> {
        self.with_session(|session| Ok(session.find_close()?.into()))
    }

    pub fn find_report(&self) -> Result<EditorFindReport, EditorSessionError> {
        self.with_session(|session| Ok(session.find_report()?.into()))
    }

    pub fn find_matches(
        &self,
        expected: u64,
        range: EditorByteRange,
    ) -> Result<Vec<EditorByteRange>, EditorSessionError> {
        self.with_revision(expected, |session| {
            Ok(session
                .find_matches(Revision(expected), range.try_into()?)?
                .into_iter()
                .map(Into::into)
                .collect())
        })
    }

    pub fn find_scan_request(&self) -> Result<Option<EditorFindScanRequest>, EditorSessionError> {
        self.with_session(|session| {
            Ok(session
                .find_scan_request()?
                .map(|request| EditorFindScanRequest {
                    generation: request.generation,
                    revision: request.revision.0,
                    query: request.query,
                    text: request.text,
                    soft_breaks: request.soft_breaks.into_iter().map(Into::into).collect(),
                    barriers: request.barriers.into_iter().map(Into::into).collect(),
                }))
        })
    }

    /// `None`: the scan was for another revision or query and was ignored.
    pub fn find_apply_scan(
        &self,
        result: EditorFindScanResult,
    ) -> Result<Option<EditorFindReport>, EditorSessionError> {
        self.with_session(|session| {
            let result = editor::FindScanResult {
                generation: result.generation,
                revision: Revision(result.revision),
                matches: ranges(result.matches)?,
                scanned_bytes: result.scanned_bytes,
            };
            Ok(session.find_apply_scan(&result)?.map(Into::into))
        })
    }
}
