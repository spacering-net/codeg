use super::*;
use crate::acp::codex_catalog_commit::tests::{
    hooks, interrupted_and_edited, native_body, panel_toml, save_panel, serve, Env, AUTH,
    NATIVE_INTENT,
};
use crate::acp::codex_catalog_commit::{CatalogMeta, AUTH_REL, CONFIG_REL, META_REL};
use crate::acp::codex_runtime::test_hooks;
use crate::acp::codex_runtime::JudgeError;
use serde_json::Value;

const CUSTOMS: &str = r#"{"customs":[{"slug":"gw/x","base":"gpt-5.6-sol"}],"default":"gw/x"}"#;

fn runtime(version: &str, js: &str) -> CodexRuntime {
    test_hooks::runtime_of(version, js)
}

fn upgraded() -> CodexRuntime {
    runtime("0.161.0", "/fake/b/codex.js")
}

fn hours(h: i64) -> chrono::Duration {
    chrono::Duration::hours(h)
}

fn write_meta(env: &Env, f: impl FnOnce(&mut CatalogMeta)) {
    let mut meta = env.meta();
    f(&mut meta);
    env.write(META_REL, &serde_json::to_string(&meta).unwrap());
}

/// The official list with one more model cloned from `gpt-5.5`.
fn officials_plus(slug: &str) -> Vec<Value> {
    let mut list = catalog::bundled_snapshot_models();
    let mut extra = list
        .iter()
        .find(|m| m["slug"] == "gpt-5.5")
        .cloned()
        .expect("gpt-5.5 in snapshot");
    extra["slug"] = Value::String(slug.into());
    list.push(extra);
    list
}

#[test]
fn the_refresh_interval_reads_hours_and_zero_turns_it_off() {
    assert_eq!(parse_ttl(None), Some(hours(24)));
    assert_eq!(parse_ttl(Some("  ")), Some(hours(24)));
    assert_eq!(parse_ttl(Some("6")), Some(hours(6)));
    assert_eq!(parse_ttl(Some("0.5")), Some(chrono::Duration::minutes(30)));
    assert_eq!(parse_ttl(Some("0")), None);
    assert_eq!(parse_ttl(Some("-3")), None);
    assert_eq!(parse_ttl(Some("soon")), Some(hours(24)));
}

#[test]
fn failures_back_off_five_minutes_half_an_hour_two_hours_then_six() {
    let t0 = Utc::now();
    let mut backoff = Backoff::default();
    assert_eq!(backoff.gate(), None);
    let gaps: Vec<i64> = (0..5)
        .map(|_| {
            backoff.fail(t0);
            (backoff.gate().unwrap() - t0).num_minutes()
        })
        .collect();
    assert_eq!(gaps, [5, 30, 120, 360, 360]);
    backoff.reset();
    assert_eq!(backoff.gate(), None);
}

#[test]
fn the_scheduler_wakes_at_the_earliest_of_expiry_backoff_and_an_hour() {
    let now = Utc::now();
    let idle = Backoff::default();
    assert_eq!(next_wake(now, None, &idle), now + MAX_SLEEP);
    let soon = now + chrono::Duration::minutes(20);
    assert_eq!(next_wake(now, Some(soon), &idle), soon);
    // An expiry already past is the backoff's business, not a busy loop.
    assert_eq!(next_wake(now, Some(now - hours(2)), &idle), now + MAX_SLEEP);
    let mut failing = Backoff::default();
    failing.fail(now);
    assert_eq!(
        next_wake(now, Some(now - hours(2)), &failing),
        now + chrono::Duration::minutes(5)
    );
}

// ─── What is due ────────────────────────────────────────────────────────

