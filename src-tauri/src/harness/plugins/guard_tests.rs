//! The plugins guard end to end: the update check (`harness::updates`)
//! over the install tests' fixture — the stand-in SpaceRing answering
//! `/resolve`, the plugin store and record, fake Claude Code — so that what
//! a check's answer says is what switches a plugin off (design §7 「SRN 上已
//! 没有的条目」, §13).

use super::update_tests::installed_mixed;
use super::*;
use crate::harness::mcp::model::codes as shared;
use crate::harness::plugins::guard::Guard;
use crate::harness::plugins::update::plan_update;
use crate::harness::updates::{
    HarnessUpdates, Paths, UpdateChecker, UpdateItem, UpdatePlugin, UpdateState,
};

impl Fixture {
    /// The update check of this machine: the fixture's records and site,
    /// its cache under the data dir, the guard over `local`.
    fn checker_with(&self, local: &PluginsLocal) -> UpdateChecker {
        let paths = Paths {
            cache: self.path("data/cache/harness/updates.json"),
            mcp_record: self.path("codeg/harness/mcp.json"),
            skills_store: self.skills().store.clone(),
            plugins: self.plugins().clone(),
        };
        let (origin, data_dir, backoff) = (
            self.harness.origin.clone(),
            self.path("data"),
            self.harness.backoff,
        );
        UpdateChecker::unscheduled(
            paths,
            Box::new(move || Harness {
                enabled: true,
                origin: origin.clone(),
                cache: Cache::in_data_dir(&data_dir),
                limits: Limits::default(),
                backoff,
            }),
            self.emitter.clone(),
        )
        .with_guard(Guard::fixed(local.clone()))
    }

    fn checker(&self) -> UpdateChecker {
        self.checker_with(&self.local)
    }

    /// "Check now".
    async fn check(&self, checker: &UpdateChecker) -> HarnessUpdates {
        checker.check_now(true).await.unwrap()
    }

    fn running(&self) -> bool {
        self.claude_settings()["enabledPlugins"][KEY] == json!(true)
    }

    /// Whether the fake Claude Code was told to switch something off since
    /// the log was last taken (and forget the log).
    fn disabled_since(&self) -> bool {
        self.take_log()
            .iter()
            .any(|line| line.contains("plugin disable"))
    }
}

fn plugin_item(updates: &HarnessUpdates) -> &UpdateItem {
    updates.items.iter().find(|item| item.id == ID).unwrap()
}

fn plugin_of(updates: &HarnessUpdates) -> &UpdatePlugin {
    plugin_item(updates).plugin.as_ref().unwrap()
}

/// Withdraws revision 1's approval (what the website says once a reviewer
/// takes it back).
fn unapproved(v: &mut Value) {
    v["installed"]["plugin"]["approved"] = json!(false);
}

fn advisory(action: &str, revisions: &[u64]) -> Value {
    json!({ "id": "a1", "severity": "high", "action": action, "revisions": revisions,
            "summary": {}, "publishedAt": "2026-11-20T00:00:00.000Z" })
}

// ─── What switches a plugin off ─────────────────────────────────────────

