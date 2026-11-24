//! Updates, changes of mode, switching off and on, and repairs, end to end
//! on the install tests' fixture (the stand-in SpaceRing, Codeg's skill
//! store, the plugin store, fake Claude Code and Codex wrappers, OpenCode by
//! its config files). design §13: the mixed-mode update, consent again,
//! Codeg's suspension lifted only by an update, the Experts links taken and
//! given back, a failure midway undone on every agent.

use super::*;
use crate::harness::plugins::update::{
    plan_update, repair, set_enabled, set_host_mode, stale_check, update,
};
use crate::harness::skills::owned::OwnedPlan;

impl Fixture {
    async fn plan_update(&self) -> HarnessPluginUpdatePlan {
        plan_update(&self.local, &self.harness, ID).await.unwrap()
    }

    /// What the prompt sends for `plan`, agreeing to what runs when
    /// `consent`, with every `ack`.
    pub(super) fn update_request(
        &self,
        plan: &HarnessPluginUpdatePlan,
        consent: bool,
    ) -> HarnessPluginUpdateRequest {
        HarnessPluginUpdateRequest {
            item_id: ID.to_string(),
            revision: plan.target.unwrap(),
            state_sha256: plan.state_sha256.clone().unwrap(),
            consent_exec: consent.then(|| plan.consent_exec.clone()).flatten(),
            acks: plan
                .hosts
                .iter()
                .filter_map(|row| Some((row.agent, row.skills.as_ref()?.acks())))
                .collect(),
            experts_acks: plan
                .hosts
                .iter()
                .filter_map(|row| Some((row.agent, row.experts_ack.clone()?)))
                .collect(),
            accept_yanked: false,
        }
    }

    async fn update_with(
        &self,
        local: &PluginsLocal,
        request: HarnessPluginUpdateRequest,
    ) -> HarnessPluginInstallResult {
        update(local, &self.harness, &self.emitter, request)
            .await
            .unwrap()
    }

    pub(super) async fn update(
        &self,
        request: HarnessPluginUpdateRequest,
    ) -> HarnessPluginInstallResult {
        self.update_with(&self.local, request).await
    }

    /// The preflight, then the call with everything it asked for.
    async fn set_host(&self, agent: AgentType, mode: PlanMode) -> HarnessPluginInstallResult {
        let ask = |preflight: bool,
                   state: Option<String>,
                   consent: Option<String>,
                   acks: BTreeMap<String, String>,
                   experts_ack: Option<String>| HarnessPluginSetHostRequest {
            item_id: ID.to_string(),
            agent,
            mode,
            preflight,
            state_sha256: state,
            consent_exec: consent,
            acks,
            experts_ack,
        };
        let first = set_host_mode(
            &self.local,
            &self.harness,
            &self.emitter,
            ask(true, None, None, BTreeMap::new(), None),
        )
        .await
        .unwrap();
        if first.outcome != PluginInstallOutcome::Preflight || !first.issues.is_empty() {
            return first;
        }
        let acks = first
            .skills
            .get(&agent)
            .map(OwnedPlan::acks)
            .unwrap_or_default();
        let consent = first
            .consent_required
            .then(|| first.consent_exec.clone())
            .flatten();
        set_host_mode(
            &self.local,
            &self.harness,
            &self.emitter,
            ask(
                false,
                first.state_sha256.clone(),
                consent,
                acks,
                first.experts_acks.get(&agent).cloned(),
            ),
        )
        .await
        .unwrap()
    }

    async fn switch(&self, agent: AgentType, enabled: bool) -> HarnessPluginInstallResult {
        let ask = |preflight: bool, acks: BTreeMap<String, String>, experts_ack: Option<String>| {
            HarnessPluginSetEnabledRequest {
                item_id: ID.to_string(),
                agent,
                enabled,
                preflight,
                acks,
                experts_ack,
            }
        };
        let first = set_enabled(
            &self.local,
            &self.harness,
            &self.emitter,
            ask(true, BTreeMap::new(), None),
        )
        .await
        .unwrap();
        if first.outcome != PluginInstallOutcome::Preflight || !first.issues.is_empty() {
            return first;
        }
        let acks = first
            .skills
            .get(&agent)
            .map(OwnedPlan::acks)
            .unwrap_or_default();
        set_enabled(
            &self.local,
            &self.harness,
            &self.emitter,
            ask(false, acks, first.experts_acks.get(&agent).cloned()),
        )
        .await
        .unwrap()
    }

    pub(super) async fn repair_with(&self, local: &PluginsLocal) -> HarnessPluginInstallResult {
        let ask =
            |preflight: bool,
             acks: BTreeMap<AgentType, BTreeMap<String, String>>,
             experts_acks: BTreeMap<AgentType, String>| HarnessPluginRepairRequest {
                item_id: ID.to_string(),
                agent: None,
                preflight,
                acks,
                experts_acks,
            };
        let first = repair(
            local,
            &self.harness,
            &self.emitter,
            ask(true, BTreeMap::new(), BTreeMap::new()),
        )
        .await
        .unwrap();
        if first.outcome != PluginInstallOutcome::Preflight {
            return first;
        }
        assert!(first.issues.is_empty(), "{:?}", first.issues);
        let acks = first
            .skills
            .iter()
            .map(|(agent, plan)| (*agent, plan.acks()))
            .collect();
        repair(
            local,
            &self.harness,
            &self.emitter,
            ask(false, acks, first.experts_acks.clone()),
        )
        .await
        .unwrap()
    }

