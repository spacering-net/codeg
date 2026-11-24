//! A plugin's member skills in "skills only" mode (`super::owned`), over a
//! store and agent directories of the test's own (`skills::tests::
//! fixture_ctx_with`). Nothing reads or writes the real home.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::acp::types::{AgentSkillOwner, AgentSkillScope};
use crate::harness::mcp::model::Reason;
use crate::harness::plugins::lock::PluginsGuard;
use crate::harness::plugins::{InstallName, PluginsCtx};
use crate::models::agent::AgentType;
use crate::skills::apply::apply_blocking;
use crate::skills::link::{LinkStrategy, PlatformLinks};
use crate::skills::model::{
    codes as skill_codes, CellState, SkillAction, SkillOp, SkillsApplyRequest,
};
use crate::skills::owned::{
    experts_linked, relink_experts, unlink_experts, ExpertLink, HeldBy, PluginOwner,
};
use crate::skills::world::{Entry, World};
use crate::skills::SkillsCtx;

use super::manifest::{self, ManifestEntry};
use super::model::{codes, Rewrites};
use super::owned::*;
use super::package::PackageFile;

const PLUGIN: &str = "superpowers";
const ITEM: &str = "0199-superpowers";

struct Fx {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    ctx: SkillsCtx,
    _plugins: PluginsCtx,
    // Held for the whole test, as the plugins module does.
    guard: PluginsGuard,
    owner: PluginOwner,
}

fn fx() -> Fx {
    fx_with(Arc::new(PlatformLinks))
}

fn fx_with(linker: Arc<dyn LinkStrategy>) -> Fx {
    let tmp = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(tmp.path()).unwrap();
    let ctx = crate::skills::tests::fixture_ctx_with(&root, linker);
    let plugins = PluginsCtx::at(&root.join("codeg"));
    let guard = plugins.lock_blocking().unwrap();
    let owner = PluginOwner::new(&guard, &InstallName::parse(PLUGIN).unwrap());
    Fx {
        _tmp: tmp,
        root,
        ctx,
        _plugins: plugins,
        guard,
        owner,
    }
}

fn member(name: &str, body: &str) -> OwnedMember {
    OwnedMember {
        name: name.to_string(),
        files: vec![
            PackageFile {
                path: "SKILL.md".into(),
                bytes: format!(
                    "---\nname: {name}\ndescription: {name}, the plugin's\n---\n{body}\n"
                )
                .into_bytes(),
                executable: false,
            },
            PackageFile {
                path: "refs/notes.md".into(),
                bytes: format!("notes of {name}\n").into_bytes(),
                executable: false,
            },
        ],
    }
}

fn origin(revision: u64) -> OwnedOrigin {
    OwnedOrigin {
        item_id: ITEM.into(),
        item_ref: "obra/superpowers".into(),
        revision,
        version: Some(format!("7.0.{revision}")),
        archive_sha256: Some("a".repeat(64)),
        source: None,
        state_sha256: format!("state-{revision}"),
    }
}

fn names(members: &[OwnedMember]) -> Vec<String> {
    members.iter().map(|m| m.name.clone()).collect()
}

