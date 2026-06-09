//! Standalone bench for SPLADE document encoding. Mirrors the Tauri
//! migration path (walk a notes root, chunk with the same chunker, batch
//! into the encoder, time it) without paying the cost of an RPM rebuild
//! and app reinstall on every iteration.
//!
//! Output is JSON on stdout so it's easy to diff across runs.
//!
//! Usage:
//!
//! ```text
//! cargo run --release --example splade_bench -- \
//!     --notes /home/justin/Documents/futo-notes \
//!     --model apps/tauri/src-tauri/gen/linux/splade-model.onnx \
//!     --tokenizer apps/tauri/src-tauri/gen/linux/splade-tokenizer.json \
//!     --batch 16
//! ```
//!
//! Flags:
//!   --notes PATH        Notes root to walk (recursive, *.md).
//!   --model PATH        SPLADE ONNX file. Defaults to gen/linux/splade-model.onnx.
//!   --tokenizer PATH    SPLADE tokenizer.json. Defaults to gen/linux/splade-tokenizer.json.
//!   --batch N           Notes per encode_batch call (default 16).
//!   --target-tokens N   Chunker target token count (default 400 — matches Tauri).
//!   --limit N           Cap the number of notes processed (default: all).
//!   --warmup N          Pre-encode this many notes before timing (default 0).

use std::path::{Path, PathBuf};
use std::time::Instant;

use futo_notes_core::search::{build_embedding_text, chunk_content_with_target};
use futo_notes_inference::SpladeDocEncoder;
use walkdir::WalkDir;

#[derive(Default)]
struct Args {
    notes: Option<PathBuf>,
    model: Option<PathBuf>,
    tokenizer: Option<PathBuf>,
    batch: usize,
    target_tokens: usize,
    limit: Option<usize>,
    warmup: usize,
    sort_by_length: bool,
    intra_threads: Option<usize>,
    pool: usize,
}

fn parse_args() -> Args {
    let mut out = Args {
        batch: 16,
        target_tokens: 400,
        warmup: 0,
        sort_by_length: false,
        intra_threads: None,
        pool: 1,
        ..Default::default()
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--notes" => out.notes = Some(PathBuf::from(it.next().expect("--notes needs a value"))),
            "--model" => out.model = Some(PathBuf::from(it.next().expect("--model needs a value"))),
            "--tokenizer" => {
                out.tokenizer = Some(PathBuf::from(it.next().expect("--tokenizer needs a value")))
            }
            "--batch" => out.batch = it.next().expect("--batch needs a value").parse().unwrap(),
            "--target-tokens" => {
                out.target_tokens = it.next().expect("--target-tokens needs a value").parse().unwrap()
            }
            "--limit" => out.limit = Some(it.next().expect("--limit needs a value").parse().unwrap()),
            "--warmup" => out.warmup = it.next().expect("--warmup needs a value").parse().unwrap(),
            "--sort-by-length" => out.sort_by_length = true,
            "--intra-threads" => {
                out.intra_threads = Some(
                    it.next()
                        .expect("--intra-threads needs a value")
                        .parse()
                        .unwrap(),
                )
            }
            "--pool" => out.pool = it.next().expect("--pool needs a value").parse().unwrap(),
            other => panic!("unknown flag: {other}"),
        }
    }
    out
}