    /// The record's entry changed by hand (what the guard of a later step
    /// does, say).
    pub(super) fn edit_entry(&self, change: impl FnOnce(&mut PluginEntry)) {
        let _held = self.plugins().lock_blocking().unwrap();
        let mut record = record::load_for_write(self.plugins()).unwrap();
        change(record.plugins.get_mut(NAME).unwrap());
        record::save(self.plugins(), &record).unwrap();
    }

    /// The Experts pack's `name` switched on for `agent`.
    fn link_expert_named(&self, agent: AgentType, name: &str) {
        let _held = self.skills().lock_blocking().unwrap();
        let done = apply_blocking(
            self.skills(),
            &SkillsApplyRequest {
                ops: vec![SkillOp {
                    skill: name.into(),
                    agent,
                    action: SkillAction::Enable,
                    ack: None,
                    replace_modified: false,
                }],
                preflight: false,
            },
        )
        .0;
        assert!(done.ok, "{done:?}");
    }

    /// Whether Codex has Codeg's plugin switched on (`None`: not listed).
    pub(super) fn codex_enabled(&self) -> Option<bool> {
        let text = fs::read_to_string(self.codex_home().join("config.toml")).ok()?;
        let doc: toml_edit::Document = text.parse().unwrap();
        doc.get("plugins")?.get(KEY)?.get("enabled")?.as_bool()
    }

    fn member_text(&self, member: &str) -> String {
        fs::read_to_string(self.plugin_store(member).join("SKILL.md")).unwrap_or_default()
    }
}

fn update_row(plan: &HarnessPluginUpdatePlan, agent: AgentType) -> &UpdateHost {
    plan.hosts.iter().find(|row| row.agent == agent).unwrap()
}

/// Revision 1 approved, installed for Claude Code as a plugin and for
/// Gemini as its skills.
pub(super) async fn installed_mixed() -> Fixture {
    let mut fx = Fixture::new().await;
    fx.publish(1, true);
    let done = fx
        .install_planned(&[(CLAUDE, PlanMode::Native), (OPENCODE, PlanMode::None)])
        .await;
    assert_eq!(done.outcome, PluginInstallOutcome::Installed, "{done:?}");
    fx
}

// ─── Which revision ─────────────────────────────────────────────────────

#[tokio::test]
async fn while_the_latest_waits_every_agent_stays_on_full() {
    let mut fx = installed_mixed().await;
    fx.publish(2, false);
    let plan = fx.plan_update().await;
    // Claude Code has it as a plugin: the target is `full`, which is what
    // both agents have.
    assert_eq!(plan.target, Some(1));
    assert!(plan.up_to_date, "{plan:?}");
    assert_eq!(plan.revision_from, 1);
    assert_eq!(plan.latest.as_ref().map(|r| r.revision), Some(2));
    assert!(plan.blocking.is_empty(), "{:?}", plan.blocking);
    assert_eq!(update_row(&plan, GEMINI).action, UpdateAction::None);

    let same = fx.update(fx.update_request(&plan, true)).await;
    assert_eq!(codes_of(&same.issues), vec![codes::UP_TO_DATE]);
    // Not even the skills-only agent goes to the latest.
    let mut ahead = fx.update_request(&plan, true);
    ahead.revision = 2;
    ahead.state_sha256 = fx.state(2);
    let refused = fx.update(ahead).await;
    assert_eq!(refused.outcome, PluginInstallOutcome::Aborted);
    assert_eq!(codes_of(&refused.issues), vec![codes::REVISION_NOT_TARGET]);
    assert_eq!(fx.entry().unwrap().revision, 1);
    assert!(fx.member_text("brainstorming").contains("Revision 1."));
}

#[tokio::test]
async fn skills_only_everywhere_moves_to_the_latest_without_consent() {
    let mut fx = Fixture::new().await;
    fx.publish(1, true);
    let done = fx
        .install_planned(&[(CLAUDE, PlanMode::Skills), (OPENCODE, PlanMode::None)])
        .await;
    assert_eq!(done.outcome, PluginInstallOutcome::Installed, "{done:?}");
    fx.publish(2, false);
    let plan = fx.plan_update().await;
    assert_eq!(plan.target, Some(2));
    assert!(!plan.up_to_date && !plan.needs_consent);
    assert_eq!(plan.version_from.as_deref(), Some("7.0.1"));
    assert_eq!(plan.version_to.as_deref(), Some("7.0.2"));
    assert_eq!(update_row(&plan, CLAUDE).action, UpdateAction::Update);
    let done = fx.update(fx.update_request(&plan, false)).await;
    assert_eq!(done.outcome, PluginInstallOutcome::Updated, "{done:?}");

    let entry = fx.entry().unwrap();
    assert_eq!(entry.revision, 2);
    assert_eq!(entry.state_sha256, fx.state(2));
    assert_eq!(entry.previous_revision, Some(1));
    assert!(entry.consent.is_none());
    assert!(fx.member_text("brainstorming").contains("Revision 2."));
    for agent in ["claude", "gemini"] {
        assert_eq!(
            leads_to(&fx.path(&format!("{agent}/skills/brainstorming"))),
            leads_to(&fx.plugin_store("brainstorming"))
        );
    }
    // The revision before stays until the next operation.
    assert!(fx.revision_dir(1).is_dir() && fx.revision_dir(2).is_dir());
    assert!(fx.journals().is_empty());
}

