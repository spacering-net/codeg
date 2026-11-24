//! What step 11 wires up, end to end on the install tests' fixture: the
//! installed list (each host checked read-only), the repair of an agent an
//! uninstall stopped on (the uninstall finished, never undone), the repair
//! after a backup restore (checked, switched off and repointed, never put
//! in or on), and the startup recovery (the plugins' journals before the
//! skills').

use super::update_tests::installed_mixed;
use super::*;
use crate::harness::mcp::model::codes as shared;
use crate::harness::plugins::listing::{self, ListedPlugin};
use crate::harness::updates::{UpdateItem, UpdateState};

impl Fixture {
    async fn listed(&self) -> Vec<ListedPlugin> {
        listing::installed(&self.local, &[])
            .await
            .unwrap()
            .expect("the record reads")
    }

    fn mark_restored(&self) {
        let held = self.plugins().lock_blocking().unwrap();
        let marked = record::mark_restored(self.plugins(), &held).unwrap();
        assert_eq!(marked, Some(self.entry().unwrap().hosts.len()));
    }
}

fn listed_host(row: &ListedPlugin, agent: AgentType) -> &listing::ListedHost {
    row.hosts
        .iter()
        .find(|host| host.agent == agent.as_wire())
        .unwrap()
}

#[tokio::test]
async fn the_list_has_one_row_per_plugin_with_each_host_checked_read_only() {
    let fx = installed_mixed().await;
    fx.take_log();
    let update = UpdateItem {
        id: ID.to_string(),
        revision: 1,
        state: UpdateState::Latest,
        update_available: false,
        latest: None,
        item_ref: Some(REF.to_string()),
        unknown: None,
        plugin: None,
    };
    let rows = listing::installed(&fx.local, std::slice::from_ref(&update))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!((row.name.as_str(), row.item_id.as_str()), (NAME, ID));
    assert_eq!(row.revision, 1);
    assert_eq!(row.version.as_deref(), Some("7.0.1"));
    assert_eq!(row.consent.as_deref(), Some(fx.exec(1).as_str()));
    assert_eq!(row.update.as_ref(), Some(&update));
    assert!(row.problems.is_empty(), "{:?}", row.problems);
    assert_eq!(
        row.members
            .iter()
            .map(|member| member.name.as_str())
            .collect::<Vec<_>>(),
        vec!["brainstorming", "writing-plans", "code-reviewer"]
    );
    let claude = listed_host(row, CLAUDE);
    assert_eq!(claude.host_id.as_deref(), Some("claude"));
    assert_eq!(
        (claude.mode, &claude.state),
        (HostMode::Native, &HostState::Active)
    );
    let verify = claude.verify.as_ref().expect("checked");
    assert!(verify.ok(), "{:?}", verify.problems);
    assert_eq!(verify.enabled, Some(true));
    let gemini = listed_host(row, GEMINI);
    assert_eq!(gemini.mode, HostMode::Skills);
    assert_eq!(gemini.skills, MEMBERS.map(String::from).to_vec());
    assert!(gemini.verify.is_none());
    // Read-only: no host command ran.
    assert!(fx.take_log().is_empty());

    // What does not match the record shows, per host and per plugin.
    let market = fx.plugins().root.join(".claude-plugin/marketplace.json");
    let text = fs::read_to_string(&market)
        .unwrap()
        .replace("./superpowers/1", "./superpowers/9");
    fs::write(&market, text).unwrap();
    fs::write(fx.revision_dir(1).join("index.js"), "changed\n").unwrap();
    let rows = fx.listed().await;
    let verify = listed_host(&rows[0], CLAUDE).verify.clone().unwrap();
    assert_eq!(
        codes_of(&verify.problems),
        vec![hosts::codes::MARKETPLACE_SOURCE_MISMATCH]
    );
    assert_eq!(codes_of(&rows[0].problems), vec![codes::REVISION_MODIFIED]);
    assert!(fx.take_log().is_empty());

    // Switched off, suspended: not checked; the reason is on the row.
    fx.edit_entry(|entry| {
        entry.hosts.get_mut("claude_code").unwrap().state =
            HostState::suspended(codes::NOT_APPROVED);
    });
    let rows = fx.listed().await;
    let claude = listed_host(&rows[0], CLAUDE);
    assert!(claude.verify.is_none());
    assert_eq!(
        claude.suspended_reason.as_deref(),
        Some(codes::NOT_APPROVED)
    );

    // The wire shape the frontend reads.
    let wire = serde_json::to_value(&rows[0]).unwrap();
    assert_eq!(wire["ref"], REF);
    assert_eq!(wire["hosts"][0]["agent"], "claude_code");
    assert_eq!(
        wire["hosts"][0]["state"]["suspended"]["reason"],
        codes::NOT_APPROVED
    );
    assert_eq!(wire["hosts"][1]["mode"], "skills");
    assert!(wire["members"][0]["treeSha256"].is_string());
}

