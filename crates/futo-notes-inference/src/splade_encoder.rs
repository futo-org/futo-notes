//! Concrete [`SpladeDocEncoder`] over an ONNX Runtime session.
//!
//! Encodes text into sparse vectors in 30,522-d WordPiece-vocab space (BERT /
//! DistilBERT vocab). Matches the inference-free deployment pattern: only docs
//! are run through the neural model at index time; queries are tokenized via
//! the WordPiece tokenizer alone (no model forward pass) — see
//! [`tokenize_query`].
//!
//! The default target weights are
//! `opensearch-project/opensearch-neural-sparse-encoding-doc-v3-distill`,
//! activation `log(1 + log(1 + relu(logits)))` max-pooled over the masked
//! sequence dimension.
//!
//! The reference implementation that validated the model choice and scoring
//! lives in `scripts/splade-eval/eval.py`. Encoded vectors here should match
//! its output to within rounding for matching inputs.

use std::path::Path;

use ort::{
    inputs,
    session::{builder::GraphOptimizationLevel, Session},
    value::TensorRef,
};
use serde::{Deserialize, Serialize};
use tokenizers::{
    PaddingParams, Tokenizer, TruncationDirection, TruncationParams, TruncationStrategy,
};

use crate::error::{Error, Result};

/// DistilBERT max position. Beyond this the model has no position embeddings.
pub const SPLADE_MAX_SEQ_LEN: usize = 512;

/// BERT/DistilBERT WordPiece vocab size. The model outputs logits over this
/// many vocab terms, so the sparse vector lives in this space.
pub const SPLADE_VOCAB_SIZE: usize = 30522;

/// Hard cap on sequences fed to a single ORT `run()` on the dynamic-shape
/// path. The MLM head's logits tensor is `N * seq_len * SPLADE_VOCAB_SIZE * 4`
/// bytes — at seq=512 that's ~62 MB *per sequence*. A caller that flattens all
/// chunks of a very large note (e.g. a 3 MB note → thousands of chunks) into
/// one `encode_batch` would otherwise ask ORT for a single multi-hundred-GB
/// allocation and OOM-crash the session. We sub-batch to keep peak memory
/// bounded (~32 × 512 × 30522 × 4 ≈ 2 GB worst case, far less for typical short
/// chunks). The fixed-shape (CoreML/ANE) path is already one-at-a-time.
const MAX_SEQS_PER_RUN: usize = 32;

/// A sparse vector in [`SPLADE_VOCAB_SIZE`]-d vocab space. Indices are sorted
/// ascending so we can score against the index by linear merge.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SpladeSparseVec {
    pub indices: Vec<u32>,
    pub values: Vec<f32>,
}

impl SpladeSparseVec {
    pub fn nnz(&self) -> usize {
        self.indices.len()
    }

    pub fn is_empty(&self) -> bool {
        self.indices.is_empty()
    }
}

/// Loaded SPLADE document encoder. Owns the ORT session and tokenizer; one
/// instance per process. Cheap to call repeatedly; expensive to construct
/// because of model load.
pub struct SpladeDocEncoder {
    session: Session,
    tokenizer: Tokenizer,
}