#[tokio::test]
async fn a_custom_catalog_is_rechecked_only_when_the_codex_changes() {
    let env = Env::new();
    env.write(CONFIG_REL, "");
    save_panel(&env, Some(CUSTOMS), FetchPolicy::Never)
        .await
        .unwrap();
    let now = Utc::now();
    let current = runtime("0.160.1", "/fake/a/codex.js");
    assert_eq!(
        assess(&env.published(), &current, now, Some(hours(24))),
        Assessment::default()
    );
    assert_eq!(
        assess(&env.published(), &upgraded(), now, Some(hours(24))).action,
        Some(Action::Recheck)
    );
    // A runtime that could not be read asks for nothing.
    let mut unknown = upgraded();
    unknown.confirmed = false;
    assert_eq!(assess(&env.published(), &unknown, now, None).action, None);
    // The file it references is gone.
    std::fs::remove_file(env.home().join(catalog::CATALOG_REL)).unwrap();
    assert_eq!(
        assess(&env.published(), &current, now, None).action,
        Some(Action::Recheck)
    );
    // codeg's reference removed by hand: no longer codeg's to refresh.
    env.write(CONFIG_REL, "model = \"m\"\n");
    assert_eq!(
        assess(&env.published(), &upgraded(), now, None),
        Assessment::default()
    );
}

