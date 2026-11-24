//! Installing from Harness end to end: a stand-in for SpaceRing on loopback
//! (started inside each test, answering what the test sets), and every
//! agent's config file, the MCP write lock and the provenance record under
//! one temp directory. Nothing here reaches spacering.net or the real home.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::Request;
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use super::model::*;
use super::{install, installed, plan, record, uninstall, Local};
use crate::commands::mcp::McpAppType;
use crate::commands::mcp_engine::agents::{all_apps, wire_name, AgentPaths, EngineCtx};
use crate::commands::mcp_engine::lock::{acquire_blocking_at, McpLockError, LOCK_WAIT};
use crate::commands::mcp_engine::model::{
    McpAgentStatus, McpApplyOutcome, McpDefinition, McpEntry,
};
use crate::commands::mcp_engine::{fsio, inventory};
use crate::harness::cache::Cache;
use crate::harness::client::{Backoff, Limits};
use crate::harness::{Harness, Origin};
use crate::web::event_bridge::{EventEmitter, WebEvent, WebEventBroadcaster};

const ID: &str = "0199b0aa-0000-7000-8000-0000000000aa";
const REF: &str = "acme.dev/notes";
const PACKAGE: &str = "@acme/notes-mcp";

// ─── The stand-in for SpaceRing ─────────────────────────────────────────

#[derive(Default)]
struct Catalog {
    latest: u64,
    /// `GET /items/{ref}/versions/{revision}`.
    versions: BTreeMap<u64, Value>,
    /// What `/resolve` answers for a revision (the `id` is filled in).
    resolved: BTreeMap<u64, Value>,
    /// Every request: method and path.
    seen: Vec<(Method, String)>,
    /// Run once, when `/resolve` is next asked: something another Codeg
    /// does while this one is between its checks and its commit.
    on_resolve: Option<Box<dyn FnOnce() + Send>>,
    /// Answer `/resolve` as a site that does not serve it: 404, with a
    /// missing item's body.
    resolve_missing: bool,
}

