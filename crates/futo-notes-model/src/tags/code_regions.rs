//! Code-fence and inline-code region scanning for tag extraction: which byte
//! ranges of a note count as blanked, in the same order as TS `stripCodeRegions`.

fn backtick_run_end(bytes: &[u8], start: usize) -> usize {
    let mut end = start;
    while end < bytes.len() && bytes[end] == b'`' {
        end += 1;
    }
    end
}

/// Byte ranges treated as blanked: fenced code, then inline code outside the
/// fences, the same order as TS `stripCodeRegions`.
pub(super) fn code_regions(content: &str, bytes: &[u8]) -> Vec<(usize, usize)> {
    if memchr::memchr2(b'`', b'~', bytes).is_none() {
        return Vec::new();
    }
    let mut regions = fenced_regions(content, bytes);
    regions.sort_unstable_by_key(|&(start, _)| start);
    merge_regions(&mut regions);

    let inline = inline_code_regions(bytes, &regions);
    if inline.is_empty() {
        return regions;
    }
    regions.extend(inline);
    regions.sort_unstable_by_key(|&(start, _)| start);
    merge_regions(&mut regions);
    regions
}

pub(super) fn merge_regions(regions: &mut Vec<(usize, usize)>) {
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(regions.len());
    for &(start, end) in regions.iter() {
        match merged.last_mut() {
            Some(last) if start <= last.1 => {
                if end > last.1 {
                    last.1 = end;
                }
            }
            _ => merged.push((start, end)),
        }
    }
    *regions = merged;
}

/// One fence-marker line, matching what `(?m)^( {0,3})(`{3,}|~{3,})(.*)$`
/// captures: `index` is the line's start, `end_of_line` is the position right
/// after the line's content (before its trailing `\n`, if any).
pub(super) struct FenceLine {
    pub(super) index: usize,
    pub(super) end_of_line: usize,
    pub(super) marker_char: u8,
    pub(super) marker_len: usize,
    pub(super) rest_blank: bool,
}

/// That regex as a byte scan (pinned by `fence_scan_matches_the_fence_regex`).
/// The fence marker on the line `line_start..line_end`, if it has one.
pub(super) fn fence_at(
    content: &str,
    bytes: &[u8],
    line_start: usize,
    line_end: usize,
) -> Option<FenceLine> {
    let max_indent = (line_start + 3).min(line_end);
    let mut marker_start = line_start;
    while marker_start < max_indent && bytes[marker_start] == b' ' {
        marker_start += 1;
    }
    let marker_char = *bytes
        .get(marker_start)
        .filter(|_| marker_start < line_end)?;
    if marker_char != b'`' && marker_char != b'~' {
        return None;
    }
    let mut marker_end = marker_start;
    while marker_end < line_end && bytes[marker_end] == marker_char {
        marker_end += 1;
    }
    (marker_end - marker_start >= 3).then(|| FenceLine {
        index: line_start,
        end_of_line: line_end,
        marker_char,
        marker_len: marker_end - marker_start,
        rest_blank: content[marker_end..line_end].trim().is_empty(),
    })
}

pub(super) fn scan_fence_lines(content: &str, bytes: &[u8]) -> Vec<FenceLine> {
    let len = bytes.len();
    let mut out = Vec::new();
    let mut line_start = 0usize;
    loop {
        let line_end = memchr::memchr(b'\n', &bytes[line_start..])
            .map(|pos| line_start + pos)
            .unwrap_or(len);

        out.extend(fence_at(content, bytes, line_start, line_end));
        if line_end == len {
            break;
        }
        line_start = line_end + 1;
    }
    out
}

