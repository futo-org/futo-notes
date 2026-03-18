use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::core::{CoreState, VectorArtifacts, ensure_vectors_loaded, notes_root, task_join_err};

// Same seed used by the TypeScript graph layout code.
#[cfg(test)]
const GRAPH_LAYOUT_SEED: u32 = 0x51f1_5e77;

// ---------------------------------------------------------------------------
// Seeded PRNG – same LCG as the TypeScript `createSeededRandom`.
// ---------------------------------------------------------------------------

struct SeededRandom {
    state: u32,
}

impl SeededRandom {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    fn next_f32(&mut self) -> f32 {
        self.state = self.state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        self.state as f32 / 4_294_967_296.0
    }
}

// ---------------------------------------------------------------------------
// Cluster-count heuristic – exact port of the TS `determineClusterCount`.
// ---------------------------------------------------------------------------

pub(crate) fn determine_cluster_count(note_count: usize) -> usize {
    if note_count < 12 {
        return 3.max(note_count.min(4));
    }
    let lower_bound: usize = if note_count >= 400 { 6 } else { 3 };
    let hard_upper_bound: usize = if note_count >= 1500 {
        8
    } else if note_count >= 700 {
        8
    } else {
        12
    };
    let upper_bound = hard_upper_bound.min(lower_bound.max(note_count / 12));
    let suggested = ((note_count as f64).sqrt() / 3.0).round() as usize;
    lower_bound.max(suggested.min(upper_bound))
}

// ---------------------------------------------------------------------------
// Vector helpers.
// ---------------------------------------------------------------------------

fn squared_distance(a: &[f32], b: &[f32]) -> f32 {
    let dims = a.len().min(b.len());
    let mut total = 0.0f32;
    for i in 0..dims {
        let delta = a[i] - b[i];
        total += delta * delta;
    }
    total
}

fn average_vector(vectors: &[Vec<f32>], indices: &[usize], dims: usize) -> Vec<f32> {
    let mut avg = vec![0.0f32; dims];
    if indices.is_empty() {
        return avg;
    }
    for &idx in indices {
        let vector = &vectors[idx];
        for i in 0..dims {
            avg[i] += vector[i];
        }
    }
    let count = indices.len() as f32;
    for val in avg.iter_mut() {
        *val /= count;
    }
    avg
}

// ---------------------------------------------------------------------------
// K-Means with farthest-point initialization (exact port of TS `kMeans`).
// ---------------------------------------------------------------------------

fn k_means(vectors: &[Vec<f32>], cluster_count: usize, seed: u32) -> Vec<usize> {
    let n = vectors.len();
    if n == 0 || cluster_count == 0 {
        return vec![0; n];
    }
    let dims = vectors.first().map_or(0, |v| v.len());
    let mut rng = SeededRandom::new(seed ^ (n as u32));
    let mut centroids: Vec<Vec<f32>> = Vec::with_capacity(cluster_count);

    // Pick the first centroid randomly.
    let mut next_index = (rng.next_f32() * n as f32) as usize;
    if next_index >= n {
        next_index = n - 1;
    }
    centroids.push(vectors[next_index].clone());

    // Farthest-point initialization for remaining centroids.
    while centroids.len() < cluster_count {
        let mut farthest_index: usize = 0;
        let mut farthest_distance: f32 = -1.0;
        for i in 0..n {
            let mut nearest = f32::INFINITY;
            for centroid in &centroids {
                nearest = nearest.min(squared_distance(&vectors[i], centroid));
            }
            if nearest > farthest_distance {
                farthest_distance = nearest;
                farthest_index = i;
            }
        }
        centroids.push(vectors[farthest_index].clone());
    }

    // Lloyd's iteration (max 24 rounds).
    let mut assignments = vec![0usize; n];
    for _iter in 0..24 {
        let mut changed = false;

        // Assignment step.
        for i in 0..n {
            let mut best_index: usize = 0;
            let mut best_distance = f32::INFINITY;
            for (c, centroid) in centroids.iter().enumerate() {
                let distance = squared_distance(&vectors[i], centroid);
                if distance < best_distance {
                    best_distance = distance;
                    best_index = c;
                }
            }
            if assignments[i] != best_index {
                assignments[i] = best_index;
                changed = true;
            }
        }

        // Build buckets.
        let mut buckets: HashMap<usize, Vec<usize>> = HashMap::new();
        for (i, &a) in assignments.iter().enumerate() {
            buckets.entry(a).or_default().push(i);
        }

        // Update centroids.
        for c in 0..centroids.len() {
            match buckets.get(&c) {
                Some(indices) if !indices.is_empty() => {
                    centroids[c] = average_vector(vectors, indices, dims);
                }
                _ => {
                    // Empty cluster — reinitialise with a random point.
                    next_index = (rng.next_f32() * n as f32) as usize;
                    if next_index >= n {
                        next_index = n - 1;
                    }
                    centroids[c] = vectors[next_index].clone();
                }
            }
        }

        if !changed {
            break;
        }
    }

    assignments
}