impl SpladeDocEncoder {
    /// Load an ONNX SPLADE doc encoder and its tokenizer.
    pub fn load(model_path: &Path, tokenizer_path: &Path) -> Result<Self> {
        // ORT intra-op thread pool. When CoreML EP is actually active
        // (feature compiled AND FUTO_COREML_ON set), most matmuls run on
        // GPU/ANE so 4 threads of glue is plenty. CPU-only path wants
        // closer to physical core count; cap at 8 to leave headroom for
        // the rest of the system while backfill runs.
        // Override with `FUTO_SPLADE_THREADS=N`.
        let env_threads = std::env::var("FUTO_SPLADE_THREADS")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|n| *n > 0);
        let coreml_active =
            cfg!(feature = "coreml") && std::env::var("FUTO_COREML_ON").is_ok();
        let default_cap = if coreml_active { 4 } else { 8 };
        let threads = env_threads.unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get().min(default_cap))
                .unwrap_or(2)
        });
        Self::load_with_threads(model_path, tokenizer_path, threads)
    }

    /// Same as [`Self::load`] but with an explicit intra-op thread count.
    /// Used by the bench example to sweep thread counts without rebuilding.
    pub fn load_with_threads(
        model_path: &Path,
        tokenizer_path: &Path,
        intra_threads: usize,
    ) -> Result<Self> {
        let mut tokenizer =
            Tokenizer::from_file(tokenizer_path).map_err(|e| Error::Tokenizer(e.to_string()))?;
        // FUTO_SPLADE_FIXED_SEQ=1 pads every input to seq=512 always. Use this
        // with the static-shape ONNX exports that CoreML's ANE / MPS compiler
        // requires (dynamic seq breaks shape inference on those backends).
        let pad_params = if let Ok(s) = std::env::var("FUTO_SPLADE_FIXED_SEQ") {
            use tokenizers::utils::padding::{PaddingDirection, PaddingStrategy};
            let len: usize = s.parse().unwrap_or(SPLADE_MAX_SEQ_LEN);
            PaddingParams {
                strategy: PaddingStrategy::Fixed(len),
                direction: PaddingDirection::Right,
                pad_to_multiple_of: None,
                pad_id: 0,
                pad_type_id: 0,
                pad_token: "[PAD]".to_string(),
            }
        } else {
            PaddingParams::default()
        };
        let trunc_len = std::env::var("FUTO_SPLADE_FIXED_SEQ")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(SPLADE_MAX_SEQ_LEN);
        tokenizer.with_padding(Some(pad_params));
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: trunc_len,
                strategy: TruncationStrategy::LongestFirst,
                stride: 0,
                direction: TruncationDirection::Right,
            }))
            .map_err(|e| Error::Tokenizer(e.to_string()))?;

        let builder = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(intra_threads)?;

        // CoreML EP: routes DistilBERT matmuls to the Neural Engine / GPU on
        // Apple Silicon. Falls back to CPU per-op for anything the ANE can't
        // run. MLProgram format because the older NeuralNetwork format
        // rejects too many of the ops in the SPLADE MLM head.
        //
        // OPT-IN: the bundled INT8-quantized SPLADE model doesn't fully run
        // through CoreML (some quantized ops are unsupported), so encode
        // calls error out at runtime. iOS uses a CoreML-compatible model
        // variant (fp16 with op blocklist) and sets FUTO_COREML_ON=1 + the
        // matching FUTO_SPLADE_FIXED_SEQ flag. Default off until a desktop
        // variant of the CoreML model is shipped.
        #[cfg(feature = "coreml")]
        let builder = if std::env::var("FUTO_COREML_ON").is_err() {
            builder
        } else {
            use ort::ep::{coreml::{ComputeUnits, ModelFormat}, CoreML};
            // FUTO_COREML_UNITS supports comma-separated values (e.g. "ane,gpu,cpu")
            // — each encoder in the pool picks the i-th entry by index, set via
            // FUTO_COREML_UNITS_IDX. This lets the bench run different units per
            // session so independent compute resources (ANE / GPU / CPU) all work
            // in parallel instead of contending for one accelerator.
            // Default to ANE: on our SPLADE fp16 graph (patched with Cast nodes at
            // fp16/fp32 boundaries — see `scripts/patch-fp16-casts.py`) the Apple
            // Neural Engine is ~3x faster than the GPU EP. Override with
            // FUTO_COREML_UNITS=gpu / cpu / all if needed.
            let units_csv = std::env::var("FUTO_COREML_UNITS").unwrap_or_else(|_| "ane".to_string());
            let idx: usize = std::env::var("FUTO_COREML_UNITS_IDX")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let units_list: Vec<&str> = units_csv.split(',').collect();
            let pick = units_list[idx % units_list.len()];
            let units = match pick {
                "all" => ComputeUnits::All,
                "ane" => ComputeUnits::CPUAndNeuralEngine,
                "gpu" => ComputeUnits::CPUAndGPU,
                "cpu" => ComputeUnits::CPUOnly,
                _ => ComputeUnits::CPUAndGPU,
            };
            eprintln!("[splade] encoder slot {idx} → CoreML units {pick}");
            let format = match std::env::var("FUTO_COREML_FORMAT").as_deref() {
                Ok("nn") => ModelFormat::NeuralNetwork,
                _ => ModelFormat::MLProgram,
            };
            let static_shapes = std::env::var("FUTO_COREML_STATIC").is_ok();
            builder.with_execution_providers([
                CoreML::default()
                    .with_compute_units(units)
                    .with_model_format(format)
                    .with_static_input_shapes(static_shapes)
                    .build(),
            ])?
        };

        let mut builder = builder;
        let session = builder.commit_from_file(model_path)?;

        Ok(Self { session, tokenizer })
    }

    /// Encode a single document chunk into a sparse vocab vector.
    pub fn encode_document(&mut self, text: &str) -> Result<SpladeSparseVec> {
        let mut out = self.encode_batch(&[text])?;
        Ok(out.pop().expect("encode_batch returned empty for non-empty input"))
    }

    /// Encode a batch of document chunks. Amortizes ORT session overhead.
    pub fn encode_batch(&mut self, texts: &[&str]) -> Result<Vec<SpladeSparseVec>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        // When loaded against a [1, 512] static model (CoreML ANE), loop the
        // texts one-at-a-time. Multi-sample batches violate the static batch
        // dim and ORT rejects them at run().
        if std::env::var("FUTO_SPLADE_BATCH1").is_ok() {
            let mut out = Vec::with_capacity(texts.len());
            for t in texts {
                out.extend(self.encode_one_batch1(t)?);
            }
            return Ok(out);
        }

        // FUTO_SPLADE_FIXED_BATCH=N pads each call to exactly N inputs (static
        // batch model). Last partial chunk is padded with "" placeholders;
        // pad outputs are discarded.
        if let Ok(fixed_n) = std::env::var("FUTO_SPLADE_FIXED_BATCH").and_then(|s| s.parse::<usize>().map_err(|_| std::env::VarError::NotPresent)) {
            let mut out = Vec::with_capacity(texts.len());
            for window in texts.chunks(fixed_n) {
                let real = window.len();
                let mut buf: Vec<&str> = window.to_vec();
                while buf.len() < fixed_n {
                    buf.push("[PAD]");
                }
                let r = self.encode_dynamic_batch(&buf)?;
                out.extend(r.into_iter().take(real));
            }
            return Ok(out);
        }

        // Default dynamic path: sub-batch by sequence count so one caller can't
        // trigger an unbounded ORT allocation (see `MAX_SEQS_PER_RUN`). For the
        // common case (a handful of chunks) this is a single run; only large
        // notes split across multiple runs.
        if texts.len() > MAX_SEQS_PER_RUN {
            let mut out = Vec::with_capacity(texts.len());
            for window in texts.chunks(MAX_SEQS_PER_RUN) {
                out.extend(self.encode_dynamic_batch(window)?);
            }
            return Ok(out);
        }
        self.encode_dynamic_batch(texts)
    }

    fn encode_dynamic_batch(&mut self, texts: &[&str]) -> Result<Vec<SpladeSparseVec>> {

        let t_tok_start = std::time::Instant::now();
        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| Error::Tokenizer(e.to_string()))?;

        let batch = encodings.len();
        let seq_len = encodings[0].get_ids().len();

        let mut input_ids = Vec::with_capacity(batch * seq_len);
        let mut attention_mask = Vec::with_capacity(batch * seq_len);
        for enc in &encodings {
            input_ids.extend(enc.get_ids().iter().map(|&x| x as i64));
            attention_mask.extend(enc.get_attention_mask().iter().map(|&x| x as i64));
        }
        let tok_ms = t_tok_start.elapsed().as_millis();

        let t_ort_start = std::time::Instant::now();
        let shape = [batch, seq_len];
        let outputs = self.session.run(inputs![
            "input_ids" => TensorRef::from_array_view((shape, input_ids.as_slice()))?,
            "attention_mask" => TensorRef::from_array_view((shape, attention_mask.as_slice()))?,
        ])?;
        let ort_ms = t_ort_start.elapsed().as_millis();

        let t_pool_start = std::time::Instant::now();
        // Pooling-fused models (see `scripts/fuse-splade-pool.py`) emit a dense
        // `pooled` output of shape [batch, vocab] — the masked max-pool +
        // activation already applied in-graph. Older un-fused exports emit raw
        // `logits` [batch, seq, vocab] and we pool here on the CPU.
        let pooled = if let Some(pooled_out) = outputs.get("pooled") {
            let (out_shape, data) = pooled_out.try_extract_tensor::<f32>()?;
            if out_shape.len() != 2 {
                return Err(Error::Shape(format!(
                    "expected [batch, vocab] pooled, got {out_shape:?}"
                )));
            }
            let out_batch = out_shape[0] as usize;
            let vocab = out_shape[1] as usize;
            if out_batch != batch {
                return Err(Error::Shape(format!(
                    "batch mismatch: input {batch} vs pooled output {out_batch}"
                )));
            }
            if vocab != SPLADE_VOCAB_SIZE {
                return Err(Error::Shape(format!(
                    "expected vocab {SPLADE_VOCAB_SIZE}, model returned {vocab}"
                )));
            }
            sparse_from_pooled(data, batch, vocab)
        } else {
            // SPLADE-family ONNX exports name the MLM logits output `logits`.
            let logits = outputs.get("logits").ok_or(Error::BadModelOutput)?;
            let (out_shape, data) = logits.try_extract_tensor::<f32>()?;
            if out_shape.len() != 3 {
                return Err(Error::Shape(format!(
                    "expected [batch, seq, vocab] logits, got {out_shape:?}"
                )));
            }
            let out_batch = out_shape[0] as usize;
            let out_seq = out_shape[1] as usize;
            let vocab = out_shape[2] as usize;
            if out_batch != batch || out_seq != seq_len {
                return Err(Error::Shape(format!(
                    "batch/seq mismatch: input ({batch}, {seq_len}) vs output ({out_batch}, {out_seq})"
                )));
            }
            if vocab != SPLADE_VOCAB_SIZE {
                return Err(Error::Shape(format!(
                    "expected vocab {SPLADE_VOCAB_SIZE}, model returned {vocab}"
                )));
            }
            splade_pool(data, &attention_mask, batch, seq_len, vocab)
        };
        let pool_ms = t_pool_start.elapsed().as_millis();
        if std::env::var("FUTO_SPLADE_TIMING").is_ok() {
            eprintln!("[splade timing] batch={batch} seq={seq_len} tok_ms={tok_ms} ort_ms={ort_ms} pool_ms={pool_ms}");
        }
        Ok(pooled)
    }

    fn encode_one_batch1(&mut self, text: &str) -> Result<Vec<SpladeSparseVec>> {
        let enc = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| Error::Tokenizer(e.to_string()))?;
        let seq_len = enc.get_ids().len();
        let input_ids: Vec<i64> = enc.get_ids().iter().map(|&x| x as i64).collect();
        let attention_mask: Vec<i64> = enc.get_attention_mask().iter().map(|&x| x as i64).collect();
        let shape = [1usize, seq_len];
        let t_ort_start = std::time::Instant::now();
        let outputs = self.session.run(inputs![
            "input_ids" => TensorRef::from_array_view((shape, input_ids.as_slice()))?,
            "attention_mask" => TensorRef::from_array_view((shape, attention_mask.as_slice()))?,
        ])?;
        let ort_ms = t_ort_start.elapsed().as_millis();
        let pooled = if let Some(pooled_out) = outputs.get("pooled") {
            let (out_shape, data) = pooled_out.try_extract_tensor::<f32>()?;
            let vocab = out_shape[1] as usize;
            sparse_from_pooled(data, 1, vocab)
        } else {
            let logits = outputs.get("logits").ok_or(Error::BadModelOutput)?;
            let (out_shape, data) = logits.try_extract_tensor::<f32>()?;
            let vocab = out_shape[2] as usize;
            splade_pool(data, &attention_mask, 1, seq_len, vocab)
        };
        if std::env::var("FUTO_SPLADE_TIMING").is_ok() {
            eprintln!("[splade timing] batch1 seq={seq_len} ort_ms={ort_ms}");
        }
        Ok(pooled)
    }

    /// Tokenize-only query encoder (the inference-free retrieval path).
    /// Returns the unique WordPiece vocab IDs of the query, each weighted 1.0.
    /// No model forward pass.
    pub fn tokenize_query(&self, query: &str) -> Result<SpladeSparseVec> {
        tokenize_only_query(&self.tokenizer, query)
    }

    /// Expose the tokenizer for callers that want to tokenize without owning the encoder.
    pub fn tokenizer(&self) -> &Tokenizer {
        &self.tokenizer
    }
}

