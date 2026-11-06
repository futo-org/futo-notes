//! Independent per-item work spread over the native cores. WebAssembly has
//! no threads here, so the same calls run in order on the calling thread.

/// Below this many items the hand-off to other cores costs more than it
/// saves; a keystroke's reparse stays on the calling thread.
#[cfg(not(target_arch = "wasm32"))]
const PARALLEL_FROM: usize = 64;

/// At most this many workers. On the 8-core Moto g play 2023 (two clusters
/// of four A53s) a select-all Bold over 10,000 blocks took 1.10 s with 4
/// workers and 1.63 s with 8: the slower cluster and the shared allocator
/// cost more than its cores bring.
#[cfg(not(target_arch = "wasm32"))]
const MAX_WORKERS: usize = 4;

/// `None` when no worker thread could start: the work then runs in place.
#[cfg(not(target_arch = "wasm32"))]
fn pool() -> Option<&'static rayon::ThreadPool> {
    static POOL: std::sync::OnceLock<Option<rayon::ThreadPool>> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        let cores = std::thread::available_parallelism().map_or(1, |cores| cores.get());
        rayon::ThreadPoolBuilder::new()
            .num_threads(cores.min(MAX_WORKERS))
            .thread_name(|index| format!("futo-editor-{index}"))
            .build()
            .ok()
    })
    .as_ref()
}

/// `f` over every item, results in item order.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync + Send) -> Vec<R> {
    use rayon::prelude::*;
    match pool() {
        Some(pool) if items.len() >= PARALLEL_FROM => {
            pool.install(|| items.par_iter().map(f).collect())
        }
        _ => items.iter().map(f).collect(),
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn map<T, R>(items: &[T], f: impl Fn(&T) -> R) -> Vec<R> {
    items.iter().map(f).collect()
}

/// Free a large retired structure (`count` items) off the calling thread, so
/// a whole-note reparse does not also wait for the old rows to be dropped.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn drop_large<T: Send + 'static>(value: T, count: usize) {
    match pool() {
        Some(pool) if count >= PARALLEL_FROM => pool.spawn(move || drop(value)),
        _ => drop(value),
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn drop_large<T>(value: T, _count: usize) {
    drop(value);
}