#[tokio::test]
async fn each_way_srn_stops_vouching_switches_it_off_files_kept() {
    type Change = fn(&mut Value);
    let cases: [(&str, Change, &str, UpdateState); 8] = [
        (
            "approval",
            unapproved,
            codes::NOT_APPROVED,
            UpdateState::Unapproved,
        ),
        (
            "yanked",
            |v| v["installed"]["status"] = json!("yanked"),
            shared::YANKED,
            UpdateState::Yanked,
        ),
        (
            "blocked",
            |v| v["installed"]["status"] = json!("blocked"),
            shared::VERSION_BLOCKED,
            UpdateState::RemovedByHarness,
        ),
        (
            "retired",
            |v| *v = json!({ "status": "retired", "installed": { "revision": 1, "status": "ok" } }),
            shared::ITEM_UNAVAILABLE,
            UpdateState::DisabledByAuthor,
        ),
        (
            "removed",
            |v| *v = json!({ "status": "removed", "installed": { "revision": 1, "status": "ok" } }),
            shared::ITEM_UNAVAILABLE,
            UpdateState::RemovedByHarness,
        ),
        (
            "unavailable",
            |v| *v = json!({ "status": "unavailable" }),
            shared::ITEM_UNAVAILABLE,
            UpdateState::Gone,
        ),
        (
            "advisory",
            |v| v["advisories"] = json!([advisory("disable", &[1])]),
            codes::ADVISORY_DISABLE,
            UpdateState::Latest,
        ),
        (
            "advisory for every revision",
            |v| v["advisories"] = json!([advisory("remove", &[])]),
            codes::ADVISORY_DISABLE,
            UpdateState::Latest,
        ),
    ];
    for (case, change, reason, state) in cases {
        let fx = installed_mixed().await;
        let checker = fx.checker();
        let first = fx.check(&checker).await;
        assert_eq!(plugin_item(&first).state, UpdateState::Latest, "{case}");
        assert!(fx.running(), "{case}");
        fx.take_log();

        fx.resolve(1, change);
        let mut events = fx.events.subscribe();
        let updates = fx.check(&checker).await;
        assert_eq!(plugin_item(&updates).state, state, "{case}");
        assert!(plugin_of(&updates).suspended, "{case}");
        // Off in Claude Code, Suspended in the record, the files kept.
        assert_eq!(
            fx.host(CLAUDE).state,
            HostState::suspended(reason),
            "{case}"
        );
        assert!(!fx.running(), "{case}");
        assert!(fx.disabled_since(), "{case}");
        assert!(exists(&fx.revision_dir(1)), "{case}");
        assert!(exists(
            &fx.claude_config().join("plugins/cache/codeg-harness")
        ));
        assert!(fx.journals().is_empty(), "{case}");
        // The skills-only agent keeps its skills: only marked.
        assert_eq!(fx.host(GEMINI).state, HostState::Active, "{case}");
        assert_eq!(fx.host(GEMINI).mode, HostMode::Skills, "{case}");
        assert!(exists(&fx.plugin_store("brainstorming")), "{case}");
        let seen: Vec<String> = drain(&mut events).into_iter().map(|(c, _)| c).collect();
        assert!(
            seen.iter().any(|c| c == INSTALLED_CHANGED_EVENT),
            "{case}: {seen:?}"
        );

        // A second check with the same answer: nothing more.
        let again = fx.check(&checker).await;
        assert_eq!(plugin_item(&again).state, state, "{case}");
        assert_eq!(fx.host(CLAUDE).state, HostState::suspended(reason));
        assert!(fx.take_log().is_empty(), "{case}");
    }
}

#[tokio::test]
async fn an_advisory_for_another_revision_switches_nothing_off() {
    let fx = installed_mixed().await;
    let checker = fx.checker();
    fx.resolve(1, |v| {
        v["advisories"] = json!([advisory("disable", &[2]), advisory("notify", &[1])])
    });
    fx.take_log();
    let updates = fx.check(&checker).await;
    assert_eq!(plugin_item(&updates).state, UpdateState::Latest);
    assert_eq!(fx.host(CLAUDE).state, HostState::Active);
    assert!(fx.running());
    assert!(!fx.disabled_since());
}

// ─── What does not ──────────────────────────────────────────────────────

#[tokio::test]
async fn full_moving_on_offers_an_update_and_switches_nothing_off() {
    let mut fx = installed_mixed().await;
    let checker = fx.checker();
    // Revision 2 waits for review: every agent stays on 1, nothing to do.
    fx.publish(2, false);
    fx.take_log();
    let waiting = fx.check(&checker).await;
    let item = plugin_item(&waiting);
    assert_eq!(item.state, UpdateState::Latest);
    assert!(!item.update_available);
    assert_eq!(item.latest.as_ref().unwrap().revision, 2);
    assert_eq!(plugin_of(&waiting).target.as_ref().unwrap().revision, 1);

    // Approved: `full` moves to 2. Revision 1 is still approved: it runs,
    // and an update is offered.
    fx.publish(2, true);
    let moved = fx.check(&checker).await;
    let item = plugin_item(&moved);
    assert_eq!(item.state, UpdateState::UpdateAvailable);
    assert!(item.update_available);
    assert_eq!(moved.count, 1);
    let plugin = plugin_of(&moved);
    assert_eq!(plugin.target.as_ref().unwrap().revision, 2);
    assert!(!plugin.suspended);
    // agreed to, and whether 2's differs is the update's plan's to say
    assert!(!plugin.needs_consent);
    assert_eq!(fx.host(CLAUDE).state, HostState::Active);
    assert!(fx.running());
    assert!(!fx.disabled_since());
}

