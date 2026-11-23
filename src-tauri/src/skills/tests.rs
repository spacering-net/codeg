//! The skills engine's tests. Everything runs over temporary directories:
//! a store, a lock and agent directories of the test's own ([`Home`],
//! [`fixture_ctx`]) handed to the entry points that take them, or — for the
//! few that resolve the user's directories themselves (the older packs'
//! commands) — a home of the test's own ([`with_hermetic_home`], not on
//! Windows). The real home's skills and agent directories are never read or
//! written.

#[cfg(not(windows))]
use std::ffi::OsString;
use std::fs;
#[cfg(not(windows))]
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use include_dir::{Dir, DirEntry, File};

use crate::models::agent::AgentType;
use crate::web::event_bridge::EventEmitter;

use super::adopt::{adopt_blocking, AdoptRequest};
use super::apply::{apply_blocking, repair_blocking, RepairRequest};
use super::link::{platform_link, LinkMode, LinkStrategy, PlatformLinks};
use super::model::*;
use super::packs::{install_bundle, Bundle};
use super::record::{LinkRecord, RecordEntry};
use super::world::World;
use super::{AgentDirs, SkillsCtx};

/// Every variable that moves an agent's skill directory away from the home.
#[cfg(not(windows))]
pub(crate) const RELOCATING_VARS: &[&str] = &[
    "CODEX_HOME",
    "OPENCODE_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "HERMES_HOME",
    "KIMI_CODE_HOME",
    "PI_CODING_AGENT_DIR",
    "GROK_HOME",
    "DSH_HOME",
    "DSH_AGENTS_HOME",
    "QODER_CONFIG_DIR",
    "QODER_CLI_HOME",
    "QODER_CONFIG_DIR_NAME",
    "GEMINI_HOME",
    "GEMINI_CLI_HOME",
    "KIRO_HOME",
    "TRAE_HOME",
    "TRAECLI_HOME",
    "CURSOR_CONFIG_DIR",
    "ZCODE_HOME",
    "CLAUDE_CONFIG_DIR",
];

/// Run `body` with `HOME` (and `USERPROFILE`) at `home` and every variable
/// that relocates an agent's skill directory unset, under `temp_env`'s lock:
/// the store, the lock and every agent's directories resolve inside `home`.
///
/// **Not on Windows**: there the home is the OS profile folder (`dirs` asks
/// the profile API and reads neither variable), so a test that relied on this
/// would read and write the real one. It is not compiled there, so every test
/// that uses it has to say `#[cfg(not(windows))]`; what such a test checks is
/// also covered through an injected [`SkillsCtx`] ([`fixture_ctx`]).
#[cfg(not(windows))]
pub(crate) async fn with_hermetic_home<F: Future>(home: &Path, body: F) -> F::Output {
    let mut vars: Vec<(&str, Option<OsString>)> = vec![
        ("HOME", Some(home.as_os_str().to_owned())),
        ("USERPROFILE", Some(home.as_os_str().to_owned())),
    ];
    for var in RELOCATING_VARS {
        vars.push((var, None));
    }
    temp_env::async_with_vars(vars, body).await
}

// ─── A home of the test's own ───────────────────────────────────────────

/// The real layout in miniature, under `root` (see [`Home`]): the store at
/// `root/store`, the lock at `root/locks/skills.lock`, and the agents'
/// directories beside them. For the tests of the commands that take an
/// injected [`SkillsCtx`] — nothing resolves the user's home.
pub(crate) fn fixture_ctx(root: &Path) -> SkillsCtx {
    fixture_ctx_with(root, Arc::new(PlatformLinks))
}

fn fixture_ctx_with(root: &Path, linker: Arc<dyn LinkStrategy>) -> SkillsCtx {
    let d = |rel: &str| root.join(rel);
    let agent = |agent, dirs: Vec<PathBuf>, read_only: Vec<PathBuf>, markdown_files| AgentDirs {
        agent,
        dirs,
        read_only,
        markdown_files,
    };
    let agents = vec![
        agent(
            AgentType::ClaudeCode,
            vec![d("claude/skills")],
            vec![],
            false,
        ),
        agent(
            AgentType::Codex,
            vec![
                d("codex/skills"),
                d("codex/skills/.system"),
                d("agents/skills"),
            ],
            vec![d("codex/skills/.system")],
            true,
        ),
        agent(
            AgentType::Gemini,
            vec![d("gemini/skills"), d("agents/skills")],
            vec![],
            false,
        ),
        agent(
            AgentType::Cline,
            vec![d("agents/skills"), d("cline/skills")],
            vec![],
            false,
        ),
        agent(
            AgentType::OpenCode,
            vec![
                d("opencode/skills"),
                d("opencode/skill"),
                d("agents/skills"),
            ],
            vec![],
            true,
        ),
        agent(shared_only_agent(), vec![d("agents/skills")], vec![], false),
    ];
    SkillsCtx::new(d("store"), d("locks/skills.lock"), agents, linker)
}

fn shared_only_agent() -> AgentType {
    AgentType::custom("k1-shared-store-agent").expect("a valid custom id")
}

/// The real layout in miniature: Claude with one directory; Codex with its
/// own, its read-only `.system` and the shared `agents/skills`; Gemini and
/// OpenCode with their own and the shared one; Cline with the shared one
/// FIRST and its own second; a custom agent that declared only the shared
/// store.
struct Home {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    ctx: SkillsCtx,
}

impl Home {
    fn new() -> Self {
        Self::with_linker(Arc::new(PlatformLinks))
    }

    fn with_linker(linker: Arc<dyn LinkStrategy>) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        let ctx = fixture_ctx_with(&root, linker);
        Self {
            _tmp: tmp,
            root,
            ctx,
        }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    fn store(&self, id: &str) -> PathBuf {
        self.ctx.store.join(id)
    }

    /// A Custom skill in the store.
    fn skill(&self, id: &str, body: &str) {
        let dir = self.store(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {id}\n---\n{body}\n"),
        )
        .unwrap();
    }

    /// A link into the store that an older release made (nothing recorded).
    fn plant_link(&self, dir: &str, id: &str) -> PathBuf {
        let dir = self.path(dir);
        fs::create_dir_all(&dir).unwrap();
        let link = dir.join(id);
        platform_link(&self.store(id), &link).unwrap();
        link
    }

    fn is_link_to(&self, path: &Path, id: &str) -> bool {
        fs::symlink_metadata(path)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
            && fs::canonicalize(path).ok() == fs::canonicalize(self.store(id)).ok()
    }

    fn run(&self, ops: Vec<SkillOp>, preflight: bool) -> SkillsApplyResult {
        let _guard = (!preflight).then(|| self.ctx.lock_blocking().unwrap());
        apply_blocking(&self.ctx, &SkillsApplyRequest { ops, preflight }).0
    }

    /// Preflight, show the effects, send back every `ack` it returned.
    fn confirm(&self, mut ops: Vec<SkillOp>) -> SkillsApplyResult {
        let preflight = self.run(ops.clone(), true);
        for (op, result) in ops.iter_mut().zip(&preflight.ops) {
            op.ack = result.ack.clone();
        }
        self.run(ops, false)
    }

    fn cell(&self, skill: &str, agent: AgentType) -> SkillCell {
        World::load(&self.ctx).cell(agent, skill)
    }

    fn record(&self) -> LinkRecord {
        LinkRecord::load(&self.ctx.store)
    }

    /// No staging folder is left anywhere.
    fn assert_no_staging(&self) {
        let mut found = Vec::new();
        for dir in [
            "claude", "codex", "gemini", "cline", "opencode", "agents", "store",
        ] {
            for name in [".codeg-skills-staging", ".codeg-staging"] {
                let path = self.path(dir).join(name);
                if path.exists() {
                    found.push(path);
                }
            }
        }
        assert!(found.is_empty(), "staging left behind: {found:?}");
    }
}

fn op(skill: &str, agent: AgentType, action: SkillAction) -> SkillOp {
    SkillOp {
        skill: skill.to_string(),
        agent,
        action,
        ack: None,
        replace_modified: false,
    }
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn codes_of(issues: &[SkillsIssue]) -> Vec<&str> {
    issues.iter().map(|issue| issue.code.as_str()).collect()
}

/// Where Windows cannot make a junction: every link fails, a copy stands in.
struct FailingJunction;

impl LinkStrategy for FailingJunction {
    fn link(&self, _target: &Path, _link: &Path) -> io::Result<LinkMode> {
        Err(io::Error::other("the junction failed (test)"))
    }

    fn copy_fallback(&self) -> bool {
        true
    }
}

// ─── Directories ────────────────────────────────────────────────────────

#[test]
fn which_directories_are_shared_is_worked_out_from_who_reads_them() {
    let home = Home::new();
    let ctx = &home.ctx;
    let shared = ctx.dir_info(&home.path("agents/skills")).unwrap();
    let mut readers = shared.readers.clone();
    readers.sort();
    let mut expected = vec![
        AgentType::Codex,
        AgentType::Gemini,
        AgentType::Cline,
        AgentType::OpenCode,
        shared_only_agent(),
    ];
    expected.sort();
    assert_eq!(readers, expected);

    // Cline's first directory is the shared one; enabling uses its own.
    assert_eq!(
        ctx.link_dir(AgentType::Cline),
        Some((home.path("cline/skills"), false))
    );
    assert_eq!(
        ctx.link_dir(AgentType::Codex),
        Some((home.path("codex/skills"), false))
    );
    // Only a shared directory: the link would go there, and say so.
    assert_eq!(
        ctx.link_dir(shared_only_agent()),
        Some((home.path("agents/skills"), true))
    );
    let roles: Vec<(PathBuf, DirRole)> = ctx
        .dirs_of(AgentType::Codex)
        .into_iter()
        .map(|(info, role)| (info.path.clone(), role))
        .collect();
    assert_eq!(
        roles,
        vec![
            (home.path("codex/skills"), DirRole::Own),
            (home.path("codex/skills/.system"), DirRole::ReadOnly),
            (home.path("agents/skills"), DirRole::Shared),
        ]
    );
}

/// The same, from the real `skill_storage_spec` over a home of the test's
/// own: `~/.agents/skills` is shared, and Cline links into `~/.cline/skills`.
/// (Not on Windows, where the home cannot be one of the test's own:
/// [`with_hermetic_home`].)
#[cfg(not(windows))]
#[tokio::test]
async fn the_real_agents_share_the_agents_store_and_cline_gets_its_own() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().to_path_buf();
    let (cline, codex_roles) = with_hermetic_home(&home, async {
        let ctx = SkillsCtx::user();
        let cline = ctx.link_dir(AgentType::Cline);
        let codex_roles: Vec<(PathBuf, DirRole)> = ctx
            .dirs_of(AgentType::Codex)
            .into_iter()
            .map(|(info, role)| (info.path.clone(), role))
            .collect();
        (cline, codex_roles)
    })
    .await;
    assert_eq!(cline, Some((home.join(".cline").join("skills"), false)));
    assert!(
        codex_roles.contains(&(home.join(".agents").join("skills"), DirRole::Shared)),
        "{codex_roles:?}"
    );
    assert!(
        codex_roles.contains(&(
            home.join(".codex").join("skills").join(".system"),
            DirRole::ReadOnly
        )),
        "{codex_roles:?}"
    );
}

// ─── Shared directories ─────────────────────────────────────────────────

#[test]
fn enabling_for_cline_links_into_its_own_directory_and_leaves_the_others_alone() {
    let home = Home::new();
    home.skill("x", "body");
    let result = home.run(vec![op("x", AgentType::Cline, SkillAction::Enable)], false);
    assert_eq!(result.outcome, ApplyOutcome::Applied, "{result:?}");
    let op = &result.ops[0];
    assert_eq!(op.status, OpStatus::Done);
    assert!(op.gains.is_empty() && op.loses.is_empty() && op.touches.is_empty());
    assert!(op.ack.is_none(), "nobody else is affected");
    assert!(home.is_link_to(&home.path("cline/skills/x"), "x"));
    assert!(!exists(&home.path("agents/skills/x")));

    assert_eq!(home.cell("x", AgentType::Cline).state, CellState::Linked);
    for agent in [
        AgentType::Codex,
        AgentType::Gemini,
        AgentType::OpenCode,
        shared_only_agent(),
    ] {
        assert_eq!(
            home.cell("x", agent).state,
            CellState::NotLinked,
            "{agent:?}"
        );
    }
    let entry = home.record();
    let entry = entry.get(&home.path("cline/skills/x")).expect("recorded");
    assert_eq!(entry.skill, "x");
    assert_ne!(entry.mode, LinkMode::Copy);
}

#[test]
fn a_legacy_link_in_the_shared_directory_is_reported_as_it_is() {
    let home = Home::new();
    home.skill("x", "body");
    let link = home.plant_link("agents/skills", "x");

    let codex = home.cell("x", AgentType::Codex);
    assert_eq!(codex.state, CellState::VisibleThrough);
    assert_eq!(
        codex.dir.as_deref(),
        Some(home.path("agents/skills").to_str().unwrap())
    );
    assert!(
        codex.codeg,
        "a link into the store is Codeg's, record or not"
    );
    assert!(codex.shared_with.contains(&AgentType::Cline));
    assert!(!codex.shared_with.contains(&AgentType::Codex));
    assert_eq!(
        home.cell("x", AgentType::Cline).state,
        CellState::VisibleThrough
    );
    assert_eq!(
        home.cell("x", AgentType::ClaudeCode).state,
        CellState::NotLinked
    );

    // Codex already sees it: nothing is added to its own directory.
    let result = home.run(vec![op("x", AgentType::Codex, SkillAction::Enable)], false);
    assert_eq!(result.ops[0].status, OpStatus::Unchanged, "{result:?}");
    assert_eq!(
        codes_of(&result.ops[0].warnings),
        vec![codes::ALREADY_VISIBLE]
    );
    assert!(!exists(&home.path("codex/skills/x")));
    assert!(
        home.is_link_to(&link, "x"),
        "the older link stays where it is"
    );

    // The older packs' view says the same: Codex's cell is on.
    let statuses = super::legacy::statuses(
        &home.ctx,
        SkillOrigin::Custom,
        &["x".to_string()],
        &[AgentType::Codex, AgentType::ClaudeCode],
    );
    assert_eq!(
        statuses[0].state,
        crate::commands::experts::ExpertLinkState::LinkedToCodeg
    );
    assert_eq!(statuses[0].link_path, link.to_string_lossy());
    assert_eq!(
        statuses[1].state,
        crate::commands::experts::ExpertLinkState::NotLinked
    );
}

