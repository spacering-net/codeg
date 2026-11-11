use super::*;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use tokio::sync::Notify;

fn entry(path: &str, dir: bool) -> WorkspaceFileEntry {
    WorkspaceFileEntry {
        name: path.rsplit('/').next().unwrap().into(),
        path: path.into(),
        kind: if dir {
            WorkspaceEntryKind::Dir
        } else {
            WorkspaceEntryKind::File
        },
    }
}

async fn search(service: &Arc<IndexService>, key: RootKey, query: &str) -> Vec<WorkspaceFileEntry> {
    service
        .search(
            key,
            SearchOptions {
                query,
                limit: 10,
                files_only: true,
                refresh: false,
            },
            Instant::now(),
            Arc::new(SearchControl::default()),
        )
        .await
        .unwrap()
}

fn counted(limits: Limits) -> (Arc<IndexService>, Arc<AtomicUsize>) {
    let visits = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&visits);
    let service = IndexService::new(
        limits,
        Arc::new(move |path, visit| {
            count.fetch_add(1, Ordering::SeqCst);
            visit_workspace_files(path, visit)
        }),
    );
    (service, visits)
}

struct Gate {
    closed: AtomicBool,
    started: Notify,
}

impl Gate {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            closed: AtomicBool::new(true),
            started: Notify::new(),
        })
    }
    fn wait(&self) {
        self.started.notify_one();
        let start = Instant::now();
        while self.closed.load(Ordering::Acquire) && start.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    fn release(&self) {
        self.closed.store(false, Ordering::Release);
    }
}

#[tokio::test]
async fn large_discovery_does_not_block_small_root_or_empty_listing() {
    let large = tempfile::tempdir().unwrap();
    let small = tempfile::tempdir().unwrap();
    std::fs::write(small.path().join("needle.ts"), "x").unwrap();
    let blocked = std::fs::canonicalize(large.path()).unwrap();
    let gate = Gate::new();
    let worker_gate = Arc::clone(&gate);
    let service = IndexService::new(
        Limits::default(),
        Arc::new(move |path, visit| {
            if Path::new(path) == blocked {
                worker_gate.wait();
            }
            visit_workspace_files(path, visit);
        }),
    );
    let worker = Arc::clone(&service);
    let large_key = RootKey::resolve(large.path().to_str().unwrap()).unwrap();
    let pending = tokio::spawn(async move { search(&worker, large_key, "needle").await });
    tokio::time::timeout(Duration::from_secs(2), gate.started.notified())
        .await
        .unwrap();
    let small_key = RootKey::resolve(small.path().to_str().unwrap()).unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        search(&service, small_key.clone(), "needle"),
    )
    .await
    .unwrap();
    assert_eq!(result[0].path, "needle.ts");
    let empty = tokio::time::timeout(Duration::from_secs(1), search(&service, small_key, ""))
        .await
        .unwrap();
    assert_eq!(empty[0].path, "needle.ts");
    assert!(!pending.is_finished());
    gate.release();
    pending.await.unwrap();
}

#[tokio::test]
async fn empty_listing_proceeds_with_both_discovery_permits_held() {
    let (service, _) = counted(Limits::default());
    let one = service.discovery.clone().acquire_owned().await.unwrap();
    let two = service.discovery.clone().acquire_owned().await.unwrap();
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.ts"), "x").unwrap();
    let key = RootKey::resolve(root.path().to_str().unwrap()).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), search(&service, key, ""))
            .await
            .unwrap()
            .len(),
        1
    );
    drop((one, two));
}

#[tokio::test]
async fn roots_a_b_a_and_canonical_aliases_reuse_complete_indexes() {
    let (service, visits) = counted(Limits::default());
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    for root in [&a, &b] {
        std::fs::write(root.path().join("needle"), "x").unwrap();
    }
    for root in [&a, &b, &a] {
        let result = search(
            &service,
            RootKey::resolve(root.path().to_str().unwrap()).unwrap(),
            "needle",
        )
        .await;
        assert_eq!(result[0].path, "needle");
    }
    let alias = format!("{}/.", a.path().display());
    search(&service, RootKey::resolve(&alias).unwrap(), "needle").await;
    assert_eq!(visits.load(Ordering::SeqCst), 2);
    assert_eq!(service.registry.lock().unwrap().snapshots.len(), 2);
    assert!(service.memory.used.load(Ordering::Acquire) <= INDEX_BYTES);
}