fn collect_notes(root: &Path, limit: Option<usize>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let rel = match p.strip_prefix(root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let note_id = rel.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
        let content = match std::fs::read_to_string(p) {
            Ok(s) => s,
            Err(_) => continue,
        };
        out.push((note_id, content));
        if let Some(n) = limit {
            if out.len() >= n {
                break;
            }
        }
    }
    out
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args();
    let notes_root = args.notes.expect("--notes is required");
    let model_path = args.model.unwrap_or_else(|| {
        PathBuf::from("apps/tauri/src-tauri/gen/linux/splade-model.onnx")
    });
    let tokenizer_path = args.tokenizer.unwrap_or_else(|| {
        PathBuf::from("apps/tauri/src-tauri/gen/linux/splade-tokenizer.json")
    });

    eprintln!("[bench] notes root: {}", notes_root.display());
    eprintln!("[bench] model:      {}", model_path.display());
    eprintln!("[bench] tokenizer:  {}", tokenizer_path.display());
    eprintln!("[bench] batch:      {}", args.batch);
    eprintln!("[bench] target_tokens: {}", args.target_tokens);
    eprintln!("[bench] sort_by_length: {}", args.sort_by_length);
    if let Some(t) = args.intra_threads {
        eprintln!("[bench] intra_threads override: {t}");
    }

    let load_start = Instant::now();
    let pool_size = args.pool.max(1);
    eprintln!("[bench] encoder pool size: {pool_size}");
    let encoders: Vec<std::sync::Mutex<SpladeDocEncoder>> = (0..pool_size)
        .map(|i| -> Result<_, Box<dyn std::error::Error>> {
            std::env::set_var("FUTO_COREML_UNITS_IDX", i.to_string());
            let enc = if let Some(t) = args.intra_threads {
                SpladeDocEncoder::load_with_threads(&model_path, &tokenizer_path, t)?
            } else {
                SpladeDocEncoder::load(&model_path, &tokenizer_path)?
            };
            Ok(std::sync::Mutex::new(enc))
        })
        .collect::<Result<_, _>>()?;
    let encoders = std::sync::Arc::new(encoders);
    let load_ms = load_start.elapsed().as_millis();
    eprintln!("[bench] {pool_size} encoder(s) loaded in {load_ms} ms");

    let walk_start = Instant::now();
    let notes = collect_notes(&notes_root, args.limit);
    let walk_ms = walk_start.elapsed().as_millis();
    eprintln!("[bench] walked {} notes in {walk_ms} ms", notes.len());

    // Pre-flatten all chunks once (independent of batching).
    // Each entry is (note_idx, chunk_text). We track note_idx purely for
    // sanity (production code groups results by note before upsert).
    let flatten_start = Instant::now();
    let mut all_chunks: Vec<(usize, String)> = Vec::new();
    for (idx, (note_id, content)) in notes.iter().enumerate() {
        for c in chunk_content_with_target(content, args.target_tokens) {
            all_chunks.push((idx, build_embedding_text(note_id, &c.text)));
        }
    }
    let flatten_ms = flatten_start.elapsed().as_millis();
    eprintln!(
        "[bench] flattened {} notes → {} chunks in {flatten_ms} ms",
        notes.len(),
        all_chunks.len()
    );

    if args.sort_by_length {
        // Sort ascending by character length as a cheap proxy for token count.
        // Doesn't need to be perfectly accurate — neighbours in the sorted
        // order will have similar token counts after WordPiece, which is what
        // matters for padding waste.
        let sort_start = Instant::now();
        all_chunks.sort_by_key(|(_, t)| t.len());
        eprintln!(
            "[bench] sorted {} chunks by length in {} ms",
            all_chunks.len(),
            sort_start.elapsed().as_millis()
        );
    }

    // Warmup: encode a few batches before timing so first-batch overhead
    // (CPU cache, allocator) doesn't pollute the steady-state number.
    // Each encoder in the pool warms up separately so CoreML's per-session
    // compile / first-call lazy init doesn't get charged to the steady state.
    if args.warmup > 0 && !all_chunks.is_empty() {
        let mid = all_chunks.len() / 2;
        let take = args.warmup.min(all_chunks.len());
        let lo = mid.saturating_sub(take / 2);
        let hi = (lo + take).min(all_chunks.len());
        let head = &all_chunks[lo..hi];
        for (i, enc) in encoders.iter().enumerate() {
            let mut e = enc.lock().unwrap();
            for batch in head.chunks(args.batch) {
                let refs: Vec<&str> = batch.iter().map(|(_, t)| t.as_str()).collect();
                if !refs.is_empty() {
                    let _ = e.encode_batch(&refs)?;
                }
            }
            eprintln!("[bench] warmup of {} chunks done on encoder {i}", args.warmup);
        }
    }

    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use rayon::prelude::*;

    let total_chunks_atom = AtomicUsize::new(0);
    let total_batches_atom = AtomicUsize::new(0);
    let batch_ms_min_atom = AtomicU64::new(u64::MAX);
    let batch_ms_max_atom = AtomicU64::new(0);
    let batch_ms_sum_atom = AtomicU64::new(0);

    // Build a vec of batches up-front so rayon can parallelise it across the
    // encoder pool. Each rayon worker grabs an encoder by round-robin and
    // serialises on its mutex; with pool>=worker-count this is contention-free.
    let batches: Vec<Vec<(usize, String)>> = all_chunks
        .chunks(args.batch)
        .map(|b| b.to_vec())
        .collect();

    let total_start = Instant::now();
    let next_encoder = AtomicUsize::new(0);
    batches.par_iter().for_each(|batch| {
        let refs: Vec<&str> = batch.iter().map(|(_, t)| t.as_str()).collect();
        if refs.is_empty() {
            return;
        }
        let idx = next_encoder.fetch_add(1, Ordering::Relaxed) % encoders.len();
        let mut enc = encoders[idx].lock().unwrap();
        let batch_start = Instant::now();
        let _vecs = enc.encode_batch(&refs).expect("encode");
        let batch_ms = batch_start.elapsed().as_millis() as u64;
        total_chunks_atom.fetch_add(refs.len(), Ordering::Relaxed);
        total_batches_atom.fetch_add(1, Ordering::Relaxed);
        batch_ms_min_atom.fetch_min(batch_ms, Ordering::Relaxed);
        batch_ms_max_atom.fetch_max(batch_ms, Ordering::Relaxed);
        batch_ms_sum_atom.fetch_add(batch_ms, Ordering::Relaxed);
    });
    let total_ms = total_start.elapsed().as_millis();
    let total_chunks = total_chunks_atom.load(Ordering::Relaxed);
    let total_batches = total_batches_atom.load(Ordering::Relaxed);
    let batch_ms_min = batch_ms_min_atom.load(Ordering::Relaxed) as u128;
    let batch_ms_max = batch_ms_max_atom.load(Ordering::Relaxed) as u128;
    let batch_ms_sum = batch_ms_sum_atom.load(Ordering::Relaxed) as u128;

    let avg_batch_ms = if total_batches > 0 {
        batch_ms_sum as f64 / total_batches as f64
    } else {
        0.0
    };
    let notes_per_sec = if total_ms > 0 {
        (notes.len() as f64) * 1000.0 / total_ms as f64
    } else {
        0.0
    };

    let summary = format!(
        r#"{{
  "notes": {notes_count},
  "chunks": {chunks},
  "batches": {batches},
  "batch_size_setting": {batch},
  "target_tokens": {target_tokens},
  "load_ms": {load_ms},
  "walk_ms": {walk_ms},
  "encode_total_ms": {total_ms},
  "encode_batch_avg_ms": {avg_batch_ms:.1},
  "encode_batch_min_ms": {batch_ms_min},
  "encode_batch_max_ms": {batch_ms_max},
  "notes_per_sec": {notes_per_sec:.1}
}}"#,
        notes_count = notes.len(),
        chunks = total_chunks,
        batches = total_batches,
        batch = args.batch,
        target_tokens = args.target_tokens,
        load_ms = load_ms,
        walk_ms = walk_ms,
        total_ms = total_ms,
        avg_batch_ms = avg_batch_ms,
        batch_ms_min = if batch_ms_min == u128::MAX { 0 } else { batch_ms_min },
        batch_ms_max = batch_ms_max,
        notes_per_sec = notes_per_sec,
    );
    println!("{summary}");

    Ok(())
}

// `flatten_for_batch` was inlined into main() so we can sort across all
// chunks before batching when `--sort-by-length` is set.
