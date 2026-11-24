//! Installing skills from Harness end to end: a stand-in for SpaceRing and
//! one for the raw-file host on loopback (started inside each test,
//! answering what the test sets), and Codeg's skill store, the skills lock
//! and every agent's skill directory under one temp directory. Nothing here
//! reaches spacering.net, GitHub, the real home or `~/.codeg/skills`.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::Request;
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::journal::{new_journal, Action, Tx};
use super::manifest::{self as skill_manifest, ManifestEntry};
use super::package::PackageFile;
use super::*;
use crate::harness::cache::Cache;
use crate::harness::client::{Backoff, Limits};
use crate::harness::mcp::model::LocalState;
use crate::harness::{Harness, Origin};
use crate::models::agent::AgentType;
use crate::skills::link::{platform_link, LinkMode, LinkStrategy, PlatformLinks};
use crate::skills::model::{ApplyOutcome, OpStatus, SkillOrigin};
use crate::skills::{AgentDirs, SkillsCtx};
use crate::web::event_bridge::{EventEmitter, WebEvent, WebEventBroadcaster};

const ID: &str = "0199b0aa-0000-7000-8000-0000000000bb";
const REF: &str = "acme.dev/pdf";
const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
const NAME: &str = "pdf";

// ─── The package ────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub(crate) struct File {
    pub(crate) path: String,
    pub(crate) bytes: Vec<u8>,
    pub(crate) executable: bool,
}

pub(crate) fn file(path: &str, text: &str, executable: bool) -> File {
    File {
        path: path.to_string(),
        bytes: text.as_bytes().to_vec(),
        executable,
    }
}

fn skill_md(revision: u64) -> String {
    format!(
        "---\nname: pdf\ndescription: Fill PDF forms.\nallowed-tools: Bash Read\n---\nRevision {revision}.\n"
    )
}

fn package(revision: u64) -> Vec<File> {
    vec![
        file("SKILL.md", &skill_md(revision), false),
        file("scripts/run.sh", "#!/bin/sh\necho run\n", true),
        file("reference.md", &format!("Reference {revision}\n"), false),
    ]
}

pub(crate) fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn zip_of(files: &[File]) -> Vec<u8> {
    let mut out = io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut out);
        for file in files {
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(if file.executable { 0o755 } else { 0o644 });
            zip.start_file(file.path.as_str(), options).unwrap();
            zip.write_all(&file.bytes).unwrap();
        }
        zip.finish().unwrap();
    }
    out.into_inner()
}

pub(crate) fn listing(files: &[File]) -> Value {
    Value::Array(
        files
            .iter()
            .map(|file| {
                json!({ "path": file.path, "sha256": sha(&file.bytes),
                        "size": file.bytes.len(), "executable": file.executable })
            })
            .collect(),
    )
}

// ─── The stand-ins ──────────────────────────────────────────────────────

/// What the stand-in serves. The plugin install's tests use it too, for an
/// item of their own (`item`).
#[derive(Default)]
pub(crate) struct Catalog {
    /// The item served, `(ref, id)`; the skill's own when `None`.
    pub(crate) item: Option<(String, String)>,
    pub(crate) latest: u64,
    pub(crate) versions: BTreeMap<u64, Value>,
    pub(crate) resolved: BTreeMap<u64, Value>,
    /// Files served as they are, by path (archives here, the source's files
    /// on the raw host).
    pub(crate) blobs: BTreeMap<String, Vec<u8>>,
    pub(crate) config: Value,
    pub(crate) seen: Vec<(Method, String)>,
    /// Run once, when `/resolve` is next asked.
    on_resolve: Option<Box<dyn FnOnce() + Send>>,
    /// Answer `/resolve` as a site that does not serve it: 404, with a
    /// missing item's body.
    pub(crate) resolve_missing: bool,
}

fn json_reply(value: &Value) -> Response {
    (
        [(header::CONTENT_TYPE, "application/json")],
        value.to_string(),
    )
        .into_response()
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        json_reply(&json!({ "error": "not_found" })),
    )
        .into_response()
}

fn answer(catalog: &Mutex<Catalog>, method: Method, path: &str, body: &[u8]) -> Response {
    let mut catalog = catalog.lock().unwrap();
    catalog.seen.push((method.clone(), path.to_string()));
    if let Some(bytes) = catalog.blobs.get(path) {
        return (
            [(header::CONTENT_TYPE, "application/octet-stream")],
            bytes.clone(),
        )
            .into_response();
    }
    let (item_ref, item_id) = catalog
        .item
        .clone()
        .unwrap_or_else(|| (REF.to_string(), ID.to_string()));
    let item = format!("/api/harness/v1/items/{item_ref}");
    if path == item {
        return json_reply(
            &json!({ "id": item_id, "ref": item_ref, "latest": { "revision": catalog.latest } }),
        );
    }
    if path == "/api/harness/v1/config" {
        return json_reply(&catalog.config);
    }
    if let Some(revision) = path
        .strip_prefix(&format!("{item}/versions/"))
        .and_then(|rest| rest.parse::<u64>().ok())
    {
        return match catalog.versions.get(&revision) {
            Some(version) => json_reply(version),
            None => not_found(),
        };
    }
    if path == "/api/harness/v1/resolve" && method == Method::POST {
        if let Some(meanwhile) = catalog.on_resolve.take() {
            meanwhile();
        }
        if catalog.resolve_missing {
            return not_found();
        }
        let asked: Value = serde_json::from_slice(body).unwrap();
        let items: Vec<Value> = asked["installed"]
            .as_array()
            .unwrap()
            .iter()
            .map(|asked| {
                let revision = asked["revision"].as_u64().unwrap();
                let mut item = catalog
                    .resolved
                    .get(&revision)
                    .cloned()
                    .unwrap_or_else(|| json!({ "status": "unavailable" }));
                item["id"] = asked["id"].clone();
                item
            })
            .collect();
        return json_reply(&json!({ "items": items }));
    }
    not_found()
}