#[tokio::test]
async fn an_unreadable_or_newer_record_is_the_lists_problem_not_a_failure() {
    let fx = installed_mixed().await;
    // Another operation holds the lock: the rows come without the checks.
    let held = fx.plugins().lock_blocking().unwrap();
    let rows = fx.listed().await;
    assert_eq!(codes_of(&rows[0].problems), vec!["lock_busy"]);
    assert!(listed_host(&rows[0], CLAUDE).verify.is_none());
    drop(held);

    let record = fs::read_to_string(&fx.plugins().record).unwrap();
    let mut newer: Value = serde_json::from_str(&record).unwrap();
    newer["format"] = json!(2);
    fs::write(&fx.plugins().record, newer.to_string()).unwrap();
    let problem = listing::installed(&fx.local, &[])
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(problem.code, shared::RECORD_UNREADABLE);
    assert!(problem.detail.unwrap().contains("newer Codeg"));

    fs::write(&fx.plugins().record, "{ not json").unwrap();
    let problem = listing::installed(&fx.local, &[])
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(problem.code, shared::RECORD_UNREADABLE);
}

#[tokio::test]
async fn an_agent_an_uninstall_stopped_on_is_repaired_by_finishing_the_uninstall() {
    let fx = installed_mixed().await;
    let failing = fx.with_claude_env(&[("FAKE_FAIL", "plugin uninstall*")]);
    let partly = fx.uninstall_with(&failing).await;
    assert_eq!(partly.needs_repair, vec![CLAUDE], "{partly:?}");
    let claude = fx.host(CLAUDE);
    assert_eq!(claude.state, HostState::NeedsRepair);
    let note = claude.repair.clone().expect("a note for the repair");
    assert!(note.uninstalling, "{note:?}");
    assert_eq!(note.was, Some(HostState::Active));

    fx.take_log();
    let repaired = fx.repair_with(&fx.local).await;
    assert_eq!(
        repaired.outcome,
        PluginInstallOutcome::Repaired,
        "{repaired:?}"
    );
    // The uninstall again — never the install.
    let log = fx.take_log();
    assert!(
        log.iter().any(|line| line.contains("plugin uninstall")),
        "{log:?}"
    );
    assert!(
        !log.iter().any(|line| line.contains("plugin install")),
        "{log:?}"
    );
    assert!(fx.entry().is_none());
    assert!(fx.claude_marketplace().is_none());
    assert!(fx.claude_settings()["enabledPlugins"].get(KEY).is_none());
    assert!(!exists(&fx.plugins().root.join(NAME)));
    assert!(fx.journals().is_empty());
}

