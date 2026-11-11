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
        service.registry.lock().unwrap().snapshots[0].1.storage,
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

#[tokio::test]
async fn closing_the_last_consumer_cancels_discovery_and_never_publishes_partial_data() {
    let root = tempfile::tempdir().unwrap();
    let key = RootKey::resolve(root.path().to_str().unwrap()).unwrap();
    let gate = Gate::new();
    let worker_gate = Arc::clone(&gate);
    let service = IndexService::new(
        Limits::default(),
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
    let (service, visits) = counted(Limits::default());
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
        Limits::default(),
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
        service.registry.lock().unwrap().snapshots[0].1.storage,
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
        Arc::get_mut(&mut registry.snapshots[0].1).unwrap().built_at = Instant::now() - CACHE_TTL;
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
    let snapshot = service
        .snapshot(key, false, Instant::now(), &SearchControl::default())
        .await
        .unwrap()
        .unwrap();
    let cancelled = SearchControl::default();
    cancelled.cancel.cancel();
    assert!(snapshot
        .search("README", 10, true, &cancelled)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn expired_waiter_cancels_a_queued_job_and_leaves_no_worker_or_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let key = RootKey::resolve(root.path().to_str().unwrap()).unwrap();
    let (service, visits) = counted(Limits::default());
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
