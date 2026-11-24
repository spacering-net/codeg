//! A plugin's install, uninstall and recovery end to end: the skill
//! install's stand-in for SpaceRing on loopback (`harness::skills::tests::
//! Site`, serving a plugin), Codeg's skill store with the agents'
//! directories (`skills::tests::fixture_ctx_with`), the plugin store, and
//! fake hosts — Claude Code through the fake wrapper of the adapter's tests
//! (run by the sandbox runner, with nothing of the test's environment),
//! OpenCode by its config files, Codex not installed — all under one temp
//! directory. No real host, no PATH, no real home.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::ctx::PluginsCtx;
use super::hosts::claude::ClaudeAdapter;
use super::hosts::codex::CodexAdapter;
use super::hosts::codex_tests::fake_codex_wrapper;
use super::hosts::opencode::OpenCodeAdapter;
use super::hosts::tests::fake_claude_wrapper;
use super::hosts::{self, HostAdapter, HostEnv, SandboxRunner};
use super::install::{install, plan, uninstall, PluginsLocal};
use super::journal;
use super::model::*;
use super::record::{self, HostEntry, HostMode, HostState, PluginEntry};
use crate::harness::cache::Cache;
use crate::harness::client::{Backoff, Limits};
use crate::harness::mcp::model::{Reason, INSTALLED_CHANGED_EVENT};
use crate::harness::skills::tests::{drain, file, listing, sha, zip_of, File, Site};
use crate::harness::skills::{Local as SkillsLocal, UninstallOutcome};
use crate::harness::{Harness, Origin};
use crate::models::agent::AgentType;
use crate::skills::apply::apply_blocking;
use crate::skills::link::PlatformLinks;
use crate::skills::model::{SkillAction, SkillOp, SkillsApplyRequest};
use crate::skills::owned::ExpertLink;
use crate::skills::SkillsCtx;
use crate::web::event_bridge::{EventEmitter, WebEventBroadcaster};

const ID: &str = "01a1f230-a5b2-7bca-9cee-bd63eb5aee5c";
const REF: &str = "obra/superpowers";
const NAME: &str = "superpowers";
const KEY: &str = "superpowers@codeg-harness";

const CLAUDE: AgentType = AgentType::ClaudeCode;
const CODEX: AgentType = AgentType::Codex;
const OPENCODE: AgentType = AgentType::OpenCode;
const GEMINI: AgentType = AgentType::Gemini;

fn package(revision: u64) -> Vec<File> {
    let skill = |name: &str| {
        format!("---\nname: {name}\ndescription: {name}, revision {revision}.\n---\nRevision {revision}.\n")
    };
    vec![
        file(
            ".claude-plugin/plugin.json",
            &json!({ "name": NAME, "version": format!("7.0.{revision}") }).to_string(),
            false,
        ),
        file(
            "hooks/hooks.json",
            r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"hooks/session-start"}]}]}}"#,
            false,
        ),
        file("hooks/session-start", "#!/bin/sh\necho hello\n", true),
        file("index.js", "export default {}\n", false),
        file(
            "skills/brainstorming/SKILL.md",
            &skill("brainstorming"),
            false,
        ),
        file(
            "skills/brainstorming/notes.md",
            &format!("Notes {revision}\n"),
            false,
        ),
        file(
            "skills/writing-plans/SKILL.md",
            &skill("writing-plans"),
            false,
        ),
        file(
            "agents/code-reviewer.md",
            "---\nname: code-reviewer\n---\nReview.\n",
            false,
        ),
    ]
}

