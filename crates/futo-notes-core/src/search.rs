//! Chunking, RRF fusion, and embedding text helpers for search.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Default target tokens per chunk (used by [`chunk_content`]).
///
/// SPLADE callers should use [`chunk_content_with_target`] with ~400 so chunks
/// fit inside DistilBERT's 512-WordPiece-token cap (word-count × 1.3 ≈ 520
/// WordPiece tokens worst case).
const TARGET_TOKENS: usize = 900;

/// Overlap ratio between adjacent chunks.
const OVERLAP_RATIO: f64 = 0.15;

/// Notes shorter than this (in estimated tokens) become a single chunk.
const SHORT_NOTE_THRESHOLD: usize = 512;

/// Default K for Reciprocal Rank Fusion.
const RRF_K: f64 = 60.0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A chunk of note content with byte offsets into the original text.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    pub text: String,
    pub start_offset: usize,
    pub end_offset: usize,
}

/// A search hit returned by RRF fusion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub filename: String,
    pub snippet: String,
    pub score: f64,
    pub source: SearchSource,
}

/// Where a search hit came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchSource {
    Keyword,
    Vector,
    Both,
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/// Estimate token count from text. Approximation: word_count * 1.3.
pub fn estimate_tokens(text: &str) -> usize {
    let words = text.split_whitespace().count();
    ((words as f64) * 1.3).ceil() as usize
}

// ---------------------------------------------------------------------------
// Embedding text builder
// ---------------------------------------------------------------------------

