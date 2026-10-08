use super::*;
use crate::models::message::{ContentBlock, TurnRole};
use std::fs;
use tempfile::{tempdir, TempDir};

mod lifecycle;
mod transaction;

struct Fixture {
    _dir: TempDir,
    store: Store,
}

#[tokio::test]
async fn removing_a_nested_git_boundary_never_turns_existing_files_into_deletions() {
    let f = Fixture::new();
    fs::create_dir_all(f.store.root.join("nested/.git")).unwrap();
    f.write("nested/existing", b"must survive");
    let pending = f.begin(0);
    fs::remove_dir(f.store.root.join("nested/.git")).unwrap();
    assert!(finish_turn(pending).await.is_err());
    assert!(f.plan(1).is_err());
    assert_eq!(f.read("nested/existing"), b"must survive");
}

#[tokio::test]
async fn fork_bound_recovery_requires_decision_and_preserves_committed_files() {
    let f = Fixture::new();
    f.write("a", b"before");
    let pending = f.begin(0);
    f.write("a", b"after");
    finish_turn(pending).await.unwrap();
    let mut transaction = f.prepare(1);
    transaction.bind_fork(7, "parent", "child").unwrap();
    transaction.apply().unwrap();
    let journal: serde_json::Value = f.store.read_json(&f.store.journal_path()).unwrap();
    let progress = fs::read(f.store.dir.join("recovery-progress.json")).unwrap();
    transaction.commit().unwrap();
    drop(transaction);
    f.store
        .write_json(&f.store.journal_path(), &journal)
        .unwrap();
    fs::write(f.store.dir.join("recovery-progress.json"), &progress).unwrap();
    let binding = restore::recovery_binding(&f.store).unwrap().unwrap();
    assert_eq!(binding.conversation_id, 7);
    assert_eq!(binding.forked_session_id, "child");
    assert!(restore::recover(&f.store).is_err());
    assert_eq!(f.read("a"), b"before");
    restore::recover_decided(&f.store, true).unwrap();
    assert_eq!(f.read("a"), b"before");
    f.store
        .write_json(&f.store.journal_path(), &journal)
        .unwrap();
    fs::write(f.store.dir.join("recovery-progress.json"), &progress).unwrap();
    restore::recover_decided(&f.store, false).unwrap();
    assert_eq!(f.read("a"), b"after");
}

