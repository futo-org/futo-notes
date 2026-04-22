//! Concrete [`Embedder`] over an ONNX Runtime session.
//!
//! Design notes:
//!
//! - Mean-pool the last hidden state, masking out padding tokens, then
//!   L2-normalize so cosine similarity reduces to a dot product. This matches
//!   what sentence-transformers and nomic's own reference code do, so vectors
//!   we compute locally are comparable with published nomic embeddings.
//! - We take `&mut self` on `embed*` methods because ORT's `Session::run`
//!   borrows the session mutably. If that turns out to be a pain for callers,
//!   we can wrap the session in a `Mutex` later — but for Phase 1 the indexer
//!   owns the embedder exclusively.
//! - The session is BERT-style (nomic-bert-2048): requires three int64 inputs
//!   (`input_ids`, `attention_mask`, `token_type_ids`) and emits
//!   `last_hidden_state` of shape `[batch, seq, dims]`.

use std::path::Path;

use ort::{
    inputs,
    session::{builder::GraphOptimizationLevel, Session},
    value::TensorRef,
};
use tokenizers::{PaddingParams, Tokenizer, TruncationDirection, TruncationParams, TruncationStrategy};

use crate::{NOMIC_DOCUMENT_PREFIX, NOMIC_QUERY_PREFIX};

/// Maximum sequence length we feed the model. `futo-notes-core::search` chunks
/// around 900 estimated tokens, so 512 truncation is a defensive upper bound
/// and keeps mobile latency predictable.
const MAX_SEQ_LEN: usize = 512;

/// Errors produced by the embedder.
#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("ort: {0}")]
    Ort(String),

    #[error("tokenizer: {0}")]
    Tokenizer(String),

    #[error("shape: {0}")]
    Shape(String),

    #[error("http: {0}")]
    Http(String),

    #[error("hash mismatch on downloaded file")]
    HashMismatch,

    #[error("model output `last_hidden_state` missing or wrong dtype")]
    BadModelOutput,
}

pub type Result<T> = std::result::Result<T, Error>;

// ort 2.0's `ort::Error<T>` is generic over a context tag (e.g. `SessionBuilder`),
// so we can't use `#[from]` — write a blanket conversion that stringifies any
// variant we encounter.
impl<T> From<ort::Error<T>> for Error {
    fn from(e: ort::Error<T>) -> Self {
        Error::Ort(e.to_string())
    }
}

/// A loaded embedding model.
pub struct Embedder {
    session: Session,
    tokenizer: Tokenizer,
    dims: usize,
}