#[tokio::test]
async fn once_the_latest_is_approved_every_agent_moves_after_agreeing_again() {
    let mut fx = installed_mixed().await;
    fx.publish(2, true);
    let plan = fx.plan_update().await;
    assert_eq!(plan.target, Some(2));
    // What runs changed: agreed to again.
    assert!(plan.needs_consent);
    assert_eq!(plan.consent_exec, Some(fx.exec(2)));
    assert_eq!(update_row(&plan, CLAUDE).action, UpdateAction::Update);
    assert_eq!(update_row(&plan, GEMINI).action, UpdateAction::Update);

    let unasked = fx.update(fx.update_request(&plan, false)).await;
    assert_eq!(codes_of(&unasked.issues), vec![codes::CONSENT_REQUIRED]);
    let mut stale = fx.update_request(&plan, false);
    stale.consent_exec = Some(fx.exec(1));
    let stale = fx.update(stale).await;
    assert_eq!(codes_of(&stale.issues), vec![codes::CONSENT_STALE]);
    assert_eq!(fx.entry().unwrap().revision, 1);

    let done = fx.update(fx.update_request(&plan, true)).await;
    assert_eq!(done.outcome, PluginInstallOutcome::Updated, "{done:?}");
    let entry = fx.entry().unwrap();
    assert_eq!(entry.revision, 2);
    assert_eq!(
        entry.consent.as_ref().map(|c| c.exec.clone()),
        Some(fx.exec(2))
    );
    assert_eq!(entry.exec_sha256, fx.exec(2));
    assert_eq!(fx.host(CLAUDE).state, HostState::Active);
    assert_eq!(fx.host(CLAUDE).host_name.as_deref(), Some(NAME));
    let market = fx.claude_marketplace().unwrap();
    assert_eq!(market["plugins"][0]["source"], json!("./superpowers/2"));
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(true));
    assert!(fx.member_text("brainstorming").contains("Revision 2."));
    assert!(fx.revision_dir(1).is_dir());

    // The next operation lets the revision before go.
    let off = fx.switch(CLAUDE, false).await;
    assert_eq!(off.outcome, PluginInstallOutcome::Changed, "{off:?}");
    assert!(!exists(&fx.revision_dir(1)));
    assert!(fx.revision_dir(2).is_dir());
    assert!(fx.entry().unwrap().previous_revision.is_none());
}

#[tokio::test]
async fn the_same_exec_sha256_needs_no_new_agreement() {
    let mut fx = installed_mixed().await;
    fx.publish(2, true);
    let exec = fx.exec(1);
    let (in_info, in_state) = (exec.clone(), exec.clone());
    fx.version(2, move |v| v["plugin"]["execSha256"] = json!(in_info));
    fx.resolve(2, move |v| {
        v["installed"]["plugin"]["execSha256"] = json!(in_state)
    });
    let plan = fx.plan_update().await;
    assert_eq!(plan.target, Some(2));
    assert!(!plan.needs_consent, "{plan:?}");
    let done = fx.update(fx.update_request(&plan, false)).await;
    assert_eq!(done.outcome, PluginInstallOutcome::Updated, "{done:?}");
    assert_eq!(fx.entry().unwrap().consent.map(|c| c.exec), Some(exec));
}

#[tokio::test]
async fn members_changed_are_told_by_their_tree_hash_and_dropped_ones_give_the_experts_back() {
    let mut fx = Fixture::new().await;
    fx.experts();
    fx.link_expert_named(GEMINI, "writing-plans");
    fx.publish(1, true);
    let done = fx
        .install_planned(&[(CLAUDE, PlanMode::Skills), (OPENCODE, PlanMode::None)])
        .await;
    assert_eq!(done.outcome, PluginInstallOutcome::Installed, "{done:?}");
    let pack_link = fx.path("gemini/skills/writing-plans");
    assert_eq!(fx.host(GEMINI).experts.len(), 1);
    assert_eq!(
        leads_to(&pack_link),
        leads_to(&fx.plugin_store("writing-plans"))
    );

    // Revision 2: `brainstorming` the same, `writing-plans` gone, a new
    // skill, the assistant changed.
    fx.publish_with(2, false, |files| {
        files.push(file(
            "skills/new-skill/SKILL.md",
            "---\nname: new-skill\ndescription: New.\n---\nNew.\n",
            false,
        ));
    });
    let same_tree = sha("brainstorming-1".as_bytes());
    fx.version(2, move |v| {
        v["plugin"]["components"] = json!([
            { "kind": "skill", "name": "brainstorming", "path": "skills/brainstorming",
              "treeSha256": same_tree },
            { "kind": "skill", "name": "new-skill", "path": "skills/new-skill",
              "treeSha256": sha("new-skill-2".as_bytes()) },
            { "kind": "assistant", "name": "code-reviewer", "path": "agents/code-reviewer.md",
              "treeSha256": sha("code-reviewer-2".as_bytes()) }
        ]);
    });
    let plan = fx.plan_update().await;
    let changed: Vec<(String, MemberChangeKind)> = plan
        .changed_members
        .clone()
        .unwrap()
        .into_iter()
        .map(|change| (change.name, change.change))
        .collect();
    assert_eq!(
        changed,
        vec![
            ("new-skill".to_string(), MemberChangeKind::Added),
            ("code-reviewer".to_string(), MemberChangeKind::Changed),
            ("writing-plans".to_string(), MemberChangeKind::Removed),
        ]
    );
    assert_eq!(update_row(&plan, GEMINI).experts_to_give_back.len(), 1);

    let done = fx.update(fx.update_request(&plan, false)).await;
    assert_eq!(done.outcome, PluginInstallOutcome::Updated, "{done:?}");
    for agent in ["claude", "gemini"] {
        assert!(exists(&fx.path(&format!("{agent}/skills/new-skill"))));
    }
    assert!(!exists(&fx.path("claude/skills/writing-plans")));
    assert!(!exists(&fx.plugin_store("writing-plans")));
    // The pack's own skill is back where the plugin's was.
    assert_eq!(
        leads_to(&pack_link),
        leads_to(&fx.skills().store.join("writing-plans"))
    );
    assert!(fx.host(GEMINI).experts.is_empty());
    assert_eq!(
        fx.host(GEMINI).skills,
        vec!["brainstorming".to_string(), "new-skill".to_string()]
    );
    assert_eq!(fx.entry().unwrap().components.len(), 3);
}

