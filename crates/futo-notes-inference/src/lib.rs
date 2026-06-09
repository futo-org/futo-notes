//! On-device sparse retrieval for FUTO Notes.
//!
//! This crate wraps an ONNX Runtime session and a HuggingFace tokenizer behind
//! the SPLADE doc encoder — the building block for client-side semantic search.
//! The abstraction stays deliberately thin: no trait between us and
//! `ort::Session` until a second concrete implementation actually lands.

mod error;
mod splade_encoder;

pub use error::{Error, Result};
pub use splade_encoder::{
    tokenize_only_query, SpladeDocEncoder, SpladeSparseVec, SPLADE_MAX_SEQ_LEN, SPLADE_VOCAB_SIZE,
};

// ---------------------------------------------------------------------------
// SPLADE — inference-free learned sparse retrieval (OpenSearch v3-distill)
// ---------------------------------------------------------------------------

/// Model identifier for the SPLADE doc encoder. Apache 2.0 license, ~67M
/// params (DistilBERT base), inference-free at query time.
pub const SPLADE_V3_DISTILL_MODEL_ID: &str = "opensearch-neural-sparse-encoding-doc-v3-distill";

/// Hugging Face URL for the ONNX export of the SPLADE doc encoder. The repo
/// ships safetensors by default; the `onnx/` subdirectory contains the
/// exported ONNX file.
pub const SPLADE_V3_DISTILL_MODEL_URL: &str =
    "https://huggingface.co/opensearch-project/opensearch-neural-sparse-encoding-doc-v3-distill/resolve/main/onnx/model.onnx";

/// Hugging Face URL for the matching WordPiece tokenizer.
pub const SPLADE_V3_DISTILL_TOKENIZER_URL: &str =
    "https://huggingface.co/opensearch-project/opensearch-neural-sparse-encoding-doc-v3-distill/resolve/main/tokenizer.json";