#[test]
fn disabling_codex_never_takes_a_shared_link_unasked() {
    let home = Home::new();
    home.skill("x", "body");
    let link = home.plant_link("agents/skills", "x");
    let disable = || vec![op("x", AgentType::Codex, SkillAction::Disable)];

    // The preflight names everyone who loses it, and that Codex cannot be
    // turned off alone.
    let preflight = home.run(disable(), true);
    assert_eq!(preflight.outcome, ApplyOutcome::Preflight);
    let planned = &preflight.ops[0];
    assert_eq!(planned.status, OpStatus::NeedsAck);
    let mut expected = vec![
        AgentType::Gemini,
        AgentType::Cline,
        AgentType::OpenCode,
        shared_only_agent(),
    ];
    expected.sort();
    assert_eq!(planned.loses, expected);
    assert_eq!(planned.removes.len(), 1);
    assert_eq!(planned.removes[0].path, link.to_string_lossy());
    assert!(codes_of(&planned.warnings).contains(&codes::DISABLED_TOGETHER));
    let ack = planned.ack.clone().expect("an ack for these effects");
    assert!(home.is_link_to(&link, "x"), "a preflight writes nothing");

    // Without it: refused, nothing written.
    let refused = home.run(disable(), false);
    assert_eq!(refused.outcome, ApplyOutcome::AcknowledgementRequired);
    assert!(!refused.ok);
    assert_eq!(
        codes_of(&refused.ops[0].issues),
        vec![codes::ACKNOWLEDGEMENT_REQUIRED]
    );
    assert!(home.is_link_to(&link, "x"));

    // With an ack for other effects: refused as stale.
    let mut stale = disable();
    stale[0].ack = Some("0".repeat(64));
    let refused = home.run(stale, false);
    assert_eq!(refused.outcome, ApplyOutcome::AcknowledgementRequired);
    assert_eq!(
        codes_of(&refused.ops[0].issues),
        vec![codes::EFFECTS_CHANGED]
    );
    assert!(home.is_link_to(&link, "x"));

    // Confirmed: it goes, for all of them.
    let mut confirmed = disable();
    confirmed[0].ack = Some(ack);
    let done = home.run(confirmed, false);
    assert_eq!(done.outcome, ApplyOutcome::Applied, "{done:?}");
    assert!(!exists(&link));
    for agent in expected {
        assert_eq!(home.cell("x", agent).state, CellState::NotLinked);
    }

    // The older commands cannot ask, so they refuse with the code.
    let link = home.plant_link("agents/skills", "x");
    let (result, _) = super::legacy::apply_one(
        &home.ctx,
        SkillOrigin::Custom,
        &crate::commands::experts::LinkOp {
            expert_id: "x".into(),
            agent_type: AgentType::Codex,
            enable: false,
        },
    );
    assert!(!result.ok);
    assert_eq!(
        result.code.as_deref(),
        Some(codes::ACKNOWLEDGEMENT_REQUIRED)
    );
    assert!(home.is_link_to(&link, "x"));
}

#[test]
fn only_for_cline_moves_the_link_into_its_own_directory() {
    let home = Home::new();
    home.skill("x", "body");
    let shared = home.plant_link("agents/skills", "x");
    let own = home.path("cline/skills/x");

    let preflight = home.run(vec![op("x", AgentType::Cline, SkillAction::Only)], true);
    let planned = &preflight.ops[0];
    assert_eq!(planned.status, OpStatus::NeedsAck);
    assert_eq!(
        planned.moves,
        vec![PathMove {
            from: shared.to_string_lossy().into_owned(),
            to: own.to_string_lossy().into_owned(),
        }]
    );
    assert!(planned.creates.is_empty() && planned.removes.is_empty());
    let mut losers = vec![
        AgentType::Codex,
        AgentType::Gemini,
        AgentType::OpenCode,
        shared_only_agent(),
    ];
    losers.sort();
    assert_eq!(planned.loses, losers);

    let done = home.confirm(vec![op("x", AgentType::Cline, SkillAction::Only)]);
    assert_eq!(done.outcome, ApplyOutcome::Applied, "{done:?}");
    assert!(home.is_link_to(&own, "x"));
    assert!(!exists(&shared));
    assert_eq!(home.cell("x", AgentType::Cline).state, CellState::Linked);
    assert_eq!(home.cell("x", AgentType::Codex).state, CellState::NotLinked);
}

#[test]
fn a_shared_only_agent_needs_confirming_and_nobody_gets_two() {
    let home = Home::new();
    home.skill("x", "body");
    // Codex has its own link already.
    let codex_own = home.path("codex/skills/x");
    assert_eq!(
        home.run(vec![op("x", AgentType::Codex, SkillAction::Enable)], false)
            .outcome,
        ApplyOutcome::Applied
    );
    assert!(home.is_link_to(&codex_own, "x"));

    let preflight = home.run(
        vec![op("x", shared_only_agent(), SkillAction::Enable)],
        true,
    );
    let planned = &preflight.ops[0];
    assert_eq!(planned.status, OpStatus::NeedsAck);
    assert_eq!(
        planned.creates,
        vec![PathChange {
            path: home.path("agents/skills/x").to_string_lossy().into_owned(),
            kind: ChangeKind::Link,
        }]
    );
    assert_eq!(
        planned.removes,
        vec![PathChange {
            path: codex_own.to_string_lossy().into_owned(),
            kind: ChangeKind::Link,
        }]
    );
    let mut gains = vec![AgentType::Gemini, AgentType::Cline, AgentType::OpenCode];
    gains.sort();
    assert_eq!(planned.gains, gains);
    assert_eq!(planned.touches, vec![AgentType::Codex]);
    assert!(codes_of(&planned.warnings).contains(&codes::SHARED_DIRECTORY));

    let done = home.confirm(vec![op("x", shared_only_agent(), SkillAction::Enable)]);
    assert_eq!(done.outcome, ApplyOutcome::Applied, "{done:?}");
    assert!(home.is_link_to(&home.path("agents/skills/x"), "x"));
    assert!(!exists(&codex_own), "Codex sees it through the shared one");
    assert_eq!(
        home.cell("x", AgentType::Codex).state,
        CellState::VisibleThrough
    );
}

#[test]
fn an_acknowledgement_confirms_only_the_effects_it_was_given_for() {
    let home = Home::new();
    home.skill("x", "body");
    let enable = || vec![op("x", shared_only_agent(), SkillAction::Enable)];
    let shown = home.run(enable(), true).ops[0].ack.clone().unwrap();
    // Before the user confirms, Codex gets the skill of its own: the effects
    // are no longer the ones shown (its link would now be removed).
    assert_eq!(
        home.run(vec![op("x", AgentType::Codex, SkillAction::Enable)], false)
            .outcome,
        ApplyOutcome::Applied
    );
    let mut stale = enable();
    stale[0].ack = Some(shown);
    let refused = home.run(stale, false);
    assert_eq!(refused.outcome, ApplyOutcome::AcknowledgementRequired);
    assert_eq!(
        codes_of(&refused.ops[0].issues),
        vec![codes::EFFECTS_CHANGED]
    );
    assert!(!exists(&home.path("agents/skills/x")), "nothing written");
    assert!(home.is_link_to(&home.path("codex/skills/x"), "x"));
}

#[test]
fn one_blocked_operation_stops_the_whole_request() {
    let home = Home::new();
    home.skill("x", "body");
    fs::create_dir_all(home.path("gemini/skills/x")).unwrap();
    let result = home.run(
        vec![
            op("x", AgentType::ClaudeCode, SkillAction::Enable),
            op("x", AgentType::Gemini, SkillAction::Enable),
        ],
        false,
    );
    assert_eq!(result.outcome, ApplyOutcome::Invalid);
    assert_eq!(result.ops[0].status, OpStatus::NotDone);
    assert_eq!(result.ops[1].status, OpStatus::Blocked);
    assert_eq!(
        codes_of(&result.ops[1].issues),
        vec![codes::TARGET_OCCUPIED]
    );
    assert!(!exists(&home.path("claude/skills/x")));
}

// ─── Copies (Windows: a junction that fails) ────────────────────────────

#[test]
fn a_same_name_folder_at_the_target_is_never_copied_over() {
    let home = Home::with_linker(Arc::new(FailingJunction));
    home.skill("x", "codeg's");
    let folder = home.path("claude/skills/x");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("SKILL.md"), "mine\n").unwrap();

    let result = home.run(
        vec![op("x", AgentType::ClaudeCode, SkillAction::Enable)],
        false,
    );
    assert_eq!(result.outcome, ApplyOutcome::Invalid, "{result:?}");
    assert_eq!(
        codes_of(&result.ops[0].issues),
        vec![codes::TARGET_OCCUPIED]
    );
    assert_eq!(
        fs::read_to_string(folder.join("SKILL.md")).unwrap(),
        "mine\n"
    );
    assert_eq!(
        fs::read_dir(&folder).unwrap().count(),
        1,
        "nothing copied in"
    );
    assert!(home.record().entries().next().is_none());
    assert_eq!(
        home.cell("x", AgentType::ClaudeCode).state,
        CellState::Blocked
    );
    home.assert_no_staging();
}

#[test]
fn a_copy_is_made_where_no_link_can_be_and_recorded_with_its_hash() {
    let home = Home::with_linker(Arc::new(FailingJunction));
    home.skill("x", "v1");
    fs::create_dir_all(home.store("x").join("scripts")).unwrap();
    fs::write(home.store("x").join("scripts/run.sh"), "#!/bin/sh\n").unwrap();

    let result = home.run(
        vec![op("x", AgentType::ClaudeCode, SkillAction::Enable)],
        false,
    );
    assert_eq!(result.outcome, ApplyOutcome::Applied, "{result:?}");
    let applied = &result.ops[0];
    assert_eq!(applied.creates[0].kind, ChangeKind::Copy);
    assert_eq!(codes_of(&applied.warnings), vec![codes::COPIED]);

    let copy = home.path("claude/skills/x");
    assert!(
        copy.is_dir()
            && !fs::symlink_metadata(&copy)
                .unwrap()
                .file_type()
                .is_symlink()
    );
    assert_eq!(
        fs::read_to_string(copy.join("scripts/run.sh")).unwrap(),
        "#!/bin/sh\n"
    );
    let record = home.record();
    let entry = record.get(&copy).expect("the copy is recorded");
    assert_eq!(entry.mode, LinkMode::Copy);
    assert_eq!(
        entry.copy_hash.as_deref(),
        Some(
            super::fsio::hash_skill_dir(&home.store("x"), "x")
                .unwrap()
                .as_str()
        )
    );

    let cell = home.cell("x", AgentType::ClaudeCode);
    assert_eq!(cell.state, CellState::Copy);
    assert_eq!(cell.copy_matches, Some(true));
    assert_eq!(cell.copy_current, Some(true));
    // The older screens show it as on, in copy mode.
    let status = &super::legacy::statuses(
        &home.ctx,
        SkillOrigin::Custom,
        &["x".to_string()],
        &[AgentType::ClaudeCode],
    )[0];
    assert_eq!(
        status.state,
        crate::commands::experts::ExpertLinkState::LinkedToCodeg
    );
    assert!(status.copy_mode);
    home.assert_no_staging();
}

/// A junction that fails after making its directory leaves it empty; the
/// copy goes there — but never over a folder with anything in it.
struct JunctionLeavesItsFolder;

impl LinkStrategy for JunctionLeavesItsFolder {
    fn link(&self, _target: &Path, link: &Path) -> io::Result<LinkMode> {
        fs::create_dir(link)?;
        Err(io::Error::other(
            "the junction failed after making its folder (test)",
        ))
    }

    fn copy_fallback(&self) -> bool {
        true
    }
}

#[test]
fn an_empty_folder_a_failed_junction_left_does_not_stop_the_copy() {
    let home = Home::with_linker(Arc::new(JunctionLeavesItsFolder));
    home.skill("x", "v1");
    let result = home.run(
        vec![op("x", AgentType::ClaudeCode, SkillAction::Enable)],
        false,
    );
    assert_eq!(result.outcome, ApplyOutcome::Applied, "{result:?}");
    assert_eq!(result.ops[0].creates[0].kind, ChangeKind::Copy);
    assert!(home.path("claude/skills/x/SKILL.md").is_file());
    assert_eq!(home.cell("x", AgentType::ClaudeCode).state, CellState::Copy);
}

#[test]
fn disabling_removes_only_a_copy_that_matches_its_record() {
    let home = Home::with_linker(Arc::new(FailingJunction));
    home.skill("x", "v1");
    assert!(
        home.run(
            vec![
                op("x", AgentType::ClaudeCode, SkillAction::Enable),
                op("x", AgentType::Gemini, SkillAction::Enable),
            ],
            false
        )
        .ok
    );
    let changed = home.path("claude/skills/x");
    let untouched = home.path("gemini/skills/x");
    fs::write(changed.join("notes.md"), "mine\n").unwrap();

    let result = home.run(
        vec![
            op("x", AgentType::ClaudeCode, SkillAction::Disable),
            op("x", AgentType::Gemini, SkillAction::Disable),
        ],
        false,
    );
    assert_eq!(result.outcome, ApplyOutcome::Applied, "{result:?}");
    assert_eq!(
        codes_of(&result.ops[0].warnings),
        vec![codes::COPY_MODIFIED_KEPT]
    );
    assert_eq!(result.ops[0].status, OpStatus::Unchanged);
    assert_eq!(result.ops[1].status, OpStatus::Done);
    assert_eq!(
        fs::read_to_string(changed.join("notes.md")).unwrap(),
        "mine\n"
    );
    assert!(!exists(&untouched));
    let record = home.record();
    assert!(
        record.get(&changed).is_some(),
        "the changed copy stays Codeg's"
    );
    assert!(record.get(&untouched).is_none());
    let cell = home.cell("x", AgentType::ClaudeCode);
    assert_eq!(
        (cell.state, cell.copy_matches),
        (CellState::Copy, Some(false))
    );
    home.assert_no_staging();
}

/// After a skill update: an unchanged copy is replaced, a changed one kept
/// and flagged — and replaced, after a backup, only on request.
#[test]
fn copies_follow_an_update_only_while_unchanged() {
    let home = Home::with_linker(Arc::new(FailingJunction));
    home.skill("x", "v1");
    assert!(
        home.run(
            vec![
                op("x", AgentType::ClaudeCode, SkillAction::Enable),
                op("x", AgentType::Gemini, SkillAction::Enable),
            ],
            false
        )
        .ok
    );
    let unchanged = home.path("claude/skills/x");
    let changed = home.path("gemini/skills/x");
    fs::write(changed.join("SKILL.md"), "edited on the agent's side\n").unwrap();

    // The update.
    home.skill("x", "v2");
    let problems = {
        let _guard = home.ctx.lock_blocking().unwrap();
        super::packs::refresh_copies(&home.ctx, "x")
    };
    assert!(problems.is_empty(), "{problems:?}");
    assert!(fs::read_to_string(unchanged.join("SKILL.md"))
        .unwrap()
        .contains("v2"));
    assert_eq!(
        fs::read_to_string(changed.join("SKILL.md")).unwrap(),
        "edited on the agent's side\n"
    );
    let claude = home.cell("x", AgentType::ClaudeCode);
    assert_eq!(
        (claude.copy_matches, claude.copy_current),
        (Some(true), Some(true))
    );
    let gemini = home.cell("x", AgentType::Gemini);
    assert_eq!(gemini.copy_matches, Some(false), "flagged as changed");

    // Refresh without consent: refused.
    let refused = home.run(
        vec![op("x", AgentType::Gemini, SkillAction::Refresh)],
        false,
    );
    assert_eq!(refused.outcome, ApplyOutcome::Invalid);
    assert_eq!(codes_of(&refused.ops[0].issues), vec![codes::COPY_MODIFIED]);

    // On request: backed up, then replaced.
    let mut replace = op("x", AgentType::Gemini, SkillAction::Refresh);
    replace.replace_modified = true;
    let done = home.run(vec![replace], false);
    assert_eq!(done.outcome, ApplyOutcome::Applied, "{done:?}");
    assert!(fs::read_to_string(changed.join("SKILL.md"))
        .unwrap()
        .contains("v2"));
    let backups = super::backups::list(&home.ctx, Some("x")).backups;
    assert_eq!(backups.len(), 1, "{backups:?}");
    assert_eq!(backups[0].kind, BackupKind::Copy);
    assert_eq!(backups[0].agent.as_deref(), Some("gemini"));
    assert_eq!(
        fs::read_to_string(Path::new(&backups[0].path).join("SKILL.md")).unwrap(),
        "edited on the agent's side\n"
    );
    let gemini = home.cell("x", AgentType::Gemini);
    assert_eq!(
        (gemini.copy_matches, gemini.copy_current),
        (Some(true), Some(true))
    );
    home.assert_no_staging();
}