/// Stand-alone query tokenizer. Same output shape as
/// [`SpladeDocEncoder::tokenize_query`]; takes only a [`Tokenizer`] so callers
/// can do query encoding without holding the (large) ORT session.
///
/// Filters out BERT special tokens ([CLS]/[SEP]/[PAD]) and the unknown token,
/// dedupes IDs, and returns them sorted with weight 1.0.
pub fn tokenize_only_query(tokenizer: &Tokenizer, query: &str) -> Result<SpladeSparseVec> {
    let enc = tokenizer
        .encode(query, false) // add_special_tokens=false: we want bare WordPiece IDs
        .map_err(|e| Error::Tokenizer(e.to_string()))?;
    let mut ids: Vec<u32> = enc.get_ids().to_vec();
    ids.sort_unstable();
    ids.dedup();
    let values = vec![1.0f32; ids.len()];
    Ok(SpladeSparseVec {
        indices: ids,
        values,
    })
}

/// Extract per-row sparse vectors from a dense `[batch, vocab]` pooled tensor,
/// as produced by a pooling-fused model (`scripts/fuse-splade-pool.py`) whose
/// graph already applied `log(1 + log(1 + relu(x)))` + masked max-pool. Keeps
/// strictly-positive entries with indices ascending — identical output contract
/// to [`splade_pool`], minus the CPU pooling work.
fn sparse_from_pooled(data: &[f32], batch: usize, vocab: usize) -> Vec<SpladeSparseVec> {
    let mut out = Vec::with_capacity(batch);
    for b in 0..batch {
        let row = &data[b * vocab..(b + 1) * vocab];
        let mut indices = Vec::new();
        let mut values = Vec::new();
        for (i, &v) in row.iter().enumerate() {
            if v > 0.0 {
                indices.push(i as u32);
                values.push(v);
            }
        }
        out.push(SpladeSparseVec { indices, values });
    }
    out
}