pub(crate) struct Site {
    pub(crate) origin: String,
    pub(crate) catalog: Arc<Mutex<Catalog>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Site {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Site {
    pub(crate) async fn start() -> Self {
        let catalog: Arc<Mutex<Catalog>> = Arc::new(Mutex::new(Catalog {
            config: json!({}),
            ..Catalog::default()
        }));
        let app = axum::Router::new().fallback({
            let catalog = catalog.clone();
            move |request: Request| {
                let catalog = catalog.clone();
                async move {
                    let (parts, body) = request.into_parts();
                    let body = axum::body::to_bytes(body, usize::MAX)
                        .await
                        .unwrap_or_default();
                    answer(&catalog, parts.method, parts.uri.path(), &body)
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            origin,
            catalog,
            task,
        }
    }

    pub(crate) fn seen(&self) -> Vec<(Method, String)> {
        self.catalog.lock().unwrap().seen.clone()
    }
}

// ─── The local side ─────────────────────────────────────────────────────

/// A "junction" that always fails, where copies may stand in: Windows'
/// fallback, on any machine.
struct FailingJunction;

impl LinkStrategy for FailingJunction {
    fn link(&self, _target: &Path, _link: &Path) -> io::Result<LinkMode> {
        Err(io::Error::other("the junction failed (test)"))
    }

    fn copy_fallback(&self) -> bool {
        true
    }
}

fn shared_only() -> AgentType {
    AgentType::custom("h3-shared-only").expect("a valid custom id")
}

/// The real layout in miniature: Claude with one directory; Codex with its
/// own and the shared `agents/skills`; Gemini likewise; Cline with the
/// shared one first and its own second; a custom agent that declared only
/// the shared store.
fn ctx_at(root: &Path, linker: Arc<dyn LinkStrategy>) -> SkillsCtx {
    let d = |rel: &str| root.join(rel);
    let agent = |agent, dirs: Vec<PathBuf>, markdown_files| AgentDirs {
        agent,
        dirs,
        read_only: Vec::new(),
        markdown_files,
    };
    SkillsCtx::new(
        d("store"),
        d("locks/skills.lock"),
        vec![
            agent(AgentType::ClaudeCode, vec![d("claude/skills")], false),
            agent(
                AgentType::Codex,
                vec![d("codex/skills"), d("agents/skills")],
                true,
            ),
            agent(
                AgentType::Gemini,
                vec![d("gemini/skills"), d("agents/skills")],
                false,
            ),
            agent(
                AgentType::Cline,
                vec![d("agents/skills"), d("cline/skills")],
                false,
            ),
            agent(shared_only(), vec![d("agents/skills")], false),
        ],
        linker,
    )
}

/// Installed here: Claude, Codex and Cline.
const INSTALLED: [AgentType; 3] = [AgentType::ClaudeCode, AgentType::Codex, AgentType::Cline];

struct Sandbox {
    _dir: tempfile::TempDir,
    root: PathBuf,
    local: Local,
    site: Site,
    raw: Site,
    harness: Harness,
    events: Arc<WebEventBroadcaster>,
    emitter: EventEmitter,
    /// Fingerprints are this tag plus a name: the snapshots a plan shows
    /// are kept process-wide, and tests run side by side.
    tag: String,
}

impl Sandbox {
    async fn new() -> Self {
        Self::with_linker(Arc::new(PlatformLinks)).await
    }

    async fn with_linker(linker: Arc<dyn LinkStrategy>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let ctx = ctx_at(&root, linker);
        fs::create_dir_all(&ctx.store).unwrap();
        let site = Site::start().await;
        let raw = Site::start().await;
        let harness = Harness {
            enabled: true,
            origin: Origin::parse(&site.origin).expect("a loopback origin"),
            cache: Cache::in_data_dir(&root.join("data")),
            limits: Limits::default(),
            backoff: Box::leak(Box::new(Backoff::default())),
        };
        let local = Local {
            ctx,
            installed: INSTALLED.iter().map(|agent| (*agent, true)).collect(),
            raw_origin: Origin::parse(&raw.origin).expect("a loopback origin"),
        };
        let events = Arc::new(WebEventBroadcaster::new());
        let emitter = EventEmitter::test_web_only(events.clone());
        let sandbox = Self {
            _dir: dir,
            root,
            local,
            site,
            raw,
            harness,
            events,
            emitter,
            tag: uuid::Uuid::new_v4().simple().to_string(),
        };
        sandbox.publish(3, &package(3), true);
        sandbox
    }

    fn ctx(&self) -> &SkillsCtx {
        &self.local.ctx
    }

    fn sha(&self, name: &str) -> String {
        format!("{}-{name}", self.tag)
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    fn store(&self, name: &str) -> PathBuf {
        self.ctx().store.join(name)
    }

    /// Publish `revision` with `files`: as a zip on the catalog, or (no
    /// archive) on the raw host at the source commit.
    fn publish(&self, revision: u64, files: &[File], archive: bool) {
        let zip = zip_of(files);
        let zip_sha = sha(&zip);
        let mut catalog = self.site.catalog.lock().unwrap();
        catalog.latest = catalog.latest.max(revision);
        let (archive_json, source_json) = if archive {
            let url = format!("/api/harness/v1/archives/{zip_sha}.zip");
            catalog.blobs.insert(url.clone(), zip.clone());
            (
                json!({ "url": url, "sha256": zip_sha, "size": zip.len() }),
                Value::Null,
            )
        } else {
            let mut raw = self.raw.catalog.lock().unwrap();
            for file in files {
                raw.blobs.insert(
                    format!("/acme/skills/{COMMIT}/pdf/{}", file.path),
                    file.bytes.clone(),
                );
            }
            (
                Value::Null,
                json!({ "repository": "acme/skills", "commit": COMMIT, "path": "pdf" }),
            )
        };
        catalog.versions.insert(
            revision,
            json!({
                "item": { "id": ID, "ref": REF, "kind": "skill", "title": { "en": "PDF" } },
                "version": { "revision": revision, "version": format!("1.0.{revision}"),
                             "publishedAt": "2026-11-01T00:00:00.000Z", "status": "ok" },
                "archive": archive_json,
                "files": listing(files),
                "source": source_json,
                "skill": { "name": "pdf", "description": "Fill PDF forms.",
                           "allowedTools": ["Bash", "Read"] },
                "permissions": {}, "risk": "low", "reviewed": true, "advisories": []
            }),
        );
        catalog.resolved.insert(
            revision,
            json!({
                "status": "public", "ref": REF, "kind": "skill",
                "latest": { "revision": revision, "version": format!("1.0.{revision}"), "publishedAt": "p" },
                "advisories": [],
                "installed": {
                    "revision": revision, "status": "ok", "risk": "low", "reviewed": true,
                    "permissions": { "declared": { "tools": ["Bash", "Read"] },
                                     "detected": { "runsCode": ["sh"], "installs": [], "installScripts": [],
                                                   "network": [], "secrets": [], "paths": [], "tools": [] } },
                    "checks": { "findings": { "low": 0, "medium": 0, "high": 0 }, "secrets": 0, "review": "off" },
                    "packages": [],
                    "stateSha256": self.sha(&format!("r{revision}"))
                }
            }),
        );
    }

    /// Change what `/resolve` says of `revision`.
    fn resolve(&self, revision: u64, change: impl FnOnce(&mut Value)) {
        let mut catalog = self.site.catalog.lock().unwrap();
        change(catalog.resolved.get_mut(&revision).unwrap());
    }

    /// Change the install info of `revision` (what a cache may hold).
    fn version(&self, revision: u64, change: impl FnOnce(&mut Value)) {
        let mut catalog = self.site.catalog.lock().unwrap();
        change(catalog.versions.get_mut(&revision).unwrap());
    }

    fn blob(&self, change: impl FnOnce(&mut BTreeMap<String, Vec<u8>>)) {
        change(&mut self.site.catalog.lock().unwrap().blobs);
    }

    async fn plan(&self, revision: Option<u64>) -> HarnessSkillPlan {
        plan(&self.local, &self.harness, REF, revision, None)
            .await
            .unwrap()
    }

    async fn plan_for(&self, agents: &[AgentType]) -> HarnessSkillPlan {
        plan(&self.local, &self.harness, REF, None, Some(agents.to_vec()))
            .await
            .unwrap()
    }

    /// What a dialog would send for `plan`, to the agents its links
    /// preflight covers, under the default name, with every op's `ack`.
    fn request(&self, plan: &HarnessSkillPlan) -> HarnessSkillInstallRequest {
        HarnessSkillInstallRequest {
            item_ref: REF.to_string(),
            revision: plan.item.revision,
            install_name: plan.install_name.default.clone(),
            agents: plan.links.ops.iter().map(|op| op.agent).collect(),
            keep_allowed_tools: false,
            state_sha256: plan.state_sha256.clone().unwrap(),
            acks: plan
                .links
                .ops
                .iter()
                .filter_map(|op| Some((op.agent, op.ack.clone()?)))
                .collect(),
            accept_yanked: false,
        }
    }

    async fn install(&self, request: HarnessSkillInstallRequest) -> HarnessSkillInstallResult {
        install(&self.local, &self.harness, &self.emitter, request)
            .await
            .unwrap()
    }

    /// Plan `revision` (the latest when `None`), then install it as planned.
    async fn install_planned(&self, revision: Option<u64>) -> HarnessSkillInstallResult {
        let plan = self.plan(revision).await;
        let request = self.request(&plan);
        self.install(request).await
    }

    fn listing(&self) -> Vec<InstalledSkill> {
        installed_skills_in(self.ctx()).unwrap()
    }

    async fn uninstall(&self, preflight: bool, ack: Option<String>) -> HarnessSkillUninstallResult {
        uninstall(
            &self.local,
            &self.emitter,
            HarnessSkillUninstallRequest {
                item_id: ID.to_string(),
                preflight,
                ack,
            },
        )
        .await
        .unwrap()
    }

    fn manifest(&self) -> Option<Value> {
        fs::read(skill_manifest::path(&self.ctx().store))
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }

    /// Everything under `rel` (the store by default), by relative path:
    /// a file's hash, `dir`, or `link -> <target>`. Links are not followed.
    fn tree(&self, rel: &str) -> BTreeMap<String, String> {
        fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                let meta = fs::symlink_metadata(&path).unwrap();
                if meta.file_type().is_symlink() {
                    out.insert(
                        rel,
                        format!("link -> {}", fs::read_link(&path).unwrap().display()),
                    );
                } else if meta.is_dir() {
                    out.insert(rel, "dir".to_string());
                    walk(root, &path, out);
                } else {
                    out.insert(rel, sha(&fs::read(&path).unwrap()));
                }
            }
        }
        let root = self.path(rel);
        let mut out = BTreeMap::new();
        walk(&root, &root, &mut out);
        out
    }

    fn store_tree(&self) -> BTreeMap<String, String> {
        self.tree("store")
    }
}

fn codes_of(reasons: &[Reason]) -> Vec<&str> {
    reasons.iter().map(|reason| reason.code.as_str()).collect()
}

pub(crate) fn drain(
    events: &mut tokio::sync::broadcast::Receiver<WebEvent>,
) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    while let Ok(event) = events.try_recv() {
        out.push((event.channel, (*event.payload).clone()));
    }
    out
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap()
}

/// A backup of another skill the user already had: it must survive
/// whatever happens to an install.
fn plant_user_backup(sandbox: &Sandbox) -> PathBuf {
    let backup = sandbox
        .ctx()
        .store
        .join(".user-backups/other/20260101-000000.000");
    fs::create_dir_all(&backup).unwrap();
    fs::write(backup.join("SKILL.md"), "---\nname: other\n---\nmine\n").unwrap();
    backup
}

// ─── The plan ───────────────────────────────────────────────────────────

#[tokio::test]
async fn the_plan_shows_the_package_the_snapshot_the_name_and_the_links() {
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;
    assert_eq!(plan.item.id, ID);
    assert_eq!(plan.item.revision, 3);
    assert!(plan.blocking.is_empty(), "{:?}", plan.blocking);
    assert!(plan.confirm.is_empty());
    assert_eq!(
        plan.state_sha256.as_deref(),
        Some(sandbox.sha("r3").as_str())
    );
    assert_eq!(plan.skill.name, "pdf");
    assert_eq!(
        plan.skill.allowed_tools.as_deref(),
        Some(&["Bash".to_string(), "Read".to_string()][..])
    );
    assert_eq!(codes_of(&plan.warnings), [codes::ALLOWED_TOOLS]);
    assert_eq!(plan.package.files.len(), 3);
    assert!(plan.package.archive.is_some());
    assert_eq!(plan.package.limits.files, 500);
    assert_eq!(plan.install_name.default, NAME);
    assert!(plan.install_name.taken.is_empty());
    assert_eq!(plan.default_agents, INSTALLED.to_vec());
    let defaults: Vec<AgentType> = plan
        .agents
        .iter()
        .filter(|agent| agent.default)
        .map(|agent| agent.agent)
        .collect();
    assert_eq!(defaults, INSTALLED.to_vec());
    // the links, as if the skill were in the store: each into its own
    // directory, nobody else affected, no ack needed
    assert_eq!(plan.links.outcome, ApplyOutcome::Preflight);
    assert!(plan.links.ok);
    for op in &plan.links.ops {
        assert_eq!(op.status, OpStatus::Ready, "{op:?}");
        assert!(op.ack.is_none());
    }
    assert_eq!(
        plan.links.ops[2].creates[0].path,
        sandbox.path("cline/skills/pdf").to_string_lossy()
    );
    assert!(plan.installed.is_none());
    // a plan writes nothing
    assert!(sandbox.store_tree().is_empty());
}

// ─── An install ─────────────────────────────────────────────────────────

#[tokio::test]
async fn an_install_stages_commits_and_links_through_the_engine() {
    let sandbox = Sandbox::new().await;
    let mut events = sandbox.events.subscribe();
    let result = sandbox.install_planned(None).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    assert_eq!(result.name.as_deref(), Some(NAME));
    let links = result.links.as_ref().unwrap();
    assert_eq!(links.outcome, ApplyOutcome::Applied);
    assert!(links.ok);
    assert!(result.links_skipped.is_empty());
    for phase in [
        Phase::Download,
        Phase::Verify,
        Phase::Snapshot,
        Phase::Stage,
        Phase::Swap,
        Phase::Commit,
        Phase::Links,
    ] {
        assert!(
            result
                .phases
                .iter()
                .any(|done| done.phase == phase && done.status == PhaseStatus::Done),
            "{phase:?} in {:?}",
            result.phases
        );
    }

    // the folder, every file as listed but SKILL.md (rewritten), the mode
    let store = sandbox.store(NAME);
    assert_eq!(
        read(&store.join("SKILL.md")),
        "---\nname: pdf\ndescription: Fill PDF forms.\n---\nRevision 3.\n"
    );
    assert_eq!(read(&store.join("reference.md")), "Reference 3\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |rel: &str| fs::metadata(store.join(rel)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode("scripts/run.sh"), 0o755);
        assert_eq!(mode("reference.md"), 0o644);
    }
    // the manifest, in the shape the engine reads
    let manifest = sandbox.manifest().unwrap();
    let entry = &manifest["skills"][NAME];
    assert_eq!(manifest["format"], 1);
    assert_eq!(entry["item_id"], ID);
    assert_eq!(entry["ref"], REF);
    assert_eq!(entry["revision"], 3);
    assert_eq!(entry["version"], "1.0.3");
    assert_eq!(entry["state_sha256"], sandbox.sha("r3"));
    assert_eq!(entry["rewrites"]["allowed_tools"], "removed");
    assert!(entry["rewrites"].get("name").is_none());
    assert_eq!(
        entry["files"]["SKILL.md"],
        sha(read(&store.join("SKILL.md")).as_bytes())
    );
    assert_eq!(entry["files"]["reference.md"], sha(b"Reference 3\n"));
    // no staging left
    assert!(!sandbox.ctx().store.join(".codeg-staging").exists());
    // the links
    for dir in ["claude/skills", "codex/skills", "cline/skills"] {
        let link = sandbox.path(dir).join(NAME);
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "{dir}"
        );
        assert_eq!(read(&link.join("reference.md")), "Reference 3\n");
    }
    assert!(!sandbox.path("agents/skills").join(NAME).exists());

    // the engine calls it Harness's, with its ref and version
    let inventory = crate::skills::world::inventory(sandbox.ctx());
    let skill = inventory.skills.iter().find(|s| s.id == NAME).unwrap();
    assert_eq!(skill.origin, SkillOrigin::Harness);
    let info = skill.harness.as_ref().unwrap();
    assert_eq!(info.item_ref.as_deref(), Some(REF));
    assert_eq!(info.version.as_deref(), Some("1.0.3"));

    // the listing
    let listed = sandbox.listing();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, ID);
    assert_eq!(listed[0].name, NAME);
    assert_eq!(listed[0].state, LocalState::AsInstalled);
    assert_eq!(listed[0].agents, INSTALLED.to_vec());

    // the events
    let seen = drain(&mut events);
    let channels: Vec<&str> = seen.iter().map(|(channel, _)| channel.as_str()).collect();
    assert!(channels.contains(&"skills://changed"), "{channels:?}");
    let installed = seen
        .iter()
        .find(|(channel, _)| channel == INSTALLED_CHANGED_EVENT)
        .expect("harness://installed-changed");
    assert_eq!(installed.1["item_ids"], json!([ID]));
    assert_eq!(
        installed.1["agents"],
        json!(["claude_code", "codex", "cline"])
    );

    // the plan of an installed item says so
    let plan = sandbox.plan(None).await;
    let installed = plan.installed.unwrap();
    assert_eq!(installed.revision, 3);
    assert_eq!(plan.install_name.default, NAME);
    assert_eq!(plan.default_agents, INSTALLED.to_vec());
    assert!(plan.agents.iter().filter(|a| a.default).all(|a| a.sees));
    assert!(plan
        .links
        .ops
        .iter()
        .all(|op| op.status == OpStatus::Unchanged));
}

#[tokio::test]
async fn allowed_tools_are_kept_only_when_asked() {
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;
    let mut request = sandbox.request(&plan);
    request.keep_allowed_tools = true;
    let result = sandbox.install(request).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    assert_eq!(read(&sandbox.store(NAME).join("SKILL.md")), skill_md(3));
    assert_eq!(
        sandbox.manifest().unwrap()["skills"][NAME]["rewrites"]["allowed_tools"],
        "kept"
    );
    assert_eq!(
        result.rewrites.unwrap().allowed_tools,
        Some(AllowedTools::Kept)
    );
}

#[tokio::test]
async fn the_no_archive_path_fetches_each_file_at_the_source_commit() {
    let sandbox = Sandbox::new().await;
    sandbox.publish(4, &package(4), false);
    let plan = sandbox.plan(None).await;
    assert!(plan.package.archive.is_none());
    assert!(codes_of(&plan.warnings).contains(&codes::FETCHED_FROM_SOURCE));
    let result = sandbox.install(sandbox.request(&plan)).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    assert_eq!(
        read(&sandbox.store(NAME).join("reference.md")),
        "Reference 4\n"
    );
    let raw: Vec<String> = sandbox
        .raw
        .seen()
        .into_iter()
        .map(|(_, path)| path)
        .collect();
    for file in ["SKILL.md", "scripts/run.sh", "reference.md"] {
        assert!(
            raw.contains(&format!("/acme/skills/{COMMIT}/pdf/{file}")),
            "{raw:?}"
        );
    }
    assert!(!sandbox
        .site
        .seen()
        .iter()
        .any(|(_, path)| path.contains("/archives/")));
    let entry = &sandbox.manifest().unwrap()["skills"][NAME];
    assert!(entry["archive_sha256"].is_null());
    assert_eq!(entry["source"]["commit"], COMMIT);

    // a file the source host does not have, or one that is not what is
    // listed: nothing changes
    let other = Sandbox::new().await;
    other.publish(4, &package(4), false);
    other
        .raw
        .catalog
        .lock()
        .unwrap()
        .blobs
        .remove(&format!("/acme/skills/{COMMIT}/pdf/reference.md"));
    let result = other.install_planned(None).await;
    assert_eq!(result.outcome, InstallOutcome::InvalidPackage);
    assert_eq!(codes_of(&result.issues), [codes::SOURCE_FILE_UNAVAILABLE]);
    other.raw.catalog.lock().unwrap().blobs.insert(
        format!("/acme/skills/{COMMIT}/pdf/reference.md"),
        b"Reference 5\n".to_vec(),
    );
    let result = other.install_planned(None).await;
    assert_eq!(result.outcome, InstallOutcome::InvalidPackage);
    assert_eq!(codes_of(&result.issues), [codes::FILE_HASH_MISMATCH]);
    assert!(other.store_tree().is_empty(), "{:?}", other.store_tree());
}

// ─── A package that is not what it says ─────────────────────────────────

#[tokio::test]
async fn a_package_that_is_not_what_it_says_leaves_nothing_in_the_store() {
    let sandbox = Sandbox::new().await;
    let backup = plant_user_backup(&sandbox);
    let before = sandbox.store_tree();
    let archive_url = |sandbox: &Sandbox| -> String {
        sandbox.site.catalog.lock().unwrap().versions[&3]["archive"]["url"]
            .as_str()
            .unwrap()
            .to_string()
    };

    // the archive's bytes are not the ones hashed
    let url = archive_url(&sandbox);
    sandbox.blob(|blobs| {
        let bytes = blobs.get_mut(&url).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
    });
    let result = sandbox.install_planned(None).await;
    assert_eq!(result.outcome, InstallOutcome::InvalidPackage);
    assert_eq!(codes_of(&result.issues), [codes::ARCHIVE_HASH_MISMATCH]);
    assert_eq!(sandbox.store_tree(), before);

    // a zip that holds another file than listed, one fewer, one more, a
    // file whose hash or size is not the listed one: each refused
    let cases: Vec<(&str, Vec<File>, &str)> = vec![
        (
            "missing",
            package(3)
                .into_iter()
                .filter(|f| f.path != "reference.md")
                .collect(),
            codes::FILE_MISSING,
        ),
        (
            "extra",
            {
                let mut files = package(3);
                files.push(file("extra.sh", "rm -rf ~\n", true));
                files
            },
            codes::FILE_UNEXPECTED,
        ),
        (
            "hash",
            {
                let mut files = package(3);
                files[2].bytes = b"Reference X\n".to_vec();
                files
            },
            codes::FILE_HASH_MISMATCH,
        ),
        (
            "size",
            {
                let mut files = package(3);
                files[2].bytes = b"Reference 3 and more\n".to_vec();
                files
            },
            codes::FILE_SIZE_MISMATCH,
        ),
    ];
    for (what, zipped, code) in cases {
        let zip = zip_of(&zipped);
        let zip_sha = sha(&zip);
        let url = format!("/api/harness/v1/archives/{zip_sha}.zip");
        sandbox.blob(|blobs| {
            blobs.insert(url.clone(), zip.clone());
        });
        // the listing stays revision 3's: the archive does not match it
        sandbox.version(3, |version| {
            version["archive"] = json!({ "url": url, "sha256": zip_sha, "size": zip.len() });
        });
        let result = sandbox.install_planned(None).await;
        assert_eq!(result.outcome, InstallOutcome::InvalidPackage, "{what}");
        assert!(
            codes_of(&result.issues).contains(&code),
            "{what}: {:?}",
            result.issues
        );
        assert_eq!(sandbox.store_tree(), before, "{what}");
    }

    // over a limit (`/config`'s): the plan says so, the install refuses
    // before anything is fetched
    sandbox.site.catalog.lock().unwrap().config = json!({ "limits": { "fileBytes": 10 } });
    let plan = sandbox.plan(None).await;
    assert!(
        codes_of(&plan.blocking).contains(&codes::FILE_TOO_LARGE),
        "{:?}",
        plan.blocking
    );
    let fetched = sandbox.site.seen().len();
    let result = sandbox.install(sandbox.request(&plan)).await;
    assert_eq!(result.outcome, InstallOutcome::InvalidPackage);
    assert!(codes_of(&result.issues).contains(&codes::FILE_TOO_LARGE));
    assert!(!sandbox.site.seen()[fetched..]
        .iter()
        .any(|(_, path)| path.contains("/archives/")));
    sandbox.site.catalog.lock().unwrap().config = json!({ "limits": { "files": 2 } });
    let result = sandbox.install_planned(None).await;
    assert!(codes_of(&result.issues).contains(&codes::TOO_MANY_FILES));
    sandbox.site.catalog.lock().unwrap().config =
        json!({ "limits": { "compression": { "minBytes": 1, "ratio": 1 } } });
    sandbox.publish(
        5,
        &[file(
            "SKILL.md",
            &format!("---\nname: pdf\n---\n{}", "a".repeat(4000)),
            false,
        )],
        true,
    );
    let result = sandbox.install_planned(Some(5)).await;
    assert_eq!(result.outcome, InstallOutcome::InvalidPackage);
    assert_eq!(codes_of(&result.issues), [codes::COMPRESSION_RATIO]);
    sandbox.site.catalog.lock().unwrap().config = json!({});

    // path tricks in the listing: refused before anything is fetched
    for (path, code) in [
        ("../escape.md", codes::UNSAFE_PATH),
        ("/etc/passwd", codes::UNSAFE_PATH),
        ("a\\b.md", codes::UNSAFE_PATH),
        ("C:evil", codes::UNSAFE_PATH),
        ("dir/./x.md", codes::UNSAFE_PATH),
        ("dir//x.md", codes::UNSAFE_PATH),
        ("Reference.MD", codes::DUPLICATE_PATH),
        ("reference.md/inner", codes::DUPLICATE_PATH),
    ] {
        sandbox.publish(3, &package(3), true);
        sandbox.version(3, |version| {
            version["files"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "path": path, "sha256": sha(b"x"), "size": 1, "executable": false }));
        });
        let plan = sandbox.plan(Some(3)).await;
        assert!(
            codes_of(&plan.blocking).contains(&code),
            "{path}: {:?}",
            plan.blocking
        );
        let result = sandbox.install(sandbox.request(&plan)).await;
        assert_eq!(result.outcome, InstallOutcome::InvalidPackage, "{path}");
        assert!(codes_of(&result.issues).contains(&code), "{path}");
        assert_eq!(sandbox.store_tree(), before, "{path}");
    }
    // an archive address that is not on the catalog's origin
    sandbox.publish(3, &package(3), true);
    sandbox.version(3, |version| {
        version["archive"]["url"] = json!("https://elsewhere.example/a.zip");
    });
    let result = sandbox.install_planned(Some(3)).await;
    assert_eq!(codes_of(&result.issues), [codes::ARCHIVE_ADDRESS_INVALID]);
    assert_eq!(sandbox.store_tree(), before);
    assert!(backup.join("SKILL.md").is_file());
}