fn codes_of(reasons: &[Reason]) -> Vec<&str> {
    reasons.iter().map(|r| r.code.as_str()).collect()
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

impl Fx {
    /// A plugin store of its own for the startup task (this test holds the
    /// plugins lock of its own throughout).
    fn startup_plugins(&self) -> PluginsCtx {
        PluginsCtx::at(&self.root.join("startup-codeg"))
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    fn own_store(&self) -> PathBuf {
        self.ctx.store.join(".plugins").join(PLUGIN)
    }

    fn put(
        &self,
        agent: AgentType,
        revision: u64,
        members: &[OwnedMember],
        replace: bool,
    ) -> OwnedReport {
        let plan = plan_owned(&self.ctx, &self.owner, agent, &names(members));
        let held = self.ctx.lock_blocking().unwrap();
        let call = if replace {
            replace_owned
        } else {
            install_owned
        };
        call(
            &self.ctx,
            &held,
            &self.owner,
            agent,
            &origin(revision),
            members,
            &plan.acks(),
        )
    }

    fn install(&self, agent: AgentType, members: &[OwnedMember]) -> OwnedReport {
        self.put(agent, 1, members, false)
    }

    fn remove(&self, agent: AgentType) -> OwnedReport {
        let plan = plan_remove_owned(&self.ctx, &self.owner, agent);
        let held = self.ctx.lock_blocking().unwrap();
        remove_owned(&self.ctx, &held, &self.owner, agent, &plan.acks())
    }

    fn apply(
        &self,
        ctx: &SkillsCtx,
        skill: &str,
        agent: AgentType,
        action: SkillAction,
    ) -> crate::skills::model::SkillsApplyResult {
        let _held = self.ctx.lock_blocking().unwrap();
        apply_blocking(
            ctx,
            &SkillsApplyRequest {
                ops: vec![SkillOp {
                    skill: skill.into(),
                    agent,
                    action,
                    ack: None,
                    replace_modified: false,
                }],
                preflight: false,
            },
        )
        .0
    }

    fn experts(&self) {
        let report = crate::commands::experts::install_in(&self.ctx);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
    }

    /// Where the entry leads, made canonical.
    fn leads_to(&self, path: &Path) -> Option<PathBuf> {
        fs::canonicalize(path).ok()
    }

    fn manifest(&self) -> manifest::Manifest {
        manifest::load(&self.own_store()).unwrap()
    }

    fn entry(&self, path: &Path) -> Entry {
        World::load(&self.ctx).entry(path)
    }
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

fn tree_hash(dir: &Path) -> String {
    crate::skills::fsio::hash_skill_dir(dir, "x").unwrap()
}

// ─── Install, a second agent, update, remove ────────────────────────────

#[test]
fn a_plugins_skills_go_into_its_own_store_and_link_under_their_own_names() {
    let fx = fx();
    fx.experts();
    let pack_copy = tree_hash(&fx.ctx.store.join("brainstorming"));
    let members = [
        member("brainstorming", "the plugin's"),
        member("plan-well", "plans"),
    ];

    let report = fx.install(AgentType::ClaudeCode, &members);
    assert_eq!(report.outcome, OwnedOutcome::Done, "{:?}", report.issues);
    assert_eq!(report.added, vec!["brainstorming", "plan-well"]);
    assert_eq!(report.linked, vec!["brainstorming", "plan-well"]);
    assert!(report.store_changed);
    assert_eq!(report.touched, vec![AgentType::ClaudeCode]);

    // Its own store, its own manifest; the pack's skill untouched.
    let own = fx.own_store();
    assert_eq!(
        read(&own.join("brainstorming/refs/notes.md")),
        "notes of brainstorming\n"
    );
    assert_eq!(tree_hash(&fx.ctx.store.join("brainstorming")), pack_copy);
    let manifest = fx.manifest();
    let entry = &manifest.skills["brainstorming"];
    assert_eq!(entry.plugin.as_deref(), Some(PLUGIN));
    assert_eq!((entry.item_id.as_str(), entry.revision), (ITEM, 1));
    assert!(manifest.find_item(ITEM).is_none());
    assert!(super::installed_skills_in(&fx.ctx).unwrap().is_empty());

    // Linked under the skill's own name, into the plugin's store.
    let link = fx.path("claude/skills/brainstorming");
    assert_eq!(
        fx.leads_to(&link),
        fs::canonicalize(own.join("brainstorming")).ok()
    );
    assert!(matches!(
        fx.entry(&link),
        Entry::Owned { ref plugin, ref skill, copy: false, broken: false, .. }
            if plugin == PLUGIN && skill == "brainstorming"
    ));

    // The pack's cell for Claude: provided by the plugin.
    let cell = World::load(&fx.ctx).cell(AgentType::ClaudeCode, "brainstorming");
    assert_eq!(cell.state, CellState::LinkedElsewhere);
    assert_eq!(cell.plugin.as_deref(), Some(PLUGIN));

    // The inventory lists the members apart, with their plugin.
    let inventory = crate::skills::world::inventory(&fx.ctx);
    assert_eq!(
        inventory
            .skills
            .iter()
            .filter(|s| s.id == "brainstorming")
            .count(),
        1
    );
    let listed: Vec<(&str, Option<&str>, Option<&str>)> = inventory
        .plugin_skills
        .iter()
        .map(|s| {
            (
                s.id.as_str(),
                s.plugin.as_deref(),
                s.harness.as_ref().and_then(|h| h.plugin.as_deref()),
            )
        })
        .collect();
    assert_eq!(
        listed,
        vec![
            ("brainstorming", Some(PLUGIN), Some(PLUGIN)),
            ("plan-well", Some(PLUGIN), Some(PLUGIN))
        ]
    );
    let claude = inventory.plugin_skills[0]
        .cells
        .iter()
        .find(|c| c.agent == AgentType::ClaudeCode)
        .unwrap();
    assert_eq!(claude.state, CellState::Linked);

    // The Skills page says whose it is.
    let mut items = crate::commands::acp::list_skills_from_dir(
        AgentSkillScope::Global,
        &fx.path("claude/skills"),
        crate::commands::acp::SkillStorageKind::SkillDirectoryOnly,
    )
    .unwrap();
    crate::skills::world::annotate_items(&fx.ctx.store, &mut items);
    let item = items.iter().find(|i| i.id == "brainstorming").unwrap();
    assert_eq!(
        (item.owner, item.plugin.as_deref()),
        (AgentSkillOwner::Harness, Some(PLUGIN))
    );

    // A second agent: nothing new in the store, only its links.
    let gemini = fx.install(AgentType::Gemini, &members);
    assert_eq!(gemini.outcome, OwnedOutcome::Done, "{:?}", gemini.issues);
    assert!(gemini.added.is_empty() && gemini.replaced.is_empty() && !gemini.store_changed);
    assert_eq!(gemini.linked, vec!["brainstorming", "plan-well"]);
    assert!(exists(&fx.path("gemini/skills/plan-well")));

    // The same call again does nothing.
    let again = fx.install(AgentType::ClaudeCode, &members);
    assert_eq!(again.outcome, OwnedOutcome::Done);
    assert!(again.linked.is_empty() && again.added.is_empty() && !again.store_changed);
    assert!(again.touched.is_empty());
}

#[test]
fn an_update_swaps_the_set_and_a_dropped_member_waits_for_the_last_agent() {
    let fx = fx();
    let v1 = [member("alpha", "one"), member("beta", "one")];
    for agent in [AgentType::ClaudeCode, AgentType::Gemini] {
        assert_eq!(fx.install(agent, &v1).outcome, OwnedOutcome::Done);
    }
    let v2 = [member("alpha", "two"), member("gamma", "two")];

    let claude = fx.put(AgentType::ClaudeCode, 2, &v2, true);
    assert_eq!(claude.outcome, OwnedOutcome::Done, "{:?}", claude.issues);
    assert_eq!(claude.replaced, vec!["alpha"]);
    assert_eq!(claude.added, vec!["gamma"]);
    assert_eq!(claude.linked, vec!["gamma"]);
    assert_eq!(claude.unlinked, vec!["beta"]);
    // Gemini still links beta: it stays until Gemini's own call.
    assert_eq!(claude.kept, vec!["beta"]);
    assert!(claude.removed.is_empty());
    assert!(read(&fx.own_store().join("alpha/SKILL.md")).contains("two"));
    assert!(!exists(&fx.path("claude/skills/beta")));
    assert!(exists(&fx.path("gemini/skills/beta")));
    assert_eq!(fx.manifest().skills["alpha"].revision, 2);

    // One more agent of the old set while another has it: refused.
    let stale = fx.put(AgentType::ClaudeCode, 1, &v1, false);
    assert_eq!(
        codes_of(&stale.issues),
        vec![owned_codes::OWNED_SET_DIFFERS]
    );

    let gemini = fx.put(AgentType::Gemini, 2, &v2, true);
    assert_eq!(gemini.outcome, OwnedOutcome::Done, "{:?}", gemini.issues);
    assert!(gemini.replaced.is_empty() && gemini.added.is_empty());
    assert_eq!(gemini.linked, vec!["gamma"]);
    assert_eq!(gemini.unlinked, vec!["beta"]);
    assert_eq!(gemini.removed, vec!["beta"]);
    assert!(!exists(&fx.own_store().join("beta")));
    assert_eq!(
        fx.manifest().skills.keys().cloned().collect::<Vec<_>>(),
        vec!["alpha", "gamma"]
    );
    // The previous revision again (an undo): the same swap backwards.
    let back = fx.put(AgentType::Gemini, 1, &v1, true);
    assert_eq!(back.outcome, OwnedOutcome::Done, "{:?}", back.issues);
    assert_eq!(
        (back.added.clone(), back.replaced.clone()),
        (vec!["beta".to_string()], vec!["alpha".to_string()])
    );
    assert_eq!(back.kept, vec!["gamma"]);
}

#[test]
fn removing_takes_the_agents_links_then_whatever_nobody_links() {
    let fx = fx();
    let set = [member("alpha", "one"), member("beta", "one")];
    for agent in [AgentType::ClaudeCode, AgentType::Gemini] {
        assert_eq!(fx.install(agent, &set).outcome, OwnedOutcome::Done);
    }
    let claude = fx.remove(AgentType::ClaudeCode);
    assert_eq!(claude.outcome, OwnedOutcome::Done, "{:?}", claude.issues);
    assert_eq!(claude.unlinked, vec!["alpha", "beta"]);
    assert_eq!(claude.kept, vec!["alpha", "beta"]);
    assert!(!exists(&fx.path("claude/skills/alpha")));
    assert!(exists(&fx.own_store().join("alpha")));

    let gemini = fx.remove(AgentType::Gemini);
    assert_eq!(gemini.removed, vec!["alpha", "beta"]);
    assert!(!exists(&fx.own_store()));
    assert!(!exists(&fx.ctx.store.join(".plugins")));

    let again = fx.remove(AgentType::Gemini);
    assert_eq!(again.outcome, OwnedOutcome::Done);
    assert!(again.unlinked.is_empty() && again.removed.is_empty() && !again.store_changed);
}

// ─── What else holds a name ─────────────────────────────────────────────

#[test]
fn a_name_held_by_anything_else_is_refused_and_nothing_is_written() {
    let fx = fx();
    // A standalone Harness skill (a former member installed on its own),
    // linked into Claude.
    let former = fx.ctx.store.join("former");
    fs::create_dir_all(&former).unwrap();
    fs::write(former.join("SKILL.md"), "---\nname: former\n---\nx\n").unwrap();
    let mut main = manifest::load(&fx.ctx.store).unwrap();
    main.skills.insert(
        "former".into(),
        ManifestEntry {
            item_id: "0199-former".into(),
            item_ref: "obra/former".into(),
            revision: 1,
            version: None,
            archive_sha256: None,
            source: None,
            files: BTreeMap::new(),
            rewrites: Rewrites::default(),
            state_sha256: String::new(),
            installed_at: String::new(),
            op: String::new(),
            plugin: None,
            extra: serde_json::Map::new(),
        },
    );
    manifest::save(&fx.ctx.store, &main).unwrap();
    assert!(
        fx.apply(
            &fx.ctx,
            "former",
            AgentType::ClaudeCode,
            SkillAction::Enable
        )
        .ok
    );
    // A skill of the user's own.
    fs::create_dir_all(fx.path("claude/skills/mine")).unwrap();
    fs::write(fx.path("claude/skills/mine/SKILL.md"), "mine\n").unwrap();

    let report = fx.install(
        AgentType::ClaudeCode,
        &[member("former", "p"), member("mine", "p")],
    );
    assert_eq!(report.outcome, OwnedOutcome::Refused);
    let held: Vec<(&str, HeldBy)> = report
        .held
        .iter()
        .map(|h| (h.name.as_str(), h.by))
        .collect();
    assert_eq!(
        held,
        vec![("former", HeldBy::Harness), ("mine", HeldBy::Agent)]
    );
    assert_eq!(
        codes_of(&report.issues),
        vec![codes::NAME_TAKEN, codes::NAME_TAKEN]
    );
    assert_eq!(report.issues[0].params["by"], "harness");
    assert!(!exists(&fx.ctx.store.join(".plugins")));
    assert_eq!(read(&fx.path("claude/skills/mine/SKILL.md")), "mine\n");

    // Gemini has neither: it may.
    let gemini = fx.install(
        AgentType::Gemini,
        &[member("former", "p"), member("mine", "p")],
    );
    assert_eq!(gemini.outcome, OwnedOutcome::Done, "{:?}", gemini.issues);

    // Another plugin's member holds a name too.
    let other = PluginOwner::new(&fx.guard, &InstallName::parse("other").unwrap());
    let held = fx.ctx.lock_blocking().unwrap();
    let plan = plan_owned(
        &fx.ctx,
        &other,
        AgentType::Codex,
        &["shared-name".to_string()],
    );
    let done = install_owned(
        &fx.ctx,
        &held,
        &other,
        AgentType::Codex,
        &origin(1),
        &[member("shared-name", "o")],
        &plan.acks(),
    );
    drop(held);
    assert_eq!(done.outcome, OwnedOutcome::Done, "{:?}", done.issues);
    let refused = fx.install(AgentType::Codex, &[member("shared-name", "p")]);
    assert_eq!(refused.held[0].by, HeldBy::Plugin);
    assert_eq!(refused.held[0].plugin.as_deref(), Some("other"));
}

// ─── The Experts pack (superpowers) ─────────────────────────────────────

#[test]
fn the_experts_packs_links_are_taken_over_and_given_back() {
    let fx = fx();
    fx.experts();
    assert!(
        fx.apply(
            &fx.ctx,
            "brainstorming",
            AgentType::ClaudeCode,
            SkillAction::Enable
        )
        .ok
    );
    let link = fx.path("claude/skills/brainstorming");
    let set = [member("brainstorming", "the plugin's")];
    let wanted = names(&set);

    let plan = plan_owned(&fx.ctx, &fx.owner, AgentType::ClaudeCode, &wanted);
    let expected = vec![ExpertLink {
        name: "brainstorming".into(),
        path: link.to_string_lossy().into_owned(),
        copy: false,
        agents: vec![AgentType::ClaudeCode],
    }];
    assert_eq!(plan.takeover, expected);
    assert_eq!(
        experts_linked(&fx.ctx, AgentType::ClaudeCode, &wanted),
        expected
    );
    // Not before they are taken over: refused, nothing written.
    let refused = fx.install(AgentType::ClaudeCode, &set);
    assert_eq!(codes_of(&refused.issues), vec![owned_codes::EXPERTS_LINKED]);
    assert_eq!(refused.takeover, expected);
    assert!(!exists(&fx.ctx.store.join(".plugins")));

    let held = fx.ctx.lock_blocking().unwrap();
    let taken = unlink_experts(&fx.ctx, &held, &expected);
    drop(held);
    assert!(taken.ok() && taken.done == expected, "{taken:?}");
    assert_eq!(taken.touched, vec![AgentType::ClaudeCode]);
    assert!(!exists(&link));
    assert_eq!(
        fx.install(AgentType::ClaudeCode, &set).outcome,
        OwnedOutcome::Done
    );

    // The pack cannot be switched on there now.
    let blocked = fx.apply(
        &fx.ctx,
        "brainstorming",
        AgentType::ClaudeCode,
        SkillAction::Enable,
    );
    assert!(!blocked.ok);
    assert_eq!(blocked.ops[0].issues[0].code, skill_codes::PLUGIN_OWNED);
    assert_eq!(blocked.ops[0].issues[0].detail.as_deref(), Some(PLUGIN));

    // Uninstalled: the pack's link comes back.
    assert_eq!(fx.remove(AgentType::ClaudeCode).outcome, OwnedOutcome::Done);
    let held = fx.ctx.lock_blocking().unwrap();
    let back = relink_experts(&fx.ctx, &held, &expected);
    assert!(back.ok() && back.done == expected, "{back:?}");
    assert_eq!(
        fx.leads_to(&link),
        fs::canonicalize(fx.ctx.store.join("brainstorming")).ok()
    );
    let twice = relink_experts(&fx.ctx, &held, &expected);
    assert!(twice.done.is_empty() && twice.already == expected);

    // The user changed it meanwhile: left alone, both ways.
    let gone = unlink_experts(&fx.ctx, &held, &expected);
    assert_eq!(gone.done, expected);
    fs::create_dir_all(&link).unwrap();
    fs::write(link.join("SKILL.md"), "the user's\n").unwrap();
    let left = relink_experts(&fx.ctx, &held, &expected);
    assert!(left.done.is_empty() && left.changed == expected);
    assert_eq!(read(&link.join("SKILL.md")), "the user's\n");
    let not_ours = unlink_experts(&fx.ctx, &held, &expected);
    assert!(not_ours.done.is_empty() && not_ours.changed == expected);
    assert!(exists(&link.join("SKILL.md")));
    // …or turned the pack's skill on another way (here: in the shared
    // directory Gemini also reads): not given back.
    fs::remove_dir_all(&link).unwrap();
    drop(held);
    let gemini_link = vec![ExpertLink {
        name: "brainstorming".into(),
        path: fx
            .path("gemini/skills/brainstorming")
            .to_string_lossy()
            .into_owned(),
        copy: false,
        agents: vec![AgentType::Gemini],
    }];
    fs::create_dir_all(fx.path("agents/skills")).unwrap();
    crate::skills::link::platform_link(
        &fx.ctx.store.join("brainstorming"),
        &fx.path("agents/skills/brainstorming"),
    )
    .unwrap();
    let held = fx.ctx.lock_blocking().unwrap();
    let skipped = relink_experts(&fx.ctx, &held, &gemini_link);
    assert!(
        skipped.done.is_empty() && skipped.changed == gemini_link,
        "{skipped:?}"
    );
}

// ─── The Skills section without the token ───────────────────────────────

#[tokio::test]
async fn the_skills_sections_operations_never_touch_a_plugins_skill() {
    use crate::commands::acp::{acp_delete_agent_skill_in, SkillPageDirs, SkillStorageKind};
    use crate::skills::apply::{repair_blocking, RepairRequest};
    use crate::skills::model::RepairAction;
    let fx = fx();
    assert_eq!(
        fx.install(AgentType::ClaudeCode, &[member("alpha", "one")])
            .outcome,
        OwnedOutcome::Done
    );
    let link = fx.path("claude/skills/alpha");

    // Unlink (Codeg's store has no alpha): nothing of the plugin's moves.
    let disable = fx.apply(
        &fx.ctx,
        "alpha",
        AgentType::ClaudeCode,
        SkillAction::Disable,
    );
    assert!(disable.ops[0].removes.is_empty());
    assert!(exists(&link));

    // The Skills page's delete.
    let agent_dir = fx.path("claude/skills");
    let target = || {
        Ok(SkillPageDirs::with_readers(
            &fx.ctx,
            AgentType::ClaudeCode,
            SkillStorageKind::SkillDirectoryOnly,
            vec![agent_dir.clone()],
        ))
    };
    let error = acp_delete_agent_skill_in(
        &fx.ctx,
        &crate::web::event_bridge::EventEmitter::Noop,
        AgentType::ClaudeCode,
        AgentSkillScope::Global,
        "alpha".into(),
        &target,
        Default::default(),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.i18n_params.unwrap_or_default()["code"],
        skill_codes::PLUGIN_OWNED
    );
    assert!(exists(&link));

    // Repairing the plugin's broken link.
    let aside = fx.root.join("alpha-aside");
    fs::rename(fx.own_store().join("alpha"), &aside).unwrap();
    for action in [RepairAction::Remove, RepairAction::Repoint] {
        let _held = fx.ctx.lock_blocking().unwrap();
        let (result, _) = repair_blocking(
            &fx.ctx,
            &RepairRequest {
                path: link.clone(),
                action,
                preflight: false,
                ack: None,
            },
        );
        assert_eq!(result.issues[0].code, skill_codes::PLUGIN_OWNED);
    }
    assert!(exists(&link));
    fs::rename(&aside, fx.own_store().join("alpha")).unwrap();

    // With the owner's token, the engine works on it as on any skill.
    let owned = fx.ctx.owned_by(&fx.owner);
    let off = fx.apply(&owned, "alpha", AgentType::ClaudeCode, SkillAction::Disable);
    assert!(off.ok && off.ops[0].removes.len() == 1, "{off:?}");
    assert!(!exists(&link));
}

#[test]
fn where_no_link_can_be_made_a_plugins_copy_is_still_the_plugins() {
    use crate::skills::adopt::{adopt_blocking, AdoptRequest};
    let fx = fx_with(Arc::new(crate::skills::tests::FailingJunction));
    assert_eq!(
        fx.install(AgentType::ClaudeCode, &[member("alpha", "one")])
            .outcome,
        OwnedOutcome::Done
    );
    let copy = fx.path("claude/skills/alpha");
    assert!(fs::symlink_metadata(&copy).unwrap().is_dir());
    assert!(matches!(fx.entry(&copy), Entry::Owned { copy: true, .. }));
    let mut items = crate::commands::acp::list_skills_from_dir(
        AgentSkillScope::Global,
        &fx.path("claude/skills"),
        crate::commands::acp::SkillStorageKind::SkillDirectoryOnly,
    )
    .unwrap();
    crate::skills::world::annotate_items(&fx.ctx.store, &mut items);
    assert!(items[0].codeg_copy && items[0].plugin.as_deref() == Some(PLUGIN));

    // "Move into Codeg management": not the agent's own.
    let held = fx.ctx.lock_blocking().unwrap();
    let (adopted, _) = adopt_blocking(
        &fx.ctx,
        &AdoptRequest {
            agent: AgentType::ClaudeCode,
            skill: "alpha".into(),
            dir: None,
        },
    );
    drop(held);
    assert_eq!(adopted.issues[0].code, skill_codes::PLUGIN_OWNED);
    assert!(!exists(&fx.ctx.store.join("alpha")));

    // An update brings the copy along; removing takes it.
    let update = fx.put(AgentType::ClaudeCode, 2, &[member("alpha", "two")], true);
    assert_eq!(
        update.copies_refreshed,
        vec![copy.to_string_lossy().into_owned()]
    );
    assert!(read(&copy.join("SKILL.md")).contains("two"));
    assert_eq!(fx.remove(AgentType::ClaudeCode).removed, vec!["alpha"]);
    assert!(!exists(&copy));
}

// ─── Startup, failures, journals ────────────────────────────────────────

#[test]
fn the_startup_and_a_plugins_store_leave_each_other_alone() {
    let fx = fx();
    // The plugin first, while Codeg's store has no `brainstorming` yet.
    let set = [member("brainstorming", "the plugin's")];
    assert_eq!(
        fx.install(AgentType::ClaudeCode, &set).outcome,
        OwnedOutcome::Done
    );
    let own = fx.own_store().join("brainstorming");
    let ours = tree_hash(&own);

    let report = crate::skills::startup::run_blocking(&fx.ctx, &fx.startup_plugins());
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    assert!(report.experts.installed_count > 0);
    assert_eq!(tree_hash(&own), ours);
    let link = fx.path("claude/skills/brainstorming");
    assert_eq!(fx.leads_to(&link), fs::canonicalize(&own).ok());
    let pack = fx.ctx.store.join("brainstorming");
    let pack_hash = tree_hash(&pack);
    assert!(crate::skills::record::LinkRecord::load(&fx.own_store())
        .get(&link)
        .is_some());

    // …and an update of the plugin leaves the pack's skill as it is.
    let update = fx.put(
        AgentType::ClaudeCode,
        2,
        &[member("brainstorming", "v2")],
        true,
    );
    assert_eq!(update.replaced, vec!["brainstorming"]);
    assert_eq!(tree_hash(&pack), pack_hash);
    let again = crate::skills::startup::run_blocking(&fx.ctx, &fx.startup_plugins());
    assert!(again.problems.is_empty(), "{:?}", again.problems);
    assert_eq!(
        again.experts.installed_count + again.experts.updated_count,
        0
    );
}

#[test]
fn a_failed_write_says_what_was_done_and_the_next_call_finishes_it() {
    let fx = fx();
    fx.ctx.arm_fault("harness_commit");
    let set = [member("alpha", "one"), member("beta", "one")];
    let failed = fx.install(AgentType::ClaudeCode, &set);
    assert_eq!(failed.outcome, OwnedOutcome::WriteFailed);
    assert_eq!(codes_of(&failed.issues), vec![codes::MANIFEST_WRITE_FAILED]);
    assert!(failed.added.is_empty() && failed.linked.is_empty() && failed.kept_paths.is_empty());
    assert!(!exists(&fx.own_store().join("alpha")));
    assert!(!exists(&fx.own_store().join(".codeg-staging")));
    assert!(!exists(&fx.path("claude/skills/alpha")));
    fx.ctx.disarm_faults();
    let done = fx.install(AgentType::ClaudeCode, &set);
    assert!(done.ok(), "{:?}", done.issues);
    assert_eq!(done.added, vec!["alpha", "beta"]);
}

#[test]
fn a_crash_inside_a_plugins_store_is_undone_at_the_next_start() {
    use super::journal::{new_journal, Action, Tx};
    let fx = fx();
    assert_eq!(
        fx.install(AgentType::ClaudeCode, &[member("alpha", "one")])
            .outcome,
        OwnedOutcome::Done
    );
    let own = fx.ctx.owned_by(&fx.owner);
    let before = fx.manifest().skills["alpha"].clone();
    let v1 = tree_hash(&fx.own_store().join("alpha"));
    // An update swapped in and never committed.
    let journal = new_journal(
        Action::Update,
        "alpha",
        ITEM,
        Some(before),
        None,
        true,
        false,
    );
    let mut tx = Tx::begin(&own, journal).unwrap();
    tx.journal.new_hash = Some(tx.stage(&member("alpha", "two").files).unwrap());
    tx.write_journal().unwrap();
    tx.swap().unwrap();
    drop(tx);
    assert!(read(&fx.own_store().join("alpha/SKILL.md")).contains("two"));

    let report = crate::skills::startup::run_blocking(&fx.ctx, &fx.startup_plugins());
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    assert_eq!(tree_hash(&fx.own_store().join("alpha")), v1);
    assert!(!exists(&fx.own_store().join(".codeg-staging")));
}

#[test]
fn a_plugins_members_are_never_a_harness_skill_of_their_own() {
    let fx = fx();
    let mut manifest = manifest::load(&fx.ctx.store).unwrap();
    let entry = |plugin: Option<&str>| ManifestEntry {
        item_id: ITEM.into(),
        item_ref: "obra/superpowers".into(),
        revision: 3,
        version: None,
        archive_sha256: None,
        source: None,
        files: BTreeMap::new(),
        rewrites: Rewrites::default(),
        state_sha256: String::new(),
        installed_at: String::new(),
        op: String::new(),
        plugin: plugin.map(str::to_string),
        extra: serde_json::Map::new(),
    };
    manifest.skills.insert("member".into(), entry(Some(PLUGIN)));
    assert!(manifest.find_item(ITEM).is_none());
    manifest::save(&fx.ctx.store, &manifest).unwrap();
    assert!(super::installed_skills_in(&fx.ctx).unwrap().is_empty());
    // Written and read back with its owner.
    let back = manifest::load(&fx.ctx.store).unwrap();
    assert_eq!(back.skills["member"].plugin.as_deref(), Some(PLUGIN));
    manifest.skills.insert("standalone".into(), entry(None));
    assert_eq!(
        manifest.find_item(ITEM).map(|(name, _)| name.as_str()),
        Some("standalone")
    );
}

#[test]
fn members_are_read_from_the_revision_against_its_listing() {
    use crate::harness::types::{ComponentKind, FileEntry, PluginComponent};
    let tmp = tempfile::tempdir().unwrap();
    let rev = tmp.path();
    let write = |rel: &str, text: &str| {
        let path = rev.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        FileEntry {
            path: rel.into(),
            sha256: super::sha256_hex(text.as_bytes()),
            size: text.len() as u64,
            executable: false,
        }
    };
    let listing = vec![
        write(".claude-plugin/plugin.json", "{}"),
        write("skills/alpha/SKILL.md", "---\nname: alpha\n---\nA\n"),
        write("skills/alpha/tools/run.sh", "echo\n"),
        write("agents/helper.md", "an assistant\n"),
    ];
    let component = |kind, name: &str, path: &str| PluginComponent {
        kind,
        name: name.into(),
        path: path.into(),
        summary: None,
        tree_sha256: None,
    };
    let components = vec![
        component(ComponentKind::Skill, "alpha", "skills/alpha"),
        component(ComponentKind::Assistant, "helper", "agents/helper.md"),
    ];
    let members = read_members(rev, &components, &listing).unwrap();
    assert_eq!(members.len(), 1);
    let paths: Vec<&str> = members[0].files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, vec!["SKILL.md", "tools/run.sh"]);

    fs::write(rev.join("skills/alpha/tools/run.sh"), "changed\n").unwrap();
    let issues = read_members(rev, &components, &listing).unwrap_err();
    assert_eq!(codes_of(&issues), vec![owned_codes::MEMBER_FILE_MISMATCH]);
}

// ─── After review ───────────────────────────────────────────────────────

/// A plugin's store holding an entry of another owner (reached under
/// another spelling of the install name) is never worked on.
#[test]
fn a_store_whose_entries_are_another_plugins_is_left_alone() {
    let fx = fx();
    assert!(fx
        .install(AgentType::ClaudeCode, &[member("alpha", "one")])
        .ok());
    let mut manifest = fx.manifest();
    manifest.skills.get_mut("alpha").unwrap().plugin = Some("SuperPowers".into());
    manifest::save(&fx.own_store(), &manifest).unwrap();
    let removed = fx.remove(AgentType::ClaudeCode);
    assert_eq!(codes_of(&removed.issues), vec![owned_codes::OWNED_BY_OTHER]);
    assert!(exists(&fx.path("claude/skills/alpha")));
    assert!(exists(&fx.own_store().join("alpha")));
}

/// A copy record left behind (its copy deleted by hand) never makes the
/// copy another plugin made there since its own.
#[test]
fn a_stale_copy_record_loses_to_the_copy_made_there_since() {
    let fx = fx_with(Arc::new(crate::skills::tests::FailingJunction));
    assert!(fx
        .install(AgentType::ClaudeCode, &[member("alpha", "same")])
        .ok());
    let copy = fx.path("claude/skills/alpha");
    fs::remove_dir_all(&copy).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    let other = PluginOwner::new(&fx.guard, &InstallName::parse("other").unwrap());
    let held = fx.ctx.lock_blocking().unwrap();
    let plan = plan_owned(
        &fx.ctx,
        &other,
        AgentType::ClaudeCode,
        &["alpha".to_string()],
    );
    let theirs = install_owned(
        &fx.ctx,
        &held,
        &other,
        AgentType::ClaudeCode,
        &origin(1),
        &[member("alpha", "same")],
        &plan.acks(),
    );
    drop(held);
    assert!(theirs.ok(), "{:?}", theirs.issues);
    assert!(matches!(
        fx.entry(&copy),
        Entry::Owned { ref plugin, copy: true, .. } if plugin == "other"
    ));
    let mut items = crate::commands::acp::list_skills_from_dir(
        AgentSkillScope::Global,
        &fx.path("claude/skills"),
        crate::commands::acp::SkillStorageKind::SkillDirectoryOnly,
    )
    .unwrap();
    crate::skills::world::annotate_items(&fx.ctx.store, &mut items);
    assert_eq!(items[0].plugin.as_deref(), Some("other"));

    let ours = fx.remove(AgentType::ClaudeCode);
    assert!(ours.ok() && ours.unlinked.is_empty(), "{ours:?}");
    assert!(exists(&copy.join("SKILL.md")));
}

#[test]
fn copies_that_could_not_follow_an_update_are_refreshed_by_the_next_call() {
    let fx = fx_with(Arc::new(crate::skills::tests::FailingJunction));
    assert!(fx
        .install(AgentType::ClaudeCode, &[member("alpha", "one")])
        .ok());
    let copy = fx.path("claude/skills/alpha");
    fx.ctx.arm_fault("refresh_record");
    let failed = fx.put(AgentType::ClaudeCode, 2, &[member("alpha", "two")], true);
    assert_eq!(failed.outcome, OwnedOutcome::WriteFailed);
    assert_eq!(
        codes_of(&failed.issues),
        vec![owned_codes::COPIES_NOT_REFRESHED]
    );
    assert!(read(&copy.join("SKILL.md")).contains("one"));
    fx.ctx.disarm_faults();
    let again = fx.put(AgentType::ClaudeCode, 2, &[member("alpha", "two")], true);
    assert!(again.ok(), "{:?}", again.issues);
    assert!(again.replaced.is_empty());
    assert_eq!(
        again.copies_refreshed,
        vec![copy.to_string_lossy().into_owned()]
    );
    assert!(read(&copy.join("SKILL.md")).contains("two"));
}

#[cfg(unix)]
#[test]
fn a_revision_that_changes_only_a_mode_puts_the_mode_in_place() {
    use std::os::unix::fs::PermissionsExt;
    let fx = fx();
    let with_script = |executable: bool| {
        let mut m = member("alpha", "one");
        m.files.push(PackageFile {
            path: "run.sh".into(),
            bytes: b"echo\n".to_vec(),
            executable,
        });
        m
    };
    assert!(fx
        .install(AgentType::ClaudeCode, &[with_script(false)])
        .ok());
    let update = fx.put(AgentType::ClaudeCode, 2, &[with_script(true)], true);
    assert_eq!(update.replaced, vec!["alpha"], "{update:?}");
    let mode = fs::metadata(fx.own_store().join("alpha/run.sh"))
        .unwrap()
        .permissions()
        .mode();
    assert_ne!(mode & 0o111, 0);
}

/// A copy changed on the agent's side is set aside among the backups and
/// goes with the rest: the plugin's skill does not stay in the agent.
#[test]
fn removing_takes_a_changed_copy_too_after_keeping_the_change() {
    let fx = fx_with(Arc::new(crate::skills::tests::FailingJunction));
    assert!(fx
        .install(AgentType::ClaudeCode, &[member("alpha", "one")])
        .ok());
    let copy = fx.path("claude/skills/alpha");
    fs::write(copy.join("SKILL.md"), "the user's edit\n").unwrap();
    let removed = fx.remove(AgentType::ClaudeCode);
    assert!(removed.ok(), "{:?}", removed.issues);
    assert_eq!(
        removed.copies_taken,
        vec![copy.to_string_lossy().into_owned()]
    );
    assert_eq!(removed.removed, vec!["alpha"]);
    assert!(!exists(&copy));
    let backups = fx.ctx.store.join(".user-backups/alpha");
    let kept: Vec<_> = fs::read_dir(&backups).unwrap().flatten().collect();
    assert_eq!(kept.len(), 1);
    assert_eq!(read(&kept[0].path().join("SKILL.md")), "the user's edit\n");
}

/// The Experts pack's link in a shared directory: the plan's `ack`s are the
/// install's once the link is taken over; giving it back never gives a
/// reader a second provider of the name.
#[test]
fn an_experts_link_in_a_shared_directory_is_taken_over_with_the_plans_acks() {
    let fx = fx();
    fx.experts();
    let shared = AgentType::custom("k1-shared-store-agent").unwrap();
    let enable = |agent| SkillOp {
        skill: "brainstorming".into(),
        agent,
        action: SkillAction::Enable,
        ack: None,
        replace_modified: false,
    };
    let preflight = apply_blocking(
        &fx.ctx,
        &SkillsApplyRequest {
            ops: vec![enable(shared)],
            preflight: true,
        },
    )
    .0;
    let mut op = enable(shared);
    op.ack = preflight.ops[0].ack.clone();
    {
        let _held = fx.ctx.lock_blocking().unwrap();
        let done = apply_blocking(
            &fx.ctx,
            &SkillsApplyRequest {
                ops: vec![op],
                preflight: false,
            },
        )
        .0;
        assert!(done.ok, "{done:?}");
    }
    let set = [member("brainstorming", "the plugin's")];
    let plan = plan_owned(&fx.ctx, &fx.owner, shared, &names(&set));
    assert_eq!(plan.takeover.len(), 1);
    assert!(plan.takeover[0].agents.len() > 1);
    assert!(plan.links.ok, "{:?}", plan.links);
    let acks = plan.acks();
    assert!(acks.contains_key("brainstorming"));

    let held = fx.ctx.lock_blocking().unwrap();
    assert!(unlink_experts(&fx.ctx, &held, &plan.takeover).ok());
    let done = install_owned(&fx.ctx, &held, &fx.owner, shared, &origin(1), &set, &acks);
    assert!(done.ok(), "{:?}", done.issues);
    drop(held);

    // Taken out of the shared directory again, and the plugin given to
    // Gemini (which reads it) in its own: the pack's link is not put back.
    let removal = plan_remove_owned(&fx.ctx, &fx.owner, shared);
    let held = fx.ctx.lock_blocking().unwrap();
    let removed = remove_owned(&fx.ctx, &held, &fx.owner, shared, &removal.acks());
    assert!(removed.ok(), "{:?}", removed.issues);
    drop(held);
    assert!(fx.install(AgentType::Gemini, &set).ok());
    let held = fx.ctx.lock_blocking().unwrap();
    let back = relink_experts(&fx.ctx, &held, &plan.takeover);
    assert!(
        back.done.is_empty() && back.changed == plan.takeover,
        "{back:?}"
    );
    drop(held);
    // Once Gemini's goes too, it is.
    assert!(fx.remove(AgentType::Gemini).ok());
    let held = fx.ctx.lock_blocking().unwrap();
    let back = relink_experts(&fx.ctx, &held, &plan.takeover);
    assert!(back.ok() && back.done == plan.takeover, "{back:?}");
}

/// The Skills section never gives an agent a second provider of a name a
/// plugin provides, and says so when turning it off.
#[test]
fn the_pack_cannot_add_a_second_provider_of_a_plugins_name() {
    let fx = fx();
    fx.experts();
    // The plugin in the shared directory (the shared-only agent's); Gemini
    // reads it, and its own directory is free.
    let shared = AgentType::custom("k1-shared-store-agent").unwrap();
    let set = [member("brainstorming", "the plugin's")];
    let plan = plan_owned(&fx.ctx, &fx.owner, shared, &names(&set));
    let held = fx.ctx.lock_blocking().unwrap();
    let done = install_owned(
        &fx.ctx,
        &held,
        &fx.owner,
        shared,
        &origin(1),
        &set,
        &plan.acks(),
    );
    assert!(done.ok(), "{:?}", done.issues);
    drop(held);
    let on = fx.apply(
        &fx.ctx,
        "brainstorming",
        AgentType::Gemini,
        SkillAction::Enable,
    );
    assert!(!on.ok);
    assert_eq!(on.ops[0].issues[0].code, skill_codes::PLUGIN_OWNED);
    assert!(!exists(&fx.path("gemini/skills/brainstorming")));
    let off = fx.apply(
        &fx.ctx,
        "brainstorming",
        AgentType::Gemini,
        SkillAction::Disable,
    );
    assert!(off.ok && off.ops[0].removes.is_empty());
    assert_eq!(off.ops[0].warnings[0].code, skill_codes::PLUGIN_OWNED);
}

/// A copy record of the plugin's left behind never makes a copy the
/// Experts pack made there since the plugin's.
#[test]
fn a_stale_copy_record_never_takes_the_packs_copy_made_since() {
    let fx = fx_with(Arc::new(crate::skills::tests::FailingJunction));
    fx.experts();
    assert!(fx
        .install(AgentType::ClaudeCode, &[member("brainstorming", "plugin")])
        .ok());
    let copy = fx.path("claude/skills/brainstorming");
    fs::remove_dir_all(&copy).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    assert!(
        fx.apply(
            &fx.ctx,
            "brainstorming",
            AgentType::ClaudeCode,
            SkillAction::Enable
        )
        .ok
    );
    let pack = tree_hash(&copy);
    let removed = fx.remove(AgentType::ClaudeCode);
    assert!(removed.ok(), "{:?}", removed.issues);
    assert!(removed.copies_taken.is_empty() && removed.unlinked.is_empty());
    assert_eq!(tree_hash(&copy), pack);
    assert!(World::load(&fx.ctx)
        .entry(&copy)
        .is_codeg_of("brainstorming"));
}

#[cfg(unix)]
#[test]
fn one_more_agent_never_changes_a_mode_under_the_others() {
    let fx = fx();
    let with_script = |executable: bool| {
        let mut m = member("alpha", "one");
        m.files.push(PackageFile {
            path: "run.sh".into(),
            bytes: b"echo\n".to_vec(),
            executable,
        });
        m
    };
    assert!(fx
        .install(AgentType::ClaudeCode, &[with_script(false)])
        .ok());
    let other = fx.install(AgentType::Gemini, &[with_script(true)]);
    assert_eq!(
        codes_of(&other.issues),
        vec![owned_codes::OWNED_SET_DIFFERS]
    );
}

/// The changed copy goes in the same request as the links: when a link
/// fails, it is back where it was, and its spare backup is gone.
#[test]
fn a_changed_copy_comes_back_when_the_links_fail() {
    let fx = fx_with(Arc::new(crate::skills::tests::FailingJunction));
    assert!(fx
        .install(AgentType::ClaudeCode, &[member("alpha", "one")])
        .ok());
    let copy = fx.path("claude/skills/alpha");
    fs::write(copy.join("SKILL.md"), "the user's edit\n").unwrap();
    fx.ctx.arm_fault("copy");
    let failed = fx.put(AgentType::ClaudeCode, 2, &[member("beta", "two")], true);
    fx.ctx.disarm_faults();
    assert_eq!(failed.outcome, OwnedOutcome::WriteFailed, "{failed:?}");
    assert!(failed.copies_taken.is_empty() && failed.backups.is_empty());
    assert_eq!(read(&copy.join("SKILL.md")), "the user's edit\n");
    assert!(matches!(
        World::load(&fx.ctx.owned_by(&fx.owner)).entry(&copy),
        Entry::CodegCopy { matches: false, .. }
    ));
    assert!(!exists(&fx.ctx.store.join(".user-backups")));
    assert!(!exists(&fx.path("claude/skills/beta")));
}

/// …and when the changed copy cannot be put back either, its backup stays
/// (and is said): the change is never lost.
#[test]
fn a_changed_copy_that_cannot_come_back_keeps_its_backup() {
    let fx = fx_with(Arc::new(crate::skills::tests::FailingJunction));
    assert!(fx
        .install(AgentType::ClaudeCode, &[member("alpha", "one")])
        .ok());
    let copy = fx.path("claude/skills/alpha");
    fs::write(copy.join("SKILL.md"), "the user's edit\n").unwrap();
    fx.ctx.arm_fault("copy");
    fx.ctx.arm_fault("unstage");
    let failed = fx.put(AgentType::ClaudeCode, 2, &[member("beta", "two")], true);
    fx.ctx.disarm_faults();
    assert_eq!(failed.outcome, OwnedOutcome::WriteFailed);
    assert_eq!(failed.backups.len(), 1, "{failed:?}");
    assert!(failed.kept_paths.contains(&failed.backups[0]));
    assert_eq!(
        read(&Path::new(&failed.backups[0]).join("SKILL.md")),
        "the user's edit\n"
    );
}