#[tokio::test]
async fn an_uninstall_rolled_back_is_finished_by_the_repair_too() {
    let fx = installed_mixed().await;
    // The record cannot be written at the commit: rolled back, every agent
    // a step touched marked — as uninstalling.
    fx.plugins().arm_fault("commit");
    let failed = fx.uninstall().await;
    fx.plugins().disarm_faults();
    assert_eq!(failed.outcome, UninstallOutcome::WriteFailed, "{failed:?}");
    let entry = fx.entry().unwrap();
    assert_eq!(entry.hosts.len(), 2);
    for host in entry.hosts.values() {
        assert_eq!(host.state, HostState::NeedsRepair);
        assert!(host.repair.as_ref().is_some_and(|note| note.uninstalling));
    }

    fx.take_log();
    let repaired = fx.repair_with(&fx.local).await;
    assert_eq!(
        repaired.outcome,
        PluginInstallOutcome::Repaired,
        "{repaired:?}"
    );
    assert!(!fx
        .take_log()
        .iter()
        .any(|line| line.contains("plugin install")));
    assert!(fx.entry().is_none());
    for member in MEMBERS {
        assert!(!exists(&fx.path(&format!("gemini/skills/{member}"))));
    }
    assert!(fx.claude_marketplace().is_none());
}

#[tokio::test]
async fn after_a_restore_the_repair_keeps_what_matches_and_never_puts_anything_in() {
    let fx = installed_mixed().await;
    fx.mark_restored();
    for host in fx.entry().unwrap().hosts.values() {
        assert_eq!(host.state, HostState::NeedsRepair);
        assert!(host.repair.as_ref().is_some_and(|note| note.restored));
    }
    let rows = fx.listed().await;
    assert!(rows[0]
        .hosts
        .iter()
        .all(|host| host.repair.as_ref().is_some_and(|note| note.restored)));

    fx.take_log();
    let repaired = fx.repair_with(&fx.local).await;
    assert_eq!(
        repaired.outcome,
        PluginInstallOutcome::Repaired,
        "{repaired:?}"
    );
    assert!(!fx
        .take_log()
        .iter()
        .any(|line| line.contains("plugin install") || line.contains("plugin enable")));
    // Claude Code has it as the record says: it goes on running it.
    assert_eq!(fx.host(CLAUDE).state, HostState::Active);
    assert!(fx.host(CLAUDE).repair.is_none());
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(true));
    // The skills agent has its members as the record says.
    assert_eq!(fx.host(GEMINI).state, HostState::Active);
    for member in MEMBERS {
        assert_eq!(
            leads_to(&fx.path(&format!("gemini/skills/{member}"))),
            leads_to(&fx.plugin_store(member))
        );
    }
}

#[tokio::test]
async fn after_a_restore_a_host_that_does_not_match_is_only_switched_off_and_repointed() {
    let fx = installed_mixed().await;
    // The restored store's marketplace points at another revision than the
    // record's: Claude Code would load something the record does not say.
    let market = fx.plugins().root.join(".claude-plugin/marketplace.json");
    let text = fs::read_to_string(&market)
        .unwrap()
        .replace("./superpowers/1", "./superpowers/7");
    fs::write(&market, text).unwrap();
    fx.mark_restored();

    fx.take_log();
    let repaired = fx.repair_with(&fx.local).await;
    assert_eq!(
        repaired.outcome,
        PluginInstallOutcome::Repaired,
        "{repaired:?}"
    );
    let log = fx.take_log();
    assert!(
        !log.iter()
            .any(|line| line.contains("plugin install") || line.contains("plugin enable")),
        "{log:?}"
    );
    // Off — the user may switch it on again — and pointed at the record's
    // revision.
    assert_eq!(fx.host(CLAUDE).state, HostState::DisabledByUser);
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(false));
    assert_eq!(
        fx.claude_marketplace().unwrap()["plugins"][0]["source"],
        json!("./superpowers/1")
    );
}