// ─── Codeg's suspension ─────────────────────────────────────────────────

#[tokio::test]
async fn a_suspended_agent_runs_again_only_through_an_update_agreed_to() {
    let fx = installed_mixed().await;
    // What the guard does: off in the host, Suspended in the record.
    let off = fx.switch(CLAUDE, false).await;
    assert_eq!(off.outcome, PluginInstallOutcome::Changed, "{off:?}");
    fx.edit_entry(|entry| {
        entry.hosts.get_mut("claude_code").unwrap().state = HostState::suspended("not_approved");
    });
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(false));

    // Not by switching it on.
    let on = fx.switch(CLAUDE, true).await;
    assert_eq!(codes_of(&on.issues), vec![codes::SUSPENDED]);

    // The same revision is approved again: an update to it, agreed to.
    let plan = fx.plan_update().await;
    assert_eq!(plan.target, Some(1));
    assert!(!plan.up_to_date);
    assert!(plan.needs_consent);
    assert_eq!(update_row(&plan, CLAUDE).action, UpdateAction::Resume);
    assert_eq!(update_row(&plan, CLAUDE).to_state, HostState::Active);
    let unasked = fx.update(fx.update_request(&plan, false)).await;
    assert_eq!(codes_of(&unasked.issues), vec![codes::CONSENT_REQUIRED]);
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(false));

    let done = fx.update(fx.update_request(&plan, true)).await;
    assert_eq!(done.outcome, PluginInstallOutcome::Updated, "{done:?}");
    assert_eq!(fx.host(CLAUDE).state, HostState::Active);
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(true));
    assert_eq!(fx.entry().unwrap().revision, 1);
}

// ─── Modes ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_change_of_mode_keeps_the_experts_taken_and_not_at_all_gives_them_back() {
    let mut fx = Fixture::new().await;
    fx.experts();
    fx.link_expert(CLAUDE);
    fx.publish(1, true);
    let done = fx
        .install_planned(&[(CLAUDE, PlanMode::Native), (OPENCODE, PlanMode::None)])
        .await;
    assert_eq!(done.outcome, PluginInstallOutcome::Installed, "{done:?}");
    let claude_link = fx.path("claude/skills/brainstorming");
    assert!(!exists(&claude_link));
    let taken = fx.host(CLAUDE).experts.clone();
    assert_eq!(taken.len(), 1);

    // As its skills: out of Claude Code's plugins, into its skill folder.
    let skills = fx.set_host(CLAUDE, PlanMode::Skills).await;
    assert_eq!(skills.outcome, PluginInstallOutcome::Changed, "{skills:?}");
    let claude = fx.host(CLAUDE);
    assert_eq!(claude.mode, HostMode::Skills);
    assert_eq!(claude.experts, taken);
    assert!(claude.host_name.is_none());
    assert_eq!(claude.skills, MEMBERS.map(String::from).to_vec());
    assert_eq!(
        leads_to(&claude_link),
        leads_to(&fx.plugin_store("brainstorming"))
    );
    assert!(fx.claude_marketplace().is_none());
    assert!(fx.claude_settings()["enabledPlugins"].get(KEY).is_none());

    // As a plugin again: the same revision, agreed to already.
    let native = fx.set_host(CLAUDE, PlanMode::Native).await;
    assert_eq!(native.outcome, PluginInstallOutcome::Changed, "{native:?}");
    assert!(!native.consent_required);
    let claude = fx.host(CLAUDE);
    assert_eq!(claude.mode, HostMode::Native);
    assert_eq!(claude.host_name.as_deref(), Some(NAME));
    assert_eq!(claude.experts, taken);
    assert!(!exists(&claude_link));
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(true));
    // Gemini kept its skills all along.
    assert_eq!(
        leads_to(&fx.path("gemini/skills/brainstorming")),
        leads_to(&fx.plugin_store("brainstorming"))
    );

    // Not at all: the pack's link back.
    let none = fx.set_host(CLAUDE, PlanMode::None).await;
    assert_eq!(none.outcome, PluginInstallOutcome::Changed, "{none:?}");
    assert!(!fx.entry().unwrap().hosts.contains_key("claude_code"));
    assert_eq!(leads_to(&claude_link), Some(fx.expert_store()));
    assert!(fx.claude_marketplace().is_none());

    // The last agent goes only with the uninstall.
    let last = fx.set_host(GEMINI, PlanMode::None).await;
    assert_eq!(codes_of(&last.issues), vec![codes::LAST_HOST]);
    // An agent added as a plugin takes the pack's link over again.
    let back = fx.set_host(CLAUDE, PlanMode::Native).await;
    assert_eq!(back.outcome, PluginInstallOutcome::Changed, "{back:?}");
    assert!(!exists(&claude_link));
    assert_eq!(fx.host(CLAUDE).experts, taken);
    assert!(fx.journals().is_empty());
}

