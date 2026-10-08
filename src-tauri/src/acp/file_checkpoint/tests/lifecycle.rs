use super::*;

#[tokio::test]
async fn canceled_capture_waits_for_late_background_work_before_publishing() {
    let f = Fixture::new();
    f.write("a", b"before");
    let mut pending = Some(start(&f, "session", 0));
    let activity =
        crate::acp::file_checkpoint_activity::TurnActivity::begin(&f.store.root).unwrap();
    let state = std::sync::Arc::new(tokio::sync::RwLock::new(crate::acp::SessionState::new(
        "fixture".into(),
        AgentType::Codex,
        Some(f.store.root.clone()),
        "fixture".into(),
        None,
    )));
    state.write().await.status = crate::acp::types::ConnectionStatus::Connected;
    let changed = state.clone();
    let path = f.store.root.join("a");
    let native = async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        {
            let mut state = changed.write().await;
            state.background_outstanding = 1;
            state.event_seq += 1;
        }
        tokio::time::sleep(Duration::from_millis(1100)).await;
        fs::write(path, b"after native command settles").unwrap();
        {
            let mut state = changed.write().await;
            state.background_outstanding = 0;
            state.event_seq += 1;
        }
    };
    let finish =
        crate::acp::connection::finish_canceled_checkpoint(&mut pending, Some(&activity), &state);
    tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(finish, native);
    })
    .await
    .unwrap();
    assert!(pending.is_none());
    drop(activity);
    let plan = f.plan(1).unwrap();
    assert!(plan.preview.conflicts.is_empty());
    assert_eq!(plan.preview.files.len(), 1);
    let mut restore = f.prepare(1);
    restore.apply().unwrap();
    assert_eq!(f.read("a"), b"before");
}
use crate::acp::file_checkpoint::storage::ObjectBudget;
use crate::acp::file_checkpoint::workspace::{Entry, Snapshot};
use std::collections::HashSet;
use std::io::{Seek, SeekFrom};

// Correctness tests do not assert machine speed. Only the deliberate zero-budget
// cases below depend on a deadline expiring.
fn control() -> CaptureControl {
    CaptureControl::with_budget(Duration::from_secs(300))
}

fn start(f: &Fixture, session: &str, index: usize) -> PendingCheckpoint {
    begin_controlled(
        f.store.clone(),
        AgentType::Codex,
        session,
        index,
        &[PromptInputBlock::Text {
            text: "prompt".into(),
        }],
        control(),
    )
    .unwrap()
}

async fn finish(pending: PendingCheckpoint) {
    finish_turn_guarded_controlled(pending, control(), |publish| publish())
        .await
        .unwrap();
}

fn object(f: &Fixture, bytes: &[u8]) -> String {
    f.store.put_object(bytes, &mut None).unwrap()
}

// Retention fixtures use real immutable objects and durable metadata, but avoid
// hundreds of workspace walks. Repeated references exercise actual ref counts.
fn completed(f: &Fixture, session: &str, index: usize, ids: &[String], finished: i64) -> Record {
    let mut record = Record::new(AgentType::Codex, session, index);
    record.prompt = prompt_fingerprint(
        AgentType::Codex,
        &[PromptInputBlock::Text {
            text: "prompt".into(),
        }],
    )
    .unwrap();
    record.started_ms = finished;
    record.finished_ms = Some(finished);
    let snapshot = Snapshot {
        scope: "retention-fixture".into(),
        files: ids
            .iter()
            .enumerate()
            .map(|(i, id)| {
                (
                    format!("file-{i}"),
                    Entry {
                        object: id.clone(),
                        mode: 0,
                    },
                )
            })
            .collect(),
    };
    record.before = Some(snapshot.clone());
    record.after = Some(snapshot);
    f.store.write_record(&record).unwrap();
    record
}

fn sweep(f: &Fixture) -> u64 {
    let _guard = f.store.lock().unwrap();
    f.store.collect(None, &HashSet::new(), 0, None).unwrap()
}