#[tokio::test]
async fn oversized_roots_are_complete_and_reused_without_another_walk() {
    let limits = Limits {
        memory: 1024,
        build: 2048,
        disk: 4 * 1024 * 1024,
        disk_per_root: 2 * 1024 * 1024,
        ..Limits::default()
    };
    let (service, visits) = counted(limits);
    let root = tempfile::tempdir().unwrap();
    for i in 0..300 {
        std::fs::write(root.path().join(format!("a{i:03}")), "x").unwrap();
    }
    std::fs::create_dir_all(root.path().join("z/deep")).unwrap();
    std::fs::write(root.path().join("z/deep/needle.ts"), "x").unwrap();
    let key = RootKey::resolve(root.path().to_str().unwrap()).unwrap();
    for query in ["needle", "needle.ts", "ndle", "z/deep"] {
        let result = search(&service, key.clone(), query).await;
        assert_eq!(result[0].path, "z/deep/needle.ts");
    }
    assert_eq!(visits.load(Ordering::SeqCst), 1);
    assert!(matches!(
        service.registry.lock().unwrap().snapshots[0]
            .snapshot
            .storage,
        Storage::Disk { .. }
    ));
    assert_eq!(service.memory.used.load(Ordering::Acquire), 0);
    assert!(service.disk.used.load(Ordering::Acquire) > 0);
    assert!(service.disk.used.load(Ordering::Acquire) < limits.disk_per_root);

    let mut concurrent = Vec::new();
    for _ in 0..8 {
        let worker = Arc::clone(&service);
        let key = key.clone();
        concurrent.push(tokio::spawn(
            async move { search(&worker, key, "needle").await },
        ));
    }
    for task in concurrent {
        assert_eq!(task.await.unwrap()[0].path, "z/deep/needle.ts");
    }
    assert_eq!(visits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn same_root_discovery_coalesces_and_one_closed_consumer_does_not_cancel_the_other() {
    let root = tempfile::tempdir().unwrap();
    let key = RootKey::resolve(root.path().to_str().unwrap()).unwrap();
    let gate = Gate::new();
    let worker_gate = Arc::clone(&gate);
    let visits = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&visits);
    let service = IndexService::new(
        Limits::default(),
        Arc::new(move |_, visit| {
            count.fetch_add(1, Ordering::SeqCst);
            worker_gate.wait();
            visit(entry("needle.ts", false));
        }),
    );
    let first_control = Arc::new(SearchControl::default());
    let worker = Arc::clone(&service);
    let first_key = key.clone();
    let control = Arc::clone(&first_control);
    let first = tokio::spawn(async move {
        worker
            .search(
                first_key,
                SearchOptions {
                    query: "needle",
                    limit: 10,
                    files_only: true,
                    refresh: false,
                },
                Instant::now(),
                control,
            )
            .await
            .unwrap()
    });
    tokio::time::timeout(Duration::from_secs(2), gate.started.notified())
        .await
        .unwrap();
    let worker = Arc::clone(&service);
    let second_key = key.clone();
    let second = tokio::spawn(async move { search(&worker, second_key, "needle").await });
    tokio::time::timeout(Duration::from_secs(1), async {
        while service.registry.lock().unwrap().jobs[&key]
            .users
            .load(Ordering::Acquire)
            < 2
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    first_control.cancel.cancel();
    assert!(first.await.unwrap().is_empty());
    assert!(!service.registry.lock().unwrap().jobs[&key]
        .control
        .stopped());
    gate.release();
    assert_eq!(second.await.unwrap()[0].path, "needle.ts");
    assert_eq!(visits.load(Ordering::SeqCst), 1);
}

/// Long enough for a test to observe, short enough to stay inside the
/// one-second waits the cancellation tests use.
const SHORT_LINGER: Duration = Duration::from_millis(50);

#[tokio::test]
async fn a_superseding_keystroke_reattaches_to_the_running_discovery() {
    let root = tempfile::tempdir().unwrap();
    let key = RootKey::resolve(root.path().to_str().unwrap()).unwrap();
    let gate = Gate::new();
    let worker_gate = Arc::clone(&gate);
    let visits = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&visits);
    let service = IndexService::new(
        Limits::default(),
        Arc::new(move |_, visit| {
            count.fetch_add(1, Ordering::SeqCst);
            worker_gate.wait();
            visit(entry("needle.ts", false));
        }),
    );
    let worker = Arc::clone(&service);
    let first_key = key.clone();
    let first = tokio::spawn(async move { search(&worker, first_key, "ne").await });
    tokio::time::timeout(Duration::from_secs(2), gate.started.notified())
        .await
        .unwrap();
    // The picker aborts the old query before its debounced successor arrives:
    // for a moment the cold discovery has no consumer at all.
    first.abort();
    let _ = first.await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!service.registry.lock().unwrap().jobs[&key]
        .control
        .stopped());
    let worker = Arc::clone(&service);
    let second_key = key.clone();
    let second = tokio::spawn(async move { search(&worker, second_key, "needle").await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    gate.release();
    assert_eq!(second.await.unwrap()[0].path, "needle.ts");
    assert_eq!(visits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn closing_the_last_consumer_cancels_discovery_and_never_publishes_partial_data() {
    let root = tempfile::tempdir().unwrap();
    let key = RootKey::resolve(root.path().to_str().unwrap()).unwrap();
    let key_for_wait = key.clone();
    let gate = Gate::new();
    let worker_gate = Arc::clone(&gate);
    let service = IndexService::new(
        Limits {
            linger: SHORT_LINGER,
            ..Limits::default()
        },
        Arc::new(move |_, visit| {
            visit(entry("prefix.ts", false));
            worker_gate.wait();
            visit(entry("late.ts", false));
        }),
    );
    let control = Arc::new(SearchControl::default());
    let request_control = Arc::clone(&control);
    let worker = Arc::clone(&service);
    let task = tokio::spawn(async move {
        worker
            .search(
                key,
                SearchOptions {
                    query: "late",
                    limit: 1,
                    files_only: true,
                    refresh: false,
                },
                Instant::now(),
                request_control,
            )
            .await
            .unwrap()
    });
    tokio::time::timeout(Duration::from_secs(2), gate.started.notified())
        .await
        .unwrap();
    control.cancel.cancel();
    assert!(tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap()
        .is_empty());
    // A job that completes inside the linger may still publish a complete
    // snapshot; this test is about one abandoned for longer than that.
    tokio::time::timeout(Duration::from_secs(1), async {
        while !service.registry.lock().unwrap().jobs[&key_for_wait]
            .control
            .stopped()
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    gate.release();
    tokio::time::timeout(Duration::from_secs(1), async {
        while service.discovery.available_permits() < WORKERS
            || !service.registry.lock().unwrap().jobs.is_empty()
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(service.registry.lock().unwrap().snapshots.is_empty());
    assert_eq!(service.disk.used.load(Ordering::Acquire), 0);
    assert_eq!(service.memory.used.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn cancelled_queued_discovery_and_dropped_query_release_admission() {
    let (service, visits) = counted(Limits {
        linger: SHORT_LINGER,
        ..Limits::default()
    });
    let permits = service
        .discovery
        .clone()
        .acquire_many_owned(WORKERS as u32)
        .await
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let key = RootKey::resolve(root.path().to_str().unwrap()).unwrap();
    let worker = Arc::clone(&service);
    let worker_key = key.clone();
    let task = tokio::spawn(async move { search(&worker, worker_key, "needle").await });
    tokio::time::timeout(Duration::from_secs(1), async {
        while !service.registry.lock().unwrap().jobs.contains_key(&key) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    task.abort();
    let _ = task.await;
    tokio::time::timeout(Duration::from_secs(1), async {
        while !service.registry.lock().unwrap().jobs.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(permits);
    assert_eq!(visits.load(Ordering::SeqCst), 0);
    assert!(service.registry.lock().unwrap().snapshots.is_empty());
}

#[tokio::test]
async fn a_cancelled_old_build_cannot_replace_the_new_same_root_generation() {
    let root = tempfile::tempdir().unwrap();
    let key = RootKey::resolve(root.path().to_str().unwrap()).unwrap();
    let gate = Gate::new();
    let worker_gate = Arc::clone(&gate);
    let visits = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&visits);
    let service = IndexService::new(
        Limits {
            linger: Duration::ZERO,
            ..Limits::default()
        },
        Arc::new(move |_, visit| {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                worker_gate.wait();
                visit(entry("old.ts", false));
            } else {
                visit(entry("new.ts", false));
            }
        }),
    );
    let worker = Arc::clone(&service);
    let old_key = key.clone();
    let task = tokio::spawn(async move { search(&worker, old_key, ".ts").await });
    tokio::time::timeout(Duration::from_secs(2), gate.started.notified())
        .await
        .unwrap();
    task.abort();
    let _ = task.await;
    let result = search(&service, key.clone(), ".ts").await;
    assert_eq!(result[0].path, "new.ts");
    gate.release();
    tokio::time::timeout(Duration::from_secs(1), async {
        while service.discovery.available_permits() < WORKERS {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(search(&service, key, ".ts").await[0].path, "new.ts");
    assert_eq!(visits.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn active_snapshot_leases_remain_charged_after_lru_eviction() {
    let one = tempfile::tempdir().unwrap();
    let two = tempfile::tempdir().unwrap();
    for root in [&one, &two] {
        std::fs::write(root.path().join("needle"), "x").unwrap();
    }
    let mut builder = Builder::default();
    assert!(builder.push(&entry("needle", false), BUILD_BYTES));
    let bytes = builder.index.bytes();
    let limits = Limits {
        memory: bytes,
        roots: 1,
        ..Limits::default()
    };
    let (service, _) = counted(limits);
    let key = RootKey::resolve(one.path().to_str().unwrap()).unwrap();
    let lease = service
        .snapshot(key, false, Instant::now(), &SearchControl::default())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(service.memory.used.load(Ordering::Acquire), bytes);
    search(
        &service,
        RootKey::resolve(two.path().to_str().unwrap()).unwrap(),
        "needle",
    )
    .await;
    assert_eq!(service.memory.used.load(Ordering::Acquire), bytes);
    assert!(matches!(
        service.registry.lock().unwrap().snapshots[0]
            .snapshot
            .storage,
        Storage::Disk { .. }
    ));
    drop(lease);
    assert_eq!(service.memory.used.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn total_disk_budget_includes_active_leases_and_failures_back_off() {
    let limits = Limits {
        memory: 0,
        disk: 50,
        disk_per_root: 50,
        roots: 1,
        ..Limits::default()
    };
    let (service, visits) = counted(limits);
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    for root in [&a, &b] {
        std::fs::write(root.path().join("needle"), "x").unwrap();
    }
    let key_a = RootKey::resolve(a.path().to_str().unwrap()).unwrap();
    let key_b = RootKey::resolve(b.path().to_str().unwrap()).unwrap();
    let held = service
        .snapshot(key_a, false, Instant::now(), &SearchControl::default())
        .await
        .unwrap()
        .unwrap();
    assert!(service.disk.used.load(Ordering::Acquire) > 0);
    for _ in 0..3 {
        let error = service
            .snapshot(
                key_b.clone(),
                false,
                Instant::now(),
                &SearchControl::default(),
            )
            .await
            .err()
            .unwrap();
        assert!(error.contains("budget is in use"));
    }
    assert_eq!(visits.load(Ordering::SeqCst), 1);
    assert!(service.disk.used.load(Ordering::Acquire) <= limits.disk);
    drop(held);
    assert_eq!(service.disk.used.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn reserving_one_quota_never_evicts_snapshots_charged_to_the_other() {
    let (service, visits) = counted(Limits {
        disk: 64,
        disk_per_root: 64,
        ..Limits::default()
    });
    let warm = tempfile::tempdir().unwrap();
    let cold = tempfile::tempdir().unwrap();
    for root in [&warm, &cold] {
        std::fs::write(root.path().join("needle"), "x").unwrap();
    }
    let warm_key = RootKey::resolve(warm.path().to_str().unwrap()).unwrap();
    assert_eq!(search(&service, warm_key.clone(), "needle").await.len(), 1);
    assert!(matches!(
        service.registry.lock().unwrap().snapshots[0]
            .snapshot
            .storage,
        Storage::Memory { .. }
    ));
    // Disk is exhausted by something no snapshot owns: evicting the memory
    // index cannot free it, so the warm root must survive the failed build.
    let held = service.disk.reserve(64).unwrap();
    let error = service
        .snapshot(
            RootKey::resolve(cold.path().to_str().unwrap()).unwrap(),
            false,
            Instant::now(),
            &SearchControl::default(),
        )
        .await
        .err()
        .unwrap();
    assert!(error.contains("budget is in use"));
    assert_eq!(service.registry.lock().unwrap().snapshots.len(), 1);
    assert_eq!(search(&service, warm_key, "needle").await.len(), 1);
    // The failed build is refused before walking; the warm root is reused.
    assert_eq!(visits.load(Ordering::SeqCst), 1);
    drop(held);
}

#[tokio::test]
async fn disk_overflow_never_publishes_partial_results_or_rewalks_on_each_query() {
    let (service, visits) = counted(Limits {
        memory: 0,
        disk: 32,
        disk_per_root: 32,
        ..Limits::default()
    });
    let root = tempfile::tempdir().unwrap();
    for name in ["a.txt", "late-needle.txt"] {
        std::fs::write(root.path().join(name), "x").unwrap();
    }
    let key = RootKey::resolve(root.path().to_str().unwrap()).unwrap();
    for _ in 0..3 {
        assert!(service
            .snapshot(
                key.clone(),
                false,
                Instant::now(),
                &SearchControl::default()
            )
            .await
            .is_err());
    }
    assert_eq!(visits.load(Ordering::SeqCst), 1);
    assert!(service.registry.lock().unwrap().snapshots.is_empty());
    assert_eq!(service.disk.used.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn refresh_expiry_root_configuration_and_lru_eviction_trigger_real_rebuilds() {
    let (service, visits) = counted(Limits {
        roots: 1,
        ..Limits::default()
    });
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    for root in [&a, &b] {
        std::fs::write(root.path().join("needle"), "x").unwrap();
    }
    let key = RootKey::resolve(a.path().to_str().unwrap()).unwrap();
    search(&service, key.clone(), "needle").await;
    service
        .search(
            key.clone(),
            SearchOptions {
                query: "needle",
                limit: 1,
                files_only: true,
                refresh: true,
            },
            Instant::now(),
            Arc::new(SearchControl::default()),
        )
        .await
        .unwrap();
    assert_eq!(visits.load(Ordering::SeqCst), 2);
    {
        let mut registry = service.registry.lock().unwrap();
        registry.snapshots[0].fresh_base = Instant::now() - CACHE_TTL;
    }
    search(&service, key, "needle").await;
    assert_eq!(visits.load(Ordering::SeqCst), 3);
    std::fs::write(a.path().join(".gitignore"), "needle\n").unwrap();
    assert!(search(
        &service,
        RootKey::resolve(a.path().to_str().unwrap()).unwrap(),
        "needle"
    )
    .await
    .is_empty());
    assert_eq!(visits.load(Ordering::SeqCst), 4);
    search(
        &service,
        RootKey::resolve(b.path().to_str().unwrap()).unwrap(),
        "needle",
    )
    .await;
    search(
        &service,
        RootKey::resolve(a.path().to_str().unwrap()).unwrap(),
        "needle",
    )
    .await;
    assert_eq!(visits.load(Ordering::SeqCst), 6);
    assert_eq!(service.registry.lock().unwrap().snapshots.len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn linked_root_authorization_is_part_of_the_cache_identity() {
    let root = tempfile::tempdir().unwrap();
    let linked = tempfile::tempdir().unwrap();
    std::fs::write(linked.path().join("needle.ts"), "x").unwrap();
    std::os::unix::fs::symlink(linked.path(), root.path().join("api")).unwrap();
    let target = std::fs::canonicalize(linked.path()).unwrap();
    let (service, visits) = counted(Limits::default());
    let path = root.path().to_str().unwrap();
    assert!(search(&service, RootKey::resolve(path).unwrap(), "needle")
        .await
        .is_empty());
    crate::folder_links::register(root.path(), &target);
    let authorized = search(&service, RootKey::resolve(path).unwrap(), "needle").await;
    crate::folder_links::unregister(root.path(), &target);
    assert_eq!(authorized[0].path, "api/needle.ts");
    assert!(search(&service, RootKey::resolve(path).unwrap(), "needle")
        .await
        .is_empty());
    assert_eq!(
        visits.load(Ordering::SeqCst),
        2,
        "revocation can reuse the snapshot made before authorization"
    );
}

#[tokio::test]
async fn disk_scoring_matches_memory_unicode_path_and_stable_tie_ranking() {
    let root = tempfile::tempdir().unwrap();
    let key = RootKey::resolve(root.path().to_str().unwrap()).unwrap();
    let entries = vec![
        entry("foo", true),
        entry("foo/😀FooBar.rs", false),
        entry("foo/README.md", false),
        entry("src", true),
        entry("src/İstanbul.ts", false),
        entry("src/éclair.ts", false),
        entry("src/README.md", false),
    ];
    let copied = entries.clone();
    let service = IndexService::new(
        Limits {
            memory: 0,
            ..Limits::default()
        },
        Arc::new(move |_, visit| {
            for entry in copied.clone() {
                if !visit(entry) {
                    break;
                }
            }
        }),
    );
    for query in ["README", "src/", "fbr", "😀", "é", "İ"] {
        let mut expected = Matches::new(query, 10, true);
        for (i, entry) in entries.iter().enumerate() {
            expected.offer(
                &entry.name,
                &entry.path,
                entry.kind == WorkspaceEntryKind::Dir,
                i,
            );
        }
        assert_eq!(
            search(&service, key.clone(), query).await,
            expected.finish(),
            "{query}"
        );
    }
    let (snapshot, overlay) = service
        .snapshot(key, false, Instant::now(), &SearchControl::default())
        .await
        .unwrap()
        .unwrap();
    let cancelled = SearchControl::default();
    cancelled.cancel.cancel();
    assert!(snapshot
        .search("README", 10, true, &cancelled, &overlay)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn expired_waiter_cancels_a_queued_job_and_leaves_no_worker_or_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let key = RootKey::resolve(root.path().to_str().unwrap()).unwrap();
    let (service, visits) = counted(Limits {
        linger: SHORT_LINGER,
        ..Limits::default()
    });
    let held = service
        .discovery
        .clone()
        .acquire_many_owned(WORKERS as u32)
        .await
        .unwrap();
    let control = Arc::new(SearchControl {
        deadline: Instant::now() + Duration::from_millis(10),
        ..SearchControl::default()
    });
    assert!(service
        .search(
            key,
            SearchOptions {
                query: "needle",
                limit: 10,
                files_only: true,
                refresh: false
            },
            Instant::now(),
            control
        )
        .await
        .unwrap()
        .is_empty());
    tokio::time::timeout(Duration::from_secs(1), async {
        while !service.registry.lock().unwrap().jobs.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(held);
    assert_eq!(visits.load(Ordering::SeqCst), 0);
    assert_eq!(service.disk.used.load(Ordering::Acquire), 0);
}

/// Run explicitly to profile a real workspace. Outputs counts/bytes/timings,
/// never filenames. The temporary snapshot closes when the service drops.
#[tokio::test]
#[ignore = "set CODEG_MEMORY_WORKSPACE to profile a real workspace"]
async fn large_workspace_memory_probe() {
    let path = std::env::var("CODEG_MEMORY_WORKSPACE").expect("CODEG_MEMORY_WORKSPACE");
    let key = RootKey::resolve(&path).unwrap();
    let (service, visits) = counted(Limits::default());
    println!("probe_pid={}", std::process::id());
    for query in ["README.md", "index.ts", "workspace_file_search"] {
        let at = Instant::now();
        let result = search(&service, key.clone(), query).await;
        println!(
            "{}",
            serde_json::json!({
                "results": result.len(), "responseBytes": serde_json::to_vec(&result).unwrap().len(),
                "seconds": at.elapsed().as_secs_f64(), "walks": visits.load(Ordering::Acquire),
                "retainedMemoryBytes": service.memory.used.load(Ordering::Acquire),
                "snapshotDiskBytes": service.disk.used.load(Ordering::Acquire),
            })
        );
    }
    assert_eq!(visits.load(Ordering::Acquire), 1);
}

// ---- File-change events keep watched snapshots current ----

fn watched_root() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    (dir, root)
}

fn changed(service: &Arc<IndexService>, root: &Path, paths: &[&str]) {
    service.watch_changed(root, paths.iter().copied(), paths.iter().copied(), false);
    service.settle();
}

fn paths(entries: Vec<WorkspaceFileEntry>) -> Vec<String> {
    entries.into_iter().map(|entry| entry.path).collect()
}

async fn find(service: &Arc<IndexService>, root: &Path, query: &str) -> Vec<String> {
    let key = RootKey::resolve(root.to_str().unwrap()).unwrap();
    service.settle();
    paths(search(service, key, query).await)
}

#[tokio::test]
async fn watched_snapshot_follows_creates_deletes_and_renames_without_a_rewalk() {
    let (_dir, root) = watched_root();
    std::fs::create_dir(root.join("src")).unwrap();
    std::fs::write(root.join("src/old-needle.ts"), "x").unwrap();
    let (service, visits) = counted(Limits::default());
    service.watch_started(&root);
    assert_eq!(find(&service, &root, "needle").await, ["src/old-needle.ts"]);

    std::fs::write(root.join("src/new-needle.ts"), "x").unwrap();
    changed(&service, &root, &["src/new-needle.ts"]);
    // Equal scores: snapshot entries rank before ones added since.
    assert_eq!(
        find(&service, &root, "needle").await,
        ["src/old-needle.ts", "src/new-needle.ts"]
    );

    std::fs::remove_file(root.join("src/old-needle.ts")).unwrap();
    changed(&service, &root, &["src/old-needle.ts"]);
    assert_eq!(find(&service, &root, "needle").await, ["src/new-needle.ts"]);

    // A renamed directory: the old path disappears with its subtree, the new
    // one is read in full even though only the directory was reported.
    std::fs::rename(root.join("src"), root.join("lib")).unwrap();
    changed(&service, &root, &["src", "lib"]);
    assert_eq!(find(&service, &root, "needle").await, ["lib/new-needle.ts"]);
    assert_eq!(visits.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn changes_in_ignored_trees_leave_the_overlay_untouched() {
    let (_dir, root) = watched_root();
    std::fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
    std::fs::create_dir_all(root.join("target/debug")).unwrap();
    std::fs::write(root.join("main.rs"), "x").unwrap();
    let (service, _) = counted(Limits::default());
    service.watch_started(&root);
    assert_eq!(find(&service, &root, "main").await, ["main.rs"]);
    std::fs::write(root.join("target/debug/main.o"), "x").unwrap();
    std::fs::remove_dir_all(root.join("target/debug")).unwrap();
    std::fs::write(root.join("main.log"), "x").unwrap();
    changed(
        &service,
        &root,
        &["target/debug/main.o", "target/debug", ".git/index"],
    );
    {
        let registry = service.registry.lock().unwrap();
        assert_eq!(registry.snapshots[0].overlay.len(), 0);
    }
    // A newly ignored-by-name file in a visible directory never shows up.
    changed(&service, &root, &["main.log"]);
    assert_eq!(find(&service, &root, "main").await, ["main.rs"]);
}

#[tokio::test]
async fn nested_ignore_changes_and_lost_events_force_a_rebuild() {
    let (_dir, root) = watched_root();
    std::fs::create_dir(root.join("pkg")).unwrap();
    std::fs::write(root.join("pkg/needle.ts"), "x").unwrap();
    let (service, visits) = counted(Limits::default());
    service.watch_started(&root);
    assert_eq!(find(&service, &root, "needle").await, ["pkg/needle.ts"]);
    std::fs::write(root.join("pkg/.gitignore"), "needle.ts\n").unwrap();
    // A content edit of an ignore file is not structural, still decisive.
    service.watch_changed(
        &root,
        ["pkg/.gitignore"].into_iter(),
        std::iter::empty(),
        false,
    );
    assert!(find(&service, &root, "needle").await.is_empty());
    assert_eq!(visits.load(Ordering::SeqCst), 2);
    std::fs::remove_file(root.join("pkg/.gitignore")).unwrap();
    service.watch_changed(&root, std::iter::empty(), std::iter::empty(), true);
    assert_eq!(find(&service, &root, "needle").await, ["pkg/needle.ts"]);
    assert_eq!(visits.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn changes_during_the_walk_are_replayed_onto_the_published_snapshot() {
    let (_dir, root) = watched_root();
    std::fs::write(root.join("first-needle.ts"), "x").unwrap();
    let gate = Gate::new();
    let worker_gate = Arc::clone(&gate);
    let service = IndexService::new(
        Limits::default(),
        Arc::new(move |path, visit| {
            visit_workspace_files(path, visit);
            worker_gate.wait();
        }),
    );
    service.watch_started(&root);
    let worker = Arc::clone(&service);
    let key = RootKey::resolve(root.to_str().unwrap()).unwrap();
    let first = tokio::spawn(async move { paths(search(&worker, key, "needle").await) });
    tokio::time::timeout(Duration::from_secs(2), gate.started.notified())
        .await
        .unwrap();
    // The walk has already passed this point: only the event can add it.
    std::fs::write(root.join("late-needle.ts"), "x").unwrap();
    changed(&service, &root, &["late-needle.ts"]);
    gate.release();
    assert_eq!(first.await.unwrap(), ["first-needle.ts"]);
    // "needle" starts earlier in the late name, so it ranks first.
    assert_eq!(
        find(&service, &root, "needle").await,
        ["late-needle.ts", "first-needle.ts"]
    );
}

#[tokio::test]
async fn only_a_watch_live_for_the_whole_walk_covers_a_snapshot_until_it_stops() {
    let (_dir, root) = watched_root();
    std::fs::write(root.join("needle.ts"), "x").unwrap();
    let (service, visits) = counted(Limits::default());
    let key = RootKey::resolve(root.to_str().unwrap()).unwrap();
    let covered =
        |service: &Arc<IndexService>| service.registry.lock().unwrap().snapshots[0].covered;
    // Built before the watch: it may have missed earlier changes.
    search(&service, key.clone(), "needle").await;
    let token = service.watch_started(&root);
    assert!(!covered(&service));
    let refresh = |service: Arc<IndexService>, key: RootKey| async move {
        service
            .search(
                key,
                SearchOptions {
                    query: "needle",
                    limit: 10,
                    files_only: true,
                    refresh: true,
                },
                Instant::now(),
                Arc::new(SearchControl::default()),
            )
            .await
            .unwrap()
    };
    refresh(Arc::clone(&service), key.clone()).await;
    assert_eq!(visits.load(Ordering::SeqCst), 2);
    assert!(covered(&service));
    // Covered: as fresh as any request asks for, and it never ages out.
    service.registry.lock().unwrap().snapshots[0].fresh_base = Instant::now() - CACHE_TTL * 2;
    refresh(Arc::clone(&service), key.clone()).await;
    search(&service, key.clone(), "needle").await;
    assert_eq!(visits.load(Ordering::SeqCst), 2);
    // A stale token (a replaced watch) changes nothing.
    service.watch_stopped(&root, token + 1);
    assert!(covered(&service));
    service.watch_stopped(&root, token);
    assert!(!covered(&service));
    // From here the TTL applies as for any unwatched snapshot.
    search(&service, key.clone(), "needle").await;
    assert_eq!(visits.load(Ordering::SeqCst), 2);
    refresh(Arc::clone(&service), key).await;
    assert_eq!(visits.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn disk_snapshots_apply_the_same_overlay() {
    let (_dir, root) = watched_root();
    std::fs::write(root.join("a-needle.ts"), "x").unwrap();
    std::fs::write(root.join("b-needle.ts"), "x").unwrap();
    let (service, visits) = counted(Limits {
        memory: 0,
        ..Limits::default()
    });
    service.watch_started(&root);
    assert_eq!(
        find(&service, &root, "needle").await,
        ["a-needle.ts", "b-needle.ts"]
    );
    assert!(matches!(
        service.registry.lock().unwrap().snapshots[0]
            .snapshot
            .storage,
        Storage::Disk { .. }
    ));
    std::fs::remove_file(root.join("a-needle.ts")).unwrap();
    std::fs::write(root.join("c-needle.ts"), "x").unwrap();
    changed(&service, &root, &["a-needle.ts", "c-needle.ts"]);
    assert_eq!(
        find(&service, &root, "needle").await,
        ["b-needle.ts", "c-needle.ts"]
    );
    assert_eq!(visits.load(Ordering::SeqCst), 1);
}

#[test]
fn reading_changes_uses_full_walk_semantics() {
    let (_dir, root) = watched_root();
    std::fs::write(root.join(".gitignore"), "build/\n").unwrap();
    std::fs::create_dir_all(root.join("build/out")).unwrap();
    std::fs::create_dir_all(root.join("src/new/deep")).unwrap();
    std::fs::write(root.join("src/new/deep/a.ts"), "x").unwrap();
    std::fs::write(root.join("src/new/deep/.DS_Store"), "x").unwrap();
    let changes = read_changes(
        &root,
        vec![
            "src/new/deep/a.ts".into(),
            "src/new".into(),
            "build/out/x.o".into(),
            "src/gone.ts".into(),
            "missing-parent/x.ts".into(),
        ],
        OVERLAY_LIMIT,
    )
    .unwrap();
    assert_eq!(
        changes,
        [
            Change::Removed("src/gone.ts".into()),
            Change::Replaced(
                "src/new".into(),
                vec![
                    entry("src/new", true),
                    entry("src/new/deep", true),
                    entry("src/new/deep/a.ts", false),
                ]
            ),
        ]
    );
}

#[tokio::test]
async fn a_walk_that_lost_events_answers_its_waiters_but_is_not_cached() {
    let (_dir, root) = watched_root();
    std::fs::write(root.join("needle.ts"), "x").unwrap();
    let gate = Gate::new();
    let worker_gate = Arc::clone(&gate);
    let visits = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&visits);
    let service = IndexService::new(
        Limits::default(),
        Arc::new(move |path, visit| {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                worker_gate.wait();
            }
            visit_workspace_files(path, visit);
        }),
    );
    service.watch_started(&root);
    let worker = Arc::clone(&service);
    let key = RootKey::resolve(root.to_str().unwrap()).unwrap();
    let first_key = key.clone();
    let first = tokio::spawn(async move { paths(search(&worker, first_key, "needle").await) });
    tokio::time::timeout(Duration::from_secs(2), gate.started.notified())
        .await
        .unwrap();
    service.watch_changed(&root, std::iter::empty(), std::iter::empty(), true);
    gate.release();
    assert_eq!(first.await.unwrap(), ["needle.ts"]);
    assert!(service.registry.lock().unwrap().snapshots.is_empty());
    search(&service, key, "needle").await;
    assert_eq!(visits.load(Ordering::SeqCst), 2);
    assert!(service.registry.lock().unwrap().snapshots[0].covered);
}

#[test]
fn a_changed_subtree_past_the_overlay_limit_is_not_collected() {
    let (_dir, root) = watched_root();
    std::fs::create_dir(root.join("moved")).unwrap();
    for i in 0..4 {
        std::fs::write(root.join(format!("moved/{i}.ts")), "x").unwrap();
    }
    assert_eq!(read_changes(&root, vec!["moved".into()], 3), None);
    assert_eq!(
        read_changes(&root, vec!["moved".into()], 5).unwrap().len(),
        1
    );
}

#[test]
fn ignore_rule_files_include_nested_git_excludes() {
    for path in [
        ".gitignore",
        "a/.ignore",
        "pkg/.git/info/exclude",
        ".git/info/exclude",
    ] {
        assert!(is_ignore_file(path), "{path}");
    }
    for path in [
        ".git/.gitignore",
        "pkg/.git/hooks/.ignore",
        "a/gitignore",
        "a/b.ts",
    ] {
        assert!(!is_ignore_file(path), "{path}");
    }
}

#[tokio::test]
async fn an_oversized_change_drops_the_snapshot_for_a_rebuild() {
    let (_dir, root) = watched_root();
    std::fs::write(root.join("needle.ts"), "x").unwrap();
    let (service, visits) = counted(Limits::default());
    service.watch_started(&root);
    assert_eq!(find(&service, &root, "needle").await, ["needle.ts"]);
    std::fs::create_dir(root.join("vendor")).unwrap();
    for i in 0..=OVERLAY_LIMIT {
        std::fs::write(root.join(format!("vendor/{i}")), "").unwrap();
    }
    changed(&service, &root, &["vendor"]);
    assert!(service.registry.lock().unwrap().snapshots.is_empty());
    assert_eq!(find(&service, &root, "needle").await, ["needle.ts"]);
    assert_eq!(visits.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_change_read_before_a_rebuild_never_lands_on_the_new_snapshot() {
    let (_dir, root) = watched_root();
    std::fs::create_dir(root.join("src")).unwrap();
    std::fs::write(root.join("src/needle.ts"), "x").unwrap();
    let (service, visits) = counted(Limits::default());
    service.watch_started(&root);
    assert_eq!(find(&service, &root, "needle").await, ["src/needle.ts"]);
    // Hold the change thread after it has read `src/needle.ts` as present.
    let (reached, wait_reached) = mpsc::channel();
    let (release, wait_release) = mpsc::channel::<()>();
    let wait_release = Mutex::new(wait_release);
    *service.after_read.lock().unwrap() = Some(Box::new(move || {
        let _ = reached.send(());
        let _ = wait_release.lock().unwrap().recv();
    }));
    service.watch_changed(
        &root,
        ["src/needle.ts"].into_iter(),
        ["src/needle.ts"].into_iter(),
        false,
    );
    wait_reached.recv().unwrap();
    // Meanwhile the rules change and a rebuild no longer lists the file.
    std::fs::write(root.join("src/.gitignore"), "needle.ts\n").unwrap();
    service.watch_changed(
        &root,
        ["src/.gitignore"].into_iter(),
        std::iter::empty(),
        false,
    );
    let key = RootKey::resolve(root.to_str().unwrap()).unwrap();
    assert!(search(&service, key, "needle").await.is_empty());
    assert_eq!(visits.load(Ordering::SeqCst), 2);
    release.send(()).unwrap();
    assert!(find(&service, &root, "needle").await.is_empty());
}

#[tokio::test]
async fn a_replaced_watch_uncovers_snapshots_like_a_stop() {
    let (_dir, root) = watched_root();
    std::fs::write(root.join("needle.ts"), "x").unwrap();
    let (service, _) = counted(Limits::default());
    let first = service.watch_started(&root);
    find(&service, &root, "needle").await;
    assert!(service.registry.lock().unwrap().snapshots[0].covered);
    // A new stream registered before the old one's stop arrived.
    let second = service.watch_started(&root);
    assert!(!service.registry.lock().unwrap().snapshots[0].covered);
    service.watch_stopped(&root, first);
    assert_eq!(service.registry.lock().unwrap().watches[&root], second);
}

#[tokio::test]
async fn roots_with_linked_directories_are_not_maintained_by_events() {
    let (_dir, root) = watched_root();
    std::fs::write(root.join("needle.ts"), "x").unwrap();
    let (service, _) = counted(Limits::default());
    service.watch_started(&root);
    find(&service, &root, "needle").await;
    let mut registry = service.registry.lock().unwrap();
    assert_eq!(registry.maintained(&root).count(), 1);
    // The same root keyed with an authorized link (its target is outside the
    // watched tree, and the focused walk does not follow links).
    registry.snapshots[0]
        .key
        .links
        .push(("api".into(), PathBuf::from("/elsewhere")));
    assert_eq!(registry.maintained(&root).count(), 0);
}

#[tokio::test]
async fn a_covered_snapshot_is_still_rebuilt_after_the_long_backstop_ttl() {
    let (_dir, root) = watched_root();
    std::fs::write(root.join("needle.ts"), "x").unwrap();
    let (service, visits) = counted(Limits::default());
    service.watch_started(&root);
    find(&service, &root, "needle").await;
    // Past the plain TTL: a covered snapshot is kept.
    service.registry.lock().unwrap().snapshots[0].fresh_base = Instant::now() - CACHE_TTL * 2;
    find(&service, &root, "needle").await;
    assert_eq!(visits.load(Ordering::SeqCst), 1);
    // A file created without an event (a backend lost it silently) shows up
    // once the backstop expires.
    std::fs::write(root.join("unseen-needle.ts"), "x").unwrap();
    service.registry.lock().unwrap().snapshots[0].fresh_base = Instant::now() - COVERED_TTL;
    assert_eq!(
        find(&service, &root, "needle").await,
        ["needle.ts", "unseen-needle.ts"]
    );
    assert_eq!(visits.load(Ordering::SeqCst), 2);
    assert!(service.registry.lock().unwrap().snapshots[0].covered);
}

#[cfg(unix)]
#[tokio::test]
async fn nested_symlinked_ignore_rules_keep_a_snapshot_on_the_plain_ttl() {
    let (_dir, root) = watched_root();
    let outside = tempfile::tempdir().unwrap();
    let rules = outside.path().join("rules");
    std::fs::write(&rules, "").unwrap();
    std::fs::create_dir(root.join("pkg")).unwrap();
    std::fs::write(root.join("pkg/needle.ts"), "x").unwrap();
    std::os::unix::fs::symlink(&rules, root.join("pkg/.ignore")).unwrap();
    let (service, visits) = counted(Limits::default());
    service.watch_started(&root);
    assert_eq!(find(&service, &root, "needle").await, ["pkg/needle.ts"]);
    assert!(!service.registry.lock().unwrap().snapshots[0].covered);
    // The rule target changes outside the watched tree: no event arrives, but
    // a fresh query (Cmd+K opening) rebuilds rather than trusting coverage.
    std::fs::write(&rules, "needle.ts\n").unwrap();
    let key = RootKey::resolve(root.to_str().unwrap()).unwrap();
    let fresh = service
        .search(
            key,
            SearchOptions {
                query: "needle",
                limit: 10,
                files_only: true,
                refresh: true,
            },
            Instant::now(),
            Arc::new(SearchControl::default()),
        )
        .await
        .unwrap();
    assert!(fresh.is_empty());
    assert_eq!(visits.load(Ordering::SeqCst), 2);
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlinked_rule_file_that_is_itself_ignored_still_counts() {
    let (_dir, root) = watched_root();
    let outside = tempfile::tempdir().unwrap();
    let rules = outside.path().join("rules");
    std::fs::write(&rules, "").unwrap();
    // Hidden from results by the root rules, yet still applied by the walk.
    std::fs::write(root.join(".gitignore"), ".ignore\n").unwrap();
    std::fs::create_dir(root.join("pkg")).unwrap();
    std::fs::write(root.join("pkg/needle.ts"), "x").unwrap();
    std::os::unix::fs::symlink(&rules, root.join("pkg/.ignore")).unwrap();
    let (service, _) = counted(Limits::default());
    service.watch_started(&root);
    assert_eq!(find(&service, &root, "needle").await, ["pkg/needle.ts"]);
    assert!(!service.registry.lock().unwrap().snapshots[0].covered);
    // Moved in the same way, it drops a covered snapshot.
    std::fs::remove_file(root.join("pkg/.ignore")).unwrap();
    service.watch_changed(
        &root,
        ["pkg/.ignore"].into_iter(),
        ["pkg/.ignore"].into_iter(),
        false,
    );
    find(&service, &root, "needle").await;
    assert!(service.registry.lock().unwrap().snapshots[0].covered);
    let moved = outside.path().join("lib");
    std::fs::create_dir(&moved).unwrap();
    std::os::unix::fs::symlink(&rules, moved.join(".ignore")).unwrap();
    std::fs::rename(&moved, root.join("lib")).unwrap();
    changed(&service, &root, &["lib"]);
    assert!(service.registry.lock().unwrap().snapshots.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_directory_moved_in_with_symlinked_rules_drops_the_snapshot() {
    let (_dir, root) = watched_root();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(root.join("needle.ts"), "x").unwrap();
    let (service, visits) = counted(Limits::default());
    service.watch_started(&root);
    find(&service, &root, "needle").await;
    assert!(service.registry.lock().unwrap().snapshots[0].covered);
    let moved = outside.path().join("pkg");
    std::fs::create_dir(&moved).unwrap();
    std::fs::write(moved.join("other-needle.ts"), "x").unwrap();
    std::os::unix::fs::symlink(outside.path().join("rules"), moved.join(".gitignore")).unwrap();
    std::fs::rename(&moved, root.join("pkg")).unwrap();
    // Only the directory itself is reported.
    changed(&service, &root, &["pkg"]);
    assert!(service.registry.lock().unwrap().snapshots.is_empty());
    assert_eq!(
        find(&service, &root, "needle").await,
        ["needle.ts", "pkg/other-needle.ts"]
    );
    assert_eq!(visits.load(Ordering::SeqCst), 2);
    assert!(!service.registry.lock().unwrap().snapshots[0].covered);
}