/// A fence line closes the most recently opened fence when the marker char
/// matches, the run is at least as long and the rest of the line is blank;
/// otherwise it opens one. A fence left open runs to the end.
pub(super) fn fenced_regions(content: &str, bytes: &[u8]) -> Vec<(usize, usize)> {
    let fence_lines = scan_fence_lines(content, bytes);

    struct OpenFence {
        pos: usize,
        marker_char: u8,
        marker_len: usize,
    }
    let mut open_fences: Vec<OpenFence> = Vec::new();
    let mut regions: Vec<(usize, usize)> = Vec::new();
    for f in &fence_lines {
        if let Some(open) = open_fences.last() {
            if f.marker_char == open.marker_char && f.marker_len >= open.marker_len && f.rest_blank
            {
                regions.push((open.pos, f.end_of_line));
                open_fences.pop();
                continue;
            }
        }
        open_fences.push(OpenFence {
            pos: f.index,
            marker_char: f.marker_char,
            marker_len: f.marker_len,
        });
    }
    for open in &open_fences {
        regions.push((open.pos, content.len()));
    }
    regions
}

/// The non-overlapping matches of ``(`+)([^`]*?)\1`` in linear time, with
/// fenced bytes treated as absent (pinned by
/// `linear_inline_scan_matches_backreference_regex`).
pub(super) fn inline_code_regions(bytes: &[u8], fenced: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut matches = Vec::new();
    let skipper = RegionCursor::new(fenced);
    let mut cursor = 0usize;
    while let Some(start) = next_backtick_outside(bytes, cursor, &skipper) {
        let opener_end = backtick_run_end(bytes, start);
        let opener_len = opener_end - start;
        let next_start = next_backtick_outside(bytes, opener_end, &skipper);

        let match_end = next_start.and_then(|closing_start| {
            let closing_len = backtick_run_end(bytes, closing_start) - closing_start;
            (closing_len >= opener_len).then_some(closing_start + opener_len)
        });

        if let Some(end) = match_end {
            matches.push((start, end));
            cursor = end;
        } else if opener_len >= 2 {
            let end = start + 2 * (opener_len / 2);
            matches.push((start, end));
            cursor = end;
        } else {
            cursor = opener_end;
        }
    }
    matches
}

/// The next backtick at or after `from` outside a fenced region.
pub(super) fn next_backtick_outside(
    bytes: &[u8],
    from: usize,
    skipper: &RegionCursor,
) -> Option<usize> {
    let mut pos = from;
    loop {
        pos = skipper.skip(pos);
        let found = pos + memchr::memchr(b'`', &bytes[pos..])?;
        let after = skipper.skip(found);
        if after == found {
            return Some(found);
        }
        pos = after;
    }
}

/// Point queries against sorted, disjoint ranges. Binary search, not a
/// forward-only pointer: a failed closing-backtick probe resumes from an
/// earlier position, so queries are not monotonic.
pub(super) struct RegionCursor<'a> {
    regions: &'a [(usize, usize)],
}

impl<'a> RegionCursor<'a> {
    pub(super) fn new(regions: &'a [(usize, usize)]) -> Self {
        Self { regions }
    }

    /// True if `pos` lies inside some region (`start <= pos < end`).
    pub(super) fn covers(&self, pos: usize) -> bool {
        match self.regions.binary_search_by(|&(start, _)| start.cmp(&pos)) {
            Ok(_) => true,
            Err(idx) => idx > 0 && self.regions[idx - 1].1 > pos,
        }
    }

    /// True if some region ends exactly at `pos` (equivalently, `pos - 1` is
    /// covered by that region) — used instead of a separate `covers(pos - 1)`
    /// query.
    pub(super) fn immediately_after_region(&self, pos: usize) -> bool {
        self.regions
            .binary_search_by(|&(_, end)| end.cmp(&pos))
            .is_ok()
    }

    /// If `pos` lies inside a region, returns that region's end (the first
    /// position outside it); otherwise returns `pos` unchanged.
    pub(super) fn skip(&self, pos: usize) -> usize {
        match self.regions.binary_search_by(|&(start, _)| start.cmp(&pos)) {
            Ok(idx) => self.regions[idx].1,
            Err(idx) if idx > 0 && self.regions[idx - 1].1 > pos => self.regions[idx - 1].1,
            Err(_) => pos,
        }
    }
}
