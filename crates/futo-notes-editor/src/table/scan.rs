//! Composable canonical table scanning over retained source rows. A rule is
//! exempt from interruption only when the preceding header actually owns it.
use super::{delimiter, interrupts, parse_line};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Header {
    pub start: usize,
    pub columns: usize,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum State {
    Searching(Option<Header>),
    Inside(Header),
}
#[derive(Clone, Copy, Debug)]
enum Owner {
    Local(Header),
    IncomingOwner,
    IncomingHeader,
}
#[derive(Clone, Copy, Debug)]
enum Output {
    Searching(Option<Header>),
    Inside(Owner),
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct Summary {
    pub len: usize,
    first_delimiter: Option<usize>,
    inside: Output,
    searching: Output,
    matching: Output,
}
impl Default for Summary {
    fn default() -> Self {
        Self {
            len: 0,
            first_delimiter: None,
            inside: Output::Inside(Owner::IncomingOwner),
            searching: Output::Searching(None),
            matching: Output::Inside(Owner::IncomingHeader),
        }
    }
}
impl Summary {
    fn line(text: &str) -> Self {
        let end = text.trim_end_matches(['\r', '\n']).len();
        let line = parse_line(text, 0, end, text.len());
        let header = (line.pipes > 0 && !line.cells.is_empty()).then_some(Header {
            start: 0,
            columns: line.cells.len(),
        });
        let first_delimiter = delimiter(text, &line).map(|columns| columns.len());
        let searching = Output::Searching(header);
        let interruption =
            text.trim_matches([' ', '\t', '\r', '\n']).is_empty() || interrupts(text);
        Self {
            len: text.len(),
            first_delimiter,
            inside: if interruption {
                searching
            } else {
                Output::Inside(Owner::IncomingOwner)
            },
            searching,
            matching: if first_delimiter.is_some() {
                Output::Inside(Owner::IncomingHeader)
            } else {
                searching
            },
        }
    }

    /// Concatenate exact source generations, retaining symbolic incoming
    /// owner/header identities until the first line consumes them.
    pub fn then(self, next: Self) -> Self {
        if self.len == 0 {
            return next;
        }
        if next.len == 0 {
            return self;
        }
        Self {
            len: self.len + next.len,
            first_delimiter: self.first_delimiter,
            inside: substitute(self.inside, next, self.len),
            searching: substitute(self.searching, next, self.len),
            matching: substitute(self.matching, next, self.len),
        }
    }

    pub fn apply(self, state: State) -> State {
        if self.len == 0 {
            return state;
        }
        let output = match state {
            State::Inside(_) => self.inside,
            State::Searching(Some(header)) if self.first_delimiter == Some(header.columns) => {
                self.matching
            }
            State::Searching(_) => self.searching,
        };
        match output {
            Output::Searching(header) => State::Searching(header),
            Output::Inside(Owner::Local(header)) => State::Inside(header),
            Output::Inside(Owner::IncomingOwner) => match state {
                State::Inside(header) => State::Inside(header),
                _ => unreachable!("inside identity"),
            },
            Output::Inside(Owner::IncomingHeader) => match state {
                State::Searching(Some(header)) => State::Inside(header),
                _ => unreachable!("header identity"),
            },
        }
    }
}
fn shift(header: Header, by: usize) -> Header {
    Header {
        start: header.start + by,
        ..header
    }
}
fn substitute(previous: Output, next: Summary, by: usize) -> Output {
    let (output, inherited) = match previous {
        Output::Inside(owner) => (next.inside, Some(owner)),
        Output::Searching(header) => {
            let matching =
                header.is_some_and(|header| next.first_delimiter == Some(header.columns));
            (
                if matching {
                    next.matching
                } else {
                    next.searching
                },
                header.map(Owner::Local),
            )
        }
    };
    match output {
        Output::Searching(header) => Output::Searching(header.map(|header| shift(header, by))),
        Output::Inside(Owner::Local(header)) => Output::Inside(Owner::Local(shift(header, by))),
        Output::Inside(Owner::IncomingOwner | Owner::IncomingHeader) => {
            Output::Inside(inherited.expect("the selected transition has an incoming identity"))
        }
    }
}

pub(crate) struct RowScan {
    pub summary: Summary,
    lines: Vec<(usize, Summary)>,
}
impl RowScan {
    // Pipe-bearing physical lines are never word-cut. A word-cut fragment
    // starts inside ASCII letters, so it cannot invent a header, rule or
    // line-start interruption (inline/row/split/word.rs).
    pub fn new(text: &str) -> Self {
        let mut summary = Summary::default();
        let mut lines = Vec::new();
        for text in text.split_inclusive('\n') {
            let line = Summary::line(text);
            let start = summary.len;
            summary = summary.then(line);
            lines.push((start, summary));
        }
        Self { summary, lines }
    }
    /// Includes the physical line holding `at`, never later lines in the row.
    pub fn prefix(&self, at: usize) -> (Summary, usize) {
        let mut work = 0;
        let end = self.lines.partition_point(|(start, _)| {
            work += 1;
            *start <= at
        });
        (
            end.checked_sub(1)
                .map_or_else(Summary::default, |index| self.lines[index].1),
            work,
        )
    }
}