// ---------------------------------------------------------------------------
// Serde types for the Tauri command boundary.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphClustersInput {
    uuids: Vec<String>,
    seed: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphClustersOutput {
    assignments: Vec<ClusterAssignment>,
    cluster_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterAssignment {
    uuid: String,
    cluster_index: usize,
}

// ---------------------------------------------------------------------------
// The `_impl` function – unit-tested directly.
// ---------------------------------------------------------------------------

pub(crate) fn graph_compute_clusters_impl(
    artifacts: &VectorArtifacts,
    input: &GraphClustersInput,
) -> Result<GraphClustersOutput, String> {
    let dims = artifacts.dims;

    // Build per-UUID averaged + L2-normalised vectors (same logic as
    // `supersearch_all_note_vectors` in core.rs).
    let mut by_uuid: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, chunk) in artifacts.chunks.iter().enumerate() {
        by_uuid.entry(&chunk.uuid).or_default().push(i);
    }

    let requested: std::collections::HashSet<&str> =
        input.uuids.iter().map(|s| s.as_str()).collect();

    // Collect note vectors in the order of `input.uuids` so the caller gets
    // deterministic ordering that matches their request.
    let mut note_vectors: Vec<Vec<f32>> = Vec::with_capacity(input.uuids.len());
    let mut uuid_order: Vec<&str> = Vec::with_capacity(input.uuids.len());

    for uuid in &input.uuids {
        let indices = match by_uuid.get(uuid.as_str()) {
            Some(idx) => idx,
            None => continue, // UUID not present in artifacts — skip.
        };
        if !requested.contains(uuid.as_str()) {
            continue;
        }

        let mut avg = vec![0.0f32; dims];
        for &idx in indices {
            let offset = idx * dims;
            for (j, val) in avg.iter_mut().enumerate() {
                *val += artifacts.vectors[offset + j];
            }
        }
        let count = indices.len() as f32;
        for val in avg.iter_mut() {
            *val /= count;
        }
        let norm: f32 = avg.iter().map(|v| v * v).sum::<f32>().sqrt();
        if norm > 0.0 {
            for val in avg.iter_mut() {
                *val /= norm;
            }
        }

        note_vectors.push(avg);
        uuid_order.push(uuid);
    }

    if note_vectors.is_empty() {
        return Ok(GraphClustersOutput {
            assignments: Vec::new(),
            cluster_count: 0,
        });
    }

    let cluster_count = determine_cluster_count(note_vectors.len());
    let effective_k = cluster_count.min(note_vectors.len());
    let raw_assignments = k_means(&note_vectors, effective_k, input.seed);

    let assignments = uuid_order
        .iter()
        .zip(raw_assignments.iter())
        .map(|(&uuid, &cluster_index)| ClusterAssignment {
            uuid: uuid.to_string(),
            cluster_index,
        })
        .collect();

    Ok(GraphClustersOutput {
        assignments,
        cluster_count: effective_k,
    })
}