#[test]
fn a_swap_that_fails_leaves_the_old_copy_and_the_record_as_they_were() {
    let home = Home::with_linker(Arc::new(FailingJunction));
    home.skill("x", "v1");
    assert!(
        home.run(
            vec![op("x", AgentType::ClaudeCode, SkillAction::Enable)],
            false
        )
        .ok
    );
    let copy = home.path("claude/skills/x");
    let record_before = home.record().get(&copy).cloned().unwrap();
    home.skill("x", "v2");

    for point in ["swap_out", "swap_in"] {
        home.ctx.arm_fault(point);
        let problems = {
            let _guard = home.ctx.lock_blocking().unwrap();
            super::packs::refresh_copies(&home.ctx, "x")
        };
        home.ctx.disarm_faults();
        assert_eq!(problems.len(), 1, "{point}: {problems:?}");
        assert!(
            fs::read_to_string(copy.join("SKILL.md"))
                .unwrap()
                .contains("v1"),
            "{point}: the old copy is intact"
        );
        assert_eq!(home.record().get(&copy), Some(&record_before), "{point}");
        home.assert_no_staging();
    }

    // And through `refresh`: the failure is reported, nothing changed.
    home.ctx.arm_fault("swap_in");
    let result = home.run(
        vec![op("x", AgentType::ClaudeCode, SkillAction::Refresh)],
        false,
    );
    home.ctx.disarm_faults();
    assert_eq!(result.outcome, ApplyOutcome::WriteFailed, "{result:?}");
    assert_eq!(result.ops[0].status, OpStatus::Failed);
    assert!(fs::read_to_string(copy.join("SKILL.md"))
        .unwrap()
        .contains("v1"));
    assert_eq!(home.record().get(&copy), Some(&record_before));
    home.assert_no_staging();
}

#[test]
fn a_failed_record_write_puts_back_every_link_made() {
    let home = Home::new();
    home.skill("x", "body");
    home.ctx.arm_fault("record");
    let result = home.run(
        vec![
            op("x", AgentType::ClaudeCode, SkillAction::Enable),
            op("x", AgentType::Gemini, SkillAction::Enable),
        ],
        false,
    );
    home.ctx.disarm_faults();
    assert_eq!(result.outcome, ApplyOutcome::WriteFailed);
    assert_eq!(codes_of(&result.issues), vec![codes::RECORD_WRITE_FAILED]);
    assert!(result
        .ops
        .iter()
        .all(|op| op.status == OpStatus::RolledBack));
    assert!(!exists(&home.path("claude/skills/x")));
    assert!(!exists(&home.path("gemini/skills/x")));
}

// ─── Provenance and the packs ───────────────────────────────────────────

static V1_FILES: [DirEntry<'static>; 1] = [DirEntry::File(File::new(
    "skills/k1-pack/SKILL.md",
    b"---\nname: k1-pack\n---\nversion one\n",
))];
static V1_SKILL: [DirEntry<'static>; 1] = [DirEntry::Dir(Dir::new("skills/k1-pack", &V1_FILES))];
static V1_ROOT: [DirEntry<'static>; 1] = [DirEntry::Dir(Dir::new("skills", &V1_SKILL))];
static V1: Dir<'static> = Dir::new("", &V1_ROOT);

static V2_FILES: [DirEntry<'static>; 2] = [
    DirEntry::File(File::new(
        "skills/k1-pack/SKILL.md",
        b"---\nname: k1-pack\n---\nversion two\n",
    )),
    DirEntry::File(File::new(
        "skills/k1-pack/scripts/run.py",
        b"print('two')\n",
    )),
];
static V2_SKILL: [DirEntry<'static>; 1] = [DirEntry::Dir(Dir::new("skills/k1-pack", &V2_FILES))];
static V2_ROOT: [DirEntry<'static>; 1] = [DirEntry::Dir(Dir::new("skills", &V2_SKILL))];
static V2: Dir<'static> = Dir::new("", &V2_ROOT);

fn bundle(dir: &'static Dir<'static>) -> Bundle<'static> {
    Bundle {
        origin: SkillOrigin::Experts,
        dir,
        skills: vec![(
            "k1-pack".to_string(),
            super::packs::bundled_hash(dir, "k1-pack").unwrap(),
        )],
    }
}

fn install(home: &Home, dir: &'static Dir<'static>) -> super::packs::InstallReport {
    let _guard = home.ctx.lock_blocking().unwrap();
    install_bundle(&home.ctx, &bundle(dir))
}

#[test]
fn a_pack_update_that_brings_a_custom_skills_id_takes_nothing_over() {
    let home = Home::new();
    home.skill("k1-pack", "mine");
    let link = home.plant_link("claude/skills", "k1-pack");

    let report = install(&home, &V1);
    assert_eq!(report.name_taken, vec!["k1-pack".to_string()], "{report:?}");
    assert_eq!(report.installed_count + report.updated_count, 0);
    assert!(fs::read_to_string(home.store("k1-pack/SKILL.md"))
        .unwrap()
        .contains("mine"));
    assert!(
        home.is_link_to(&link, "k1-pack"),
        "the user's link is left alone"
    );
    let provenance = super::provenance::Provenance::load(&home.ctx.store);
    assert_eq!(
        provenance.origin_of(&home.ctx.store, "k1-pack"),
        Some(SkillOrigin::Custom)
    );
    assert!(super::backups::list(&home.ctx, None).backups.is_empty());

    // A real pack's id held the same way shows in the inventory.
    home.skill("brainstorming", "mine too");
    let inventory = super::world::inventory(&home.ctx);
    assert!(inventory
        .name_taken
        .iter()
        .any(|taken| taken.id == "brainstorming"
            && taken.pack == SkillOrigin::Experts
            && taken.held_by == SkillOrigin::Custom));
}

#[test]
fn a_pack_skill_follows_updates_and_a_changed_one_goes_into_the_backups() {
    let home = Home::new();
    let report = install(&home, &V1);
    assert_eq!(report.installed_count, 1, "{report:?}");
    // Pristine but outdated: replaced, no backup.
    let report = install(&home, &V2);
    assert_eq!(
        (report.updated_count, report.pending_user_review.len()),
        (1, 0)
    );
    assert!(home.store("k1-pack/scripts/run.py").is_file());
    assert!(super::backups::list(&home.ctx, None).backups.is_empty());

    // The user changes the pack's copy; the next update keeps theirs aside.
    fs::write(home.store("k1-pack/SKILL.md"), "my changes\n").unwrap();
    let report = install(&home, &V1);
    assert_eq!(report.pending_user_review, vec!["k1-pack".to_string()]);
    assert!(fs::read_to_string(home.store("k1-pack/SKILL.md"))
        .unwrap()
        .contains("version one"));
    let backups = super::backups::list(&home.ctx, Some("k1-pack")).backups;
    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0].kind, BackupKind::Update);
    assert!(Path::new(&backups[0].path).starts_with(home.store(".user-backups/k1-pack")));
    assert_eq!(
        fs::read_to_string(Path::new(&backups[0].path).join("SKILL.md")).unwrap(),
        "my changes\n"
    );
    // A backup is never a skill.
    let skills = super::provenance::store_skills(
        &home.ctx.store,
        &super::provenance::Provenance::load(&home.ctx.store),
    );
    assert_eq!(skills, vec![("k1-pack".to_string(), SkillOrigin::Experts)]);
    home.assert_no_staging();
}

#[test]
fn what_using_a_skill_leaves_behind_is_no_change() {
    let home = Home::new();
    install(&home, &V2);
    let skill = home.store("k1-pack");
    let before = super::fsio::hash_skill_dir(&skill, "k1-pack").unwrap();
    fs::create_dir_all(skill.join("scripts/__pycache__")).unwrap();
    fs::write(
        skill.join("scripts/__pycache__/run.cpython-312.pyc"),
        b"\0\0",
    )
    .unwrap();
    fs::write(skill.join("scripts/run.pyc"), b"\0").unwrap();
    fs::write(skill.join(".DS_Store"), b"\0").unwrap();
    fs::write(skill.join("scripts/Thumbs.db"), b"\0").unwrap();
    assert_eq!(
        super::fsio::hash_skill_dir(&skill, "k1-pack").unwrap(),
        before
    );

    let report = install(&home, &V2);
    assert_eq!(
        report.installed_count + report.updated_count,
        0,
        "{report:?}"
    );
    assert!(report.pending_user_review.is_empty());
    assert!(super::backups::list(&home.ctx, None).backups.is_empty());
    // But a real change is one.
    fs::write(skill.join("scripts/run.py"), "print('mine')\n").unwrap();
    assert_ne!(
        super::fsio::hash_skill_dir(&skill, "k1-pack").unwrap(),
        before
    );
}

#[test]
fn an_unreadable_manifest_neither_disowns_a_pack_nor_is_overwritten() {
    let home = Home::new();
    // A real Experts id in the store, and its manifest garbled.
    home.skill("brainstorming", "the pack's");
    fs::write(home.store(".manifest.json"), b"{ not json").unwrap();
    let provenance = super::provenance::Provenance::load(&home.ctx.store);
    assert_eq!(
        provenance.origin_of(&home.ctx.store, "brainstorming"),
        Some(SkillOrigin::Experts),
        "still the pack's, not a Custom skill"
    );
    assert_eq!(
        codes_of(&provenance.problems),
        vec![codes::MANIFEST_UNREADABLE]
    );
    let inventory = super::world::inventory(&home.ctx);
    assert!(codes_of(&inventory.problems).contains(&codes::MANIFEST_UNREADABLE));

    // The next extraction writes a new one and keeps the old one aside.
    let report = install(&home, &V1);
    assert_eq!(report.errors.len(), 1, "{report:?}");
    assert!(home.store(".manifest.json.unreadable").is_file());
    let fresh: serde_json::Value =
        serde_json::from_slice(&fs::read(home.store(".manifest.json")).unwrap()).unwrap();
    assert!(fresh["experts"]["k1-pack"].is_object());
}

// ─── Backups ────────────────────────────────────────────────────────────

#[test]
fn older_backups_move_aside_unless_linked_and_are_never_skills() {
    let home = Home::new();
    let old = |name: &str| {
        let dir = home.store(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), format!("---\nname: {name}\n---\n")).unwrap();
    };
    old("foo.user-backup-20250101-120000");
    old("bar.user-backup-20250202-130000");
    home.plant_link("claude/skills", "bar.user-backup-20250202-130000");

    let (moved, kept, problems) = {
        let _guard = home.ctx.lock_blocking().unwrap();
        super::backups::migrate_legacy(&home.ctx)
    };
    assert_eq!((moved, kept), (1, 1), "{problems:?}");
    assert!(!exists(&home.store("foo.user-backup-20250101-120000")));
    assert!(home
        .store(".user-backups/foo/20250101-120000/SKILL.md")
        .is_file());
    assert!(
        exists(&home.store("bar.user-backup-20250202-130000")),
        "linked: stays"
    );

    let provenance = super::provenance::Provenance::load(&home.ctx.store);
    assert!(super::provenance::store_skills(&home.ctx.store, &provenance).is_empty());
    assert!(super::world::inventory(&home.ctx).skills.is_empty());

    let listed = super::backups::list(&home.ctx, None).backups;
    assert_eq!(listed.len(), 2, "{listed:?}");
    let bar = listed.iter().find(|b| b.skill == "bar").unwrap();
    assert_eq!(bar.kind, BackupKind::Legacy);
    assert_eq!(bar.linked_by, vec![AgentType::ClaudeCode]);
    let foo = listed.iter().find(|b| b.skill == "foo").unwrap();
    assert_eq!(foo.kind, BackupKind::Update);
    assert_eq!(foo.created_at.as_deref(), Some("2025-01-01T12:00:00.000Z"));
}

#[test]
fn a_backup_is_restored_as_a_custom_skill_or_deleted() {
    let home = Home::new();
    let backup = home.store(".user-backups/foo/20250101-120000");
    fs::create_dir_all(&backup).unwrap();
    fs::write(backup.join("SKILL.md"), "---\nname: foo\n---\nmine\n").unwrap();
    let second = home.store(".user-backups/foo/20250303-140000");
    fs::create_dir_all(&second).unwrap();
    fs::write(second.join("SKILL.md"), "older\n").unwrap();
    let linked = home.store("bar.user-backup-20250202-130000");
    fs::create_dir_all(&linked).unwrap();
    fs::write(linked.join("SKILL.md"), "linked\n").unwrap();
    home.plant_link("claude/skills", "bar.user-backup-20250202-130000");

    let _guard = home.ctx.lock_blocking().unwrap();
    // An id a pack owns is refused.
    let refused =
        super::backups::restore_as_custom(&home.ctx, "foo", "20250101-120000", "brainstorming");
    assert_eq!(refused.outcome, BackupOutcome::Invalid);
    assert_eq!(codes_of(&refused.issues), vec![codes::ID_RESERVED]);

    let restored =
        super::backups::restore_as_custom(&home.ctx, "foo", "20250101-120000", "foo-mine");
    assert_eq!(restored.outcome, BackupOutcome::Restored, "{restored:?}");
    assert!(!restored.backup_kept);
    assert_eq!(
        fs::read_to_string(home.store("foo-mine/SKILL.md")).unwrap(),
        "---\nname: foo\n---\nmine\n"
    );
    assert!(!exists(&backup));
    let provenance = super::provenance::Provenance::load(&home.ctx.store);
    assert_eq!(
        provenance.origin_of(&home.ctx.store, "foo-mine"),
        Some(SkillOrigin::Custom)
    );

    // Taken ids are refused too.
    let taken = super::backups::restore_as_custom(&home.ctx, "foo", "20250303-140000", "foo-mine");
    assert_eq!(codes_of(&taken.issues), vec![codes::ID_TAKEN]);

    let deleted = super::backups::delete(&home.ctx, "foo", "20250303-140000");
    assert_eq!(deleted.outcome, BackupOutcome::Deleted, "{deleted:?}");
    assert!(!exists(&second));
    assert!(
        !exists(&home.store(".user-backups")),
        "nothing empty is left"
    );

    // An older release's backup an agent links to is not deleted under it.
    let linked_delete = super::backups::delete(&home.ctx, "bar", "20250202-130000");
    assert_eq!(linked_delete.outcome, BackupOutcome::Invalid);
    assert_eq!(codes_of(&linked_delete.issues), vec![codes::BACKUP_LINKED]);
    assert_eq!(linked_delete.issues[0].agents, vec![AgentType::ClaudeCode]);
    assert!(linked.is_dir());
    // …and restoring it copies, keeping it for the agent that uses it.
    let copied = super::backups::restore_as_custom(&home.ctx, "bar", "20250202-130000", "bar-mine");
    assert_eq!(copied.outcome, BackupOutcome::Restored, "{copied:?}");
    assert!(copied.backup_kept);
    assert!(linked.is_dir() && home.store("bar-mine/SKILL.md").is_file());
    let missing = super::backups::delete(&home.ctx, "foo", "20990101-000000");
    assert_eq!(codes_of(&missing.issues), vec![codes::BACKUP_NOT_FOUND]);
}