#[tokio::test]
async fn as_a_plugin_again_needs_the_revision_still_approved() {
    let mut fx = Fixture::new().await;
    fx.publish(1, true);
    let done = fx
        .install_planned(&[(CLAUDE, PlanMode::Skills), (OPENCODE, PlanMode::None)])
        .await;
    assert_eq!(done.outcome, PluginInstallOutcome::Installed, "{done:?}");
    fx.resolve(1, |v| v["installed"]["plugin"]["approved"] = json!(false));
    let refused = fx.set_host(CLAUDE, PlanMode::Native).await;
    assert_eq!(refused.outcome, PluginInstallOutcome::Refused);
    assert!(codes_of(&refused.issues).contains(&codes::NOT_APPROVED));
    assert_eq!(fx.host(CLAUDE).mode, HostMode::Skills);
    assert!(fx.take_log().is_empty());
}

// ─── Off and on ─────────────────────────────────────────────────────────

#[tokio::test]
async fn each_mode_switches_off_and_on_and_codex_stays_off_through_an_update() {
    let mut fx = Fixture::new().await;
    fx.publish(1, true);
    let plan = fx
        .plan_for(&[
            (CLAUDE, PlanMode::Native),
            (CODEX, PlanMode::Native),
            (GEMINI, PlanMode::Skills),
        ])
        .await;
    assert!(plan.blocking.is_empty(), "{:?}", plan.blocking);
    let done = fx.install(fx.request(&plan)).await;
    assert_eq!(done.outcome, PluginInstallOutcome::Installed, "{done:?}");
    assert_eq!(fx.codex_enabled(), Some(true));

    // Claude Code: its own switch.
    let off = fx.switch(CLAUDE, false).await;
    assert_eq!(off.outcome, PluginInstallOutcome::Changed, "{off:?}");
    assert_eq!(fx.host(CLAUDE).state, HostState::DisabledByUser);
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(false));
    let again = fx.switch(CLAUDE, false).await;
    assert_eq!(codes_of(&again.issues), vec![codes::UNCHANGED]);
    let on = fx.switch(CLAUDE, true).await;
    assert_eq!(on.outcome, PluginInstallOutcome::Changed, "{on:?}");
    assert_eq!(fx.host(CLAUDE).state, HostState::Active);
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(true));

    // Gemini: its links out, and back.
    let gemini_link = fx.path("gemini/skills/brainstorming");
    let off = fx.switch(GEMINI, false).await;
    assert_eq!(off.outcome, PluginInstallOutcome::Changed, "{off:?}");
    assert!(!exists(&gemini_link));
    assert_eq!(fx.host(GEMINI).state, HostState::DisabledByUser);
    let on = fx.switch(GEMINI, true).await;
    assert_eq!(on.outcome, PluginInstallOutcome::Changed, "{on:?}");
    assert_eq!(
        leads_to(&gemini_link),
        leads_to(&fx.plugin_store("brainstorming"))
    );

    // Codex off, then an update: still off.
    let off = fx.switch(CODEX, false).await;
    assert_eq!(off.outcome, PluginInstallOutcome::Changed, "{off:?}");
    assert_eq!(fx.codex_enabled(), Some(false));
    fx.publish(2, true);
    let plan = fx.plan_update().await;
    assert_eq!(update_row(&plan, CODEX).action, UpdateAction::Update);
    assert_eq!(update_row(&plan, CODEX).to_state, HostState::DisabledByUser);
    let done = fx.update(fx.update_request(&plan, true)).await;
    assert_eq!(done.outcome, PluginInstallOutcome::Updated, "{done:?}");
    assert!(fx
        .take_log()
        .iter()
        .any(|line| line.contains(&format!("plugin add {KEY}"))));
    assert_eq!(fx.codex_enabled(), Some(false));
    assert_eq!(fx.host(CODEX).state, HostState::DisabledByUser);
    assert_eq!(fx.entry().unwrap().revision, 2);
}

#[tokio::test]
async fn switching_on_what_runs_needs_srn_to_vouch_for_it_now() {
    let fx = installed_mixed().await;
    let off = fx.switch(CLAUDE, false).await;
    assert_eq!(off.outcome, PluginInstallOutcome::Changed, "{off:?}");
    fx.resolve(1, |v| v["installed"]["status"] = json!("yanked"));
    let on = fx.switch(CLAUDE, true).await;
    assert_eq!(on.outcome, PluginInstallOutcome::Refused);
    assert_eq!(
        codes_of(&on.issues),
        vec![crate::harness::mcp::model::codes::YANKED]
    );
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(false));
}

// ─── Failures and repair ────────────────────────────────────────────────

#[tokio::test]
async fn a_renamed_plugin_is_refused_and_every_agent_is_put_back() {
    let mut fx = installed_mixed().await;
    fx.publish_with(2, true, |files| {
        let manifest = files
            .iter_mut()
            .find(|file| file.path == ".claude-plugin/plugin.json")
            .unwrap();
        manifest.bytes = json!({ "name": "superpowers-next", "version": "7.0.2" })
            .to_string()
            .into_bytes();
    });
    let plan = fx.plan_update().await;
    // Gemini (skills) goes first, then Claude Code refuses the new name.
    let done = fx.update(fx.update_request(&plan, true)).await;
    assert_eq!(done.outcome, PluginInstallOutcome::Failed, "{done:?}");
    let codes = codes_of(
        &done
            .hosts
            .iter()
            .find(|h| h.agent == CLAUDE)
            .unwrap()
            .issues,
    );
    assert!(codes.contains(&codes::REINSTALL_REQUIRED), "{codes:?}");
    assert!(codes.contains(&hosts::codes::NAME_CHANGED), "{codes:?}");
    let statuses: Vec<(AgentType, HostStepStatus)> =
        done.hosts.iter().map(|h| (h.agent, h.status)).collect();
    assert_eq!(
        statuses,
        vec![
            (GEMINI, HostStepStatus::Undone),
            (CLAUDE, HostStepStatus::Failed)
        ]
    );
    assert!(done.needs_repair.is_empty());

    // Every agent on revision 1, as before.
    let entry = fx.entry().unwrap();
    assert_eq!(entry.revision, 1);
    assert!(entry.hosts.values().all(|h| h.state == HostState::Active));
    assert!(fx.member_text("brainstorming").contains("Revision 1."));
    assert_eq!(
        fx.claude_marketplace().unwrap()["plugins"][0]["source"],
        json!("./superpowers/1")
    );
    assert!(!exists(&fx.revision_dir(2)));
    assert!(fx.journals().is_empty());
}

