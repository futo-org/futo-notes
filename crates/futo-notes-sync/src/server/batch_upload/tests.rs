use super::*;

#[test]
fn upload_batch_frames_encode_the_frozen_wire_contract() {
    let create_id = "01890000-0000-7000-8000-00000000a001";
    let entries = vec![
        BatchWriteEntry {
            operation: BatchWriteOperation::Create {
                mutation_id: create_id.into(),
            },
            ciphertext: vec![0xaa, 0xbb],
        },
        BatchWriteEntry {
            operation: BatchWriteOperation::Update {
                object_id: "oid".into(),
                version: 7,
            },
            ciphertext: vec![0xcc],
        },
    ];
    let mut expected = vec![0, 0, 36];
    expected.extend_from_slice(create_id.as_bytes());
    expected.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 2, 0xaa, 0xbb]);
    expected.extend_from_slice(&[1, 0, 3, b'o', b'i', b'd', 0, 0, 0, 7, 0, 0, 0, 1, 0xcc]);
    assert_eq!(encode_batch_write_frames(&entries).unwrap(), expected);
    assert_eq!(
        entries
            .iter()
            .map(|entry| {
                let identifier = match &entry.operation {
                    BatchWriteOperation::Create { mutation_id } => mutation_id,
                    BatchWriteOperation::Update { object_id, .. } => object_id,
                };
                batch_write_frame_size(identifier, entry.ciphertext.len()).unwrap()
            })
            .sum::<u64>(),
        expected.len() as u64
    );
}

fn all_statuses_body() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "results": [
            {"status":"created","object":{"id":"o1","version":1,"change_seq":2,"blob_key":"b1"},"collectionVersion":2},
            {"status":"replayed","object":{"id":"o-replay","version":1,"change_seq":2,"blob_key":"b-replay"},"collectionVersion":2},
            {"status":"updated","object":{"id":"o2","version":"3","change_seq":"4","blob_key":"b2"},"collectionVersion":"4"},
            {"status":"conflict","currentVersion":5,"currentBlobKey":"b3"},
            {"status":"not_found"},
            {"status":"too_large"},
            {"status":"error","error":"database unavailable"}
        ]
    }))
    .unwrap()
}

fn all_statuses_entries() -> Vec<BatchWriteEntry> {
    vec![
        BatchWriteEntry {
            operation: BatchWriteOperation::Create {
                mutation_id: "create-mutation".into(),
            },
            ciphertext: vec![1],
        },
        BatchWriteEntry {
            operation: BatchWriteOperation::Create {
                mutation_id: "replay-mutation".into(),
            },
            ciphertext: vec![1],
        },
        BatchWriteEntry {
            operation: BatchWriteOperation::Update {
                object_id: "o2".into(),
                version: 3,
            },
            ciphertext: vec![1],
        },
        BatchWriteEntry {
            operation: BatchWriteOperation::Update {
                object_id: "o3".into(),
                version: 3,
            },
            ciphertext: vec![1],
        },
        BatchWriteEntry {
            operation: BatchWriteOperation::Update {
                object_id: "o4".into(),
                version: 3,
            },
            ciphertext: vec![1],
        },
        BatchWriteEntry {
            operation: BatchWriteOperation::Update {
                object_id: "o5".into(),
                version: 3,
            },
            ciphertext: vec![1],
        },
        BatchWriteEntry {
            operation: BatchWriteOperation::Update {
                object_id: "o6".into(),
                version: 3,
            },
            ciphertext: vec![1],
        },
    ]
}

#[test]
fn results_map_every_entry_status() {
    let body = all_statuses_body();
    let entries = all_statuses_entries();
    let results = parse_batch_write_results(&body, &entries).unwrap();

    assert!(matches!(
        &results[0],
        BatchMutation::Created(write)
            if write.object.id == "o1"
                && write.collection_version == 2
    ));
    assert!(matches!(
        &results[1],
        BatchMutation::Replayed(write)
            if write.object.id == "o-replay"
    ));
    assert!(matches!(
        &results[2],
        BatchMutation::Updated(write)
            if write.object.id == "o2"
                && write.collection_version == 4
    ));
    assert!(matches!(
        &results[3],
        BatchMutation::Conflict(conflict)
            if conflict.current_version == 5
    ));
    assert!(matches!(results[4], BatchMutation::NotFound));
    assert!(matches!(results[5], BatchMutation::TooLarge));
    assert!(matches!(
        &results[6],
        BatchMutation::Error(error)
            if error == "database unavailable"
    ));
    assert!(parse_batch_write_results(&body, &entries[..entries.len() - 1]).is_err());
}

