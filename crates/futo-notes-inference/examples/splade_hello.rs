//! Smoke binary for the SPLADE doc encoder. Loads the OS-v3-doc-distill
//! model + tokenizer from paths in env vars, encodes a doc and a query, and
//! prints the top sparse dimensions for eyeball validation.
//!
//! Usage:
//!
//! ```text
//! SPLADE_TOKENIZER_PATH=path/to/tokenizer.json \
//! SPLADE_MODEL_PATH=path/to/model.onnx \
//! cargo run --example splade_hello --release
//! ```

use std::path::PathBuf;
use std::time::Instant;

use futo_notes_inference::{tokenize_only_query, SpladeDocEncoder};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let tokenizer_path = PathBuf::from(
        std::env::var("SPLADE_TOKENIZER_PATH").expect("set SPLADE_TOKENIZER_PATH"),
    );
    let model_path =
        PathBuf::from(std::env::var("SPLADE_MODEL_PATH").expect("set SPLADE_MODEL_PATH"));

    let load_start = Instant::now();
    let mut encoder = SpladeDocEncoder::load(&model_path, &tokenizer_path)?;
    println!("encoder loaded in {} ms", load_start.elapsed().as_millis());

    let doc = "Barton Hills apartment hunt 2025 — looking for places walkable to Zilker.";
    let encode_start = Instant::now();
    let doc_vec = encoder.encode_document(doc)?;
    let doc_ms = encode_start.elapsed().as_millis();
    println!(
        "doc encoded in {} ms — nnz={}, top 5 by weight:",
        doc_ms,
        doc_vec.nnz()
    );
    let mut ranked: Vec<(u32, f32)> = doc_vec
        .indices
        .iter()
        .zip(doc_vec.values.iter())
        .map(|(&i, &v)| (i, v))
        .collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    for (i, v) in ranked.iter().take(5) {
        println!("  vocab[{i:5}] = {v:.4}");
    }

    let query = "zilker apartments";
    let q_start = Instant::now();
    let q_vec = tokenize_only_query(encoder.tokenizer(), query)?;
    let q_us = q_start.elapsed().as_micros();
    println!(
        "\nquery `{}` tokenized in {} µs — nnz={} (inference-free, no model)",
        query,
        q_us,
        q_vec.nnz()
    );
    for i in q_vec.indices.iter().take(8) {
        println!("  vocab[{i}]");
    }

    Ok(())
}