#[tokio::test]
async fn an_agent_that_cannot_be_put_back_needs_repair_and_is_repaired() {
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
    fx.publish(2, true);

    // Codex fails every `plugin add`: its update, and its way back.
    let failing = PluginsLocal {
        envs: fx.envs_with(&[], &[("FAKE_FAIL", "plugin add*")]),
        ..fx.local.clone()
    };
    let plan = fx.plan_update().await;
    let done = fx
        .update_with(&failing, fx.update_request(&plan, true))
        .await;
    assert_eq!(done.outcome, PluginInstallOutcome::Failed, "{done:?}");
    assert_eq!(done.needs_repair, vec![CODEX]);
    let entry = fx.entry().unwrap();
    assert_eq!(entry.revision, 1);
    assert_eq!(fx.host(CODEX).state, HostState::NeedsRepair);
    assert_eq!(fx.host(CLAUDE).state, HostState::Active);
    assert_eq!(fx.host(GEMINI).state, HostState::Active);
    assert!(entry.held_revisions.contains(&2));
    assert!(fx.revision_dir(2).is_dir());
    assert!(fx.member_text("brainstorming").contains("Revision 1."));
    assert_eq!(
        fx.claude_marketplace().unwrap()["plugins"][0]["source"],
        json!("./superpowers/1")
    );
    // Nothing else for it until it is repaired.
    let mode = fx.set_host(CODEX, PlanMode::Skills).await;
    assert_eq!(codes_of(&mode.issues), vec![codes::NEEDS_REPAIR]);

    // Repaired with Codex working again: back on the record's revision.
    let repaired = fx.repair_with(&fx.local).await;
    assert_eq!(
        repaired.outcome,
        PluginInstallOutcome::Repaired,
        "{repaired:?}"
    );
    assert!(repaired.needs_repair.is_empty());
    let entry = fx.entry().unwrap();
    assert!(entry.hosts.values().all(|h| h.state == HostState::Active));
    assert!(entry.held_revisions.is_empty());
    assert_eq!(fx.codex_enabled(), Some(true));
    assert!(!exists(&fx.revision_dir(2)));
    assert!(fx.journals().is_empty());
    let none = fx.repair_with(&fx.local).await;
    assert_eq!(codes_of(&none.issues), vec![codes::NO_REPAIR_NEEDED]);
}

#[tokio::test]
async fn repair_brings_back_what_an_interrupted_install_left() {
    let mut fx = Fixture::new().await;
    fx.publish(1, true);
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
    let guard = fx.plugins().lock_blocking().unwrap();
    let report = journal::recover(fx.plugins(), &guard);
    drop(guard);
    assert_eq!(report.rolled_back, 1, "{:?}", report.problems);
    assert!(fx
        .entry()
        .unwrap()
        .hosts
        .values()
        .all(|host| host.state == HostState::NeedsRepair));

    let repaired = fx.repair_with(&fx.local).await;
    assert_eq!(
        repaired.outcome,
        PluginInstallOutcome::Repaired,
        "{repaired:?}"
    );
    let entry = fx.entry().unwrap();
    assert!(
        entry.hosts.values().all(|h| h.state == HostState::Active),
        "{:?}",
        entry.hosts
    );
    assert!(entry.held_revisions.is_empty());
    assert_eq!(fx.host(CLAUDE).host_name.as_deref(), Some(NAME));
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(true));
    assert_eq!(
        fx.claude_marketplace().unwrap()["plugins"][0]["source"],
        json!("./superpowers/1")
    );
    for member in MEMBERS {
        assert_eq!(
            leads_to(&fx.path(&format!("gemini/skills/{member}"))),
            leads_to(&fx.plugin_store(member))
        );
    }
    assert!(fx.journals().is_empty());
}

#[tokio::test]
async fn a_repair_never_runs_what_srn_no_longer_vouches_for() {
    let fx = installed_mixed().await;
    fx.edit_entry(|entry| {
        entry.hosts.get_mut("claude_code").unwrap().state = HostState::NeedsRepair;
    });
    fx.resolve(1, |v| v["installed"]["plugin"]["approved"] = json!(false));
    fx.take_log();
    let repaired = fx.repair_with(&fx.local).await;
    assert_eq!(
        repaired.outcome,
        PluginInstallOutcome::Repaired,
        "{repaired:?}"
    );
    // Switched off in Claude Code, never put in again.
    assert_eq!(
        fx.host(CLAUDE).state,
        HostState::suspended(codes::NOT_APPROVED)
    );
    assert!(fx.host(CLAUDE).repair.is_none());
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(false));
    assert_eq!(
        fx.claude_marketplace().unwrap()["plugins"][0]["source"],
        json!("./superpowers/1")
    );
    assert!(!fx
        .take_log()
        .iter()
        .any(|line| line.contains("plugin install")));

    // Approved again: an update agreed to puts it back, on.
    fx.resolve(1, |v| v["installed"]["plugin"]["approved"] = json!(true));
    let plan = fx.plan_update().await;
    assert_eq!(update_row(&plan, CLAUDE).action, UpdateAction::Resume);
    assert!(plan.needs_consent);
    let done = fx.update(fx.update_request(&plan, true)).await;
    assert_eq!(done.outcome, PluginInstallOutcome::Updated, "{done:?}");
    assert_eq!(fx.host(CLAUDE).state, HostState::Active);
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(true));
}

