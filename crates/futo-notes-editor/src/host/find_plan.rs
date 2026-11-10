use super::{DisplayMirror, MirrorError};
use crate::{DisplayRange, FindReport};

/// One find result in the host's UTF-16 units: what a native view paints and scrolls to.
/// `matches` are ascending and non-overlapping; `current` is one-based, zero for none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FindSnapshot {
    pub open: bool,
    pub query: String,
    pub total: usize,
    pub current: usize,
    pub stale: bool,
    pub matches: Vec<(usize, usize)>,
    /// Set only when the call moved the current match: scroll it into view.
    pub reveal: Option<(usize, usize)>,
}

fn utf16(mirror: &DisplayMirror, range: DisplayRange) -> Result<(usize, usize), MirrorError> {
    Ok((
        mirror.byte_to_utf16(range.start.0)?,
        mirror.byte_to_utf16(range.end.0)?,
    ))
}

/// The engine's find report and its matches as UTF-16 marks. While a composition overlays the
/// host's text the marks would be off by the marked text, so they wait for its end
/// (`composing`). `reveal_requested` asks for the current match (else the report's reveal) as the
/// range to scroll to.
pub fn plan_find(
    report: &FindReport,
    matches: &[DisplayRange],
    mirror: &DisplayMirror,
    composing: bool,
    reveal_requested: bool,
) -> Result<FindSnapshot, MirrorError> {
    let marks = if !report.open || report.total == 0 || composing {
        Vec::new()
    } else {
        matches
            .iter()
            .map(|range| utf16(mirror, *range))
            .collect::<Result<_, _>>()?
    };
    let target = if reveal_requested {
        report.current_range.or(report.reveal)
    } else {
        None
    };
    Ok(FindSnapshot {
        open: report.open,
        query: report.query.clone(),
        total: report.total,
        current: report.current,
        stale: report.stale,
        matches: marks,
        reveal: target.map(|range| utf16(mirror, range)).transpose()?,
    })
}

/// What one Next/Previous press asks of the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FindStepPlan {
    /// Composing: change nothing, report only.
    Hold,
    /// The first press after the query changed lands on the current match.
    Land,
    /// Later presses move from the match the last one landed on, and so does a first press
    /// with matches but no current one.
    Advance,
}

/// The per-bar memory of whether a press has already landed on the current match since the query
/// last changed (opening, a new query and closing all reset it).
#[derive(Debug, Default)]
pub struct FindLanding {
    landed: bool,
    /// `FindReport::dropped` when `landed` was last settled.
    dropped: u64,
}

impl FindLanding {
    pub fn reset(&mut self) {
        self.landed = false;
    }

    /// `report` is the engine's current find report. Matches with no current one (an edit
    /// dropped it until the next rescan) have nothing to land on, so the press steps to one.
    ///
    /// A press has landed only while the user is on the current match. An edit that dropped it
    /// (`report.dropped` moved) leaves the user on no match, and a rescan may then choose another
    /// they were never taken to, so the next press lands on it instead of stepping past it.
    pub fn plan(&mut self, composing: bool, report: &FindReport) -> FindStepPlan {
        if composing {
            return FindStepPlan::Hold;
        }
        if self.dropped != report.dropped {
            self.dropped = report.dropped;
            self.landed = false;
        }
        if self.landed || (report.total > 0 && report.current_range.is_none()) {
            FindStepPlan::Advance
        } else {
            FindStepPlan::Land
        }
    }

    /// The range to select and scroll to after `plan` ran (`Advance` ran the engine's step, the
    /// others only read its report). A press that finds nothing leaves the next one a first.
    pub fn landing(&mut self, plan: FindStepPlan, report: &FindReport) -> Option<DisplayRange> {
        let range = match plan {
            FindStepPlan::Hold => None,
            FindStepPlan::Land => report.current_range,
            FindStepPlan::Advance => report.reveal,
        };
        self.landed |= range.is_some();
        range
    }
}
