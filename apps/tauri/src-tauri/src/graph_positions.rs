use crate::core::{CoreState, VectorArtifacts, ensure_vectors_loaded, notes_root, task_join_err};
use rand::prelude::*;
use rand_chacha::ChaCha8Rng;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, State};

#[cfg(test)]
const GRAPH_LAYOUT_SEED: u64 = 0x51f15e77;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPositionsInput {
    pub uuids: Vec<String>,
    pub seed: u64,
    pub n_neighbors: usize,
    pub min_dist: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPositionsOutput {
    pub positions: Vec<PositionEntry>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PositionEntry {
    pub uuid: String,
    pub x: f32,
    pub y: f32,
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn graph_compute_positions(
    app: AppHandle,
    state: State<'_, CoreState>,
    input: GraphPositionsInput,
) -> Result<GraphPositionsOutput, String> {
    let vectors_state = state.vectors.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let artifacts = ensure_vectors_loaded(&base, &vectors_state)?;
        graph_compute_positions_impl(&artifacts, &input)
    })
    .await
    .map_err(task_join_err)?
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

pub(crate) fn graph_compute_positions_impl(
    artifacts: &VectorArtifacts,
    input: &GraphPositionsInput,
) -> Result<GraphPositionsOutput, String> {
    let n = input.uuids.len();
    if n < 2 {
        return Err("Need at least 2 notes for graph layout".to_string());
    }

    // Step 1: Extract per-note vectors (average + L2-normalize chunks per UUID)
    let dims = artifacts.dims;
    let uuid_set: HashMap<&str, usize> = input
        .uuids
        .iter()
        .enumerate()
        .map(|(i, u)| (u.as_str(), i))
        .collect();

    // Group chunk indices by UUID
    let mut by_uuid: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, chunk) in artifacts.chunks.iter().enumerate() {
        if uuid_set.contains_key(chunk.uuid.as_str()) {
            by_uuid.entry(&chunk.uuid).or_default().push(i);
        }
    }

    // Build ordered vectors matching input.uuids order
    let mut note_vectors: Vec<Vec<f32>> = vec![Vec::new(); n];
    for (uuid, idx) in &uuid_set {
        if let Some(chunk_indices) = by_uuid.get(uuid) {
            let mut avg = vec![0.0f32; dims];
            for &ci in chunk_indices {
                let offset = ci * dims;
                for (j, val) in avg.iter_mut().enumerate() {
                    *val += artifacts.vectors[offset + j];
                }
            }
            let count = chunk_indices.len() as f32;
            for val in avg.iter_mut() {
                *val /= count;
            }
            let norm: f32 = avg.iter().map(|v| v * v).sum::<f32>().sqrt();
            if norm > 0.0 {
                for val in avg.iter_mut() {
                    *val /= norm;
                }
            }
            note_vectors[*idx] = avg;
        }
    }

    // Filter out UUIDs with no vectors and track mapping
    let mut valid_indices: Vec<usize> = Vec::with_capacity(n);
    let mut valid_vectors: Vec<&[f32]> = Vec::with_capacity(n);
    for i in 0..n {
        if !note_vectors[i].is_empty() {
            valid_indices.push(i);
            valid_vectors.push(&note_vectors[i]);
        }
    }

    let n_valid = valid_vectors.len();
    if n_valid < 2 {
        return Err("Need at least 2 notes with vectors for graph layout".to_string());
    }

    let n_neighbors = input.n_neighbors.min(n_valid - 1).max(2);

    // Step 2-5: Build kNN graph and fuzzy simplicial set
    let mut rng = ChaCha8Rng::seed_from_u64(input.seed ^ (n_valid as u64));

    let knn = build_knn_graph(&valid_vectors, n_neighbors, dims, &mut rng);
    let sigmas = smooth_knn_distances(&knn, n_neighbors);
    let mut graph = build_fuzzy_simplicial_set(&knn, &sigmas, n_valid);

    // Sort edges for deterministic SGD traversal
    graph.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

    // Step 6: SGD optimization
    let positions_2d = optimize_layout(&graph, n_valid, &mut rng);

    // Normalization
    let half_range = (150.0f32).max((n_valid as f32).sqrt() * 35.0);
    let mut xs: Vec<f32> = positions_2d.iter().map(|p| p.0).collect();
    let mut ys: Vec<f32> = positions_2d.iter().map(|p| p.1).collect();

    let x_min = xs.iter().cloned().fold(f32::INFINITY, f32::min);
    let x_max = xs.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let y_min = ys.iter().cloned().fold(f32::INFINITY, f32::min);
    let y_max = ys.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let x_range = if (x_max - x_min).abs() < 1e-10 {
        1.0
    } else {
        x_max - x_min
    };
    let y_range = if (y_max - y_min).abs() < 1e-10 {
        1.0
    } else {
        y_max - y_min
    };

    for i in 0..n_valid {
        xs[i] = ((xs[i] - x_min) / x_range) * half_range * 2.0 - half_range;
        ys[i] = ((ys[i] - y_min) / y_range) * half_range * 2.0 - half_range;
    }

    // Collision repulsion
    collision_repulsion(&mut xs, &mut ys, n_valid, input.seed);

    // Build output
    let mut positions = Vec::with_capacity(n_valid);
    for (vi, &orig_idx) in valid_indices.iter().enumerate() {
        positions.push(PositionEntry {
            uuid: input.uuids[orig_idx].clone(),
            x: xs[vi],
            y: ys[vi],
        });
    }

    Ok(GraphPositionsOutput { positions })
}

// ---------------------------------------------------------------------------
// kNN graph building
// ---------------------------------------------------------------------------

/// Neighbor entry in the kNN heap: (distance, index)
type KnnHeap = Vec<Vec<(f32, usize)>>;

fn euclidean_distance(a: &[f32], b: &[f32]) -> f32 {
    let mut sum = 0.0f32;
    for i in 0..a.len() {
        let d = a[i] - b[i];
        sum += d * d;
    }
    sum.sqrt()
}

fn build_knn_graph(
    vectors: &[&[f32]],
    n_neighbors: usize,
    dims: usize,
    rng: &mut ChaCha8Rng,
) -> KnnHeap {
    let n = vectors.len();
    let n_trees = ((n / 20) as usize).min(8).max(1);

    // Build RP forest for initial candidates
    let candidates = build_rp_forest(vectors, n_trees, n_neighbors, dims, rng);

    // Initialize kNN heaps from RP forest candidates
    let mut heaps: Vec<Vec<(f32, usize)>> = vec![Vec::new(); n];

    for i in 0..n {
        let mut seen = std::collections::HashSet::new();
        seen.insert(i);
        if let Some(cands) = candidates.get(&i) {
            for &j in cands {
                if seen.contains(&j) {
                    continue;
                }
                seen.insert(j);
                let dist = euclidean_distance(vectors[i], vectors[j]);
                heap_push(&mut heaps[i], dist, j, n_neighbors);
            }
        }
        // If we don't have enough neighbors, add random ones
        let mut attempts = 0;
        while heaps[i].len() < n_neighbors && heaps[i].len() < n - 1 && attempts < n * 2 {
            let j = rng.random_range(0..n);
            attempts += 1;
            if seen.contains(&j) {
                continue;
            }
            seen.insert(j);
            let dist = euclidean_distance(vectors[i], vectors[j]);
            heap_push(&mut heaps[i], dist, j, n_neighbors);
        }
    }

    // NN Descent refinement
    nn_descent(vectors, &mut heaps, n_neighbors);

    heaps
}

/// Push into a max-heap of size k. The heap stores the k nearest neighbors,
/// with the farthest at index 0 (max-heap by distance).
fn heap_push(heap: &mut Vec<(f32, usize)>, dist: f32, idx: usize, k: usize) {
    if heap.len() < k {
        heap.push((dist, idx));
        // Bubble up
        let mut i = heap.len() - 1;
        while i > 0 {
            let parent = (i - 1) / 2;
            if heap[i].0 > heap[parent].0 {
                heap.swap(i, parent);
                i = parent;
            } else {
                break;
            }
        }
    } else if dist < heap[0].0 {
        // Replace the farthest neighbor
        heap[0] = (dist, idx);
        // Sift down
        heap_sift_down(heap);
    }
}

fn heap_sift_down(heap: &mut [(f32, usize)]) {
    let n = heap.len();
    let mut i = 0;
    loop {
        let left = 2 * i + 1;
        let right = 2 * i + 2;
        let mut largest = i;
        if left < n && heap[left].0 > heap[largest].0 {
            largest = left;
        }
        if right < n && heap[right].0 > heap[largest].0 {
            largest = right;
        }
        if largest == i {
            break;
        }
        heap.swap(i, largest);
        i = largest;
    }
}

// ---------------------------------------------------------------------------
// Random Projection Forest
// ---------------------------------------------------------------------------

fn build_rp_forest(
    vectors: &[&[f32]],
    n_trees: usize,
    n_neighbors: usize,
    dims: usize,
    rng: &mut ChaCha8Rng,
) -> HashMap<usize, Vec<usize>> {
    let max_leaf = (10usize).max(n_neighbors);
    let mut candidates: HashMap<usize, Vec<usize>> = HashMap::new();

    for _ in 0..n_trees {
        let indices: Vec<usize> = (0..vectors.len()).collect();
        let mut leaves: Vec<Vec<usize>> = Vec::new();
        rp_tree_split(vectors, &indices, dims, max_leaf, rng, &mut leaves);

        for leaf in &leaves {
            for &i in leaf {
                let entry = candidates.entry(i).or_default();
                for &j in leaf {
                    if j != i {
                        entry.push(j);
                    }
                }
            }
        }
    }

    // Deduplicate candidates
    for cands in candidates.values_mut() {
        cands.sort_unstable();
        cands.dedup();
    }

    candidates
}

fn rp_tree_split(
    vectors: &[&[f32]],
    indices: &[usize],
    dims: usize,
    max_leaf: usize,
    rng: &mut ChaCha8Rng,
    leaves: &mut Vec<Vec<usize>>,
) {
    if indices.len() <= max_leaf {
        leaves.push(indices.to_vec());
        return;
    }

    // Pick two random points to define the hyperplane
    let a = rng.random_range(0..indices.len());
    let mut b = rng.random_range(0..indices.len());
    let mut attempts = 0;
    while b == a && indices.len() > 1 && attempts < 20 {
        b = rng.random_range(0..indices.len());
        attempts += 1;
    }
    let va = vectors[indices[a]];
    let vb = vectors[indices[b]];

    // Hyperplane: the difference vector
    let mut hyperplane = vec![0.0f32; dims];
    for d in 0..dims {
        hyperplane[d] = va[d] - vb[d];
    }

    // Midpoint offset
    let mut offset = 0.0f32;
    for d in 0..dims {
        offset += hyperplane[d] * (va[d] + vb[d]) / 2.0;
    }

    let mut left = Vec::new();
    let mut right = Vec::new();
    for &idx in indices {
        let mut proj = 0.0f32;
        for d in 0..dims {
            proj += hyperplane[d] * vectors[idx][d];
        }
        if proj <= offset {
            left.push(idx);
        } else {
            right.push(idx);
        }
    }

    // Prevent degenerate splits
    if left.is_empty() || right.is_empty() {
        leaves.push(indices.to_vec());
        return;
    }

    rp_tree_split(vectors, &left, dims, max_leaf, rng, leaves);
    rp_tree_split(vectors, &right, dims, max_leaf, rng, leaves);
}

// ---------------------------------------------------------------------------
// NN Descent
// ---------------------------------------------------------------------------

fn nn_descent(vectors: &[&[f32]], heaps: &mut [Vec<(f32, usize)>], n_neighbors: usize) {
    let n = vectors.len();
    let max_iterations = 10;

    for _iter in 0..max_iterations {
        let mut updated = false;

        // Build reverse neighbor lists
        let mut reverse: Vec<Vec<usize>> = vec![Vec::new(); n];
        for i in 0..n {
            for &(_, j) in &heaps[i] {
                reverse[j].push(i);
            }
        }

        // Collect candidate updates in parallel (one vec per point), then flatten deterministically
        let per_point_updates: Vec<Vec<(usize, f32, usize)>> = (0..n)
            .into_par_iter()
            .map(|i| {
                let mut local_updates = Vec::new();
                // Collect all candidate neighbors (neighbors of neighbors)
                let mut candidates = std::collections::HashSet::new();
                for &(_, j) in &heaps[i] {
                    candidates.insert(j);
                    for &(_, k) in &heaps[j] {
                        candidates.insert(k);
                    }
                }
                // Also check reverse neighbors
                for &j in &reverse[i] {
                    candidates.insert(j);
                    for &(_, k) in &heaps[j] {
                        candidates.insert(k);
                    }
                }
                candidates.remove(&i);

                // Current worst distance for i
                let worst_i = if heaps[i].is_empty() {
                    f32::INFINITY
                } else {
                    heaps[i][0].0
                };

                // Sort candidates for deterministic iteration
                let mut sorted_candidates: Vec<usize> = candidates.into_iter().collect();
                sorted_candidates.sort_unstable();

                for c in sorted_candidates {
                    if heaps[i].len() >= n_neighbors && worst_i <= 0.0 {
                        break;
                    }
                    // Check if c is already in i's heap
                    let already = heaps[i].iter().any(|&(_, x)| x == c);
                    if already {
                        continue;
                    }
                    let dist = euclidean_distance(vectors[i], vectors[c]);
                    if heaps[i].len() < n_neighbors || dist < worst_i {
                        local_updates.push((i, dist, c));
                    }
                }
                local_updates
            })
            .collect();

        // Apply updates in point order (par_iter preserves index-to-result mapping)
        for point_updates in per_point_updates {
            for (i, dist, c) in point_updates {
                // Check again if c is in the heap (another update may have added it)
                let already = heaps[i].iter().any(|&(_, x)| x == c);
                if already {
                    continue;
                }
                let before_worst = if heaps[i].is_empty() {
                    f32::INFINITY
                } else {
                    heaps[i][0].0
                };
                if heaps[i].len() < n_neighbors || dist < before_worst {
                    heap_push(&mut heaps[i], dist, c, n_neighbors);
                    updated = true;
                }
            }
        }

        if !updated {
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Smooth kNN distances
// ---------------------------------------------------------------------------

/// Returns (rho, sigma) per point
fn smooth_knn_distances(knn: &KnnHeap, n_neighbors: usize) -> Vec<(f32, f32)> {
    let target = (n_neighbors as f32).ln() / std::f32::consts::LN_2; // log2(nNeighbors)

    knn.par_iter()
        .map(|heap| {
            // Sort neighbors by distance
            let mut neighbors: Vec<(f32, usize)> = heap.clone();
            neighbors.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

            let rho = if neighbors.is_empty() {
                0.0
            } else {
                neighbors[0].0
            };

            // Binary search for sigma
            let mut lo = 1e-5f32;
            let mut hi = 1000.0f32;
            let mut sigma = 1.0f32;

            for _ in 0..64 {
                sigma = (lo + hi) / 2.0;
                let mut sum = 0.0f32;
                for &(d, _) in &neighbors {
                    let adjusted = (d - rho).max(0.0);
                    sum += (-adjusted / sigma).exp();
                }
                if (sum - target).abs() < 1e-5 {
                    break;
                }
                if sum > target {
                    hi = sigma;
                } else {
                    lo = sigma;
                }
            }

            (rho, sigma)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Fuzzy simplicial set
// ---------------------------------------------------------------------------

/// Returns sparse symmetric weight matrix as vec of (i, j, weight) with i < j
fn build_fuzzy_simplicial_set(
    knn: &KnnHeap,
    sigmas: &[(f32, f32)],
    n: usize,
) -> Vec<(usize, usize, f32)> {
    // Compute directed weights
    let mut directed: HashMap<(usize, usize), f32> = HashMap::new();

    for i in 0..n {
        let (rho, sigma) = sigmas[i];
        if sigma <= 0.0 {
            continue;
        }
        for &(d, j) in &knn[i] {
            let adjusted = (d - rho).max(0.0);
            let w = (-adjusted / sigma).exp();
            directed.insert((i, j), w);
        }
    }

    // Symmetrize: w = w_ij + w_ji - w_ij * w_ji
    let mut symmetric: HashMap<(usize, usize), f32> = HashMap::new();

    for (&(i, j), &w_ij) in &directed {
        let key = if i < j { (i, j) } else { (j, i) };
        if symmetric.contains_key(&key) {
            continue;
        }
        let w_ji = directed.get(&(j, i)).copied().unwrap_or(0.0);
        let (a, b) = if i < j { (w_ij, w_ji) } else { (w_ji, w_ij) };
        let w = a + b - a * b;
        if w > 1e-8 {
            symmetric.insert(key, w);
        }
    }

    symmetric
        .into_iter()
        .map(|((i, j), w)| (i, j, w))
        .collect()
}

// ---------------------------------------------------------------------------
// SGD layout optimization
// ---------------------------------------------------------------------------

fn optimize_layout(
    graph: &[(usize, usize, f32)],
    n: usize,
    rng: &mut ChaCha8Rng,
) -> Vec<(f32, f32)> {
    // Hardcoded a, b parameters (from umap-js defaults for minDist=0.1)
    let a: f32 = 1.5769434603113077;
    let b: f32 = 0.8950608779109733;
    let n_epochs = 200;
    let negative_sample_rate = 5;

    // Initialize embedding randomly in [-10, 10]
    let mut embedding: Vec<(f32, f32)> = (0..n)
        .map(|_| {
            let x = rng.random_range(-10.0f32..10.0f32);
            let y = rng.random_range(-10.0f32..10.0f32);
            (x, y)
        })
        .collect();

    if graph.is_empty() {
        return embedding;
    }

    // Compute epochs per edge based on weight
    let max_weight = graph
        .iter()
        .map(|&(_, _, w)| w)
        .fold(0.0f32, f32::max);
    if max_weight <= 0.0 {
        return embedding;
    }

    let epochs_per_edge: Vec<f32> = graph
        .iter()
        .map(|&(_, _, w)| {
            let ratio = w / max_weight;
            if ratio > 0.0 {
                (n_epochs as f32) * ratio
            } else {
                0.0
            }
        })
        .collect();

    let mut epoch_of_next_sample: Vec<f32> = epochs_per_edge
        .iter()
        .map(|&e| {
            if e > 0.0 {
                (n_epochs as f32) / e
            } else {
                f32::INFINITY
            }
        })
        .collect();

    let alpha_init = 1.0f32;
    let clamp = 4.0f32;

    for epoch in 0..n_epochs {
        let alpha = (alpha_init * (1.0 - epoch as f32 / n_epochs as f32)).max(0.001);

        for (edge_idx, &(i, j, _w)) in graph.iter().enumerate() {
            if epoch_of_next_sample[edge_idx] > epoch as f32 {
                continue;
            }

            // Attractive force
            let dx = embedding[i].0 - embedding[j].0;
            let dy = embedding[i].1 - embedding[j].1;
            let dist_sq = dx * dx + dy * dy + 1e-6;
            let dist = dist_sq.sqrt();

            // Gradient for attractive force
            let grad_coeff =
                -2.0 * a * b * dist.powf(2.0 * b - 2.0) / (1.0 + a * dist.powf(2.0 * b));

            let grad_x = (grad_coeff * dx).clamp(-clamp, clamp);
            let grad_y = (grad_coeff * dy).clamp(-clamp, clamp);

            embedding[i].0 += grad_x * alpha;
            embedding[i].1 += grad_y * alpha;
            embedding[j].0 -= grad_x * alpha;
            embedding[j].1 -= grad_y * alpha;

            // Negative sampling (repulsive)
            for _ in 0..negative_sample_rate {
                let k = rng.random_range(0..n);
                if k == i {
                    continue;
                }
                let dx = embedding[i].0 - embedding[k].0;
                let dy = embedding[i].1 - embedding[k].1;
                let dist_sq = dx * dx + dy * dy + 1e-6;

                let grad_coeff = 2.0 * b / ((0.001 + dist_sq) * (1.0 + a * dist_sq.powf(b)));

                let grad_x = (grad_coeff * dx).clamp(-clamp, clamp);
                let grad_y = (grad_coeff * dy).clamp(-clamp, clamp);

                embedding[i].0 += grad_x * alpha;
                embedding[i].1 += grad_y * alpha;
            }

            // Advance epoch counter for this edge
            let step = if epochs_per_edge[edge_idx] > 0.0 {
                (n_epochs as f32) / epochs_per_edge[edge_idx]
            } else {
                f32::INFINITY
            };
            epoch_of_next_sample[edge_idx] += step;
        }
    }

    embedding
}

// ---------------------------------------------------------------------------
// Collision repulsion (grid-based)
// ---------------------------------------------------------------------------

fn collision_repulsion(xs: &mut [f32], ys: &mut [f32], n: usize, seed: u64) {
    let min_dist: f32 = 12.0;
    let cell_size = min_dist;

    // Seeded PRNG for jitter (matches TS LCG)
    let mut jitter_state: u32 = (seed ^ ((n as u64) << 4)) as u32;
    let mut jitter_random = || -> f32 {
        jitter_state = jitter_state
            .wrapping_mul(1664525)
            .wrapping_add(1013904223);
        (jitter_state as f32) / 4294967296.0
    };

    for _iter in 0..50 {
        let mut moved = false;
        let mut grid: HashMap<(i32, i32), Vec<usize>> = HashMap::new();

        for i in 0..n {
            let cx = (xs[i] / cell_size).floor() as i32;
            let cy = (ys[i] / cell_size).floor() as i32;
            grid.entry((cx, cy)).or_default().push(i);
        }

        let keys: Vec<(i32, i32)> = grid.keys().copied().collect();
        for &(cx, cy) in &keys {
            let indices = match grid.get(&(cx, cy)) {
                Some(v) => v.clone(),
                None => continue,
            };
            for dx in -1..=1i32 {
                for dy in -1..=1i32 {
                    let neighbor = match grid.get(&(cx + dx, cy + dy)) {
                        Some(v) => v.clone(),
                        None => continue,
                    };
                    for &i in &indices {
                        for &j in &neighbor {
                            if j <= i {
                                continue;
                            }
                            let ddx = xs[j] - xs[i];
                            let ddy = ys[j] - ys[i];
                            let dist = (ddx * ddx + ddy * ddy).sqrt();
                            if dist < min_dist {
                                if dist > 0.0 {
                                    let overlap = (min_dist - dist) / 2.0;
                                    let nx = ddx / dist;
                                    let ny = ddy / dist;
                                    xs[i] -= nx * overlap;
                                    ys[i] -= ny * overlap;
                                    xs[j] += nx * overlap;
                                    ys[j] += ny * overlap;
                                } else {
                                    xs[j] += (jitter_random() - 0.5) * min_dist;
                                    ys[j] += (jitter_random() - 0.5) * min_dist;
                                }
                                moved = true;
                            }
                        }
                    }
                }
            }
        }

        if !moved {
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ManifestChunk;

    fn make_test_artifacts(vectors: Vec<Vec<f32>>, dims: usize) -> VectorArtifacts {
        let chunks: Vec<ManifestChunk> = vectors
            .iter()
            .enumerate()
            .map(|(i, _)| ManifestChunk {
                chunk_id: i as i64,
                uuid: format!("uuid-{}", i),
                chunk_text: format!("chunk {}", i),
                start_offset: 0,
                end_offset: 10,
            })
            .collect();
        let flat: Vec<f32> = vectors.into_iter().flatten().collect();
        VectorArtifacts {
            dims,
            chunks,
            vectors: flat,
        }
    }

    fn make_random_vectors(n: usize, dims: usize, seed: u64) -> Vec<Vec<f32>> {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        (0..n)
            .map(|_| {
                let v: Vec<f32> = (0..dims)
                    .map(|_| rng.random_range(-1.0f32..1.0f32))
                    .collect();
                // L2-normalize
                let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
                if norm > 0.0 {
                    v.into_iter().map(|x| x / norm).collect()
                } else {
                    v
                }
            })
            .collect()
    }

    #[test]
    fn determinism() {
        let dims = 64;
        let vecs = make_random_vectors(20, dims, 42);
        let artifacts = make_test_artifacts(vecs, dims);
        let uuids: Vec<String> = (0..20).map(|i| format!("uuid-{}", i)).collect();

        let input = GraphPositionsInput {
            uuids: uuids.clone(),
            seed: GRAPH_LAYOUT_SEED,
            n_neighbors: 5,
            min_dist: 0.1,
        };

        let result1 = graph_compute_positions_impl(&artifacts, &input).unwrap();
        let result2 = graph_compute_positions_impl(&artifacts, &input).unwrap();

        assert_eq!(result1.positions.len(), result2.positions.len());
        for (p1, p2) in result1.positions.iter().zip(result2.positions.iter()) {
            assert_eq!(p1.uuid, p2.uuid);
            assert!(
                (p1.x - p2.x).abs() < 1e-6,
                "x mismatch for {}: {} vs {}",
                p1.uuid,
                p1.x,
                p2.x
            );
            assert!(
                (p1.y - p2.y).abs() < 1e-6,
                "y mismatch for {}: {} vs {}",
                p1.uuid,
                p1.y,
                p2.y
            );
        }
    }

    #[test]
    fn cluster_separation() {
        let dims = 64;
        let mut rng = ChaCha8Rng::seed_from_u64(99);

        // Cluster A: vectors near [1, 0, 0, ...]
        let mut vecs = Vec::new();
        for _ in 0..10 {
            let mut v = vec![0.0f32; dims];
            v[0] = 5.0;
            for d in 1..dims {
                v[d] = rng.random_range(-0.1f32..0.1f32);
            }
            let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            vecs.push(v.into_iter().map(|x| x / norm).collect::<Vec<f32>>());
        }
        // Cluster B: vectors near [0, 1, 0, ...]
        for _ in 0..10 {
            let mut v = vec![0.0f32; dims];
            v[1] = 5.0;
            for d in 0..dims {
                if d != 1 {
                    v[d] += rng.random_range(-0.1f32..0.1f32);
                }
            }
            let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            vecs.push(v.into_iter().map(|x| x / norm).collect::<Vec<f32>>());
        }

        let artifacts = make_test_artifacts(vecs, dims);
        let uuids: Vec<String> = (0..20).map(|i| format!("uuid-{}", i)).collect();

        let input = GraphPositionsInput {
            uuids,
            seed: GRAPH_LAYOUT_SEED,
            n_neighbors: 5,
            min_dist: 0.1,
        };

        let result = graph_compute_positions_impl(&artifacts, &input).unwrap();
        assert_eq!(result.positions.len(), 20);

        // Compute centroids of the two clusters
        let (mut ax, mut ay) = (0.0f32, 0.0f32);
        let (mut bx, mut by) = (0.0f32, 0.0f32);
        for (i, pos) in result.positions.iter().enumerate() {
            if i < 10 {
                ax += pos.x;
                ay += pos.y;
            } else {
                bx += pos.x;
                by += pos.y;
            }
        }
        ax /= 10.0;
        ay /= 10.0;
        bx /= 10.0;
        by /= 10.0;

        let centroid_dist = ((ax - bx).powi(2) + (ay - by).powi(2)).sqrt();
        assert!(
            centroid_dist > 20.0,
            "Clusters should be separated, got distance: {}",
            centroid_dist
        );
    }

    #[test]
    fn minimum_two_notes() {
        let dims = 32;
        let vecs = make_random_vectors(2, dims, 123);
        let artifacts = make_test_artifacts(vecs, dims);
        let uuids = vec!["uuid-0".to_string(), "uuid-1".to_string()];

        let input = GraphPositionsInput {
            uuids,
            seed: GRAPH_LAYOUT_SEED,
            n_neighbors: 2,
            min_dist: 0.1,
        };

        let result = graph_compute_positions_impl(&artifacts, &input).unwrap();
        assert_eq!(result.positions.len(), 2);
    }

    #[test]
    fn three_notes() {
        let dims = 32;
        let vecs = make_random_vectors(3, dims, 456);
        let artifacts = make_test_artifacts(vecs, dims);
        let uuids = vec![
            "uuid-0".to_string(),
            "uuid-1".to_string(),
            "uuid-2".to_string(),
        ];

        let input = GraphPositionsInput {
            uuids,
            seed: GRAPH_LAYOUT_SEED,
            n_neighbors: 2,
            min_dist: 0.1,
        };

        let result = graph_compute_positions_impl(&artifacts, &input).unwrap();
        assert_eq!(result.positions.len(), 3);
    }

    #[test]
    fn single_note_errors() {
        let dims = 32;
        let vecs = make_random_vectors(1, dims, 789);
        let artifacts = make_test_artifacts(vecs, dims);
        let uuids = vec!["uuid-0".to_string()];

        let input = GraphPositionsInput {
            uuids,
            seed: GRAPH_LAYOUT_SEED,
            n_neighbors: 2,
            min_dist: 0.1,
        };

        let result = graph_compute_positions_impl(&artifacts, &input);
        assert!(result.is_err());
    }

    #[test]
    fn collision_minimum_distance() {
        let dims = 64;
        let vecs = make_random_vectors(30, dims, 555);
        let artifacts = make_test_artifacts(vecs, dims);
        let uuids: Vec<String> = (0..30).map(|i| format!("uuid-{}", i)).collect();

        let input = GraphPositionsInput {
            uuids,
            seed: GRAPH_LAYOUT_SEED,
            n_neighbors: 5,
            min_dist: 0.1,
        };

        let result = graph_compute_positions_impl(&artifacts, &input).unwrap();
        let positions = &result.positions;

        // Check that no two positions are closer than minDist=12
        // Allow a tiny epsilon for floating point
        let min_dist_check = 12.0f32 - 0.1;
        for i in 0..positions.len() {
            for j in (i + 1)..positions.len() {
                let dx = positions[i].x - positions[j].x;
                let dy = positions[i].y - positions[j].y;
                let dist = (dx * dx + dy * dy).sqrt();
                assert!(
                    dist >= min_dist_check,
                    "Points {} and {} are too close: {} (min: {})",
                    positions[i].uuid,
                    positions[j].uuid,
                    dist,
                    min_dist_check
                );
            }
        }
    }
}