#[tokio::test]
async fn a_host_switched_off_by_the_server_goes_on_with_its_skills_only() {
    let mut fx = installed_mixed().await;
    fx.publish(2, false);
    fx.site.catalog.lock().unwrap().config = json!({ "plugins": { "adapters": {
        "opencode": { "enabled": true, "minVersion": "2.3.2", "maxVersion": null } } } });
    let plan = fx.plan_update().await;
    let claude = update_row(&plan, CLAUDE);
    assert_eq!(claude.action, UpdateAction::ToSkills);
    assert_eq!(claude.to_mode, HostMode::Skills);
    assert_eq!(
        claude.why_not.as_ref().map(|r| r.code.as_str()),
        Some(hosts::codes::ADAPTER_OFF)
    );
    // Chosen as the install chose it (an agent had it as a plugin): `full`,
    // while the latest waits; nothing runs once updated, nothing to agree
    // to.
    assert_eq!(plan.target, Some(1));
    assert!(!plan.needs_consent);
    assert!(!plan.up_to_date);
    let done = fx.update(fx.update_request(&plan, false)).await;
    assert_eq!(done.outcome, PluginInstallOutcome::Updated, "{done:?}");
    let claude = fx.host(CLAUDE);
    assert_eq!(claude.mode, HostMode::Skills);
    assert_eq!(claude.state, HostState::Active);
    assert!(claude.host_name.is_none());
    assert!(fx.claude_marketplace().is_none());
    assert_eq!(
        leads_to(&fx.path("claude/skills/brainstorming")),
        leads_to(&fx.plugin_store("brainstorming"))
    );
    assert!(fx.member_text("brainstorming").contains("Revision 1."));
    assert_eq!(fx.entry().unwrap().revision, 1);
}

#[tokio::test]
async fn a_change_of_mode_cut_short_is_repaired_without_the_other_mode() {
    let mut fx = Fixture::new().await;
    fx.publish(1, true);
    let done = fx
        .install_planned(&[(CLAUDE, PlanMode::Skills), (OPENCODE, PlanMode::None)])
        .await;
    assert_eq!(done.outcome, PluginInstallOutcome::Installed, "{done:?}");
    // Claude Code to a plugin, its commands hanging: given up on midway,
    // after its links went out.
    let slow = fx.with_claude_env(&[("FAKE_SLEEP", "30")]);
    let ask = |preflight: bool, state: Option<String>| HarnessPluginSetHostRequest {
        item_id: ID.to_string(),
        agent: CLAUDE,
        mode: PlanMode::Native,
        preflight,
        state_sha256: state,
        consent_exec: Some(fx.exec(1)),
        acks: BTreeMap::new(),
        experts_ack: None,
    };
    let first = set_host_mode(&slow, &fx.harness, &fx.emitter, ask(true, None))
        .await
        .unwrap();
    assert_eq!(first.outcome, PluginInstallOutcome::Preflight, "{first:?}");
    let cut = tokio::time::timeout(
        Duration::from_secs(5),
        set_host_mode(
            &slow,
            &fx.harness,
            &fx.emitter,
            ask(false, first.state_sha256.clone()),
        ),
    )
    .await;
    assert!(cut.is_err(), "the change should still be running");
    let guard = fx.plugins().lock_blocking().unwrap();
    let report = journal::recover(fx.plugins(), &guard);
    drop(guard);
    assert_eq!(report.rolled_back, 1, "{:?}", report.problems);
    let claude = fx.host(CLAUDE);
    assert_eq!(claude.mode, HostMode::Skills);
    assert_eq!(claude.state, HostState::NeedsRepair);
    let note = claude.repair.clone().unwrap();
    assert_eq!(note.was, Some(HostState::Active));
    assert_eq!(note.other_modes, vec![HostMode::Native]);

    // Repaired: its skills again, nothing of it in Claude Code's plugins.
    let repaired = fx.repair_with(&fx.local).await;
    assert_eq!(
        repaired.outcome,
        PluginInstallOutcome::Repaired,
        "{repaired:?}"
    );
    let claude = fx.host(CLAUDE);
    assert_eq!(claude.state, HostState::Active);
    assert!(claude.repair.is_none());
    assert!(fx.claude_marketplace().is_none());
    assert!(fx.claude_settings()["enabledPlugins"].get(KEY).is_none());
    assert_eq!(
        leads_to(&fx.path("claude/skills/brainstorming")),
        leads_to(&fx.plugin_store("brainstorming"))
    );
    assert!(fx.journals().is_empty());
}