#[tokio::test]
async fn the_startup_recovers_the_plugin_journals_before_the_skills() {
    let fx = two_revisions().await;
    let slow = fx.with_claude_env(&[("FAKE_SLEEP", "30")]);
    let plan = fx
        .plan_with(
            &slow,
            &[(CLAUDE, PlanMode::Native), (OPENCODE, PlanMode::None)],
        )
        .await;
    let request = fx.request(&plan);
    let cut = tokio::time::timeout(Duration::from_secs(5), fx.install_with(&slow, request)).await;
    assert!(cut.is_err(), "the install should still be running");
    assert_eq!(fx.journals().len(), 1);

    let (skills, plugins) = (fx.skills().clone(), fx.plugins().clone());
    let report = tokio::task::spawn_blocking(move || {
        crate::skills::startup::run_blocking(&skills, &plugins)
    })
    .await
    .unwrap();
    assert_eq!(report.order, vec!["plugins", "skills"]);
    let plugins = report.plugins.as_ref().expect("the plugins lock was had");
    assert_eq!(plugins.rolled_back, 1, "{:?}", plugins.problems);
    assert!(fx.journals().is_empty());
    assert!(fx
        .entry()
        .unwrap()
        .hosts
        .values()
        .all(|host| host.state == HostState::NeedsRepair));
    // Never a host command at startup.
    assert!(!fx
        .take_log()
        .iter()
        .any(|line| line.contains("plugin uninstall")));
}

#[tokio::test]
async fn after_a_restore_codex_is_only_switched_off_whatever_its_copy_looks_like() {
    let mut fx = Fixture::new().await;
    fx.publish(1, true);
    let plan = fx
        .plan_for(&[
            (CLAUDE, PlanMode::Native),
            (CODEX, PlanMode::Native),
            (GEMINI, PlanMode::Skills),
        ])
        .await;
    let done = fx.install(fx.request(&plan)).await;
    assert_eq!(done.outcome, PluginInstallOutcome::Installed, "{done:?}");
    assert_eq!(fx.codex_enabled(), Some(true));
    fx.mark_restored();

    fx.take_log();
    let repaired = fx.repair_with(&fx.local).await;
    assert_eq!(
        repaired.outcome,
        PluginInstallOutcome::Repaired,
        "{repaired:?}"
    );
    // Codex runs its own copy, which cannot be told from another
    // revision's: off, never put in again.
    assert_eq!(fx.host(CODEX).state, HostState::DisabledByUser);
    assert_eq!(fx.codex_enabled(), Some(false));
    assert!(!fx
        .take_log()
        .iter()
        .any(|line| line.contains("plugin add") || line.contains("plugin install")));
    assert_eq!(fx.host(CLAUDE).state, HostState::Active);
}

#[tokio::test]
async fn an_agent_whose_settings_cannot_be_read_is_never_reached_with_a_guessed_environment() {
    let fx = installed_mixed().await;
    let unread = PluginsLocal {
        missing_envs: [CLAUDE].into_iter().collect(),
        ..fx.local.clone()
    };
    // The list does not check it.
    let rows = listing::installed(&unread, &[]).await.unwrap().unwrap();
    assert!(listed_host(&rows[0], CLAUDE).verify.is_none());

    fx.take_log();
    let partly = fx.uninstall_with(&unread).await;
    assert_eq!(partly.needs_repair, vec![CLAUDE], "{partly:?}");
    let claude = partly.hosts.iter().find(|h| h.agent == CLAUDE).unwrap();
    assert_eq!(codes_of(&claude.issues), vec![codes::ENV_UNREADABLE]);
    assert!(fx.take_log().is_empty());
    // Kept, with its files, for the repair once the settings read again.
    assert!(fx.host(CLAUDE).repair.as_ref().unwrap().uninstalling);
    assert!(fx.revision_dir(1).is_dir());
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(true));
    let repaired = fx.repair_with(&fx.local).await;
    assert_eq!(
        repaired.outcome,
        PluginInstallOutcome::Repaired,
        "{repaired:?}"
    );
    assert!(fx.entry().is_none());
}

