//! Public-engine measurements with disposable notes, independent of any user vault.
//! `just bench-search --save-baseline main`, then `just bench-search --baseline main`.
//! Set SEARCH_BENCH_NOTES to vary the corpus size (default: 5,000).

use std::fs;
use std::path::Path;
use std::sync::{mpsc, Arc};
use std::time::Duration;

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use futo_notes_search::{SearchConfig, SearchEngine};
use tempfile::TempDir;

fn seed_vault(root: &Path, count: usize) {
    for folder in 0..20 {
        fs::create_dir(root.join(format!("folder-{folder}"))).unwrap();
    }
    for i in 0..count {
        let repetitions = if i % 500 == 0 {
            4_000
        } else if i % 50 == 0 {
            120
        } else {
            4
        };
        let body = format!(
            "#project{} #work\n\n{}\n{}\n",
            i % 30,
            [
                "meeting planning architecture performance measurements",
                "groceries kitchen breakfast cooking recipe",
                "travel hiking mountain camping equipment",
                "reading writing research library history",
            ][i % 4]
                .repeat(repetitions),
            if i == 0 { "driverless vehicles" } else { "" },
        );
        fs::write(root.join(format!("folder-{}/note-{i:05}.md", i % 20)), body).unwrap();
    }
}

fn start_engine(vault: &Path, index: &Path) -> (SearchEngine, mpsc::Receiver<()>) {
    let (tx, rx) = mpsc::channel();
    let engine = SearchEngine::start(
        SearchConfig {
            notes_root: vault.to_owned(),
            index_dir: index.to_owned(),
        },
        Arc::new(move |status| {
            if status.keyword.ready {
                // The final shutdown notification may arrive after the receiver drops.
                let _ = tx.send(());
            }
        }),
    )
    .unwrap();
    rx.recv_timeout(Duration::from_secs(30))
        .expect("initial reconcile did not finish");
    (engine, rx)
}

fn search(c: &mut Criterion) {
    let count = match std::env::var("SEARCH_BENCH_NOTES") {
        Ok(value) => value
            .parse::<usize>()
            .expect("SEARCH_BENCH_NOTES must be an integer"),
        Err(std::env::VarError::NotPresent) => 5_000,
        Err(error) => panic!("SEARCH_BENCH_NOTES: {error}"),
    };
    assert!(count >= 20, "use at least 20 notes to cover every query");
    let vault = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    seed_vault(vault.path(), count);
    let (engine, ready) = start_engine(vault.path(), index.path());

    let mut group = c.benchmark_group("search");
    group.sample_size(30);
    group.warm_up_time(Duration::from_secs(1));
    group.measurement_time(Duration::from_secs(3));

    group.bench_with_input(
        BenchmarkId::new("unchanged_rescan", count),
        &count,
        |b, _| {
            b.iter(|| {
                engine.rescan();
                ready
                    .recv_timeout(Duration::from_secs(30))
                    .expect("rescan did not finish");
            });
        },
    );

    for (name, query, expected) in [
        ("exact", "meeting ", 50.min(count.div_ceil(4))),
        ("prefix", "mee", 50.min(count.div_ceil(4))),
        (
            "all_words",
            "meeting architecture ",
            50.min(count.div_ceil(4)),
        ),
        ("typo", "drivreless ", 1),
        ("missing", "zzqxvvww ", 0),
    ] {
        assert_eq!(engine.query(query, 50).unwrap().len(), expected, "{name}");
        group.bench_with_input(BenchmarkId::new(name, count), &query, |b, query| {
            b.iter(|| black_box(engine.query(black_box(query), 50).unwrap()));
        });
    }

    drop(ready);
    drop(engine);
    group.sample_size(10);
    group.bench_with_input(BenchmarkId::new("warm_start", count), &count, |b, _| {
        b.iter(|| {
            let (engine, _ready) = start_engine(vault.path(), index.path());
            black_box(engine);
        });
    });
    group.finish();
}

criterion_group!(benches, search);
criterion_main!(benches);
