//! Graph layout (UMAP) and clustering (K-Means) algorithms.
//!
//! Ported from V1 Tauri implementations in `graph_positions.rs` and
//! `graph_clusters.rs`, adapted to use filename-based identity instead of UUIDs.

use rand::prelude::*;
use rand_chacha::ChaCha8Rng;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UMAP_A: f64 = 1.5769434603113077;
const UMAP_B: f64 = 0.8950608779109733;
const N_EPOCHS: usize = 200;
const NEGATIVE_SAMPLE_RATE: usize = 5;
const GRAD_CLIP: f64 = 4.0;
const COLLISION_MIN_DIST: f32 = 12.0;
const COLLISION_ITERATIONS: usize = 50;
const FUZZY_WEIGHT_THRESHOLD: f64 = 1e-8;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Input vector for a single note.
#[derive(Debug, Clone)]
pub struct NoteVector {
    pub filename: String,
    pub embedding: Vec<f32>,
}

/// A single node's position in the 2D layout.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PositionEntry {
    pub filename: String,
    pub x: f32,
    pub y: f32,
}

/// Rich cluster information including label and geometry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterInfo {
    pub index: usize,
    pub label: String,
    pub center_x: f32,
    pub center_y: f32,
    pub radius: f32,
    pub color_index: usize,
    pub filenames: Vec<String>,
}

/// Complete graph layout result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphLayout {
    pub positions: Vec<PositionEntry>,
    pub clusters: Vec<ClusterInfo>,
}

// ---------------------------------------------------------------------------
// SeededRandom — LCG matching V1 TypeScript `createSeededRandom`
// ---------------------------------------------------------------------------

struct SeededRandom {
    state: u32,
}

impl SeededRandom {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    fn next_f32(&mut self) -> f32 {
        self.state = self
            .state
            .wrapping_mul(1_664_525)
            .wrapping_add(1_013_904_223);
        self.state as f32 / 4_294_967_296.0
    }
}

// ---------------------------------------------------------------------------
// Vector utilities
// ---------------------------------------------------------------------------

fn l2_normalize(v: &mut [f32]) {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

fn euclidean_dist_sq(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| (x - y) * (x - y)).sum()
}

fn euclidean_dist(a: &[f32], b: &[f32]) -> f32 {
    euclidean_dist_sq(a, b).sqrt()
}

/// Average multiple embeddings into one, then L2-normalize.
pub fn average_and_normalize(embeddings: &[Vec<f32>]) -> Option<Vec<f32>> {
    if embeddings.is_empty() {
        return None;
    }
    let dims = embeddings[0].len();
    let mut avg = vec![0.0f32; dims];
    for emb in embeddings {
        for (i, v) in emb.iter().enumerate() {
            avg[i] += v;
        }
    }
    let n = embeddings.len() as f32;
    for v in avg.iter_mut() {
        *v /= n;
    }
    l2_normalize(&mut avg);
    Some(avg)
}

// ---------------------------------------------------------------------------
// Cluster count heuristic
// ---------------------------------------------------------------------------

/// Determine optimal cluster count based on note count.
/// Ported from V1 `graph_clusters.rs::determine_cluster_count`.
pub fn determine_cluster_count(note_count: usize) -> usize {
    if note_count < 12 {
        return 3.max(note_count.min(4));
    }
    let lower_bound: usize = if note_count >= 400 { 6 } else { 3 };
    let hard_upper_bound: usize = if note_count >= 700 { 8 } else { 12 };
    let upper_bound = hard_upper_bound.min(lower_bound.max(note_count / 12));
    let suggested = ((note_count as f64).sqrt() / 3.0).round() as usize;
    lower_bound.max(upper_bound.min(suggested))
}

// ---------------------------------------------------------------------------
// K-Means clustering
// ---------------------------------------------------------------------------

