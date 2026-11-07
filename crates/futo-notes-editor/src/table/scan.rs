//! Composable canonical table scanning over retained source rows. A rule is
//! exempt from interruption only when the preceding header actually owns it.
use super::{delimiter, interrupts_counted, line_bounds, line_from_pipes, PipeScan};

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
    fn line(
        text: &str,
        raw_pipe: bool,
        pipes: PipeScan,
        blank: bool,
        delimiter_possible: bool,
    ) -> (Self, usize) {
        let mut parsed = 0;
        let (header, first_delimiter) = if raw_pipe {
            let mut end = text.len();
            while end > 0 && matches!(text.as_bytes()[end - 1], b'\r' | b'\n') {
                end -= 1;
            }
            let (bounds, read) = line_bounds(text, 0, end);
            parsed += text.len() - end + usize::from(end > 0) + read;
            let line = line_from_pipes(0, end, text.len(), bounds, pipes.positions);
            (
                (line.pipes > 0 && !line.cells.is_empty()).then_some(Header {
                    start: 0,
                    columns: line.cells.len(),
                }),
                if delimiter_possible {
                    parsed += text.len();
                    delimiter(text, &line).map(|columns| columns.len())
                } else {
                    None
                },
            )
        } else {
            (None, None)
        };
        let (interruption, read) = if blank {
            (true, 0)
        } else {
            interrupts_counted(text)
        };
        let searching = Output::Searching(header);
        (
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
            },
            parsed + read,
        )
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
    #[cfg(test)]
    pub fn new(text: &str) -> Self {
        Self::counted(text).0
    }
    /// Fallback constructors walk raw source explicitly, then inspect cells
    /// or interruption prefixes; charge both unlike an existing source walk.
    pub fn counted(text: &str) -> (Self, usize) {
        let mut builder = Builder::new(text);
        for (at, ch) in text.char_indices() {
            builder.observe(at, ch);
        }
        let (scan, read) = builder.finish();
        (scan, text.len() + read)
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

/// Collect raw line boundaries and cheap facts during an existing source walk.
/// Only pipe-bearing lines need the canonical full cell/delimiter parse.
pub(crate) struct Builder<'a> {
    text: &'a str,
    scan: RowScan,
    start: usize,
    raw_pipe: bool,
    pipes: PipeScan,
    delimiter_possible: bool,
    blank: bool,
    parsed: usize,
}
impl<'a> Builder<'a> {
    pub fn new(text: &'a str) -> Self {
        Self {
            text,
            scan: RowScan {
                summary: Summary::default(),
                lines: Vec::new(),
            },
            start: 0,
            raw_pipe: false,
            pipes: PipeScan::default(),
            delimiter_possible: true,
            blank: true,
            parsed: 0,
        }
    }
    pub fn observe(&mut self, at: usize, ch: char) {
        self.raw_pipe |= ch == '|';
        self.pipes.observe(at - self.start, ch);
        self.delimiter_possible &= matches!(ch, '|' | '-' | ':' | ' ' | '\t' | '\r' | '\n');
        self.blank &= matches!(ch, ' ' | '\t' | '\r' | '\n');
        if ch == '\n' {
            self.line(at + 1);
        }
    }
    fn line(&mut self, end: usize) {
        let (line, read) = Summary::line(
            &self.text[self.start..end],
            self.raw_pipe,
            std::mem::take(&mut self.pipes),
            self.blank,
            self.delimiter_possible,
        );
        self.scan.summary = self.scan.summary.then(line);
        self.scan.lines.push((self.start, self.scan.summary));
        self.parsed += read;
        self.start = end;
        self.raw_pipe = false;
        self.delimiter_possible = true;
        self.blank = true;
    }
    pub fn finish(mut self) -> (RowScan, usize) {
        if self.start < self.text.len() {
            self.line(self.text.len());
        }
        (self.scan, self.parsed)
    }
}