fn entry(operation: BatchWriteOperation) -> BatchWriteEntry {
    BatchWriteEntry {
        operation,
        ciphertext: vec![1],
    }
}

fn object(id: &str) -> Object {
    Object {
        id: id.into(),
        version: 1,
        change_seq: 1,
        deleted: false,
        blob_key: Some("blob".into()),
        size_bytes: Some(1),
        updated_at: String::new(),
    }
}

fn created(id: &str) -> BatchWriteResultBody {
    BatchWriteResultBody::Created {
        object: object(id),
        collection_version: 1,
    }
}

fn replayed(id: &str) -> BatchWriteResultBody {
    BatchWriteResultBody::Replayed {
        object: object(id),
        collection_version: 1,
    }
}

fn updated(id: &str) -> BatchWriteResultBody {
    BatchWriteResultBody::Updated {
        object: object(id),
        collection_version: 1,
    }
}

#[test]
fn validation_accepts_each_status_allowed_for_the_operation() {
    let create = entry(BatchWriteOperation::Create {
        mutation_id: "mutation".into(),
    });
    for result in [
        created("expected"),
        replayed("expected"),
        BatchWriteResultBody::TooLarge,
        BatchWriteResultBody::Error {
            error: "unavailable".into(),
        },
    ] {
        assert!(validate_batch_write_result(0, &result, &create).is_ok());
    }

    let update = entry(BatchWriteOperation::Update {
        object_id: "expected".into(),
        version: 2,
    });
    for result in [
        updated("expected"),
        BatchWriteResultBody::Conflict {
            current_version: 1,
            current_blob_key: Some("blob".into()),
        },
        BatchWriteResultBody::NotFound,
        BatchWriteResultBody::TooLarge,
        BatchWriteResultBody::Error {
            error: "unavailable".into(),
        },
    ] {
        assert!(validate_batch_write_result(0, &result, &update).is_ok());
    }
}

#[test]
fn validation_rejects_each_status_incompatible_with_the_operation() {
    let create = entry(BatchWriteOperation::Create {
        mutation_id: "mutation".into(),
    });
    for result in [
        updated("expected"),
        BatchWriteResultBody::Conflict {
            current_version: 1,
            current_blob_key: Some("blob".into()),
        },
        BatchWriteResultBody::NotFound,
    ] {
        assert!(validate_batch_write_result(0, &result, &create).is_err());
    }

    let update = entry(BatchWriteOperation::Update {
        object_id: "expected".into(),
        version: 2,
    });
    for result in [created("expected"), replayed("expected")] {
        assert!(validate_batch_write_result(0, &result, &update).is_err());
    }
}

#[test]
fn validation_accepts_server_generated_create_ids_but_rejects_wrong_update_ids() {
    let create = entry(BatchWriteOperation::Create {
        mutation_id: "mutation".into(),
    });
    let update = entry(BatchWriteOperation::Update {
        object_id: "expected".into(),
        version: 2,
    });

    assert!(validate_batch_write_result(3, &created("server-generated"), &create).is_ok());
    let update_error = validate_batch_write_result(4, &updated("other"), &update).unwrap_err();
    assert_eq!(
        update_error.message,
        "batch upload result 4: expected object expected, got other"
    );
}

#[test]
fn parsing_rejects_an_incompatible_status() {
    let create = BatchWriteEntry {
        operation: BatchWriteOperation::Create {
            mutation_id: "mutation".into(),
        },
        ciphertext: vec![1],
    };
    let updated = serde_json::to_vec(&serde_json::json!({
        "results": [{
            "status":"updated",
            "object":{
                "id":"expected",
                "version":2,
                "change_seq":1,
                "blob_key":"b1"
            },
            "collectionVersion":1
        }]
    }))
    .unwrap();
    assert!(parse_batch_write_results(&updated, &[create]).is_err());
}