// ---------------------------------------------------------------------------
// Tauri command.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn graph_compute_clusters(
    app: AppHandle,
    state: State<'_, CoreState>,
    input: GraphClustersInput,
) -> Result<GraphClustersOutput, String> {
    let vectors_state = state.vectors.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let base = notes_root(&app)?;
        let artifacts = ensure_vectors_loaded(&base, &vectors_state)?;
        graph_compute_clusters_impl(&artifacts, &input)
    })
    .await
    .map_err(task_join_err)?
}

// ---------------------------------------------------------------------------
// Unit tests.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ManifestChunk;

    /// Helper: build `VectorArtifacts` from a list of (uuid, vector) pairs.
    fn make_artifacts(entries: &[(&str, Vec<f32>)]) -> VectorArtifacts {
        let dims = entries.first().map_or(0, |(_, v)| v.len());
        let mut chunks = Vec::new();
        let mut vectors = Vec::new();
        for (i, (uuid, vec)) in entries.iter().enumerate() {
            chunks.push(ManifestChunk {
                chunk_id: i as i64,
                uuid: uuid.to_string(),
                chunk_text: String::new(),
                start_offset: 0,
                end_offset: 0,
            });
            vectors.extend_from_slice(vec);
        }
        VectorArtifacts { dims, chunks, vectors }
    }

    /// Normalise a vector to unit length.
    fn l2_normalize(v: &mut Vec<f32>) {
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for x in v.iter_mut() {
                *x /= norm;
            }
        }
    }

    // 1. Determinism: same input ⇒ identical output.
    #[test]
    fn determinism() {
        let mut entries: Vec<(&str, Vec<f32>)> = Vec::new();
        for i in 0..20 {
            let mut v = vec![0.0f32; 8];
            v[i % 8] = 1.0;
            v[(i + 1) % 8] = 0.5;
            entries.push(("", v));
        }
        // Assign distinct UUIDs.
        let uuids: Vec<String> = (0..20).map(|i| format!("uuid-{i}")).collect();
        let entries_with_uuid: Vec<(&str, Vec<f32>)> = uuids
            .iter()
            .zip(entries.iter())
            .map(|(u, (_, v))| (u.as_str(), v.clone()))
            .collect();
        let artifacts = make_artifacts(&entries_with_uuid);
        let input = GraphClustersInput {
            uuids: uuids.clone(),
            seed: GRAPH_LAYOUT_SEED,
        };

        let result1 = graph_compute_clusters_impl(&artifacts, &input).unwrap();
        let result2 = graph_compute_clusters_impl(&artifacts, &input).unwrap();

        assert_eq!(result1.cluster_count, result2.cluster_count);
        assert_eq!(result1.assignments.len(), result2.assignments.len());
        for (a, b) in result1.assignments.iter().zip(result2.assignments.iter()) {
            assert_eq!(a.uuid, b.uuid);
            assert_eq!(a.cluster_index, b.cluster_index);
        }
    }

    // 2. `determine_cluster_count` matches TypeScript for known inputs.
    #[test]
    fn cluster_count_matches_ts() {
        assert_eq!(determine_cluster_count(5), 4);
        assert_eq!(determine_cluster_count(10), 4);
        assert_eq!(determine_cluster_count(12), 3);
        assert_eq!(determine_cluster_count(50), 3);
        assert_eq!(determine_cluster_count(100), 3);
        assert_eq!(determine_cluster_count(200), 5);
        assert_eq!(determine_cluster_count(400), 7);
        assert_eq!(determine_cluster_count(700), 8);
        assert_eq!(determine_cluster_count(1500), 8);
    }

    // 3. Separation: three well-separated groups → three distinct clusters.
    #[test]
    fn separation() {
        let dims = 8;
        let mut entries: Vec<(&str, Vec<f32>)> = Vec::new();
        let uuids: Vec<String> = (0..30).map(|i| format!("uuid-{i}")).collect();

        for i in 0..30 {
            let mut v = vec![0.0f32; dims];
            let group = i / 10;
            // Place vectors far apart along different axes.
            v[group * 2] = 10.0;
            v[group * 2 + 1] = 10.0;
            // Add a small per-point variation.
            v[7] = (i as f32) * 0.01;
            l2_normalize(&mut v);
            entries.push((uuids[i].as_str(), v));
        }

        let artifacts = make_artifacts(&entries);
        let input = GraphClustersInput {
            uuids: uuids.clone(),
            seed: GRAPH_LAYOUT_SEED,
        };

        let result = graph_compute_clusters_impl(&artifacts, &input).unwrap();
        assert_eq!(result.assignments.len(), 30);

        // Every member of a group should share the same cluster.
        let group0: Vec<usize> = result.assignments[0..10]
            .iter()
            .map(|a| a.cluster_index)
            .collect();
        let group1: Vec<usize> = result.assignments[10..20]
            .iter()
            .map(|a| a.cluster_index)
            .collect();
        let group2: Vec<usize> = result.assignments[20..30]
            .iter()
            .map(|a| a.cluster_index)
            .collect();

        // All within a group identical.
        assert!(group0.iter().all(|&c| c == group0[0]), "group 0 not uniform");
        assert!(group1.iter().all(|&c| c == group1[0]), "group 1 not uniform");
        assert!(group2.iter().all(|&c| c == group2[0]), "group 2 not uniform");

        // Groups are distinct.
        assert_ne!(group0[0], group1[0], "group 0 and 1 same cluster");
        assert_ne!(group0[0], group2[0], "group 0 and 2 same cluster");
        assert_ne!(group1[0], group2[0], "group 1 and 2 same cluster");
    }

    // 4. Edge cases: 2 and 3 notes.
    #[test]
    fn edge_case_two_notes() {
        let uuids = vec!["a".to_string(), "b".to_string()];
        let mut va = vec![1.0f32, 0.0, 0.0, 0.0];
        let mut vb = vec![0.0f32, 1.0, 0.0, 0.0];
        l2_normalize(&mut va);
        l2_normalize(&mut vb);
        let artifacts = make_artifacts(&[("a", va), ("b", vb)]);
        let input = GraphClustersInput {
            uuids,
            seed: GRAPH_LAYOUT_SEED,
        };
        let result = graph_compute_clusters_impl(&artifacts, &input).unwrap();
        assert_eq!(result.assignments.len(), 2);
        // With 2 notes, cluster_count = max(3, min(2, 4)) = 3, but
        // effective_k = min(3, 2) = 2 so we should get at most 2 clusters.
        assert!(result.cluster_count <= 2);
    }

    #[test]
    fn edge_case_three_notes() {
        let uuids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let mut va = vec![1.0f32, 0.0, 0.0, 0.0];
        let mut vb = vec![0.0f32, 1.0, 0.0, 0.0];
        let mut vc = vec![0.0f32, 0.0, 1.0, 0.0];
        l2_normalize(&mut va);
        l2_normalize(&mut vb);
        l2_normalize(&mut vc);
        let artifacts = make_artifacts(&[("a", va), ("b", vb), ("c", vc)]);
        let input = GraphClustersInput {
            uuids,
            seed: GRAPH_LAYOUT_SEED,
        };
        let result = graph_compute_clusters_impl(&artifacts, &input).unwrap();
        assert_eq!(result.assignments.len(), 3);
        assert!(result.cluster_count <= 3);
    }

    // 5. Verify the seeded PRNG matches TypeScript output.
    #[test]
    fn seeded_random_matches_ts() {
        // TypeScript: state = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        // With seed = 0, first state = 1013904223, value = 1013904223 / 4294967296
        let mut rng = SeededRandom::new(0);
        let v1 = rng.next_f32();
        let expected = 1_013_904_223.0f32 / 4_294_967_296.0;
        assert!((v1 - expected).abs() < 1e-7, "first value mismatch: {v1} vs {expected}");
    }
}