/// Run K-Means clustering on the given vectors.
/// Returns cluster assignments (index into `vectors` → cluster index).
pub fn k_means(vectors: &[Vec<f32>], k: usize, seed: u32) -> Vec<usize> {
    let n = vectors.len();
    if n == 0 || k == 0 {
        return vec![];
    }
    let k = k.min(n);

    // Farthest-point initialization
    let mut rng = SeededRandom::new(seed ^ (n as u32));
    let first = (rng.next_f32() * n as f32) as usize % n;
    let mut centroids: Vec<Vec<f32>> = vec![vectors[first].clone()];
    let mut min_dists = vec![f32::MAX; n];

    for _ in 1..k {
        // Update minimum distances to nearest centroid
        let last = centroids.last().unwrap();
        for (i, v) in vectors.iter().enumerate() {
            let d = euclidean_dist_sq(v, last);
            if d < min_dists[i] {
                min_dists[i] = d;
            }
        }
        // Pick farthest point
        let farthest = min_dists
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(i, _)| i)
            .unwrap_or(0);
        centroids.push(vectors[farthest].clone());
    }

    // Lloyd's iteration (max 24 rounds)
    let mut assignments = vec![0usize; n];
    for _iter in 0..24 {
        let mut changed = false;

        // Assign each point to nearest centroid
        for (i, v) in vectors.iter().enumerate() {
            let mut best = 0;
            let mut best_dist = f32::MAX;
            for (c, centroid) in centroids.iter().enumerate() {
                let d = euclidean_dist_sq(v, centroid);
                if d < best_dist {
                    best_dist = d;
                    best = c;
                }
            }
            if assignments[i] != best {
                assignments[i] = best;
                changed = true;
            }
        }

        if !changed {
            break;
        }

        // Recompute centroids
        let dims = vectors[0].len();
        let mut sums = vec![vec![0.0f32; dims]; k];
        let mut counts = vec![0usize; k];
        for (i, v) in vectors.iter().enumerate() {
            let c = assignments[i];
            counts[c] += 1;
            for (j, val) in v.iter().enumerate() {
                sums[c][j] += val;
            }
        }
        for c in 0..k {
            if counts[c] > 0 {
                for j in 0..dims {
                    centroids[c][j] = sums[c][j] / counts[c] as f32;
                }
            } else {
                // Reinitialize empty cluster with random point
                let idx = (rng.next_f32() * n as f32) as usize % n;
                centroids[c] = vectors[idx].clone();
            }
        }
    }

    assignments
}

// ---------------------------------------------------------------------------
// kNN graph building (Random Projection Forest + NN Descent)
// ---------------------------------------------------------------------------

/// kNN heap entry: (distance, index). Max-heap by distance.
type KnnHeap = Vec<(f32, usize)>;

fn heap_push(heap: &mut KnnHeap, dist: f32, idx: usize, k: usize) -> bool {
    // Check if idx is already in heap
    if heap.iter().any(|(_, i)| *i == idx) {
        return false;
    }

    if heap.len() < k {
        heap.push((dist, idx));
        // Bubble up
        let mut pos = heap.len() - 1;
        while pos > 0 {
            let parent = (pos - 1) / 2;
            if heap[pos].0 > heap[parent].0 {
                heap.swap(pos, parent);
                pos = parent;
            } else {
                break;
            }
        }
        return true;
    }

    if dist >= heap[0].0 {
        return false;
    }

    // Replace root (farthest) and sift down
    heap[0] = (dist, idx);
    let mut pos = 0;
    loop {
        let left = 2 * pos + 1;
        let right = 2 * pos + 2;
        let mut largest = pos;
        if left < heap.len() && heap[left].0 > heap[largest].0 {
            largest = left;
        }
        if right < heap.len() && heap[right].0 > heap[largest].0 {
            largest = right;
        }
        if largest != pos {
            heap.swap(pos, largest);
            pos = largest;
        } else {
            break;
        }
    }
    true
}

