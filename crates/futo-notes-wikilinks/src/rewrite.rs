//! One canonical rewrite emitter, optionally reporting the source it actually copies.
use super::{
    copied, find_wikilinks_with_work, items, link_targets_naming, resolve_wikilink_with_work,
};
use std::ops::Range;

#[derive(Debug, PartialEq, Eq)]
pub struct RewriteRange {
    pub before: Range<usize>,
    pub after: Range<usize>,
}

/// Visits and owned target/context copies at the actual rewrite owner. These
/// are not markdown-parser input or a complete CPU/allocation measurement.
#[derive(Default)]
pub struct RewriteWork {
    pub metadata_items: usize,
    pub copied_bytes: usize,
}

/// Ranges belong to this one actual input/output generation. Replacements
/// include every emitted bracket; equal spelling does not make them copied.
pub struct WikilinkRewrite {
    pub source: String,
    pub rewrites: u32,
    pub input_len: usize,
    pub copied: Vec<RewriteRange>,
    pub replaced: Vec<RewriteRange>,
    pub work: RewriteWork,
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
    let mut work = RewriteWork::default();
    let mut event_items = 0;
    let (source, rewrites) = rewrite(
        text,
        old_id,
        new_id,
        all_ids,
        Some(&mut |changed, before, after| {
            event_items += 2;
            if before.is_empty() && after.is_empty() {
                return;
            }
            event_items += 1;
            if changed {
                event_items += 4 + usize::from(replaced.len() == replaced.capacity());
                replaced.push(RewriteRange { before, after });
            } else if let Some(last) = copied.last_mut().filter(|last| {
                event_items += 2;
                last.before.end == before.start && last.after.end == after.start
            }) {
                event_items += 2;
                last.before.end = before.end;
                last.after.end = after.end;
            } else {
                event_items += 4 + usize::from(copied.len() == copied.capacity());
                copied.push(RewriteRange { before, after });
            }
        }),
        Some(&mut work),
    );
    work.metadata_items += event_items;
    WikilinkRewrite {
        source,
        rewrites,
        input_len: text.len(),
        copied,
        replaced,
        work,
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
    mut work: Option<&mut RewriteWork>,
) -> (String, u32) {
    let occurrences = find_wikilinks_with_work(text, work.as_deref_mut());
    if !occurrences
        .iter()
        .any(|occ| could_name(&occ.target, old_id, &mut work))
    {
        if let Some(observer) = observer.as_deref_mut() {
            observer(false, 0..text.len(), 0..text.len());
        }
        return (text.to_string(), 0);
    }
    // The id-resolution context must include `old_id` so legacy bare-filename
    // links targeting it still resolve. Replace `new_id` with `old_id` so
    // resolution sees the pre-rename universe.
    items(&mut work, usize::from(!all_ids.is_empty()));
    let mut ctx: Vec<String> = all_ids
        .iter()
        .map(|id| {
            items(&mut work, 1);
            copied(&mut work, id.len());
            id.clone()
        })
        .collect();
    if !ctx.iter().any(|id| {
        items(&mut work, 1);
        id == old_id
    }) {
        copied(&mut work, old_id.len());
        if let Some(position) = ctx.iter().position(|id| {
            items(&mut work, 1);
            id == new_id
        }) {
            ctx[position] = old_id.to_owned();
        } else {
            items(&mut work, 1 + usize::from(ctx.len() == ctx.capacity()));
            ctx.push(old_id.to_owned());
        }
    }
    let mut rewrites = 0u32;
    let mut cursor = 0usize;
    let mut out = String::with_capacity(text.len());
    for occ in &occurrences {
        items(&mut work, 1);
        copy(&mut out, text, cursor..occ.start, &mut observer);
        if could_name(&occ.target, old_id, &mut work)
            && resolve_wikilink_with_work(&occ.target, &ctx, work.as_deref_mut()).as_deref()
                == Some(old_id)
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

fn could_name(target: &str, old_id: &str, work: &mut Option<&mut RewriteWork>) -> bool {
    link_targets_naming(old_id).any(|naming| {
        items(work, 1);
        naming == target
    })
}