#[tokio::test]
async fn a_check_that_fails_or_does_not_tell_switches_nothing_off() {
    let fx = installed_mixed().await;
    let checker = fx.checker();
    fx.take_log();

    // No answer at all.
    fx.resolve(1, unapproved);
    fx.site.catalog.lock().unwrap().resolve_missing = true;
    let failed = fx.check(&checker).await;
    assert_eq!(failed.error.as_ref().unwrap().code, "resolve_unavailable");
    assert_eq!(fx.host(CLAUDE).state, HostState::Active);
    assert!(fx.running());
    fx.site.catalog.lock().unwrap().resolve_missing = false;
    fx.resolve(1, |v| v["installed"]["plugin"]["approved"] = json!(true));

    // Answers that do not tell: a status this Codeg does not know, no such
    // revision, a revision status it does not know, no plugin part.
    type Change = fn(&mut Value);
    let cases: [(&str, Change); 4] = [
        ("item status", |v| v["status"] = json!("quarantined")),
        ("no such revision", |v| v["installed"] = Value::Null),
        ("revision status", |v| {
            v["installed"]["status"] = json!("frozen");
            v["installed"]["plugin"]["approved"] = json!(false);
        }),
        ("no plugin part", |v| {
            v["installed"].as_object_mut().unwrap().remove("plugin");
        }),
    ];
    for (case, change) in cases {
        let kept = fx.site.catalog.lock().unwrap().resolved[&1].clone();
        fx.resolve(1, change);
        let updates = fx.check(&checker).await;
        assert!(updates.error.is_none(), "{case}");
        assert_eq!(plugin_item(&updates).state, UpdateState::Unknown, "{case}");
        assert_eq!(fx.host(CLAUDE).state, HostState::Active, "{case}");
        assert!(fx.running(), "{case}");
        assert!(!fx.disabled_since(), "{case}");
        fx.resolve(1, |v| *v = kept);
    }
}

#[tokio::test]
async fn a_plugin_without_anything_that_runs_is_only_marked() {
    let fx = installed_mixed().await;
    fx.edit_entry(|entry| entry.autorun.clear());
    let checker = fx.checker();
    fx.resolve(1, unapproved);
    fx.take_log();
    let updates = fx.check(&checker).await;
    assert_eq!(plugin_item(&updates).state, UpdateState::Unapproved);
    assert!(!plugin_of(&updates).suspended);
    assert_eq!(fx.host(CLAUDE).state, HostState::Active);
    assert!(fx.running());
    assert!(!fx.disabled_since());
}

#[tokio::test]
async fn skills_only_everywhere_is_only_marked() {
    let mut fx = Fixture::new().await;
    fx.publish(1, true);
    let done = fx
        .install_planned(&[(CLAUDE, PlanMode::Skills), (OPENCODE, PlanMode::None)])
        .await;
    assert_eq!(done.outcome, PluginInstallOutcome::Installed, "{done:?}");
    let checker = fx.checker();

    // Not approved means nothing to a plugin no agent has whole.
    fx.resolve(1, unapproved);
    let updates = fx.check(&checker).await;
    assert_eq!(plugin_item(&updates).state, UpdateState::Latest);

    // Stopped by its author: marked, nothing switched off.
    fx.resolve(
        1,
        |v| *v = json!({ "status": "retired", "installed": { "revision": 1, "status": "ok" } }),
    );
    fx.take_log();
    let updates = fx.check(&checker).await;
    assert_eq!(plugin_item(&updates).state, UpdateState::DisabledByAuthor);
    for agent in [CLAUDE, GEMINI] {
        assert_eq!(fx.host(agent).state, HostState::Active);
    }
    assert!(exists(&fx.plugin_store("brainstorming")));
    assert!(fx.take_log().is_empty());
}

// ─── After ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn suspended_is_offered_an_update_once_srn_vouches_again_never_turned_on() {
    let mut fx = installed_mixed().await;
    let checker = fx.checker();
    fx.resolve(1, unapproved);
    fx.check(&checker).await;
    assert_eq!(
        fx.host(CLAUDE).state,
        HostState::suspended(codes::NOT_APPROVED)
    );
    fx.take_log();

    // Approved again, the same revision: an update (back on) to offer,
    // with agreement asked again; still off until then.
    fx.resolve(1, |v| v["installed"]["plugin"]["approved"] = json!(true));
    let again = fx.check(&checker).await;
    let item = plugin_item(&again);
    assert_eq!(item.state, UpdateState::UpdateAvailable);
    assert!(item.update_available);
    let plugin = plugin_of(&again);
    assert_eq!(plugin.target.as_ref().unwrap().revision, 1);
    assert!(plugin.needs_consent);
    assert!(plugin.suspended);
    assert!(!fx.running());
    assert!(fx.take_log().is_empty());

    // Withdrawn again, and a newer revision approved: the update goes there.
    fx.resolve(1, unapproved);
    fx.publish(2, true);
    let newer = fx.check(&checker).await;
    let item = plugin_item(&newer);
    assert_eq!(item.state, UpdateState::Unapproved);
    assert!(item.update_available);
    let plugin = plugin_of(&newer);
    assert_eq!(plugin.target.as_ref().unwrap().revision, 2);
    assert!(plugin.needs_consent);
    assert!(plugin.suspended);
    assert!(!fx.running());
    assert!(fx.take_log().is_empty());
    let plan = plan_update(&fx.local, &fx.harness, ID).await.unwrap();
    assert_eq!(plan.target, Some(2));
    assert!(plan.needs_consent);
}