#[test]
fn an_archive_with_a_link_in_it_is_refused() {
    let mut out = io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut out);
        zip.add_symlink(
            "SKILL.md",
            "/etc/passwd",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.finish().unwrap();
    }
    let files = vec![crate::harness::types::FileEntry {
        path: "SKILL.md".into(),
        sha256: sha(b"/etc/passwd"),
        size: 11,
        executable: false,
    }];
    let issues =
        package::extract(&out.into_inner(), &files, &package::default_limits()).unwrap_err();
    assert!(
        codes_of(&issues).contains(&codes::LINK_IN_ARCHIVE),
        "{issues:?}"
    );
}

// ─── The install name ───────────────────────────────────────────────────

#[tokio::test]
async fn the_install_name_steps_around_whatever_holds_it() {
    // a Custom skill of the user's
    let sandbox = Sandbox::new().await;
    fs::create_dir_all(sandbox.store(NAME)).unwrap();
    fs::write(
        sandbox.store(NAME).join("SKILL.md"),
        "---\nname: pdf\n---\nmine\n",
    )
    .unwrap();
    let plan = sandbox.plan(None).await;
    assert_eq!(plan.install_name.default, "pdf-acme-dev");
    assert_eq!(plan.install_name.taken[0].by, TakenBy::Custom);
    let result = sandbox.install(sandbox.request(&plan)).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    // SKILL.md's name follows the install name, and that is recorded
    assert!(read(&sandbox.store("pdf-acme-dev").join("SKILL.md"))
        .starts_with("---\nname: pdf-acme-dev\n"));
    let rewrites = &sandbox.manifest().unwrap()["skills"]["pdf-acme-dev"]["rewrites"];
    assert_eq!(
        rewrites["name"],
        json!({ "from": "pdf", "to": "pdf-acme-dev" })
    );
    // the user's skill is untouched, and still theirs
    assert_eq!(
        read(&sandbox.store(NAME).join("SKILL.md")),
        "---\nname: pdf\n---\nmine\n"
    );
    let inventory = crate::skills::world::inventory(sandbox.ctx());
    let origin = |id: &str| inventory.skills.iter().find(|s| s.id == id).unwrap().origin;
    assert_eq!(origin(NAME), SkillOrigin::Custom);
    assert_eq!(origin("pdf-acme-dev"), SkillOrigin::Harness);
    // a name another holder has is refused, whoever asks for it
    let mut request = sandbox.request(&plan);
    request.install_name = NAME.to_string();
    let result = sandbox.install(request).await;
    assert_eq!(result.outcome, InstallOutcome::Refused);
    assert_eq!(
        codes_of(&result.issues),
        [codes::INSTALLED_UNDER_OTHER_NAME]
    );

    // a pack's id
    let sandbox = Sandbox::new().await;
    let pack_id = crate::commands::experts::bundled_ids().remove(0);
    sandbox.version(3, |version| {
        version["skill"]["name"] = json!(pack_id.clone())
    });
    let plan = sandbox.plan(None).await;
    assert_eq!(plan.install_name.taken[0].by, TakenBy::Reserved);
    assert_eq!(plan.install_name.default, format!("{pack_id}-acme-dev"));
    let mut request = sandbox.request(&plan);
    request.install_name = pack_id.clone();
    let result = sandbox.install(request).await;
    assert_eq!(codes_of(&result.issues), [codes::NAME_RESERVED]);
    let mut request = sandbox.request(&plan);
    request.install_name = "Not_A-Name".to_string();
    let result = sandbox.install(request).await;
    assert_eq!(codes_of(&result.issues), [codes::NAME_INVALID]);

    // another Harness item; then its `<name>-<publisher>` too, so a number
    let sandbox = Sandbox::new().await;
    let mut manifest = skill_manifest::load(&sandbox.ctx().store).unwrap();
    for name in [NAME, "pdf-acme-dev"] {
        manifest.skills.insert(
            name.to_string(),
            ManifestEntry {
                item_id: format!("other-{name}"),
                item_ref: "other/pdf".into(),
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
    }
    skill_manifest::save(&sandbox.ctx().store, &manifest).unwrap();
    let plan = sandbox.plan(None).await;
    assert_eq!(plan.install_name.default, "pdf-acme-dev-2");
    assert!(plan
        .install_name
        .taken
        .iter()
        .all(|t| t.by == TakenBy::Harness));
    assert_eq!(
        plan.install_name.taken[0].item_ref.as_deref(),
        Some("other/pdf")
    );

    // a folder of that name in a target agent's directory
    let sandbox = Sandbox::new().await;
    fs::create_dir_all(sandbox.path("claude/skills/pdf")).unwrap();
    let plan = sandbox.plan(None).await;
    assert_eq!(plan.install_name.default, "pdf-acme-dev");
    let held = &plan.install_name.taken[0];
    assert_eq!(held.by, TakenBy::AgentDir);
    assert_eq!(held.agents, [AgentType::ClaudeCode]);
    // ... which a name the user insists on keeps: that agent's link is
    // refused, the others are made
    let mut request = sandbox.request(&plan);
    request.install_name = NAME.to_string();
    let result = sandbox.install(request).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    assert_eq!(result.links_skipped.len(), 1);
    assert_eq!(result.links_skipped[0].agent, AgentType::ClaudeCode);
    assert!(fs::symlink_metadata(sandbox.path("claude/skills/pdf"))
        .unwrap()
        .is_dir());
    assert!(fs::symlink_metadata(sandbox.path("codex/skills/pdf"))
        .unwrap()
        .file_type()
        .is_symlink());

    // a link of Codeg's under the name that would come back to life
    let sandbox = Sandbox::new().await;
    fs::create_dir_all(sandbox.path("gemini/skills")).unwrap();
    platform_link(&sandbox.store(NAME), &sandbox.path("gemini/skills/pdf")).unwrap();
    let plan = sandbox.plan(None).await;
    assert_eq!(plan.install_name.default, "pdf-acme-dev");
    assert_eq!(plan.install_name.taken[0].by, TakenBy::CodegLink);
    let mut request = sandbox.request(&plan);
    request.install_name = NAME.to_string();
    let result = sandbox.install(request).await;
    assert_eq!(result.outcome, InstallOutcome::Refused);
    assert_eq!(codes_of(&result.issues), [codes::NAME_TAKEN]);
    assert_eq!(result.issues[0].params["by"], "codeg_link");
}

// ─── Links that reach other agents ──────────────────────────────────────

#[tokio::test]
async fn links_that_reach_other_agents_install_only_with_their_ack() {
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan_for(&[shared_only()]).await;
    let op = &plan.links.ops[0];
    assert_eq!(op.status, OpStatus::NeedsAck);
    assert_eq!(
        op.gains,
        [AgentType::Codex, AgentType::Gemini, AgentType::Cline]
    );
    let ack = op.ack.clone().unwrap();
    // without it: nothing written, the effects again
    let mut request = sandbox.request(&plan);
    request.acks.clear();
    let result = sandbox.install(request).await;
    assert_eq!(result.outcome, InstallOutcome::AcknowledgementRequired);
    assert_eq!(codes_of(&result.issues), [codes::ACKNOWLEDGEMENT_REQUIRED]);
    assert_eq!(
        result.links.unwrap().ops[0].ack.as_deref(),
        Some(ack.as_str())
    );
    assert!(sandbox.store_tree().is_empty());
    // with a stale one
    let mut request = sandbox.request(&plan);
    request.acks.insert(shared_only(), "stale".into());
    let result = sandbox.install(request).await;
    assert_eq!(codes_of(&result.issues), [codes::EFFECTS_CHANGED]);
    assert!(sandbox.store_tree().is_empty());
    // with it
    let result = sandbox.install(sandbox.request(&plan)).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    assert!(fs::symlink_metadata(sandbox.path("agents/skills/pdf"))
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        sandbox.listing()[0].agents,
        [
            AgentType::Codex,
            AgentType::Gemini,
            AgentType::Cline,
            shared_only()
        ]
    );
}

// ─── The snapshot between the plan and the commit ───────────────────────

#[tokio::test]
async fn a_snapshot_that_changed_is_listed_or_aborts_and_nothing_is_committed() {
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;
    let request = sandbox.request(&plan);

    // risk, permissions, an install script: confirm again
    let new_sha = sandbox.sha("r3-changed");
    sandbox.resolve(3, |item| {
        let state = &mut item["installed"];
        state["risk"] = json!("high");
        state["permissions"]["detected"]["network"] = json!(["evil.example"]);
        state["packages"] = json!([{ "registryType": "npm", "identifier": "helper", "version": "1.0.0",
                                     "verified": "ok", "hasInstallScript": true }]);
        state["stateSha256"] = json!(new_sha);
    });
    let result = sandbox.install(request.clone()).await;
    assert_eq!(result.outcome, InstallOutcome::StateChanged);
    let changes = codes_of(&result.changes);
    for code in [
        shared::RISK_CHANGED,
        shared::PERMISSION_ADDED,
        shared::PACKAGE_ADDED,
    ] {
        assert!(changes.contains(&code), "{changes:?}");
    }
    assert_eq!(result.state_sha256.as_deref(), Some(new_sha.as_str()));
    assert!(sandbox.store_tree().is_empty());
    // confirmed with the new fingerprint: installed
    let mut confirmed = request.clone();
    confirmed.state_sha256 = new_sha.clone();
    // ... unless the package lost its verification meanwhile (pending →
    // missing, the status and risk the same)
    let missing_sha = sandbox.sha("r3-missing");
    sandbox.resolve(3, |item| {
        item["installed"]["packages"][0]["verified"] = json!("missing");
        item["installed"]["stateSha256"] = json!(missing_sha);
    });
    let result = sandbox.install(confirmed.clone()).await;
    assert_eq!(result.outcome, InstallOutcome::Aborted);
    assert_eq!(codes_of(&result.issues), [shared::PACKAGE_MISSING]);
    assert!(sandbox.store_tree().is_empty());

    // blocked after the plan: aborted, nothing written
    sandbox.resolve(3, |item| {
        item["installed"]["packages"] = json!([]);
        item["installed"]["status"] = json!("blocked");
    });
    let result = sandbox.install(request.clone()).await;
    assert_eq!(result.outcome, InstallOutcome::Aborted);
    assert_eq!(codes_of(&result.issues), [shared::VERSION_BLOCKED]);
    assert!(sandbox.store_tree().is_empty());

    // taken down by Harness
    sandbox.resolve(
        3,
        |item| {
            *item =
                json!({ "status": "removed", "installed": { "revision": 3, "status": "blocked" } })
        },
    );
    let result = sandbox.install(request).await;
    assert_eq!(result.outcome, InstallOutcome::Aborted);
    assert_eq!(codes_of(&result.issues), [shared::ITEM_UNAVAILABLE]);
    assert!(sandbox.store_tree().is_empty());
}

/// Status and risk the same; only a package's verification and its install
/// script change after the dialog opened: still found, and confirmed again.
#[tokio::test]
async fn a_change_in_package_verification_alone_is_found_before_the_commit() {
    let sandbox = Sandbox::new().await;
    sandbox.resolve(3, |item| {
        item["installed"]["packages"] = json!([{ "registryType": "pypi", "identifier": "pdfplumber",
                                                 "version": "0.11.4", "verified": "ok",
                                                 "hasInstallScript": false }]);
    });
    let plan = sandbox.plan(None).await;
    assert!(plan.blocking.is_empty(), "{:?}", plan.blocking);
    let changed_sha = sandbox.sha("r3-pending");
    sandbox.resolve(3, |item| {
        item["installed"]["packages"][0]["verified"] = json!("pending");
        item["installed"]["packages"][0]["hasInstallScript"] = json!(true);
        item["installed"]["stateSha256"] = json!(changed_sha);
    });
    let result = sandbox.install(sandbox.request(&plan)).await;
    assert_eq!(result.outcome, InstallOutcome::StateChanged);
    assert_eq!(
        codes_of(&result.changes),
        [shared::VERIFICATION_CHANGED, shared::INSTALL_SCRIPT_ADDED]
    );
    assert!(sandbox.store_tree().is_empty());
    // confirmed again: installed, with the new fingerprint recorded
    let mut request = sandbox.request(&plan);
    request.state_sha256 = changed_sha.clone();
    let result = sandbox.install(request).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    assert_eq!(sandbox.listing()[0].state_sha256, changed_sha);
}

/// The last snapshot is read once the package is staged and journaled,
/// with the skills lock held: nothing but the swap and the commit come
/// after it.
#[tokio::test]
async fn the_last_snapshot_is_read_with_the_package_staged_and_the_lock_held() {
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;
    let store = sandbox.ctx().store.clone();
    let mut other = sandbox.ctx().clone();
    other.lock_wait = std::time::Duration::from_millis(50);
    let seen: Arc<Mutex<Option<(usize, bool)>>> = Arc::default();
    let seen_there = seen.clone();
    sandbox.site.catalog.lock().unwrap().on_resolve = Some(Box::new(move || {
        let journals = fs::read_dir(store.join(".codeg-staging"))
            .map(|dirs| {
                dirs.flatten()
                    .filter(|dir| {
                        dir.path().join("op.json").is_file()
                            && dir.path().join("new/SKILL.md").is_file()
                    })
                    .count()
            })
            .unwrap_or(0);
        let locked = other.lock_blocking().is_err();
        *seen_there.lock().unwrap() = Some((journals, locked));
    }));
    let result = sandbox.install(sandbox.request(&plan)).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    assert_eq!(*seen.lock().unwrap(), Some((1, true)));
    let order: Vec<Phase> = result.phases.iter().map(|done| done.phase).collect();
    let at = |phase: Phase| order.iter().position(|p| *p == phase).unwrap();
    assert!(at(Phase::Verify) < at(Phase::Stage));
    assert!(at(Phase::Stage) < at(Phase::Snapshot));
    assert!(at(Phase::Snapshot) < at(Phase::Swap));

    // a snapshot that stops it there: the staging goes, nothing else moved
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;
    sandbox.resolve(3, |item| item["installed"]["status"] = json!("blocked"));
    let result = sandbox.install(sandbox.request(&plan)).await;
    assert_eq!(result.outcome, InstallOutcome::Aborted);
    assert!(result
        .phases
        .iter()
        .any(|done| done.phase == Phase::Stage && done.status == PhaseStatus::RolledBack));
    assert!(
        sandbox.store_tree().is_empty(),
        "{:?}",
        sandbox.store_tree()
    );
}

#[tokio::test]
async fn a_cached_ok_is_never_trusted_over_the_snapshot() {
    // the install info (which a cache may hold) says ok; /resolve says
    // blocked: the plan blocks and the install aborts
    let sandbox = Sandbox::new().await;
    sandbox.resolve(3, |item| item["installed"]["status"] = json!("blocked"));
    let plan = sandbox.plan(None).await;
    assert_eq!(codes_of(&plan.blocking), [shared::VERSION_BLOCKED]);
    let result = sandbox.install(sandbox.request(&plan)).await;
    assert_eq!(result.outcome, InstallOutcome::Aborted);
    assert!(sandbox.store_tree().is_empty());

    // yanked: to be confirmed in so many words
    let sandbox = Sandbox::new().await;
    sandbox.resolve(3, |item| item["installed"]["status"] = json!("yanked"));
    let plan = sandbox.plan(None).await;
    assert!(plan.blocking.is_empty());
    assert_eq!(codes_of(&plan.confirm), [shared::YANKED]);
    let result = sandbox.install(sandbox.request(&plan)).await;
    assert_eq!(result.outcome, InstallOutcome::Refused);
    assert_eq!(codes_of(&result.issues), [shared::YANKED_NOT_ACCEPTED]);
    assert!(sandbox.store_tree().is_empty());
    let mut request = sandbox.request(&plan);
    request.accept_yanked = true;
    let result = sandbox.install(request).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");

    // a package without an exact version cannot be installed
    let sandbox = Sandbox::new().await;
    sandbox.resolve(3, |item| {
        item["installed"]["packages"] = json!([{ "registryType": "pypi", "identifier": "pdfplumber",
                                                 "version": "latest", "verified": "pending",
                                                 "hasInstallScript": false }]);
    });
    let plan = sandbox.plan(None).await;
    assert_eq!(codes_of(&plan.blocking), [shared::PACKAGE_VERSION_INEXACT]);
}

// ─── Updates ────────────────────────────────────────────────────────────

#[tokio::test]
async fn an_update_over_changed_files_keeps_them_among_the_backups() {
    let sandbox = Sandbox::new().await;
    let backup = plant_user_backup(&sandbox);
    assert_eq!(
        sandbox.install_planned(None).await.outcome,
        InstallOutcome::Installed
    );
    fs::write(sandbox.store(NAME).join("reference.md"), "my notes\n").unwrap();
    fs::write(sandbox.store(NAME).join("mine.md"), "added\n").unwrap();
    // what Python leaves behind is not a change
    fs::create_dir_all(sandbox.store(NAME).join("scripts/__pycache__")).unwrap();
    fs::write(sandbox.store(NAME).join("scripts/__pycache__/x.pyc"), "x").unwrap();
    let listed = sandbox.listing();
    assert_eq!(listed[0].state, LocalState::ChangedLocally);
    assert_eq!(listed[0].files.changed, ["reference.md"]);
    assert_eq!(listed[0].files.added, ["mine.md"]);

    sandbox.publish(4, &package(4), true);
    let plan = sandbox.plan(None).await;
    assert_eq!(plan.item.revision, 4);
    assert_eq!(plan.installed.as_ref().unwrap().revision, 3);
    assert!(codes_of(&plan.warnings).contains(&codes::FILES_CHANGED_LOCALLY));
    let result = sandbox.install(sandbox.request(&plan)).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    let kept = PathBuf::from(result.backup.expect("a backup"));
    assert!(kept.starts_with(sandbox.ctx().store.join(".user-backups").join(NAME)));
    assert_eq!(read(&kept.join("reference.md")), "my notes\n");
    assert_eq!(read(&kept.join("mine.md")), "added\n");
    assert_eq!(
        read(&sandbox.store(NAME).join("reference.md")),
        "Reference 4\n"
    );
    assert!(!sandbox.store(NAME).join("mine.md").exists());
    let entry = &sandbox.manifest().unwrap()["skills"][NAME];
    assert_eq!(entry["revision"], 4);
    assert_eq!(sandbox.listing()[0].state, LocalState::AsInstalled);
    // the links still lead to it
    assert_eq!(
        read(&sandbox.path("claude/skills/pdf/reference.md")),
        "Reference 4\n"
    );
    assert!(backup.join("SKILL.md").is_file());
    // the engine lists the backup under the skill
    let backups = crate::skills::backups::list(sandbox.ctx(), Some(NAME));
    assert_eq!(backups.backups.len(), 1);

    // an update of unchanged files keeps nothing
    sandbox.publish(5, &package(5), true);
    let result = sandbox.install_planned(None).await;
    assert_eq!(result.outcome, InstallOutcome::Installed);
    assert!(result.backup.is_none());
    assert_eq!(
        crate::skills::backups::list(sandbox.ctx(), Some(NAME))
            .backups
            .len(),
        1
    );
}

#[tokio::test]
async fn an_update_refreshes_codegs_copies_and_never_a_changed_one() {
    let sandbox = Sandbox::with_linker(Arc::new(FailingJunction)).await;
    let result = sandbox.install_planned(None).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    // where no link can be made, the engine copies
    let claude = sandbox.path("claude/skills/pdf");
    let codex = sandbox.path("codex/skills/pdf");
    assert!(fs::symlink_metadata(&claude).unwrap().is_dir());
    assert_eq!(read(&claude.join("reference.md")), "Reference 3\n");
    // the user changes Codex's copy
    fs::write(codex.join("reference.md"), "codex's own\n").unwrap();

    sandbox.publish(4, &package(4), true);
    let result = sandbox.install_planned(None).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    let copies = result.copies.unwrap();
    assert!(copies
        .refreshed
        .contains(&claude.to_string_lossy().into_owned()));
    assert_eq!(copies.kept_changed, [codex.to_string_lossy().into_owned()]);
    assert!(copies.problems.is_empty());
    assert_eq!(read(&claude.join("reference.md")), "Reference 4\n");
    assert_eq!(read(&codex.join("reference.md")), "codex's own\n");
}

// ─── Failures and crashes ───────────────────────────────────────────────

/// A first install and an update of a folder the user changed, each made
/// to fail at every step of the commit: everything is as it was.
#[tokio::test]
async fn a_failure_at_any_step_of_the_commit_puts_everything_back() {
    for point in [
        "harness_stage",
        "harness_journal",
        "harness_swap_in",
        "harness_commit",
    ] {
        let sandbox = Sandbox::new().await;
        let backup = plant_user_backup(&sandbox);
        let before = sandbox.store_tree();
        sandbox.ctx().arm_fault(point);
        let result = sandbox.install_planned(None).await;
        assert_eq!(result.outcome, InstallOutcome::WriteFailed, "{point}");
        assert!(result.kept.is_empty(), "{point}: {:?}", result.kept);
        assert_eq!(sandbox.store_tree(), before, "{point}");
        assert!(!sandbox.path("claude/skills/pdf").exists(), "{point}");
        assert!(backup.join("SKILL.md").is_file());
    }
    for point in [
        "harness_stage",
        "harness_journal",
        "harness_swap_out",
        "harness_swap_in",
        "harness_commit",
    ] {
        let sandbox = Sandbox::new().await;
        assert_eq!(
            sandbox.install_planned(None).await.outcome,
            InstallOutcome::Installed
        );
        fs::write(sandbox.store(NAME).join("reference.md"), "my notes\n").unwrap();
        let backup = plant_user_backup(&sandbox);
        let before = sandbox.store_tree();
        sandbox.publish(4, &package(4), true);
        sandbox.ctx().arm_fault(point);
        let result = sandbox.install_planned(None).await;
        assert_eq!(result.outcome, InstallOutcome::WriteFailed, "{point}");
        assert_eq!(sandbox.store_tree(), before, "{point}");
        assert_eq!(sandbox.manifest().unwrap()["skills"][NAME]["revision"], 3);
        assert_eq!(
            read(&sandbox.path("claude/skills/pdf/reference.md")),
            "my notes\n"
        );
        assert!(backup.join("SKILL.md").is_file());
    }
    // a rollback that fails too deletes nothing: the next start finishes it
    let sandbox = Sandbox::new().await;
    assert_eq!(
        sandbox.install_planned(None).await.outcome,
        InstallOutcome::Installed
    );
    fs::write(sandbox.store(NAME).join("reference.md"), "my notes\n").unwrap();
    let before = sandbox.store_tree();
    sandbox.publish(4, &package(4), true);
    sandbox.ctx().arm_fault("harness_commit");
    sandbox.ctx().arm_fault("harness_rollback");
    let result = sandbox.install_planned(None).await;
    assert_eq!(result.outcome, InstallOutcome::WriteFailed);
    assert!(codes_of(&result.issues).contains(&codes::ROLLBACK_FAILED));
    assert!(!result.kept.is_empty());
    sandbox.ctx().disarm_faults();
    let report = recover_journals(sandbox.ctx());
    assert_eq!(report.rolled_back, 1, "{report:?}");
    crate::skills::startup::clear_store_staging(sandbox.ctx());
    assert_eq!(sandbox.store_tree(), before);

    // a cleanup that fails after the commit: installed; the next start
    // finishes the cleaning (and keeps the changed folder)
    let sandbox = Sandbox::new().await;
    assert_eq!(
        sandbox.install_planned(None).await.outcome,
        InstallOutcome::Installed
    );
    fs::write(sandbox.store(NAME).join("reference.md"), "my notes\n").unwrap();
    sandbox.publish(4, &package(4), true);
    sandbox.ctx().arm_fault("harness_cleanup");
    let result = sandbox.install_planned(None).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    assert!(result
        .phases
        .iter()
        .any(|p| p.phase == Phase::Cleanup && p.status == PhaseStatus::Failed));
    assert!(result.backup.is_none());
    sandbox.ctx().disarm_faults();
    let report = recover_journals(sandbox.ctx());
    assert_eq!(report.finished, 1, "{report:?}");
    assert!(!sandbox.ctx().store.join(".codeg-staging").exists());
    let backups = crate::skills::backups::list(sandbox.ctx(), Some(NAME)).backups;
    assert_eq!(backups.len(), 1);
    assert_eq!(
        read(&PathBuf::from(&backups[0].path).join("reference.md")),
        "my notes\n"
    );
}

/// The steps of a commit, driven one by one as the install drives them,
/// stopped after `steps` of them — a crash there.
fn crash_after(sandbox: &Sandbox, revision: u64, steps: usize) -> PathBuf {
    let ctx = sandbox.ctx();
    let manifest = skill_manifest::load(&ctx.store).unwrap();
    let before = manifest.skills.get(NAME).cloned();
    let live = ctx.skill_path(NAME);
    let had_old = live.exists();
    let keep_old = before.as_ref().is_some_and(|entry| {
        file_changes(&live, entry).is_ok_and(|c| !c.changed.is_empty() || !c.added.is_empty())
    });
    let action = if before.is_some() {
        Action::Update
    } else {
        Action::Install
    };
    let journal = new_journal(action, NAME, ID, before, None, had_old, keep_old);
    let mut tx = Tx::begin(ctx, journal).unwrap();
    let files: Vec<PackageFile> = package(revision)
        .into_iter()
        .map(|file| PackageFile {
            path: file.path,
            bytes: file.bytes,
            executable: file.executable,
        })
        .collect();
    let dir = tx.dir.clone();
    if steps == 0 {
        return dir;
    }
    tx.journal.new_hash = Some(tx.stage(&files).unwrap());
    tx.journal.after = Some(ManifestEntry {
        item_id: ID.into(),
        item_ref: REF.into(),
        revision,
        version: Some(format!("1.0.{revision}")),
        archive_sha256: None,
        source: None,
        files: files
            .iter()
            .map(|f| (f.path.clone(), sha(&f.bytes)))
            .collect(),
        rewrites: Rewrites::default(),
        state_sha256: String::new(),
        installed_at: String::new(),
        op: tx.journal.op.clone(),
        plugin: None,
        extra: serde_json::Map::new(),
    });
    if steps == 1 {
        return dir;
    }
    tx.write_journal().unwrap();
    if steps == 2 {
        return dir;
    }
    tx.swap().unwrap();
    if steps == 3 {
        return dir;
    }
    tx.commit().unwrap();
    if steps == 4 {
        return dir;
    }
    unreachable!()
}

#[tokio::test]
async fn a_crash_at_any_point_is_finished_or_undone_at_the_next_start() {
    // a first install
    for steps in 0..=4 {
        let sandbox = Sandbox::new().await;
        let backup = plant_user_backup(&sandbox);
        let before = sandbox.store_tree();
        crash_after(&sandbox, 3, steps);
        let report = recover_journals(sandbox.ctx());
        crate::skills::startup::clear_store_staging(sandbox.ctx());
        assert!(report.problems.is_empty(), "{steps}: {report:?}");
        assert!(
            !sandbox.ctx().store.join(".codeg-staging").exists(),
            "{steps}"
        );
        if steps == 4 {
            // committed: it is installed, and the manifest says so
            assert_eq!(report.finished, 1);
            assert_eq!(sandbox.manifest().unwrap()["skills"][NAME]["revision"], 3);
            assert_eq!(
                read(&sandbox.store(NAME).join("reference.md")),
                "Reference 3\n"
            );
            assert_eq!(sandbox.listing()[0].state, LocalState::AsInstalled);
        } else {
            assert_eq!(sandbox.store_tree(), before, "{steps}");
        }
        assert!(backup.join("SKILL.md").is_file());
    }
    // an update over a changed folder
    for steps in 0..=4 {
        let sandbox = Sandbox::new().await;
        assert_eq!(
            sandbox.install_planned(None).await.outcome,
            InstallOutcome::Installed
        );
        fs::write(sandbox.store(NAME).join("reference.md"), "my notes\n").unwrap();
        let backup = plant_user_backup(&sandbox);
        let before = sandbox.store_tree();
        crash_after(&sandbox, 4, steps);
        let report = recover_journals(sandbox.ctx());
        crate::skills::startup::clear_store_staging(sandbox.ctx());
        assert!(report.problems.is_empty(), "{steps}: {report:?}");
        let listed = sandbox.listing();
        if steps == 4 {
            assert_eq!(listed[0].revision, 4);
            assert_eq!(listed[0].state, LocalState::AsInstalled);
            let kept = crate::skills::backups::list(sandbox.ctx(), Some(NAME)).backups;
            assert_eq!(kept.len(), 1, "{steps}");
            assert_eq!(
                read(&PathBuf::from(&kept[0].path).join("reference.md")),
                "my notes\n"
            );
        } else {
            assert_eq!(sandbox.store_tree(), before, "{steps}");
            assert_eq!(listed[0].revision, 3);
            assert_eq!(listed[0].state, LocalState::ChangedLocally);
        }
        assert!(backup.join("SKILL.md").is_file());
    }
}

#[tokio::test]
async fn the_engines_startup_finishes_journals_before_it_clears_staging() {
    let sandbox = Sandbox::new().await;
    // a journal, swapped and committed but not cleaned
    crash_after(&sandbox, 3, 4);
    // staging without a journal: cleared
    let stray = sandbox.ctx().store.join(".codeg-staging/stray/new");
    fs::create_dir_all(&stray).unwrap();
    fs::write(stray.join("x"), "x").unwrap();
    let report = crate::skills::startup::run_blocking(
        sandbox.ctx(),
        &crate::harness::plugins::PluginsCtx::at(&sandbox.path("codeg")),
    );
    assert!(
        !report.problems.iter().any(|p| p.contains("journal")),
        "{:?}",
        report.problems
    );
    assert!(!sandbox.ctx().store.join(".codeg-staging").exists());
    assert_eq!(sandbox.listing()[0].state, LocalState::AsInstalled);

    // and one rolled back: swapped in, not committed
    let sandbox = Sandbox::new().await;
    crash_after(&sandbox, 3, 3);
    crate::skills::startup::run_blocking(
        sandbox.ctx(),
        &crate::harness::plugins::PluginsCtx::at(&sandbox.path("codeg")),
    );
    assert!(!sandbox.store(NAME).exists());
    assert!(sandbox.manifest().is_none());
    assert!(!sandbox.ctx().store.join(".codeg-staging").exists());
}

#[tokio::test]
async fn a_journal_whose_world_is_gone_is_dropped_and_loses_nothing() {
    // the store restored from a backup: the folders the journal names are
    // not there
    let sandbox = Sandbox::new().await;
    let dir = crash_after(&sandbox, 3, 3);
    fs::remove_dir_all(sandbox.store(NAME)).unwrap();
    let report = recover_journals(sandbox.ctx());
    assert_eq!(report.rolled_back, 1, "{report:?}");
    assert!(!dir.exists());
    assert!(
        sandbox.store_tree().is_empty(),
        "{:?}",
        sandbox.store_tree()
    );

    // a manifest that is neither the journal's before nor its after (a
    // restored one): the live folder is left, the old one kept
    let sandbox = Sandbox::new().await;
    assert_eq!(
        sandbox.install_planned(None).await.outcome,
        InstallOutcome::Installed
    );
    crash_after(&sandbox, 4, 3);
    let mut manifest = skill_manifest::load(&sandbox.ctx().store).unwrap();
    manifest.skills.get_mut(NAME).unwrap().op = "restored".into();
    skill_manifest::save(&sandbox.ctx().store, &manifest).unwrap();
    let live_before = sandbox.tree("store/pdf");
    let report = recover_journals(sandbox.ctx());
    assert_eq!(report.dropped, 1, "{report:?}");
    assert_eq!(sandbox.tree("store/pdf"), live_before);
    let kept = crate::skills::backups::list(sandbox.ctx(), Some(NAME)).backups;
    assert_eq!(kept.len(), 1);
    assert_eq!(
        read(&PathBuf::from(&kept[0].path).join("reference.md")),
        "Reference 3\n"
    );
    assert!(!sandbox.ctx().store.join(".codeg-staging").exists());
}

#[tokio::test]
async fn two_codegs_sharing_the_store_never_clear_each_others_staging() {
    let sandbox = Sandbox::new().await;
    // "the other process": the same store and lock, a short wait
    let mut other = sandbox.ctx().clone();
    other.lock_wait = std::time::Duration::from_millis(100);

    // this one is mid-install, under the lock
    let guard = sandbox.ctx().lock().await.unwrap();
    let dir = crash_after(&sandbox, 3, 2);
    // the other's start cannot take the lock, so it touches nothing
    assert!(other.lock_blocking().is_err());
    assert!(dir.join("op.json").is_file());
    // nor can its install: busy, nothing written
    let other_local = Local {
        ctx: other.clone(),
        ..sandbox.local.clone()
    };
    let plan = plan(&other_local, &sandbox.harness, REF, None, None)
        .await
        .unwrap();
    let result = install(
        &other_local,
        &sandbox.harness,
        &sandbox.emitter,
        sandbox.request(&plan),
    )
    .await
    .unwrap();
    assert_eq!(result.outcome, InstallOutcome::Busy, "{result:?}");
    assert!(dir.join("op.json").is_file());

    // this one dies without finishing; the other's next start recovers it
    drop(guard);
    let _held = other.lock_blocking().unwrap();
    let report = recover_journals(&other);
    assert_eq!(report.rolled_back, 1, "{report:?}");
    assert!(!sandbox.store(NAME).exists());
    drop(_held);

    // and an install by one is the other's to list and uninstall
    assert_eq!(
        sandbox.install_planned(None).await.outcome,
        InstallOutcome::Installed
    );
    assert_eq!(installed_skills_in(&other).unwrap()[0].id, ID);
}

// ─── Uninstall ──────────────────────────────────────────────────────────

#[tokio::test]
async fn an_uninstall_takes_every_link_away_then_the_folder() {
    let sandbox = Sandbox::new().await;
    assert_eq!(
        sandbox.install_planned(None).await.outcome,
        InstallOutcome::Installed
    );
    fs::write(sandbox.store(NAME).join("mine.md"), "added\n").unwrap();
    let mut events = sandbox.events.subscribe();

    let preflight = sandbox.uninstall(true, None).await;
    assert_eq!(preflight.outcome, UninstallOutcome::Preflight);
    assert_eq!(preflight.name.as_deref(), Some(NAME));
    assert_eq!(preflight.removes.len(), 3);
    assert_eq!(preflight.loses, INSTALLED.to_vec());
    assert_eq!(preflight.files.added, ["mine.md"]);
    let ack = preflight.ack.clone().unwrap();
    assert!(sandbox.store(NAME).exists());
    assert!(drain(&mut events).is_empty());

    let result = sandbox.uninstall(false, None).await;
    assert_eq!(result.outcome, UninstallOutcome::AcknowledgementRequired);
    assert_eq!(codes_of(&result.issues), [codes::ACKNOWLEDGEMENT_REQUIRED]);
    let result = sandbox.uninstall(false, Some("stale".into())).await;
    assert_eq!(codes_of(&result.issues), [codes::EFFECTS_CHANGED]);
    assert!(sandbox.store(NAME).exists());

    let result = sandbox.uninstall(false, Some(ack)).await;
    assert_eq!(result.outcome, UninstallOutcome::Uninstalled, "{result:?}");
    for dir in ["claude/skills", "codex/skills", "cline/skills"] {
        assert!(
            fs::symlink_metadata(sandbox.path(dir).join(NAME)).is_err(),
            "{dir}"
        );
    }
    assert!(!sandbox.store(NAME).exists());
    assert!(sandbox.manifest().unwrap()["skills"].get(NAME).is_none());
    assert!(sandbox.listing().is_empty());
    // the changed folder is kept among the backups
    let kept = PathBuf::from(result.backup.unwrap());
    assert_eq!(read(&kept.join("mine.md")), "added\n");
    assert!(!sandbox.ctx().store.join(".codeg-staging").exists());
    let seen = drain(&mut events);
    assert!(seen
        .iter()
        .any(|(channel, payload)| channel == INSTALLED_CHANGED_EVENT
            && payload["item_ids"] == json!([ID])));
    assert!(seen
        .iter()
        .any(|(channel, _)| channel == "skills://changed"));

    // nothing left of it: refused
    let result = sandbox.uninstall(true, None).await;
    assert_eq!(result.outcome, UninstallOutcome::Refused);
    assert_eq!(codes_of(&result.issues), [shared::NOT_INSTALLED]);
}

#[tokio::test]
async fn an_uninstall_cut_short_is_undone_at_the_next_start() {
    let sandbox = Sandbox::new().await;
    assert_eq!(
        sandbox.install_planned(None).await.outcome,
        InstallOutcome::Installed
    );
    let ack = sandbox.uninstall(true, None).await.ack.unwrap();
    sandbox.ctx().arm_fault("harness_commit");
    let result = sandbox.uninstall(false, Some(ack)).await;
    assert_eq!(result.outcome, UninstallOutcome::WriteFailed);
    // put back as it was (the links were taken away first: they stay away)
    assert!(sandbox.store(NAME).join("SKILL.md").is_file());
    assert_eq!(sandbox.listing()[0].state, LocalState::AsInstalled);
    assert!(!sandbox.ctx().store.join(".codeg-staging").exists());
    sandbox.ctx().disarm_faults();

    // a crash between moving the folder out and the commit
    let ctx = sandbox.ctx();
    let entry = skill_manifest::load(&ctx.store).unwrap().skills[NAME].clone();
    let tx = Tx::begin(
        ctx,
        new_journal(Action::Uninstall, NAME, ID, Some(entry), None, true, false),
    )
    .unwrap();
    tx.write_journal().unwrap();
    tx.swap().unwrap();
    assert!(!sandbox.store(NAME).exists());
    let report = recover_journals(ctx);
    assert_eq!(report.rolled_back, 1);
    assert!(sandbox.store(NAME).join("SKILL.md").is_file());
    // ... and one after it: finished
    let entry = skill_manifest::load(&ctx.store).unwrap().skills[NAME].clone();
    let tx = Tx::begin(
        ctx,
        new_journal(Action::Uninstall, NAME, ID, Some(entry), None, true, false),
    )
    .unwrap();
    tx.write_journal().unwrap();
    tx.swap().unwrap();
    tx.commit().unwrap();
    let report = recover_journals(ctx);
    assert_eq!(report.finished, 1);
    assert!(!sandbox.store(NAME).exists());
    assert!(sandbox.listing().is_empty());
}

// ─── The listing ────────────────────────────────────────────────────────

#[tokio::test]
async fn the_listing_tells_as_installed_changed_and_missing() {
    let sandbox = Sandbox::new().await;
    assert!(sandbox.listing().is_empty());
    assert_eq!(
        sandbox.install_planned(None).await.outcome,
        InstallOutcome::Installed
    );
    let listed = sandbox.listing();
    assert_eq!(listed[0].state, LocalState::AsInstalled);
    assert_eq!(listed[0].revision, 3);
    assert_eq!(listed[0].version.as_deref(), Some("1.0.3"));
    assert_eq!(listed[0].state_sha256, sandbox.sha("r3"));
    assert!(listed[0].archive_sha256.is_some());
    // as JSON, the way H6 and the Skills section read it
    let wire = serde_json::to_value(&listed[0]).unwrap();
    assert_eq!(wire["ref"], REF);
    assert_eq!(wire["name"], NAME);
    assert_eq!(wire["state"], "as_installed");

    fs::write(sandbox.store(NAME).join("reference.md"), "changed\n").unwrap();
    assert_eq!(sandbox.listing()[0].state, LocalState::ChangedLocally);
    fs::remove_file(sandbox.store(NAME).join("scripts/run.sh")).unwrap();
    let listed = sandbox.listing();
    assert_eq!(listed[0].state, LocalState::Missing);
    assert_eq!(listed[0].files.missing, ["scripts/run.sh"]);
    fs::remove_dir_all(sandbox.store(NAME)).unwrap();
    let listed = sandbox.listing();
    assert_eq!(listed[0].state, LocalState::Missing);
    assert_eq!(listed[0].files.missing.len(), 3);
    assert!(listed[0].agents.is_empty());

    // an unreadable manifest is an error, never an empty listing
    fs::write(skill_manifest::path(&sandbox.ctx().store), "{ not json").unwrap();
    let error = installed_skills_in(sandbox.ctx()).unwrap_err();
    assert_eq!(
        error.i18n_key.as_deref(),
        Some("Harness.errors.recordUnreadable")
    );
    // ... and stops installs and uninstalls rather than overwriting it
    let result = sandbox.install_planned(None).await;
    assert_eq!(codes_of(&result.issues), [codes::MANIFEST_UNREADABLE]);
    let result = sandbox.uninstall(true, None).await;
    assert_eq!(codes_of(&result.issues), [codes::MANIFEST_UNREADABLE]);
    assert_eq!(
        fs::read_to_string(skill_manifest::path(&sandbox.ctx().store)).unwrap(),
        "{ not json"
    );
}

#[tokio::test]
async fn a_newer_manifest_is_read_and_never_rewritten() {
    let sandbox = Sandbox::new().await;
    assert_eq!(
        sandbox.install_planned(None).await.outcome,
        InstallOutcome::Installed
    );
    let mut value = sandbox.manifest().unwrap();
    value["format"] = json!(2);
    value["skills"][NAME]["future"] = json!("kept");
    fs::write(
        skill_manifest::path(&sandbox.ctx().store),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    assert_eq!(sandbox.listing().len(), 1);
    let result = sandbox.uninstall(true, None).await;
    assert_eq!(codes_of(&result.issues), [codes::MANIFEST_UNREADABLE]);
    // a field a newer Codeg added survives this one's rewrite
    value["format"] = json!(1);
    fs::write(
        skill_manifest::path(&sandbox.ctx().store),
        serde_json::to_vec(&value).unwrap(),
    )
    .unwrap();
    let mut manifest = skill_manifest::load_for_write(&sandbox.ctx().store).unwrap();
    manifest.skills.get_mut(NAME).unwrap().revision = 9;
    skill_manifest::save(&sandbox.ctx().store, &manifest).unwrap();
    assert_eq!(
        sandbox.manifest().unwrap()["skills"][NAME]["future"],
        "kept"
    );
}

// ─── The switch ─────────────────────────────────────────────────────────

#[tokio::test]
async fn switched_off_the_plan_and_the_install_refuse_and_the_rest_still_works() {
    let sandbox = Sandbox::new().await;
    assert_eq!(
        sandbox.install_planned(None).await.outcome,
        InstallOutcome::Installed
    );
    let off = Harness {
        enabled: false,
        origin: sandbox.harness.origin.clone(),
        cache: Cache::in_data_dir(&sandbox.root.join("data")),
        limits: Limits::default(),
        backoff: Box::leak(Box::new(Backoff::default())),
    };
    let asked = sandbox.site.seen().len();
    let error = plan(&sandbox.local, &off, REF, None, None)
        .await
        .unwrap_err();
    assert_eq!(error.i18n_key.as_deref(), Some("Harness.errors.disabled"));
    let plan_on = sandbox.plan(None).await;
    let asked_after_plan = sandbox.site.seen().len();
    let error = install(
        &sandbox.local,
        &off,
        &sandbox.emitter,
        sandbox.request(&plan_on),
    )
    .await
    .unwrap_err();
    assert_eq!(error.i18n_key.as_deref(), Some("Harness.errors.disabled"));
    assert_eq!(sandbox.site.seen().len(), asked_after_plan);
    assert!(asked < asked_after_plan);
    // the listing and the uninstall touch only this machine
    assert_eq!(sandbox.listing().len(), 1);
    let ack = sandbox.uninstall(true, None).await.ack.unwrap();
    let before = sandbox.site.seen().len();
    let result = sandbox.uninstall(false, Some(ack)).await;
    assert_eq!(result.outcome, UninstallOutcome::Uninstalled);
    assert_eq!(sandbox.site.seen().len(), before);
}

#[tokio::test]
async fn the_command_layer_refuses_when_switched_off_before_touching_anything() {
    let dir = tempfile::tempdir().unwrap();
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    let off = Harness {
        enabled: false,
        origin: Origin::release(),
        cache: Cache::in_data_dir(dir.path()),
        limits: Limits::default(),
        backoff: Box::leak(Box::new(Backoff::default())),
    };
    let error =
        crate::commands::harness_skills::harness_skill_plan_core(&db, &off, REF, None, None)
            .await
            .unwrap_err();
    assert_eq!(error.i18n_key.as_deref(), Some("Harness.errors.disabled"));
    let events = Arc::new(WebEventBroadcaster::new());
    let emitter = EventEmitter::test_web_only(events);
    let error = crate::commands::harness_skills::harness_skill_install_core(
        &emitter,
        &off,
        HarnessSkillInstallRequest::default(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.i18n_key.as_deref(), Some("Harness.errors.disabled"));
}

// ─── Changes after review ───────────────────────────────────────────────

/// An editor or an agent changes the installed folder while the update
/// waits for the last snapshot (neither takes Codeg's lock): the edit is
/// kept among the backups, not deleted with the old folder.
#[tokio::test]
async fn an_edit_made_while_the_update_runs_is_kept_not_deleted() {
    let sandbox = Sandbox::new().await;
    assert_eq!(
        sandbox.install_planned(None).await.outcome,
        InstallOutcome::Installed
    );
    sandbox.publish(4, &package(4), true);
    let plan = sandbox.plan(None).await;
    assert!(!codes_of(&plan.warnings).contains(&codes::FILES_CHANGED_LOCALLY));
    let live = sandbox.store(NAME);
    sandbox.site.catalog.lock().unwrap().on_resolve = Some(Box::new(move || {
        fs::write(live.join("reference.md"), "edited while it ran\n").unwrap();
    }));
    let result = sandbox.install(sandbox.request(&plan)).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    let kept = PathBuf::from(result.backup.expect("the edit is kept"));
    assert_eq!(read(&kept.join("reference.md")), "edited while it ran\n");
    assert_eq!(
        read(&sandbox.store(NAME).join("reference.md")),
        "Reference 4\n"
    );
}

/// The same at the next start: a journal that began over an unchanged
/// folder, whose old folder changed before the swap (or cannot be read),
/// finishes by keeping it.
#[tokio::test]
async fn recovery_keeps_an_old_folder_that_changed_or_cannot_be_read() {
    let sandbox = Sandbox::new().await;
    assert_eq!(
        sandbox.install_planned(None).await.outcome,
        InstallOutcome::Installed
    );
    let dir = crash_after(&sandbox, 4, 4);
    fs::write(dir.join("old/reference.md"), "edited before the swap\n").unwrap();
    let report = recover_journals(sandbox.ctx());
    assert_eq!(report.finished, 1, "{report:?}");
    let kept = crate::skills::backups::list(sandbox.ctx(), Some(NAME)).backups;
    assert_eq!(kept.len(), 1);
    assert_eq!(
        read(&PathBuf::from(&kept[0].path).join("reference.md")),
        "edited before the swap\n"
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let sandbox = Sandbox::new().await;
        assert_eq!(
            sandbox.install_planned(None).await.outcome,
            InstallOutcome::Installed
        );
        let dir = crash_after(&sandbox, 4, 4);
        let unreadable = dir.join("old/reference.md");
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();
        let report = recover_journals(sandbox.ctx());
        assert_eq!(report.finished, 1, "{report:?}");
        let kept = crate::skills::backups::list(sandbox.ctx(), Some(NAME)).backups;
        assert_eq!(kept.len(), 1, "an unreadable folder is kept, not deleted");
        let file = PathBuf::from(&kept[0].path).join("reference.md");
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(read(&file), "Reference 3\n");
    }
}

/// An uninstall that cannot compare the folder with what was installed
/// keeps it whole, says so in the preflight, and its ack covers it.
#[cfg(unix)]
#[tokio::test]
async fn an_uninstall_keeps_a_folder_it_cannot_read_whole() {
    use std::os::unix::fs::PermissionsExt;
    let sandbox = Sandbox::new().await;
    assert_eq!(
        sandbox.install_planned(None).await.outcome,
        InstallOutcome::Installed
    );
    let unreadable = sandbox.store(NAME).join("reference.md");
    fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();
    assert_eq!(sandbox.listing()[0].state, LocalState::Unknown);
    let plan = sandbox.plan(None).await;
    assert!(codes_of(&plan.warnings).contains(&codes::FILES_UNREADABLE));

    let preflight = sandbox.uninstall(true, None).await;
    assert!(preflight.files_unreadable.is_some(), "{preflight:?}");
    assert!(preflight.keeps_folder);
    let result = sandbox.uninstall(false, preflight.ack.clone()).await;
    assert_eq!(result.outcome, UninstallOutcome::Uninstalled, "{result:?}");
    let kept = PathBuf::from(result.backup.expect("kept whole"));
    let file = kept.join("reference.md");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(read(&file), "Reference 3\n");
    assert!(!sandbox.store(NAME).exists());
}

/// While Harness's manifest cannot be read, which store skills are Harness's
/// cannot be told: none of the unclaimed ones is saved over or deleted as a
/// Custom skill, and the inventory says why.
#[tokio::test]
async fn an_unreadable_harness_manifest_leaves_every_unclaimed_skill_alone() {
    use crate::commands::custom_skills::{custom_delete_skills_in, custom_save_skill_in};
    let sandbox = Sandbox::new().await;
    assert_eq!(
        sandbox.install_planned(None).await.outcome,
        InstallOutcome::Installed
    );
    let mine = sandbox.store("mine");
    fs::create_dir_all(&mine).unwrap();
    fs::write(mine.join("SKILL.md"), "---\nname: mine\n---\nmine\n").unwrap();
    let manifest_path = skill_manifest::path(&sandbox.ctx().store);
    let good = fs::read(&manifest_path).unwrap();
    let installed_md = read(&sandbox.store(NAME).join("SKILL.md"));

    // whatever the Harness loader refuses: not JSON, the wrong shape, a
    // field of the wrong type, `skills` missing or null, an entry it cannot
    // read
    for broken in [
        "{ not json",
        r#"{"format":1,"skills":"lost"}"#,
        "[]",
        r#"{"format":"broken","skills":{}}"#,
        r#"{"format":1,"skills":null}"#,
        r#"{"format":1}"#,
        r#"{"format":1,"skills":{"pdf":{"ref":"acme.dev/pdf"}}}"#,
    ] {
        fs::write(&manifest_path, broken).unwrap();
        assert!(
            skill_manifest::load(&sandbox.ctx().store).is_err(),
            "{broken}"
        );
        let inventory = crate::skills::world::inventory(sandbox.ctx());
        let unresolved: Vec<(String, String)> = inventory
            .problems
            .iter()
            .filter(|p| p.code == crate::skills::model::codes::OWNERSHIP_UNRESOLVED)
            .map(|p| (p.path.clone().unwrap(), p.detail.clone().unwrap()))
            .collect();
        assert_eq!(
            unresolved,
            [
                (mine.to_string_lossy().into_owned(), "harness".to_string()),
                (
                    sandbox.store(NAME).to_string_lossy().into_owned(),
                    "harness".to_string()
                ),
            ],
            "{broken}"
        );
        for id in [NAME, "mine"] {
            let error = custom_save_skill_in(
                sandbox.ctx().clone(),
                &EventEmitter::Noop,
                id.into(),
                "overwritten\n".into(),
            )
            .await
            .expect_err("refused");
            assert_eq!(error.code(), "ownership_unresolved", "{broken} {id}");
            let app = crate::app_error::AppCommandError::from(&error);
            assert_eq!(
                app.i18n_params
                    .unwrap_or_default()
                    .get("detail")
                    .map(String::as_str),
                Some("harness")
            );
        }
        let deleted = custom_delete_skills_in(
            sandbox.ctx().clone(),
            &EventEmitter::Noop,
            vec![NAME.into(), "mine".into()],
        )
        .await
        .unwrap();
        assert!(deleted.iter().all(|r| !r.ok), "{deleted:?}");
        assert!(deleted
            .iter()
            .all(|r| r.code.as_deref() == Some("ownership_unresolved")));
        assert_eq!(read(&sandbox.store(NAME).join("SKILL.md")), installed_md);
        assert_eq!(read(&mine.join("SKILL.md")), "---\nname: mine\n---\nmine\n");
    }

    // readable again: Harness's is Harness's, the user's is theirs
    fs::write(&manifest_path, &good).unwrap();
    let refused = custom_save_skill_in(
        sandbox.ctx().clone(),
        &EventEmitter::Noop,
        NAME.into(),
        "x\n".into(),
    )
    .await
    .expect_err("a Harness skill");
    assert_eq!(refused.code(), "id_reserved");
    custom_save_skill_in(
        sandbox.ctx().clone(),
        &EventEmitter::Noop,
        "mine".into(),
        "edited\n".into(),
    )
    .await
    .unwrap();
    assert!(!crate::skills::world::inventory(sandbox.ctx())
        .problems
        .iter()
        .any(|p| p.code == crate::skills::model::codes::OWNERSHIP_UNRESOLVED));
}

/// `harness_installed` lists each part on its own: a record that cannot be
/// read empties only its part, with that part's problem.
#[tokio::test]
async fn the_listing_answers_each_part_on_its_own() {
    use crate::commands::mcp_engine::agents::{all_apps, wire_name, AgentPaths, EngineCtx};
    let sandbox = Sandbox::new().await;
    assert_eq!(
        sandbox.install_planned(None).await.outcome,
        InstallOutcome::Installed
    );
    let paths = all_apps()
        .iter()
        .map(|app| {
            let home = sandbox.path("mcp").join(wire_name(*app));
            (
                *app,
                AgentPaths {
                    servers: home.join("mcp.json"),
                    plugin_gate: None,
                },
            )
        })
        .collect();
    let mcp_local = crate::harness::mcp::Local {
        engine: EngineCtx {
            paths,
            lock_path: sandbox.path("locks/mcp.lock"),
            backup_root: sandbox.path("mcp-backups"),
            lock_wait: crate::commands::mcp_engine::lock::LOCK_WAIT,
        },
        installed: BTreeMap::new(),
        record_path: sandbox.path("codeg/harness/mcp.json"),
    };
    let plugins = crate::harness::plugins::install::PluginsLocal {
        plugins: crate::harness::plugins::PluginsCtx::at(&sandbox.path("codeg")),
        skills: sandbox.local.clone(),
        adapters: Vec::new(),
        envs: BTreeMap::new(),
        default_env: crate::harness::plugins::hosts::HostEnv::sandboxed(&sandbox.path("home"), &[]),
        missing_envs: Default::default(),
    };
    let list = || {
        crate::commands::harness_mcp::harness_installed_in(
            &mcp_local,
            sandbox.ctx().clone(),
            &plugins,
            &[],
            &sandbox.emitter,
        )
    };

    let listed = list().await.unwrap();
    assert_eq!(listed.skills.len(), 1);
    assert!(listed.mcp_problem.is_none() && listed.skills_problem.is_none());

    // the MCP record cannot be read: the skills are still listed
    fs::create_dir_all(mcp_local.record_path.parent().unwrap()).unwrap();
    fs::write(&mcp_local.record_path, "{ not json").unwrap();
    let listed = list().await.unwrap();
    assert!(listed.mcp.is_empty());
    assert_eq!(
        listed.mcp_problem.as_ref().unwrap().code,
        "record_unreadable"
    );
    assert_eq!(listed.skills.len(), 1);
    assert!(listed.skills_problem.is_none());

    // the skills manifest cannot be read: the MCP side is still listed
    fs::remove_file(&mcp_local.record_path).unwrap();
    fs::write(skill_manifest::path(&sandbox.ctx().store), "{ not json").unwrap();
    let listed = list().await.unwrap();
    assert!(listed.mcp_problem.is_none());
    assert!(listed.skills.is_empty());
    let problem = listed.skills_problem.unwrap();
    assert_eq!(problem.code, "record_unreadable");
    assert!(problem.detail.unwrap().contains(".manifest.harness.json"));
    let wire = serde_json::to_value(list().await.unwrap()).unwrap();
    assert!(wire["mcp_problem"].is_null());
    assert_eq!(wire["skills_problem"]["code"], "record_unreadable");
    assert!(wire["plugins_problem"].is_null());
    assert_eq!(wire["plugins"], serde_json::json!([]));

    // the plugins record cannot be read: the MCP side is still listed
    let plugins_record = &plugins.plugins.record;
    fs::create_dir_all(plugins_record.parent().unwrap()).unwrap();
    fs::write(plugins_record, "{ not json").unwrap();
    let listed = list().await.unwrap();
    assert!(listed.mcp_problem.is_none());
    assert!(listed.plugins.is_empty());
    let problem = listed.plugins_problem.unwrap();
    assert_eq!(problem.code, "record_unreadable");
    assert!(problem.detail.unwrap().contains("plugins.json"));
}

/// QA finding: a site without `/resolve` answers it 404 — not "no item at
/// this address". The skill's plan and install both say SpaceRing cannot
/// confirm its state, and the install leaves nothing in the store.
#[tokio::test]
async fn a_resolve_the_site_does_not_serve_is_not_a_missing_item() {
    let sandbox = Sandbox::new().await;
    let plan_ok = sandbox.plan(None).await;
    let request = sandbox.request(&plan_ok);
    let before = sandbox.store_tree();
    sandbox.site.catalog.lock().unwrap().resolve_missing = true;

    let error = plan(&sandbox.local, &sandbox.harness, REF, None, None)
        .await
        .unwrap_err();
    assert_eq!(
        error.i18n_key.as_deref(),
        Some("Harness.errors.resolveUnavailable")
    );
    let error = install(&sandbox.local, &sandbox.harness, &sandbox.emitter, request)
        .await
        .unwrap_err();
    assert_eq!(
        error.i18n_key.as_deref(),
        Some("Harness.errors.resolveUnavailable")
    );
    assert_eq!(sandbox.store_tree(), before, "nothing left in the store");
    assert!(sandbox.manifest().is_none());
    assert!(sandbox.listing().is_empty());
}
