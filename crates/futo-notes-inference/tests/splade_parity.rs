//! Parity tests for the SPLADE encoder.
//!
//! These integration tests are env-gated because they need the
//! `opensearch-project/opensearch-neural-sparse-encoding-doc-v3-distill`
//! tokenizer and (for the doc-side test) ONNX model file. Phase 2's
//! `scripts/fetch-splade-model.mjs` lays those down at known locations.
//!
//! Run locally:
//!
//! ```text
//! SPLADE_TOKENIZER_PATH=apps/tauri/src-tauri/gen/linux/splade-tokenizer.json \
//! SPLADE_MODEL_PATH=apps/tauri/src-tauri/gen/linux/splade-model.onnx \
//! cargo test -p futo-notes-inference --test splade_parity -- --nocapture
//! ```
//!
//! Without the env vars set, every test in this file no-ops with a printed
//! skip message.

use std::path::PathBuf;

use futo_notes_inference::{tokenize_only_query, SpladeDocEncoder};
use tokenizers::Tokenizer;

fn skip(name: &str, why: &str) {
    eprintln!("[skip {name}] {why}");
}

fn tokenizer_path() -> Option<PathBuf> {
    std::env::var("SPLADE_TOKENIZER_PATH").ok().map(PathBuf::from)
}

fn model_path() -> Option<PathBuf> {
    std::env::var("SPLADE_MODEL_PATH").ok().map(PathBuf::from)
}

#[test]
fn tokenize_only_query_sorted_and_unique() {
    let tok_path = match tokenizer_path() {
        Some(p) if p.exists() => p,
        _ => {
            skip(
                "tokenize_only_query_sorted_and_unique",
                "set SPLADE_TOKENIZER_PATH to the bundled tokenizer.json to run this",
            );
            return;
        }
    };
    let tok = Tokenizer::from_file(&tok_path).expect("load tokenizer");

    // Duplicate words should dedupe; output indices must be ascending.
    let v = tokenize_only_query(&tok, "search search search query").expect("tokenize");
    assert!(!v.indices.is_empty(), "expected nonempty for `search query`");
    for w in v.indices.windows(2) {
        assert!(w[0] < w[1], "indices not strictly ascending: {:?}", v.indices);
    }
    assert!(
        v.values.iter().all(|&x| (x - 1.0).abs() < 1e-6),
        "inference-free values must all be 1.0, got {:?}",
        v.values
    );
}

#[test]
fn tokenize_only_query_empty_input() {
    let tok_path = match tokenizer_path() {
        Some(p) if p.exists() => p,
        _ => {
            skip(
                "tokenize_only_query_empty_input",
                "set SPLADE_TOKENIZER_PATH to run this",
            );
            return;
        }
    };
    let tok = Tokenizer::from_file(&tok_path).expect("load tokenizer");
    let v = tokenize_only_query(&tok, "").expect("tokenize empty");
    assert!(v.is_empty(), "empty query should produce empty sparse vec");
}

#[test]
fn doc_encode_smoke() {
    let (tp, mp) = match (tokenizer_path(), model_path()) {
        (Some(t), Some(m)) if t.exists() && m.exists() => (t, m),
        _ => {
            skip(
                "doc_encode_smoke",
                "set SPLADE_TOKENIZER_PATH and SPLADE_MODEL_PATH to the bundled files to run this",
            );
            return;
        }
    };

    let mut enc = SpladeDocEncoder::load(&mp, &tp).expect("load encoder");
    let out = enc
        .encode_document("Barton Hills apartment hunt notes")
        .expect("encode");

    // SPLADE-v3 doc-distill typically produces ~150-300 nonzeros per chunk on
    // typical English prose. A sane sanity range.
    assert!(out.nnz() >= 20, "expected at least 20 nonzeros, got {}", out.nnz());
    assert!(
        out.nnz() <= 1000,
        "more than 1000 nonzeros looks unreasonable, got {}",
        out.nnz()
    );

    // Indices must be ascending and within vocab.
    for w in out.indices.windows(2) {
        assert!(w[0] < w[1], "doc indices not ascending");
    }
    assert!(
        out.indices.iter().all(|&i| (i as usize) < 30522),
        "doc index out of vocab range"
    );
    // Values are positive after ReLU + log + log activation.
    assert!(
        out.values.iter().all(|&v| v > 0.0),
        "doc encoder produced non-positive values"
    );
}