/// Build kNN graph using random projection forest + NN descent refinement.
fn build_knn_graph(vectors: &[Vec<f32>], n_neighbors: usize, rng: &mut ChaCha8Rng) -> Vec<KnnHeap> {
    let n = vectors.len();
    let k = n_neighbors.min(n - 1);
    let mut heaps: Vec<KnnHeap> = (0..n).map(|_| Vec::with_capacity(k)).collect();

    // RP Forest: build trees and collect candidate pairs
    let n_trees = (n / 20).clamp(1, 8);
    let max_leaf = k.max(10);

    for _ in 0..n_trees {
        let indices: Vec<usize> = (0..n).collect();
        let leaves = rp_tree_split(vectors, &indices, max_leaf, rng);
        for leaf in &leaves {
            for (i, &a) in leaf.iter().enumerate() {
                for &b in leaf.iter().skip(i + 1) {
                    let d = euclidean_dist(vectors[a].as_slice(), vectors[b].as_slice());
                    heap_push(&mut heaps[a], d, b, k);
                    heap_push(&mut heaps[b], d, a, k);
                }
            }
        }
    }

    // Fill any gaps with random candidates
    for i in 0..n {
        while heaps[i].len() < k {
            let j = rng.gen_range(0..n);
            if j != i {
                let d = euclidean_dist(vectors[i].as_slice(), vectors[j].as_slice());
                heap_push(&mut heaps[i], d, j, k);
            }
        }
    }

    // NN Descent refinement (up to 10 iterations)
    for _ in 0..10 {
        let mut updated = false;

        for i in 0..n {
            let neighbors: Vec<usize> = heaps[i].iter().map(|(_, idx)| *idx).collect();
            // Collect neighbors-of-neighbors
            let mut candidates: Vec<usize> = Vec::new();
            for &nb in &neighbors {
                for &(_, nb2) in &heaps[nb] {
                    if nb2 != i && !neighbors.contains(&nb2) {
                        candidates.push(nb2);
                    }
                }
            }
            candidates.sort_unstable();
            candidates.dedup();

            for c in candidates {
                let d = euclidean_dist(vectors[i].as_slice(), vectors[c].as_slice());
                if heap_push(&mut heaps[i], d, c, k) {
                    updated = true;
                }
            }
        }

        if !updated {
            break;
        }
    }

    heaps
}

/// Recursively split indices using random projection.
fn rp_tree_split(
    vectors: &[Vec<f32>],
    indices: &[usize],
    max_leaf: usize,
    rng: &mut ChaCha8Rng,
) -> Vec<Vec<usize>> {
    if indices.len() <= max_leaf {
        return vec![indices.to_vec()];
    }

    let dims = vectors[0].len();
    let a_idx = indices[rng.gen_range(0..indices.len())];
    let b_idx = indices[rng.gen_range(0..indices.len())];
    if a_idx == b_idx {
        return vec![indices.to_vec()];
    }

    // Hyperplane normal: va - vb
    let va = &vectors[a_idx];
    let vb = &vectors[b_idx];
    let mut normal = vec![0.0f32; dims];
    let mut midpoint_dot = 0.0f32;
    for j in 0..dims {
        normal[j] = va[j] - vb[j];
        midpoint_dot += normal[j] * (va[j] + vb[j]) / 2.0;
    }

    let mut left = Vec::new();
    let mut right = Vec::new();
    for &idx in indices {
        let proj: f32 = vectors[idx]
            .iter()
            .zip(normal.iter())
            .map(|(a, b)| a * b)
            .sum();
        if proj <= midpoint_dot {
            left.push(idx);
        } else {
            right.push(idx);
        }
    }

    // Avoid degenerate splits
    if left.is_empty() || right.is_empty() {
        return vec![indices.to_vec()];
    }

    let mut leaves = rp_tree_split(vectors, &left, max_leaf, rng);
    leaves.extend(rp_tree_split(vectors, &right, max_leaf, rng));
    leaves
}

// ---------------------------------------------------------------------------
// Smooth kNN distances (sigma computation)
// ---------------------------------------------------------------------------