// ─── Moving an agent's skill into Codeg ─────────────────────────────────

fn plant_own_skill(home: &Home) -> PathBuf {
    let original = home.path("claude/skills/adopt-me");
    fs::create_dir_all(original.join("scripts")).unwrap();
    fs::write(
        original.join("SKILL.md"),
        "---\nname: adopt-me\n---\nmine\n",
    )
    .unwrap();
    fs::write(original.join("scripts/run.sh"), "#!/bin/sh\necho mine\n").unwrap();
    original
}

fn adopt(home: &Home, agent: AgentType, skill: &str) -> SkillsAdoptResult {
    let _guard = home.ctx.lock_blocking().unwrap();
    adopt_blocking(
        &home.ctx,
        &AdoptRequest {
            agent,
            skill: skill.to_string(),
            dir: None,
        },
    )
    .0
}

#[test]
fn adopting_moves_the_skill_into_the_store_and_links_it_back() {
    let home = Home::new();
    let original = plant_own_skill(&home);
    let before = super::fsio::hash_skill_dir(&original, "adopt-me").unwrap();
    assert_eq!(
        home.cell("adopt-me", AgentType::ClaudeCode).state,
        CellState::Blocked
    );

    let result = adopt(&home, AgentType::ClaudeCode, "adopt-me");
    assert_eq!(result.outcome, AdoptOutcome::Adopted, "{result:?}");
    assert_eq!(
        super::fsio::hash_skill_dir(&home.store("adopt-me"), "adopt-me").unwrap(),
        before
    );
    assert!(home.is_link_to(&original, "adopt-me"));
    assert_eq!(
        home.cell("adopt-me", AgentType::ClaudeCode).state,
        CellState::Linked
    );
    assert!(home.record().get(&original).is_some());
    let provenance = super::provenance::Provenance::load(&home.ctx.store);
    assert_eq!(
        provenance.origin_of(&home.ctx.store, "adopt-me"),
        Some(SkillOrigin::Custom)
    );
    home.assert_no_staging();

    // A link is not the agent's own skill.
    let again = adopt(&home, AgentType::ClaudeCode, "adopt-me");
    assert_eq!(again.outcome, AdoptOutcome::Invalid);
    assert_eq!(codes_of(&again.issues), vec![codes::NOT_OWN_SKILL]);
}

#[test]
fn every_failing_step_of_adopting_puts_everything_back() {
    for point in [
        "adopt_copy",
        "adopt_verify",
        "adopt_install",
        "adopt_move",
        "adopt_link",
        "adopt_record",
    ] {
        let home = Home::new();
        let original = plant_own_skill(&home);
        let before = super::fsio::hash_skill_dir(&original, "adopt-me").unwrap();
        home.ctx.arm_fault(point);
        let result = adopt(&home, AgentType::ClaudeCode, "adopt-me");
        home.ctx.disarm_faults();
        assert_eq!(result.outcome, AdoptOutcome::Failed, "{point}: {result:?}");
        assert!(result.restored, "{point}: {result:?}");
        let meta = fs::symlink_metadata(&original).unwrap();
        assert!(meta.is_dir() && !meta.file_type().is_symlink(), "{point}");
        assert_eq!(
            super::fsio::hash_skill_dir(&original, "adopt-me").unwrap(),
            before,
            "{point}: the original is as it was"
        );
        assert!(
            !exists(&home.store("adopt-me")),
            "{point}: nothing left in the store"
        );
        assert!(home.record().get(&original).is_none(), "{point}");
        home.assert_no_staging();
    }
}

#[test]
fn a_flat_markdown_skill_is_adopted_as_a_folder() {
    let home = Home::new();
    let flat = home.path("codex/skills/flat-one.md");
    fs::create_dir_all(flat.parent().unwrap()).unwrap();
    fs::write(&flat, "---\nname: flat-one\n---\nflat\n").unwrap();
    let result = adopt(&home, AgentType::Codex, "flat-one");
    assert_eq!(result.outcome, AdoptOutcome::Adopted, "{result:?}");
    assert_eq!(
        fs::read_to_string(home.store("flat-one/SKILL.md")).unwrap(),
        "---\nname: flat-one\n---\nflat\n"
    );
    assert!(!exists(&flat));
    assert!(home.is_link_to(&home.path("codex/skills/flat-one"), "flat-one"));
    assert_eq!(
        home.cell("flat-one", AgentType::Codex).state,
        CellState::Linked
    );
    // Codex's own CLI skills are not the user's to move.
    let system = home.path("codex/skills/.system/builtin");
    fs::create_dir_all(&system).unwrap();
    fs::write(system.join("SKILL.md"), "x").unwrap();
    let refused = adopt(&home, AgentType::Codex, "builtin");
    assert_eq!(codes_of(&refused.issues), vec![codes::READ_ONLY_SKILL]);
}

// ─── Repairing a broken link ────────────────────────────────────────────

fn repair(
    home: &Home,
    path: PathBuf,
    action: RepairAction,
    ack: Option<String>,
    preflight: bool,
) -> SkillsRepairResult {
    let _guard = (!preflight).then(|| home.ctx.lock_blocking().unwrap());
    repair_blocking(
        &home.ctx,
        &RepairRequest {
            path,
            action,
            preflight,
            ack,
        },
    )
    .0
}

/// A link Codeg made, by its record, that points where the store used to be
/// (a home that was renamed, a store that moved).
fn plant_recorded_broken_link(home: &Home, dir: &str, id: &str) -> PathBuf {
    let dir = home.path(dir);
    fs::create_dir_all(&dir).unwrap();
    let link = dir.join(id);
    platform_link(&home.path("old-home/.codeg/skills").join(id), &link).unwrap();
    let mut record = home.record();
    record.insert(RecordEntry {
        skill: id.to_string(),
        dir: dir.to_string_lossy().into_owned(),
        path: link.to_string_lossy().into_owned(),
        mode: LinkMode::Symlink,
        created_at: super::record::now(),
        copy_hash: None,
    });
    record.save(&home.ctx.store).unwrap();
    link
}

#[test]
fn a_broken_link_codeg_made_is_repointed_or_removed() {
    let home = Home::new();
    home.skill("x", "body");
    let own = plant_recorded_broken_link(&home, "claude/skills", "x");
    let shared = plant_recorded_broken_link(&home, "agents/skills", "x");
    // One into the store, whose skill is gone.
    home.skill("y", "gone soon");
    let doomed = home.plant_link("gemini/skills", "y");
    fs::remove_dir_all(home.store("y")).unwrap();
    // A broken link nobody recorded is not Codeg's.
    let foreign = home.path("opencode/skills/z");
    fs::create_dir_all(foreign.parent().unwrap()).unwrap();
    platform_link(&home.path("nowhere"), &foreign).unwrap();

    let inventory = super::world::inventory(&home.ctx);
    let mut listed: Vec<String> = inventory
        .broken_links
        .iter()
        .map(|b| b.path.clone())
        .collect();
    listed.sort();
    let mut expected: Vec<String> = [&own, &shared, &doomed]
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    expected.sort();
    assert_eq!(listed, expected);
    let cell = home.cell("x", AgentType::ClaudeCode);
    assert_eq!((cell.state, cell.codeg), (CellState::Broken, true));

    // In Claude's own directory: no one else is affected.
    let done = repair(&home, own.clone(), RepairAction::Repoint, None, false);
    assert_eq!(done.outcome, ApplyOutcome::Applied, "{done:?}");
    assert!(home.is_link_to(&own, "x"));
    assert_eq!(
        home.cell("x", AgentType::ClaudeCode).state,
        CellState::Linked
    );

    // In the shared directory: everyone reading it gains the skill — asked.
    let preflight = repair(&home, shared.clone(), RepairAction::Repoint, None, true);
    assert_eq!(preflight.status, OpStatus::NeedsAck, "{preflight:?}");
    assert!(preflight.gains.contains(&AgentType::Cline));
    let refused = repair(&home, shared.clone(), RepairAction::Repoint, None, false);
    assert_eq!(refused.outcome, ApplyOutcome::AcknowledgementRequired);
    assert!(fs::metadata(&shared).is_err(), "still broken");
    let done = repair(
        &home,
        shared.clone(),
        RepairAction::Repoint,
        preflight.ack,
        false,
    );
    assert_eq!(done.outcome, ApplyOutcome::Applied, "{done:?}");
    assert!(home.is_link_to(&shared, "x"));

    // Its skill is gone: it can only go.
    let nowhere = repair(&home, doomed.clone(), RepairAction::Repoint, None, false);
    assert_eq!(codes_of(&nowhere.issues), vec![codes::SKILL_NOT_FOUND]);
    let removed = repair(&home, doomed.clone(), RepairAction::Remove, None, false);
    assert_eq!(removed.outcome, ApplyOutcome::Applied, "{removed:?}");
    assert!(
        removed.ack.is_none(),
        "removing a broken link shows nobody anything new"
    );
    assert!(!exists(&doomed));

    // Only broken links of Codeg's.
    let working = repair(&home, own, RepairAction::Remove, None, false);
    assert_eq!(codes_of(&working.issues), vec![codes::NOT_BROKEN]);
    let not_ours = repair(&home, foreign.clone(), RepairAction::Remove, None, false);
    assert_eq!(codes_of(&not_ours.issues), vec![codes::NOT_CODEG_LINK]);
    assert!(exists(&foreign));
    let outside = repair(
        &home,
        home.path("elsewhere/x"),
        RepairAction::Remove,
        None,
        false,
    );
    assert_eq!(
        codes_of(&outside.issues),
        vec![codes::PATH_OUTSIDE_AGENT_DIRS]
    );
}

// ─── The link record ────────────────────────────────────────────────────

#[test]
fn the_record_is_rebuilt_from_the_disk() {
    let home = Home::new();
    home.skill("x", "body");
    let own = home.plant_link("claude/skills", "x");
    let shared = home.plant_link("agents/skills", "x");
    let copied = home.path("opencode/skills/x");
    fs::create_dir_all(&copied).unwrap();
    let entry = |path: &Path, mode| RecordEntry {
        skill: "x".into(),
        dir: path.parent().unwrap().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        mode,
        created_at: super::record::now(),
        copy_hash: None,
    };
    let mut record = LinkRecord::default();
    record.insert(entry(&copied, LinkMode::Copy));
    record.insert(entry(&home.path("gemini/skills/x"), LinkMode::Symlink));
    record.save(&home.ctx.store).unwrap();

    let mut record = home.record();
    assert!(super::record::reconcile(&home.ctx, &mut record));
    record.save(&home.ctx.store).unwrap();
    let record = home.record();
    assert!(record.get(&own).is_some(), "found on disk");
    assert!(record.get(&shared).is_some(), "found on disk");
    assert!(
        record.get(&copied).is_some(),
        "a recorded copy that is there stays"
    );
    assert!(
        record.get(&home.path("gemini/skills/x")).is_none(),
        "gone from disk"
    );

    // After Codeg's backup was restored over the store: the record from
    // before knows copies the restored one does not.
    let snapshot = home.path("snapshot");
    let mut before = LinkRecord::default();
    let later_copy = home.path("gemini/skills/later");
    before.insert(RecordEntry {
        skill: "later".into(),
        ..entry(&later_copy, LinkMode::Copy)
    });
    before.save(&snapshot).unwrap();
    super::startup::absorb_record_after_restore(&home.ctx.store, &snapshot).unwrap();
    assert!(home.record().get(&later_copy).is_some());
    assert!(home.record().get(&own).is_some(), "the live entries stay");
}

// ─── Atomic writes ──────────────────────────────────────────────────────

#[test]
fn writes_replace_in_one_step_and_failures_leave_nothing_half_made() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("SKILL.md");
    super::fsio::write_content_atomic(&file, b"one").unwrap();
    super::fsio::write_content_atomic(&file, b"two").unwrap();
    assert_eq!(fs::read(&file).unwrap(), b"two");
    let names: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["SKILL.md".to_string()], "no temp file left");

    // A skill placed into the store: staged in full or not at all.
    let home = Home::new();
    let failed = super::packs::place_skill(&home.ctx, "half", false, |target| {
        fs::create_dir_all(target)?;
        fs::write(target.join("SKILL.md"), "partial")?;
        Err(io::Error::other("the import failed midway"))
    });
    assert!(failed.is_err());
    assert!(!exists(&home.store("half")));
    home.assert_no_staging();

    // The record and the manifests are written whole, too.
    let mut record = LinkRecord::default();
    record.insert(RecordEntry {
        skill: "x".into(),
        dir: "/d".into(),
        path: "/d/x".into(),
        mode: LinkMode::Symlink,
        created_at: super::record::now(),
        copy_hash: None,
    });
    record.save(&home.ctx.store).unwrap();
    let names: Vec<String> = fs::read_dir(&home.ctx.store)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec![".links.json".to_string()]);
    let parsed: serde_json::Value =
        serde_json::from_slice(&fs::read(home.store(".links.json")).unwrap()).unwrap();
    assert_eq!(parsed["links"][0]["skill"], "x");
}

// ─── The lock ───────────────────────────────────────────────────────────

/// Links made slowly, noting whether two were ever being made at once.
#[derive(Default)]
struct SlowLinks {
    in_flight: AtomicUsize,
    overlapped: AtomicBool,
}

impl LinkStrategy for SlowLinks {
    fn link(&self, target: &Path, link: &Path) -> io::Result<LinkMode> {
        if self.in_flight.fetch_add(1, Ordering::SeqCst) > 0 {
            self.overlapped.store(true, Ordering::SeqCst);
        }
        std::thread::sleep(Duration::from_millis(150));
        let made = platform_link(target, link);
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        made
    }