#[tokio::test]
async fn a_start_after_a_restore_with_waiting_journals_marks_what_it_rolls_back_as_restored() {
    let fx = two_revisions().await;
    // An install the backup caught midway, and a journal that cannot be read.
    let slow = fx.with_claude_env(&[("FAKE_SLEEP", "30")]);
    let plan = fx
        .plan_with(
            &slow,
            &[(CLAUDE, PlanMode::Native), (OPENCODE, PlanMode::None)],
        )
        .await;
    let request = fx.request(&plan);
    let cut = tokio::time::timeout(Duration::from_secs(5), fx.install_with(&slow, request)).await;
    assert!(cut.is_err(), "the install should still be running");
    let ops = fx.plugins().root.join(".ops");
    fs::write(ops.join("op-0.json"), "{ not json").unwrap();
    // As the restore leaves it: the operations that came with the backup.
    let mark = fx.plugins().root.join(journal::RESTORED_MARK);
    journal::mark_restored_journals(fx.plugins()).unwrap();
    let listed: Vec<String> = serde_json::from_slice(&fs::read(&mark).unwrap()).unwrap();
    assert_eq!(listed.len(), 2);
    let run = |fx: &Fixture| {
        let (skills, plugins) = (fx.skills().clone(), fx.plugins().clone());
        tokio::task::spawn_blocking(move || crate::skills::startup::run_blocking(&skills, &plugins))
    };
    let report = run(&fx).await.unwrap();
    assert_eq!(report.plugins.as_ref().unwrap().rolled_back, 1);
    // What the rollback brought in is repaired as after a restore; the mark
    // stays for the journal still waiting.
    for host in fx.entry().unwrap().hosts.values() {
        assert_eq!(host.state, HostState::NeedsRepair);
        assert!(host.repair.as_ref().is_some_and(|note| note.restored));
    }
    assert!(mark.exists());

    // Nothing else is marked again by a start that rolls nothing back; the
    // mark goes once no journal is left.
    fx.edit_entry(|entry| {
        for host in entry.hosts.values_mut() {
            host.state = HostState::Active;
            host.repair = None;
        }
    });
    run(&fx).await.unwrap();
    assert!(fx
        .entry()
        .unwrap()
        .hosts
        .values()
        .all(|host| host.repair.is_none()));
    assert!(mark.exists());
    fs::remove_file(ops.join("op-0.json")).unwrap();
    run(&fx).await.unwrap();
    assert!(!mark.exists());
    assert!(fx
        .entry()
        .unwrap()
        .hosts
        .values()
        .all(|host| host.repair.is_none()));
}

#[tokio::test]
async fn a_restores_mark_leaves_the_rollback_of_any_other_operation_as_it_was() {
    let fx = two_revisions().await;
    let slow = fx.with_claude_env(&[("FAKE_SLEEP", "30")]);
    let plan = fx
        .plan_with(
            &slow,
            &[(CLAUDE, PlanMode::Native), (OPENCODE, PlanMode::None)],
        )
        .await;
    let request = fx.request(&plan);
    let cut = tokio::time::timeout(Duration::from_secs(5), fx.install_with(&slow, request)).await;
    assert!(cut.is_err(), "the install should still be running");
    // A restore's mark for another operation, still waiting.
    let ops = fx.plugins().root.join(".ops");
    fs::write(ops.join("op-0.json"), "{ not json").unwrap();
    let mark = fx.plugins().root.join(journal::RESTORED_MARK);
    fs::write(&mark, serde_json::to_vec(&["op-0"]).unwrap()).unwrap();

    let guard = fx.plugins().lock_blocking().unwrap();
    let report = journal::recover(fx.plugins(), &guard);
    drop(guard);
    assert_eq!(report.rolled_back, 1, "{:?}", report.problems);
    for host in fx.entry().unwrap().hosts.values() {
        assert_eq!(host.state, HostState::NeedsRepair);
        assert!(!host.repair.as_ref().is_some_and(|note| note.restored));
    }
    journal::clear_restored_mark(fx.plugins()).unwrap();
    assert!(mark.exists());
    fs::remove_file(ops.join("op-0.json")).unwrap();
    journal::clear_restored_mark(fx.plugins()).unwrap();
    assert!(!mark.exists());
}
