//! Vault open: what every shell waits on before its note list shows. Each
//! iteration opens a fresh `LocalNoteStore` over the same vault and index dir,
//! as a relaunch does; store drop stays outside the timing.
//! `just bench-vault --save-baseline main`, then `just bench-vault --baseline main`.
//! VAULT_BENCH_NOTES sets the corpus size (default 10,000).

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use futo_notes_store::LocalNoteStore;
use tempfile::TempDir;

/// SplitMix64, so the corpus is the same on every run.
struct Rng(u64);

impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        (z ^ (z >> 31)) % n
    }

    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len() as u64) as usize]
    }
}

const WORDS: &[&str] = &[
    "meeting",
    "planning",
    "the",
    "a",
    "and",
    "of",
    "to",
    "project",
    "review",
    "kitchen",
    "recipe",
    "travel",
    "budget",
    "draft",
    "idea",
    "sync",
    "vault",
    "café",
    "日本語",
    "🎉",
];
const BLOCKS: &[&str] = &[
    "- [ ] follow up\n- [x] sent\n",
    "* one\n* two\n",
    "| a | b |\n| --- | --- |\n| 1 | 2 |\n",
    "```rust\nlet x = f(`inline`, #not_a_tag);\n```\n",
    "![shot](image-20260101-000000.png)\n",
    "<br />\n",
    "> quoted `code`\n",
    "## Section\n",
];

/// Long-tailed: median ~600 B, mean ~4.5 KB, a few notes near 768 KB.
fn note_body(rng: &mut Rng) -> String {
    let size = match rng.below(1000) {
        0..=599 => 40 + rng.below(760),
        600..=879 => 800 + rng.below(3_200),
        880..=979 => 4_000 + rng.below(20_000),
        980..=997 => 24_000 + rng.below(104_000),
        _ => 128_000 + rng.below(640_000),
    } as usize;
    let mut body = String::with_capacity(size + 64);
    if rng.below(2) == 0 {
        body.push_str("# Title\n\n");
    }
    while body.len() < size {
        for _ in 0..3 + rng.below(12) {
            body.push_str(rng.pick(WORDS));
            body.push(' ');
        }
        if rng.below(5) == 0 {
            body.push_str("#work #project-alpha ");
        }
        body.push_str("\n\n");
        if rng.below(3) == 0 {
            body.push_str(rng.pick(BLOCKS));
            body.push('\n');
        }
    }
    body
}

/// `flat` puts every note in the root, the worst case for parallelism that
/// only spreads work across folders.
fn seed_vault(root: &Path, count: usize, flat: bool) {
    let mut rng = Rng(0x5EED);
    let now = SystemTime::now();
    for i in 0..count {
        let folder = match (flat, rng.below(10)) {
            (true, _) | (false, 0) => String::new(),
            (false, depth) => (0..depth % 3 + 1)
                .map(|level| format!("Area {:02}", (i as u64 + level) % 12))
                .collect::<Vec<_>>()
                .join("/"),
        };
        fs::create_dir_all(root.join(&folder)).unwrap();
        let path = root
            .join(&folder)
            .join(format!("{} {i:05}.md", rng.pick(WORDS)));
        fs::write(&path, note_body(&mut rng)).unwrap();
        let age = Duration::from_millis(rng.below(2 * 365 * 24 * 3_600_000));
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(now - age)
            .unwrap();
    }
}

fn timed(vault: &Path, iters: u64, open: impl Fn(&LocalNoteStore)) -> Duration {
    (0..iters)
        .map(|_| {
            let store = LocalNoteStore::new(vault.to_owned());
            let started = Instant::now();
            open(&store);
            started.elapsed()
        })
        .sum()
}

fn vault_open(c: &mut Criterion) {
    let count = std::env::var("VAULT_BENCH_NOTES").map_or(10_000, |value| {
        value.parse().expect("VAULT_BENCH_NOTES must be an integer")
    });
    let (vault, flat, index) = (
        TempDir::new().unwrap(),
        TempDir::new().unwrap(),
        TempDir::new().unwrap(),
    );
    seed_vault(vault.path(), count, false);
    seed_vault(flat.path(), count, true);
    let with_search = |store: &LocalNoteStore| {
        let boot = store
            .bootstrap_with_search(index.path().to_owned(), Arc::new(|_| {}))
            .unwrap();
        assert_eq!(boot.snapshot.notes.len(), count);
        black_box(boot);
    };
    // Past the racy-timestamp margin, then one open to build the persisted
    // index and list cache, so every measured open is a relaunch.
    std::thread::sleep(Duration::from_millis(2_500));
    timed(vault.path(), 2, with_search);

    let mut group = c.benchmark_group("vault_open");
    group.sample_size(20);
    group.measurement_time(Duration::from_secs(6));
    group.bench_function(BenchmarkId::new("bootstrap_with_search", count), |b| {
        b.iter_custom(|iters| timed(vault.path(), iters, with_search))
    });
    group.bench_function(BenchmarkId::new("bootstrap", count), |b| {
        b.iter_custom(|iters| {
            timed(vault.path(), iters, |store| {
                drop(black_box(store.bootstrap()))
            })
        })
    });
    group.bench_function(BenchmarkId::new("startup_listing", count), |b| {
        b.iter_custom(|iters| {
            timed(vault.path(), iters, |store| {
                drop(black_box(store.startup_listing()))
            })
        })
    });
    group.bench_function(BenchmarkId::new("bootstrap_flat", count), |b| {
        b.iter_custom(|iters| {
            timed(flat.path(), iters, |store| {
                drop(black_box(store.bootstrap()))
            })
        })
    });
    group.finish();
}

criterion_group!(benches, vault_open);
criterion_main!(benches);