    fn copy_fallback(&self) -> bool {
        false
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_writers_take_turns() {
    let links = Arc::new(SlowLinks::default());
    let home = Home::with_linker(links.clone());
    home.skill("a", "a");
    home.skill("b", "b");
    let run = |skill: &str| {
        let ctx = home.ctx.clone();
        let request = SkillsApplyRequest {
            ops: vec![op(skill, AgentType::ClaudeCode, SkillAction::Enable)],
            preflight: false,
        };
        async move {
            super::commands::skills_apply_links_in(ctx, &EventEmitter::Noop, request)
                .await
                .unwrap()
        }
    };
    let (first, second) = tokio::join!(run("a"), run("b"));
    assert_eq!(first.outcome, ApplyOutcome::Applied);
    assert_eq!(second.outcome, ApplyOutcome::Applied);
    assert!(
        !links.overlapped.load(Ordering::SeqCst),
        "one writer at a time"
    );
    assert!(home.is_link_to(&home.path("claude/skills/a"), "a"));
    assert!(home.is_link_to(&home.path("claude/skills/b"), "b"));
}

#[tokio::test]
async fn a_held_lock_gives_a_coded_busy_result() {
    let home = Home::new();
    home.skill("x", "body");
    let mut ctx = home.ctx.clone();
    ctx.lock_wait = Duration::from_millis(100);
    let held = super::lock::acquire_at(&ctx.lock_path, Duration::from_secs(5))
        .await
        .unwrap();
    let request = SkillsApplyRequest {
        ops: vec![op("x", AgentType::ClaudeCode, SkillAction::Enable)],
        preflight: false,
    };
    let result = super::commands::skills_apply_links_in(ctx.clone(), &EventEmitter::Noop, request)
        .await
        .unwrap();
    assert_eq!(result.outcome, ApplyOutcome::Busy);
    assert_eq!(codes_of(&result.issues), vec![codes::LOCK_BUSY]);
    assert_eq!(result.ops[0].status, OpStatus::NotDone);
    assert!(!exists(&home.path("claude/skills/x")));
    // A preflight takes no lock.
    let preflight = super::commands::skills_apply_links_in(
        ctx.clone(),
        &EventEmitter::Noop,
        SkillsApplyRequest {
            ops: vec![op("x", AgentType::ClaudeCode, SkillAction::Enable)],
            preflight: true,
        },
    )
    .await
    .unwrap();
    assert_eq!(preflight.outcome, ApplyOutcome::Preflight);
    // Adopting and the backups say busy the same way.
    let adopt = super::commands::skills_adopt_in(
        ctx.clone(),
        &EventEmitter::Noop,
        AgentType::ClaudeCode,
        "x".into(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(adopt.outcome, AdoptOutcome::Busy);
    assert_eq!(codes_of(&adopt.issues), vec![codes::LOCK_BUSY]);
    drop(held);
    let result = super::commands::skills_apply_links_in(
        ctx,
        &EventEmitter::Noop,
        SkillsApplyRequest {
            ops: vec![op("x", AgentType::ClaudeCode, SkillAction::Enable)],
            preflight: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(result.outcome, ApplyOutcome::Applied);
}

// ─── The event ──────────────────────────────────────────────────────────

#[tokio::test]
async fn the_event_names_what_changed_and_for_whom_and_nothing_else() {
    let home = Home::new();
    home.skill("secret-skill-name", "secret content");
    let broadcaster = Arc::new(crate::web::event_bridge::WebEventBroadcaster::new());
    let mut events = broadcaster.subscribe();
    let emitter = EventEmitter::test_web_only(broadcaster.clone());
    let result = super::commands::skills_apply_links_in(
        home.ctx.clone(),
        &emitter,
        SkillsApplyRequest {
            ops: vec![op(
                "secret-skill-name",
                AgentType::ClaudeCode,
                SkillAction::Enable,
            )],
            preflight: false,
        },
    )
    .await
    .unwrap();
    assert_eq!(result.outcome, ApplyOutcome::Applied);
    let event = events.try_recv().expect("one event");
    assert_eq!(event.channel, SKILLS_CHANGED_EVENT);
    assert_eq!(
        *event.payload,
        serde_json::json!({ "kinds": ["links"], "agents": ["claude_code"] })
    );
    let text = event.payload.to_string();
    assert!(!text.contains("secret"), "{text}");
    assert!(!text.contains(home.root.to_str().unwrap()), "{text}");
    assert!(events.try_recv().is_err(), "one event per change");

    // A preflight changes nothing and announces nothing.
    super::commands::skills_apply_links_in(
        home.ctx.clone(),
        &emitter,
        SkillsApplyRequest {
            ops: vec![op(
                "secret-skill-name",
                AgentType::Gemini,
                SkillAction::Enable,
            )],
            preflight: true,
        },
    )
    .await
    .unwrap();
    assert!(events.try_recv().is_err());
}

// ─── The inventory ──────────────────────────────────────────────────────

#[test]
fn the_inventory_lists_every_skill_with_its_origin_and_every_agents_view() {
    let home = Home::new();
    home.skill("mine", "custom");
    install(&home, &V1);
    home.plant_link("agents/skills", "mine");
    let inventory = super::world::inventory(&home.ctx);
    let ids: Vec<(&str, SkillOrigin)> = inventory
        .skills
        .iter()
        .map(|s| (s.id.as_str(), s.origin))
        .collect();
    assert_eq!(
        ids,
        vec![
            ("k1-pack", SkillOrigin::Experts),
            ("mine", SkillOrigin::Custom)
        ]
    );
    let mine = &inventory.skills[1];
    assert_eq!(mine.cells.len(), home.ctx.agents.len());
    let cline = mine
        .cells
        .iter()
        .find(|c| c.agent == AgentType::Cline)
        .unwrap();
    assert_eq!(cline.state, CellState::VisibleThrough);
    let agent = inventory
        .agents
        .iter()
        .find(|a| a.agent == shared_only_agent())
        .unwrap();
    assert!(agent.link_dir_shared);
    let value = serde_json::to_value(&inventory).unwrap();
    assert_eq!(value["skills"][1]["cells"][0]["state"], "not_linked");
    assert_eq!(value["skills"][0]["origin"], "experts");
}

// ─── The Skills page (injected directories) ─────────────────────────────

#[tokio::test]
async fn the_skills_page_never_overwrites_or_writes_through_a_link_into_the_store() {
    use crate::acp::types::{AgentSkillOwner, AgentSkillScope};
    use crate::commands::acp::{
        acp_delete_agent_skill_in, acp_save_agent_skill_in, list_skills_from_dir, SkillPageDirs,
        SkillStorageKind,
    };
    let home = Home::new();
    let agent_dir = home.path("claude/skills");
    let store = home.ctx.store.clone();
    fs::create_dir_all(agent_dir.join("dup")).unwrap();
    fs::write(agent_dir.join("dup/SKILL.md"), "theirs\n").unwrap();
    fs::create_dir_all(store.join("instore")).unwrap();
    fs::write(store.join("instore/SKILL.md"), "codeg's\n").unwrap();
    fs::create_dir_all(store.join("linked")).unwrap();
    fs::write(store.join("linked/SKILL.md"), "codeg's\n").unwrap();
    platform_link(&store.join("linked"), &agent_dir.join("linked")).unwrap();

    let dirs = || {
        SkillPageDirs::with_readers(
            &home.ctx,
            AgentType::ClaudeCode,
            SkillStorageKind::SkillDirectoryOnly,
            vec![agent_dir.clone()],
        )
    };
    let target = || Ok(dirs());
    let save = |id: &str, create: bool| {
        acp_save_agent_skill_in(
            &home.ctx,
            &EventEmitter::Noop,
            AgentType::ClaudeCode,
            AgentSkillScope::Global,
            id.to_string(),
            "new\n".to_string(),
            &target,
            None,
            create,
        )
    };
    let code = |err: crate::app_error::AppCommandError| {
        err.i18n_params.unwrap_or_default()["code"].clone()
    };
    // New, over an id in the scope or in the store: refused.
    assert_eq!(code(save("dup", true).await.unwrap_err()), codes::ID_TAKEN);
    assert_eq!(
        fs::read_to_string(agent_dir.join("dup/SKILL.md")).unwrap(),
        "theirs\n"
    );
    assert_eq!(
        code(save("instore", true).await.unwrap_err()),
        codes::ID_TAKEN
    );
    assert!(!agent_dir.join("instore").exists());
    let fresh = save("fresh", true).await.unwrap();
    assert_eq!(fresh.owner, AgentSkillOwner::Agent);
    assert_eq!(
        fs::read_to_string(agent_dir.join("fresh/SKILL.md")).unwrap(),
        "new\n"
    );
    // Without `create`, as before: an update.
    save("dup", false).await.unwrap();
    assert_eq!(
        fs::read_to_string(agent_dir.join("dup/SKILL.md")).unwrap(),
        "new\n"
    );

    // Through a link into the store: refused (and as a new skill, the id
    // is taken).
    assert_eq!(
        code(save("linked", false).await.unwrap_err()),
        codes::STORE_LINK_READ_ONLY
    );
    assert_eq!(
        code(save("linked", true).await.unwrap_err()),
        codes::ID_TAKEN
    );
    assert_eq!(
        fs::read_to_string(store.join("linked/SKILL.md")).unwrap(),
        "codeg's\n"
    );

    // The page's list says whose each is and where the link points.
    let mut listed = list_skills_from_dir(
        AgentSkillScope::Global,
        &agent_dir,
        SkillStorageKind::SkillDirectoryOnly,
    )
    .unwrap();
    super::world::annotate_items(&store, &mut listed);
    let linked = listed.iter().find(|s| s.id == "linked").unwrap();
    assert_eq!(linked.owner, AgentSkillOwner::Custom);
    // (On Windows the store here is a verbatim path, the junction's target
    // is not.)
    assert!(
        linked
            .link_target
            .as_deref()
            .is_some_and(|target| super::fsio::same_path(Path::new(target), &store.join("linked"))),
        "{:?}",
        linked.link_target
    );
    let own = listed.iter().find(|s| s.id == "dup").unwrap();
    assert_eq!(
        (own.owner, own.link_target.is_none()),
        (AgentSkillOwner::Agent, true)
    );

    // Deleting Codeg's link takes only the link.
    let deleted = acp_delete_agent_skill_in(
        &home.ctx,
        &EventEmitter::Noop,
        AgentType::ClaudeCode,
        AgentSkillScope::Global,
        "linked".into(),
        &target,
        Default::default(),
    )
    .await
    .unwrap();
    assert!(deleted.deleted && deleted.kind == "link", "{deleted:?}");
    assert!(!exists(&agent_dir.join("linked")));
    assert_eq!(
        fs::read_to_string(store.join("linked/SKILL.md")).unwrap(),
        "codeg's\n"
    );
}

// ─── After review: data on disk ─────────────────────────────────────────

/// Finding 1. A backup is named by two plain entries — no separator of
/// either kind, no drive (`C:x` would replace the path it is joined to on
/// Windows), no `..` — and every folder on the way to it is a real one, so
/// restoring or deleting a backup never reaches outside the store's backups.
#[test]
fn a_backup_name_or_folder_that_leads_out_of_the_backups_is_never_touched() {
    let home = Home::new();
    let plant = |dir: &Path| {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("SKILL.md"), "precious\n").unwrap();
    };
    let _guard = home.ctx.lock_blocking().unwrap();

    // A name that is a drive-relative path on Windows is refused everywhere
    // (here it is an ordinary folder name, which shows the refusal).
    assert!(!super::fsio::plain_name("C:victim"));
    // (Windows has no such folder to plant.)
    #[cfg(not(windows))]
    let drive = home.store(".user-backups/foo/C:victim");
    #[cfg(not(windows))]
    plant(&drive);
    let refused = super::backups::delete(&home.ctx, "foo", "C:victim");
    assert_eq!(codes_of(&refused.issues), vec![codes::BACKUP_NOT_FOUND]);
    #[cfg(not(windows))]
    assert!(drive.join("SKILL.md").is_file());
    for (skill, name) in [
        ("foo", ".."),
        ("..", "foo"),
        ("foo", "../../victim"),
        ("foo", "a/b"),
        ("foo", "a\\b"),
        ("foo", ".hidden"),
        ("", "x"),
    ] {
        let refused = super::backups::delete(&home.ctx, skill, name);
        assert_eq!(
            codes_of(&refused.issues),
            vec![codes::BACKUP_NOT_FOUND],
            "{skill}/{name}"
        );
    }

    // A link on the way: `.user-backups/<id>` leading elsewhere.
    let victim = home.path("victim");
    plant(&victim.join("20250101-120000"));
    fs::create_dir_all(home.store(".user-backups")).unwrap();
    platform_link(&victim, &home.store(".user-backups/bar")).unwrap();
    let deleted = super::backups::delete(&home.ctx, "bar", "20250101-120000");
    assert_eq!(codes_of(&deleted.issues), vec![codes::BACKUP_NOT_FOUND]);
    let restored =
        super::backups::restore_as_custom(&home.ctx, "bar", "20250101-120000", "bar-mine");
    assert_eq!(codes_of(&restored.issues), vec![codes::BACKUP_NOT_FOUND]);
    assert!(victim.join("20250101-120000/SKILL.md").is_file());
    assert!(!exists(&home.store("bar-mine")));
    assert!(super::backups::list(&home.ctx, Some("bar"))
        .backups
        .is_empty());

    // `.user-backups` itself a link elsewhere.
    let other = home.path("other-root");
    plant(&other.join("baz/20250101-120000"));
    fs::remove_dir_all(home.store(".user-backups")).unwrap();
    platform_link(&other, &home.store(".user-backups")).unwrap();
    let deleted = super::backups::delete(&home.ctx, "baz", "20250101-120000");
    assert_eq!(codes_of(&deleted.issues), vec![codes::BACKUP_NOT_FOUND]);
    assert!(other.join("baz/20250101-120000/SKILL.md").is_file());

    // An older release's backup that is a link to somewhere else is not one.
    let elsewhere = home.path("elsewhere");
    plant(&elsewhere);
    platform_link(&elsewhere, &home.store("qux.user-backup-20250101-120000")).unwrap();
    let restored =
        super::backups::restore_as_custom(&home.ctx, "qux", "20250101-120000", "qux-mine");
    assert_eq!(codes_of(&restored.issues), vec![codes::BACKUP_NOT_FOUND]);
    assert!(!exists(&home.store("qux-mine")));
    assert!(elsewhere.join("SKILL.md").is_file());
}

/// Finding 1, the repair: a path that climbs (`..`) out through a link in an
/// agent's directory names nothing Codeg may touch.
#[test]
fn a_repair_path_that_climbs_out_of_an_agent_directory_is_refused() {
    let home = Home::new();
    // `claude/skills/sub` leads to `elsewhere/inner`, so the kernel reads
    // `claude/skills/sub/../x` as `elsewhere/x`: a broken link into the
    // store there.
    fs::create_dir_all(home.path("elsewhere/inner")).unwrap();
    fs::create_dir_all(home.path("claude/skills")).unwrap();
    platform_link(
        &home.path("elsewhere/inner"),
        &home.path("claude/skills/sub"),
    )
    .unwrap();
    let outside = home.path("elsewhere/x");
    platform_link(&home.store("x"), &outside).unwrap();
    // Not through `home.path`: joined onto a verbatim root (`\\?\C:\…`,
    // what Windows' `canonicalize` gives) the `..` would be folded away.
    let climbing = super::fsio::strip_verbatim(&home.path("claude/skills/sub"))
        .join("..")
        .join("x");
    for action in [RepairAction::Remove, RepairAction::Repoint] {
        let refused = repair(&home, climbing.clone(), action, None, false);
        assert_eq!(
            codes_of(&refused.issues),
            vec![codes::PATH_OUTSIDE_AGENT_DIRS],
            "{refused:?}"
        );
        assert!(exists(&outside), "left alone");
    }
}

fn copy_home_with_claude_copy() -> (Home, PathBuf) {
    let home = Home::with_linker(Arc::new(FailingJunction));
    home.skill("x", "v1");
    assert!(
        home.run(
            vec![op("x", AgentType::ClaudeCode, SkillAction::Enable)],
            false
        )
        .ok
    );
    let copy = home.path("claude/skills/x");
    assert!(copy.join("SKILL.md").is_file());
    (home, copy)
}

fn staged_ops(home: &Home) -> Vec<PathBuf> {
    fs::read_dir(home.path("claude/.codeg-skills-staging"))
        .map(|entries| entries.flatten().map(|e| e.path()).collect())
        .unwrap_or_default()
}

/// Finding 2. Replacing a changed copy (backed up first) when the new copy
/// cannot go in and the changed one cannot go back either: nothing is
/// deleted — the changed copy waits in staging with its journal, its backup
/// stays, the result names both — and the next start puts it back.
#[test]
fn a_failed_rollback_keeps_the_original_and_its_backup() {
    let (home, copy) = copy_home_with_claude_copy();
    fs::write(copy.join("notes.md"), "mine\n").unwrap();
    home.skill("x", "v2");

    home.ctx.arm_fault("swap_in");
    home.ctx.arm_fault("swap_restore");
    let mut replace = op("x", AgentType::ClaudeCode, SkillAction::Refresh);
    replace.replace_modified = true;
    let result = home.run(vec![replace], false);
    home.ctx.disarm_faults();
    assert_eq!(result.outcome, ApplyOutcome::WriteFailed, "{result:?}");
    let issues = &result.ops[0].issues;
    assert_eq!(
        codes_of(issues),
        vec![codes::COPY_FAILED, codes::ROLLBACK_FAILED],
        "{issues:?}"
    );
    let kept: Vec<PathBuf> = issues[1].kept.iter().map(PathBuf::from).collect();
    assert_eq!(kept.len(), 3, "{kept:?}");
    let staged_old = kept
        .iter()
        .find(|p| p.ends_with("old"))
        .expect("the staged original");
    assert_eq!(
        fs::read_to_string(staged_old.join("notes.md")).unwrap(),
        "mine\n"
    );
    assert!(staged_old.parent().unwrap().join("op.json").is_file());
    let backup = kept
        .iter()
        .find(|p| p.starts_with(home.store(".user-backups")))
        .expect("the backup");
    assert_eq!(
        fs::read_to_string(backup.join("notes.md")).unwrap(),
        "mine\n"
    );
    assert!(!exists(&copy), "nothing could go back yet");

    // The next start puts the changed copy back.
    let _guard = home.ctx.lock_blocking().unwrap();
    let problems = super::copies::recover(&home.ctx, &home.record());
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(fs::read_to_string(copy.join("notes.md")).unwrap(), "mine\n");
    assert!(staged_ops(&home).is_empty());
    assert!(backup.join("notes.md").is_file(), "the backup stays");
}

/// Finding 2, undoing: a later failure undoes earlier steps; an undo that
/// fails keeps what it had moved (and the backup), and its copy's record
/// entry, so the next start can put it back.
#[test]
fn an_undo_that_fails_keeps_what_it_moved_for_the_next_start() {
    let (home, copy) = copy_home_with_claude_copy();
    assert!(
        home.run(vec![op("x", AgentType::Gemini, SkillAction::Enable)], false)
            .ok
    );
    let gemini = home.path("gemini/skills/x");
    fs::write(copy.join("notes.md"), "mine\n").unwrap();
    home.skill("x", "v2");

    // Claude: replace the changed copy (backed up first). Gemini: take its
    // copy away. Then the record cannot be written, and neither step can
    // be put back.
    let mut replace = op("x", AgentType::ClaudeCode, SkillAction::Refresh);
    replace.replace_modified = true;
    for point in ["record", "unswap", "unstage"] {
        home.ctx.arm_fault(point);
    }
    let result = home.run(
        vec![replace, op("x", AgentType::Gemini, SkillAction::Disable)],
        false,
    );
    home.ctx.disarm_faults();
    assert_eq!(result.outcome, ApplyOutcome::WriteFailed, "{result:?}");
    for op in &result.ops {
        assert_eq!(op.status, OpStatus::RollbackFailed, "{op:?}");
        let rollback = op
            .issues
            .iter()
            .find(|i| i.code == codes::ROLLBACK_FAILED)
            .expect("rollback_failed");
        assert!(!rollback.kept.is_empty(), "{rollback:?}");
    }
    let claude_kept = &result.ops[0]
        .issues
        .iter()
        .find(|i| i.code == codes::ROLLBACK_FAILED)
        .unwrap()
        .kept;
    assert!(
        claude_kept
            .iter()
            .any(|p| Path::new(p).starts_with(home.store(".user-backups"))),
        "the backup is kept: {claude_kept:?}"
    );
    assert!(
        home.record().get(&gemini).is_some(),
        "the staged copy keeps its entry"
    );

    let _guard = home.ctx.lock_blocking().unwrap();
    let problems = super::copies::recover(&home.ctx, &home.record());
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(
        fs::read_to_string(copy.join("notes.md")).unwrap(),
        "mine\n",
        "Claude's changed copy is back"
    );
    assert!(fs::read_to_string(gemini.join("SKILL.md"))
        .unwrap()
        .contains("v1"));
    assert!(staged_ops(&home).is_empty());
}

/// Finding 2, the store: a pack update whose new folder cannot go in, when
/// the old one cannot go back either, keeps the old one (never deleted), and
/// the next start puts it back.
#[test]
fn a_skill_swapped_out_of_the_store_is_never_lost() {
    let home = Home::new();
    home.skill("p", "the old one");
    home.ctx.arm_fault("place_swap");
    home.ctx.arm_fault("place_restore");
    let failed = super::packs::place_skill(&home.ctx, "p", false, |target| {
        fs::create_dir_all(target)?;
        fs::write(target.join("SKILL.md"), "the new one")
    });
    home.ctx.disarm_faults();
    let err = failed.expect_err("the swap failed");
    assert!(err.to_string().contains("kept"), "{err}");
    assert!(!exists(&home.store("p")));

    let problems = super::startup::clear_store_staging(&home.ctx);
    assert!(problems.is_empty(), "{problems:?}");
    assert!(fs::read_to_string(home.store("p/SKILL.md"))
        .unwrap()
        .contains("the old one"));
    home.assert_no_staging();
}

/// Finding 3. A crash after the new copy was recorded (the commit point)
/// and before the staging was cleared, then an edit on the agent's side:
/// the next start keeps the edit. Before the commit point, a copy that
/// matches neither the old copy nor the new one is kept too, with the old
/// one, and reported; only Codeg's own new copy is ever replaced back.
#[test]
fn recovery_never_takes_an_edit_made_after_a_crash() {
    let (home, copy) = copy_home_with_claude_copy();
    home.skill("x", "v2");
    let lock = home.ctx.lock_blocking().unwrap();

    // Committed, then edited.
    let staged = super::copies::swap_in(&home.ctx, &copy, "x").unwrap();
    let mut record = home.record();
    let mut entry = record.get(&copy).cloned().unwrap();
    entry.copy_hash = Some(staged.new_hash.clone());
    record.insert(entry);
    record.save(&home.ctx.store).unwrap();
    // …the crash: no commit. Then the user edits the copy.
    fs::write(copy.join("notes.md"), "edited after\n").unwrap();
    let problems = super::copies::recover(&home.ctx, &home.record());
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(
        fs::read_to_string(copy.join("notes.md")).unwrap(),
        "edited after\n"
    );
    assert!(fs::read_to_string(copy.join("SKILL.md"))
        .unwrap()
        .contains("v2"));
    assert!(staged_ops(&home).is_empty());

    // Not committed, then edited: both stay, and it is said.
    fs::remove_file(copy.join("notes.md")).unwrap();
    home.skill("x", "v3");
    let staged = super::copies::swap_in(&home.ctx, &copy, "x").unwrap();
    fs::write(copy.join("notes.md"), "edited again\n").unwrap();
    let problems = super::copies::recover(&home.ctx, &home.record());
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert_eq!(
        fs::read_to_string(copy.join("notes.md")).unwrap(),
        "edited again\n"
    );
    assert!(staged.op_dir.join("old/SKILL.md").is_file(), "kept");
    assert!(staged.op_dir.join("op.json").is_file(), "journal kept");

    // Not committed and untouched: Codeg's new copy gives way to the old.
    fs::remove_dir_all(&staged.op_dir).unwrap();
    super::fsio::remove_if_empty(&home.path("claude/.codeg-skills-staging"));
    fs::remove_file(copy.join("notes.md")).unwrap();
    let before = super::fsio::hash_skill_dir(&copy, "x").unwrap();
    home.skill("x", "v4");
    let _staged = super::copies::swap_in(&home.ctx, &copy, "x").unwrap();
    let problems = super::copies::recover(&home.ctx, &home.record());
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(super::fsio::hash_skill_dir(&copy, "x").unwrap(), before);
    assert!(staged_ops(&home).is_empty());
    drop(lock);
}

/// Finding 4. After Codeg's backup is restored over the store, which folders
/// are Codeg's copies follows the record from before the restore: a copy
/// disabled since the backup (where the user has a folder of their own now)
/// is not Codeg's again, and a copy refreshed since keeps its new hash.
#[test]
fn a_restore_never_brings_back_copies_disabled_since_the_backup() {
    let home = Home::new();
    home.skill("x", "body");
    home.skill("y", "body");
    let entry = |path: &Path, skill: &str, hash: &str| RecordEntry {
        skill: skill.into(),
        dir: path.parent().unwrap().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        mode: LinkMode::Copy,
        created_at: super::record::now(),
        copy_hash: Some(hash.into()),
    };
    // Now: the user's own folder where Codeg's copy of `x` was (disabled
    // since the backup), and Codeg's refreshed copy of `y`.
    let users = home.path("gemini/skills/x");
    fs::create_dir_all(&users).unwrap();
    fs::write(users.join("SKILL.md"), "the user's own\n").unwrap();
    let refreshed = home.path("claude/skills/y");
    fs::create_dir_all(&refreshed).unwrap();
    fs::write(refreshed.join("SKILL.md"), "refreshed\n").unwrap();
    let fresh_hash = super::fsio::hash_skill_dir(&refreshed, "y").unwrap();
    // The record from just before the restore.
    let snapshot = home.path("snapshot");
    let mut before = LinkRecord::default();
    before.insert(entry(&refreshed, "y", &fresh_hash));
    before.save(&snapshot).unwrap();
    // The restored record, as old as the backup.
    let mut restored = LinkRecord::default();
    restored.insert(entry(&users, "x", "stale"));
    restored.insert(entry(&refreshed, "y", "stale"));
    restored.save(&home.ctx.store).unwrap();

    super::startup::absorb_record_after_restore(&home.ctx.store, &snapshot).unwrap();
    let record = home.record();
    assert!(record.get(&users).is_none(), "not Codeg's again");
    assert_eq!(
        record.get(&refreshed).and_then(|e| e.copy_hash.clone()),
        Some(fresh_hash)
    );
    assert_eq!(home.cell("x", AgentType::Gemini).state, CellState::Blocked);
    let disabled = home.run(
        vec![op("x", AgentType::Gemini, SkillAction::Disable)],
        false,
    );
    assert_eq!(disabled.ops[0].status, OpStatus::Unchanged);
    assert_eq!(
        fs::read_to_string(users.join("SKILL.md")).unwrap(),
        "the user's own\n"
    );
    let y = home.cell("y", AgentType::ClaudeCode);
    assert_eq!((y.state, y.copy_matches), (CellState::Copy, Some(true)));
}

/// Finding 5. A move across volumes deletes the original only once the
/// copy is on disk: every copied file is flushed, and a flush that fails
/// fails the move with the original untouched.
#[test]
fn a_move_across_volumes_puts_the_copy_on_disk_before_the_original_goes() {
    let tmp = tempfile::tempdir().unwrap();
    let make = |dir: &Path| {
        fs::create_dir_all(dir.join("scripts")).unwrap();
        fs::write(dir.join("SKILL.md"), "body\n").unwrap();
        fs::write(dir.join("scripts/run.sh"), "echo\n").unwrap();
    };
    super::fsio::hooks::disarm();

    let from = tmp.path().join("a");
    let to = tmp.path().join("b");
    make(&from);
    super::fsio::hooks::arm("move_rename");
    super::fsio::move_dir(&from, &to, "s").unwrap();
    assert_eq!(super::fsio::hooks::synced_files(), 2);
    assert!(!exists(&from));
    assert_eq!(fs::read_to_string(to.join("SKILL.md")).unwrap(), "body\n");

    let from = tmp.path().join("c");
    let to = tmp.path().join("d");
    make(&from);
    super::fsio::hooks::arm("sync");
    let failed = super::fsio::move_dir(&from, &to, "s");
    super::fsio::hooks::disarm();
    assert!(failed.is_err());
    assert_eq!(fs::read_to_string(from.join("SKILL.md")).unwrap(), "body\n");
    assert!(from.join("scripts/run.sh").is_file());
    assert!(!exists(&to));
}

/// Finding 7. A skill of the user's under a pack's id stays theirs even when
/// its content equals the pack's: the pack's is "name taken".
#[test]
fn a_pack_never_claims_a_users_skill_even_one_equal_to_its_own() {
    let home = Home::new();
    let dir = home.store("k1-pack");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        "---\nname: k1-pack\n---\nversion one\n",
    )
    .unwrap();
    assert_eq!(
        super::fsio::hash_skill_dir(&dir, "k1-pack").unwrap(),
        super::packs::bundled_hash(&V1, "k1-pack").unwrap(),
        "the same content"
    );

    let report = install(&home, &V1);
    assert_eq!(report.name_taken, vec!["k1-pack".to_string()], "{report:?}");
    let provenance = super::provenance::Provenance::load(&home.ctx.store);
    assert_eq!(
        provenance.origin_of(&home.ctx.store, "k1-pack"),
        Some(SkillOrigin::Custom)
    );
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(home.store(".manifest.json")).unwrap()).unwrap();
    assert!(manifest["experts"].get("k1-pack").is_none(), "{manifest}");
}

/// Finding 8, as decided after review: while a pack's manifest cannot be
/// read, nothing whose owner is unknown changes. A folder equal to the
/// bundled skill is recorded as the pack's; any other is left exactly as it
/// is — no backup, no replacement, not claimed (the pack's is "name taken")
/// — and reported (`ownership_unresolved`) until it goes or comes to equal
/// the pack's skill.
#[test]
fn while_a_manifest_is_unreadable_nothing_of_unknown_ownership_changes() {
    let home = Home::new();
    assert_eq!(install(&home, &V1).installed_count, 1);
    let origin = |home: &Home| {
        super::provenance::Provenance::load(&home.ctx.store).origin_of(&home.ctx.store, "k1-pack")
    };

    // Equal to the bundle: recorded as the pack's.
    fs::write(home.store(".manifest.json"), b"{ not json").unwrap();
    let report = install(&home, &V1);
    assert!(
        report.name_taken.is_empty() && report.unresolved.is_empty(),
        "{report:?}"
    );
    assert!(home.store(".manifest.json.unreadable").is_file());
    assert_eq!(origin(&home), Some(SkillOrigin::Experts));

    // Anything else: left exactly as it is, and said so.
    fs::write(home.store(".manifest.json"), b"{ not json").unwrap();
    fs::write(home.store("k1-pack/SKILL.md"), "whose is this?\n").unwrap();
    let report = install(&home, &V1);
    assert_eq!(report.unresolved, vec!["k1-pack".to_string()], "{report:?}");
    assert_eq!(report.name_taken, vec!["k1-pack".to_string()]);
    assert!(report.pending_user_review.is_empty());
    assert_eq!(
        fs::read_to_string(home.store("k1-pack/SKILL.md")).unwrap(),
        "whose is this?\n"
    );
    assert!(super::backups::list(&home.ctx, None).backups.is_empty());
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(home.store(".manifest.json")).unwrap()).unwrap();
    assert!(manifest["experts"].get("k1-pack").is_none(), "{manifest}");
    assert_eq!(manifest["unresolved"], serde_json::json!(["k1-pack"]));
    assert_eq!(origin(&home), Some(SkillOrigin::Custom), "not claimed");
    let inventory = super::world::inventory(&home.ctx);
    let problem = inventory
        .problems
        .iter()
        .find(|p| p.code == codes::OWNERSHIP_UNRESOLVED)
        .expect("reported");
    assert_eq!(problem.path.as_deref(), home.store("k1-pack").to_str());
    assert_eq!(problem.detail.as_deref(), Some("experts"));

    // The manifest readable again: still left alone…
    let report = install(&home, &V1);
    assert_eq!(report.unresolved, vec!["k1-pack".to_string()]);
    assert_eq!(
        fs::read_to_string(home.store("k1-pack/SKILL.md")).unwrap(),
        "whose is this?\n"
    );
    // …until it goes: then the pack's own is put in, and nothing is pending.
    fs::remove_dir_all(home.store("k1-pack")).unwrap();
    let report = install(&home, &V1);
    assert_eq!(report.installed_count, 1, "{report:?}");
    assert!(report.unresolved.is_empty());
    assert_eq!(origin(&home), Some(SkillOrigin::Experts));
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(home.store(".manifest.json")).unwrap()).unwrap();
    assert!(manifest.get("unresolved").is_none(), "{manifest}");
}

/// The same for Office: with its manifest unreadable, a folder holding
/// exactly what Office writes is recorded as Office's; any other is never
/// overwritten, never uninstalled, and is reported.
#[test]
fn office_never_overwrites_or_removes_a_folder_of_unknown_owner() {
    use super::packs::{
        load_office_manifest, uninstall_office_skills, write_office_skill, OfficeWrite,
    };
    let home = Home::new();
    let ids = crate::commands::office_tools::bundled_skill_ids();
    assert!(ids.len() >= 2, "{ids:?}");
    let (ours, theirs) = (ids[0].clone(), ids[1].clone());
    let plant = |id: &str, text: &str| {
        fs::create_dir_all(home.store(id)).unwrap();
        fs::write(home.store(id).join("SKILL.md"), text).unwrap();
    };
    plant(&ours, "office writes this\n");
    plant(&theirs, "the user's own\n");
    fs::write(home.store(".manifest.office.json"), b"{ not json").unwrap();

    let mut manifest = load_office_manifest(&home.ctx);
    assert_eq!(
        write_office_skill(&home.ctx, &mut manifest, &ours, "office writes this\n").unwrap(),
        OfficeWrite::Unchanged
    );
    assert_eq!(
        write_office_skill(
            &home.ctx,
            &mut manifest,
            &theirs,
            "office would write this\n"
        )
        .unwrap(),
        OfficeWrite::LeftAlone
    );
    manifest.stamp();
    manifest.save(&home.ctx.store).unwrap();
    assert_eq!(
        fs::read_to_string(home.store(&theirs).join("SKILL.md")).unwrap(),
        "the user's own\n"
    );
    let provenance = super::provenance::Provenance::load(&home.ctx.store);
    assert_eq!(
        provenance.origin_of(&home.ctx.store, &ours),
        Some(SkillOrigin::Office)
    );
    assert_eq!(
        provenance.origin_of(&home.ctx.store, &theirs),
        Some(SkillOrigin::Custom)
    );
    assert!(provenance
        .problems
        .iter()
        .any(|p| p.code == codes::OWNERSHIP_UNRESOLVED
            && p.path.as_deref() == home.store(&theirs).to_str()
            && p.detail.as_deref() == Some("office")));

    // Uninstalling Office takes only what is Office's.
    let (_, errors) = uninstall_office_skills(&home.ctx);
    assert!(!exists(&home.store(&ours)));
    assert!(home.store(&theirs).join("SKILL.md").is_file());
    assert!(
        errors
            .iter()
            .any(|e| e.contains(codes::OWNERSHIP_UNRESOLVED)),
        "{errors:?}"
    );
}

/// Finding 7, the other side: a pack's new skill is claimed before its folder
/// is put in the store, so a manifest that cannot be written leaves nothing
/// of the pack's unclaimed (it would read as the user's from then on).
#[test]
fn a_pack_extracts_nothing_it_could_not_claim() {
    let home = Home::new();
    home.ctx.arm_fault("manifest_save");
    let report = install(&home, &V1);
    home.ctx.disarm_faults();
    assert!(!report.errors.is_empty(), "{report:?}");
    assert_eq!(report.installed_count, 0);
    assert!(!exists(&home.store("k1-pack")), "nothing unclaimed");
    home.assert_no_staging();
}

/// Finding 9. Enabling in a shared directory would leave an agent that has
/// its own changed copy of the skill with two: blocked, with whose copy.
#[test]
fn a_changed_copy_of_another_agent_blocks_adding_the_shared_link() {
    let home = Home::with_linker(Arc::new(FailingJunction));
    home.skill("x", "v1");
    assert!(
        home.run(vec![op("x", AgentType::Gemini, SkillAction::Enable)], false)
            .ok
    );
    let gemini = home.path("gemini/skills/x");
    fs::write(gemini.join("notes.md"), "mine\n").unwrap();

    let preflight = home.run(
        vec![op("x", shared_only_agent(), SkillAction::Enable)],
        true,
    );
    assert!(!preflight.ok, "{preflight:?}");
    assert_eq!(preflight.ops[0].status, OpStatus::Blocked);
    let issue = &preflight.ops[0].issues[0];
    assert_eq!(issue.code, codes::COPY_MODIFIED);
    assert_eq!(issue.agents, vec![AgentType::Gemini]);
    assert_eq!(issue.path.as_deref(), gemini.to_str());
    let refused = home.confirm(vec![op("x", shared_only_agent(), SkillAction::Enable)]);
    assert_eq!(refused.outcome, ApplyOutcome::Invalid);
    assert!(!exists(&home.path("agents/skills/x")));
    assert_eq!(
        fs::read_to_string(gemini.join("notes.md")).unwrap(),
        "mine\n"
    );
}

/// Finding 9, repairs: re-pointing a broken link in a shared directory
/// takes the readers' own links of the skill away (they see it through the
/// shared one), as enabling there does; in a directory of one agent's own,
/// it is refused when that agent already sees the skill elsewhere.
#[test]
fn repairing_a_link_never_leaves_an_agent_with_two() {
    let home = Home::new();
    home.skill("x", "body");
    let codex_own = home.plant_link("codex/skills", "x");
    let shared = plant_recorded_broken_link(&home, "agents/skills", "x");

    let preflight = repair(&home, shared.clone(), RepairAction::Repoint, None, true);
    assert!(preflight.ok, "{preflight:?}");
    assert!(
        preflight.removes.contains(&PathChange {
            path: codex_own.to_string_lossy().into_owned(),
            kind: ChangeKind::Link,
        }),
        "{preflight:?}"
    );
    assert!(
        preflight.touches.contains(&AgentType::Codex),
        "{preflight:?}"
    );
    let done = repair(
        &home,
        shared.clone(),
        RepairAction::Repoint,
        preflight.ack,
        false,
    );
    assert_eq!(done.outcome, ApplyOutcome::Applied, "{done:?}");
    assert!(home.is_link_to(&shared, "x"));
    assert!(!exists(&codex_own));
    assert_eq!(
        home.cell("x", AgentType::Codex).state,
        CellState::VisibleThrough
    );

    // Codex sees it through the shared link now: its own broken one cannot
    // be re-pointed too (it can be removed).
    let own_broken = plant_recorded_broken_link(&home, "codex/skills", "x");
    let refused = repair(
        &home,
        own_broken.clone(),
        RepairAction::Repoint,
        None,
        false,
    );
    assert_eq!(codes_of(&refused.issues), vec![codes::ALREADY_VISIBLE]);
    assert!(fs::metadata(&own_broken).is_err(), "still the broken link");
    let removed = repair(&home, own_broken.clone(), RepairAction::Remove, None, false);
    assert_eq!(removed.outcome, ApplyOutcome::Applied, "{removed:?}");
}

/// The UI pack's two names in a store of the test's own.
fn plant_ui(home: &Home, ui_render_is_codegs: bool) {
    use super::provenance::UI_MARKER;
    for (id, marked) in [("ui-render", ui_render_is_codegs), ("json-render", true)] {
        let dir = home.store(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), format!("---\nname: {id}\n---\n")).unwrap();
        if marked {
            fs::write(dir.join(UI_MARKER), "Codeg installs this skill\n").unwrap();
        }
    }
}

