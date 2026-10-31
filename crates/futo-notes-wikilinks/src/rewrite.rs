//! One canonical rewrite emitter, optionally reporting the source it actually copies.
use super::{find_wikilinks, link_targets_naming, resolve_wikilink};
use std::ops::Range;

#[derive(Debug, PartialEq, Eq)]
pub struct RewriteRange {
    pub before: Range<usize>,
    pub after: Range<usize>,
}

/// Ranges belong to this one actual input/output generation. Replacements
/// include every emitted bracket; equal spelling does not make them copied.
pub struct WikilinkRewrite {
    pub source: String,
    pub rewrites: u32,
    pub input_len: usize,
    pub copied: Vec<RewriteRange>,
    pub replaced: Vec<RewriteRange>,
}

/// Observe the existing canonical rewrite without changing its resolution or
/// text-level scope. Legacy callers keep the same emitter with no observer Vec.
pub fn observe_wikilink_rewrite(
    text: &str,
    old_id: &str,
    new_id: &str,
    all_ids: &[String],
) -> WikilinkRewrite {
    let mut copied: Vec<RewriteRange> = Vec::new();
    let mut replaced = Vec::new();
    let (source, rewrites) = rewrite(
        text,
        old_id,
        new_id,
        all_ids,
        Some(&mut |changed, before, after| {
            if before.is_empty() && after.is_empty() {
                return;
            }
            if changed {
                replaced.push(RewriteRange { before, after });
            } else if let Some(last) = copied
                .last_mut()
                .filter(|last| last.before.end == before.start && last.after.end == after.start)
            {
                last.before.end = before.end;
                last.after.end = after.end;
            } else {
                copied.push(RewriteRange { before, after });
            }
        }),
    );
    WikilinkRewrite {
        source,
        rewrites,
        input_len: text.len(),
        copied,
        replaced,
    }
}

type Observer<'a> = Option<&'a mut dyn FnMut(bool, Range<usize>, Range<usize>)>;
fn copy(out: &mut String, text: &str, range: Range<usize>, observer: &mut Observer<'_>) {
    let start = out.len();
    out.push_str(&text[range.clone()]);
    if let Some(observer) = observer.as_deref_mut() {
        observer(false, range, start..out.len());
    }
}

pub(super) fn rewrite(
    text: &str,
    old_id: &str,
    new_id: &str,
    all_ids: &[String],
    mut observer: Observer<'_>,
) -> (String, u32) {
    let could_name_old_id =
        |target: &str| link_targets_naming(old_id).any(|naming| naming == target);
    let occurrences = find_wikilinks(text);
    if !occurrences.iter().any(|occ| could_name_old_id(&occ.target)) {
        if let Some(observer) = observer.as_deref_mut() {
            observer(false, 0..text.len(), 0..text.len());
        }
        return (text.to_string(), 0);
    }
    // The id-resolution context must include `old_id` so legacy bare-filename
    // links targeting it still resolve. Replace `new_id` with `old_id` so
    // resolution sees the pre-rename universe.
    let mut ctx = all_ids.to_vec();
    if !ctx.iter().any(|id| id == old_id) {
        if let Some(position) = ctx.iter().position(|id| id == new_id) {
            ctx[position] = old_id.to_owned();
        } else {
            ctx.push(old_id.to_owned());
        }
    }
    let mut rewrites = 0u32;
    let mut cursor = 0usize;
    let mut out = String::with_capacity(text.len());
    for occ in &occurrences {
        copy(&mut out, text, cursor..occ.start, &mut observer);
        if could_name_old_id(&occ.target)
            && resolve_wikilink(&occ.target, &ctx).as_deref() == Some(old_id)
        {
            let start = out.len();
            out.push_str("[[");
            out.push_str(new_id);
            out.push_str("]]");
            if let Some(observer) = observer.as_deref_mut() {
                observer(true, occ.start..occ.end, start..out.len());
            }
            rewrites += 1;
        } else {
            copy(&mut out, text, occ.start..occ.end, &mut observer);
        }
        cursor = occ.end;
    }
    copy(&mut out, text, cursor..text.len(), &mut observer);
    (out, rewrites)
}