struct Site {
    origin: String,
    /// Fingerprints are this tag plus a name: the snapshots a plan shows are
    /// kept process-wide, and tests run side by side.
    tag: String,
    catalog: Arc<Mutex<Catalog>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Site {
    fn drop(&mut self) {
        self.task.abort();
    }
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
    let item = format!("/api/harness/v1/items/{REF}");
    if path == item {
        return json_reply(
            &json!({ "id": ID, "ref": REF, "latest": { "revision": catalog.latest } }),
        );
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

impl Site {
    async fn start() -> Self {
        let catalog: Arc<Mutex<Catalog>> = Arc::default();
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
        let site = Self {
            origin,
            tag: uuid::Uuid::new_v4().simple().to_string(),
            catalog,
            task,
        };
        site.publish(3, "1.2.3", "s3-a");
        site
    }

    /// Publish `revision`, pinning the package at `version`, with a state
    /// whose fingerprint is `sha`.
    fn publish(&self, revision: u64, version: &str, sha: &str) {
        let sha = self.sha(sha);
        let mut catalog = self.catalog.lock().unwrap();
        catalog.latest = catalog.latest.max(revision);
        catalog
            .versions
            .insert(revision, version_json(revision, version));
        catalog
            .resolved
            .insert(revision, resolved_json(revision, version, &sha));
    }

    /// Publish `revision` with a server.json of its own.
    fn publish_server(&self, revision: u64, sha: &str, server: Value) {
        self.publish(revision, "1.2.3", sha);
        self.catalog
            .lock()
            .unwrap()
            .versions
            .get_mut(&revision)
            .unwrap()["server"] = server;
    }

    /// The catalog no longer serves `revision`'s install info.
    fn withdraw(&self, revision: u64) {
        self.catalog.lock().unwrap().versions.remove(&revision);
    }

    fn sha(&self, name: &str) -> String {
        format!("{}-{name}", self.tag)
    }

    /// Change what `/resolve` says of `revision`.
    fn resolve(&self, revision: u64, change: impl FnOnce(&mut Value)) {
        let mut catalog = self.catalog.lock().unwrap();
        change(catalog.resolved.get_mut(&revision).unwrap());
    }

    fn requests(&self) -> usize {
        self.catalog.lock().unwrap().seen.len()
    }
}

fn server_json() -> Value {
    json!({
        "name": "dev.acme/notes",
        "description": "Search and edit notes from your agent.",
        "packages": [{
            "registryType": "npm", "identifier": PACKAGE, "version": "latest",
            "runtimeHint": "npx", "transport": { "type": "stdio" },
            "environmentVariables": [
                { "name": "NOTES_TOKEN", "isRequired": true, "isSecret": true },
                { "name": "NOTES_DIR", "description": "Where the notes are" }
            ]
        }],
        "remotes": [
            { "type": "streamable-http", "url": "https://mcp.acme.dev/mcp",
              "headers": [{ "name": "Authorization", "isRequired": true, "isSecret": true }] },
            { "type": "streamable-http", "url": "https://{host}/mcp",
              "variables": { "host": { "isRequired": true } } }
        ]
    })
}

fn version_json(revision: u64, version: &str) -> Value {
    json!({
        "item": { "id": ID, "ref": REF, "kind": "mcp", "title": { "en": "Notes" } },
        "version": { "revision": revision, "version": format!("{revision}.0.0"),
                     "publishedAt": "2026-11-01T00:00:00.000Z", "status": "ok" },
        "archive": null, "files": [], "source": null,
        "server": server_json(),
        // what a cache may still hold: never decided on
        "packages": [{ "registryType": "npm", "identifier": PACKAGE, "version": version,
                       "verified": "ok", "hasInstallScript": false }],
        "permissions": {}, "risk": "low", "reviewed": true, "advisories": []
    })
}

fn resolved_json(revision: u64, version: &str, sha: &str) -> Value {
    json!({
        "status": "public", "ref": REF, "kind": "mcp",
        "latest": { "revision": revision, "version": format!("{revision}.0.0"), "publishedAt": "p" },
        "advisories": [],
        "installed": {
            "revision": revision, "status": "ok", "risk": "low", "reviewed": true,
            "permissions": { "declared": { "secrets": ["NOTES_TOKEN"] },
                             "detected": { "runsCode": ["node"], "installs": [format!("npm:{PACKAGE}@{version}")],
                                           "installScripts": [], "network": ["mcp.acme.dev"],
                                           "secrets": ["NOTES_TOKEN"], "paths": [], "tools": [] } },
            "checks": { "findings": { "low": 0, "medium": 0, "high": 0 }, "secrets": 0, "review": "off" },
            "packages": [{ "registryType": "npm", "identifier": PACKAGE, "version": version,
                           "verified": "ok", "hasInstallScript": false }],
            "stateSha256": sha
        }
    })
}

// ─── The agents' side ───────────────────────────────────────────────────

struct Sandbox {
    _dir: tempfile::TempDir,
    local: Local,
    site: Site,
    harness: Harness,
    events: Arc<WebEventBroadcaster>,
    emitter: EventEmitter,
}

fn file_name(app: McpAppType) -> &'static str {
    match app {
        McpAppType::Codex | McpAppType::Grok => "config.toml",
        McpAppType::Trae => "traecli.toml",
        McpAppType::Hermes => "config.yaml",
        McpAppType::OpenCode => "opencode.jsonc",
        McpAppType::ClaudeCode => ".claude.json",
        _ => "mcp.json",
    }
}

/// The agents a test has installed: four with every kind of file the engine
/// writes (Claude's JSON with its plugin gate, Codex's TOML, Gemini's JSON,
/// Cline's JSON with an on/off flag).
const INSTALLED: [McpAppType; 4] = [
    McpAppType::ClaudeCode,
    McpAppType::Codex,
    McpAppType::Gemini,
    McpAppType::Cline,
];

impl Sandbox {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let paths = all_apps()
            .iter()
            .map(|app| {
                let home = dir.path().join("agents").join(wire_name(*app));
                let plugin_gate = matches!(app, McpAppType::ClaudeCode | McpAppType::CodeBuddy)
                    .then(|| home.join("settings.json"));
                (
                    *app,
                    AgentPaths {
                        servers: home.join(file_name(*app)),
                        plugin_gate,
                    },
                )
            })
            .collect();
        let engine = EngineCtx {
            paths,
            lock_path: dir.path().join("locks").join("mcp.lock"),
            backup_root: dir.path().join("backups"),
            lock_wait: LOCK_WAIT,
        };
        let installed = all_apps()
            .iter()
            .map(|app| (*app, INSTALLED.contains(app)))
            .collect();
        let local = Local {
            engine,
            installed,
            record_path: dir.path().join("codeg").join("harness").join("mcp.json"),
        };
        let site = Site::start().await;
        let harness = Harness {
            enabled: true,
            origin: Origin::parse(&site.origin).expect("a loopback origin"),
            cache: Cache::in_data_dir(&dir.path().join("data")),
            limits: Limits::default(),
            backoff: Box::leak(Box::new(Backoff::default())),
        };
        let events = Arc::new(WebEventBroadcaster::new());
        let emitter = EventEmitter::test_web_only(events.clone());
        let sandbox = Self {
            _dir: dir,
            local,
            site,
            harness,
            events,
            emitter,
        };
        sandbox.write(McpAppType::ClaudeCode, "{\n  \"numStartups\": 3\n}\n");
        sandbox.write(McpAppType::Codex, "# mine\nmodel = \"gpt-5.5\"\n");
        sandbox
    }

    fn path(&self, app: McpAppType) -> PathBuf {
        self.local.engine.paths_of(app).unwrap().servers.clone()
    }

    fn write(&self, app: McpAppType, text: &str) {
        let path = self.path(app);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read(&self, app: McpAppType) -> Option<String> {
        std::fs::read_to_string(self.path(app)).ok()
    }

    fn files(&self) -> Vec<Option<String>> {
        all_apps().iter().map(|app| self.read(*app)).collect()
    }

    fn entry(&self, app: McpAppType, key: &str) -> Option<McpEntry> {
        inventory::inventory(&self.local.engine, &BTreeMap::new())
            .agents
            .into_iter()
            .find(|agent| agent.agent == app)?
            .entries
            .into_iter()
            .find(|entry| entry.key == key)
    }

    fn record(&self) -> Option<Value> {
        std::fs::read(&self.local.record_path)
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }

    async fn plan(&self, revision: Option<u64>) -> HarnessMcpPlan {
        plan(&self.local, &self.harness, REF, revision)
            .await
            .unwrap()
    }

    /// The install request a dialog would send for `plan`'s first option,
    /// to `agents`, under `key`.
    fn request(
        &self,
        plan: &HarnessMcpPlan,
        agents: &[McpAppType],
        key: &str,
    ) -> HarnessMcpInstallRequest {
        HarnessMcpInstallRequest {
            item_ref: REF.to_string(),
            revision: plan.item.revision,
            option_id: "official:package:0:stdio".to_string(),
            values: BTreeMap::from([("env.NOTES_TOKEN".to_string(), "t0ken".to_string())]),
            key: key.to_string(),
            agents: agents.to_vec(),
            replace: Vec::new(),
            state_sha256: plan.state_sha256.clone().unwrap(),
            basis: agents
                .iter()
                .map(|agent| (*agent, plan.basis[agent].clone()))
                .collect(),
            accept_yanked: false,
        }
    }

    async fn install(&self, request: HarnessMcpInstallRequest) -> HarnessMcpInstallResult {
        install(&self.local, &self.harness, &self.emitter, request)
            .await
            .unwrap()
    }

    /// Plan, then install the first option to `agents` under the default key.
    async fn install_to(&self, agents: &[McpAppType]) -> HarnessMcpInstallResult {
        let plan = self.plan(None).await;
        let request = self.request(&plan, agents, &plan.key.default);
        self.install(request).await
    }

    async fn listing(&self) -> Vec<InstalledItem> {
        installed(&self.local, &self.emitter).await.unwrap().mcp
    }

    async fn uninstall(&self, request: HarnessMcpUninstallRequest) -> HarnessMcpUninstallResult {
        uninstall(&self.local, &self.emitter, request)
            .await
            .unwrap()
    }
}

fn codes_of(reasons: &[Reason]) -> Vec<&str> {
    reasons.iter().map(|reason| reason.code.as_str()).collect()
}

fn drain(events: &mut tokio::sync::broadcast::Receiver<WebEvent>) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    while let Ok(event) = events.try_recv() {
        out.push((event.channel, (*event.payload).clone()));
    }
    out
}

fn npx(version: &str, token: &str) -> McpDefinition {
    McpDefinition::Stdio {
        command: "npx".into(),
        args: vec!["-y".into(), format!("{PACKAGE}@{version}")],
        env: BTreeMap::from([("NOTES_TOKEN".into(), token.into())]),
    }
}

/// Clears the record hook when a test ends, however it ends.
struct HookGuard;

impl Drop for HookGuard {
    fn drop(&mut self) {
        record::hooks::set_before_save(None);
    }
}

// ─── The plan ───────────────────────────────────────────────────────────

#[tokio::test]
async fn the_plan_shows_the_snapshot_the_options_the_targets_and_the_basis() {
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;

    assert_eq!(plan.item.id, ID);
    assert_eq!(plan.item.item_ref, REF);
    assert_eq!(
        plan.item.revision, 3,
        "the latest, when no revision is asked for"
    );
    assert_eq!(plan.item_status, crate::harness::types::ItemStatus::Public);
    assert_eq!(plan.state_sha256, Some(sandbox.site.sha("s3-a")));
    assert!(
        plan.blocking.is_empty() && plan.confirm.is_empty(),
        "{plan:?}"
    );

    let ids: Vec<&str> = plan
        .options
        .iter()
        .map(|option| option.id.as_str())
        .collect();
    assert_eq!(
        ids,
        [
            "official:package:0:stdio",
            "official:remote:0:http",
            "official:remote:1:http"
        ]
    );
    let package = &plan.options[0];
    assert!(package.selectable);
    assert_eq!(package.source, OptionSource::Package);
    // the version Harness pinned, never the server.json's `latest`
    assert_eq!(
        package.definition,
        Some(McpDefinition::Stdio {
            command: "npx".into(),
            args: vec!["-y".into(), format!("{PACKAGE}@1.2.3")],
            env: BTreeMap::new(),
        })
    );
    let pinned = package.package.as_ref().unwrap();
    assert_eq!(pinned.version.as_deref(), Some("1.2.3"));
    assert_eq!(pinned.runtime.as_deref(), Some("npx"));
    let parameters: Vec<(&str, bool, bool)> = package
        .parameters
        .iter()
        .map(|parameter| (parameter.key.as_str(), parameter.required, parameter.secret))
        .collect();
    assert_eq!(
        parameters,
        [
            ("env.NOTES_TOKEN", true, true),
            ("env.NOTES_DIR", false, false)
        ]
    );
    assert_eq!(
        plan.default_option.as_deref(),
        Some("official:package:0:stdio")
    );

    let remote = &plan.options[1];
    assert_eq!(remote.url.as_deref(), Some("https://mcp.acme.dev/mcp"));
    assert_eq!(remote.parameters[0].location, "header");
    // the address depends on what the user types: decided when installing
    assert!(plan.options[2].selectable);
    assert_eq!(plan.options[2].url.as_deref(), Some("https://{host}/mcp"));

    // installed agents that take the transport
    assert_eq!(package.default_targets, INSTALLED);
    assert!(package.default_replace.is_empty());
    assert_eq!(plan.key.name, "notes");
    assert_eq!(plan.key.default, "notes");
    assert!(plan.key.conflicts.is_empty());
    assert_eq!(plan.key.pattern, "^[A-Za-z0-9_-]{1,64}$");
    assert!(plan.installed.is_none());

    // a basis for every agent, a file or not
    assert_eq!(plan.agents.len(), all_apps().len());
    assert_eq!(plan.basis[&McpAppType::Gemini], "missing");
    assert_eq!(
        plan.basis[&McpAppType::Codex],
        fsio::basis_of(Some(sandbox.read(McpAppType::Codex).unwrap().as_bytes()))
    );

    // the camelCase of the catalog's own objects, the snake_case of ours
    let wire = serde_json::to_value(&plan).unwrap();
    assert_eq!(wire["snapshot"]["stateSha256"], sandbox.site.sha("s3-a"));
    assert_eq!(wire["latest"]["publishedAt"], "p");
    assert_eq!(wire["item"]["ref"], REF);
    assert_eq!(wire["options"][0]["default_targets"][0], "claude_code");
    assert_eq!(
        wire["options"][0]["parameters"][0]["key"],
        "env.NOTES_TOKEN"
    );
}

#[tokio::test]
async fn what_blocks_the_item_or_an_option_and_what_is_worth_a_warning() {
    let sandbox = Sandbox::new().await;
    let set = |path: &[&str], value: Value| {
        sandbox.site.resolve(3, |resolved| {
            let mut at = resolved;
            for part in &path[..path.len() - 1] {
                at = match part.parse::<usize>() {
                    Ok(index) => &mut at[index],
                    Err(_) => &mut at[*part],
                };
            }
            at[path[path.len() - 1]] = value;
        })
    };
    let reset = || sandbox.site.publish(3, "1.2.3", "s3-a");

    // the version blocked, the item gone
    set(&["installed", "status"], json!("blocked"));
    let plan = sandbox.plan(Some(3)).await;
    assert_eq!(codes_of(&plan.blocking), [codes::VERSION_BLOCKED]);
    assert!(plan.options.iter().all(|option| !option.selectable));
    assert_eq!(plan.default_option, None);
    reset();
    sandbox
        .site
        .resolve(3, |resolved| *resolved = json!({ "status": "unavailable" }));
    let plan = sandbox.plan(Some(3)).await;
    assert_eq!(codes_of(&plan.blocking), [codes::ITEM_UNAVAILABLE]);
    assert_eq!(plan.blocking[0].params["status"], "unavailable");

    // the package: missing at its registry, no exact version, `latest`
    for (field, value, code) in [
        ("verified", json!("missing"), codes::PACKAGE_MISSING),
        ("version", json!(null), codes::PACKAGE_VERSION_INEXACT),
        ("version", json!("latest"), codes::PACKAGE_VERSION_INEXACT),
        ("version", json!("^1.2.0"), codes::PACKAGE_VERSION_INEXACT),
    ] {
        reset();
        set(&["installed", "packages", "0", field], value);
        let plan = sandbox.plan(Some(3)).await;
        assert!(plan.blocking.is_empty());
        assert_eq!(codes_of(&plan.options[0].blocking), [code], "{field}");
        assert!(!plan.options[0].selectable);
        // the hosted endpoint does not run the package
        assert!(plan.options[1].selectable);
        assert_eq!(
            plan.default_option.as_deref(),
            Some("official:remote:0:http")
        );
    }

    // warnings: not verified, install scripts; and a yanked version
    reset();
    set(
        &["installed", "packages", "0", "verified"],
        json!("pending"),
    );
    set(
        &["installed", "packages", "0", "hasInstallScript"],
        json!(true),
    );
    set(&["installed", "status"], json!("yanked"));
    let plan = sandbox.plan(Some(3)).await;
    assert!(plan.blocking.is_empty());
    assert_eq!(codes_of(&plan.confirm), [codes::YANKED]);
    assert!(plan.options[0].selectable);
    assert_eq!(
        codes_of(&plan.options[0].warnings),
        [codes::VERSION_UNVERIFIED, codes::INSTALL_SCRIPT]
    );
    assert_eq!(plan.options[0].warnings[0].params["verified"], "pending");
    reset();
    set(
        &["installed", "packages", "0", "verified"],
        json!("unchecked"),
    );
    let plan = sandbox.plan(Some(3)).await;
    assert_eq!(plan.options[0].warnings[0].params["verified"], "unchecked");

    // no such revision
    let missing = plan_error(&sandbox, Some(9)).await;
    assert_eq!(missing.i18n_key.as_deref(), Some("Harness.errors.notFound"));
}

async fn plan_error(sandbox: &Sandbox, revision: Option<u64>) -> crate::app_error::AppCommandError {
    plan(&sandbox.local, &sandbox.harness, REF, revision)
        .await
        .unwrap_err()
}

#[tokio::test]
async fn the_default_name_steps_around_servers_from_elsewhere() {
    let sandbox = Sandbox::new().await;
    sandbox.write(
        McpAppType::ClaudeCode,
        r#"{ "mcpServers": { "notes": { "command": "my-notes" } } }"#,
    );
    let plan = sandbox.plan(None).await;
    assert_eq!(plan.key.default, "notes-acme-dev");
    let conflicts: Vec<(&str, McpAppType, EntryOwner)> = plan
        .key
        .conflicts
        .iter()
        .map(|conflict| (conflict.key.as_str(), conflict.agent, conflict.owner))
        .collect();
    assert_eq!(
        conflicts,
        [("notes", McpAppType::ClaudeCode, EntryOwner::Elsewhere)]
    );
    assert_eq!(
        plan.key.conflicts[0].definition,
        Some(McpDefinition::Stdio {
            command: "my-notes".into(),
            args: vec![],
            env: BTreeMap::new()
        })
    );

    // that one taken too: a number
    sandbox.write(
        McpAppType::Codex,
        "[mcp_servers.notes-acme-dev]\ncommand = \"other\"\n",
    );
    let plan = sandbox.plan(None).await;
    assert_eq!(plan.key.default, "notes-acme-dev-2");
    // what a replace would overwrite: only under the item's name
    assert_eq!(plan.key.conflicts.len(), 1);

    // an agent that is not installed does not move the default
    sandbox.write(
        McpAppType::Kiro,
        r#"{ "mcpServers": { "notes": { "command": "x" } } }"#,
    );
    sandbox.write(McpAppType::ClaudeCode, "{}");
    sandbox.write(McpAppType::Codex, "");
    let plan = sandbox.plan(None).await;
    assert_eq!(plan.key.default, "notes");
    assert_eq!(plan.key.conflicts[0].agent, McpAppType::Kiro);

    // long names are cut to 64, a dash or not
    let taken = |key: &str| key.len() < 70;
    let long = super::default_key(&"n".repeat(60), "a.very.long.publisher", |key| {
        key == "n".repeat(60) || (taken(key) && !key.ends_with("-2"))
    });
    assert!(long.len() <= 64 && long.ends_with("-2"), "{long}");
    assert_eq!(super::default_key("x", "p.q", |key| key == "x"), "x-p-q");
}

// ─── Installing ─────────────────────────────────────────────────────────

#[tokio::test]
async fn an_install_writes_through_the_engine_and_records_it_under_the_lock() {
    let sandbox = Sandbox::new().await;
    let mut events = sandbox.events.subscribe();
    let plan = sandbox.plan(None).await;
    let targets = [
        McpAppType::ClaudeCode,
        McpAppType::Codex,
        McpAppType::Gemini,
    ];
    let request = sandbox.request(&plan, &targets, "notes");

    // The record is written while the MCP write lock is still held.
    let held: Rc<RefCell<Option<Option<McpLockError>>>> = Rc::default();
    let _hook = HookGuard;
    {
        let held = held.clone();
        let lock_path = sandbox.local.engine.lock_path.clone();
        record::hooks::set_before_save(Some(Box::new(move |_| {
            *held.borrow_mut() =
                Some(acquire_blocking_at(&lock_path, Duration::from_millis(60)).err());
        })));
    }
    let result = sandbox.install(request).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    assert_eq!(
        *held.borrow(),
        Some(Some(McpLockError::Busy)),
        "saved without the lock"
    );
    let apply = result.apply.as_ref().unwrap();
    assert_eq!(apply.outcome, McpApplyOutcome::Applied);
    assert!(apply
        .agents
        .iter()
        .all(|agent| agent.status == McpAgentStatus::Written));
    assert_eq!(result.record.as_ref().unwrap().status, "written");

    // Each agent's file, in its own spelling, the rest of it kept.
    let claude: Value =
        serde_json::from_str(&sandbox.read(McpAppType::ClaudeCode).unwrap()).unwrap();
    assert_eq!(claude["numStartups"], 3);
    assert_eq!(
        claude["mcpServers"]["notes"],
        json!({ "type": "stdio", "command": "npx", "args": ["-y", "@acme/notes-mcp@1.2.3"],
                "env": { "NOTES_TOKEN": "t0ken" } })
    );
    let codex = sandbox.read(McpAppType::Codex).unwrap();
    assert!(
        codex.starts_with("# mine\nmodel = \"gpt-5.5\"\n"),
        "{codex}"
    );
    let codex: toml::Table = codex.parse().unwrap();
    assert_eq!(
        codex["mcp_servers"]["notes"]["args"][1].as_str(),
        Some("@acme/notes-mcp@1.2.3")
    );
    for agent in targets {
        assert_eq!(
            sandbox.entry(agent, "notes").unwrap().definition,
            Some(npx("1.2.3", "t0ken"))
        );
    }
    assert!(sandbox.read(McpAppType::Cline).is_none(), "not a target");

    // The record: what was written where, as the agent reads it back.
    let record = sandbox.record().unwrap();
    let item = &record["items"][ID];
    assert_eq!(item["ref"], REF);
    assert_eq!(item["key"], "notes");
    let agents: Vec<&String> = item["agents"].as_object().unwrap().keys().collect();
    assert_eq!(agents, ["claude_code", "codex", "gemini"]);
    let claude = &item["agents"]["claude_code"];
    assert_eq!(claude["revision"], 3);
    assert_eq!(claude["version"], "3.0.0");
    assert_eq!(claude["option"], "official:package:0:stdio");
    assert_eq!(claude["transport"], "stdio");
    assert_eq!(
        claude["packages"],
        json!([{ "registry_type": "npm", "identifier": PACKAGE, "version": "1.2.3" }])
    );
    assert_eq!(claude["state_sha256"], json!(sandbox.site.sha("s3-a")));
    assert_eq!(
        claude["definition_sha256"],
        sandbox
            .entry(McpAppType::ClaudeCode, "notes")
            .unwrap()
            .fingerprint
            .unwrap()
    );
    assert!(
        !record.to_string().contains("t0ken"),
        "no secret in the record"
    );

    // Both events: the engine's, and the record's — names, no content.
    let seen = drain(&mut events);
    let channels: Vec<&str> = seen.iter().map(|(channel, _)| channel.as_str()).collect();
    assert_eq!(channels, ["mcp://changed", INSTALLED_CHANGED_EVENT]);
    assert_eq!(
        seen[1].1,
        json!({ "item_ids": [ID], "agents": ["claude_code", "codex", "gemini"] })
    );
    assert!(!seen
        .iter()
        .any(|(_, payload)| payload.to_string().contains("t0ken")));

    // The listing says so.
    let listing = sandbox.listing().await;
    assert_eq!(listing.len(), 1);
    assert_eq!(listing[0].key, "notes");
    assert_eq!(listing[0].state, LocalState::AsInstalled);
    assert_eq!(listing[0].revision, 3);
    assert!(listing[0]
        .agents
        .iter()
        .all(|agent| agent.state == LocalState::AsInstalled));
}

#[tokio::test]
async fn a_config_changed_after_the_plan_stops_the_install_before_anything_is_written() {
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;
    let request = sandbox.request(
        &plan,
        &[McpAppType::ClaudeCode, McpAppType::Gemini],
        "notes",
    );
    sandbox.write(McpAppType::Gemini, r#"{ "theme": "dark" }"#);
    let before = sandbox.files();
    let asked = sandbox.site.requests();

    let result = sandbox.install(request).await;
    assert_eq!(result.outcome, InstallOutcome::ChangedElsewhere);
    let apply = result.apply.unwrap();
    assert_eq!(apply.outcome, McpApplyOutcome::ChangedElsewhere);
    assert!(apply
        .agents
        .iter()
        .any(|agent| agent.agent == McpAppType::Gemini
            && agent.status == McpAgentStatus::ChangedElsewhere));
    assert_eq!(sandbox.files(), before, "nothing written");
    assert!(sandbox.record().is_none());
    // stopped before the snapshot was asked for again
    let resolves = sandbox.site.catalog.lock().unwrap().seen[asked..]
        .iter()
        .filter(|(_, path)| path.ends_with("/resolve"))
        .count();
    assert_eq!(resolves, 0);
}

#[tokio::test]
async fn a_snapshot_that_changed_is_listed_and_confirmed_again() {
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;
    let request = sandbox.request(&plan, &[McpAppType::ClaudeCode], "notes");
    let changed = sandbox.site.sha("s3-b");
    sandbox.site.resolve(3, |resolved| {
        resolved["installed"]["risk"] = json!("medium");
        resolved["installed"]["permissions"]["detected"]["network"] =
            json!(["mcp.acme.dev", "x.example"]);
        resolved["installed"]["stateSha256"] = json!(changed.clone());
    });
    let before = sandbox.files();

    let result = sandbox.install(request.clone()).await;
    assert_eq!(result.outcome, InstallOutcome::StateChanged);
    assert_eq!(
        codes_of(&result.changes),
        [codes::RISK_CHANGED, codes::PERMISSION_ADDED]
    );
    assert_eq!(result.changes[0].params["to"], "medium");
    assert_eq!(result.changes[1].params["value"], "x.example");
    assert_eq!(result.state_sha256.as_deref(), Some(changed.as_str()));
    assert_eq!(
        result.snapshot.as_ref().unwrap().state_sha256.as_deref(),
        Some(changed.as_str())
    );
    assert_eq!(sandbox.files(), before, "nothing written");
    assert!(sandbox.record().is_none());

    // Confirmed again, with the new fingerprint: installed.
    let again = HarnessMcpInstallRequest {
        state_sha256: changed.clone(),
        ..request
    };
    let result = sandbox.install(again).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    assert_eq!(
        sandbox.record().unwrap()["items"][ID]["agents"]["claude_code"]["state_sha256"],
        json!(changed)
    );
}

#[tokio::test]
async fn a_version_that_became_uninstallable_aborts_the_install() {
    let changes: [fn(&mut Value); 4] = [
        |resolved: &mut Value| resolved["installed"]["status"] = json!("blocked"),
        |resolved: &mut Value| resolved["installed"]["packages"][0]["verified"] = json!("missing"),
        |resolved: &mut Value| resolved["installed"]["packages"][0]["version"] = json!(null),
        |resolved: &mut Value| {
            *resolved =
                json!({ "status": "removed", "installed": { "revision": 3, "status": "ok" } })
        },
    ];
    for change in changes {
        let sandbox = Sandbox::new().await;
        let plan = sandbox.plan(None).await;
        let request = sandbox.request(&plan, &[McpAppType::ClaudeCode, McpAppType::Codex], "notes");
        sandbox.site.resolve(3, change);
        let before = sandbox.files();

        let result = sandbox.install(request).await;
        assert_eq!(result.outcome, InstallOutcome::Aborted, "{result:?}");
        assert_eq!(result.issues.len(), 1, "{:?}", result.issues);
        assert!([
            codes::VERSION_BLOCKED,
            codes::PACKAGE_MISSING,
            codes::PACKAGE_VERSION_INEXACT,
            codes::ITEM_UNAVAILABLE
        ]
        .contains(&result.issues[0].code.as_str()));
        assert_eq!(sandbox.files(), before, "nothing written");
        assert!(sandbox.record().is_none());
    }
}

#[tokio::test]
async fn a_yanked_version_installs_only_when_the_call_accepts_it() {
    let sandbox = Sandbox::new().await;
    sandbox.site.resolve(3, |resolved| {
        resolved["installed"]["status"] = json!("yanked")
    });
    let plan = sandbox.plan(None).await;
    assert_eq!(codes_of(&plan.confirm), [codes::YANKED]);
    let request = sandbox.request(&plan, &[McpAppType::Gemini], "notes");
    let refused = sandbox.install(request.clone()).await;
    assert_eq!(refused.outcome, InstallOutcome::Refused);
    assert_eq!(codes_of(&refused.issues), [codes::YANKED_NOT_ACCEPTED]);
    assert!(sandbox.read(McpAppType::Gemini).is_none());
    let accepted = sandbox
        .install(HarnessMcpInstallRequest {
            accept_yanked: true,
            ..request
        })
        .await;
    assert_eq!(accepted.outcome, InstallOutcome::Installed);
}

#[tokio::test]
async fn a_name_already_taken_is_replaced_only_when_the_call_says_so() {
    let sandbox = Sandbox::new().await;
    sandbox.write(
        McpAppType::ClaudeCode,
        r#"{ "mcpServers": { "notes": { "command": "my-notes", "args": ["--fast"] } } }"#,
    );
    let plan = sandbox.plan(None).await;
    let request = sandbox.request(
        &plan,
        &[McpAppType::ClaudeCode, McpAppType::Gemini],
        "notes",
    );
    let before = sandbox.files();
    let result = sandbox.install(request.clone()).await;
    assert_eq!(result.outcome, InstallOutcome::Refused);
    assert_eq!(codes_of(&result.issues), [codes::REPLACE_REQUIRED]);
    assert_eq!(result.issues[0].params["agent"], "claude_code");
    assert_eq!(sandbox.files(), before, "nothing written");

    let result = sandbox
        .install(HarnessMcpInstallRequest {
            replace: vec![McpAppType::ClaudeCode],
            ..request
        })
        .await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    assert_eq!(
        sandbox
            .entry(McpAppType::ClaudeCode, "notes")
            .unwrap()
            .definition,
        Some(npx("1.2.3", "t0ken"))
    );
}

#[tokio::test]
async fn the_call_is_checked_before_anything_is_asked_or_written() {
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;
    let base = sandbox.request(&plan, &[McpAppType::Gemini], "notes");
    let asked = sandbox.site.requests();
    for (request, code) in [
        (
            HarnessMcpInstallRequest {
                key: "codeg-mcp".into(),
                ..base.clone()
            },
            codes::KEY_RESERVED,
        ),
        (
            HarnessMcpInstallRequest {
                key: "no spaces".into(),
                ..base.clone()
            },
            codes::KEY_INVALID,
        ),
        (
            HarnessMcpInstallRequest {
                agents: vec![],
                basis: BTreeMap::new(),
                ..base.clone()
            },
            codes::NO_TARGETS,
        ),
        (
            HarnessMcpInstallRequest {
                replace: vec![McpAppType::Codex],
                ..base.clone()
            },
            codes::REPLACE_NOT_TARGET,
        ),
        (
            HarnessMcpInstallRequest {
                basis: BTreeMap::new(),
                ..base.clone()
            },
            codes::BASIS_REQUIRED,
        ),
    ] {
        let result = sandbox.install(request).await;
        assert_eq!(result.outcome, InstallOutcome::Refused);
        assert_eq!(codes_of(&result.issues), [code]);
    }
    assert_eq!(sandbox.site.requests(), asked, "refused without a request");

    for (request, code) in [
        (
            HarnessMcpInstallRequest {
                option_id: "official:package:7:stdio".into(),
                ..base.clone()
            },
            codes::OPTION_NOT_FOUND,
        ),
        (
            HarnessMcpInstallRequest {
                values: BTreeMap::new(),
                ..base.clone()
            },
            codes::PARAMETER_REQUIRED,
        ),
    ] {
        let result = sandbox.install(request).await;
        assert_eq!(result.outcome, InstallOutcome::Refused);
        assert_eq!(codes_of(&result.issues), [code]);
    }
    assert!(sandbox.read(McpAppType::Gemini).is_none());

    // A transport the agent cannot take: the engine's preflight says so.
    let sse_only = HarnessMcpInstallRequest {
        option_id: "official:remote:0:http".into(),
        values: BTreeMap::from([("headers.Authorization".into(), "Bearer t".into())]),
        agents: vec![McpAppType::ZCode],
        basis: BTreeMap::from([(McpAppType::ZCode, plan.basis[&McpAppType::ZCode].clone())]),
        ..base.clone()
    };
    let result = sandbox.install(sse_only).await;
    assert_eq!(result.outcome, InstallOutcome::Invalid);
    assert!(sandbox.read(McpAppType::ZCode).is_none());
}

#[tokio::test]
async fn a_remote_address_that_is_not_public_once_filled_in_writes_nothing() {
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;
    let templated = |host: &str| HarnessMcpInstallRequest {
        option_id: "official:remote:1:http".into(),
        values: BTreeMap::from([("variables.host".into(), host.into())]),
        ..sandbox.request(
            &plan,
            &[McpAppType::ClaudeCode, McpAppType::Gemini],
            "notes",
        )
    };
    let before = sandbox.files();
    for host in [
        "127.0.0.1",
        "10.1.2.3",
        "intranet",
        "printer.local",
        "localhost",
        // what the site's own rule lets through (review finding)
        "localhost.",
        "198.18.0.5",
    ] {
        let result = sandbox.install(templated(host)).await;
        assert_eq!(result.outcome, InstallOutcome::Refused, "{host}");
        assert_eq!(
            codes_of(&result.issues),
            [codes::REMOTE_NOT_PUBLIC],
            "{host}"
        );
        assert_eq!(sandbox.files(), before, "{host}: nothing written");
    }
    let result = sandbox.install(templated("mcp.acme.dev")).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    assert_eq!(
        sandbox
            .entry(McpAppType::Gemini, "notes")
            .unwrap()
            .definition,
        Some(McpDefinition::Http {
            url: "https://mcp.acme.dev/mcp".into(),
            headers: BTreeMap::new()
        })
    );
}

#[tokio::test]
async fn an_update_replaces_the_recorded_entries_with_the_newer_revision() {
    let sandbox = Sandbox::new().await;
    let first = sandbox
        .install_to(&[McpAppType::ClaudeCode, McpAppType::Codex])
        .await;
    assert_eq!(first.outcome, InstallOutcome::Installed);
    sandbox.site.publish(4, "1.3.0", "s4-a");

    let plan = sandbox.plan(None).await;
    assert_eq!(plan.item.revision, 4);
    let installed = plan.installed.as_ref().expect("recorded");
    assert_eq!(installed.revision, 3);
    assert_eq!(plan.key.default, "notes");
    let option = &plan.options[0];
    assert_eq!(
        option.default_targets,
        [McpAppType::ClaudeCode, McpAppType::Codex]
    );
    assert_eq!(
        option.default_replace,
        [McpAppType::ClaudeCode, McpAppType::Codex]
    );
    let conflicts: Vec<(McpAppType, EntryOwner, Option<LocalState>)> = plan
        .key
        .conflicts
        .iter()
        .map(|conflict| (conflict.agent, conflict.owner, conflict.state))
        .collect();
    assert_eq!(
        conflicts,
        [
            (
                McpAppType::ClaudeCode,
                EntryOwner::ThisItem,
                Some(LocalState::AsInstalled)
            ),
            (
                McpAppType::Codex,
                EntryOwner::ThisItem,
                Some(LocalState::AsInstalled)
            ),
        ]
    );

    // without saying replace, the update is refused; saying it, it is done
    let request = sandbox.request(&plan, &option.default_targets, &plan.key.default);
    let refused = sandbox.install(request.clone()).await;
    assert_eq!(
        codes_of(&refused.issues),
        [codes::REPLACE_REQUIRED, codes::REPLACE_REQUIRED]
    );
    let result = sandbox
        .install(HarnessMcpInstallRequest {
            replace: option.default_replace.clone(),
            ..request
        })
        .await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    for agent in [McpAppType::ClaudeCode, McpAppType::Codex] {
        assert_eq!(
            sandbox.entry(agent, "notes").unwrap().definition,
            Some(npx("1.3.0", "t0ken"))
        );
    }
    let record = sandbox.record().unwrap();
    for agent in ["claude_code", "codex"] {
        assert_eq!(record["items"][ID]["agents"][agent]["revision"], 4);
        assert_eq!(
            record["items"][ID]["agents"][agent]["packages"][0]["version"],
            "1.3.0"
        );
    }
    // under another name it is refused: update it under its own
    let other = sandbox.request(
        &sandbox.plan(None).await,
        &[McpAppType::Gemini],
        "notes-two",
    );
    let result = sandbox.install(other).await;
    assert_eq!(codes_of(&result.issues), [codes::INSTALLED_UNDER_OTHER_KEY]);
    assert_eq!(result.issues[0].params["key"], "notes");
}

#[tokio::test]
async fn an_update_to_some_agents_leaves_the_others_at_their_revision() {
    let sandbox = Sandbox::new().await;
    sandbox
        .install_to(&[McpAppType::ClaudeCode, McpAppType::Codex])
        .await;
    sandbox.site.publish(4, "1.3.0", "s4-a");
    let plan = sandbox.plan(None).await;
    let request = HarnessMcpInstallRequest {
        replace: vec![McpAppType::Codex],
        ..sandbox.request(&plan, &[McpAppType::Codex], "notes")
    };
    assert_eq!(
        sandbox.install(request).await.outcome,
        InstallOutcome::Installed
    );
    let listing = sandbox.listing().await;
    let revisions: Vec<(McpAppType, u64)> = listing[0]
        .agents
        .iter()
        .map(|agent| (agent.agent, agent.revision))
        .collect();
    assert_eq!(
        revisions,
        [(McpAppType::ClaudeCode, 3), (McpAppType::Codex, 4)]
    );
    assert_eq!(listing[0].revision, 3, "an update starts from the oldest");
    assert_eq!(listing[0].state, LocalState::AsInstalled);
}

/// Clears the engine's injected steps when a test ends, however it ends.
struct EngineHooksGuard;

impl Drop for EngineHooksGuard {
    fn drop(&mut self) {
        crate::commands::mcp_engine::apply::hooks::after_write(None);
    }
}

/// Review finding: the record must hold what the engine wrote. An agent that
/// edits its config right after the write (the agents take no lock) must not
/// have that edit recorded as "as installed" — a later uninstall would then
/// remove the user's change without asking.
#[tokio::test]
async fn an_edit_made_right_after_the_write_is_not_recorded_as_installed() {
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;
    let request = sandbox.request(
        &plan,
        &[McpAppType::ClaudeCode, McpAppType::Gemini],
        "notes",
    );
    let claude = sandbox.path(McpAppType::ClaudeCode);
    let edited = Rc::new(std::cell::Cell::new(false));
    let _hooks = EngineHooksGuard;
    crate::commands::mcp_engine::apply::hooks::after_write(Some(Box::new({
        let edited = edited.clone();
        move |path: &std::path::Path| {
            if path == claude && !edited.get() {
                edited.set(true);
                let text = std::fs::read_to_string(path).unwrap();
                std::fs::write(path, text.replace("t0ken", "the-agent-s-own")).unwrap();
            }
        }
    })));

    let result = sandbox.install(request).await;
    assert_eq!(result.outcome, InstallOutcome::Installed, "{result:?}");
    assert!(
        edited.get(),
        "the edit happened between the write and the record"
    );
    let record = sandbox.record().unwrap();
    assert_eq!(
        record["items"][ID]["agents"]["claude_code"]["definition_sha256"],
        json!(npx("1.2.3", "t0ken").fingerprint()),
        "what the engine wrote, not what the agent made of it"
    );

    let listing = sandbox.listing().await;
    let states: Vec<(McpAppType, LocalState)> = listing[0]
        .agents
        .iter()
        .map(|agent| (agent.agent, agent.state))
        .collect();
    assert_eq!(
        states,
        [
            (McpAppType::ClaudeCode, LocalState::ChangedLocally),
            (McpAppType::Gemini, LocalState::AsInstalled),
        ]
    );
    let check = sandbox
        .uninstall(HarnessMcpUninstallRequest {
            item_id: ID.into(),
            preflight: true,
            ..Default::default()
        })
        .await;
    assert_eq!(check.agents[0].action, UninstallAction::KeepChanged);
}

/// Review finding: two installs of one item that both read an empty record
/// and chose different names must not end with the second one's record
/// throwing the first one's agents away. The second is checked again under
/// the lock, before it writes anything, and refused.
#[tokio::test]
async fn an_install_under_another_name_made_meanwhile_is_not_overwritten() {
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;
    let request = sandbox.request(&plan, &[McpAppType::Gemini], "notes");
    // Another Codeg installs it under another name into Claude Code while
    // this one is between its checks and its commit.
    let record_path = sandbox.local.record_path.clone();
    let theirs = json!({ "format": 1, "items": { ID: { "ref": REF, "key": "notes-acme-dev", "agents": {
        "claude_code": { "revision": 3, "version": "3.0.0", "option": "official:package:0:stdio",
                         "transport": "stdio", "packages": [], "definition_sha256": "theirs",
                         "state_sha256": "theirs", "installed_at": "2026-11-16T00:00:00.000Z" } } } } });
    sandbox.site.catalog.lock().unwrap().on_resolve = Some(Box::new({
        let theirs = theirs.clone();
        move || {
            std::fs::create_dir_all(record_path.parent().unwrap()).unwrap();
            std::fs::write(&record_path, theirs.to_string()).unwrap();
        }
    }));
    let before = sandbox.files();

    let result = sandbox.install(request).await;
    assert_eq!(result.outcome, InstallOutcome::Refused, "{result:?}");
    assert_eq!(codes_of(&result.issues), [codes::INSTALLED_UNDER_OTHER_KEY]);
    assert_eq!(result.issues[0].params["key"], "notes-acme-dev");
    assert_eq!(sandbox.files(), before, "nothing written");
    assert_eq!(
        sandbox.record().unwrap(),
        theirs,
        "their record kept as it was"
    );
}

/// The engine's guarded commit (what the check above runs under): a guard
/// that refuses calls the save off before anything is written, the step
/// after it does not run, and the lock is let go.
#[tokio::test]
async fn a_guard_that_refuses_calls_the_save_off_under_the_lock() {
    use crate::commands::mcp_engine::model::{McpApplyRequest, McpOp, McpOpAction};
    let sandbox = Sandbox::new().await;
    let lock_path = sandbox.local.engine.lock_path.clone();
    let request = McpApplyRequest {
        basis: BTreeMap::from([(McpAppType::Gemini, "missing".to_string())]),
        ops: vec![McpOp {
            agent: McpAppType::Gemini,
            key: "x".into(),
            action: McpOpAction::Set {
                definition: npx("1.0.0", "t"),
            },
        }],
        preflight: false,
    };
    let ran = std::cell::Cell::new(false);
    let refused = crate::commands::mcp_engine::apply_in_guarded(
        &sandbox.local.engine,
        &request,
        || {
            // the lock is held while the guard runs
            assert_eq!(
                acquire_blocking_at(&lock_path, Duration::from_millis(60)).err(),
                Some(McpLockError::Busy)
            );
            Err("refused")
        },
        |_| ran.set(true),
    )
    .await;
    assert_eq!(refused.err(), Some("refused"));
    assert!(!ran.get());
    assert!(
        sandbox.read(McpAppType::Gemini).is_none(),
        "nothing written"
    );
    assert!(
        acquire_blocking_at(&lock_path, LOCK_WAIT).is_ok(),
        "the lock was let go"
    );

    let (applied, after) = crate::commands::mcp_engine::apply_in_guarded(
        &sandbox.local.engine,
        &request,
        || Ok::<(), ()>(()),
        |result| result.outcome,
    )
    .await
    .unwrap();
    assert_eq!(applied.outcome, McpApplyOutcome::Applied);
    assert_eq!(after, Some(McpApplyOutcome::Applied));
}

// ─── What the dialog needs beyond the first version ─────────────────────

/// An update must not drop what the user entered at install: the plan reads
/// each agent's own entry back into the parameters of the option it was
/// installed with, flags where they disagree, and names what it cannot carry.
#[tokio::test]
async fn an_update_plan_reads_back_what_the_installed_entries_hold() {
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;
    // stdio into Claude Code and Codex, with an optional value as well
    let mut request = sandbox.request(&plan, &[McpAppType::ClaudeCode, McpAppType::Codex], "notes");
    request
        .values
        .insert("env.NOTES_DIR".to_string(), "/home/me/notes".to_string());
    assert_eq!(
        sandbox.install(request).await.outcome,
        InstallOutcome::Installed
    );
    // Codex's token changed by hand since, and a variable of the user's own
    let codex = sandbox.read(McpAppType::Codex).unwrap().replace(
        "NOTES_TOKEN = \"t0ken\"",
        "NOTES_TOKEN = \"rotated\"\nNOTES_EXTRA = \"mine\"",
    );
    sandbox.write(McpAppType::Codex, &codex);

    sandbox.site.publish(4, "1.3.0", "s4-a");
    let plan = sandbox.plan(None).await;
    let stdio = &plan.options[0];
    let current = |key: &str| {
        stdio
            .parameters
            .iter()
            .find(|parameter| parameter.key == key)
            .and_then(|parameter| parameter.current.clone())
    };
    let token = current("env.NOTES_TOKEN").expect("the token was recovered");
    assert_eq!(token.value, "t0ken");
    assert_eq!(token.agents, [McpAppType::ClaudeCode, McpAppType::Codex]);
    assert!(token.conflicting, "Codex holds another one");
    let dir = current("env.NOTES_DIR").unwrap();
    assert_eq!(dir.value, "/home/me/notes");
    assert!(!dir.conflicting);
    let recovery = stdio.recovery.as_ref().unwrap();
    assert_eq!(recovery.from, [McpAppType::ClaudeCode, McpAppType::Codex]);
    assert!(recovery.unmatched.is_empty());
    assert_eq!(
        recovery.lost,
        [LostValue {
            key: "env.NOTES_EXTRA".into(),
            agents: vec![McpAppType::Codex]
        }]
    );
    // the other options were not installed: nothing read for them
    assert!(plan.options[1].recovery.is_none());
    assert!(plan.options[1]
        .parameters
        .iter()
        .all(|parameter| parameter.current.is_none()));

    // the values are the entries' own: they reach the plan, never an event
    let mut events = sandbox.events.subscribe();
    let _ = sandbox.listing().await;
    assert!(!drain(&mut events)
        .iter()
        .any(|(_, payload)| payload.to_string().contains("t0ken")));
}

#[tokio::test]
async fn an_address_variable_is_read_back_by_the_option_s_template() {
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;
    let request = HarnessMcpInstallRequest {
        option_id: "official:remote:1:http".into(),
        values: BTreeMap::from([("variables.host".into(), "mcp.acme.dev".into())]),
        ..sandbox.request(&plan, &[McpAppType::Gemini, McpAppType::Cline], "notes")
    };
    assert_eq!(
        sandbox.install(request).await.outcome,
        InstallOutcome::Installed
    );
    // Cline's address moved by hand: the host can no longer be read from it
    let cline = sandbox
        .read(McpAppType::Cline)
        .unwrap()
        .replace("https://mcp.acme.dev/mcp", "https://mcp.acme.dev/v2/mcp");
    sandbox.write(McpAppType::Cline, &cline);

    let plan = sandbox.plan(None).await;
    assert_eq!(
        plan.default_option.as_deref(),
        Some("official:remote:1:http")
    );
    let templated = plan
        .options
        .iter()
        .find(|option| option.id == "official:remote:1:http")
        .unwrap();
    let host = templated.parameters[0].current.clone().unwrap();
    assert_eq!(host.value, "mcp.acme.dev");
    assert_eq!(host.agents, [McpAppType::Gemini]);
    assert!(host.conflicting);
    assert_eq!(
        templated.recovery.as_ref().unwrap().lost,
        [LostValue {
            key: "variables.host".into(),
            agents: vec![McpAppType::Cline]
        }]
    );
}

/// Review finding: the same option can write its address otherwise in the
/// next revision. An installed entry is read with the template of the
/// revision it was installed from, and carried over by name — the secret
/// stays the secret.
#[tokio::test]
async fn an_update_reads_values_with_the_template_they_were_written_with() {
    let sandbox = Sandbox::new().await;
    let variables = json!({ "tenant": { "isRequired": true },
                            "token": { "isRequired": true, "isSecret": true } });
    let server = |url: &str| {
        json!({ "name": "dev.acme/notes",
        "remotes": [{ "type": "streamable-http", "url": url, "variables": variables.clone() }] })
    };
    sandbox.site.publish_server(
        4,
        "s4-a",
        server("https://mcp.acme.dev/{token}/{tenant}/mcp"),
    );
    let plan = sandbox.plan(Some(4)).await;
    let request = HarnessMcpInstallRequest {
        option_id: "official:remote:0:http".into(),
        values: BTreeMap::from([
            ("variables.tenant".into(), "acme".into()),
            ("variables.token".into(), "demo-secret".into()),
        ]),
        ..sandbox.request(&plan, &[McpAppType::Gemini], "notes")
    };
    assert_eq!(
        sandbox.install(request).await.outcome,
        InstallOutcome::Installed
    );
    assert!(sandbox
        .read(McpAppType::Gemini)
        .unwrap()
        .contains("/demo-secret/acme/mcp"));

    sandbox.site.publish_server(
        5,
        "s5-a",
        server("https://mcp.acme.dev/{tenant}/{token}/mcp"),
    );
    let plan = sandbox.plan(None).await;
    assert_eq!(plan.item.revision, 5);
    let option = &plan.options[0];
    let current = |key: &str| {
        option
            .parameters
            .iter()
            .find(|parameter| parameter.key == key)
            .and_then(|parameter| parameter.current.clone())
    };
    assert_eq!(current("variables.tenant").unwrap().value, "acme");
    assert_eq!(current("variables.token").unwrap().value, "demo-secret");
    assert!(option
        .parameters
        .iter()
        .any(|parameter| parameter.key == "variables.token" && parameter.secret));
    assert!(option.recovery.as_ref().unwrap().lost.is_empty());

    // The recorded revision's definition is gone: nothing is guessed.
    sandbox.site.withdraw(4);
    let plan = sandbox.plan(None).await;
    let option = &plan.options[0];
    assert!(option
        .parameters
        .iter()
        .all(|parameter| parameter.current.is_none()));
    assert_eq!(
        option.recovery.as_ref().unwrap().unmatched,
        [McpAppType::Gemini]
    );
}

/// The agents' side of the dialog: why one cannot be written, and who owns
/// every name already in its config (for a name the user types).
#[tokio::test]
async fn the_plan_says_why_an_agent_cannot_be_written_and_who_owns_each_name() {
    let sandbox = Sandbox::new().await;
    assert_eq!(
        sandbox.install_to(&[McpAppType::ClaudeCode]).await.outcome,
        InstallOutcome::Installed
    );
    let claude: Value =
        serde_json::from_str(&sandbox.read(McpAppType::ClaudeCode).unwrap()).unwrap();
    let mut claude = claude;
    claude["mcpServers"]["mine"] = json!({ "command": "my-tool" });
    sandbox.write(McpAppType::ClaudeCode, &claude.to_string());
    sandbox.write(McpAppType::Cursor, "{ \"mcpServers\": ");

    let plan = sandbox.plan(None).await;
    let agent = |app: McpAppType| plan.agents.iter().find(|agent| agent.agent == app).unwrap();
    let mut entries: Vec<(&str, EntryOwner, Option<&str>)> = agent(McpAppType::ClaudeCode)
        .entries
        .iter()
        .map(|entry| (entry.key.as_str(), entry.owner, entry.item_ref.as_deref()))
        .collect();
    entries.sort();
    assert_eq!(
        entries,
        [
            ("mine", EntryOwner::Elsewhere, None),
            ("notes", EntryOwner::ThisItem, Some(REF)),
        ]
    );
    assert!(agent(McpAppType::ClaudeCode).reason.is_none());
    let cursor = agent(McpAppType::Cursor);
    assert!(!cursor.writable);
    assert_eq!(cursor.reason.as_ref().unwrap().code, "invalid_json");
    // listed only, and no file at all: still a reason
    let open_claw = agent(McpAppType::OpenClaw);
    assert!(!open_claw.writable);
    assert_eq!(open_claw.reason.as_ref().unwrap().code, "managed_by_agent");
    // the wire: names only, no definitions
    let wire = serde_json::to_value(&plan).unwrap();
    let claude_wire = wire["agents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|agent| agent["agent"] == "claude_code")
        .unwrap();
    let mine = claude_wire["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["key"] == "mine")
        .unwrap();
    assert_eq!(
        *mine,
        json!({ "key": "mine", "owner": "elsewhere", "item_id": null, "item_ref": null })
    );

    // and the listing names the item, as the catalog titled it
    let listing = sandbox.listing().await;
    assert_eq!(
        listing[0].title.as_ref().unwrap().en.as_deref(),
        Some("Notes")
    );
}

/// QA finding: a site without `/resolve` answers it 404 — not "no item at
/// this address", which the dialog said about an item whose detail had just
/// loaded. Plan and install both say SpaceRing cannot confirm its state,
/// and the install writes nothing.
#[tokio::test]
async fn a_resolve_the_site_does_not_serve_is_not_a_missing_item() {
    let sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;
    let request = sandbox.request(
        &plan,
        &[McpAppType::ClaudeCode, McpAppType::Gemini],
        "notes",
    );
    sandbox.site.catalog.lock().unwrap().resolve_missing = true;

    let error = plan_error(&sandbox, None).await;
    assert_eq!(
        error.i18n_key.as_deref(),
        Some("Harness.errors.resolveUnavailable")
    );
    let before = sandbox.files();
    let error = install(&sandbox.local, &sandbox.harness, &sandbox.emitter, request)
        .await
        .unwrap_err();
    assert_eq!(
        error.i18n_key.as_deref(),
        Some("Harness.errors.resolveUnavailable")
    );
    assert_eq!(sandbox.files(), before, "nothing written");
    assert!(sandbox.record().is_none());
}

// ─── Listing and uninstalling ───────────────────────────────────────────

#[tokio::test]
async fn the_scan_drops_what_is_gone_and_keeps_what_cannot_be_read() {
    let sandbox = Sandbox::new().await;
    let result = sandbox.install_to(&INSTALLED).await;
    assert_eq!(result.outcome, InstallOutcome::Installed);
    let mut events = sandbox.events.subscribe();

    // Claude's entry edited by hand, Codex's removed, Gemini's file broken.
    let claude = sandbox
        .read(McpAppType::ClaudeCode)
        .unwrap()
        .replace("t0ken", "edited");
    sandbox.write(McpAppType::ClaudeCode, &claude);
    sandbox.write(McpAppType::Codex, "# mine\nmodel = \"gpt-5.5\"\n");
    sandbox.write(McpAppType::Gemini, "{ \"mcpServers\": ");

    let listing = sandbox.listing().await;
    let states: Vec<(McpAppType, LocalState)> = listing[0]
        .agents
        .iter()
        .map(|agent| (agent.agent, agent.state))
        .collect();
    assert_eq!(
        states,
        [
            (McpAppType::ClaudeCode, LocalState::ChangedLocally),
            (McpAppType::Codex, LocalState::Missing),
            (McpAppType::Gemini, LocalState::Unknown),
            (McpAppType::Cline, LocalState::AsInstalled),
        ]
    );
    assert_eq!(listing[0].state, LocalState::ChangedLocally);

    // Only the one that is gone was forgotten, and that was announced.
    let record = sandbox.record().unwrap();
    let agents: Vec<&String> = record["items"][ID]["agents"]
        .as_object()
        .unwrap()
        .keys()
        .collect();
    assert_eq!(agents, ["claude_code", "cline", "gemini"]);
    assert_eq!(
        drain(&mut events),
        [(
            INSTALLED_CHANGED_EVENT.to_string(),
            json!({ "item_ids": [ID], "agents": ["codex"] })
        )]
    );
    let again = sandbox.listing().await;
    assert_eq!(again[0].agents.len(), 3);
    assert!(drain(&mut events).is_empty(), "nothing more to forget");

    // Every entry gone: the item goes.
    sandbox.write(McpAppType::ClaudeCode, "{}");
    sandbox.write(McpAppType::Gemini, "{}");
    sandbox.write(McpAppType::Cline, "{}");
    let gone = sandbox.listing().await;
    assert!(gone[0]
        .agents
        .iter()
        .all(|agent| agent.state == LocalState::Missing));
    assert_eq!(gone[0].state, LocalState::Missing);
    assert_eq!(sandbox.record().unwrap()["items"], json!({}));
    assert!(sandbox.listing().await.is_empty());
}

#[tokio::test]
async fn an_unreadable_record_is_an_error_and_never_overwritten() {
    let sandbox = Sandbox::new().await;
    std::fs::create_dir_all(sandbox.local.record_path.parent().unwrap()).unwrap();
    std::fs::write(&sandbox.local.record_path, "{ broken").unwrap();
    let error = installed(&sandbox.local, &sandbox.emitter)
        .await
        .unwrap_err();
    assert_eq!(
        error.i18n_key.as_deref(),
        Some(super::I18N_KEY_RECORD_UNREADABLE)
    );
    let plan = sandbox.plan(None).await;
    assert_eq!(codes_of(&plan.blocking), [codes::RECORD_UNREADABLE]);
    let result = sandbox
        .install(sandbox.request(&plan, &[McpAppType::Gemini], "notes"))
        .await;
    assert_eq!(codes_of(&result.issues), [codes::RECORD_UNREADABLE]);
    assert!(sandbox.read(McpAppType::Gemini).is_none());
    assert_eq!(
        std::fs::read_to_string(&sandbox.local.record_path).unwrap(),
        "{ broken"
    );
}

#[tokio::test]
async fn an_uninstall_removes_what_is_as_installed_and_a_changed_entry_only_when_told() {
    let sandbox = Sandbox::new().await;
    let targets = [
        McpAppType::ClaudeCode,
        McpAppType::Codex,
        McpAppType::Gemini,
    ];
    assert_eq!(
        sandbox.install_to(&targets).await.outcome,
        InstallOutcome::Installed
    );
    let gemini = sandbox
        .read(McpAppType::Gemini)
        .unwrap()
        .replace("t0ken", "mine");
    sandbox.write(McpAppType::Gemini, &gemini);
    let mut events = sandbox.events.subscribe();

    // The preflight: what would happen, and the basis to come back with.
    let check = sandbox
        .uninstall(HarnessMcpUninstallRequest {
            item_id: ID.into(),
            preflight: true,
            ..Default::default()
        })
        .await;
    assert_eq!(check.outcome, UninstallOutcome::Preflight);
    let actions: Vec<(McpAppType, LocalState, UninstallAction)> = check
        .agents
        .iter()
        .map(|agent| (agent.agent, agent.state, agent.action))
        .collect();
    assert_eq!(
        actions,
        [
            (
                McpAppType::ClaudeCode,
                LocalState::AsInstalled,
                UninstallAction::Remove
            ),
            (
                McpAppType::Codex,
                LocalState::AsInstalled,
                UninstallAction::Remove
            ),
            (
                McpAppType::Gemini,
                LocalState::ChangedLocally,
                UninstallAction::KeepChanged
            ),
        ]
    );
    let basis: BTreeMap<McpAppType, String> = check
        .apply
        .as_ref()
        .unwrap()
        .agents
        .iter()
        .map(|agent| (agent.agent, agent.basis.clone().unwrap()))
        .collect();
    assert_eq!(basis.len(), 2);
    assert!(drain(&mut events).is_empty(), "a preflight changes nothing");

    // Without the basis: refused.
    let refused = sandbox
        .uninstall(HarnessMcpUninstallRequest {
            item_id: ID.into(),
            ..Default::default()
        })
        .await;
    assert_eq!(refused.outcome, UninstallOutcome::Refused);
    assert_eq!(
        codes_of(&refused.issues),
        [codes::BASIS_REQUIRED, codes::BASIS_REQUIRED]
    );

    let done = sandbox
        .uninstall(HarnessMcpUninstallRequest {
            item_id: ID.into(),
            basis: basis.clone(),
            ..Default::default()
        })
        .await;
    assert_eq!(done.outcome, UninstallOutcome::Uninstalled, "{done:?}");
    assert!(sandbox.entry(McpAppType::ClaudeCode, "notes").is_none());
    assert!(sandbox.entry(McpAppType::Codex, "notes").is_none());
    assert!(
        sandbox.entry(McpAppType::Gemini, "notes").is_some(),
        "changed: kept"
    );
    let record = sandbox.record().unwrap();
    let agents: Vec<&String> = record["items"][ID]["agents"]
        .as_object()
        .unwrap()
        .keys()
        .collect();
    assert_eq!(agents, ["gemini"]);
    let channels: Vec<String> = drain(&mut events)
        .into_iter()
        .map(|(channel, _)| channel)
        .collect();
    assert_eq!(channels, ["mcp://changed", INSTALLED_CHANGED_EVENT]);

    // Told to: the changed one goes too, and with it the record.
    let check = sandbox
        .uninstall(HarnessMcpUninstallRequest {
            item_id: ID.into(),
            remove_changed: vec![McpAppType::Gemini],
            preflight: true,
            ..Default::default()
        })
        .await;
    assert_eq!(check.agents[0].action, UninstallAction::Remove);
    let basis = BTreeMap::from([(
        McpAppType::Gemini,
        check.apply.unwrap().agents[0].basis.clone().unwrap(),
    )]);
    let done = sandbox
        .uninstall(HarnessMcpUninstallRequest {
            item_id: ID.into(),
            remove_changed: vec![McpAppType::Gemini],
            basis,
            ..Default::default()
        })
        .await;
    assert_eq!(done.outcome, UninstallOutcome::Uninstalled);
    assert!(sandbox.entry(McpAppType::Gemini, "notes").is_none());
    assert_eq!(sandbox.record().unwrap()["items"], json!({}));

    let gone = sandbox
        .uninstall(HarnessMcpUninstallRequest {
            item_id: ID.into(),
            preflight: true,
            ..Default::default()
        })
        .await;
    assert_eq!(codes_of(&gone.issues), [codes::NOT_INSTALLED]);
}

#[tokio::test]
async fn an_uninstall_with_a_stale_basis_writes_nothing() {
    let sandbox = Sandbox::new().await;
    sandbox.install_to(&[McpAppType::ClaudeCode]).await;
    let check = sandbox
        .uninstall(HarnessMcpUninstallRequest {
            item_id: ID.into(),
            preflight: true,
            ..Default::default()
        })
        .await;
    let basis = BTreeMap::from([(
        McpAppType::ClaudeCode,
        check.apply.unwrap().agents[0].basis.clone().unwrap(),
    )]);
    let claude = sandbox
        .read(McpAppType::ClaudeCode)
        .unwrap()
        .replace("\"numStartups\": 3", "\"numStartups\": 4");
    sandbox.write(McpAppType::ClaudeCode, &claude);
    let result = sandbox
        .uninstall(HarnessMcpUninstallRequest {
            item_id: ID.into(),
            basis,
            ..Default::default()
        })
        .await;
    assert_eq!(result.outcome, UninstallOutcome::ChangedElsewhere);
    assert!(sandbox.entry(McpAppType::ClaudeCode, "notes").is_some());
    assert!(sandbox.record().unwrap()["items"][ID]["agents"]
        .get("claude_code")
        .is_some());
}

// ─── The operator's switch ──────────────────────────────────────────────

#[tokio::test]
async fn switched_off_the_plan_and_the_install_refuse_and_the_rest_still_works() {
    let mut sandbox = Sandbox::new().await;
    let plan = sandbox.plan(None).await;
    let request = sandbox.request(&plan, &[McpAppType::ClaudeCode], "notes");
    assert_eq!(
        sandbox.install(request.clone()).await.outcome,
        InstallOutcome::Installed
    );
    let asked = sandbox.site.requests();

    sandbox.harness.enabled = false;
    let error = plan_error(&sandbox, None).await;
    assert_eq!(error.i18n_key.as_deref(), Some("Harness.errors.disabled"));
    let error = install(&sandbox.local, &sandbox.harness, &sandbox.emitter, request)
        .await
        .unwrap_err();
    assert_eq!(error.i18n_key.as_deref(), Some("Harness.errors.disabled"));
    assert_eq!(sandbox.site.requests(), asked, "nothing was asked");

    // Local files only: still there.
    assert_eq!(sandbox.listing().await.len(), 1);
    let check = sandbox
        .uninstall(HarnessMcpUninstallRequest {
            item_id: ID.into(),
            preflight: true,
            ..Default::default()
        })
        .await;
    let basis = BTreeMap::from([(
        McpAppType::ClaudeCode,
        check.apply.unwrap().agents[0].basis.clone().unwrap(),
    )]);
    let done = sandbox
        .uninstall(HarnessMcpUninstallRequest {
            item_id: ID.into(),
            basis,
            ..Default::default()
        })
        .await;
    assert_eq!(done.outcome, UninstallOutcome::Uninstalled);
}

#[tokio::test]
async fn the_command_layer_refuses_when_switched_off_before_touching_anything() {
    let sandbox = Sandbox::new().await;
    let dir = tempfile::tempdir().unwrap();
    let harness = Harness {
        enabled: false,
        origin: sandbox.harness.origin.clone(),
        cache: Cache::in_data_dir(dir.path()),
        limits: Limits::default(),
        backoff: Box::leak(Box::new(Backoff::default())),
    };
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    let error = crate::commands::harness_mcp::harness_mcp_plan_core(&db, &harness, REF, None)
        .await
        .unwrap_err();
    assert_eq!(error.i18n_key.as_deref(), Some("Harness.errors.disabled"));
    let error = crate::commands::harness_mcp::harness_mcp_install_core(
        &db,
        &EventEmitter::Noop,
        &harness,
        HarnessMcpInstallRequest::default(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.i18n_key.as_deref(), Some("Harness.errors.disabled"));
    assert_eq!(sandbox.site.requests(), 0);
}