/// Finding 10. Retiring Codeg 0.35.0's `json-render` links is part of the
/// plan — in the preflight's `removes`, under the `ack` — and only for
/// Codeg's own `ui-render`: a skill of the user's of that name never takes
/// an agent's `json-render` away.
#[test]
fn retiring_json_render_is_planned_and_only_for_codegs_ui_render() {
    // The user's `ui-render`: their `json-render` links stay.
    let home = Home::new();
    plant_ui(&home, false);
    let old = home.plant_link("claude/skills", "json-render");
    let result = home.run(
        vec![op("ui-render", AgentType::ClaudeCode, SkillAction::Enable)],
        false,
    );
    assert_eq!(result.outcome, ApplyOutcome::Applied, "{result:?}");
    assert!(home.is_link_to(&old, "json-render"), "left alone");

    // Codeg's: shown first, then done.
    let home = Home::new();
    plant_ui(&home, true);
    let own = home.plant_link("claude/skills", "json-render");
    let preflight = home.run(
        vec![op("ui-render", AgentType::ClaudeCode, SkillAction::Enable)],
        true,
    );
    assert!(
        preflight.ops[0].removes.contains(&PathChange {
            path: own.to_string_lossy().into_owned(),
            kind: ChangeKind::Link,
        }),
        "{preflight:?}"
    );
    let done = home.run(
        vec![op("ui-render", AgentType::ClaudeCode, SkillAction::Enable)],
        false,
    );
    assert_eq!(done.outcome, ApplyOutcome::Applied, "{done:?}");
    assert!(!exists(&own));

    // In a shared directory the others lose `json-render` too: asked first.
    let shared = home.plant_link("agents/skills", "json-render");
    let preflight = home.run(
        vec![op("ui-render", shared_only_agent(), SkillAction::Enable)],
        true,
    );
    let planned = &preflight.ops[0];
    assert!(
        planned.removes.contains(&PathChange {
            path: shared.to_string_lossy().into_owned(),
            kind: ChangeKind::Link,
        }),
        "{planned:?}"
    );
    assert!(planned.ack.is_some());
    let unasked = home.run(
        vec![op("ui-render", shared_only_agent(), SkillAction::Enable)],
        false,
    );
    assert_eq!(unasked.outcome, ApplyOutcome::AcknowledgementRequired);
    assert!(home.is_link_to(&shared, "json-render"), "nothing unasked");
    let done = home.confirm(vec![op(
        "ui-render",
        shared_only_agent(),
        SkillAction::Enable,
    )]);
    assert_eq!(done.outcome, ApplyOutcome::Applied, "{done:?}");
    assert!(!exists(&shared));
}