fn smooth_knn_distances(heaps: &[KnnHeap], n_neighbors: usize) -> Vec<(f64, f64)> {
    let target = (n_neighbors as f64).ln() / std::f64::consts::LN_2; // log2(n_neighbors)

    heaps
        .par_iter()
        .map(|heap| {
            let dists: Vec<f64> = {
                let mut d: Vec<f64> = heap.iter().map(|(dist, _)| *dist as f64).collect();
                d.sort_by(|a, b| a.partial_cmp(b).unwrap());
                d
            };

            let rho = if dists.is_empty() { 0.0 } else { dists[0] };

            // Binary search for sigma
            let mut lo = 1e-5_f64;
            let mut hi = 1000.0_f64;
            let mut sigma = 1.0;

            for _ in 0..64 {
                sigma = (lo + hi) / 2.0;
                let sum: f64 = dists
                    .iter()
                    .map(|&d| {
                        let shifted = (d - rho).max(0.0);
                        (-shifted / sigma).exp()
                    })
                    .sum();

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
// Build fuzzy simplicial set
// ---------------------------------------------------------------------------

fn build_fuzzy_simplicial_set(
    heaps: &[KnnHeap],
    sigmas: &[(f64, f64)],
) -> Vec<(usize, usize, f64)> {
    // Compute directed weights
    let mut directed: HashMap<(usize, usize), f64> = HashMap::new();
    for (i, heap) in heaps.iter().enumerate() {
        let (rho, sigma) = sigmas[i];
        for &(dist, j) in heap {
            let shifted = ((dist as f64) - rho).max(0.0);
            let w = (-shifted / sigma).exp();
            directed.insert((i, j), w);
        }
    }

    // Symmetrize: w = w_ij + w_ji - w_ij * w_ji
    let mut edges: HashMap<(usize, usize), f64> = HashMap::new();
    for (&(i, j), &w_ij) in &directed {
        let key = if i < j { (i, j) } else { (j, i) };
        let w_ji = directed.get(&(j, i)).copied().unwrap_or(0.0);
        let w = w_ij + w_ji - w_ij * w_ji;
        edges
            .entry(key)
            .and_modify(|existing| {
                if w > *existing {
                    *existing = w;
                }
            })
            .or_insert(w);
    }

    // Filter and collect
    let mut result: Vec<(usize, usize, f64)> = edges
        .into_iter()
        .filter(|(_, w)| *w > FUZZY_WEIGHT_THRESHOLD)
        .map(|((i, j), w)| (i, j, w))
        .collect();
    result.sort_by_key(|(i, j, _)| (*i, *j));
    result
}

// ---------------------------------------------------------------------------
// UMAP SGD optimization
// ---------------------------------------------------------------------------

fn optimize_layout(n: usize, edges: &[(usize, usize, f64)], rng: &mut ChaCha8Rng) -> Vec<[f64; 2]> {
    // Initialize random embedding
    let mut embedding: Vec<[f64; 2]> = (0..n)
        .map(|_| [rng.gen_range(-10.0..10.0), rng.gen_range(-10.0..10.0)])
        .collect();

    if edges.is_empty() {
        return embedding;
    }

    let max_weight = edges.iter().map(|(_, _, w)| *w).fold(0.0_f64, f64::max);

    // Compute epochs-per-edge
    let epochs_per_edge: Vec<f64> = edges
        .iter()
        .map(|(_, _, w)| N_EPOCHS as f64 * (w / max_weight))
        .collect();

    let mut next_epoch: Vec<f64> = epochs_per_edge
        .iter()
        .map(|epe| {
            if *epe > 0.0 {
                N_EPOCHS as f64 / epe
            } else {
                f64::MAX
            }
        })
        .collect();

    for epoch in 0..N_EPOCHS {
        let alpha = (1.0 - epoch as f64 / N_EPOCHS as f64).max(0.001);

        for (edge_idx, &(i, j, _)) in edges.iter().enumerate() {
            if (epoch as f64) < next_epoch[edge_idx] {
                continue;
            }
            next_epoch[edge_idx] += if epochs_per_edge[edge_idx] > 0.0 {
                N_EPOCHS as f64 / epochs_per_edge[edge_idx]
            } else {
                f64::MAX
            };

            let dx = embedding[i][0] - embedding[j][0];
            let dy = embedding[i][1] - embedding[j][1];
            let dist_sq = dx * dx + dy * dy;
            let dist_sq = dist_sq.max(1e-8);

            // Attractive gradient
            let grad_coeff = -2.0 * UMAP_A * UMAP_B * dist_sq.powf(UMAP_B - 1.0)
                / (1.0 + UMAP_A * dist_sq.powf(UMAP_B));

            let gx = (grad_coeff * dx).clamp(-GRAD_CLIP, GRAD_CLIP) * alpha;
            let gy = (grad_coeff * dy).clamp(-GRAD_CLIP, GRAD_CLIP) * alpha;

            embedding[i][0] += gx;
            embedding[i][1] += gy;
            embedding[j][0] -= gx;
            embedding[j][1] -= gy;

            // Negative sampling
            for _ in 0..NEGATIVE_SAMPLE_RATE {
                let k = rng.gen_range(0..n);
                if k == i {
                    continue;
                }
                let dx = embedding[i][0] - embedding[k][0];
                let dy = embedding[i][1] - embedding[k][1];
                let dist_sq = (dx * dx + dy * dy).max(1e-8);

                let rep_coeff =
                    2.0 * UMAP_B / ((0.001 + dist_sq) * (1.0 + UMAP_A * dist_sq.powf(UMAP_B)));

                let rx = (rep_coeff * dx).clamp(-GRAD_CLIP, GRAD_CLIP) * alpha;
                let ry = (rep_coeff * dy).clamp(-GRAD_CLIP, GRAD_CLIP) * alpha;

                embedding[i][0] += rx;
                embedding[i][1] += ry;
            }
        }
    }

    embedding
}

// ---------------------------------------------------------------------------
// Collision repulsion + normalization
// ---------------------------------------------------------------------------

fn normalize_and_repulse(embedding: &mut [[f64; 2]], n: usize) {
    if n == 0 {
        return;
    }

    // Scale to [-half_range, +half_range]
    let half_range = (150.0_f64).max((n as f64).sqrt() * 35.0);
    let mut min_x = f64::MAX;
    let mut max_x = f64::MIN;
    let mut min_y = f64::MAX;
    let mut max_y = f64::MIN;
    for p in embedding.iter() {
        min_x = min_x.min(p[0]);
        max_x = max_x.max(p[0]);
        min_y = min_y.min(p[1]);
        max_y = max_y.max(p[1]);
    }
    let range_x = (max_x - min_x).max(1e-8);
    let range_y = (max_y - min_y).max(1e-8);
    for p in embedding.iter_mut() {
        p[0] = (p[0] - min_x) / range_x * 2.0 * half_range - half_range;
        p[1] = (p[1] - min_y) / range_y * 2.0 * half_range - half_range;
    }

    // Grid-based collision repulsion
    let cell_size = COLLISION_MIN_DIST as f64;
    for _ in 0..COLLISION_ITERATIONS {
        let mut grid: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
        for (i, p) in embedding.iter().enumerate() {
            let gx = (p[0] / cell_size).floor() as i64;
            let gy = (p[1] / cell_size).floor() as i64;
            grid.entry((gx, gy)).or_default().push(i);
        }

        let mut displacements = vec![[0.0_f64; 2]; n];
        for (&(gx, gy), indices) in &grid {
            // Check this cell and neighbors
            for dx in -1..=1 {
                for dy in -1..=1 {
                    if let Some(neighbors) = grid.get(&(gx + dx, gy + dy)) {
                        for &i in indices {
                            for &j in neighbors {
                                if i >= j {
                                    continue;
                                }
                                let ddx = embedding[i][0] - embedding[j][0];
                                let ddy = embedding[i][1] - embedding[j][1];
                                let dist = (ddx * ddx + ddy * ddy).sqrt();
                                if dist < cell_size && dist > 0.0 {
                                    let push = (cell_size - dist) / 2.0;
                                    let nx = ddx / dist;
                                    let ny = ddy / dist;
                                    displacements[i][0] += push * nx;
                                    displacements[i][1] += push * ny;
                                    displacements[j][0] -= push * nx;
                                    displacements[j][1] -= push * ny;
                                } else if dist == 0.0 {
                                    // Jitter apart
                                    displacements[i][0] += cell_size * 0.5;
                                    displacements[j][0] -= cell_size * 0.5;
                                }
                            }
                        }
                    }
                }
            }
        }

        for (i, p) in embedding.iter_mut().enumerate() {
            p[0] += displacements[i][0];
            p[1] += displacements[i][1];
        }
    }
}

// ---------------------------------------------------------------------------
// Public API: compute_layout
// ---------------------------------------------------------------------------

/// Compute 2D UMAP layout for a set of note vectors.
///
/// Returns one `PositionEntry` per input vector. Requires at least 2 vectors.
pub fn compute_layout(
    vectors: &[NoteVector],
    seed: u64,
    n_neighbors: usize,
    _min_dist: f32,
) -> Vec<PositionEntry> {
    let n = vectors.len();
    if n == 0 {
        return vec![];
    }
    if n == 1 {
        return vec![PositionEntry {
            filename: vectors[0].filename.clone(),
            x: 0.0,
            y: 0.0,
        }];
    }

    let k = if n <= 2 {
        1
    } else {
        n_neighbors.clamp(2, n - 1)
    };
    let vecs: Vec<Vec<f32>> = vectors.iter().map(|v| v.embedding.clone()).collect();

    let mut rng = ChaCha8Rng::seed_from_u64(seed);

    // Step 1: Build kNN graph
    let heaps = build_knn_graph(&vecs, k, &mut rng);

    // Step 2: Smooth kNN distances
    let sigmas = smooth_knn_distances(&heaps, k);

    // Step 3: Build fuzzy simplicial set
    let edges = build_fuzzy_simplicial_set(&heaps, &sigmas);

    // Step 4: SGD optimization
    let mut embedding = optimize_layout(n, &edges, &mut rng);

    // Step 5: Normalize and collision repulsion
    normalize_and_repulse(&mut embedding, n);

    // Map back to entries
    vectors
        .iter()
        .enumerate()
        .map(|(i, v)| PositionEntry {
            filename: v.filename.clone(),
            x: embedding[i][0] as f32,
            y: embedding[i][1] as f32,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Public API: compute_clusters
// ---------------------------------------------------------------------------

/// Compute clusters for positioned notes using K-Means on their embeddings.
///
/// Returns cluster info with labels, centers, radii, and membership.
pub fn compute_clusters(
    vectors: &[NoteVector],
    positions: &[PositionEntry],
    seed: u32,
) -> Vec<ClusterInfo> {
    let n = vectors.len();
    if n == 0 {
        return vec![];
    }

    let k = determine_cluster_count(n);
    let vecs: Vec<Vec<f32>> = vectors.iter().map(|v| v.embedding.clone()).collect();
    let assignments = k_means(&vecs, k, seed);

    // Group by cluster
    let mut cluster_members: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, &c) in assignments.iter().enumerate() {
        cluster_members.entry(c).or_default().push(i);
    }

    let mut clusters: Vec<ClusterInfo> = Vec::new();
    for cluster_idx in 0..k {
        let members = cluster_members
            .get(&cluster_idx)
            .cloned()
            .unwrap_or_default();
        if members.is_empty() {
            continue;
        }

        let filenames: Vec<String> = members
            .iter()
            .map(|&i| vectors[i].filename.clone())
            .collect();

        // Compute centroid from positions
        let cx: f32 = members.iter().map(|&i| positions[i].x).sum::<f32>() / members.len() as f32;
        let cy: f32 = members.iter().map(|&i| positions[i].y).sum::<f32>() / members.len() as f32;

        // Compute radius: max distance from centroid + padding
        let max_dist = members
            .iter()
            .map(|&i| {
                let dx = positions[i].x - cx;
                let dy = positions[i].y - cy;
                (dx * dx + dy * dy).sqrt()
            })
            .fold(0.0f32, f32::max);
        let radius = max_dist + 24.0;
        let radius = radius.max(48.0);

        // Generate label from filenames
        let label = generate_cluster_label(&filenames);

        clusters.push(ClusterInfo {
            index: cluster_idx,
            label,
            center_x: cx,
            center_y: cy,
            radius,
            color_index: clusters.len() % 12,
            filenames,
        });
    }

    clusters
}

// ---------------------------------------------------------------------------
// Cluster label generation
// ---------------------------------------------------------------------------

/// Stopwords to exclude from label candidates.
const LABEL_STOPWORDS: &[&str] = &[
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
    "from", "as", "is", "was", "are", "were", "be", "been", "being", "have", "has", "had", "do",
    "does", "did", "will", "would", "could", "should", "may", "might", "can", "shall", "not", "no",
    "nor", "so", "if", "then", "than", "that", "this", "these", "those", "it", "its", "my", "your",
    "his", "her", "our", "their", "we", "you", "he", "she", "they", "me", "him", "us", "them",
    "who", "what", "which", "when", "where", "how", "why", "all", "each", "every", "both", "few",
    "more", "most", "other", "some", "such", "just", "about", "up", "out", "into", "over", "after",
    "before", "between", "under", "again", "further", "also", "very", "too", "only", "own", "same",
    "here", "there", "now",
];

const LABEL_LOW_SIGNAL: &[&str] = &[
    "note", "notes", "idea", "ideas", "chapter", "guide", "intro", "doc", "docs", "page", "pages",
    "draft", "drafts", "list", "lists", "section", "part", "item", "items", "thing", "things",
    "stuff", "misc", "untitled", "new", "old", "temp", "test", "copy",
];

/// Generate a label for a cluster from its member filenames.
fn generate_cluster_label(filenames: &[String]) -> String {
    if filenames.is_empty() {
        return "Notes".to_string();
    }

    // Tokenize all filenames
    let mut token_counts: HashMap<String, usize> = HashMap::new();
    let mut doc_freq: HashMap<String, usize> = HashMap::new();

    for filename in filenames {
        let title = filename.strip_suffix(".md").unwrap_or(filename);
        let tokens = tokenize_title(title);
        let mut seen = std::collections::HashSet::new();
        for token in &tokens {
            *token_counts.entry(token.clone()).or_default() += 1;
            if seen.insert(token.clone()) {
                *doc_freq.entry(token.clone()).or_default() += 1;
            }
        }
    }

    let n = filenames.len();
    let min_coverage = 2.max((n as f64 * 0.16).ceil() as usize);

    // Score tokens by TF-IDF-like metric
    let mut candidates: Vec<(String, f64, usize)> = Vec::new();
    for token in token_counts.keys() {
        let df = doc_freq.get(token).copied().unwrap_or(1);
        if df < min_coverage.min(if n <= 6 { 1 } else { min_coverage }) {
            continue;
        }
        let idf = ((1.0 + n as f64) / (df as f64 + 1.0)).ln();
        let score = 1.5 * idf * (1.0 + df as f64 / n as f64);
        candidates.push((token.clone(), score, df));
    }

    candidates.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.2.cmp(&a.2))
            .then(a.0.cmp(&b.0))
    });

    if let Some((label, _, _)) = candidates.first() {
        title_case(label)
    } else {
        "Notes".to_string()
    }
}

/// Tokenize a note title into normalized tokens.
fn tokenize_title(title: &str) -> Vec<String> {
    let lower = title.to_lowercase();
    let mut tokens = Vec::new();

    let mut current = String::new();
    for ch in lower.chars() {
        if ch.is_alphanumeric() || ch == '-' {
            current.push(ch);
        } else if !current.is_empty() {
            if let Some(normalized) = normalize_token(&current) {
                tokens.push(normalized);
            }
            current.clear();
        }
    }
    if !current.is_empty() {
        if let Some(normalized) = normalize_token(&current) {
            tokens.push(normalized);
        }
    }

    tokens
}

/// Normalize a token: lowercase, strip non-alphanumeric, basic stemming, stopword filter.
fn normalize_token(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-')
        .collect();
    if cleaned.is_empty() || cleaned.len() < 3 {
        return None;
    }
    if cleaned.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if LABEL_STOPWORDS.contains(&cleaned.as_str()) {
        return None;
    }
    if LABEL_LOW_SIGNAL.contains(&cleaned.as_str()) {
        return None;
    }

    // Basic plural stemming
    let stemmed = if cleaned.ends_with("ies") && cleaned.len() > 4 {
        format!("{}y", &cleaned[..cleaned.len() - 3])
    } else if cleaned.ends_with('s') && !cleaned.ends_with("ss") && cleaned.len() > 4 {
        cleaned[..cleaned.len() - 1].to_string()
    } else {
        cleaned
    };

    Some(stemmed)
}

/// Convert a string to title case.
fn title_case(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut capitalize = true;
    for ch in s.chars() {
        if capitalize {
            result.extend(ch.to_uppercase());
            capitalize = false;
        } else {
            result.push(ch);
        }
        if ch == ' ' || ch == '-' {
            capitalize = true;
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_determine_cluster_count_small() {
        assert_eq!(determine_cluster_count(0), 3);
        assert_eq!(determine_cluster_count(3), 3);
        assert_eq!(determine_cluster_count(5), 4);
        assert_eq!(determine_cluster_count(11), 4);
    }

    #[test]
    fn test_determine_cluster_count_medium() {
        let k = determine_cluster_count(100);
        assert!((3..=12).contains(&k), "got {k}");
    }

    #[test]
    fn test_determine_cluster_count_large() {
        let k = determine_cluster_count(500);
        assert!((6..=8).contains(&k), "got {k}");
    }

    #[test]
    fn test_k_means_basic() {
        // 4 vectors in 2 natural clusters
        let vecs = vec![
            vec![1.0, 0.0],
            vec![1.1, 0.1],
            vec![-1.0, 0.0],
            vec![-1.1, 0.1],
        ];
        let assignments = k_means(&vecs, 2, 42);
        assert_eq!(assignments.len(), 4);
        // First two should share a cluster, last two should share a cluster
        assert_eq!(assignments[0], assignments[1]);
        assert_eq!(assignments[2], assignments[3]);
        assert_ne!(assignments[0], assignments[2]);
    }

    #[test]
    fn test_k_means_empty() {
        let vecs: Vec<Vec<f32>> = vec![];
        let assignments = k_means(&vecs, 3, 42);
        assert!(assignments.is_empty());
    }

    #[test]
    fn test_compute_layout_deterministic() {
        let vectors = make_test_vectors(20, 16);
        let layout1 = compute_layout(&vectors, 42, 5, 0.1);
        let layout2 = compute_layout(&vectors, 42, 5, 0.1);
        assert_eq!(layout1.len(), layout2.len());
        for (a, b) in layout1.iter().zip(layout2.iter()) {
            assert_eq!(a.filename, b.filename);
            assert!((a.x - b.x).abs() < 1e-6);
            assert!((a.y - b.y).abs() < 1e-6);
        }
    }

    #[test]
    fn test_compute_layout_single() {
        let vectors = make_test_vectors(1, 8);
        let layout = compute_layout(&vectors, 42, 5, 0.1);
        assert_eq!(layout.len(), 1);
        assert_eq!(layout[0].x, 0.0);
        assert_eq!(layout[0].y, 0.0);
    }

    #[test]
    fn test_compute_layout_minimum() {
        let vectors = make_test_vectors(2, 8);
        let layout = compute_layout(&vectors, 42, 5, 0.1);
        assert_eq!(layout.len(), 2);
    }

    #[test]
    fn test_compute_clusters_basic() {
        let vectors = make_test_vectors(20, 16);
        let positions = compute_layout(&vectors, 42, 5, 0.1);
        let clusters = compute_clusters(&vectors, &positions, 42);
        assert!(!clusters.is_empty());
        // All filenames should appear in exactly one cluster
        let mut all_files: Vec<String> =
            clusters.iter().flat_map(|c| c.filenames.clone()).collect();
        all_files.sort();
        let mut expected: Vec<String> = vectors.iter().map(|v| v.filename.clone()).collect();
        expected.sort();
        assert_eq!(all_files, expected);
    }

    #[test]
    fn test_cluster_radius_minimum() {
        let vectors = make_test_vectors(5, 8);
        let positions = compute_layout(&vectors, 42, 3, 0.1);
        let clusters = compute_clusters(&vectors, &positions, 42);
        for c in &clusters {
            assert!(c.radius >= 48.0, "radius {} should be >= 48", c.radius);
        }
    }

    #[test]
    fn test_normalize_token() {
        assert_eq!(normalize_token("recipes"), Some("recipe".to_string()));
        assert_eq!(normalize_token("the"), None); // stopword
        assert_eq!(normalize_token("ab"), None); // too short
        assert_eq!(normalize_token("123"), None); // all digits
        assert_eq!(normalize_token("notes"), None); // low signal
    }

    #[test]
    fn test_title_case() {
        assert_eq!(title_case("hello world"), "Hello World");
        assert_eq!(title_case("foo-bar"), "Foo-Bar");
    }

    #[test]
    fn test_generate_cluster_label_fallback() {
        let filenames = vec!["a.md".to_string(), "b.md".to_string()];
        let label = generate_cluster_label(&filenames);
        assert_eq!(label, "Notes"); // single-char tokens filtered out
    }

    #[test]
    fn test_average_and_normalize() {
        let embs = vec![vec![3.0, 0.0], vec![0.0, 4.0]];
        let avg = average_and_normalize(&embs).unwrap();
        let norm: f32 = avg.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5);
    }

    fn make_test_vectors(n: usize, dims: usize) -> Vec<NoteVector> {
        let mut rng = ChaCha8Rng::seed_from_u64(12345);
        (0..n)
            .map(|i| {
                let mut emb: Vec<f32> = (0..dims).map(|_| rng.gen_range(-1.0..1.0)).collect();
                l2_normalize(&mut emb);
                NoteVector {
                    filename: format!("note{i}.md"),
                    embedding: emb,
                }
            })
            .collect()
    }
}
