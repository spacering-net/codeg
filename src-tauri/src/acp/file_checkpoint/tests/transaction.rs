use super::*;

async fn captured() -> Fixture {
    let f = Fixture::new();
    f.write("a", b"before");
    f.write("b", b"before-b");
    let pending = f.begin(0);
    f.write("a", b"after");
    f.write("b", b"after-b");
    finish_turn_guarded_controlled(
        pending,
        CaptureControl::with_budget(Duration::from_secs(300)),
        |publish| publish(),
    )
    .await
    .unwrap();
    f
}

fn child_count(f: &Fixture, child: &str) -> usize {
    f.store
        .records(None)
        .unwrap()
        .iter()
        .filter(|(_, r)| r.session == child)
        .count()
}

fn prepare_last(f: &Fixture) -> PreparedRestore {
    let mut target = f.target();
    target.timestamp = chrono::DateTime::from_timestamp(0, 0).unwrap();
    let plan = restore::plan(&f.store, AgentType::Codex, "session", 99, 100, &target).unwrap();
    restore::prepare(
        f.store.clone(),
        AgentType::Codex,
        "session",
        99,
        100,
        &target,
        &plan.preview.token,
    )
    .unwrap()
}

#[tokio::test]
async fn failed_restore_retry_removes_tentative_prefix_and_preserves_all_parent_slots() {
    let f = captured().await;
    let record = f.store.read_record(AgentType::Codex, "session", 0).unwrap();
    for index in 1..100 {
        let mut copy = record.clone();
        copy.user_index = index;
        f.store.write_record(&copy).unwrap();
    }
    for child in ["failed-child", "retry-child"] {
        let mut transaction = prepare_last(&f);
        transaction
            .inherit_prefix(AgentType::Codex, "session", child, 99)
            .unwrap();
        assert_eq!(child_count(&f, child), 99);
        transaction.bind_fork(7, "session", child).unwrap();
        transaction.fail_after = Some(1);
        assert!(transaction.apply().unwrap_err().contains("compensated"));
        drop(transaction);
        assert_eq!(child_count(&f, child), 0);
        assert_eq!(f.store.records(None).unwrap().len(), 100);
        for index in 0..100 {
            assert!(f
                .store
                .read_record(AgentType::Codex, "session", index)
                .is_ok());
        }
        assert_eq!(f.read("a"), b"after");
        assert_eq!(f.read("b"), b"after-b");
    }
}

#[tokio::test]
async fn failed_database_rollback_removes_only_new_child_records() {
    let f = captured().await;
    let mut preexisting = f.store.read_record(AgentType::Codex, "session", 0).unwrap();
    preexisting.session = "existing-child".into();
    f.store.write_record(&preexisting).unwrap();
    let mut transaction = f.prepare(1);
    transaction
        .inherit_prefix(AgentType::Codex, "session", "child", 1)
        .unwrap();
    transaction.bind_fork(7, "session", "child").unwrap();
    transaction.apply().unwrap();
    transaction.rollback().unwrap(); // DB persistence failed.
    drop(transaction);
    assert_eq!(child_count(&f, "child"), 0);
    assert_eq!(child_count(&f, "existing-child"), 1);
    assert_eq!(child_count(&f, "session"), 1);
    assert_eq!(f.read("a"), b"after");
    assert!(!f.store.journal_path().exists());
    assert!(!f.store.dir.join("recovery-progress.json").exists());
}

#[tokio::test]
async fn plan_is_immutable_and_progress_is_small_and_transaction_bound() {
    let f = captured().await;
    let mut transaction = f.prepare(1);
    transaction
        .inherit_prefix(AgentType::Codex, "session", "child", 1)
        .unwrap();
    let plan = fs::read(f.store.journal_path()).unwrap();
    transaction.bind_fork(7, "session", "child").unwrap();
    transaction.apply().unwrap();
    assert_eq!(fs::read(f.store.journal_path()).unwrap(), plan);
    let path = f.store.dir.join("recovery-progress.json");
    let progress: serde_json::Value = f.store.read_json(&path).unwrap();
    assert_eq!(progress["attempted"], 2);
    assert!(fs::metadata(&path).unwrap().len() < 512);
    transaction.rollback().unwrap();
    drop(transaction);
    fs::write(f.store.journal_path(), plan).unwrap();
    let mut wrong = progress;
    wrong["transaction_id"] = serde_json::json!("different-transaction");
    f.store.write_json(&path, &wrong).unwrap();
    assert!(restore::recover_decided(&f.store, false).is_err());
    assert_eq!(f.read("a"), b"after");
    assert!(f.store.journal_path().exists());
}