fn object_ids(f: &Fixture) -> HashSet<String> {
    fs::read_dir(f.store.dir.join("objects"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect()
}

fn journal(f: &Fixture, original: &str, desired: &str, committed: bool) {
    f.store
        .write_json(
            &f.store.journal_path(),
            &serde_json::json!({
                "version": 1,
                "committed": committed,
                "root": f.store.root,
                "attempted": 0,
                "changes": [{
                    "path": "file",
                    "original": { "object": original, "mode": 0 },
                    "desired": { "object": desired, "mode": 0 }
                }]
            }),
        )
        .unwrap();
}

#[test]
fn configuration_defaults_off_persists_and_disabling_preserves_coverage() {
    let f = Fixture::new();
    fs::remove_file(f.store.dir.join("settings.json")).unwrap();
    assert!(!f.store.settings().unwrap().enabled);
    f.write("a", b"uncaptured");
    let error = begin_controlled(
        f.store.clone(),
        AgentType::Codex,
        "session",
        0,
        &[],
        control(),
    )
    .unwrap_err();
    assert!(error.contains("disabled"), "{error}");
    assert!(f.store.records(None).unwrap().is_empty());
    assert!(object_ids(&f).is_empty());
    assert!(f.store.lock().is_ok());

    let id = object(&f, b"retained");
    completed(
        &f,
        "session",
        0,
        &[id.clone()],
        chrono::Utc::now().timestamp_millis(),
    );
    f.store.set_enabled(true).unwrap();
    let reopened = Store::at(&f.store.root, &f._dir.path().join("data")).unwrap();
    assert!(reopened.settings().unwrap().enabled);
    reopened.set_enabled(false).unwrap();
    let status = f.store.status().unwrap();
    assert!(!status.enabled);
    assert_eq!(status.record_count, 1);
    assert_eq!(status.object_bytes, 8);
    assert_eq!(status.max_records, 201);
    assert_eq!(status.max_object_bytes, 512 * 1024 * 1024);
    assert_eq!(f.store.object(&id).unwrap(), b"retained");
}

#[test]
fn gc_keeps_shared_objects_until_the_last_retained_reference_is_removed() {
    let f = Fixture::new();
    let now = chrono::Utc::now().timestamp_millis();
    let old = now - chrono::Duration::days(31).num_milliseconds();
    let shared = object(&f, b"shared");
    let expired_only = object(&f, b"expired");
    let live_only = object(&f, b"live");
    let expired = completed(
        &f,
        "parent",
        0,
        &[shared.clone(), shared.clone(), expired_only.clone()],
        old,
    );
    let mut live = completed(&f, "child", 0, &[shared.clone(), live_only.clone()], now);
    assert_eq!(sweep(&f), 10);
    assert!(!f.store.record_path(&expired).exists());
    assert_eq!(object_ids(&f), HashSet::from([shared.clone(), live_only]));
    assert_eq!(f.store.object(&shared).unwrap(), b"shared");
    live.finished_ms = Some(old);
    f.store.write_record(&live).unwrap();
    assert_eq!(sweep(&f), 0);
    assert!(object_ids(&f).is_empty());
}

#[test]
fn gc_applies_age_and_newest_100_limits_across_sessions() {
    let f = Fixture::new();
    let now = chrono::Utc::now().timestamp_millis();
    let shared = object(&f, b"shared");
    let expired = completed(
        &f,
        "expired",
        0,
        &[shared.clone()],
        now - chrono::Duration::days(31).num_milliseconds(),
    );
    let recent = completed(
        &f,
        "recent",
        0,
        &[shared.clone()],
        now - chrono::Duration::days(29).num_milliseconds(),
    );
    assert_eq!(sweep(&f), 6);
    assert!(!f.store.record_path(&expired).exists());
    assert!(f.store.record_path(&recent).exists());
    for index in 0..105 {
        completed(
            &f,
            if index % 2 == 0 { "parent" } else { "child" },
            index,
            &[shared.clone()],
            now - 1000 + index as i64,
        );
    }
    assert_eq!(sweep(&f), 6);
    let records = f.store.records(None).unwrap();
    assert_eq!(records.len(), 100);
    let mut indexes: Vec<_> = records.iter().map(|(_, r)| r.user_index).collect();
    indexes.sort_unstable();
    assert_eq!(indexes, (5..105).collect::<Vec<_>>());
    assert!(!f.store.record_path(&recent).exists());
    assert_eq!(sweep(&f), 6);
}

#[test]
fn gc_reclaims_dropped_captures_orphans_and_atomic_write_temporary_files() {
    let f = Fixture::new();
    let live = object(&f, b"live");
    completed(
        &f,
        "other",
        0,
        &[live.clone()],
        chrono::Utc::now().timestamp_millis(),
    );
    f.write("a", b"abandoned");
    let pending = start(&f, "session", 0);
    let path = f.store.record_path(&pending.record);
    let abandoned = pending.record.before.as_ref().unwrap().files["a"]
        .object
        .clone();
    drop(pending);
    object(&f, b"orphan after failed capture");
    let metadata_temp = f.store.dir.join("records/.tmp-interrupted");
    fs::write(&metadata_temp, b"partial metadata").unwrap();
    fs::write(
        f.store.dir.join("objects/.tmp-interrupted"),
        b"partial object",
    )
    .unwrap();
    assert_eq!(sweep(&f), 4);
    assert!(!path.exists());
    assert!(!metadata_temp.exists());
    assert!(f.store.object(&abandoned).is_err());
    assert_eq!(object_ids(&f), HashSet::from([live]));
    assert_eq!(f.read("a"), b"abandoned");
}

#[test]
fn quota_pressure_evicts_oldest_records_until_unique_bytes_fit() {
    let mut f = Fixture::new();
    let now = chrono::Utc::now().timestamp_millis();
    let shared = object(&f, b"same");
    let oldest_only = object(&f, b"old!");
    let newest_only = object(&f, b"new!");
    let oldest = completed(&f, "session", 0, &[shared.clone(), oldest_only], now - 2);
    let middle = completed(&f, "session", 1, &[shared.clone(), shared.clone()], now - 1);
    let newest = completed(&f, "session", 2, &[newest_only.clone()], now);
    f.store.object_limit = Some(8);
    let _guard = f.store.lock().unwrap();
    let mut budget = ObjectBudget::default();
    let fresh = storage::hash(b"next");
    f.store
        .put_object_controlled(b"next", &fresh, &mut budget, &control())
        .unwrap();
    assert_eq!(budget.bytes, Some(8));
    assert!(!f.store.record_path(&oldest).exists());
    // Removing the oldest alone cannot free the still-shared object.
    assert!(!f.store.record_path(&middle).exists());
    assert!(f.store.record_path(&newest).exists());
    assert_eq!(object_ids(&f), HashSet::from([newest_only, fresh]));
    assert_eq!(f.store.status().unwrap().object_bytes, 8);
}

#[test]
fn deduplicated_scan_objects_are_pinned_before_quota_gc_evicts_their_record() {
    let mut f = Fixture::new();
    let shared = object(&f, b"same");
    let old = completed(
        &f,
        "session",
        0,
        &[shared.clone()],
        chrono::Utc::now().timestamp_millis(),
    );
    f.store.object_limit = Some(8);
    let _guard = f.store.lock().unwrap();
    let mut budget = ObjectBudget::default();
    let control = control();
    f.store
        .put_object_controlled(b"same", &shared, &mut budget, &control)
        .unwrap();
    let second = storage::hash(b"next");
    f.store
        .put_object_controlled(b"next", &second, &mut budget, &control)
        .unwrap();
    let error = f
        .store
        .put_object_controlled(b"more", &storage::hash(b"more"), &mut budget, &control)
        .unwrap_err();
    assert!(error.contains("protected coverage"), "{error}");
    assert!(!f.store.record_path(&old).exists());
    assert_eq!(object_ids(&f), HashSet::from([shared.clone(), second]));
    assert_eq!(f.store.object(&shared).unwrap(), b"same");
}

#[tokio::test]
async fn pending_baseline_survives_quota_failure_then_is_reclaimed_after_drop() {
    let mut f = Fixture::new();
    f.store.object_limit = Some(8);
    f.write("a", b"base");
    let pending = start(&f, "session", 0);
    let path = f.store.record_path(&pending.record);
    f.write("a", b"too-large");
    let error = finish_turn_guarded_controlled(pending, control(), |publish| publish())
        .await
        .unwrap_err();
    assert!(error.contains("protected coverage"), "{error}");
    let record: Record = f.store.read_json(&path).unwrap();
    assert!(record.after.is_none());
    assert!(record.finished_ms.is_none());
    assert_eq!(
        f.store
            .object(&record.before.unwrap().files["a"].object)
            .unwrap(),
        b"base"
    );
    assert_eq!(f.read("a"), b"too-large");
    assert_eq!(
        f.store.status().unwrap().last_error.as_deref(),
        Some(error.as_str())
    );
    assert_eq!(sweep(&f), 0);
    assert!(!path.exists());
    assert!(object_ids(&f).is_empty());
}

#[test]
fn pending_record_and_scan_pins_survive_expiration_and_quota_pressure() {
    let mut f = Fixture::new();
    let baseline = object(&f, b"base");
    let scan = object(&f, b"scan");
    let discard = object(&f, b"drop");
    let old = chrono::Utc::now().timestamp_millis() - chrono::Duration::days(31).num_milliseconds();
    let mut pending = completed(&f, "session", 0, &[baseline.clone()], old);
    pending.finished_ms = None;
    pending.after = None;
    f.store.write_record(&pending).unwrap();
    completed(&f, "other", 0, &[discard], old);
    f.store.object_limit = Some(8);
    let _guard = f.store.lock().unwrap();
    let path = f.store.record_path(&pending);
    assert_eq!(
        f.store
            .collect(Some(&path), &HashSet::from([scan.clone()]), 0, None)
            .unwrap(),
        8
    );
    let error = f
        .store
        .collect(Some(&path), &HashSet::from([scan.clone()]), 1, None)
        .unwrap_err();
    assert!(error.contains("protected coverage"), "{error}");
    assert!(path.exists());
    assert_eq!(object_ids(&f), HashSet::from([baseline, scan]));
}

#[test]
fn journal_pins_both_sides_even_when_unattempted_or_committed_and_records_expire() {
    for committed in [false, true] {
        let mut f = Fixture::new();
        let original = object(&f, b"original");
        let desired = object(&f, b"desired");
        let garbage = object(&f, b"garbage");
        completed(
            &f,
            "session",
            0,
            &[original.clone(), desired.clone(), garbage],
            chrono::Utc::now().timestamp_millis() - chrono::Duration::days(31).num_milliseconds(),
        );
        journal(&f, &original, &desired, committed);
        assert_eq!(sweep(&f), 15);
        assert!(f.store.records(None).unwrap().is_empty());
        assert_eq!(
            object_ids(&f),
            HashSet::from([original.clone(), desired.clone()])
        );
        assert!(f
            .store
            .status()
            .unwrap()
            .last_error
            .unwrap()
            .contains("recovery journal"));
        f.store.object_limit = Some(14);
        let guard = f.store.lock().unwrap();
        let error = f.store.collect(None, &HashSet::new(), 0, None).unwrap_err();
        assert!(error.contains("protected coverage"), "{error}");
        assert_eq!(f.store.object(&original).unwrap(), b"original");
        assert_eq!(f.store.object(&desired).unwrap(), b"desired");
        restore::recover(&f.store).unwrap();
        drop(guard);
        assert_eq!(sweep(&f), 0);
        assert!(object_ids(&f).is_empty());
    }
}

#[test]
fn malformed_journal_or_record_stops_gc_before_any_deletion() {
    let f = Fixture::new();
    let orphan = object(&f, b"must survive failed GC");
    let abandoned = Record::new(AgentType::Codex, "session", 0);
    f.store.write_record(&abandoned).unwrap();
    let path = f.store.record_path(&abandoned);
    let _guard = f.store.lock().unwrap();
    for contents in [
        b"{".as_slice(),
        br#"{"version":2,"root":"wrong","attempted":0,"changes":[]}"#,
    ] {
        fs::write(f.store.journal_path(), contents).unwrap();
        assert!(f.store.collect(None, &HashSet::new(), 0, None).is_err());
        assert!(path.exists());
        assert_eq!(object_ids(&f), HashSet::from([orphan.clone()]));
    }
    fs::remove_file(f.store.journal_path()).unwrap();
    let mut invalid = abandoned.clone();
    invalid.session = "substituted".into();
    f.store.write_json(&path, &invalid).unwrap();
    assert!(f
        .store
        .collect(None, &HashSet::new(), 0, None)
        .unwrap_err()
        .contains("identity"));
    assert!(path.exists());
    assert_eq!(f.store.object(&orphan).unwrap(), b"must survive failed GC");
}

#[test]
fn zero_deadline_and_cancellation_stop_begin_before_walking_or_publishing() {
    for canceled in [false, true] {
        let f = Fixture::new();
        f.write("a", b"untouched");
        let control = if canceled {
            control()
        } else {
            CaptureControl::with_budget(Duration::ZERO)
        };
        let clone = control.clone();
        if canceled {
            clone.cancel();
        }
        let error = begin_controlled(
            f.store.clone(),
            AgentType::Codex,
            "session",
            0,
            &[],
            control,
        )
        .unwrap_err();
        assert!(
            error.contains(if canceled {
                "canceled"
            } else {
                "deadline exceeded"
            }),
            "{error}"
        );
        assert!(f.store.records(None).unwrap().is_empty());
        assert!(object_ids(&f).is_empty());
        assert_eq!(f.read("a"), b"untouched");
        assert!(f.store.lock().is_ok());
        assert_eq!(
            f.store.status().unwrap().last_error.as_deref(),
            Some(error.as_str())
        );
    }
}

#[test]
fn canceled_gc_and_chunked_read_make_no_progress() {
    for canceled in [false, true] {
        let f = Fixture::new();
        let id = object(&f, b"orphan");
        let record = Record::new(AgentType::Codex, "session", 0);
        f.store.write_record(&record).unwrap();
        f.write("a", &vec![42; 128 * 1024]);
        let control = if canceled {
            control()
        } else {
            CaptureControl::with_budget(Duration::ZERO)
        };
        if canceled {
            control.cancel();
        }
        let _guard = f.store.lock().unwrap();
        assert!(f
            .store
            .collect(None, &HashSet::new(), 0, Some(&control))
            .is_err());
        assert!(f.store.record_path(&record).exists());
        assert_eq!(object_ids(&f), HashSet::from([id]));
        let mut file = workspace::open_read(&f.store.root.join("a")).unwrap();
        file.seek(SeekFrom::Start(17)).unwrap();
        assert!(workspace::read_hashed(&mut file, Some(&control)).is_err());
        assert_eq!(file.stream_position().unwrap(), 17);
    }
}

#[tokio::test]
async fn canceled_or_expired_after_capture_never_calls_publisher_or_completes_record() {
    for canceled in [false, true] {
        let f = Fixture::new();
        f.write("a", b"before");
        let pending = start(&f, "session", 0);
        f.write("a", b"after");
        let control = if canceled {
            control()
        } else {
            CaptureControl::with_budget(Duration::ZERO)
        };
        if canceled {
            control.cancel();
        }
        let error = finish_turn_guarded_controlled(pending, control, |_| {
            panic!("failed capture must not publish")
        })
        .await
        .unwrap_err();
        assert!(
            error.contains(if canceled {
                "canceled"
            } else {
                "deadline exceeded"
            }),
            "{error}"
        );
        let record = f.store.read_record(AgentType::Codex, "session", 0).unwrap();
        assert!(record.finished_ms.is_none());
        assert!(record.after.is_none());
        assert!(f.plan(1).is_err());
        assert_eq!(f.read("a"), b"after");
        assert!(f.store.lock().is_ok());
    }
}

#[tokio::test]
async fn cancellation_at_publication_boundary_cannot_publish_completed_coverage() {
    let f = Fixture::new();
    f.write("a", b"before");
    let pending = start(&f, "session", 0);
    f.write("a", b"after");
    let control = control();
    let cancel = control.clone();
    let error = finish_turn_guarded_controlled(pending, control, move |publish| {
        cancel.cancel();
        publish()
    })
    .await
    .unwrap_err();
    assert!(error.contains("canceled"), "{error}");
    assert!(f
        .store
        .read_record(AgentType::Codex, "session", 0)
        .unwrap()
        .after
        .is_none());
    assert_eq!(
        f.store.status().unwrap().last_error.as_deref(),
        Some(error.as_str())
    );
    assert_eq!(sweep(&f), 0);
}

#[tokio::test]
async fn finish_renews_deadline_but_preserves_cancel_token_and_allows_explicit_replacement() {
    let f = Fixture::new();
    f.write("a", b"before");
    let mut pending = start(&f, "session", 0);
    pending.control.deadline = Instant::now();
    assert!(pending.control.renewed().check().is_ok());
    pending.control.cancel();
    assert!(pending
        .control
        .renewed()
        .check()
        .unwrap_err()
        .contains("canceled"));
    f.write("a", b"after");
    let error = finish_turn(pending).await.unwrap_err();
    assert!(error.contains("canceled"), "{error}");
    let pending = start(&f, "session", 1);
    pending.control.cancel();
    f.write("a", b"new after");
    finish(pending).await;
    assert!(retention::complete(
        &f.store.read_record(AgentType::Codex, "session", 1).unwrap()
    ));
}

#[test]
fn fork_inheritance_preserves_gaps_agent_prompt_and_original_ordinals() {
    let f = Fixture::new();
    let now = chrono::Utc::now().timestamp_millis();
    let id = object(&f, b"shared");
    let first = completed(&f, "parent", 0, &[id.clone()], now);
    let third = completed(&f, "parent", 2, &[id.clone()], now);
    completed(&f, "parent", 4, &[id.clone()], now);
    let incomplete = Record::new(AgentType::Codex, "parent", 1);
    f.store.write_record(&incomplete).unwrap();
    let mut other_agent = completed(&f, "other", 3, &[id.clone()], now);
    other_agent.agent = AgentType::ClaudeCode;
    other_agent.session = "parent".into();
    f.store.write_record(&other_agent).unwrap();
    let objects_before = object_ids(&f);
    let _guard = f.store.lock().unwrap();
    f.store
        .inherit_prefix(AgentType::Codex, "parent", "child", 4)
        .unwrap();
    for mut expected in [first, third] {
        expected.session = "child".into();
        let actual = f
            .store
            .read_record(AgentType::Codex, "child", expected.user_index)
            .unwrap();
        assert_eq!(
            serde_json::to_value(actual).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }
    for missing in [1, 3, 4] {
        assert!(f
            .store
            .read_record(AgentType::Codex, "child", missing)
            .is_err());
    }
    assert!(f
        .store
        .read_record(AgentType::ClaudeCode, "child", 3)
        .is_err());
    let count = f.store.records(None).unwrap().len();
    f.store
        .inherit_prefix(AgentType::Codex, "parent", "child", 4)
        .unwrap();
    assert_eq!(f.store.records(None).unwrap().len(), count);
    f.store
        .inherit_prefix(AgentType::Codex, "parent", "empty-child", 0)
        .unwrap();
    assert_eq!(f.store.records(None).unwrap().len(), count);
    assert!(f
        .store
        .inherit_prefix(AgentType::Codex, "parent", "parent", 4)
        .is_err());
    assert_eq!(object_ids(&f), objects_before);
}

#[test]
fn conflicting_child_prefix_is_rejected_before_copying_any_new_slot() {
    let f = Fixture::new();
    let now = chrono::Utc::now().timestamp_millis();
    let parent = object(&f, b"parent");
    let child = object(&f, b"child");
    completed(&f, "parent", 0, &[parent.clone()], now);
    completed(&f, "parent", 1, &[parent], now);
    let conflict = completed(&f, "child", 1, &[child], now);
    let _guard = f.store.lock().unwrap();
    let error = f
        .store
        .inherit_prefix(AgentType::Codex, "parent", "child", 2)
        .unwrap_err();
    assert!(error.contains("already differs"), "{error}");
    assert!(f.store.read_record(AgentType::Codex, "child", 0).is_err());
    assert_eq!(
        serde_json::to_value(f.store.read_record(AgentType::Codex, "child", 1).unwrap()).unwrap(),
        serde_json::to_value(conflict).unwrap()
    );
}

#[test]
fn fork_metadata_burst_is_bounded_at_201_without_gc_or_partial_quota_copy() {
    let f = Fixture::new();
    let now = chrono::Utc::now().timestamp_millis();
    let shared = object(&f, b"shared");
    for index in 0..100 {
        completed(
            &f,
            "parent",
            index,
            &[shared.clone()],
            now - 1000 + index as i64,
        );
    }
    let orphan = object(&f, b"do not collect during inheritance");
    let _guard = f.store.lock().unwrap();
    f.store
        .inherit_prefix(AgentType::Codex, "parent", "child", 100)
        .unwrap();
    assert_eq!(f.store.records(None).unwrap().len(), 200);
    let error = f
        .store
        .inherit_prefix(AgentType::Codex, "parent", "too-large", 2)
        .unwrap_err();
    assert!(error.contains("metadata quota"), "{error}");
    assert!(f
        .store
        .read_record(AgentType::Codex, "too-large", 0)
        .is_err());
    assert!(f
        .store
        .read_record(AgentType::Codex, "too-large", 1)
        .is_err());
    f.store
        .inherit_prefix(AgentType::Codex, "parent", "one-slot", 1)
        .unwrap();
    assert_eq!(f.store.status().unwrap().record_count, 201);
    f.store
        .inherit_prefix(AgentType::Codex, "parent", "child", 100)
        .unwrap();
    assert!(f
        .store
        .write_record(&Record::new(AgentType::Codex, "overflow", 0))
        .is_err());
    assert_eq!(
        f.store.object(&orphan).unwrap(),
        b"do not collect during inheritance"
    );
    assert_eq!(f.store.collect(None, &HashSet::new(), 0, None).unwrap(), 6);
    assert_eq!(f.store.status().unwrap().record_count, 100);
    assert_eq!(object_ids(&f), HashSet::from([shared]));
}

#[tokio::test]
async fn prepared_restore_inheritance_cannot_gc_its_unjournaled_plan() {
    let f = Fixture::new();
    f.write("a", b"initial");
    let pending = start(&f, "session", 0);
    f.write("a", b"after first");
    finish(pending).await;
    let pending = start(&f, "session", 1);
    f.write("a", b"after second");
    finish(pending).await;
    let mut transaction = f.prepare(2);
    // Give the prepared plan's source records an expired timestamp. Any GC in
    // inherit_prefix would delete their only object references before apply.
    for (_, mut record) in f.store.records(None).unwrap() {
        record.finished_ms = Some(
            chrono::Utc::now().timestamp_millis() - chrono::Duration::days(31).num_milliseconds(),
        );
        f.store.write_record(&record).unwrap();
    }
    let before = object_ids(&f);
    assert!(!f.store.journal_path().exists());
    transaction
        .inherit_prefix(AgentType::Codex, "session", "child", 1)
        .unwrap();
    assert_eq!(object_ids(&f), before);
    assert_eq!(f.store.records(None).unwrap().len(), 3);
    transaction.apply().unwrap();
    assert_eq!(f.read("a"), b"initial");
    transaction.rollback().unwrap();
    assert_eq!(f.read("a"), b"after second");
}

#[tokio::test]
async fn fork_lineage_restores_inherited_prefix_and_child_turn_to_original_bytes() {
    let f = Fixture::new();
    f.write("a", b"initial");
    let pending = start(&f, "session", 0);
    f.write("a", b"parent first");
    finish(pending).await;
    let pending = start(&f, "session", 1);
    f.write("a", b"parent second");
    finish(pending).await;
    let target = f.target();
    let token = restore::plan(&f.store, AgentType::Codex, "session", 1, 2, &target)
        .unwrap()
        .preview
        .token;
    let mut transaction = restore::prepare(
        f.store.clone(),
        AgentType::Codex,
        "session",
        1,
        2,
        &target,
        &token,
    )
    .unwrap();
    transaction
        .inherit_prefix(AgentType::Codex, "session", "child", 1)
        .unwrap();
    transaction.bind_fork(7, "session", "child").unwrap();
    transaction.apply().unwrap();
    transaction.commit().unwrap();
    drop(transaction);
    assert_eq!(f.read("a"), b"parent first");
    let pending = start(&f, "child", 1);
    f.write("a", b"child replacement");
    finish(pending).await;
    let target = f.target();
    let plan = restore::plan(&f.store, AgentType::Codex, "child", 0, 2, &target).unwrap();
    assert!(plan.preview.conflicts.is_empty());
    assert_eq!(plan.preview.files.len(), 1);
    let mut transaction = restore::prepare(
        f.store.clone(),
        AgentType::Codex,
        "child",
        0,
        2,
        &target,
        &plan.preview.token,
    )
    .unwrap();
    transaction.apply().unwrap();
    assert_eq!(f.read("a"), b"initial");
    transaction.rollback().unwrap();
    assert_eq!(f.read("a"), b"child replacement");
    assert!(f.store.read_record(AgentType::Codex, "session", 1).is_ok());
}

#[tokio::test]
async fn journal_objects_remain_recoverable_after_all_source_records_are_evicted() {
    let f = Fixture::new();
    f.write("a", b"before");
    let pending = start(&f, "session", 0);
    f.write("a", b"after");
    finish(pending).await;
    let mut transaction = f.prepare(1);
    transaction.apply().unwrap();
    let persisted: serde_json::Value = f.store.read_json(&f.store.journal_path()).unwrap();
    let progress_path = f.store.dir.join("recovery-progress.json");
    let progress: serde_json::Value = f.store.read_json(&progress_path).unwrap();
    transaction.commit().unwrap();
    drop(transaction);
    // Recreate both the immutable v2 plan and its pre-commit progress to
    // represent process loss after apply, including the attempted-write cursor.
    f.store
        .write_json(&f.store.journal_path(), &persisted)
        .unwrap();
    f.store.write_json(&progress_path, &progress).unwrap();
    let mut record = f.store.read_record(AgentType::Codex, "session", 0).unwrap();
    record.finished_ms =
        Some(chrono::Utc::now().timestamp_millis() - chrono::Duration::days(31).num_milliseconds());
    f.store.write_record(&record).unwrap();
    assert_eq!(sweep(&f), 11);
    assert!(f.store.records(None).unwrap().is_empty());
    let guard = f.store.lock().unwrap();
    restore::recover(&f.store).unwrap();
    drop(guard);
    assert_eq!(f.read("a"), b"after");
    assert_eq!(sweep(&f), 0);
}

#[test]
fn current_scope_hashes_only_policy_bytes_without_storing_objects() {
    let f = Fixture::new();
    let root_policy = b"ignored\n";
    let nested_policy = b"*.log\n";
    f.write(".gitignore", root_policy);
    fs::create_dir(f.store.root.join("src")).unwrap();
    f.write("src/.gitignore", nested_policy);
    f.write("ignored", &vec![8; 1024 * 1024]);
    f.write("src/a.bin", &vec![7; 2 * 1024 * 1024]);
    f.write("b.bin", &vec![9; 1024 * 1024]);
    workspace::HASHED_BYTES.with(|bytes| bytes.set(0));
    let initial = workspace::current_scope(&f.store).unwrap();
    assert_eq!(
        workspace::HASHED_BYTES.with(|bytes| bytes.get()),
        root_policy.len() + nested_policy.len()
    );
    assert!(object_ids(&f).is_empty());
    assert!(f.store.records(None).unwrap().is_empty());
    f.write("b.bin", b"changed ordinary contents");
    assert_eq!(workspace::current_scope(&f.store).unwrap(), initial);
    f.write("src/.gitignore", b"*.tmp\n");
    assert_ne!(workspace::current_scope(&f.store).unwrap(), initial);
}

#[tokio::test]
#[ignore = "reports real filesystem timings; run explicitly with --ignored --nocapture"]
async fn capture_performance_reports_small_and_large_fixtures() {
    for (name, small_files, large_files, large_bytes) in
        [("small", 24, 0, 0), ("large", 512, 8, 4 * 1024 * 1024)]
    {
        let f = Fixture::new();
        for index in 0..small_files {
            let mut data = vec![b'x'; 4096];
            data[..8].copy_from_slice(&(index as u64).to_le_bytes());
            f.write(&format!("small-{index}"), &data);
        }
        for index in 0..large_files {
            f.write(&format!("large-{index}"), &vec![index as u8; large_bytes]);
        }
        workspace::HASHED_BYTES.with(|bytes| bytes.set(0));
        let scope_started = Instant::now();
        workspace::current_scope(&f.store).unwrap();
        let scope_elapsed = scope_started.elapsed();
        let scope_bytes = workspace::HASHED_BYTES.with(|bytes| bytes.get());
        assert_eq!(scope_bytes, 0);
        assert!(object_ids(&f).is_empty());
        let cold = Instant::now();
        let pending = start(&f, "perf", 0);
        let cold_elapsed = cold.elapsed();
        let cold_files = pending.record.before.as_ref().unwrap().files.len();
        assert_eq!(cold_files, small_files + large_files);
        f.write("small-0", b"modified during turn");
        let after = Instant::now();
        finish(pending).await;
        let after_elapsed = after.elapsed();
        let warm = Instant::now();
        let pending = start(&f, "perf", 1);
        let warm_elapsed = warm.elapsed();
        assert_eq!(
            pending.record.before.as_ref().unwrap().files.len(),
            cold_files
        );
        finish(pending).await;
        let status = f.store.status().unwrap();
        assert_eq!(status.record_count, 2);
        assert_eq!(
            status.object_bytes,
            (small_files * 4096 + large_files * large_bytes + b"modified during turn".len()) as u64
        );
        eprintln!("checkpoint perf {name}: files={cold_files}, workspace_bytes={}, scope={scope_elapsed:?}, scope_hashed_bytes={scope_bytes}, cold_before={cold_elapsed:?}, after={after_elapsed:?}, warm_before={warm_elapsed:?}, object_bytes={}", small_files * 4096 + large_files * large_bytes, status.object_bytes);
    }
}

#[tokio::test]
async fn provider_normalized_prompt_identity_allows_real_restore_planning() {
    for (agent, parts, parsed) in [
        (AgentType::Codex, vec!["a  b"], "a b"),
        (
            AgentType::Codex,
            vec![" a\t\t b ", "second  line"],
            "a b \nsecond line",
        ),
        (AgentType::Codex, vec!["a", "b"], "a\nb"),
        (AgentType::DeepSeek, vec!["a  b", "c\td"], "a  b\nc\td"),
        (AgentType::DeepSeek, vec!["", "a", "", "b", ""], "a\n\nb\n"),
        (AgentType::ClaudeCode, vec!["a  b", "c\td"], "a  bc\td"),
        (
            AgentType::ClaudeCode,
            vec!["  a  b ", "\t", " second line\n"],
            "a  bsecond line",
        ),
    ] {
        let f = Fixture::new();
        f.write("a", b"before");
        let blocks: Vec<_> = parts
            .into_iter()
            .map(|text| PromptInputBlock::Text { text: text.into() })
            .collect();
        let pending =
            begin_controlled(f.store.clone(), agent, "session", 0, &blocks, control()).unwrap();
        f.write("a", b"after");
        finish(pending).await;
        let mut target = f.target();
        target.blocks = vec![ContentBlock::Text {
            text: parsed.into(),
        }];
        // This is a content identity test; timestamp matching is tested separately.
        target.timestamp = chrono::DateTime::from_timestamp(0, 0).unwrap();
        let plan = restore::plan(&f.store, agent, "session", 0, 1, &target).unwrap();
        assert_eq!(plan.preview.files.len(), 1);
        assert!(plan.preview.conflicts.is_empty());
        let mut transaction = restore::prepare(
            f.store.clone(),
            agent,
            "session",
            0,
            1,
            &target,
            &plan.preview.token,
        )
        .unwrap();
        transaction.apply().unwrap();
        assert_eq!(f.read("a"), b"before");
        transaction.rollback().unwrap();
        target.blocks = vec![ContentBlock::Text {
            text: format!("{parsed} changed"),
        }];
        assert!(restore::plan(&f.store, agent, "session", 0, 1, &target).is_err());
    }
}

#[test]
fn provider_fingerprints_preserve_image_order_and_do_not_normalize_other_providers() {
    let f = Fixture::new();
    for agent in [AgentType::Codex, AgentType::DeepSeek, AgentType::ClaudeCode] {
        let blocks = vec![
            PromptInputBlock::Text {
                text: "a  b".into(),
            },
            PromptInputBlock::Image {
                data: "first".into(),
                mime_type: "image/png".into(),
                uri: None,
            },
            PromptInputBlock::Text { text: "c".into() },
            PromptInputBlock::Image {
                data: "second".into(),
                mime_type: "image/jpeg".into(),
                uri: None,
            },
        ];
        let text = match agent {
            AgentType::Codex => "a b\nc",
            AgentType::DeepSeek => "a  b\nc",
            _ => "a  bc",
        };
        let mut target = f.target();
        target.blocks = vec![
            ContentBlock::Image {
                data: "first".into(),
                mime_type: "image/png".into(),
                uri: None,
            },
            ContentBlock::Image {
                data: "second".into(),
                mime_type: "image/jpeg".into(),
                uri: None,
            },
            ContentBlock::Text { text: text.into() },
        ];
        let fingerprint = prompt_fingerprint(agent, &blocks).unwrap();
        assert_eq!(fingerprint, target_fingerprint(agent, &target).unwrap());
        target.blocks.swap(0, 1);
        assert_ne!(fingerprint, target_fingerprint(agent, &target).unwrap());
        if agent != AgentType::Codex {
            target.blocks.swap(0, 1);
            target.blocks[2] = ContentBlock::Text {
                text: text.replace("  ", " "),
            };
            assert_ne!(fingerprint, target_fingerprint(agent, &target).unwrap());
        }
    }
}

#[test]
fn claude_parser_keeps_text_blocks_separate_and_matches_shared_fingerprint() {
    let f = Fixture::new();
    let mut target = f.target();
    target.blocks = crate::parsers::claude::extract_user_content(&serde_json::json!({
        "message": { "content": [
            { "type": "text", "text": "  a  b " },
            { "type": "image", "source": { "type": "base64", "data": "aGVsbG8=", "media_type": "image/png" } },
            { "type": "text", "text": " second line\n" }
        ] }
    }));
    assert_eq!(target.blocks.len(), 3);
    assert!(matches!(&target.blocks[0], ContentBlock::Text { text } if text == "a  b"));
    assert!(matches!(&target.blocks[2], ContentBlock::Text { text } if text == "second line"));
    let fingerprint = prompt_fingerprint(
        AgentType::ClaudeCode,
        &[
            PromptInputBlock::Text {
                text: "  a  b ".into(),
            },
            PromptInputBlock::Image {
                data: "aGVsbG8=".into(),
                mime_type: "image/png".into(),
                uri: None,
            },
            PromptInputBlock::Text {
                text: " second line\n".into(),
            },
        ],
    )
    .unwrap();
    assert_eq!(
        fingerprint,
        target_fingerprint(AgentType::ClaudeCode, &target).unwrap()
    );
}

#[tokio::test]
async fn discard_pending_keeps_objects_and_allows_same_index_retry() {
    let f = Fixture::new();
    f.write("a", b"before");
    let pending = start(&f, "session", 0);
    let path = f.store.record_path(&pending.record);
    let before = object_ids(&f);
    assert!(
        discard_unsubmitted_at(f.store.clone(), AgentType::Codex, "session", 0)
            .unwrap_err()
            .contains("busy")
    );
    discard_turn(pending).await.unwrap();
    assert!(!path.exists());
    assert_eq!(object_ids(&f), before);
    assert_eq!(f.read("a"), b"before");
    finish(start(&f, "session", 0)).await;
}

#[test]
fn discard_failed_preparation_removes_only_requested_incomplete_slot() {
    let f = Fixture::new();
    f.write("a", b"oversized");
    fs::OpenOptions::new()
        .write(true)
        .open(f.store.root.join("a"))
        .unwrap()
        .set_len(workspace::MAX_FILE + 1)
        .unwrap();
    assert!(begin_controlled(
        f.store.clone(),
        AgentType::Codex,
        "session",
        0,
        &[],
        control()
    )
    .is_err());
    let failed = f
        .store
        .record_path(&Record::new(AgentType::Codex, "session", 0));
    assert!(failed.exists());
    let other = Record::new(AgentType::Codex, "other", 0);
    f.store.write_record(&other).unwrap();
    let orphan = object(&f, b"must not GC");
    discard_unsubmitted_at(f.store.clone(), AgentType::Codex, "session", 0).unwrap();
    discard_unsubmitted_at(f.store.clone(), AgentType::Codex, "session", 0).unwrap();
    assert!(!failed.exists());
    assert!(f.store.record_path(&other).exists());
    assert_eq!(f.store.object(&orphan).unwrap(), b"must not GC");
    f.write("a", b"retry");
    drop(start(&f, "session", 0));
}

#[test]
fn discard_preserves_completed_slots_and_refuses_invalid_identity() {
    let f = Fixture::new();
    let id = object(&f, b"completed bytes");
    let mut record = completed(
        &f,
        "session",
        0,
        &[id],
        chrono::Utc::now().timestamp_millis(),
    );
    let path = f.store.record_path(&record);
    let before = fs::read(&path).unwrap();
    discard_unsubmitted_at(f.store.clone(), AgentType::Codex, "session", 0).unwrap();
    assert_eq!(fs::read(&path).unwrap(), before);
    // Retain a completion marker even if the record's other fields are damaged.
    record.before = None;
    record.after = None;
    f.store.write_record(&record).unwrap();
    discard_unsubmitted_at(f.store.clone(), AgentType::Codex, "session", 0).unwrap();
    assert!(path.exists());
    record.finished_ms = None;
    record.session = "wrong identity".into();
    f.store.write_json(&path, &record).unwrap();
    assert!(
        discard_unsubmitted_at(f.store.clone(), AgentType::Codex, "session", 0)
            .unwrap_err()
            .contains("identity")
    );
    assert!(path.exists());
}

#[test]
fn deepseek_real_parser_image_prompts_drop_only_whitespace_only_text() {
    use crate::parsers::{deepseek::DeepSeekParser, AgentParser};
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let dir = tempdir().unwrap();
    let encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let bytes = STANDARD.decode(encoded).unwrap();
    let digest = storage::hash(&bytes);
    let object_dir = dir.path().join("attachments/v1/objects").join(&digest[..2]);
    fs::create_dir_all(&object_dir).unwrap();
    fs::write(object_dir.join(&digest), &bytes).unwrap();
    let parser = DeepSeekParser::with_base_dir(dir.path().to_path_buf());
    for (index, parts) in [
        vec![],
        vec![" \t\n"],
        vec!["", "\t", "  "],
        vec!["  visible  ", "\tmore\n"],
    ]
    .into_iter()
    .enumerate()
    {
        let session = format!("image-{index}");
        let log_dir = dir.path().join("--workspace--").join(&session);
        fs::create_dir_all(&log_dir).unwrap();
        let mut content: Vec<_> = parts
            .iter()
            .map(|text| serde_json::json!({"type": "text", "text": text}))
            .collect();
        content.push(serde_json::json!({"type": "image", "attachment": {
            "attachmentId": format!("sha256:{digest}"), "mediaType": "image/png",
            "bytes": bytes.len(), "width": 1, "height": 1
        }}));
        let header = serde_json::json!({"type": "session", "version": 0, "id": session, "createdAt": 1000, "cwd": "/workspace", "delegationDepth": 0});
        let event = serde_json::json!({"type": "user/message", "seq": 1, "time": 1010,
            "data": {"content": content, "source": {"kind": "user"}, "role": "user", "id": "u"}});
        fs::write(
            log_dir.join("session.jsonl"),
            format!("{header}\n{event}\n"),
        )
        .unwrap();
        let detail = parser.get_conversation(&session).unwrap();
        assert_eq!(detail.turns.len(), 1);
        let target = &detail.turns[0];
        let mut submitted: Vec<_> = parts
            .iter()
            .map(|text| PromptInputBlock::Text {
                text: (*text).into(),
            })
            .collect();
        submitted.push(PromptInputBlock::Image {
            data: encoded.into(),
            mime_type: "image/png".into(),
            uri: None,
        });
        let expected = prompt_fingerprint(AgentType::DeepSeek, &submitted).unwrap();
        assert_eq!(
            expected,
            target_fingerprint(AgentType::DeepSeek, target).unwrap()
        );
        if index < 3 {
            assert!(matches!(
                target.blocks.as_slice(),
                [ContentBlock::Image { .. }]
            ));
        } else {
            assert!(
                matches!(&target.blocks[0], ContentBlock::Text { text } if text == "  visible  \n\tmore\n")
            );
        }
        let mut wrong_image = target.clone();
        let ContentBlock::Image { data, .. } = wrong_image.blocks.last_mut().unwrap() else {
            panic!("missing image")
        };
        *data = "changed".into();
        assert_ne!(
            expected,
            target_fingerprint(AgentType::DeepSeek, &wrong_image).unwrap()
        );
    }
}
