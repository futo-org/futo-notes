//! Custom Tantivy `Query` for SPLADE sparse dot-product.
//!
//! Standard Lucene-style SPLADE: each document indexes its expansion terms
//! with `term_freq = round(weight * SPLADE_SCALE)`. The query carries a
//! `(token, weight)` list. For every doc matching at least one query term,
//! the score is `Σ (query_weight * doc_term_freq / SPLADE_SCALE)`.
//!
//! We can't reuse Tantivy's `TermQuery` because BM25 scoring isn't what we
//! want; we explicitly want the raw `term_freq` as the per-term contribution.
//! So we implement a small custom `Query`/`Weight`/`Scorer` triple that walks
//! the posting lists ourselves.

use std::collections::HashMap;

use tantivy::postings::Postings;
use tantivy::query::{EnableScoring, Explanation, Query, Scorer, Weight};
use tantivy::schema::{Field, IndexRecordOption};
use tantivy::{DocId, DocSet, Score, SegmentReader, Term, TERMINATED};

use crate::SPLADE_SCALE;

/// Build a SPLADE query from `(token_id, weight)` pairs. The text form
/// `"t{id}"` must match what the indexer writes (`build_splade_pretokenized`).
#[derive(Debug, Clone)]
pub struct WeightedSpladeQuery {
    field: Field,
    /// (term_text, query_weight)
    terms: Vec<(String, f32)>,
}

impl WeightedSpladeQuery {
    pub fn new(field: Field, pairs: Vec<(u32, f32)>) -> Self {
        let terms = pairs
            .into_iter()
            .filter(|(_, w)| *w > 0.0)
            .map(|(idx, w)| (format!("t{}", idx), w))
            .collect();
        Self { field, terms }
    }
}

impl Query for WeightedSpladeQuery {
    fn weight(&self, _enable_scoring: EnableScoring<'_>) -> tantivy::Result<Box<dyn Weight>> {
        Ok(Box::new(WeightedSpladeWeight {
            field: self.field,
            terms: self.terms.clone(),
        }))
    }
}

struct WeightedSpladeWeight {
    field: Field,
    terms: Vec<(String, f32)>,
}

impl Weight for WeightedSpladeWeight {
    fn scorer(&self, reader: &SegmentReader, _boost: Score) -> tantivy::Result<Box<dyn Scorer>> {
        // Open posting lists for every query term. Postings missing from
        // the segment simply contribute nothing.
        let inverted = reader.inverted_index(self.field)?;
        let mut posting_lists: Vec<(f32, tantivy::postings::SegmentPostings)> =
            Vec::with_capacity(self.terms.len());
        for (text, qw) in &self.terms {
            let term = Term::from_field_text(self.field, text);
            if let Some(p) = inverted.read_postings(&term, IndexRecordOption::WithFreqs)? {
                posting_lists.push((*qw, p));
            }
        }
        Ok(Box::new(WeightedSpladeScorer::new(posting_lists)))
    }

    fn explain(&self, reader: &SegmentReader, doc: DocId) -> tantivy::Result<Explanation> {
        let mut scorer = self.scorer(reader, 1.0)?;
        // Advance to (or past) the requested doc.
        let mut cur = scorer.doc();
        while cur != TERMINATED && cur < doc {
            cur = scorer.advance();
        }
        let score = if cur == doc { scorer.score() } else { 0.0 };
        Ok(Explanation::new("WeightedSpladeQuery dot-product", score))
    }

    fn count(&self, reader: &SegmentReader) -> tantivy::Result<u32> {
        let mut scorer = self.scorer(reader, 1.0)?;
        let mut n = 0u32;
        let mut cur = scorer.doc();
        while cur != TERMINATED {
            n += 1;
            cur = scorer.advance();
        }
        Ok(n)
    }
}

/// Heap-merge style scorer: iterate posting lists in sync, pick the doc with
/// minimum current id, sum weighted contributions across all lists that
/// match, then advance.
struct WeightedSpladeScorer {
    postings: Vec<(f32, tantivy::postings::SegmentPostings)>,
    cur_doc: DocId,
    cur_score: f32,
}

