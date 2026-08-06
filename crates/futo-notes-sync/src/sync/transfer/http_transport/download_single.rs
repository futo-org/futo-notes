use std::collections::{HashMap, HashSet, VecDeque};

use tokio::task::JoinSet;

use crate::server::{Http, Object};

use super::download_failure;
use crate::sync::encrypted_note::decrypt;
use crate::sync::transfer::DownloadedObject;
use crate::sync::SyncErrorKind;

const SINGLE_CONCURRENCY: usize = 8;

fn spawn_single(
    tasks: &mut JoinSet<DownloadedObject>,
    spawned: &mut HashMap<tokio::task::Id, Object>,
    http: &Http,
    key: &[u8; 32],
    singles: &mut VecDeque<Object>,
) {
    let object = singles.pop_front().expect("single queue checked");
    let task_http = http.clone();
    let task_key = *key;
    let panic_object = object.clone();
    let handle = tasks.spawn(async move {
        let result = decrypt(&task_http, &task_key, &object).await;
        (object, result)
    });
    spawned.insert(handle.id(), panic_object);
}

fn fill_single_slots(
    tasks: &mut JoinSet<DownloadedObject>,
    spawned: &mut HashMap<tokio::task::Id, Object>,
    http: &Http,
    key: &[u8; 32],
    singles: &mut VecDeque<Object>,
) {
    while tasks.len() < SINGLE_CONCURRENCY && !singles.is_empty() {
        spawn_single(tasks, spawned, http, key, singles);
    }
}

fn collect_single_task_result(
    joined: Result<(tokio::task::Id, DownloadedObject), tokio::task::JoinError>,
    spawned: &mut HashMap<tokio::task::Id, Object>,
) -> Vec<DownloadedObject> {
    match joined {
        Ok((id, downloaded)) => {
            spawned.remove(&id);
            vec![downloaded]
        }
        Err(error) => spawned
            .remove(&error.id())
            .map(|object| download_failure(object, None))
            .into_iter()
            .collect(),
    }
}

pub(in crate::sync::transfer) async fn run_single_downloads<F>(
    http: &Http,
    key: &[u8; 32],
    singles: Vec<Object>,
    mut scheduled: HashSet<String>,
    complete: &mut F,
) -> Result<(), SyncErrorKind>
where
    F: FnMut(Vec<DownloadedObject>) -> Result<(), SyncErrorKind>,
{
    let mut singles = singles
        .into_iter()
        .filter(|object| scheduled.insert(object.id.clone()))
        .collect::<VecDeque<_>>();
    let mut tasks = JoinSet::new();
    let mut spawned = HashMap::new();
    fill_single_slots(&mut tasks, &mut spawned, http, key, &mut singles);
    while let Some(joined) = tasks.join_next_with_id().await {
        let completed = collect_single_task_result(joined, &mut spawned);
        if !completed.is_empty() {
            complete(completed)?;
        }
        fill_single_slots(&mut tasks, &mut spawned, http, key, &mut singles);
    }
    Ok(())
}