impl Fixture {
    fn new() -> Self {
        let dir = tempdir().unwrap();
        let root = dir.path().join("workspace");
        fs::create_dir(&root).unwrap();
        let store = Store::at(&root, &dir.path().join("data")).unwrap();
        store.set_enabled(true).unwrap();
        Self { _dir: dir, store }
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        fs::write(self.store.root.join(name), bytes).unwrap();
    }
    fn read(&self, name: &str) -> Vec<u8> {
        fs::read(self.store.root.join(name)).unwrap()
    }
    fn begin(&self, index: usize) -> PendingCheckpoint {
        begin(
            self.store.clone(),
            AgentType::Codex,
            "session",
            index,
            &[PromptInputBlock::Text {
                text: "prompt".into(),
            }],
        )
        .unwrap()
    }
    fn target(&self) -> MessageTurn {
        MessageTurn {
            id: "turn-0".into(),
            role: TurnRole::User,
            blocks: vec![ContentBlock::Text {
                text: "prompt".into(),
            }],
            timestamp: chrono::Utc::now(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: None,
        }
    }
    fn plan(&self, total: usize) -> Result<restore::Plan, String> {
        restore::plan(
            &self.store,
            AgentType::Codex,
            "session",
            0,
            total,
            &self.target(),
        )
    }
    fn prepare(&self, total: usize) -> PreparedRestore {
        let target = self.target();
        let preview = restore::plan(&self.store, AgentType::Codex, "session", 0, total, &target)
            .unwrap()
            .preview;
        restore::prepare(
            self.store.clone(),
            AgentType::Codex,
            "session",
            0,
            total,
            &target,
            &preview.token,
        )
        .unwrap()
    }
}

#[tokio::test]
async fn exact_dirty_untracked_binary_unicode_create_delete_and_preserve_unrelated() {
    let f = Fixture::new();
    f.write("dirty.txt", b"already dirty\r\n");
    f.write("untracked.bin", &[0, 255, 10, 13]);
    f.write("删除.txt", "原始内容".as_bytes());
    f.write("unrelated", b"untouched");
    let pending = f.begin(0);
    f.write("dirty.txt", b"agent bytes\n");
    f.write("untracked.bin", &[1, 2]);
    fs::remove_file(f.store.root.join("删除.txt")).unwrap();
    f.write("new.bin", &[0, 42]);
    finish_turn(pending).await.unwrap();
    f.write("unrelated", b"manual edit after turn");
    f.write("unrelated-new", b"also keep");
    let mut restore = f.prepare(1);
    restore.apply().unwrap();
    assert_eq!(f.read("dirty.txt"), b"already dirty\r\n");
    assert_eq!(f.read("untracked.bin"), [0, 255, 10, 13]);
    assert_eq!(f.read("删除.txt"), "原始内容".as_bytes());
    assert!(!f.store.root.join("new.bin").exists());
    assert_eq!(f.read("unrelated"), b"manual edit after turn");
    assert_eq!(f.read("unrelated-new"), b"also keep");
    restore.commit().unwrap();
    assert!(!f.store.journal_path().exists());
}

#[tokio::test]
async fn rollback_and_drop_compensate_exactly() {
    let f = Fixture::new();
    f.write("a", b"before");
    let pending = f.begin(0);
    f.write("a", b"after");
    f.write("created", b"new");
    finish_turn(pending).await.unwrap();
    {
        let mut restore = f.prepare(1);
        restore.apply().unwrap();
        assert_eq!(f.read("a"), b"before");
        restore.rollback().unwrap();
        restore.rollback().unwrap();
    }
    assert_eq!(f.read("a"), b"after");
    assert_eq!(f.read("created"), b"new");
    {
        let mut restore = f.prepare(1);
        restore.apply().unwrap();
    }
    assert_eq!(f.read("a"), b"after");
    assert_eq!(f.read("created"), b"new");
}

#[tokio::test]
async fn current_edits_conflict_and_stale_preview_rejected() {
    let f = Fixture::new();
    f.write("a", b"before");
    let pending = f.begin(0);
    f.write("a", b"after");
    finish_turn(pending).await.unwrap();
    let target = f.target();
    let token = restore::plan(&f.store, AgentType::Codex, "session", 0, 1, &target)
        .unwrap()
        .preview
        .token;
    f.write("a", b"manual");
    assert!(!f.plan(1).unwrap().preview.conflicts.is_empty());
    assert!(restore::prepare(
        f.store.clone(),
        AgentType::Codex,
        "session",
        0,
        1,
        &target,
        &token
    )
    .is_err());
    assert_eq!(f.read("a"), b"manual");
}

#[tokio::test]
async fn every_boundary_checks_changed_paths_including_earlier_unchanged_turns() {
    let f = Fixture::new();
    f.write("a", b"initial");
    finish_turn(f.begin(0)).await.unwrap();
    f.write("a", b"between");
    let pending = f.begin(1);
    f.write("a", b"agent");
    finish_turn(pending).await.unwrap();
    assert!(f
        .plan(2)
        .unwrap()
        .preview
        .conflicts
        .iter()
        .any(|e| e.contains("between captured turns")));
}

#[tokio::test]
async fn contiguous_turns_restore_first_before_and_reject_missing_tail_gap_or_aborted() {
    let f = Fixture::new();
    f.write("a", b"zero");
    let p = f.begin(0);
    f.write("a", b"one");
    finish_turn(p).await.unwrap();
    assert!(f.plan(2).is_err());
    let p = f.begin(1);
    f.write("a", b"two");
    finish_turn(p).await.unwrap();
    let mut restore = f.prepare(2);
    restore.apply().unwrap();
    assert_eq!(f.read("a"), b"zero");
    restore.rollback().unwrap();
    drop(restore);
    drop(f.begin(2));
    assert!(f.plan(3).is_err());
    let p = f.begin(4);
    finish_turn(p).await.unwrap();
    assert!(f.plan(5).is_err());
}

#[tokio::test]
async fn repeated_index_invalidates_previous_completion() {
    let f = Fixture::new();
    finish_turn(f.begin(0)).await.unwrap();
    assert!(begin(
        f.store.clone(),
        AgentType::Codex,
        "session",
        0,
        &[PromptInputBlock::Text {
            text: "prompt".into()
        }]
    )
    .is_err());
    assert!(f.plan(1).is_err());
}

#[tokio::test]
async fn root_lease_is_nonblocking_and_guarded_publish_can_invalidate() {
    let f = Fixture::new();
    let pending = f.begin(0);
    assert!(f.store.lock().is_err());
    finish_turn_guarded(pending, |_action| Err("overlap".into()))
        .await
        .unwrap_err();
    assert!(f.plan(1).is_err());
    assert!(f.store.lock().is_ok());
}

#[tokio::test]
async fn partial_write_failure_compensates_and_failed_compensation_retains_journal() {
    let f = Fixture::new();
    f.write("a", b"original-a");
    f.write("b", b"original-b");
    let p = f.begin(0);
    f.write("a", b"new-a");
    f.write("b", b"new-b");
    finish_turn(p).await.unwrap();
    let mut restore = f.prepare(1);
    restore.fail_after = Some(1);
    assert!(restore.apply().unwrap_err().contains("compensated"));
    assert_eq!(f.read("a"), b"new-a");
    assert_eq!(f.read("b"), b"new-b");
    assert!(!f.store.journal_path().exists());
    drop(restore);
    let mut restore = f.prepare(1);
    restore.apply().unwrap();
    f.write("a", b"external edit");
    assert!(restore.rollback().is_err());
    drop(restore);
    assert!(f.store.journal_path().exists());
    assert!(f.plan(1).is_err());
    assert!(restore::recover(&f.store).is_err());
    assert_eq!(f.read("a"), b"external edit");
    // Operator restores the recorded pre-restore state, making retry safe.
    f.write("a", b"new-a");
    restore::recover(&f.store).unwrap();
    assert_eq!(f.read("b"), b"new-b");
    assert!(!f.store.journal_path().exists());
}

#[test]
fn traversal_hardlinks_oversize_and_data_inside_root_are_rejected() {
    for path in [
        "../escape",
        "/absolute",
        "a/../../b",
        "a\\b",
        "C:/x",
        "a/.git/config",
        "a//b",
        "x:ads",
        "x.",
    ] {
        assert!(workspace::validate_relative(path).is_err(), "{path}");
    }
    let f = Fixture::new();
    f.write("a", b"data");
    fs::hard_link(f.store.root.join("a"), f.store.root.join("alias")).unwrap();
    assert!(workspace::capture(&f.store).is_err());
    assert!(Store::at(&f.store.root, &f.store.root.join("data")).is_err());
    fs::remove_file(f.store.root.join("alias")).unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(f.store.root.join("a"))
        .unwrap()
        .set_len(workspace::MAX_FILE + 1)
        .unwrap();
    assert!(workspace::capture(&f.store).is_err());
}

#[tokio::test]
async fn hardlink_substitution_after_prepare_is_never_written_or_chmodded() {
    let f = Fixture::new();
    f.write("a", b"before");
    let p = f.begin(0);
    f.write("a", b"after");
    finish_turn(p).await.unwrap();
    let mut restore = f.prepare(1);
    let outside = f._dir.path().join("outside");
    fs::write(&outside, b"after").unwrap();
    fs::remove_file(f.store.root.join("a")).unwrap();
    fs::hard_link(&outside, f.store.root.join("a")).unwrap();
    assert!(restore.apply().is_err());
    assert_eq!(fs::read(outside).unwrap(), b"after");
}

#[tokio::test]
async fn ignore_policy_changes_fail_capture_and_nested_git_and_build_are_excluded() {
    let f = Fixture::new();
    f.write(".gitignore", b"ignored\n");
    f.write("ignored", b"private");
    for dir in ["node_modules", ".git", "nested/.git"] {
        fs::create_dir_all(f.store.root.join(dir)).unwrap();
    }
    f.write("nested/file", b"not ours");
    f.write("node_modules/file", b"not ours");
    let snapshot = workspace::capture(&f.store).unwrap();
    assert_eq!(snapshot.files.len(), 1);
    let p = f.begin(0);
    f.write(".gitignore", b"ignored\nextra\n");
    assert!(finish_turn(p).await.is_err());
    assert!(f.plan(1).is_err());
}

#[tokio::test]
async fn stale_prompt_and_timestamp_cannot_select_other_turn() {
    let f = Fixture::new();
    finish_turn(f.begin(0)).await.unwrap();
    let mut target = f.target();
    target.blocks = vec![ContentBlock::Text {
        text: "other".into(),
    }];
    assert!(restore::plan(&f.store, AgentType::Codex, "session", 0, 1, &target).is_err());
    target = f.target();
    target.timestamp -= chrono::Duration::days(1);
    assert!(restore::plan(&f.store, AgentType::Codex, "session", 0, 1, &target).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn executable_mode_is_restored_and_symlink_ancestors_rejected() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let f = Fixture::new();
    f.write("script", b"before");
    fs::set_permissions(
        f.store.root.join("script"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let p = f.begin(0);
    f.write("script", b"after");
    fs::set_permissions(
        f.store.root.join("script"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    finish_turn(p).await.unwrap();
    let mut restore = f.prepare(1);
    restore.apply().unwrap();
    assert_eq!(
        fs::metadata(f.store.root.join("script"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    restore.commit().unwrap();
    drop(restore);
    let outside = f._dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, f.store.root.join("link")).unwrap();
    assert!(workspace::capture(&f.store).is_err());
    assert!(workspace::current(&f.store.root, "link/file").is_err());
}

#[cfg(windows)]
#[test]
fn windows_junction_ancestor_rejected() {
    let f = Fixture::new();
    let outside = f._dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    // Directory symlinks require Developer Mode/admin on Windows; retain the
    // no-follow assertion when the host permits creating one.
    if std::os::windows::fs::symlink_dir(&outside, f.store.root.join("link")).is_ok() {
        assert!(workspace::capture(&f.store).is_err());
        assert!(workspace::current(&f.store.root, "link/file").is_err());
    }
}

#[tokio::test]
async fn current_ignore_changes_reject_preview_and_apply_without_persisting_objects() {
    let f = Fixture::new();
    f.write(".gitignore", b"ignored\n");
    f.write("a", b"before");
    let p = f.begin(0);
    f.write("a", b"after");
    finish_turn(p).await.unwrap();
    let mut restore = f.prepare(1);
    let objects_before = fs::read_dir(f.store.dir.join("objects")).unwrap().count();
    f.write(".gitignore", b"ignored\na\n");
    assert!(f.plan(1).is_err());
    assert!(restore.apply().is_err());
    assert_eq!(f.read("a"), b"after");
    assert_eq!(
        fs::read_dir(f.store.dir.join("objects")).unwrap().count(),
        objects_before
    );
}

#[test]
fn fingerprint_normalizes_text_image_interleaving_but_preserves_payloads() {
    let text = |s: &str| PromptInputBlock::Text { text: s.into() };
    let image = |s: &str| PromptInputBlock::Image {
        data: s.into(),
        mime_type: "image/png".into(),
        uri: None,
    };
    let original = prompt_fingerprint(
        AgentType::Codex,
        &[text("a"), image("1"), text("b"), image("2")],
    )
    .unwrap();
    assert_eq!(
        original,
        prompt_fingerprint(AgentType::Codex, &[image("1"), image("2"), text("a\nb")]).unwrap()
    );
    assert_ne!(
        original,
        prompt_fingerprint(AgentType::Codex, &[image("2"), image("1"), text("a\nb")]).unwrap()
    );
    assert_ne!(
        original,
        prompt_fingerprint(AgentType::Codex, &[image("1"), image("2"), text("a b")]).unwrap()
    );
    assert!(prompt_fingerprint(
        AgentType::Codex,
        &[PromptInputBlock::ResourceLink {
            uri: "file:///a".into(),
            name: "a".into(),
            mime_type: None,
            description: None
        }]
    )
    .is_err());
}

#[test]
fn object_quota_accumulates_new_objects_and_deduplicates_existing() {
    let f = Fixture::new();
    let mut quota = None;
    f.store.put_object(b"abc", &mut quota).unwrap();
    assert_eq!(quota, Some(3));
    f.store.put_object(b"abc", &mut quota).unwrap();
    assert_eq!(quota, Some(3));
    f.store.put_object(b"abcd", &mut quota).unwrap();
    assert_eq!(quota, Some(7));
    quota = Some(512 * 1024 * 1024);
    assert!(f.store.put_object(b"new", &mut quota).is_err());
    assert!(!f
        .store
        .dir
        .join("objects")
        .join(storage::hash(b"new"))
        .exists());
}

#[tokio::test]
async fn committed_recovery_never_compensates_and_commit_io_error_cannot_drop_rollback() {
    let f = Fixture::new();
    f.write("a", b"before");
    let p = f.begin(0);
    f.write("a", b"after");
    finish_turn(p).await.unwrap();
    let mut restore = f.prepare(1);
    restore.apply().unwrap();
    let journal: serde_json::Value = f.store.read_json(&f.store.journal_path()).unwrap();
    let progress_path = f.store.dir.join("recovery-progress.json");
    let mut progress: serde_json::Value = f.store.read_json(&progress_path).unwrap();
    progress["committed"] = serde_json::Value::Bool(true);
    restore.commit().unwrap();
    drop(restore);
    // Simulate cleanup interrupted after the sidecar's committed flag reached disk.
    f.store
        .write_json(&f.store.journal_path(), &journal)
        .unwrap();
    f.store.write_json(&progress_path, &progress).unwrap();
    restore::recover(&f.store).unwrap();
    assert_eq!(f.read("a"), b"before");
    // Start from end state again, then inject journal-persistence failure after
    // the caller has durably committed its DB. Drop must keep the restored bytes.
    f.write("a", b"after");
    let mut restore = f.prepare(1);
    restore.apply().unwrap();
    fs::remove_file(&progress_path).unwrap();
    fs::create_dir(&progress_path).unwrap();
    assert!(restore.commit().is_err());
    drop(restore);
    assert_eq!(f.read("a"), b"before");
}