impl Embedder {
    /// Load an ONNX model + `tokenizer.json` from disk.
    ///
    /// `dims` is the expected output dimensionality — currently always 768 for
    /// nomic-embed-text-v1.5, but exposed so a future Matryoshka-truncated
    /// variant can declare a different value.
    pub fn load(model_path: &Path, tokenizer_path: &Path, dims: usize) -> Result<Self> {
        let mut tokenizer =
            Tokenizer::from_file(tokenizer_path).map_err(|e| Error::Tokenizer(e.to_string()))?;

        // Pad to longest-in-batch, truncate to MAX_SEQ_LEN. Pad id 0 matches
        // the `[PAD]` token for BERT-style tokenizers (nomic included); if we
        // swap in a model with a different pad id we'll need to read it from
        // the tokenizer.
        tokenizer.with_padding(Some(PaddingParams::default()));
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_SEQ_LEN,
                strategy: TruncationStrategy::LongestFirst,
                stride: 0,
                direction: TruncationDirection::Right,
            }))
            .map_err(|e| Error::Tokenizer(e.to_string()))?;

        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(4))
            .unwrap_or(2);

        let session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(threads)?
            .commit_from_file(model_path)?;

        Ok(Self {
            session,
            tokenizer,
            dims,
        })
    }

    /// Output dimensionality. Caller can pre-allocate result buffers with this.
    pub fn dims(&self) -> usize {
        self.dims
    }

    /// Embed a single document chunk. Applies nomic's `search_document:` prefix.
    pub fn embed(&mut self, text: &str) -> Result<Vec<f32>> {
        let prefixed = format!("{NOMIC_DOCUMENT_PREFIX}{text}");
        let mut out = self.embed_batch_prefixed(&[prefixed])?;
        Ok(out.pop().expect("embed_batch returned empty for non-empty input"))
    }

    /// Embed a search query. Applies nomic's `search_query:` prefix.
    pub fn embed_query(&mut self, text: &str) -> Result<Vec<f32>> {
        let prefixed = format!("{NOMIC_QUERY_PREFIX}{text}");
        let mut out = self.embed_batch_prefixed(&[prefixed])?;
        Ok(out.pop().expect("embed_batch returned empty for non-empty input"))
    }

    /// Embed a batch of document chunks. Much faster than calling [`embed`] in
    /// a loop because ORT amortizes session overhead across the batch.
    pub fn embed_batch(&mut self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        let prefixed: Vec<String> = texts
            .iter()
            .map(|t| format!("{NOMIC_DOCUMENT_PREFIX}{t}"))
            .collect();
        self.embed_batch_prefixed(&prefixed)
    }

    /// Internal: run the ORT session over a pre-prefixed batch.
    ///
    /// Kept private because callers should go through `embed` / `embed_query`
    /// to get the correct instruction prefix.
    fn embed_batch_prefixed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        // Tokenize the whole batch at once so padding is applied consistently.
        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| Error::Tokenizer(e.to_string()))?;

        let batch = encodings.len();
        let seq_len = encodings[0].get_ids().len();

        // Flatten batch → [batch * seq_len] so we can build ndarray views
        // without an extra transpose.
        let mut input_ids = Vec::with_capacity(batch * seq_len);
        let mut attention_mask = Vec::with_capacity(batch * seq_len);
        let mut token_type_ids = Vec::with_capacity(batch * seq_len);
        for enc in &encodings {
            input_ids.extend(enc.get_ids().iter().map(|&x| x as i64));
            attention_mask.extend(enc.get_attention_mask().iter().map(|&x| x as i64));
            token_type_ids.extend(enc.get_type_ids().iter().map(|&x| x as i64));
        }

        // ORT's `TensorRef::from_array_view` accepts a `(shape, &[T])` tuple,
        // which keeps us free of ndarray at the boundary and sidesteps the
        // version-mismatch trait-impl issue we'd hit with Array2 views.
        let shape = [batch, seq_len];
        let outputs = self.session.run(inputs![
            "input_ids" => TensorRef::from_array_view((shape, input_ids.as_slice()))?,
            "attention_mask" => TensorRef::from_array_view((shape, attention_mask.as_slice()))?,
            "token_type_ids" => TensorRef::from_array_view((shape, token_type_ids.as_slice()))?,
        ])?;

        let hidden = outputs
            .get("last_hidden_state")
            .ok_or(Error::BadModelOutput)?;
        let (shape, data) = hidden.try_extract_tensor::<f32>()?;
        if shape.len() != 3 {
            return Err(Error::Shape(format!(
                "expected [batch, seq, dims], got {shape:?}"
            )));
        }
        let out_batch = shape[0] as usize;
        let out_seq = shape[1] as usize;
        let out_dims = shape[2] as usize;
        if out_batch != batch || out_seq != seq_len {
            return Err(Error::Shape(format!(
                "batch/seq mismatch: input ({batch}, {seq_len}) vs output ({out_batch}, {out_seq})"
            )));
        }
        if out_dims != self.dims {
            return Err(Error::Shape(format!(
                "expected {} dims, model returned {}",
                self.dims, out_dims
            )));
        }

        Ok(mean_pool_normalize(
            data,
            &attention_mask,
            batch,
            seq_len,
            out_dims,
        ))
    }
}

/// Mean-pool the `last_hidden_state` tensor weighted by `attention_mask`,
/// then L2-normalize each row.
///
/// `data` has shape `[batch, seq, dims]` (flattened row-major).
/// `mask` is the flattened `[batch, seq]` int64 attention mask.
fn mean_pool_normalize(
    data: &[f32],
    mask: &[i64],
    batch: usize,
    seq: usize,
    dims: usize,
) -> Vec<Vec<f32>> {
    let mut out = Vec::with_capacity(batch);
    for b in 0..batch {
        let mut pooled = vec![0f32; dims];
        let mut mask_sum = 0f32;
        for s in 0..seq {
            let m = mask[b * seq + s] as f32;
            if m < 0.5 {
                continue;
            }
            let offset = (b * seq + s) * dims;
            for d in 0..dims {
                pooled[d] += data[offset + d] * m;
            }
            mask_sum += m;
        }
        if mask_sum > 0.0 {
            for v in &mut pooled {
                *v /= mask_sum;
            }
        }
        let norm: f32 = pooled.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for v in &mut pooled {
                *v /= norm;
            }
        }
        out.push(pooled);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mean_pool_respects_mask() {
        // 1 batch, 3 seq, 2 dims. Last token is padding.
        let data = vec![
            1.0, 0.0, // t0
            0.0, 1.0, // t1
            5.0, 5.0, // padding — should be ignored
        ];
        let mask = vec![1i64, 1, 0];
        let out = mean_pool_normalize(&data, &mask, 1, 3, 2);
        // Pre-norm pooled = (0.5, 0.5). L2 norm = sqrt(0.5) → each component /sqrt(0.5) ≈ 0.7071.
        let expected = (0.5f32 / 0.5f32.sqrt()).abs();
        assert!((out[0][0] - expected).abs() < 1e-5, "got {:?}", out);
        assert!((out[0][1] - expected).abs() < 1e-5, "got {:?}", out);
    }

    #[test]
    fn mean_pool_all_masked_stays_zero() {
        let data = vec![1.0, 2.0, 3.0, 4.0];
        let mask = vec![0i64, 0];
        let out = mean_pool_normalize(&data, &mask, 1, 2, 2);
        assert_eq!(out[0], vec![0.0, 0.0]);
    }
}