#[tokio::test]
async fn a_provider_list_is_fetched_again_when_old_moved_or_a_stand_in() {
    let env = Env::new();
    let (base, _hits) = serve(vec![(200, native_body(&["r1", "r2"]))]).await;
    env.write(CONFIG_REL, &panel_toml(&base));
    env.write(AUTH_REL, AUTH);
    save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    let current = runtime("0.160.1", "/fake/a/codex.js");
    let checked = env.meta().checked_at.unwrap();
    let ttl = Some(hours(24));

    let fresh = assess(&env.published(), &current, checked + hours(1), ttl);
    assert_eq!(fresh.action, None);
    assert!(fresh.provider_source);
    assert_eq!(fresh.expires_at, Some(checked + hours(24)));
    let due = |at: DateTime<Utc>, ttl| assess(&env.published(), &current, at, ttl).action;
    assert_eq!(due(checked + hours(25), ttl), Some(Action::Fetch));
    // The age trigger off: an old list stays.
    assert_eq!(due(checked + hours(24 * 400), None), None);
    // Another codex: the provider answers per `client_version`.
    assert_eq!(
        assess(&env.published(), &upgraded(), checked, ttl).action,
        Some(Action::Fetch)
    );
    // A stand-in, or a list from another request.
    write_meta(&env, |m| m.stale = true);
    assert_eq!(due(checked, ttl), Some(Action::Fetch));
    write_meta(&env, |m| {
        m.stale = false;
        m.degraded = Some("no_provider_list".into());
    });
    assert_eq!(due(checked, ttl), Some(Action::Fetch));
    write_meta(&env, |m| m.degraded = None);
    assert_eq!(due(checked, ttl), None);

    // The request changed outside codeg: another key, another base URL.
    env.write(AUTH_REL, r#"{"OPENAI_API_KEY":"sk-other"}"#);
    assert_eq!(due(checked, ttl), Some(Action::Fetch));
    env.write(AUTH_REL, AUTH);
    let config = env.read(CONFIG_REL).unwrap();
    env.write(CONFIG_REL, &config.replace(&base, "https://elsewhere/v1"));
    assert_eq!(due(checked, ttl), Some(Action::Fetch));
    env.write(CONFIG_REL, &config);
    assert_eq!(due(checked, ttl), None);

    // Nothing runs on its own without a key, under a provider codeg does not
    // configure, or while two codex versions disagree.
    env.write(AUTH_REL, "{}");
    let paused = |env: &Env| assess(&env.published(), &current, checked, ttl).paused;
    assert_eq!(paused(&env), Some("missing_api_key"));
    env.write(AUTH_REL, AUTH);
    env.write(
        CONFIG_REL,
        &config.replace("model_provider = \"codeg\"", "model_provider = \"mine\""),
    );
    assert_eq!(paused(&env), Some("provider_not_codeg"));
    env.write(CONFIG_REL, &config);
    write_meta(&env, |m| m.conflict = m.validated_by.clone());
    assert_eq!(paused(&env), Some("conflict"));
}

// ─── Refreshing what is published ───────────────────────────────────────

/// A catalog codeg built against an older official list is rebuilt against
/// the new one after an upgrade — the new model shows up, in codex's rank
/// behind the custom — without the user re-saving, and nothing the user
/// owns changes.
#[tokio::test]
async fn an_upgrade_rebuilds_a_custom_catalog_against_the_new_officials() {
    let env = Env::new();
    env.write(
        CONFIG_REL,
        "# my codex config\nmodel_provider = \"codeg\"\n",
    );
    hooks::set_officials(Some(
        catalog::bundled_snapshot_models()
            .into_iter()
            .filter(|m| m["slug"] != "gpt-6.1-sol")
            .collect(),
    ));
    save_panel(&env, Some(CUSTOMS), FetchPolicy::Never)
        .await
        .unwrap();
    assert!(!env.catalog_slugs().iter().any(|s| s == "gpt-6.1-sol"));
    let config = env.read(CONFIG_REL).unwrap();

    hooks::set_officials(Some(officials_plus("gpt-test-unshipped")));
    test_hooks::set_runtime(Some(upgraded()));
    let report = refresh_published(&env.home(), Origin::Install, FetchPolicy::Force, &env.cache)
        .await
        .unwrap();
    assert!(matches!(report.outcome, RefreshOutcome::Published(_)));
    let slugs = env.catalog_slugs();
    assert_eq!(slugs[..3], ["gw/x", "gpt-6.1-sol", "gpt-6-astra"]);
    assert!(slugs.iter().any(|s| s == "gpt-test-unshipped"));
    assert_eq!(env.read(catalog::SOURCE_REL).unwrap(), CUSTOMS);
    assert_eq!(env.read(CONFIG_REL).unwrap(), config);
    let meta = env.meta();
    assert_eq!(meta.officials_version.as_deref(), Some("0.161.0"));
    assert_eq!(meta.validated_versions(), ["0.161.0"]);

    // Done once: the same codex finds nothing to do.
    let again = refresh_published(&env.home(), Origin::Install, FetchPolicy::Force, &env.cache)
        .await
        .unwrap();
    assert_eq!(again.outcome, RefreshOutcome::Unchanged);
}

/// Nothing codeg cannot regenerate is touched: no config at all, the user's
/// own catalog, a codeg catalog whose intent is gone (read against the new
/// list, every newly shipped official would look like one the user removed).
#[tokio::test]
async fn a_refresh_leaves_what_codeg_cannot_regenerate_alone() {
    let env = Env::new();
    let home = env.home();
    let refresh = || refresh_published(&home, Origin::Install, FetchPolicy::Force, &env.cache);
    assert_eq!(
        refresh().await.unwrap().outcome,
        RefreshOutcome::Skipped("no_intent")
    );

    let own = "model_catalog_json = \"manual.json\"\n";
    env.write(CONFIG_REL, own);
    env.write(catalog::SOURCE_REL, CUSTOMS);
    assert_eq!(
        refresh().await.unwrap().outcome,
        RefreshOutcome::Skipped("not_published")
    );
    assert!(env.read(catalog::CATALOG_REL).is_none());
    assert_eq!(env.read(CONFIG_REL).unwrap(), own);

    env.write(CONFIG_REL, "");
    save_panel(&env, Some(CUSTOMS), FetchPolicy::Never)
        .await
        .unwrap();
    std::fs::remove_file(env.home().join(catalog::SOURCE_REL)).unwrap();
    let before = env.read(catalog::CATALOG_REL).unwrap();
    hooks::set_officials(Some(officials_plus("gpt-test-unshipped")));
    test_hooks::set_runtime(Some(upgraded()));
    assert_eq!(
        refresh().await.unwrap().outcome,
        RefreshOutcome::Skipped("no_intent")
    );
    assert_eq!(env.read(catalog::CATALOG_REL).unwrap(), before);
}

/// When the new list makes the takeover moot (the only removal names a model
/// codex has since retired), control goes back to codex: the reference goes,
/// the comments stay, and the file follows at the next startup — a codex
/// starting on the old config may still be reading it.
#[tokio::test]
async fn an_upgrade_that_makes_the_takeover_moot_releases_it() {
    let env = Env::new();
    env.write(
        CONFIG_REL,
        "# my codex config\nmodel_provider = \"codeg\"\n\n[model_providers.codeg]\nbase_url = \"https://example.test/v1\"\n",
    );
    hooks::set_officials(Some(officials_plus("gpt-5.4-retired")));
    save_panel(
        &env,
        Some(r#"{"customs":[],"excludedOfficials":["gpt-5.4-retired"]}"#),
        FetchPolicy::Never,
    )
    .await
    .unwrap();
    assert!(env.read(CONFIG_REL).unwrap().contains("model_catalog_json"));

    hooks::set_officials(Some(catalog::bundled_snapshot_models()));
    test_hooks::set_runtime(Some(upgraded()));
    let report = refresh_published(&env.home(), Origin::Install, FetchPolicy::Force, &env.cache)
        .await
        .unwrap();
    assert!(matches!(report.outcome, RefreshOutcome::Published(_)));
    let config = env.read(CONFIG_REL).unwrap();
    assert!(!config.contains("model_catalog_json"), "{config}");
    assert!(config.contains("# my codex config"));
    assert!(config.contains("base_url = \"https://example.test/v1\""));
    assert!(env.read(catalog::SOURCE_REL).is_none());
    assert!(env.read(META_REL).is_none());
    assert!(
        env.read(catalog::CATALOG_REL).is_some(),
        "removed at startup"
    );

    commit::cleanup_released(&env.home()).await.unwrap();
    assert!(env.read(catalog::CATALOG_REL).is_none());
}

#[tokio::test]
async fn a_refresh_never_changes_the_intent_or_the_provider() {
    let env = Env::new();
    let (base, hits) = serve(vec![(200, native_body(&["r1", "r2"]))]).await;
    env.write(CONFIG_REL, &panel_toml(&base));
    env.write(AUTH_REL, AUTH);
    save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    // The user points codex at a provider of their own, by hand.
    let config = env.read(CONFIG_REL).unwrap();
    env.write(
        CONFIG_REL,
        &config.replace("model_provider = \"codeg\"", "model_provider = \"mine\""),
    );
    let report = refresh_published(
        &env.home(),
        Origin::Background,
        FetchPolicy::Force,
        &env.cache,
    )
    .await
    .unwrap();
    assert_eq!(
        report.outcome,
        RefreshOutcome::Skipped("provider_not_codeg")
    );
    assert_eq!(env.read(catalog::SOURCE_REL).unwrap(), NATIVE_INTENT);
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_background_fetch_publishes_changes_and_survives_an_outage() {
    let env = Env::new();
    let (base, _hits) = serve(vec![
        (200, native_body(&["r1", "r2"])),
        (500, "down".into()),
        (200, native_body(&["r1", "r2", "r3"])),
    ])
    .await;
    env.write(CONFIG_REL, &panel_toml(&base));
    env.write(AUTH_REL, AUTH);
    save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    let before = env.read(catalog::CATALOG_REL).unwrap();
    let home = env.home();
    let refresh = || refresh_published(&home, Origin::Background, FetchPolicy::Force, &env.cache);

    let outage = refresh().await.unwrap();
    assert_eq!(outage.outcome, RefreshOutcome::Unchanged);
    assert_eq!(outage.fetch_error.unwrap().code, "http_status");
    assert_eq!(env.read(catalog::CATALOG_REL).unwrap(), before);

    let back = refresh().await.unwrap();
    assert!(matches!(back.outcome, RefreshOutcome::Published(_)));
    assert!(back.fetch_error.is_none());
    assert!(env.catalog_slugs().iter().any(|s| s == "r3"));
    assert_eq!(env.meta().diff.added, ["r3"]);
    // The intent and the user's files are what they were.
    assert_eq!(env.read(catalog::SOURCE_REL).unwrap(), NATIVE_INTENT);
    assert_eq!(env.read(AUTH_REL).unwrap(), AUTH);
}

// ─── Before a launch ────────────────────────────────────────────────────

#[tokio::test]
async fn before_a_launch_a_new_codex_rechecks_the_catalog_once() {
    let env = Env::new();
    env.write(CONFIG_REL, "");
    save_panel(&env, Some(CUSTOMS), FetchPolicy::Never)
        .await
        .unwrap();
    let bytes = env.read(catalog::CATALOG_REL).unwrap();
    assert_eq!(
        prelaunch_check(&env.home(), &env.cache).await.unwrap(),
        PrelaunchOutcome::Fine
    );

    // A new codex that loads it: only the provenance learns so.
    test_hooks::set_runtime(Some(upgraded()));
    let outcome = prelaunch_check(&env.home(), &env.cache).await.unwrap();
    assert!(
        matches!(
            outcome,
            PrelaunchOutcome::Rechecked(RefreshOutcome::Published(_))
        ),
        "{outcome:?}"
    );
    assert_eq!(env.read(catalog::CATALOG_REL).unwrap(), bytes);
    assert_eq!(env.meta().validated_versions(), ["0.161.0"]);
    // The next launch finds it done.
    assert_eq!(
        prelaunch_check(&env.home(), &env.cache).await.unwrap(),
        PrelaunchOutcome::Fine
    );
}

#[tokio::test]
async fn before_a_launch_a_codex_that_refuses_the_catalog_gets_a_rebuilt_one() {
    let env = Env::new();
    env.write(CONFIG_REL, "");
    // Built from an official entry with a field the next codex cannot read.
    let mut old = catalog::bundled_snapshot_models();
    old[0]["shell_type"] = Value::String("REJECT-ME".into());
    hooks::set_officials(Some(old));
    test_hooks::set_judge(Some(Box::new(|_, bytes| {
        Ok(serde_json::from_slice::<Value>(bytes).unwrap()["models"]
            .as_array()
            .unwrap()
            .len())
    })));
    save_panel(&env, Some(CUSTOMS), FetchPolicy::Never)
        .await
        .unwrap();
    assert!(env
        .read(catalog::CATALOG_REL)
        .unwrap()
        .contains("REJECT-ME"));

    hooks::set_officials(Some(catalog::bundled_snapshot_models()));
    test_hooks::set_judge(Some(Box::new(|_, bytes| {
        if String::from_utf8_lossy(bytes).contains("REJECT-ME") {
            Err(JudgeError::Rejected("unknown variant `REJECT-ME`".into()))
        } else {
            Ok(serde_json::from_slice::<Value>(bytes).unwrap()["models"]
                .as_array()
                .unwrap()
                .len())
        }
    })));
    test_hooks::set_runtime(Some(upgraded()));
    let outcome = prelaunch_check(&env.home(), &env.cache).await.unwrap();
    assert!(
        matches!(
            outcome,
            PrelaunchOutcome::Rechecked(RefreshOutcome::Published(_))
        ),
        "{outcome:?}"
    );
    assert!(!env
        .read(catalog::CATALOG_REL)
        .unwrap()
        .contains("REJECT-ME"));
    assert_eq!(env.meta().validated_versions(), ["0.161.0"]);
}

#[tokio::test]
async fn a_home_nobody_used_is_never_created() {
    let env = Env::new();
    let home = env.dir.path().join("never-used");
    assert_eq!(
        prelaunch_check(&home, &env.cache).await.unwrap(),
        PrelaunchOutcome::Fine
    );
    commit::cleanup_released(&home).await.unwrap();
    assert_eq!(
        refresh_published(&home, Origin::Background, FetchPolicy::Force, &env.cache)
            .await
            .unwrap()
            .outcome,
        RefreshOutcome::Skipped("no_intent")
    );
    assert!(!home.exists());
}

// ─── The scheduler ──────────────────────────────────────────────────────

#[tokio::test]
async fn the_scheduler_backs_off_after_a_failure_and_a_forced_run_clears_it() {
    let env = Env::new();
    let (base, hits) = serve(vec![
        (200, native_body(&["r1", "r2"])),
        (500, "down".into()),
        (200, native_body(&["r1", "r2", "r3"])),
    ])
    .await;
    env.write(CONFIG_REL, &panel_toml(&base));
    env.write(AUTH_REL, AUTH);
    save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    write_meta(&env, |m| m.checked_at = m.checked_at.map(|t| t - hours(25)));
    let served = || hits.load(std::sync::atomic::Ordering::SeqCst);

    let mut backoff = Backoff::default();
    let next = run_due(&env.home(), &env.cache, false, &mut backoff).await;
    assert_eq!(served(), 2);
    assert_eq!(backoff.failures, 1);
    let wait = next - Utc::now();
    assert!(
        wait > chrono::Duration::minutes(4) && wait <= chrono::Duration::minutes(5),
        "{wait:?}"
    );
    let failing = status();
    assert_eq!(failing.last_error.unwrap().code, "http_status");
    assert_eq!(failing.consecutive_failures, 1);
    assert!(!failing.in_progress);

    // Inside the backoff window nothing is fetched.
    run_due(&env.home(), &env.cache, false, &mut backoff).await;
    assert_eq!(served(), 2);

    // codex-acp changed: fetched at once.
    run_due(&env.home(), &env.cache, true, &mut backoff).await;
    assert_eq!(served(), 3);
    assert_eq!(backoff.failures, 0);
    assert!(env.catalog_slugs().iter().any(|s| s == "r3"));
    let ok = status();
    assert!(ok.last_error.is_none());
    let expiry = env.meta().checked_at.unwrap() + hours(24);
    assert_eq!(ok.next_refresh_at, Some(expiry));
}

// ─── An interrupted save, and launches ──────────────────────────────────

/// While an interrupted save waits for its file to be put back, a refresh
/// and a launch's check leave it alone: neither writes, the scheduler's
/// status says why, and the launch goes ahead.
#[tokio::test]
async fn a_refresh_and_a_launch_leave_an_unresolved_save_alone() {
    let env = Env::new();
    interrupted_and_edited(&env).await;
    let before = snapshot(&env);
    let err = refresh_published(
        &env.home(),
        Origin::Background,
        FetchPolicy::Never,
        &env.cache,
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, "repair_needed");
    // A codex change makes a recheck due; it reports the repair instead.
    test_hooks::set_runtime(Some(upgraded()));
    let mut backoff = Backoff::default();
    run_due(&env.home(), &env.cache, false, &mut backoff).await;
    assert_eq!(status().last_error.map(|e| e.code), Some("repair_needed"));
    assert_eq!(backoff.failures, 1);
    let err = prelaunch_check(&env.home(), &env.cache).await.unwrap_err();
    assert_eq!(err.code, "repair_needed");
    let started = std::time::Instant::now();
    before_launch_at(env.home(), env.cache.clone(), PRELAUNCH_WAIT).await;
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(snapshot(&env), before, "nothing written");
}

/// Every file under `CODEX_HOME` but the lock and the request counter (a
/// fetch takes a number whatever comes of it), by name.
fn snapshot(env: &Env) -> std::collections::BTreeMap<String, String> {
    std::fs::read_dir(env.home())
        .unwrap()
        .flatten()
        .filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name != commit::lock::LOCK_FILE && name != commit::lock::SEQ_FILE)
        .map(|name| {
            let text = String::from_utf8_lossy(&std::fs::read(env.home().join(&name)).unwrap())
                .into_owned();
            (name, text)
        })
        .collect()
}

/// A launch stops waiting for a check that is held up (here by another
/// commit holding the lock); the check, left running, still lands.
#[tokio::test]
async fn a_launch_stops_waiting_for_a_slow_check_and_the_check_still_lands() {
    let env = Env::new();
    env.write(CONFIG_REL, "");
    save_panel(&env, Some(CUSTOMS), FetchPolicy::Never)
        .await
        .unwrap();
    test_hooks::set_runtime(Some(upgraded()));
    let held = commit::lock::acquire(&env.home(), commit::lock::LOCK_WAIT)
        .await
        .unwrap();
    let started = std::time::Instant::now();
    before_launch_at(env.home(), env.cache.clone(), Duration::from_millis(300)).await;
    let waited = started.elapsed();
    assert!(
        waited >= Duration::from_millis(300) && waited < Duration::from_secs(3),
        "{waited:?}"
    );
    assert_eq!(env.meta().validated_versions(), ["0.160.1"], "not yet");

    drop(held);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while env.meta().validated_versions() != ["0.161.0"] {
        assert!(
            std::time::Instant::now() < deadline,
            "the check never landed"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!commit::interrupted(&env.home()));
}

/// Launches that arrive together after a codex change check once: the
/// first runs codex over the catalog, the others wait at the gate and find
/// it done.
#[tokio::test]
async fn launches_that_arrive_together_run_codex_over_the_catalog_once() {
    let env = Env::new();
    env.write(CONFIG_REL, "");
    save_panel(&env, Some(CUSTOMS), FetchPolicy::Never)
        .await
        .unwrap();
    let judged = std::rc::Rc::new(std::cell::Cell::new(0usize));
    let count = judged.clone();
    test_hooks::set_judge(Some(Box::new(move |_, bytes| {
        count.set(count.get() + 1);
        Ok(serde_json::from_slice::<Value>(bytes).unwrap()["models"]
            .as_array()
            .unwrap()
            .len())
    })));
    test_hooks::set_runtime(Some(upgraded()));
    let home = env.home();
    let outcomes =
        futures::future::join_all((0..10).map(|_| prelaunch_check(&home, &env.cache))).await;
    let rechecked = outcomes
        .iter()
        .filter(|o| matches!(o, Ok(PrelaunchOutcome::Rechecked(_))))
        .count();
    assert_eq!(rechecked, 1, "{outcomes:?}");
    assert!(outcomes.iter().all(Result::is_ok), "{outcomes:?}");
    assert_eq!(judged.get(), 1);
    assert_eq!(env.meta().validated_versions(), ["0.161.0"]);
}

// ─── After an install ───────────────────────────────────────────────────

/// After codeg installs or upgrades codex-acp, what is published is checked
/// with the new codex and the provider asked again, however fresh its list.
#[tokio::test]
async fn an_install_rechecks_and_asks_the_provider_again_however_fresh() {
    let env = Env::new();
    let (base, hits) = serve(vec![
        (200, native_body(&["r1"])),
        (200, native_body(&["r1", "r2"])),
    ])
    .await;
    env.write(CONFIG_REL, &panel_toml(&base));
    env.write(AUTH_REL, AUTH);
    save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    test_hooks::set_runtime(Some(upgraded()));
    let report = refresh_after_install(&env.home(), &env.cache)
        .await
        .unwrap();
    assert!(
        matches!(report.outcome, RefreshOutcome::Published(_)),
        "{:?}",
        report.outcome
    );
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert_eq!(env.catalog_slugs(), ["r1", "r2"]);
    assert_eq!(env.meta().validated_versions(), ["0.161.0"]);
}

/// A refresh after an install that fails — the provider down, or a save
/// waiting for repair — keeps what is published and only reports it; the
/// install itself is not failed by it (`refresh_codex_catalog_after_install`
/// returns nothing to fail with).
#[tokio::test]
async fn a_refresh_that_fails_after_an_install_keeps_what_is_published() {
    let env = Env::new();
    let (base, _) = serve(vec![(200, native_body(&["r1"])), (500, "down".into())]).await;
    env.write(CONFIG_REL, &panel_toml(&base));
    env.write(AUTH_REL, AUTH);
    save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    let before = snapshot(&env);
    let report = refresh_after_install(&env.home(), &env.cache)
        .await
        .unwrap();
    assert_eq!(report.fetch_error.unwrap().code, "http_status");
    assert_eq!(snapshot(&env), before);

    let env = Env::new();
    interrupted_and_edited(&env).await;
    let err = refresh_after_install(&env.home(), &env.cache)
        .await
        .unwrap_err();
    assert_eq!(err.code, "repair_needed");
}

// ─── A catalog from an older codeg ──────────────────────────────────────

/// A catalog an older codeg published has no provenance record: the first
/// launch checks it with the codex about to run and writes one, its binding
/// unknown until the next save says what it is.
#[tokio::test]
async fn a_catalog_from_an_older_codeg_gets_its_provenance_at_the_first_launch() {
    let env = Env::new();
    env.write(CONFIG_REL, "");
    save_panel(&env, Some(CUSTOMS), FetchPolicy::Never)
        .await
        .unwrap();
    std::fs::remove_file(env.home().join(META_REL)).unwrap();
    let catalog_before = env.read(catalog::CATALOG_REL);

    let outcome = prelaunch_check(&env.home(), &env.cache).await.unwrap();
    assert!(
        matches!(
            outcome,
            PrelaunchOutcome::Rechecked(RefreshOutcome::Published(_))
        ),
        "{outcome:?}"
    );
    let meta = env.meta();
    assert_eq!(meta.binding, "unknown");
    assert_eq!(meta.validated_versions(), ["0.160.1"]);
    assert_eq!(env.read(catalog::CATALOG_REL), catalog_before);
    assert_eq!(
        prelaunch_check(&env.home(), &env.cache).await.unwrap(),
        PrelaunchOutcome::Fine
    );

    save_panel(&env, Some(CUSTOMS), FetchPolicy::Never)
        .await
        .unwrap();
    assert_eq!(env.meta().binding, "panel");
}

// ─── The scheduler, on a stand-in clock ─────────────────────────────────

/// A list counts as current exactly its refresh interval; a provider that
/// then fails is asked again exactly 5, then 30 minutes after each failure,
/// and not a moment before.
#[tokio::test]
async fn the_scheduler_asks_again_exactly_when_due_and_at_each_retry_point() {
    use crate::acp::provider_models::clock;
    let minutes = chrono::Duration::minutes;
    let env = Env::new();
    let t0 = "2026-10-22T08:00:00Z".parse::<DateTime<Utc>>().unwrap();
    clock::set(Some(t0));
    let (base, hits) = serve(vec![
        (200, native_body(&["r1"])),
        (500, "down".into()),
        (500, "down".into()),
        (500, "down".into()),
    ])
    .await;
    env.write(CONFIG_REL, &panel_toml(&base));
    env.write(AUTH_REL, AUTH);
    save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    assert_eq!(env.meta().checked_at, Some(t0));
    let served = || hits.load(std::sync::atomic::Ordering::SeqCst);
    let mut backoff = Backoff::default();
    async fn turn_at(env: &Env, t: DateTime<Utc>, backoff: &mut Backoff) -> DateTime<Utc> {
        crate::acp::provider_models::clock::set(Some(t));
        run_due(&env.home(), &env.cache, false, backoff).await
    }

    let due = t0 + hours(24);
    let second = chrono::Duration::seconds(1);
    assert_eq!(turn_at(&env, due - second, &mut backoff).await, due);
    assert_eq!(served(), 1, "still current");

    assert_eq!(turn_at(&env, due, &mut backoff).await, due + minutes(5));
    assert_eq!(served(), 2, "due: asked, and it failed");

    let retry = due + minutes(5);
    assert_eq!(turn_at(&env, retry - second, &mut backoff).await, retry);
    assert_eq!(served(), 2, "inside the backoff");

    assert_eq!(
        turn_at(&env, retry, &mut backoff).await,
        retry + minutes(30)
    );
    assert_eq!(served(), 3);

    let third = retry + minutes(30);
    // Two hours of backoff now, so the hourly wake comes first.
    assert_eq!(turn_at(&env, third, &mut backoff).await, third + hours(1));
    assert_eq!(served(), 4);
    let status = status();
    assert_eq!(status.consecutive_failures, 3);
    assert_eq!(status.next_refresh_at, Some(third + minutes(120)));
    assert_eq!(status.last_error_at, Some(third));
}
