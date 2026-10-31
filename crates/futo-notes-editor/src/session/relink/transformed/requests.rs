//! Merge existing guard and typed identities into one canonical request index.
use super::*;
use std::ops::Range;

#[derive(Clone, Copy)]
pub(super) enum Role {
    Guard(usize),
    Typed(usize),
}
pub(super) struct Request<'a> {
    pub role: Role,
    pub range: Range<usize>,
    pub original: Option<&'a Arc<CodeWordIdentity>>,
    pub program: &'a [(usize, usize)],
}
impl rewrite::Fields {
    pub(super) fn requests<'a>(
        &'a self,
        snapshot: &'a crate::inline::PendingLinks,
        work: &mut EditWork,
    ) -> Result<Vec<Request<'a>>, EditorError> {
        let mut guards = snapshot
            .guarded_words
            .iter()
            .enumerate()
            .filter(|(i, _)| self.changed_guards[*i])
            .peekable();
        // The guard filter visits every source entry once. Count repeated
        // merge/prefix probes where they actually occur below.
        let mut origins = snapshot.typed_inputs.iter().enumerate().peekable();
        let mut next_origin = origins.next();
        let mut result = Vec::new();
        while guards.peek().is_some() || next_origin.is_some() {
            work.link_metadata_items += 1;
            while let Some((index, _)) = next_origin {
                work.link_metadata_items += 1;
                if self.changed_origins[index] {
                    break;
                }
                next_origin = origins.next();
            }
            let guard_first = guards.peek().is_some_and(|(_, word)| {
                work.link_metadata_items += 1;
                next_origin.as_ref().is_none_or(|(_, origin)| {
                    work.link_metadata_items += 1;
                    word.inner.start < origin.word.start
                })
            });
            if guard_first {
                let (index, word) = guards.next().unwrap();
                result.push(Request {
                    role: Role::Guard(index),
                    range: word.inner.clone(),
                    original: Some(&word.identity),
                    program: &self.programs[index],
                });
            } else if let Some((index, origin)) = next_origin.take() {
                result.push(Request {
                    role: Role::Typed(index),
                    range: origin.word.clone(),
                    original: origin.uri.as_ref(),
                    program: &self.origin_programs[index],
                });
                next_origin = origins.next();
            }
        }
        // The guard filter inspects each input once; emitted merge entries
        // range/role/reference table entries own no URI byte copies.
        work.link_metadata_items +=
            snapshot.guarded_words.len() + 5 * result.len() + usize::from(!result.is_empty());
        Ok(result)
    }
}