/// The skill members, as the agents' links name them.
const MEMBERS: [&str; 2] = ["brainstorming", "writing-plans"];

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    site: Site,
    _raw: Site,
    harness: Harness,
    local: PluginsLocal,
    events: Arc<WebEventBroadcaster>,
    emitter: EventEmitter,
    /// Fingerprints are this tag plus a name: snapshots shown are kept
    /// process-wide, and tests run side by side.
    tag: String,
    /// The revision to install whole, as `/resolve` says.
    full: Option<u64>,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_agents(None).await
    }

    /// With these agents' directories (paths under the test's root), else
    /// the skills tests' layout.
    async fn with_agents(agents: Option<Vec<(AgentType, Vec<&str>)>>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let ctx = match agents {
            None => crate::skills::tests::fixture_ctx_with(&root, Arc::new(PlatformLinks)),
            Some(agents) => SkillsCtx::new(
                root.join("store"),
                root.join("locks/skills.lock"),
                agents
                    .into_iter()
                    .map(|(agent, dirs)| crate::skills::AgentDirs {
                        agent,
                        dirs: dirs.into_iter().map(|dir| root.join(dir)).collect(),
                        read_only: Vec::new(),
                        markdown_files: false,
                    })
                    .collect(),
                Arc::new(PlatformLinks),
            ),
        };
        fs::create_dir_all(&ctx.store).unwrap();
        let site = Site::start().await;
        let raw = Site::start().await;
        {
            let mut catalog = site.catalog.lock().unwrap();
            catalog.item = Some((REF.to_string(), ID.to_string()));
            catalog.config = json!({ "plugins": { "adapters": {
                "claude": { "enabled": true, "minVersion": "2.1.185", "maxVersion": null },
                "codex": { "enabled": true, "minVersion": "0.149.1", "maxVersion": null },
                "opencode": { "enabled": true, "minVersion": "2.3.2", "maxVersion": null }
            } } });
        }
        let harness = Harness {
            enabled: true,
            origin: Origin::parse(&site.origin).expect("a loopback origin"),
            cache: Cache::in_data_dir(&root.join("data")),
            limits: Limits::default(),
            backoff: Box::leak(Box::new(Backoff::default())),
        };
        let skills = SkillsLocal {
            ctx,
            installed: [CLAUDE, GEMINI, OPENCODE]
                .into_iter()
                .map(|agent| (agent, true))
                .collect(),
            raw_origin: Origin::parse(&raw.origin).expect("a loopback origin"),
        };
        let wrapper = fake_claude_wrapper(&root);
        let runner = Arc::new(SandboxRunner::new(&root));
        let mcp_lock = root.join("locks/mcp.lock");
        let adapters: Vec<Arc<dyn HostAdapter>> = vec![
            Arc::new(ClaudeAdapter::sandboxed(
                runner.clone(),
                Some(wrapper),
                None,
                mcp_lock.clone(),
            )),
            Arc::new(CodexAdapter::sandboxed(
                runner,
                Some(fake_codex_wrapper(&root)),
                None,
            )),
            Arc::new(OpenCodeAdapter::sandboxed(
                Some(root.join("bin/opencode")),
                Some("2.3.2"),
                mcp_lock,
            )),
        ];
        let home = root.join("home");
        fs::create_dir_all(home.join("codex-home")).unwrap();
        let mut local = PluginsLocal {
            plugins: PluginsCtx::at(&root.join("codeg")),
            skills,
            adapters,
            envs: BTreeMap::new(),
            default_env: HostEnv::sandboxed(&home, &[]),
            missing_envs: Default::default(),
        };
        let events = Arc::new(WebEventBroadcaster::new());
        let emitter = EventEmitter::test_web_only(events.clone());
        let fixture = Self {
            _dir: dir,
            root,
            site,
            _raw: raw,
            harness,
            local: local.clone(),
            events,
            emitter,
            tag: uuid::Uuid::new_v4().simple().to_string(),
            full: None,
        };
        local.envs = fixture.envs(&[]);
        Self { local, ..fixture }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    fn home(&self) -> PathBuf {
        self.path("home")
    }

    fn claude_config(&self) -> PathBuf {
        self.path("home/claude-config")
    }

    fn codex_home(&self) -> PathBuf {
        self.path("home/codex-home")
    }

    /// The agents' environments; `claude` is laid over Claude Code's.
    fn envs(&self, claude: &[(&str, &str)]) -> BTreeMap<AgentType, HostEnv> {
        self.envs_with(claude, &[])
    }

    /// …and `codex` over Codex's.
    fn envs_with(
        &self,
        claude: &[(&str, &str)],
        codex: &[(&str, &str)],
    ) -> BTreeMap<AgentType, HostEnv> {
        let home = self.home();
        let config = self.claude_config();
        let log = self.path("argv.log");
        let xdg = self.path("xdg");
        let mut claude_env = vec![
            ("CLAUDE_CONFIG_DIR", config.to_str().unwrap()),
            ("FAKE_LOG", log.to_str().unwrap()),
            ("HOME", home.to_str().unwrap()),
        ];
        claude_env.extend_from_slice(claude);
        let codex_home = self.codex_home();
        let mut codex_env = vec![
            ("CODEX_HOME", codex_home.to_str().unwrap()),
            ("FAKE_LOG", log.to_str().unwrap()),
            ("HOME", home.to_str().unwrap()),
        ];
        codex_env.extend_from_slice(codex);
        BTreeMap::from([
            (CLAUDE, HostEnv::sandboxed(&home, &claude_env)),
            (CODEX, HostEnv::sandboxed(&home, &codex_env)),
            (
                OPENCODE,
                HostEnv::sandboxed(&home, &[("XDG_CONFIG_HOME", xdg.to_str().unwrap())]),
            ),
        ])
    }

    /// The same machine with Claude Code's environment changed.
    fn with_claude_env(&self, claude: &[(&str, &str)]) -> PluginsLocal {
        PluginsLocal {
            envs: self.envs(claude),
            ..self.local.clone()
        }
    }

    fn skills(&self) -> &SkillsCtx {
        &self.local.skills.ctx
    }

    fn plugins(&self) -> &PluginsCtx {
        &self.local.plugins
    }

    fn exec(&self, revision: u64) -> String {
        sha(format!("{}-exec-{revision}", self.tag).as_bytes())
    }

    fn state(&self, revision: u64) -> String {
        format!("{}-r{revision}", self.tag)
    }

    /// Publish `revision`; `approved`: a person approved it.
    fn publish(&mut self, revision: u64, approved: bool) {
        self.publish_with(revision, approved, |_| {});
    }

    /// …its files changed by `change` first.
    fn publish_with(&mut self, revision: u64, approved: bool, change: impl FnOnce(&mut Vec<File>)) {
        let mut files = package(revision);
        change(&mut files);
        let zip = zip_of(&files);
        let zip_sha = sha(&zip);
        let url = format!("/api/harness/v1/archives/{zip_sha}.zip");
        let mut catalog = self.site.catalog.lock().unwrap();
        catalog.latest = catalog.latest.max(revision);
        catalog.blobs.insert(url.clone(), zip.clone());
        let component = |kind: &str, name: &str, path: &str| {
            json!({ "kind": kind, "name": name, "path": path, "summary": name,
                    "treeSha256": sha(format!("{name}-{revision}").as_bytes()) })
        };
        catalog.versions.insert(
            revision,
            json!({
                "item": { "id": ID, "ref": REF, "kind": "plugin", "title": { "en": "Superpowers" } },
                "version": { "revision": revision, "version": format!("7.0.{revision}"),
                             "publishedAt": "2026-11-01T00:00:00.000Z", "status": "ok" },
                "archive": { "url": url, "sha256": zip_sha, "size": zip.len() },
                "files": listing(&files),
                "source": null,
                "plugin": {
                    "name": NAME,
                    "hosts": [
                        { "host": "claude", "manifest": ".claude-plugin/plugin.json", "skills": 2, "hooks": 1 },
                        { "host": "codex", "manifest": ".codex-plugin/plugin.json", "skills": 2, "hooks": 0 },
                        { "host": "opencode", "manifest": "", "skills": 2, "code": 1 }
                    ],
                    "unknownManifests": [],
                    "components": [
                        component("skill", "brainstorming", "skills/brainstorming"),
                        component("skill", "writing-plans", "skills/writing-plans"),
                        component("assistant", "code-reviewer", "agents/code-reviewer.md")
                    ],
                    "autorun": [
                        { "host": "claude", "type": "hook", "path": "hooks/hooks.json",
                          "event": "SessionStart", "command": "hooks/session-start" },
                        { "host": "opencode", "type": "code", "path": "index.js" }
                    ],
                    "autorunFiles": ["hooks/hooks.json", "hooks/session-start", "index.js"],
                    "mcpUnpinned": [],
                    "execSha256": self.exec(revision),
                    "approved": approved,
                    "full": null,
                    "notFull": null
                },
                "permissions": {}, "risk": "low", "reviewed": approved, "advisories": []
            }),
        );
        catalog.resolved.insert(
            revision,
            json!({
                "status": "listed", "ref": REF, "kind": "plugin",
                "latest": null,
                "advisories": [],
                "installed": {
                    "revision": revision, "status": "ok", "risk": "low", "reviewed": approved,
                    "permissions": { "declared": {},
                                     "detected": { "runsCode": ["shell", "node"], "installs": [], "installScripts": [],
                                                   "network": [], "secrets": [], "paths": [], "tools": [] } },
                    "checks": { "findings": { "low": 0, "medium": 0, "high": 0 }, "secrets": 0, "review": "off" },
                    "packages": [],
                    "plugin": { "approved": approved, "full": null, "execSha256": self.exec(revision) },
                    "stateSha256": self.state(revision)
                }
            }),
        );
        drop(catalog);
        if approved {
            self.full = Some(self.full.map_or(revision, |full| full.max(revision)));
        }
        self.settle();
    }

    /// Every answer as of now: the latest revision, the one to install
    /// whole (item-level: the same in every revision's snapshot and
    /// install info), why the latest is not it.
    fn settle(&self) {
        let mut catalog = self.site.catalog.lock().unwrap();
        let latest = catalog.latest;
        let full = self
            .full
            .map(|revision| json!({ "revision": revision, "version": format!("7.0.{revision}") }));
        let not_full = match self.full {
            Some(full) if full == latest => Value::Null,
            _ => json!("pending_review"),
        };
        for version in catalog.versions.values_mut() {
            version["plugin"]["full"] = full.clone().unwrap_or(Value::Null);
            version["plugin"]["notFull"] = not_full.clone();
        }
        for resolved in catalog.resolved.values_mut() {
            resolved["latest"] = json!({ "revision": latest, "version": format!("7.0.{latest}"),
                                         "publishedAt": "2026-11-01T00:00:00.000Z" });
            resolved["installed"]["plugin"]["full"] = full.clone().unwrap_or(Value::Null);
        }
    }

    fn resolve(&self, revision: u64, change: impl FnOnce(&mut Value)) {
        let mut catalog = self.site.catalog.lock().unwrap();
        change(catalog.resolved.get_mut(&revision).unwrap());
    }

    fn version(&self, revision: u64, change: impl FnOnce(&mut Value)) {
        let mut catalog = self.site.catalog.lock().unwrap();
        change(catalog.versions.get_mut(&revision).unwrap());
    }

    async fn plan(&self, modes: &[(AgentType, PlanMode)]) -> HarnessPluginPlan {
        self.plan_with(&self.local, modes).await
    }

    async fn plan_with(
        &self,
        local: &PluginsLocal,
        modes: &[(AgentType, PlanMode)],
    ) -> HarnessPluginPlan {
        let modes = (!modes.is_empty()).then(|| modes.iter().copied().collect());
        plan(local, &self.harness, REF, None, modes).await.unwrap()
    }

    /// Rows for `modes`' agents only, each planned so.
    async fn plan_for(&self, modes: &[(AgentType, PlanMode)]) -> HarnessPluginPlan {
        let agents = modes.iter().map(|(agent, _)| *agent).collect();
        let modes = modes.iter().copied().collect();
        plan(&self.local, &self.harness, REF, Some(agents), Some(modes))
            .await
            .unwrap()
    }

    /// What a dialog sends for `plan` with its planned modes, agreeing to
    /// what runs when it must, with every `ack`.
    fn request(&self, plan: &HarnessPluginPlan) -> HarnessPluginInstallRequest {
        let target = if plan.target == plan.latest.revision {
            &plan.latest
        } else {
            plan.full.as_ref().unwrap()
        };
        HarnessPluginInstallRequest {
            item_ref: REF.to_string(),
            revision: plan.target,
            install_name: plan.install_name.clone().unwrap(),
            hosts: plan
                .hosts
                .iter()
                .map(|row| (row.agent, row.planned))
                .collect(),
            state_sha256: target.state_sha256.clone().unwrap(),
            consent_exec: plan
                .consent_required
                .then(|| plan.consent_exec.clone())
                .flatten(),
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

    async fn install(&self, request: HarnessPluginInstallRequest) -> HarnessPluginInstallResult {
        self.install_with(&self.local, request).await
    }

    async fn install_with(
        &self,
        local: &PluginsLocal,
        request: HarnessPluginInstallRequest,
    ) -> HarnessPluginInstallResult {
        install(local, &self.harness, &self.emitter, request)
            .await
            .unwrap()
    }

    async fn install_planned(&self, modes: &[(AgentType, PlanMode)]) -> HarnessPluginInstallResult {
        let plan = self.plan(modes).await;
        self.install(self.request(&plan)).await
    }

    async fn uninstall(&self) -> HarnessPluginUninstallResult {
        self.uninstall_with(&self.local).await
    }

    async fn uninstall_with(&self, local: &PluginsLocal) -> HarnessPluginUninstallResult {
        let preflight = uninstall(
            local,
            &self.emitter,
            HarnessPluginUninstallRequest {
                item_id: ID.to_string(),
                preflight: true,
                ack: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            preflight.outcome,
            UninstallOutcome::Preflight,
            "{:?}",
            preflight.issues
        );
        uninstall(
            local,
            &self.emitter,
            HarnessPluginUninstallRequest {
                item_id: ID.to_string(),
                preflight: false,
                ack: preflight.ack,
            },
        )
        .await
        .unwrap()
    }

    fn entry(&self) -> Option<PluginEntry> {
        record::load(self.plugins())
            .unwrap()
            .plugins
            .get(NAME)
            .cloned()
    }

    fn host(&self, agent: AgentType) -> HostEntry {
        self.entry().unwrap().hosts[agent.as_wire().as_ref()].clone()
    }

    fn revision_dir(&self, revision: u64) -> PathBuf {
        self.plugins().root.join(NAME).join(revision.to_string())
    }

    /// The fake host's commands so far, and forget them.
    fn take_log(&self) -> Vec<String> {
        let path = self.path("argv.log");
        let text = fs::read_to_string(&path).unwrap_or_default();
        let _ = fs::remove_file(&path);
        text.lines().map(str::to_string).collect()
    }

    fn claude_settings(&self) -> Value {
        match fs::read_to_string(self.claude_config().join("settings.json")) {
            Ok(text) => crate::acp::opencode_config::parse(&text).unwrap(),
            Err(_) => Value::Null,
        }
    }

    fn claude_marketplace(&self) -> Option<Value> {
        fs::read(self.plugins().root.join(".claude-plugin/marketplace.json"))
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }

    fn opencode_config(&self) -> Option<String> {
        fs::read_to_string(self.path("xdg/opencode/opencode.json")).ok()
    }

    fn experts(&self) {
        let report = crate::commands::experts::install_in(self.skills());
        assert!(report.errors.is_empty(), "{:?}", report.errors);
    }

    /// The Experts pack's `brainstorming` switched on for `agent`.
    fn link_expert(&self, agent: AgentType) {
        let _held = self.skills().lock_blocking().unwrap();
        let done = apply_blocking(
            self.skills(),
            &SkillsApplyRequest {
                ops: vec![SkillOp {
                    skill: "brainstorming".into(),
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

    fn expert_store(&self) -> PathBuf {
        fs::canonicalize(self.skills().store.join("brainstorming")).unwrap()
    }

    fn plugin_store(&self, member: &str) -> PathBuf {
        self.skills().store.join(".plugins").join(NAME).join(member)
    }

    fn journals(&self) -> Vec<String> {
        fs::read_dir(self.plugins().root.join(".ops"))
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }
}

fn codes_of(reasons: &[Reason]) -> Vec<&str> {
    reasons.iter().map(|reason| reason.code.as_str()).collect()
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn leads_to(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

fn row(plan: &HarnessPluginPlan, agent: AgentType) -> &PlanHost {
    plan.hosts.iter().find(|row| row.agent == agent).unwrap()
}

/// Revision 1 approved, revision 2 (the latest) waiting for review.
async fn two_revisions() -> Fixture {
    let mut fx = Fixture::new().await;
    fx.publish(1, true);
    fx.publish(2, false);
    fx
}

// ─── The plan ───────────────────────────────────────────────────────────

#[tokio::test]
async fn the_plan_offers_each_agent_what_it_can_take_and_two_versions() {
    let fx = two_revisions().await;
    let plan = fx.plan(&[]).await;
    assert_eq!(plan.latest.revision, 2);
    assert_eq!(plan.full.as_ref().map(|full| full.revision), Some(1));
    assert_eq!(
        plan.not_full,
        Some(crate::harness::types::NotFull::PendingReview)
    );
    // Claude Code and OpenCode as plugins (their adapters found them and
    // the switch allows them); Gemini has no adapter: its skills.
    let claude = row(&plan, CLAUDE);
    assert_eq!(claude.default, PlanMode::Native);
    assert_eq!(
        claude.offered,
        vec![PlanMode::Native, PlanMode::Skills, PlanMode::None]
    );
    assert!(claude.detect.as_ref().unwrap().supported);
    assert_eq!(row(&plan, OPENCODE).default, PlanMode::Native);
    let gemini = row(&plan, GEMINI);
    assert_eq!(gemini.default, PlanMode::Skills);
    assert_eq!(
        gemini.why_not.as_ref().map(|r| r.code.as_str()),
        Some(codes::NO_ADAPTER)
    );
    assert!(gemini.skills.as_ref().unwrap().links.ok);
    // As a plugin: the approved revision, with consent to what runs.
    assert_eq!(plan.target, 1);
    assert_eq!(plan.install_name.as_deref(), Some(NAME));
    assert!(plan.consent_required);
    assert_eq!(plan.consent_exec, Some(fx.exec(1)));
    assert!(plan.blocking.is_empty(), "{:?}", plan.blocking);
    assert!(plan.installed.is_none());

    // Skills only everywhere: the latest, nothing to agree to.
    let skills = fx
        .plan(&[(CLAUDE, PlanMode::Skills), (OPENCODE, PlanMode::None)])
        .await;
    assert_eq!(skills.target, 2);
    assert!(!skills.consent_required);
    assert!(row(&skills, CLAUDE).skills.is_some());

    // The server's switch off for Claude Code: its skills only.
    fx.site.catalog.lock().unwrap().config = json!({ "plugins": { "adapters": {
        "opencode": { "enabled": true, "minVersion": "2.3.2", "maxVersion": null } } } });
    let off = fx.plan(&[]).await;
    let claude = row(&off, CLAUDE);
    assert_eq!(claude.default, PlanMode::Skills);
    assert_eq!(
        claude.why_not.as_ref().map(|r| r.code.as_str()),
        Some(hosts::codes::ADAPTER_OFF)
    );
}

// ─── Install ────────────────────────────────────────────────────────────

#[tokio::test]
async fn native_for_claude_and_skills_for_gemini_installs_full_and_records_it() {
    let fx = two_revisions().await;
    let mut events = fx.events.subscribe();
    let done = fx
        .install_planned(&[(CLAUDE, PlanMode::Native), (OPENCODE, PlanMode::None)])
        .await;
    assert_eq!(
        done.outcome,
        PluginInstallOutcome::Installed,
        "{:?}",
        done.issues
    );
    assert_eq!(done.revision, Some(1));

    // The record: the approved revision for both, how each has it, the
    // host's name, the consent.
    let entry = fx.entry().unwrap();
    assert_eq!(entry.item_id, ID);
    assert_eq!(entry.revision, 1);
    assert_eq!(entry.state_sha256, fx.state(1));
    assert_eq!(entry.exec_sha256, fx.exec(1));
    assert_eq!(
        entry.consent.as_ref().map(|c| c.exec.clone()),
        Some(fx.exec(1))
    );
    assert_eq!(entry.autorun.len(), 2);
    assert_eq!(
        entry.hosts.keys().cloned().collect::<Vec<_>>(),
        vec!["claude_code".to_string(), "gemini".to_string()]
    );
    let claude = fx.host(CLAUDE);
    assert_eq!(claude.mode, HostMode::Native);
    assert_eq!(claude.state, HostState::Active);
    assert_eq!(claude.host_name.as_deref(), Some(NAME));
    assert!(claude.skills.is_empty() && claude.experts.is_empty());
    let gemini = fx.host(GEMINI);
    assert_eq!(gemini.mode, HostMode::Skills);
    assert_eq!(gemini.skills, MEMBERS.map(String::from).to_vec());
    assert!(gemini.host_name.is_none());
    assert!(fx.revision_dir(1).join("index.js").is_file());
    assert!(!exists(&fx.revision_dir(2)));
    assert!(fx.journals().is_empty());

    // Claude Code has it from Codeg's marketplace, pointed at revision 1.
    let log = fx.take_log();
    assert!(
        log.iter()
            .any(|line| line.contains("plugin marketplace add")),
        "{log:?}"
    );
    assert!(log
        .iter()
        .any(|line| line.contains(&format!("plugin install {KEY} --scope user"))));
    let market = fx.claude_marketplace().unwrap();
    assert_eq!(market["plugins"][0]["source"], json!("./superpowers/1"));
    assert_eq!(fx.claude_settings()["enabledPlugins"][KEY], json!(true));
    // Gemini has the members (not the assistant), from the plugin's store.
    for member in MEMBERS {
        assert_eq!(
            leads_to(&fx.path(&format!("gemini/skills/{member}"))),
            leads_to(&fx.plugin_store(member))
        );
    }
    assert!(!exists(&fx.path("gemini/skills/code-reviewer")));
    assert!(fx.opencode_config().is_none());
    let seen: Vec<String> = drain(&mut events).into_iter().map(|(c, _)| c).collect();
    assert!(
        seen.iter().any(|c| c == INSTALLED_CHANGED_EVENT),
        "{seen:?}"
    );

    // Installed: again is an update, not an install.
    let again = fx
        .install_planned(&[(CLAUDE, PlanMode::Native), (OPENCODE, PlanMode::None)])
        .await;
    assert_eq!(codes_of(&again.issues), vec![codes::ALREADY_INSTALLED]);
    let plan = fx.plan(&[]).await;
    assert_eq!(plan.installed.as_ref().map(|i| i.revision), Some(1));
    assert!(codes_of(&plan.blocking).contains(&codes::ALREADY_INSTALLED));

    // Uninstalled: out of both agents, the record and the store.
    let gone = fx.uninstall().await;
    assert_eq!(
        gone.outcome,
        UninstallOutcome::Uninstalled,
        "{:?}",
        gone.issues
    );
    assert!(fx.entry().is_none());
    assert!(!exists(&fx.plugins().root.join(NAME)));
    assert!(fx.claude_marketplace().is_none());
    assert_eq!(fx.claude_settings()["enabledPlugins"], json!({}));
    for member in MEMBERS {
        assert!(!exists(&fx.path(&format!("gemini/skills/{member}"))));
    }
    assert!(!exists(&fx.skills().store.join(".plugins").join(NAME)));
    assert!(fx.journals().is_empty());
}

#[tokio::test]
async fn skills_only_everywhere_installs_the_latest_and_needs_no_consent() {
    let fx = two_revisions().await;
    let plan = fx
        .plan(&[
            (CLAUDE, PlanMode::Skills),
            (OPENCODE, PlanMode::None),
            (GEMINI, PlanMode::Skills),
        ])
        .await;
    assert_eq!(plan.target, 2);
    let mut request = fx.request(&plan);
    assert!(request.consent_exec.is_none());

    // Not the latest: refused once the snapshot is read.
    let mut older = request.clone();
    older.revision = 1;
    older.state_sha256 = fx.state(1);
    let refused = fx.install(older).await;
    assert_eq!(refused.outcome, PluginInstallOutcome::Aborted);
    assert_eq!(codes_of(&refused.issues), vec![codes::REVISION_NOT_TARGET]);
    assert_eq!(refused.issues[0].params["expected"], "2");
    // …and the latest as a plugin is not the one to install whole.
    let mut whole = request.clone();
    whole.hosts.insert(CLAUDE, PlanMode::Native);
    whole.consent_exec = Some(fx.exec(2));
    let refused = fx.install(whole).await;
    assert_eq!(refused.outcome, PluginInstallOutcome::Aborted);
    assert_eq!(refused.issues[0].params["expected"], "1");
    assert!(fx.entry().is_none() && fx.take_log().is_empty());

    request.consent_exec = None;
    let done = fx.install(request).await;
    assert_eq!(
        done.outcome,
        PluginInstallOutcome::Installed,
        "{:?}",
        done.issues
    );
    let entry = fx.entry().unwrap();
    assert_eq!(entry.revision, 2);
    assert!(entry.consent.is_none());
    assert_eq!(fx.host(CLAUDE).mode, HostMode::Skills);
    for member in MEMBERS {
        assert_eq!(
            leads_to(&fx.path(&format!("claude/skills/{member}"))),
            leads_to(&fx.plugin_store(member))
        );
    }
    // Claude Code's own plugin system never ran.
    assert!(fx.take_log().is_empty());
    assert!(fx.claude_marketplace().is_none());
}

#[tokio::test]
async fn as_a_plugin_needs_consent_to_exactly_what_runs() {
    let fx = two_revisions().await;
    let plan = fx
        .plan(&[(CLAUDE, PlanMode::Native), (OPENCODE, PlanMode::None)])
        .await;
    let mut request = fx.request(&plan);
    request.consent_exec = None;
    let refused = fx.install(request.clone()).await;
    assert_eq!(refused.outcome, PluginInstallOutcome::Refused);
    assert_eq!(codes_of(&refused.issues), vec![codes::CONSENT_REQUIRED]);
    request.consent_exec = Some(fx.exec(2));
    let stale = fx.install(request).await;
    assert_eq!(codes_of(&stale.issues), vec![codes::CONSENT_STALE]);
    assert!(fx.entry().is_none());
    assert!(fx.take_log().is_empty());
    assert!(!exists(&fx.plugins().root.join(NAME)));
}

#[tokio::test]
async fn as_a_plugin_is_refused_unless_approved_and_pinned() {
    let fx = two_revisions().await;
    let plan = fx
        .plan(&[(CLAUDE, PlanMode::Native), (OPENCODE, PlanMode::None)])
        .await;
    let request = fx.request(&plan);

    // The approval withdrawn since (the snapshot says so, its fingerprint
    // the same here): aborted before anything is written.
    fx.resolve(1, |resolved| {
        resolved["installed"]["plugin"]["approved"] = json!(false)
    });
    let refused = fx.install(request.clone()).await;
    assert_eq!(refused.outcome, PluginInstallOutcome::Aborted);
    assert_eq!(codes_of(&refused.issues), vec![codes::NOT_APPROVED]);
    // …and the plan no longer offers it.
    let replanned = fx.plan(&[]).await;
    let claude = row(&replanned, CLAUDE);
    assert_eq!(claude.default, PlanMode::Skills);
    assert_eq!(
        claude.why_not.as_ref().map(|r| r.code.as_str()),
        Some(codes::NOT_APPROVED)
    );
    fx.resolve(1, |resolved| {
        resolved["installed"]["plugin"]["approved"] = json!(true)
    });

    // An MCP server it brings is not pinned: never whole.
    fx.version(1, |version| {
        version["plugin"]["mcpUnpinned"] = json!(["playwright"])
    });
    let refused = fx.install(request).await;
    assert_eq!(refused.outcome, PluginInstallOutcome::Refused);
    assert_eq!(codes_of(&refused.issues), vec![codes::MCP_UNPINNED]);
    let replanned = fx.plan(&[]).await;
    assert_eq!(
        row(&replanned, CLAUDE)
            .why_not
            .as_ref()
            .map(|r| r.code.as_str()),
        Some(codes::MCP_UNPINNED)
    );
    assert!(fx.entry().is_none() && fx.take_log().is_empty());
}

#[tokio::test]
async fn a_failure_on_the_second_agent_undoes_the_first_and_gives_the_experts_back() {
    let fx = two_revisions().await;
    fx.experts();
    fx.link_expert(GEMINI);
    let expert = fx.path("gemini/skills/brainstorming");
    assert_eq!(leads_to(&expert), Some(fx.expert_store()));
    let failing = fx.with_claude_env(&[("FAKE_FAIL", "plugin install*")]);
    let plan = fx.plan_with(&failing, &[]).await;
    assert_eq!(row(&plan, GEMINI).experts_to_take_over.len(), 1);
    let mut events = fx.events.subscribe();
    // Gemini (skills), then Claude Code (fails), then OpenCode (never).
    let done = fx.install_with(&failing, fx.request(&plan)).await;
    assert_eq!(done.outcome, PluginInstallOutcome::Failed, "{done:?}");
    let statuses: Vec<(AgentType, HostStepStatus)> =
        done.hosts.iter().map(|h| (h.agent, h.status)).collect();
    assert_eq!(
        statuses,
        vec![
            (GEMINI, HostStepStatus::Undone),
            (CLAUDE, HostStepStatus::Failed)
        ]
    );
    assert!(done.needs_repair.is_empty(), "{:?}", done.needs_repair);
    assert!(codes_of(&done.issues).contains(&codes::HOST_STEP_FAILED));
    let gemini = &done.hosts[0];
    assert_eq!(gemini.experts_taken.len(), 1);
    assert_eq!(gemini.experts_back, gemini.experts_taken);

    // Nothing of it anywhere; the pack's link back.
    assert_eq!(leads_to(&expert), Some(fx.expert_store()));
    assert!(!exists(&fx.path("gemini/skills/writing-plans")));
    assert!(fx.entry().is_none());
    assert!(!exists(&fx.plugins().root.join(NAME)));
    assert!(fx.claude_marketplace().is_none());
    assert!(fx.claude_settings()["enabledPlugins"].get(KEY).is_none());
    assert!(fx.opencode_config().is_none());
    assert!(fx.journals().is_empty());
    assert!(!exists(&fx.skills().store.join(".plugins").join(NAME)));
    let log = fx.take_log();
    assert!(
        log.iter().any(|l| l.contains("plugin marketplace remove")),
        "{log:?}"
    );
    // No record changed: no installed-changed event.
    let seen: Vec<String> = drain(&mut events).into_iter().map(|(c, _)| c).collect();
    assert!(
        !seen.iter().any(|c| c == INSTALLED_CHANGED_EVENT),
        "{seen:?}"
    );
}

#[tokio::test]
async fn the_experts_are_taken_over_and_given_back_on_uninstall() {
    let fx = two_revisions().await;
    fx.experts();
    fx.link_expert(GEMINI);
    fx.link_expert(CLAUDE);
    let gemini_link = fx.path("gemini/skills/brainstorming");
    let claude_link = fx.path("claude/skills/brainstorming");
    let done = fx
        .install_planned(&[(CLAUDE, PlanMode::Native), (OPENCODE, PlanMode::None)])
        .await;
    assert_eq!(done.outcome, PluginInstallOutcome::Installed, "{done:?}");
    // Recorded per agent: what was taken.
    let link = |path: &Path, agent| ExpertLink {
        name: "brainstorming".into(),
        path: path.to_string_lossy().into_owned(),
        copy: false,
        agents: vec![agent],
    };
    assert_eq!(fx.host(GEMINI).experts, vec![link(&gemini_link, GEMINI)]);
    assert_eq!(fx.host(CLAUDE).experts, vec![link(&claude_link, CLAUDE)]);
    // Claude Code has the plugin's (namespaced) instead; Gemini the
    // plugin's skill under the name.
    assert!(!exists(&claude_link));
    assert_eq!(
        leads_to(&gemini_link),
        leads_to(&fx.plugin_store("brainstorming"))
    );

    // The user puts something of their own where Claude Code's was.
    fs::create_dir_all(&claude_link).unwrap();
    fs::write(claude_link.join("SKILL.md"), "the user's\n").unwrap();
    let gone = fx.uninstall().await;
    assert_eq!(
        gone.outcome,
        UninstallOutcome::Uninstalled,
        "{:?}",
        gone.issues
    );
    assert_eq!(leads_to(&gemini_link), Some(fx.expert_store()));
    assert_eq!(
        fs::read_to_string(claude_link.join("SKILL.md")).unwrap(),
        "the user's\n"
    );
    let claude = gone.hosts.iter().find(|h| h.agent == CLAUDE).unwrap();
    assert_eq!(claude.experts_left, vec![link(&claude_link, CLAUDE)]);
    let gemini = gone.hosts.iter().find(|h| h.agent == GEMINI).unwrap();
    assert_eq!(gemini.experts_back, vec![link(&gemini_link, GEMINI)]);
    // Native first, then skills: the reverse of the install.
    assert_eq!(gone.hosts[0].agent, CLAUDE);
}

#[tokio::test]
async fn a_name_another_item_has_is_refused_without_another_name() {
    let fx = two_revisions().await;
    let guard = fx.plugins().lock_blocking().unwrap();
    let mut record = record::load_for_write(fx.plugins()).unwrap();
    record.plugins.insert(
        NAME.to_string(),
        PluginEntry {
            item_id: "0199-another-item".into(),
            item_ref: "someone/superpowers".into(),
            revision: 1,
            version: None,
            archive_sha256: None,
            source: None,
            files: Vec::new(),
            exec_sha256: "e".repeat(64),
            autorun: Vec::new(),
            components: Vec::new(),
            state_sha256: "s".into(),
            consent: None,
            hosts: BTreeMap::new(),
            previous_revision: None,
            held_revisions: Vec::new(),
            installed_at: "2026-11-19T09:30:00.000Z".into(),
            op: "op".into(),
            extra: Default::default(),
        },
    );
    record::save(fx.plugins(), &record).unwrap();
    drop(guard);
    let plan = fx.plan(&[]).await;
    let taken: Vec<&Reason> = plan
        .blocking
        .iter()
        .filter(|r| r.code == codes::INSTALL_NAME_TAKEN)
        .collect();
    assert_eq!(taken.len(), 1, "{:?}", plan.blocking);
    assert_eq!(taken[0].params["ref"], "someone/superpowers");
    let refused = fx.install(fx.request(&plan)).await;
    assert_eq!(refused.outcome, PluginInstallOutcome::Refused);
    assert_eq!(codes_of(&refused.issues), vec![codes::INSTALL_NAME_TAKEN]);
    // Another name is not tried either.
    let mut renamed = fx.request(&plan);
    renamed.install_name = "superpowers-2".into();
    let refused = fx.install(renamed).await;
    assert_eq!(
        codes_of(&refused.issues),
        vec![codes::INSTALL_NAME_MISMATCH]
    );
    assert!(fx.take_log().is_empty());
    assert!(!exists(&fx.plugins().root.join(NAME)));
}

#[tokio::test]
async fn a_crash_midway_is_rolled_back_at_the_next_start_and_marked_for_repair() {
    let fx = two_revisions().await;
    // Claude Code's commands hang: the install is given up on (the app
    // quits) while one runs, after Gemini's skills went in.
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
    assert!(fx.entry().is_none());
    assert!(exists(&fx.path("gemini/skills/brainstorming")));

    // The next start: never a host command, the agents touched marked.
    let guard = fx.plugins().lock_blocking().unwrap();
    let report = journal::recover(fx.plugins(), &guard);
    drop(guard);
    assert_eq!(report.rolled_back, 1, "{:?}", report.problems);
    let mut marked: Vec<String> = report.needs_repair.iter().map(|(_, a)| a.clone()).collect();
    marked.sort();
    assert_eq!(
        marked,
        vec!["claude_code".to_string(), "gemini".to_string()]
    );
    assert!(fx.journals().is_empty());
    let entry = fx.entry().unwrap();
    assert_eq!(entry.revision, 1);
    assert!(entry
        .hosts
        .values()
        .all(|host| host.state == HostState::NeedsRepair));
    assert_eq!(fx.host(GEMINI).skills, MEMBERS.map(String::from).to_vec());
    assert!(entry.held_revisions.contains(&1));
    assert!(fx.revision_dir(1).is_dir());

    // What the agents have can still be taken out.
    let gone = fx.uninstall().await;
    assert_eq!(gone.outcome, UninstallOutcome::Uninstalled, "{:?}", gone);
    assert!(fx.entry().is_none());
    assert!(!exists(&fx.path("gemini/skills/brainstorming")));
    assert!(fx.claude_marketplace().is_none());
    assert!(!exists(&fx.plugins().root.join(NAME)));
}

#[tokio::test]
async fn skills_for_an_agent_with_a_shared_directory_and_one_reading_it_go_in_on_one_confirmation()
{
    let fx = two_revisions().await;
    // An agent that reads only the shared directory (Gemini reads it too)
    // links into it.
    let modes = [
        (GEMINI, PlanMode::Skills),
        (crate::skills::tests::shared_only_agent(), PlanMode::Skills),
    ];
    let plan = fx.plan_for(&modes).await;
    // Gemini first would leave the other's link a link of Gemini's to fold into
    // the shared directory, which no `ack` of the plan's covered: the
    // shared directory goes first.
    let done = fx.install(fx.request(&plan)).await;
    assert_eq!(
        done.outcome,
        PluginInstallOutcome::Installed,
        "{:?}",
        done.issues
    );
    for member in MEMBERS {
        assert_eq!(
            leads_to(&fx.path(&format!("agents/skills/{member}"))),
            leads_to(&fx.plugin_store(member))
        );
        // Gemini sees it there: no second link of its own.
        assert!(!exists(&fx.path(&format!("gemini/skills/{member}"))));
    }
    let gone = fx.uninstall().await;
    assert_eq!(
        gone.outcome,
        UninstallOutcome::Uninstalled,
        "{:?}",
        gone.issues
    );
    assert!(!exists(&fx.path("agents/skills/brainstorming")));
    assert!(fx.entry().is_none());
}

#[tokio::test]
async fn an_unpinned_mcp_package_keeps_it_whole_out_but_not_its_skills() {
    let fx = two_revisions().await;
    for revision in [1, 2] {
        fx.resolve(revision, |resolved| {
            resolved["installed"]["packages"] = json!([{ "registryType": "npm",
                "identifier": "@acme/mcp", "version": null, "verified": "unchecked" }]);
        });
    }
    let plan = fx.plan(&[]).await;
    // Not whole (the package is no exact version) …
    let claude = row(&plan, CLAUDE);
    assert_eq!(claude.default, PlanMode::Skills);
    assert_eq!(
        claude.why_not.as_ref().map(|r| r.code.as_str()),
        Some(crate::harness::mcp::model::codes::PACKAGE_VERSION_INEXACT)
    );
    // … but its skills, the latest, as ever.
    assert!(
        plan.latest.blocking.is_empty(),
        "{:?}",
        plan.latest.blocking
    );
    assert!(plan.blocking.is_empty(), "{:?}", plan.blocking);
    assert_eq!(plan.target, 2);
    let done = fx.install(fx.request(&plan)).await;
    assert_eq!(
        done.outcome,
        PluginInstallOutcome::Installed,
        "{:?}",
        done.issues
    );
    assert_eq!(fx.host(CLAUDE).mode, HostMode::Skills);
}

#[tokio::test]
async fn the_plan_takes_the_latest_from_the_fresh_snapshot() {
    let fx = two_revisions().await;
    // The item's answer is behind (a cache): it still says 1.
    fx.site.catalog.lock().unwrap().latest = 1;
    let plan = fx
        .plan(&[(CLAUDE, PlanMode::Skills), (OPENCODE, PlanMode::None)])
        .await;
    assert_eq!(plan.latest.revision, 2);
    assert_eq!(plan.target, 2);
    let done = fx.install(fx.request(&plan)).await;
    assert_eq!(
        done.outcome,
        PluginInstallOutcome::Installed,
        "{:?}",
        done.issues
    );
    assert_eq!(fx.entry().unwrap().revision, 2);
}

#[tokio::test]
async fn opencode_is_offered_whole_only_with_an_entry_it_loads() {
    let fx = two_revisions().await;
    // No `index.js`: OpenCode loads the file `package.json`'s `main` names.
    let with_package =
        |text: &str, main_listed: bool| {
            let sha_of = sha(text.as_bytes());
            fx.site.catalog.lock().unwrap().blobs.insert(
                format!("/api/harness/v1/blobs/{sha_of}"),
                text.as_bytes().to_vec(),
            );
            fx.version(1, |version| {
            let files = version["files"].as_array_mut().unwrap();
            files.retain(|file| {
                !["index.js", "package.json", ".opencode/plugins/superpowers.js"]
                    .contains(&file["path"].as_str().unwrap())
            });
            files.push(json!({ "path": "package.json", "sha256": sha_of,
                               "size": text.len(), "executable": false }));
            if main_listed {
                files.push(json!({ "path": ".opencode/plugins/superpowers.js",
                                   "sha256": sha(b"x"), "size": 1, "executable": false }));
            }
            version["plugin"]["autorun"] = json!([
                { "host": "opencode", "type": "code", "path": ".opencode/plugins/superpowers.js" }
            ]);
        });
        };
    let default = |plan: &HarnessPluginPlan| {
        let row = row(plan, OPENCODE);
        (row.default, row.why_not.as_ref().map(|r| r.code.clone()))
    };
    // A `package.json` without a `main`.
    with_package("{}", true);
    assert_eq!(
        default(&fx.plan(&[]).await),
        (
            PlanMode::Skills,
            Some(hosts::codes::ENTRY_MISSING.to_string())
        )
    );
    // A `main` that is not in the package.
    with_package(r#"{"main":"./.opencode/plugins/superpowers.js"}"#, false);
    assert_eq!(default(&fx.plan(&[]).await).0, PlanMode::Skills);
    // A `main` that is.
    with_package(r#"{"main":"./.opencode/plugins/superpowers.js"}"#, true);
    assert_eq!(default(&fx.plan(&[]).await), (PlanMode::Native, None));
}

#[tokio::test]
async fn an_uninstall_that_fails_for_one_agent_keeps_only_that_agent() {
    let fx = two_revisions().await;
    let done = fx
        .install_planned(&[(CLAUDE, PlanMode::Native), (OPENCODE, PlanMode::None)])
        .await;
    assert_eq!(done.outcome, PluginInstallOutcome::Installed, "{done:?}");
    let failing = fx.with_claude_env(&[("FAKE_FAIL", "plugin uninstall*")]);
    let partly = fx.uninstall_with(&failing).await;
    assert_eq!(partly.outcome, UninstallOutcome::WriteFailed, "{partly:?}");
    assert_eq!(partly.needs_repair, vec![CLAUDE]);
    let entry = fx.entry().unwrap();
    assert_eq!(
        entry.hosts.keys().cloned().collect::<Vec<_>>(),
        vec!["claude_code".to_string()]
    );
    assert_eq!(fx.host(CLAUDE).state, HostState::NeedsRepair);
    assert_eq!(fx.host(CLAUDE).host_name.as_deref(), Some(NAME));
    assert!(!exists(&fx.path("gemini/skills/brainstorming")));
    // Its revision stays while Claude Code may load from it.
    assert!(fx.revision_dir(1).is_dir());
    assert!(fx.journals().is_empty());

    let gone = fx.uninstall().await;
    assert_eq!(
        gone.outcome,
        UninstallOutcome::Uninstalled,
        "{:?}",
        gone.issues
    );
    assert!(fx.entry().is_none());
    assert!(fx.claude_marketplace().is_none());
    assert!(!exists(&fx.plugins().root.join(NAME)));
}

#[tokio::test]
async fn each_skills_agent_is_confirmed_as_its_turn_will_find_the_links() {
    // Two agents that each read only a shared directory of their own, and a
    // third that reads both: the first install shows it the skills, the
    // second only adds another way to them.
    let (one, two, both) = (
        AgentType::custom("p8-one").unwrap(),
        AgentType::custom("p8-two").unwrap(),
        AgentType::custom("p8-both").unwrap(),
    );
    let mut fx = Fixture::with_agents(Some(vec![
        (one, vec!["shared-1"]),
        (two, vec!["shared-2"]),
        (both, vec!["shared-1", "shared-2"]),
    ]))
    .await;
    fx.publish(1, true);
    let plan = fx
        .plan_for(&[(one, PlanMode::Skills), (two, PlanMode::Skills)])
        .await;
    assert!(plan.blocking.is_empty(), "{:?}", plan.blocking);
    let done = fx.install(fx.request(&plan)).await;
    assert_eq!(
        done.outcome,
        PluginInstallOutcome::Installed,
        "{:?}",
        done.issues
    );
    for dir in ["shared-1", "shared-2"] {
        assert_eq!(
            leads_to(&fx.path(&format!("{dir}/brainstorming"))),
            leads_to(&fx.plugin_store("brainstorming"))
        );
    }
    let gone = fx.uninstall().await;
    assert_eq!(
        gone.outcome,
        UninstallOutcome::Uninstalled,
        "{:?}",
        gone.issues
    );
    assert!(!exists(&fx.path("shared-1/brainstorming")));
    assert!(!exists(&fx.path("shared-2/brainstorming")));
}

#[tokio::test]
async fn an_agent_whose_turn_never_came_only_gets_its_experts_back() {
    let fx = two_revisions().await;
    fx.experts();
    fx.link_expert(OPENCODE);
    let expert = fx.path("opencode/skills/brainstorming");
    assert_eq!(leads_to(&expert), Some(fx.expert_store()));
    // Claude Code's turn fails; OpenCode's never comes (its Experts link was
    // taken before any agent's turn).
    let failing = fx.with_claude_env(&[("FAKE_FAIL", "plugin install*")]);
    let plan = fx.plan_with(&failing, &[(GEMINI, PlanMode::None)]).await;
    assert_eq!(row(&plan, OPENCODE).planned, PlanMode::Native);
    let done = fx.install_with(&failing, fx.request(&plan)).await;
    assert_eq!(done.outcome, PluginInstallOutcome::Failed, "{done:?}");
    let opencode = done.hosts.iter().find(|h| h.agent == OPENCODE).unwrap();
    assert_eq!(opencode.status, HostStepStatus::Undone);
    assert_eq!(opencode.experts_back.len(), 1);
    assert!(done.needs_repair.is_empty(), "{:?}", done.needs_repair);
    assert_eq!(leads_to(&expert), Some(fx.expert_store()));
    assert!(fx.opencode_config().is_none());
    assert!(fx.entry().is_none());
}

#[path = "update_tests.rs"]
mod update_tests;

#[path = "guard_tests.rs"]
mod guard_tests;

#[path = "listing_tests.rs"]
mod listing_tests;