/// Build the text sent to the embedding model for a chunk.
/// Prepends the note title (filename without `.md` extension).
pub fn build_embedding_text(filename: &str, chunk_text: &str) -> String {
    let title = filename.strip_suffix(".md").unwrap_or(filename);
    format!("Title: {title}\n\n{chunk_text}")
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/// Internal section produced by boundary splitting.
struct Section {
    text: String,
    start_offset: usize,
    end_offset: usize,
}

/// Split markdown content into overlapping chunks suitable for embedding,
/// using the default [`TARGET_TOKENS`] (900).
///
/// Algorithm (ported from V1 `chunker.ts`):
/// 1. Short notes (< 512 estimated tokens) → single chunk
/// 2. Split at heading boundaries (`# `, `## `, etc.)
/// 3. Split large sections at paragraph boundaries (`\n\n+`)
/// 4. Split oversized paragraphs by word count
/// 5. Merge small sections with ~15% overlap
pub fn chunk_content(content: &str) -> Vec<Chunk> {
    chunk_content_with_target(content, TARGET_TOKENS)
}

/// Same as [`chunk_content`] but with a configurable target token count per
/// chunk. SPLADE callers pass ~400 to keep chunks under DistilBERT's 512-token
/// position-embedding cap.
pub fn chunk_content_with_target(content: &str, target_tokens: usize) -> Vec<Chunk> {
    if content.is_empty() {
        return vec![];
    }

    // Short-note threshold is independent of target_tokens — if the whole note
    // fits in <512 estimated tokens (its own DistilBERT cap), keep it as one
    // chunk regardless of the target.
    let short_threshold = SHORT_NOTE_THRESHOLD.min(target_tokens);

    let tokens = estimate_tokens(content);
    if tokens <= short_threshold {
        return vec![Chunk {
            text: content.to_string(),
            start_offset: 0,
            end_offset: content.len(),
        }];
    }

    let sections = split_at_headings(content);
    let sections = split_large_sections(sections, target_tokens);
    merge_with_overlap(sections, target_tokens)
}

/// Split content at markdown heading boundaries (lines starting with `# `, `## `, etc.).
fn split_at_headings(content: &str) -> Vec<Section> {
    let mut sections = Vec::new();
    let mut current_start = 0;
    let mut current_text = String::new();

    for line in content.split_inclusive('\n') {
        let trimmed = line.trim_start();
        let is_heading = trimmed.starts_with('#')
            && trimmed.chars().take_while(|&c| c == '#').count().min(6) > 0
            && (trimmed.chars().find(|&c| c != '#') == Some(' '));

        if is_heading && !current_text.is_empty() {
            let end = current_start + current_text.len();
            sections.push(Section {
                text: current_text,
                start_offset: current_start,
                end_offset: end,
            });
            current_start = end;
            current_text = String::new();
        }
        current_text.push_str(line);
    }

    if !current_text.is_empty() {
        let end = current_start + current_text.len();
        sections.push(Section {
            text: current_text,
            start_offset: current_start,
            end_offset: end,
        });
    }

    sections
}

/// Split sections that exceed `target_tokens` at paragraph boundaries (\n\n+),
/// then by word count as a last resort.
fn split_large_sections(sections: Vec<Section>, target_tokens: usize) -> Vec<Section> {
    let mut result = Vec::new();

    for section in sections {
        if estimate_tokens(&section.text) <= target_tokens {
            result.push(section);
            continue;
        }

        // Split at paragraph boundaries
        let paragraphs = split_at_paragraphs(&section);
        for para in paragraphs {
            if estimate_tokens(&para.text) <= target_tokens {
                result.push(para);
            } else {
                // Last resort: split by word count
                let word_sections = split_by_word_count(&para, target_tokens);
                result.extend(word_sections);
            }
        }
    }

    result
}

/// Split a section at double-newline paragraph boundaries.
fn split_at_paragraphs(section: &Section) -> Vec<Section> {
    let text = &section.text;
    let mut sections = Vec::new();
    let mut pos = 0;

    while pos < text.len() {
        // Find next \n\n
        let boundary = find_paragraph_boundary(text, pos);
        match boundary {
            Some(end) => {
                let chunk = &text[pos..end];
                if !chunk.trim().is_empty() {
                    sections.push(Section {
                        text: chunk.to_string(),
                        start_offset: section.start_offset + pos,
                        end_offset: section.start_offset + end,
                    });
                }
                pos = end;
            }
            None => {
                let chunk = &text[pos..];
                if !chunk.trim().is_empty() {
                    sections.push(Section {
                        text: chunk.to_string(),
                        start_offset: section.start_offset + pos,
                        end_offset: section.start_offset + text.len(),
                    });
                }
                break;
            }
        }
    }

    if sections.is_empty() && !text.trim().is_empty() {
        sections.push(Section {
            text: text.to_string(),
            start_offset: section.start_offset,
            end_offset: section.end_offset,
        });
    }

    sections
}

/// Find the next paragraph boundary (\n\n+) after `start`.
fn find_paragraph_boundary(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = start;
    while i + 1 < bytes.len() {
        if bytes[i] == b'\n' && bytes[i + 1] == b'\n' {
            // Consume all consecutive newlines
            let mut end = i + 2;
            while end < bytes.len() && bytes[end] == b'\n' {
                end += 1;
            }
            // Don't return boundary at the very start
            if i > start {
                return Some(end);
            }
            i = end;
        } else {
            i += 1;
        }
    }
    None
}

/// Split an oversized section by word count as a fallback.
fn split_by_word_count(section: &Section, target_tokens: usize) -> Vec<Section> {
    let target_words = (target_tokens as f64 / 1.3).floor() as usize;
    let text = &section.text;
    let mut sections = Vec::new();
    let mut word_count = 0;
    let mut chunk_start = 0;
    let mut last_ws_end = 0;

    let bytes = text.as_bytes();
    let mut i = 0;
    let mut in_word = false;

    while i < bytes.len() {
        let is_ws = bytes[i] == b' ' || bytes[i] == b'\n' || bytes[i] == b'\t' || bytes[i] == b'\r';
        if in_word && is_ws {
            in_word = false;
            word_count += 1;
            last_ws_end = i;
            if word_count >= target_words && i > chunk_start {
                // Consume trailing whitespace
                let mut ws_end = i;
                while ws_end < bytes.len()
                    && (bytes[ws_end] == b' '
                        || bytes[ws_end] == b'\n'
                        || bytes[ws_end] == b'\t'
                        || bytes[ws_end] == b'\r')
                {
                    ws_end += 1;
                }
                let chunk = &text[chunk_start..ws_end];
                if !chunk.trim().is_empty() {
                    sections.push(Section {
                        text: chunk.to_string(),
                        start_offset: section.start_offset + chunk_start,
                        end_offset: section.start_offset + ws_end,
                    });
                }
                chunk_start = ws_end;
                word_count = 0;
                i = ws_end;
                continue;
            }
        } else if !in_word && !is_ws {
            in_word = true;
        }
        i += 1;
    }

    // Handle trailing content
    let _ = (last_ws_end, in_word);
    if chunk_start < text.len() {
        let chunk = &text[chunk_start..];
        if !chunk.trim().is_empty() {
            sections.push(Section {
                text: chunk.to_string(),
                start_offset: section.start_offset + chunk_start,
                end_offset: section.start_offset + text.len(),
            });
        }
    }

    sections
}

/// Merge sections into chunks with ~15% overlap.
fn merge_with_overlap(sections: Vec<Section>, target_tokens: usize) -> Vec<Chunk> {
    if sections.is_empty() {
        return vec![];
    }

    let overlap_tokens = (target_tokens as f64 * OVERLAP_RATIO).floor() as usize;
    let mut chunks = Vec::new();
    let mut current_text = String::new();
    let mut current_start = sections[0].start_offset;

    for section in &sections {
        let combined_tokens = estimate_tokens(&current_text) + estimate_tokens(&section.text);

        if !current_text.is_empty() && combined_tokens > target_tokens {
            // Emit current chunk
            let end = current_start + current_text.len();
            let overlap = get_overlap_text(&current_text, overlap_tokens);
            chunks.push(Chunk {
                text: current_text,
                start_offset: current_start,
                end_offset: end,
            });

            // Start new chunk with overlap from end of previous
            current_start = end - overlap.len();
            current_text = overlap;
        }

        current_text.push_str(&section.text);
    }

    // Emit final chunk
    if !current_text.is_empty() {
        chunks.push(Chunk {
            text: current_text.clone(),
            start_offset: current_start,
            end_offset: current_start + current_text.len(),
        });
    }

    chunks
}

/// Extract the last N estimated tokens from text for overlap.
fn get_overlap_text(text: &str, overlap_tokens: usize) -> String {
    let overlap_words = (overlap_tokens as f64 / 1.3).ceil() as usize;
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() <= overlap_words {
        return text.to_string();
    }
    let start_word = words.len() - overlap_words;
    // Find byte offset of the start word
    let mut byte_pos = 0;
    let mut word_idx = 0;
    let bytes = text.as_bytes();
    let mut in_word = false;
    for (i, &b) in bytes.iter().enumerate() {
        let is_ws = b == b' ' || b == b'\n' || b == b'\t' || b == b'\r';
        if !in_word && !is_ws {
            if word_idx == start_word {
                byte_pos = i;
                break;
            }
            in_word = true;
        } else if in_word && is_ws {
            in_word = false;
            word_idx += 1;
        }
    }
    text[byte_pos..].to_string()
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

/// Fuse keyword and vector search results using Reciprocal Rank Fusion.
///
/// Each input is a ranked list of `(filename, score)` pairs (score unused for
/// ranking — position in the list determines rank). Returns a merged list
/// sorted by fused RRF score descending.
pub fn rrf_fuse(
    keyword_results: &[(String, f64)],
    vector_results: &[(String, f64)],
    k: Option<f64>,
) -> Vec<(String, f64)> {
    let k = k.unwrap_or(RRF_K);
    let mut scores: HashMap<String, f64> = HashMap::new();

    for (rank, (filename, _)) in keyword_results.iter().enumerate() {
        *scores.entry(filename.clone()).or_default() += 1.0 / (k + rank as f64);
    }

    for (rank, (filename, _)) in vector_results.iter().enumerate() {
        *scores.entry(filename.clone()).or_default() += 1.0 / (k + rank as f64);
    }

    let mut results: Vec<(String, f64)> = scores.into_iter().collect();
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results
}

/// Determine the source of a search hit given keyword and vector result sets.
pub fn determine_source(
    filename: &str,
    keyword_filenames: &[String],
    vector_filenames: &[String],
) -> SearchSource {
    let in_keyword = keyword_filenames.iter().any(|f| f == filename);
    let in_vector = vector_filenames.iter().any(|f| f == filename);
    match (in_keyword, in_vector) {
        (true, true) => SearchSource::Both,
        (true, false) => SearchSource::Keyword,
        (false, true) => SearchSource::Vector,
        (false, false) => SearchSource::Keyword, // shouldn't happen
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- estimate_tokens --

    #[test]
    fn test_estimate_tokens_empty() {
        assert_eq!(estimate_tokens(""), 0);
    }

    #[test]
    fn test_estimate_tokens_short() {
        // 5 words * 1.3 = 6.5 → ceil = 7
        assert_eq!(estimate_tokens("one two three four five"), 7);
    }

    // -- build_embedding_text --

    #[test]
    fn test_build_embedding_text() {
        let result = build_embedding_text("grocery list.md", "Buy milk and eggs");
        assert_eq!(result, "Title: grocery list\n\nBuy milk and eggs");
    }

    #[test]
    fn test_build_embedding_text_no_extension() {
        let result = build_embedding_text("notes", "some text");
        assert_eq!(result, "Title: notes\n\nsome text");
    }

    // -- chunk_content --

    #[test]
    fn test_chunk_empty() {
        assert!(chunk_content("").is_empty());
    }

    #[test]
    fn test_chunk_short_note() {
        let content = "A short note with just a few words.";
        let chunks = chunk_content(content);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, content);
        assert_eq!(chunks[0].start_offset, 0);
        assert_eq!(chunks[0].end_offset, content.len());
    }

    #[test]
    fn test_chunk_heading_boundaries() {
        // Each section needs enough content to exceed SHORT_NOTE_THRESHOLD combined
        let mut content = String::new();
        content.push_str("# Section 1\n");
        for _ in 0..500 {
            content.push_str("word ");
        }
        content.push_str("\n# Section 2\n");
        for _ in 0..500 {
            content.push_str("word ");
        }
        content.push_str("\n# Section 3\n");
        for _ in 0..500 {
            content.push_str("word ");
        }

        let chunks = chunk_content(&content);
        assert!(
            chunks.len() >= 2,
            "should split at heading boundaries, got {} chunks",
            chunks.len()
        );
    }

    #[test]
    fn test_chunk_overlap() {
        // Create content long enough for multiple chunks with unique words
        let mut content = String::new();
        for i in 0..1500 {
            content.push_str(&format!("uniqueword{i} "));
        }

        let chunks = chunk_content(&content);
        assert!(
            chunks.len() >= 2,
            "should produce multiple chunks, got {}",
            chunks.len()
        );

        // Verify chunks have overlapping offset ranges (start of N+1 < end of N)
        for i in 0..chunks.len() - 1 {
            assert!(
                chunks[i + 1].start_offset < chunks[i].end_offset,
                "chunk {} end ({}) should overlap with chunk {} start ({})",
                i,
                chunks[i].end_offset,
                i + 1,
                chunks[i + 1].start_offset,
            );
        }
    }

    #[test]
    fn test_chunk_paragraph_boundaries() {
        let mut content = String::new();
        for _ in 0..400 {
            content.push_str("word ");
        }
        content.push_str("\n\n");
        for _ in 0..400 {
            content.push_str("word ");
        }

        let chunks = chunk_content(&content);
        assert!(chunks.len() >= 2);
    }

    #[test]
    fn test_chunk_offsets_valid() {
        let mut content = String::new();
        for i in 0..800 {
            content.push_str(&format!("word{i} "));
        }

        let chunks = chunk_content(&content);
        for chunk in &chunks {
            assert!(chunk.start_offset <= chunk.end_offset);
            assert!(chunk.end_offset <= content.len());
        }
    }

    // -- rrf_fuse --

    #[test]
    fn test_rrf_keyword_only() {
        let keyword = vec![("a.md".to_string(), 1.0), ("b.md".to_string(), 0.5)];
        let vector: Vec<(String, f64)> = vec![];
        let results = rrf_fuse(&keyword, &vector, None);
        assert_eq!(results[0].0, "a.md");
        assert_eq!(results[1].0, "b.md");
    }

    #[test]
    fn test_rrf_both_lists_boost() {
        let keyword = vec![("a.md".to_string(), 1.0), ("b.md".to_string(), 0.5)];
        let vector = vec![("b.md".to_string(), 1.0), ("c.md".to_string(), 0.5)];
        let results = rrf_fuse(&keyword, &vector, None);
        // b.md appears in both lists so should rank highest
        assert_eq!(results[0].0, "b.md");
    }

    #[test]
    fn test_rrf_rank_0_both_highest() {
        let keyword = vec![("a.md".to_string(), 1.0)];
        let vector = vec![("a.md".to_string(), 1.0)];
        let results = rrf_fuse(&keyword, &vector, None);
        assert_eq!(results.len(), 1);
        // Score should be 2 * 1/(60+0) ≈ 0.0333
        let expected = 2.0 / 60.0;
        assert!((results[0].1 - expected).abs() < 1e-10);
    }

    // -- determine_source --

    #[test]
    fn test_determine_source() {
        let kw = vec!["a.md".to_string(), "b.md".to_string()];
        let vec = vec!["b.md".to_string(), "c.md".to_string()];
        assert_eq!(determine_source("a.md", &kw, &vec), SearchSource::Keyword);
        assert_eq!(determine_source("b.md", &kw, &vec), SearchSource::Both);
        assert_eq!(determine_source("c.md", &kw, &vec), SearchSource::Vector);
    }
}