#[tokio::test]
async fn a_host_that_cannot_be_switched_off_needs_repair_and_its_repair_leaves_it_off() {
    let fx = installed_mixed().await;
    let failing = fx.with_claude_env(&[("FAKE_FAIL", "plugin disable*")]);
    let checker = fx.checker_with(&failing);
    fx.resolve(1, unapproved);
    let updates = fx.check(&checker).await;
    // Not left running unrecorded: marked, with what it was to be.
    let host = fx.host(CLAUDE);
    assert_eq!(host.state, HostState::NeedsRepair);
    assert_eq!(
        host.repair.as_ref().unwrap().was,
        Some(HostState::suspended(codes::NOT_APPROVED))
    );
    assert!(fx.running());
    assert!(fx.journals().is_empty());
    assert_eq!(plugin_item(&updates).state, UpdateState::Unapproved);
    // An agent needing repair is the repair's: the next check runs nothing.
    fx.take_log();
    fx.check(&checker).await;
    assert!(fx.take_log().is_empty());

    // The repair switches it off and leaves it Suspended.
    let repaired = fx.repair_with(&fx.local).await;
    assert_eq!(
        repaired.outcome,
        PluginInstallOutcome::Repaired,
        "{repaired:?}"
    );
    assert_eq!(
        fx.host(CLAUDE).state,
        HostState::suspended(codes::NOT_APPROVED)
    );
    assert!(!fx.running());
}

/// What the guard leaves when it stops midway: marked to stay off.
fn left_marked(fx: &Fixture) {
    let host = fx.host(CLAUDE);
    assert_eq!(host.state, HostState::NeedsRepair);
    assert_eq!(
        host.repair.as_ref().unwrap().was,
        Some(HostState::suspended(codes::NOT_APPROVED))
    );
}

/// …and the repair leaves it off, even once SRN approves it again: only an
/// update agreed to turns it on.
async fn repaired_off(fx: &Fixture) {
    fx.resolve(1, |v| v["installed"]["plugin"]["approved"] = json!(true));
    fx.take_log();
    let repaired = fx.repair_with(&fx.local).await;
    assert_eq!(
        repaired.outcome,
        PluginInstallOutcome::Repaired,
        "{repaired:?}"
    );
    assert_eq!(
        fx.host(CLAUDE).state,
        HostState::suspended(codes::NOT_APPROVED)
    );
    assert!(!fx.running());
    assert!(!fx
        .take_log()
        .iter()
        .any(|line| line.contains("plugin install") || line.contains("plugin enable")));
}

#[tokio::test]
async fn a_record_that_cannot_be_written_never_turns_it_back_on() {
    let fx = installed_mixed().await;
    let checker = fx.checker();
    fx.resolve(1, unapproved);
    fx.plugins().arm_fault("commit");
    fx.check(&checker).await;
    fx.plugins().disarm_faults();
    // Off in Claude Code all the same; the record marks it to stay off.
    assert!(!fx.running());
    left_marked(&fx);
    assert!(fx.journals().is_empty());
    repaired_off(&fx).await;
}

#[tokio::test]
async fn a_guard_cut_short_is_recovered_as_marked_to_stay_off() {
    let fx = installed_mixed().await;
    let checker = fx.checker();
    fx.resolve(1, unapproved);
    // As a crash before the commit leaves it: the journal unfinished.
    fx.plugins().arm_fault("commit");
    fx.plugins().arm_fault("rollback");
    fx.check(&checker).await;
    fx.plugins().disarm_faults();
    assert_eq!(fx.journals().len(), 1);
    {
        let guard = fx.plugins().lock_blocking().unwrap();
        journal::recover(fx.plugins(), &guard);
    }
    assert!(fx.journals().is_empty());
    assert!(!fx.running());
    left_marked(&fx);
    repaired_off(&fx).await;
}