/// Regression: a single very large note chunks into thousands of sequences. The
/// indexer flattens all chunks of a note-batch into one `encode_batch`, which
/// used to feed them all to one ORT `run()` — the `[N, seq, vocab]` logits
/// tensor then demanded hundreds of GB and OOM-crashed the session (hit in real
/// use by a 3 MB note). `encode_batch` now sub-batches the dynamic path; here we
/// hand it more sequences than the per-run cap and assert it returns one vector
/// per input without crashing.
#[test]
fn doc_encode_large_batch_subbatches() {
    let (tp, mp) = match (tokenizer_path(), model_path()) {
        (Some(t), Some(m)) if t.exists() && m.exists() => (t, m),
        _ => {
            skip(
                "doc_encode_large_batch_subbatches",
                "set SPLADE_TOKENIZER_PATH and SPLADE_MODEL_PATH to run this",
            );
            return;
        }
    };

    let mut enc = SpladeDocEncoder::load(&mp, &tp).expect("load encoder");
    // 200 sequences — well above the internal MAX_SEQS_PER_RUN cap (32) — so the
    // dynamic path must split across several ORT runs and concatenate.
    let owned: Vec<String> = (0..200)
        .map(|i| format!("chunk number {i} about war, peace, and quiet reflection"))
        .collect();
    let refs: Vec<&str> = owned.iter().map(|s| s.as_str()).collect();
    let out = enc.encode_batch(&refs).expect("large batch encodes");
    assert_eq!(out.len(), refs.len(), "one sparse vec per input chunk");
    assert!(out.iter().all(|v| v.nnz() > 0), "every chunk should activate some terms");
}

/// Equivalence: a pooling-fused model (output `pooled [batch, vocab]`, produced
/// by `scripts/fuse-splade-pool.py`) must yield the same sparse vectors as the
/// original un-fused `logits` model pooled in Rust. This is the parity gate for
/// moving the activation + masked max-pool into the ONNX graph. Gated on
/// `SPLADE_POOLED_MODEL_PATH` (set it to a fused model; reuses the same
/// tokenizer as the base model).
#[test]
fn fused_model_matches_unfused() {
    let (tp, mp) = match (tokenizer_path(), model_path()) {
        (Some(t), Some(m)) if t.exists() && m.exists() => (t, m),
        _ => {
            skip(
                "fused_model_matches_unfused",
                "set SPLADE_TOKENIZER_PATH and SPLADE_MODEL_PATH to run this",
            );
            return;
        }
    };
    let fused = match std::env::var("SPLADE_POOLED_MODEL_PATH").ok().map(PathBuf::from) {
        Some(p) if p.exists() => p,
        _ => {
            skip(
                "fused_model_matches_unfused",
                "set SPLADE_POOLED_MODEL_PATH to a pooling-fused model to run this",
            );
            return;
        }
    };

    let mut base = SpladeDocEncoder::load(&mp, &tp).expect("load base (un-fused) encoder");
    let mut pooled = SpladeDocEncoder::load(&fused, &tp).expect("load fused encoder");

    // Same arithmetic in both paths (fp32 relu/max/log), so these should agree
    // to fp32 rounding. Allow a small relative tolerance for op-order slack.
    let tol = |x: f32, y: f32| (x - y).abs() <= 1e-4 * x.abs().max(1.0);

    // Single encodes: no padding (mask all-ones).
    for t in [
        "Barton Hills apartment hunt notes",
        "audio streaming subscription service like Spotify or Pandora",
        "overcoming self-criticism and perfectionism in daily work",
        "",
    ] {
        let a = base.encode_document(t).expect("base encode");
        let b = pooled.encode_document(t).expect("fused encode");
        assert_eq!(a.indices, b.indices, "indices differ for {t:?}");
        assert_eq!(a.values.len(), b.values.len(), "nnz differs for {t:?}");
        for (i, (x, y)) in a.values.iter().zip(b.values.iter()).enumerate() {
            assert!(tol(*x, *y), "value {i} differs for {t:?}: base={x} fused={y}");
        }
    }

    // Batched encode of unequal-length inputs exercises padding + the masked
    // max-pool in the graph against the Rust mask-skipping loop.
    let refs = vec![
        "short note",
        "a considerably longer note about audio streaming, music subscriptions, and internet radio services",
    ];
    let ba = base.encode_batch(&refs).expect("base batch");
    let bb = pooled.encode_batch(&refs).expect("fused batch");
    assert_eq!(ba.len(), bb.len());
    for (j, (va, vb)) in ba.iter().zip(bb.iter()).enumerate() {
        assert_eq!(va.indices, vb.indices, "batch row {j} indices differ");
        assert_eq!(va.values.len(), vb.values.len(), "batch row {j} nnz differs");
        for (x, y) in va.values.iter().zip(vb.values.iter()) {
            assert!(tol(*x, *y), "batch row {j} value differs: base={x} fused={y}");
        }
    }
}