/// Finding 2, adopting: when the link cannot be made and the original
/// cannot go back either, nothing is deleted — the original waits in
/// staging, the store's checked copy stays, the result names both — and the
/// next start puts the original back.
#[test]
fn an_adopt_that_cannot_put_the_original_back_deletes_nothing() {
    let home = Home::new();
    let original = plant_own_skill(&home);
    let before = super::fsio::hash_skill_dir(&original, "adopt-me").unwrap();
    home.ctx.arm_fault("adopt_link");
    home.ctx.arm_fault("adopt_put_back");
    let result = adopt(&home, AgentType::ClaudeCode, "adopt-me");
    home.ctx.disarm_faults();
    assert_eq!(result.outcome, AdoptOutcome::Failed, "{result:?}");
    assert!(!result.restored);
    let rollback = result
        .issues
        .iter()
        .find(|i| i.code == codes::ROLLBACK_FAILED)
        .expect("rollback_failed");
    let kept: Vec<PathBuf> = rollback.kept.iter().map(PathBuf::from).collect();
    assert!(kept.contains(&home.store("adopt-me")), "{kept:?}");
    let staged = kept.iter().find(|p| p.ends_with("old")).expect("staged");
    assert_eq!(
        super::fsio::hash_skill_dir(staged, "adopt-me").unwrap(),
        before
    );
    assert_eq!(
        super::fsio::hash_skill_dir(&home.store("adopt-me"), "adopt-me").unwrap(),
        before,
        "the store's copy stays"
    );

    let _guard = home.ctx.lock_blocking().unwrap();
    let problems = super::copies::recover(&home.ctx, &home.record());
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(
        super::fsio::hash_skill_dir(&original, "adopt-me").unwrap(),
        before,
        "the original is back"
    );
    assert!(staged_ops(&home).is_empty());
}