#[tokio::test]
async fn a_guard_that_finds_the_lock_held_checks_again_at_the_next_look() {
    let fx = installed_mixed().await;
    // Switched off by the user, and being switched on while the check runs.
    fx.edit_entry(|entry| {
        entry.hosts.get_mut("claude_code").unwrap().state = HostState::DisabledByUser;
    });
    let mut local = fx.local.clone();
    local.plugins.lock_wait = Duration::from_millis(100);
    let checker = fx.checker_with(&local);
    fx.resolve(1, unapproved);
    let held = fx.plugins().lock_blocking().unwrap();
    fx.check(&checker).await;
    drop(held);
    assert_eq!(fx.host(CLAUDE).state, HostState::DisabledByUser);
    // The switch on went through meanwhile.
    fx.edit_entry(|entry| {
        entry.hosts.get_mut("claude_code").unwrap().state = HostState::Active;
    });

    // The scheduler's next look asks again, and the guard acts on that.
    let asked = resolves(&fx);
    checker.look().await;
    assert_eq!(resolves(&fx), asked + 1);
    assert_eq!(
        fx.host(CLAUDE).state,
        HostState::suspended(codes::NOT_APPROVED)
    );
    assert!(!fx.running());
}

/// How many times `/resolve` was asked.
fn resolves(fx: &Fixture) -> usize {
    fx.site
        .catalog
        .lock()
        .unwrap()
        .seen
        .iter()
        .filter(|(_, path)| path == "/api/harness/v1/resolve")
        .count()
}

#[tokio::test]
async fn while_an_advisory_asks_for_it_off_no_update_turns_it_on() {
    let fx = installed_mixed().await;
    let checker = fx.checker();
    fx.resolve(1, |v| v["advisories"] = json!([advisory("disable", &[1])]));
    fx.check(&checker).await;
    assert_eq!(
        fx.host(CLAUDE).state,
        HostState::suspended(codes::ADVISORY_DISABLE)
    );
    // Revision 1 is still approved and `full`: no update back on.
    let updates = fx.check(&checker).await;
    assert!(!plugin_item(&updates).update_available);
    let plan = plan_update(&fx.local, &fx.harness, ID).await.unwrap();
    assert!(
        codes_of(&plan.blocking).contains(&codes::ADVISORY_DISABLE),
        "{:?}",
        plan.blocking
    );
    let request = HarnessPluginUpdateRequest {
        item_id: ID.to_string(),
        revision: 1,
        state_sha256: fx.state(1),
        consent_exec: Some(fx.exec(1)),
        acks: BTreeMap::new(),
        experts_acks: BTreeMap::new(),
        accept_yanked: false,
    };
    let refused = fx.update(request).await;
    assert_ne!(
        refused.outcome,
        PluginInstallOutcome::Updated,
        "{refused:?}"
    );
    assert_eq!(
        fx.host(CLAUDE).state,
        HostState::suspended(codes::ADVISORY_DISABLE)
    );
    assert!(!fx.running());
}

#[tokio::test]
async fn marks_that_cannot_be_written_are_tried_again_on_a_newer_answer() {
    let fx = installed_mixed().await;
    let checker = fx.checker();
    fx.resolve(1, unapproved);
    fx.take_log();
    fx.plugins().arm_fault("record_save");
    fx.check(&checker).await;
    fx.plugins().disarm_faults();
    // Nothing touched, nothing recorded.
    assert_eq!(fx.host(CLAUDE).state, HostState::Active);
    assert!(fx.running());
    assert!(!fx.disabled_since());

    // Asked again at the next look: the newer answer is what counts — an
    // older one is never acted on (an update agreed to since may already
    // have answered it).
    fx.resolve(1, |v| v["installed"]["plugin"]["approved"] = json!(true));
    let asked = resolves(&fx);
    checker.look().await;
    assert_eq!(resolves(&fx), asked + 1);
    assert_eq!(fx.host(CLAUDE).state, HostState::Active);
    assert!(fx.running());

    // Withdrawn again and the marks written: switched off.
    fx.resolve(1, unapproved);
    fx.check(&checker).await;
    assert_eq!(
        fx.host(CLAUDE).state,
        HostState::suspended(codes::NOT_APPROVED)
    );
    assert!(!fx.running());
}