#[tokio::test]
async fn recovery_handles_durable_progress_before_and_after_each_replace() {
    for attempted in 0_usize..=2 {
        for applied in attempted.saturating_sub(1)..=attempted {
            let f = captured().await;
            let mut transaction = f.prepare(1);
            transaction
                .inherit_prefix(AgentType::Codex, "session", "child", 1)
                .unwrap();
            transaction.bind_fork(7, "session", "child").unwrap();
            transaction.apply().unwrap();
            let plan = fs::read(f.store.journal_path()).unwrap();
            let child = f.store.read_record(AgentType::Codex, "child", 0).unwrap();
            let progress_path = f.store.dir.join("recovery-progress.json");
            let mut progress: serde_json::Value = f.store.read_json(&progress_path).unwrap();
            transaction.rollback().unwrap();
            drop(transaction);
            // Reconstruct an abrupt process exit at the selected write boundary.
            fs::write(f.store.journal_path(), &plan).unwrap();
            f.store.write_record(&child).unwrap();
            progress["attempted"] = serde_json::json!(attempted);
            f.store.write_json(&progress_path, &progress).unwrap();
            if applied >= 1 {
                f.write("a", b"before");
            }
            if applied >= 2 {
                f.write("b", b"before-b");
            }
            assert!(restore::recover(&f.store).is_err());
            restore::recover_decided(&f.store, false).unwrap();
            assert_eq!(f.read("a"), b"after");
            assert_eq!(f.read("b"), b"after-b");
            assert_eq!(child_count(&f, "child"), 0);
            assert_eq!(child_count(&f, "session"), 1);
        }
    }
}

#[tokio::test]
async fn crash_during_prefix_copy_without_progress_removes_only_published_copies() {
    let f = captured().await;
    let mut transaction = f.prepare(1);
    transaction
        .inherit_prefix(AgentType::Codex, "session", "child", 1)
        .unwrap();
    let plan = fs::read(f.store.journal_path()).unwrap();
    let child = f.store.read_record(AgentType::Codex, "child", 0).unwrap();
    transaction.rollback().unwrap();
    drop(transaction);
    for copied in [false, true] {
        fs::write(f.store.journal_path(), &plan).unwrap();
        if copied {
            f.store.write_record(&child).unwrap();
        }
        restore::recover(&f.store).unwrap();
        assert_eq!(child_count(&f, "child"), 0);
        assert_eq!(child_count(&f, "session"), 1);
        assert_eq!(f.read("a"), b"after");
    }
}

#[tokio::test]
async fn committed_crash_keeps_child_and_old_v1_journal_still_compensates() {
    let f = captured().await;
    let mut transaction = f.prepare(1);
    transaction
        .inherit_prefix(AgentType::Codex, "session", "child", 1)
        .unwrap();
    transaction.bind_fork(7, "session", "child").unwrap();
    transaction.apply().unwrap();
    let mut plan: serde_json::Value = f.store.read_json(&f.store.journal_path()).unwrap();
    let progress_path = f.store.dir.join("recovery-progress.json");
    let progress: serde_json::Value = f.store.read_json(&progress_path).unwrap();
    transaction.commit().unwrap();
    drop(transaction);
    f.store.write_json(&f.store.journal_path(), &plan).unwrap();
    f.store.write_json(&progress_path, &progress).unwrap();
    restore::recover_decided(&f.store, true).unwrap();
    assert_eq!(child_count(&f, "child"), 1);
    assert_eq!(f.read("a"), b"before");
    plan["version"] = serde_json::json!(1);
    plan["attempted"] = serde_json::json!(2);
    plan["binding"] = serde_json::Value::Null;
    plan.as_object_mut().unwrap().remove("transaction_id");
    plan.as_object_mut().unwrap().remove("inherited");
    f.store.write_json(&f.store.journal_path(), &plan).unwrap();
    restore::recover(&f.store).unwrap();
    assert_eq!(f.read("a"), b"after");
    assert_eq!(f.read("b"), b"after-b");
    assert_eq!(child_count(&f, "child"), 1);
}

#[tokio::test]
async fn rollback_uses_durable_progress_instead_of_the_in_memory_cursor() {
    let f = captured().await;
    let mut transaction = f.prepare(1);
    transaction.apply().unwrap();
    let path = f.store.dir.join("recovery-progress.json");
    let mut progress: serde_json::Value = f.store.read_json(&path).unwrap();
    // Model the cursor write for b failing before rename: memory advanced to 2,
    // disk remains 1, and b was never written by the restore.
    progress["attempted"] = serde_json::json!(1);
    f.store.write_json(&path, &progress).unwrap();
    f.write("b", b"independent edit to unattempted file");
    transaction.rollback().unwrap();
    assert_eq!(f.read("a"), b"after");
    assert_eq!(f.read("b"), b"independent edit to unattempted file");
}

#[tokio::test]
async fn rollback_refuses_to_delete_a_replaced_child_record() {
    let f = captured().await;
    let mut transaction = f.prepare(1);
    transaction
        .inherit_prefix(AgentType::Codex, "session", "child", 1)
        .unwrap();
    let mut child = f.store.read_record(AgentType::Codex, "child", 0).unwrap();
    child.prompt = "different-claim".into();
    f.store.write_record(&child).unwrap();
    assert!(transaction
        .rollback()
        .unwrap_err()
        .contains("Inherited checkpoint changed"));
    drop(transaction);
    assert_eq!(child_count(&f, "child"), 1);
    assert_eq!(child_count(&f, "session"), 1);
    assert!(f.store.journal_path().exists());
    assert_eq!(f.read("a"), b"after");
}