impl WeightedSpladeScorer {
    fn new(postings: Vec<(f32, tantivy::postings::SegmentPostings)>) -> Self {
        let mut me = Self {
            postings,
            cur_doc: TERMINATED,
            cur_score: 0.0,
        };
        me.recompute_current();
        me
    }

    /// Find the minimum live doc id across all postings; sum weighted
    /// freqs from any list at that doc.
    fn recompute_current(&mut self) {
        let mut min_doc: DocId = TERMINATED;
        for (_, p) in &self.postings {
            let d = p.doc();
            if d < min_doc {
                min_doc = d;
            }
        }
        if min_doc == TERMINATED {
            self.cur_doc = TERMINATED;
            self.cur_score = 0.0;
            return;
        }
        let mut s: f32 = 0.0;
        for (qw, p) in &self.postings {
            if p.doc() == min_doc {
                let tf = p.term_freq() as f32;
                s += qw * (tf / SPLADE_SCALE);
            }
        }
        self.cur_doc = min_doc;
        self.cur_score = s;
    }
}

impl DocSet for WeightedSpladeScorer {
    fn advance(&mut self) -> DocId {
        if self.cur_doc == TERMINATED {
            return TERMINATED;
        }
        let cur = self.cur_doc;
        // Advance any posting whose current doc equals the one we just yielded.
        for (_, p) in self.postings.iter_mut() {
            if p.doc() == cur {
                p.advance();
            }
        }
        self.recompute_current();
        self.cur_doc
    }

    fn seek(&mut self, target: DocId) -> DocId {
        if self.cur_doc == TERMINATED {
            return TERMINATED;
        }
        for (_, p) in self.postings.iter_mut() {
            if p.doc() < target {
                p.seek(target);
            }
        }
        self.recompute_current();
        self.cur_doc
    }

    fn doc(&self) -> DocId {
        self.cur_doc
    }

    fn size_hint(&self) -> u32 {
        self.postings.iter().map(|(_, p)| p.size_hint()).max().unwrap_or(0)
    }
}

impl Scorer for WeightedSpladeScorer {
    fn score(&mut self) -> Score {
        self.cur_score
    }
}

/// Maps tantivy DocId → note_id and chunk_idx via the searcher's stored fields.
/// Helpers around `Searcher::doc()` for the SPLADE schema, exposed for tests.
pub fn doc_note_id(
    searcher: &tantivy::Searcher,
    note_id_field: Field,
    addr: tantivy::DocAddress,
) -> Option<String> {
    use tantivy::schema::Value;
    let doc: tantivy::TantivyDocument = searcher.doc(addr).ok()?;
    doc.get_first(note_id_field)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
}

/// Collapse top-K chunk hits to top-K note hits (keep the best chunk per note).
pub fn dedupe_by_note(hits: Vec<(String, f32)>) -> Vec<(String, f32)> {
    let mut best: HashMap<String, f32> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for (id, score) in hits {
        match best.get_mut(&id) {
            Some(prev) => {
                if score > *prev {
                    *prev = score;
                }
            }
            None => {
                order.push(id.clone());
                best.insert(id, score);
            }
        }
    }
    let mut out: Vec<(String, f32)> = order
        .into_iter()
        .map(|id| {
            let s = best.get(&id).copied().unwrap_or(0.0);
            (id, s)
        })
        .collect();
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupe_keeps_best_chunk() {
        let hits = vec![
            ("note_a".to_string(), 1.0),
            ("note_b".to_string(), 0.5),
            ("note_a".to_string(), 1.5), // better chunk wins
            ("note_c".to_string(), 0.9),
            ("note_a".to_string(), 0.4),
        ];
        let out = dedupe_by_note(hits);
        assert_eq!(out[0].0, "note_a");
        assert!((out[0].1 - 1.5).abs() < 1e-6);
        assert_eq!(out[1].0, "note_c");
        assert_eq!(out[2].0, "note_b");
    }
}
