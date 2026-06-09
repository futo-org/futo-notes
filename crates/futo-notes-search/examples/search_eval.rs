//! Ad-hoc evaluation harness for `futo-notes-search` over a real vault.
//!
//! Indexes a notes directory, then runs a fixed query set twice: once in
//! BM25-only mode (immediately after the keyword index reconciles, before the
//! SPLADE backfill finishes) and once in hybrid mode (after backfill). Prints
//! per-query latency + top hits for both, plus index/backfill timing.
//!
//! ```text
//! NOTES_ROOT=/path/to/vault \
//! SPLADE_MODEL_PATH=/path/to/splade-model.onnx \
//! SPLADE_TOKENIZER_PATH=/path/to/splade-tokenizer.json \
//! cargo run -p futo-notes-search --example search_eval --release
//! ```

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futo_notes_search::{SearchConfig, SearchEngine, SpladeModelVariant};

const KEYWORD_QUERIES: &[&str] = &[
    "startup ideas",
    "podcast",
    "SQL query",
    "meeting",
    "colors",
];

const ABSTRACT_QUERIES: &[&str] = &[
    "overcoming self-criticism and perfectionism",
    "RGB hex color values for a palette",
    "building a business in the AI era",
    "audio streaming subscription service",
    "career goals and personal growth",
];

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var(key).ok().map(PathBuf::from).filter(|p| p.exists())
}

fn run_queries(engine: &SearchEngine, label: &str, queries: &[&str]) {
    println!("\n──────── {label} ────────");
    for &q in queries {
        // Warm once, then time a few runs and take the min (most representative
        // of steady-state latency, least polluted by scheduler noise).
        let _ = engine.query(q, 5);
        let mut best = Duration::from_secs(3600);
        let mut hits = Vec::new();
        for _ in 0..5 {
            let t = Instant::now();
            hits = engine.query(q, 5).unwrap_or_default();
            best = best.min(t.elapsed());
        }
        let src = hits.first().map(|h| h.source.as_str()).unwrap_or("-");
        println!("\nQ: {q:?}   [{:>6.2} ms, source={src}]", best.as_secs_f64() * 1000.0);
        if hits.is_empty() {
            println!("   (no hits)");
        }
        for (i, h) in hits.iter().enumerate() {
            println!("   {}. {:<7.4}  {}", i + 1, h.score, h.note_id);
        }
    }
}

fn main() {
    let notes_root = env_path("NOTES_ROOT")
        .expect("set NOTES_ROOT to an existing notes directory");
    let model_path = env_path("SPLADE_MODEL_PATH");
    let tokenizer_path = env_path("SPLADE_TOKENIZER_PATH");

    let index_dir = std::env::temp_dir().join(format!(
        "futo-search-eval-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&index_dir);

    let note_count = walkdir_count(&notes_root);
    println!("corpus:     {} ({} note files)", notes_root.display(), note_count);
    println!("index dir:  {}", index_dir.display());
    println!(
        "splade:     model={} tokenizer={}",
        model_path.as_ref().map(|_| "yes").unwrap_or("NONE (BM25-only)"),
        tokenizer_path.as_ref().map(|_| "yes").unwrap_or("NONE"),
    );

    let config = SearchConfig {
        notes_root: notes_root.clone(),
        index_dir: index_dir.clone(),
        model_path,
        tokenizer_path,
        model_variant: SpladeModelVariant::Int8Dynamic,
    };

    let started = Instant::now();
    let engine = SearchEngine::start(config, Arc::new(|_| {})).expect("engine starts");

    // Phase 1: keyword reconcile.
    let t0 = Instant::now();
    wait_until(&engine, |s| s.keyword.ready, Duration::from_secs(120));
    println!("\nkeyword index ready in {:.1}s", t0.elapsed().as_secs_f64());

    // Snapshot BM25-only behavior before backfill completes.
    run_queries(&engine, "BM25-only (keyword)", KEYWORD_QUERIES);
    run_queries(&engine, "BM25-only (abstract)", ABSTRACT_QUERIES);

    // Phase 2: SPLADE backfill, with progress.
    println!("\n──────── SPLADE backfill ────────");
    let backfill_started = Instant::now();
    let total = engine.status().splade.total.max(1);
    let mut last = 0u32;
    loop {
        let s = engine.status();
        if let Some(reason) = &s.splade.fallback_reason {
            println!("backfill aborted: {reason}");
            print_summary(started);
            return;
        }
        if s.splade.ready {
            break;
        }
        if s.splade.indexed != last {
            let pct = 100.0 * s.splade.indexed as f64 / total as f64;
            let rate = s.splade.indexed as f64 / backfill_started.elapsed().as_secs_f64().max(0.001);
            println!(
                "  {}/{} ({pct:.0}%) — {rate:.1} notes/s{}",
                s.splade.indexed,
                s.splade.total,
                if s.splade.compiling { "  [compiling model…]" } else { "" }
            );
            last = s.splade.indexed;
        }
        if backfill_started.elapsed() > Duration::from_secs(1800) {
            println!("backfill timed out after 30 min");
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let backfill_secs = backfill_started.elapsed().as_secs_f64();
    let indexed = engine.status().splade.indexed;
    println!(
        "\nSPLADE backfill complete: {} notes in {:.1}s ({:.1} notes/s)",
        indexed,
        backfill_secs,
        indexed as f64 / backfill_secs.max(0.001)
    );

    // Hybrid behavior (same queries).
    run_queries(&engine, "HYBRID (keyword)", KEYWORD_QUERIES);
    run_queries(&engine, "HYBRID (abstract)", ABSTRACT_QUERIES);

    print_summary(started);
    let _ = std::fs::remove_dir_all(&index_dir);
}

fn print_summary(started: Instant) {
    println!("\n========================================");
    println!("total wall time: {:.1}s", started.elapsed().as_secs_f64());
}

fn wait_until(engine: &SearchEngine, pred: impl Fn(&futo_notes_search::SearchStatus) -> bool, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while !pred(&engine.status()) {
        if Instant::now() > deadline {
            panic!("timed out waiting for engine status");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn walkdir_count(root: &PathBuf) -> usize {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path()
                    .extension()
                    .and_then(|x| x.to_str())
                    .map(|x| {
                        let x = x.to_lowercase();
                        x == "md" || x == "txt"
                    })
                    .unwrap_or(false)
        })
        .count()
}