/// Apply SPLADE-v3-distill's activation `log(1 + log(1 + relu(x)))` to MLM
/// logits, then max-pool over the sequence dimension respecting the attention
/// mask. Returns one sparse vector per batch row.
///
/// `data` is row-major flattened `[batch, seq, vocab]`.
/// `mask` is the flattened `[batch, seq]` int64 attention mask.
fn splade_pool(
    data: &[f32],
    mask: &[i64],
    batch: usize,
    seq: usize,
    vocab: usize,
) -> Vec<SpladeSparseVec> {
    // The SPLADE activation `log(1 + log(1 + relu(x)))` is monotonically
    // increasing on x>0, so max(activation) == activation(max). Hoist the
    // expensive log1p calls out of the hot loop: max-pool first (just relu +
    // compare, vectorisable), then apply log1p(log1p(...)) once per surviving
    // nonzero. Drops ~3M log1p calls per batch1×seq=256 down to a few hundred.
    let mut out = Vec::with_capacity(batch);
    let mut pooled = vec![0f32; vocab];
    for b in 0..batch {
        pooled.iter_mut().for_each(|v| *v = 0.0);
        for s in 0..seq {
            if mask[b * seq + s] == 0 {
                continue;
            }
            let offset = (b * seq + s) * vocab;
            let row = &data[offset..offset + vocab];
            for (slot, &x) in pooled.iter_mut().zip(row.iter()) {
                if x > *slot {
                    *slot = x;
                }
            }
        }
        let mut indices = Vec::new();
        let mut values = Vec::new();
        for (i, &v) in pooled.iter().enumerate() {
            if v > 0.0 {
                indices.push(i as u32);
                values.push((1.0 + (1.0 + v).ln()).ln());
            }
        }
        out.push(SpladeSparseVec { indices, values });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splade_pool_max_over_seq() {
        // batch=1, seq=2, vocab=3. Two unmasked tokens, max-pool selects per-vocab max.
        // Token 0 logits: [1.0, 0.0, -1.0]
        // Token 1 logits: [0.5, 2.0,  3.0]
        // After activation log(1+log(1+x)) (only for x>0):
        //   Token 0: [log(1+log(2)), 0, 0]
        //   Token 1: [log(1+log(1.5)), log(1+log(3)), log(1+log(4))]
        // Max-pool: pick max per vocab dim
        let data = vec![1.0, 0.0, -1.0, 0.5, 2.0, 3.0];
        let mask = vec![1i64, 1];
        let out = splade_pool(&data, &mask, 1, 2, 3);
        assert_eq!(out.len(), 1);
        // All three vocab dims should be nonzero (vocab 2 has +3 logit → log(1+log(4)) ≈ 0.81)
        assert_eq!(out[0].nnz(), 3);
        // Indices sorted
        assert_eq!(out[0].indices, vec![0, 1, 2]);
        // Verify max selection: vocab 0 → max(log(1+log(2)), log(1+log(1.5))) = log(1+log(2))
        let expected_v0 = (1.0_f32 + 2.0_f32.ln()).ln();
        assert!((out[0].values[0] - expected_v0).abs() < 1e-5, "got {:?}", out);
    }

    #[test]
    fn splade_pool_ignores_padding() {
        // batch=1, seq=2, vocab=2. Padding mask zero on token 1: its logits must not appear.
        let data = vec![
            0.5, 0.0, // token 0
            0.0, 99.0, // token 1 — should be ignored
        ];
        let mask = vec![1i64, 0];
        let out = splade_pool(&data, &mask, 1, 2, 2);
        // Only vocab 0 is nonzero; vocab 1 was only seen in the masked-out token.
        assert_eq!(out[0].nnz(), 1);
        assert_eq!(out[0].indices, vec![0]);
    }

    #[test]
    fn sparse_from_pooled_keeps_positive_ascending() {
        // batch=2, vocab=3. Mirrors the tail of splade_pool: keep v>0, indices
        // ascending, values passed through verbatim (already activated in-graph).
        // Row 0: [0.0, 1.5, 0.0] → idx [1]. Row 1: [2.0, 0.0, 0.5] → idx [0, 2].
        let data = vec![0.0, 1.5, 0.0, 2.0, 0.0, 0.5];
        let out = sparse_from_pooled(&data, 2, 3);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].indices, vec![1]);
        assert_eq!(out[0].values, vec![1.5]);
        assert_eq!(out[1].indices, vec![0, 2]);
        assert_eq!(out[1].values, vec![2.0, 0.5]);
    }

    #[test]
    fn splade_pool_all_negative_yields_empty() {
        // All logits ≤ 0 → ReLU zeros them → empty sparse vec.
        let data = vec![-1.0, -2.0, -3.0, -4.0];
        let mask = vec![1i64, 1];
        let out = splade_pool(&data, &mask, 1, 2, 2);
        assert_eq!(out[0].nnz(), 0);
    }
}