/// Follow-up C1. A new skill from the Skills page goes into the first folder
/// only that agent reads — Cline's `~/.cline/skills`, not the shared
/// `~/.agents/skills` it reads first — and an agent with no folder of its own
/// is refused (`no_own_directory`, naming who would see it) with nothing
/// written.
#[tokio::test]
async fn a_new_skill_from_the_skills_page_goes_into_the_agents_own_folder() {
    use crate::acp::types::AgentSkillScope;
    use crate::commands::acp::{acp_save_agent_skill_in, SkillPageDirs, SkillStorageKind};
    let home = &Home::new();
    let page = &|agent: AgentType| {
        SkillPageDirs::with_readers(
            &home.ctx,
            agent,
            SkillStorageKind::SkillDirectoryOnly,
            home.ctx.agent(agent).unwrap().dirs.clone(),
        )
    };
    let save = |agent: AgentType, id: &str| {
        let id = id.to_string();
        async move {
            acp_save_agent_skill_in(
                &home.ctx,
                &EventEmitter::Noop,
                agent,
                AgentSkillScope::Global,
                id,
                "---\nname: x\n---\n".to_string(),
                &|| Ok(page(agent)),
                None,
                true,
            )
            .await
        }
    };
    let saved = save(AgentType::Cline, "cline-own").await.unwrap();
    assert_eq!(
        Path::new(&saved.path),
        home.path("cline/skills/cline-own").as_path()
    );
    assert!(home.path("cline/skills/cline-own/SKILL.md").is_file());
    assert!(!exists(&home.path("agents/skills/cline-own")));

    let refused = save(shared_only_agent(), "everyones").await.unwrap_err();
    let params = refused.i18n_params.unwrap_or_default();
    assert_eq!(
        params.get("code").map(String::as_str),
        Some(codes::NO_OWN_DIRECTORY)
    );
    let named = params.get("detail").cloned().unwrap_or_default();
    assert!(
        named.contains("cline") && named.contains("codex"),
        "{named}"
    );
    assert!(!exists(&home.path("agents/skills/everyones")));
}

/// Follow-up C2. Deleting from the Skills page in a folder other agents read
/// deletes it for them too: a preflight names them and gives an `ack`; the
/// real delete without it (or with a stale one) is refused and deletes
/// nothing. In a folder of the agent's own, no ack is needed.
#[tokio::test]
async fn deleting_from_a_shared_folder_on_the_skills_page_needs_the_ack() {
    use crate::acp::types::AgentSkillScope;
    use crate::commands::acp::{
        acp_delete_agent_skill_in, SkillPageDeleteConfirm, SkillPageDirs, SkillStorageKind,
    };
    let home = Home::new();
    let shared = home.path("agents/skills/theirs");
    fs::create_dir_all(&shared).unwrap();
    fs::write(shared.join("SKILL.md"), "everyone reads me\n").unwrap();
    let delete = |agent: AgentType, id: &str, confirm: SkillPageDeleteConfirm| {
        let id = id.to_string();
        let home = &home;
        async move {
            acp_delete_agent_skill_in(
                &home.ctx,
                &EventEmitter::Noop,
                agent,
                AgentSkillScope::Global,
                id,
                &|| {
                    Ok(SkillPageDirs::with_readers(
                        &home.ctx,
                        agent,
                        SkillStorageKind::SkillDirectoryOnly,
                        home.ctx.agent(agent).unwrap().dirs.clone(),
                    ))
                },
                confirm,
            )
            .await
        }
    };
    let code_of = |err: crate::app_error::AppCommandError| {
        err.i18n_params.unwrap_or_default().get("code").cloned()
    };

    let preflight = delete(
        AgentType::Codex,
        "theirs",
        SkillPageDeleteConfirm {
            preflight: true,
            ack: None,
        },
    )
    .await
    .unwrap();
    assert!(!preflight.deleted);
    assert_eq!(preflight.kind, "folder");
    let mut others = vec![
        AgentType::Gemini,
        AgentType::Cline,
        AgentType::OpenCode,
        shared_only_agent(),
    ];
    others.sort();
    assert_eq!(preflight.shared_with, others);
    let ack = preflight.ack.clone().expect("an ack");
    assert!(shared.is_dir(), "a preflight deletes nothing");

    let unasked = delete(AgentType::Codex, "theirs", Default::default())
        .await
        .unwrap_err();
    assert_eq!(
        code_of(unasked).as_deref(),
        Some(codes::ACKNOWLEDGEMENT_REQUIRED)
    );
    let stale = delete(
        AgentType::Codex,
        "theirs",
        SkillPageDeleteConfirm {
            preflight: false,
            ack: Some("0".repeat(64)),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(code_of(stale).as_deref(), Some(codes::EFFECTS_CHANGED));
    assert!(shared.is_dir(), "nothing unasked");

    let done = delete(
        AgentType::Codex,
        "theirs",
        SkillPageDeleteConfirm {
            preflight: false,
            ack: Some(ack),
        },
    )
    .await
    .unwrap();
    assert!(done.deleted);
    assert!(!exists(&shared));

    // In Claude's own folder: no ack.
    let own = home.path("claude/skills/mine");
    fs::create_dir_all(&own).unwrap();
    fs::write(own.join("SKILL.md"), "mine\n").unwrap();
    let done = delete(AgentType::ClaudeCode, "mine", Default::default())
        .await
        .unwrap();
    assert!(done.deleted && done.ack.is_none() && done.shared_with.is_empty());
    assert!(!exists(&own));
}

/// Follow-up A. A first backup creates the folders on its way
/// (`.user-backups`, `<id>`): each is flushed into its parent before the
/// backup counts as taken, so once the copy it backs up is replaced and the
/// original deleted, a power loss cannot lose it. The same for a move across
/// volumes into new folders.
#[test]
fn a_first_backup_and_every_folder_on_its_way_are_on_disk() {
    let home = Home::new();
    let from = home.path("claude/skills/x");
    fs::create_dir_all(from.join("scripts")).unwrap();
    fs::write(from.join("SKILL.md"), "changed by the user\n").unwrap();
    fs::write(from.join("scripts/run.sh"), "echo\n").unwrap();
    fs::create_dir_all(&home.ctx.store).unwrap();
    assert!(!exists(&home.store(".user-backups")));

    super::fsio::hooks::disarm();
    let backup =
        super::backups::copy_into_backups(&home.ctx, &from, "x", Some("claude_code")).unwrap();
    let synced = super::fsio::hooks::synced_dirs();
    for dir in [
        home.ctx.store.clone(),
        home.store(".user-backups"),
        home.store(".user-backups/x"),
        backup.clone(),
    ] {
        assert!(
            synced.contains(&dir),
            "{} not flushed: {synced:?}",
            dir.display()
        );
    }
    assert_eq!(
        fs::read_to_string(backup.join("SKILL.md")).unwrap(),
        "changed by the user\n"
    );

    // A flush that fails fails the backup.
    super::fsio::hooks::arm("sync");
    let failed = super::backups::copy_into_backups(&home.ctx, &from, "y", None);
    super::fsio::hooks::disarm();
    assert!(failed.is_err());

    // Across volumes, into folders that are new.
    let to = home.path("deep/new/x");
    super::fsio::hooks::arm("move_rename");
    super::fsio::move_dir(&from, &to, "x").unwrap();
    let synced = super::fsio::hooks::synced_dirs();
    super::fsio::hooks::disarm();
    for dir in [home.root.clone(), home.path("deep"), home.path("deep/new")] {
        assert!(
            synced.contains(&dir),
            "{} not flushed: {synced:?}",
            dir.display()
        );
    }
    assert!(!exists(&from));
    assert!(to.join("scripts/run.sh").is_file());
}

/// Round 3, item 1. Replacing a manifest that cannot be read never leaves
/// no manifest: until the new one is renamed over it, the unreadable one
/// stays where it is. A replacement that fails (here: injected) leaves it
/// in place, so the next sync still cannot tell whose the folder is and
/// still leaves it alone — it is not read as a store from before Office kept
/// a manifest, which would hand Office the folder.
#[test]
fn a_failed_manifest_replacement_keeps_the_unreadable_one_in_place() {
    use super::packs::{
        load_office_manifest, uninstall_office_skills, write_office_skill, OfficeWrite,
    };
    let home = Home::new();
    let id = crate::commands::office_tools::bundled_skill_ids()[0].clone();
    fs::create_dir_all(home.store(&id)).unwrap();
    fs::write(home.store(&id).join("SKILL.md"), "the user's own\n").unwrap();
    let manifest_path = home.store(".manifest.office.json");
    fs::write(&manifest_path, b"{ not json").unwrap();

    let mut manifest = load_office_manifest(&home.ctx);
    assert_eq!(
        write_office_skill(&home.ctx, &mut manifest, &id, "office would write this\n").unwrap(),
        OfficeWrite::LeftAlone
    );
    super::fsio::hooks::disarm();
    super::fsio::hooks::arm("manifest_write");
    manifest.stamp();
    let failed = manifest.save(&home.ctx.store);
    super::fsio::hooks::disarm();
    assert!(failed.is_err());
    assert_eq!(
        fs::read(&manifest_path).unwrap(),
        b"{ not json",
        "still in place"
    );
    assert!(
        home.store(".manifest.office.json.unreadable").is_file(),
        "kept aside too"
    );

    // The next sync and an uninstall still leave the folder alone.
    let mut manifest = load_office_manifest(&home.ctx);
    assert!(manifest.problem.is_some());
    assert_eq!(
        write_office_skill(&home.ctx, &mut manifest, &id, "office would write this\n").unwrap(),
        OfficeWrite::LeftAlone
    );
    let _ = uninstall_office_skills(&home.ctx);
    assert_eq!(
        fs::read_to_string(home.store(&id).join("SKILL.md")).unwrap(),
        "the user's own\n"
    );

    // The record is replaced the same way.
    let record_path = home.store(".links.json");
    fs::write(&record_path, b"{ not json").unwrap();
    let mut record = home.record();
    assert!(record.problem.is_some());
    record.insert(RecordEntry {
        skill: "x".into(),
        dir: "/d".into(),
        path: "/d/x".into(),
        mode: LinkMode::Symlink,
        created_at: super::record::now(),
        copy_hash: None,
    });
    record.save(&home.ctx.store).unwrap();
    assert!(home.store(".links.json.unreadable").is_file());
    assert!(home.record().get(Path::new("/d/x")).is_some());
}

/// Round 3, item 2. A new skill never goes into a folder the agent CLI
/// keeps for its own bundled skills (Codex's `skills/.system`) — here
/// Codex's own folder is read by another agent too, so `.system` would have
/// been the first folder only Codex reads. With nothing else left, the
/// save is refused (`no_own_directory`) and nothing is written.
#[tokio::test]
async fn a_new_skill_never_goes_into_the_agent_clis_own_folder() {
    use crate::acp::types::AgentSkillScope;
    use crate::commands::acp::{acp_save_agent_skill_in, SkillPageDirs, SkillStorageKind};
    let home = Home::new();
    let reader = AgentType::custom("k1-codex-reader").unwrap();
    let mut agents = home.ctx.agents.clone();
    agents.push(AgentDirs {
        agent: reader,
        dirs: vec![home.path("codex/skills")],
        read_only: vec![],
        markdown_files: false,
    });
    let ctx = SkillsCtx::new(
        home.ctx.store.clone(),
        home.ctx.lock_path.clone(),
        agents,
        Arc::new(PlatformLinks),
    );
    let target = || {
        Ok(SkillPageDirs::with_readers(
            &ctx,
            AgentType::Codex,
            SkillStorageKind::SkillDirectoryOrMarkdownFile,
            ctx.agent(AgentType::Codex).unwrap().dirs.clone(),
        ))
    };
    let refused = acp_save_agent_skill_in(
        &ctx,
        &EventEmitter::Noop,
        AgentType::Codex,
        AgentSkillScope::Global,
        "mine".into(),
        "---\nname: mine\n---\n".into(),
        &target,
        None,
        true,
    )
    .await
    .unwrap_err();
    assert_eq!(
        refused
            .i18n_params
            .unwrap_or_default()
            .get("code")
            .map(String::as_str),
        Some(codes::NO_OWN_DIRECTORY)
    );
    assert!(!exists(&home.path("codex/skills/.system/mine")));
    assert!(!exists(&home.path("codex/skills/.system/mine.md")));
}

/// Round 3, item 3. The `ack` of a delete is checked against who reads the
/// folder when the delete runs (under the lock), not when it was asked for:
/// an agent that started reading the folder in between makes it
/// `effects_changed`, and nothing is deleted.
#[tokio::test]
async fn a_delete_checks_its_ack_against_who_reads_the_folder_when_it_runs() {
    use crate::acp::types::AgentSkillScope;
    use crate::commands::acp::{
        acp_delete_agent_skill_in, SkillPageDeleteConfirm, SkillPageDirs, SkillStorageKind,
    };
    let home = Home::new();
    let shared = home.path("agents/skills/theirs");
    fs::create_dir_all(&shared).unwrap();
    fs::write(shared.join("SKILL.md"), "everyone reads me\n").unwrap();
    // The same agents, plus one that started reading the shared folder.
    let newcomer = AgentType::custom("k1-late-reader").unwrap();
    let mut agents = home.ctx.agents.clone();
    agents.push(AgentDirs {
        agent: newcomer,
        dirs: vec![home.path("agents/skills")],
        read_only: vec![],
        markdown_files: false,
    });
    let later = SkillsCtx::new(
        home.ctx.store.clone(),
        home.ctx.lock_path.clone(),
        agents,
        Arc::new(PlatformLinks),
    );
    let dirs_in = |ctx: &SkillsCtx| {
        SkillPageDirs::with_readers(
            ctx,
            AgentType::Codex,
            SkillStorageKind::SkillDirectoryOnly,
            ctx.agent(AgentType::Codex).unwrap().dirs.clone(),
        )
    };
    let preflight = acp_delete_agent_skill_in(
        &home.ctx,
        &EventEmitter::Noop,
        AgentType::Codex,
        AgentSkillScope::Global,
        "theirs".into(),
        &|| Ok(dirs_in(&home.ctx)),
        SkillPageDeleteConfirm {
            preflight: true,
            ack: None,
        },
    )
    .await
    .unwrap();
    assert!(!preflight.shared_with.contains(&newcomer));

    // By the time the delete runs, the newcomer reads the folder too.
    let stale = acp_delete_agent_skill_in(
        &home.ctx,
        &EventEmitter::Noop,
        AgentType::Codex,
        AgentSkillScope::Global,
        "theirs".into(),
        &|| Ok(dirs_in(&later)),
        SkillPageDeleteConfirm {
            preflight: false,
            ack: preflight.ack.clone(),
        },
    )
    .await
    .unwrap_err();
    let params = stale.i18n_params.unwrap_or_default();
    assert_eq!(
        params.get("code").map(String::as_str),
        Some(codes::EFFECTS_CHANGED)
    );
    assert!(
        params
            .get("detail")
            .is_some_and(|d| d.contains("custom:k1-late-reader")),
        "{params:?}"
    );
    assert!(shared.is_dir(), "nothing deleted");
}

/// A canonical path (verbatim prefix) and the same path as written, or as a
/// junction's target reads, are one place.
#[cfg(windows)]
#[test]
fn a_verbatim_path_is_the_same_path_as_written() {
    use super::fsio::same_path;
    assert!(same_path(
        Path::new(r"\\?\C:\Users\me\.codeg\skills"),
        Path::new(r"c:\users\me\.codeg\skills")
    ));
    assert!(!same_path(
        Path::new(r"\\?\UNC\host\share\skills"),
        Path::new(r"UNC\host\share\skills")
    ));
}