#[tokio::test]
async fn a_failed_commit_takes_the_experts_given_back_out_again() {
    let mut fx = Fixture::new().await;
    fx.experts();
    fx.link_expert_named(GEMINI, "writing-plans");
    fx.publish(1, true);
    let done = fx
        .install_planned(&[(CLAUDE, PlanMode::None), (OPENCODE, PlanMode::None)])
        .await;
    assert_eq!(done.outcome, PluginInstallOutcome::Installed, "{done:?}");
    // Revision 2 drops `writing-plans`: the pack's link would go back.
    fx.publish(2, false);
    fx.version(2, |v| {
        let components = v["plugin"]["components"].as_array_mut().unwrap();
        components.retain(|c| c["name"] != json!("writing-plans"));
    });
    let plan = fx.plan_update().await;
    assert_eq!(update_row(&plan, GEMINI).experts_to_give_back.len(), 1);
    fx.plugins().arm_fault("commit");
    let failed = fx.update(fx.update_request(&plan, false)).await;
    fx.plugins().disarm_faults();
    assert_eq!(failed.outcome, PluginInstallOutcome::Failed, "{failed:?}");
    assert!(failed.needs_repair.is_empty(), "{failed:?}");
    // Revision 1 again, its member where the pack's link would have been.
    let link = fx.path("gemini/skills/writing-plans");
    assert_eq!(leads_to(&link), leads_to(&fx.plugin_store("writing-plans")));
    assert!(fx.member_text("brainstorming").contains("Revision 1."));
    assert_eq!(fx.entry().unwrap().revision, 1);
    assert_eq!(fx.host(GEMINI).experts.len(), 1);
    assert!(fx.journals().is_empty());
}

#[tokio::test]
async fn a_change_planned_from_an_entry_marked_since_is_refused() {
    let fx = installed_mixed().await;
    let before = fx.entry().unwrap();
    assert_eq!(stale_check(&fx.local, before.clone()).await, None);
    // A rollback marks an agent without a new `op`: still another entry.
    fx.edit_entry(|entry| {
        entry
            .hosts
            .get_mut("claude_code")
            .unwrap()
            .mark_needs_repair([]);
    });
    assert_eq!(fx.entry().unwrap().op, before.op);
    assert_eq!(
        stale_check(&fx.local, before).await.as_deref(),
        Some(codes::RECORD_CHANGED)
    );
}

#[tokio::test]
async fn a_folder_changed_on_disk_never_goes_into_a_host() {
    let mut fx = Fixture::new().await;
    fx.publish(1, true);
    let done = fx
        .install_planned(&[(CLAUDE, PlanMode::Skills), (OPENCODE, PlanMode::None)])
        .await;
    assert_eq!(done.outcome, PluginInstallOutcome::Installed, "{done:?}");
    fs::write(fx.revision_dir(1).join("index.js"), "changed\n").unwrap();
    let refused = fx.set_host(CLAUDE, PlanMode::Native).await;
    assert_eq!(
        refused.outcome,
        PluginInstallOutcome::InvalidPackage,
        "{refused:?}"
    );
    assert_eq!(codes_of(&refused.issues), vec![codes::REVISION_MODIFIED]);
    assert_eq!(fx.host(CLAUDE).mode, HostMode::Skills);
    assert!(fx.claude_marketplace().is_none());
    assert!(fx.journals().is_empty());
}

#[tokio::test]
async fn a_repair_leaves_out_an_agent_it_cannot_repair_and_does_the_others() {
    let fx = installed_mixed().await;
    fx.edit_entry(|entry| {
        for host in entry.hosts.values_mut() {
            host.mark_needs_repair([]);
        }
    });
    // Something of the user's where Gemini's member goes.
    let link = fx.path("gemini/skills/brainstorming");
    fs::remove_file(&link).unwrap();
    fs::create_dir_all(&link).unwrap();
    fs::write(link.join("SKILL.md"), "the user's\n").unwrap();
    let repaired = repair(
        &fx.local,
        &fx.harness,
        &fx.emitter,
        HarnessPluginRepairRequest {
            item_id: ID.to_string(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        repaired.outcome,
        PluginInstallOutcome::Repaired,
        "{repaired:?}"
    );
    assert_eq!(repaired.needs_repair, vec![GEMINI]);
    assert_eq!(fx.host(CLAUDE).state, HostState::Active);
    assert_eq!(fx.host(GEMINI).state, HostState::NeedsRepair);
    assert_eq!(
        fs::read_to_string(link.join("SKILL.md")).unwrap(),
        "the user's\n"
    );
}

#[tokio::test]
async fn a_repair_leaves_off_what_was_off_and_switching_on_puts_it_back() {
    let fx = installed_mixed().await;
    let off = fx.switch(CLAUDE, false).await;
    assert_eq!(off.outcome, PluginInstallOutcome::Changed, "{off:?}");
    fx.edit_entry(|entry| {
        entry
            .hosts
            .get_mut("claude_code")
            .unwrap()
            .mark_needs_repair([]);
    });
    assert_eq!(
        fx.host(CLAUDE).repair.and_then(|note| note.was),
        Some(HostState::DisabledByUser)
    );
    fx.take_log();
    let repaired = fx.repair_with(&fx.local).await;
    assert_eq!(
        repaired.outcome,
        PluginInstallOutcome::Repaired,
        "{repaired:?}"
    );
    assert_eq!(fx.host(CLAUDE).state, HostState::DisabledByUser);
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(false));
    assert!(!fx
        .take_log()
        .iter()
        .any(|line| line.contains("plugin install")));
    let on = fx.switch(CLAUDE, true).await;
    assert_eq!(on.outcome, PluginInstallOutcome::Changed, "{on:?}");
    assert_eq!(fx.host(CLAUDE).state, HostState::Active);
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(true));
    assert_eq!(
        fx.claude_marketplace().unwrap()["plugins"][0]["source"],
        json!("./superpowers/1")
    );
}
