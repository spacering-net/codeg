//! Codex's model list, from the settings page's side: every user change to
//! codex's files funnels through [`commit_user_change`], and the commands
//! here fetch, refresh and describe the provider list.
//!
//! A user's change takes the intent, the endpoint and the key from whoever
//! owns them right now — the bound model provider's row, or the Codex panel
//! (the sidecar, auth.json) — and re-reads that owner under the `CODEX_HOME`
//! lock before it commits, so a bind or a provider edit that landed while it
//! was fetching sends it round once more instead of being overwritten.

use std::collections::HashSet;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::acp::codex_catalog_commit::{
    self as commit, AuthInput, Binding, CatalogError, CatalogMeta, CommitError, CommitOutcome,
    CurrentIntent, FetchPolicy, Origin, PrepareInput, Published, ReleaseModel, TomlEdit, TomlInput,
};
use crate::acp::codex_catalog_refresh as refresh;
use crate::acp::codex_endpoint_catalog::{
    self as endpoint, CatalogCounts, CatalogDiff, EndpointCache, EndpointRequest, EndpointSnapshot,
    SynthTemplate,
};
use crate::acp::codex_model_catalog::{self as catalog, CatalogFormat, CodexCatalogIntent};
use crate::acp::codex_runtime::{self, JudgeError};
use crate::acp::error::AcpError;
use crate::acp::types::CodexSandboxStructuredConfig;
use crate::app_error::AppCommandError;
use crate::db::service::{agent_setting_service, model_provider_service};
use crate::db::AppDatabase;
use crate::models::AgentType;
use crate::web::event_bridge::EventEmitter;

fn err(code: &'static str, message: impl Into<String>) -> CatalogError {
    CatalogError::new(code, message)
}

fn db_error(e: impl std::fmt::Display) -> CatalogError {
    err("database", format!("database: {e}"))
}

/// A catalog error as the save commands return it (their errors travel as
/// text): see [`endpoint::EndpointError::marked_message`].
pub(crate) fn to_acp_error(e: CatalogError) -> AcpError {
    AcpError::protocol(e.marked_message())
}

// ─── A user's change ────────────────────────────────────────────────────

/// Who decides codex's model list, endpoint and key right now.
#[derive(Debug, Clone, PartialEq)]
enum Owner {
    /// The Codex panel: the sidecar's intent, auth.json's key.
    Panel,
    /// A model provider bound to Codex: its row.
    Provider {
        id: i32,
        api_url: String,
        api_key: String,
        model: Option<String>,
    },
}

async fn current_owner(db: &AppDatabase) -> Result<Owner, CatalogError> {
    let setting = agent_setting_service::get_by_agent_type(&db.conn, AgentType::Codex)
        .await
        .map_err(db_error)?;
    let Some(id) = setting.and_then(|s| s.model_provider_id) else {
        return Ok(Owner::Panel);
    };
    let provider = model_provider_service::get_by_id(&db.conn, id)
        .await
        .map_err(db_error)?
        .ok_or_else(|| {
            err(
                "provider_not_found",
                format!("model provider not found: {id}"),
            )
            .with_param("id", id.to_string())
        })?;
    Ok(Owner::Provider {
        id,
        api_url: provider.api_url,
        api_key: provider.api_key,
        model: provider.model,
    })
}

/// What a user's save, bind, provider edit or refresh asks for.
#[derive(Debug, Clone)]
pub(crate) struct CodexUserChange {
    /// The panel's model list intent (`Some("")` clears it); `None` keeps the
    /// published one. A bound provider's own list wins over it.
    pub panel_intent: Option<String>,
    /// config.toml as submitted (raw editor, panel draft); `None` starts from
    /// disk.
    pub toml_base: Option<String>,
    /// The text the submitted draft was loaded from — how a hand edit of a
    /// key codeg manages is told from the disk changing underneath.
    pub toml_baseline: Option<String>,
    pub sandbox: Option<CodexSandboxStructuredConfig>,
    /// auth.json as submitted; `None` keeps disk.
    pub auth_text: Option<String>,
    pub fetch: FetchPolicy,
}

impl CodexUserChange {
    /// The current settings as they are, applied again: a bind, a provider
    /// edit, "Refresh now".
    pub fn reapply(fetch: FetchPolicy) -> Self {
        Self {
            panel_intent: None,
            toml_base: None,
            toml_baseline: None,
            sandbox: None,
            auth_text: None,
            fetch,
        }
    }
}

/// A change made concrete for one owner and one published state.
struct Resolved {
    binding: Binding,
    intent_raw: Option<String>,
    toml: TomlInput,
    auth: AuthInput,
    release_model: ReleaseModel,
}

fn resolve(owner: &Owner, change: &CodexUserChange, published: &Published) -> Resolved {
    let mut edits = Vec::new();
    if let Some(sandbox) = &change.sandbox {
        edits.push(TomlEdit::Sandbox(sandbox.clone()));
    }
    let toml = |edits| TomlInput {
        base: change.toml_base.clone(),
        baseline: change.toml_baseline.clone(),
        edits,
    };
    match owner {
        Owner::Panel => Resolved {
            binding: Binding::Panel,
            intent_raw: change
                .panel_intent
                .clone()
                .or_else(|| published.sidecar.clone()),
            toml: toml(edits),
            auth: change
                .auth_text
                .clone()
                .map(AuthInput::Text)
                .unwrap_or(AuthInput::Keep),
            release_model: ReleaseModel::Keep,
        },
        Owner::Provider {
            id,
            api_url,
            api_key,
            model,
        } => {
            edits.push(TomlEdit::ProviderEndpoint {
                base_url: api_url.clone(),
            });
            let release_model = match crate::commands::acp::provider_codex_model_action(
                AgentType::Codex,
                model.as_deref(),
            ) {
                crate::commands::acp::CodexModelAction::Set(slug) => ReleaseModel::Set(slug),
                crate::commands::acp::CodexModelAction::Clear => ReleaseModel::Clear,
                crate::commands::acp::CodexModelAction::NoOp => ReleaseModel::Keep,
            };
            Resolved {
                binding: Binding::Provider(*id),
                intent_raw: model.clone(),
                toml: toml(edits),
                auth: AuthInput::SetKey {
                    base: change.auth_text.clone(),
                    key: api_key.clone(),
                },
                release_model,
            }
        }
    }
}

/// A bound provider's list is fetched with that provider's key. Without one,
/// the key already in auth.json — perhaps the user's own, for another
/// endpoint — would go to the provider's `/models` instead, so the save stops.
fn refuse_keyless_provider_source(owner: &Owner) -> Result<(), CatalogError> {
    let Owner::Provider { api_key, model, .. } = owner else {
        return Ok(());
    };
    if api_key.trim().is_empty()
        && catalog::parse_model_config(model.as_deref())
            .catalog
            .is_some()
    {
        return Err(err(
            "missing_api_key",
            "the bound model provider has no API key, so its model list cannot be fetched",
        ));
    }
    Ok(())
}

/// What a user's change published.
#[derive(Debug, Clone)]
pub(crate) struct UserCommit {
    pub outcome: CommitOutcome,
    /// The provider could not be reached: what was published stayed, or a
    /// stand-in went out.
    pub fetch_error: Option<CatalogError>,
}

/// Prepare and commit a user's change. A result built on something that
/// changed before the commit (a bind, a provider edit, another codeg
/// publishing) is prepared once more; a second miss is reported.
pub(crate) async fn commit_user_change(
    db: &AppDatabase,
    change: &CodexUserChange,
) -> Result<UserCommit, CatalogError> {
    let home = crate::commands::acp::codex_home_dir();
    commit_user_change_at(db, &home, &EndpointCache::default(), change).await
}

pub(crate) async fn commit_user_change_at(
    db: &AppDatabase,
    home: &Path,
    cache: &EndpointCache,
    change: &CodexUserChange,
) -> Result<UserCommit, CatalogError> {
    let mut fetch = change.fetch;
    for _ in 0..2 {
        let owner = current_owner(db).await?;
        refuse_keyless_provider_source(&owner)?;
        let published = Published::read(home)?;
        let plan = resolve(&owner, change, &published);
        let config = commit::compose_toml(&plan.toml, published.config_text())?;
        let auth = commit::compose_auth(&plan.auth, published.auth_text())?;
        let prepared = commit::prepare(PrepareInput {
            origin: Origin::User,
            binding: plan.binding.clone(),
            intent_raw: plan.intent_raw.clone(),
            toml_text: &config,
            auth_text: &auth,
            published: &published,
            fetch,
            cache,
        })
        .await?;
        if prepared.fetched {
            refresh::note_user_fetch(prepared.fetch_error.as_ref());
        }

        let locked = commit::lock_home(home).await?;
        let now = resolve(&current_owner(db).await?, change, locked.published());
        let current = CurrentIntent {
            binding: now.binding.clone(),
            intent_raw: now.intent_raw.clone(),
        };
        match locked
            .commit(
                &prepared,
                &current,
                &now.toml,
                &now.auth,
                &now.release_model,
            )
            .await
        {
            Ok(outcome) => {
                drop(locked);
                if !prepared.warnings.is_empty() {
                    tracing::info!("[codex-catalog] saved with {:?}", prepared.warnings);
                }
                refresh::kick(refresh::Kick::Published);
                return Ok(UserCommit {
                    outcome,
                    fetch_error: prepared.fetch_error,
                });
            }
            Err(CommitError::Failed(e)) => return Err(e),
            Err(CommitError::Stale(why)) => {
                tracing::info!("[codex-catalog] preparing the save again: {why}");
            }
            Err(CommitError::Superseded) => {
                tracing::info!(
                    "[codex-catalog] a later provider list was published; preparing again"
                );
            }
        }
        // Whatever was just fetched is in the cache.
        fetch = FetchPolicy::IfNeeded;
    }
    Err(err(
        "config_changed",
        "the Codex configuration changed while saving; try again",
    ))
}

// ─── The provider list, before anything is published ────────────────────

/// Where the key for a fetch comes from. The backend enforces who may use
/// which: a bound provider's key never comes from auth.json.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum KeySource {
    /// Typed into the dialog (a provider not saved yet).
    Inline { api_key: String },
    /// A saved provider; a key typed into its dialog wins over the stored one.
    Provider {
        provider_id: i32,
        #[serde(default)]
        api_key: Option<String>,
    },
    /// The Codex panel's own key (auth.json), with no provider bound.
    CodexAuth,
}

/// The request the settings page has in mind.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCatalogRequestParams {
    pub base_url: String,
    #[serde(default)]
    pub catalog_url: Option<String>,
    pub key_source: KeySource,
    /// The panel's config.toml draft, for the provider table's
    /// `query_params` and `http_headers`; the file on disk when absent.
    #[serde(default)]
    pub config_toml: Option<String>,
    /// Only a list in this shape counts, when given.
    #[serde(default)]
    pub format: Option<CatalogFormat>,
}

async fn draft_request(
    db: &AppDatabase,
    published: &Published,
    params: &CodexCatalogRequestParams,
) -> Result<EndpointRequest, CatalogError> {
    let key = match &params.key_source {
        KeySource::Inline { api_key } => api_key.clone(),
        KeySource::Provider {
            provider_id,
            api_key,
        } => match api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
            Some(typed) => typed.to_string(),
            None => {
                model_provider_service::get_by_id(&db.conn, *provider_id)
                    .await
                    .map_err(db_error)?
                    .ok_or_else(|| {
                        err(
                            "provider_not_found",
                            format!("model provider not found: {provider_id}"),
                        )
                    })?
                    .api_key
            }
        },
        KeySource::CodexAuth => {
            if current_owner(db).await? != Owner::Panel {
                return Err(err(
                    "key_source_not_allowed",
                    "a bound provider's list is fetched with the provider's own key",
                ));
            }
            commit::auth_api_key(published.auth_text()).unwrap_or_default()
        }
    };
    let toml_text = params
        .config_toml
        .as_deref()
        .unwrap_or_else(|| published.config_text());
    let parts = commit::codeg_provider_parts(toml_text).unwrap_or_default();
    EndpointRequest::new(
        &params.base_url,
        params.catalog_url.as_deref(),
        &parts.query_params,
        &parts.headers,
        &key,
    )
}

/// One OpenAI-list id, with the template codeg would build it from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiIdView {
    pub id: String,
    pub context_window: Option<u64>,
    pub template: Option<SynthTemplate>,
}

/// A provider list as the settings page shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexEndpointCatalogView {
    pub url: String,
    pub host: String,
    pub format: CatalogFormat,
    /// A native catalog's entries as codex gets them.
    pub models: Option<Vec<Value>>,
    /// An OpenAI list's ids.
    pub ids: Option<Vec<OpenAiIdView>>,
    /// Picked ids the provider no longer returns, as last seen.
    pub missing: Vec<OpenAiIdView>,
    pub counts: CatalogCounts,
    pub bytes: usize,
    pub elapsed_ms: u64,
    pub client_version: String,
    pub client_version_confirmed: bool,
    pub request_seq: u64,
    pub request_started_at: DateTime<Utc>,
    pub fetched_at: DateTime<Utc>,
    pub diff: CatalogDiff,
    pub key_digest: String,
    pub warnings: Vec<String>,
}

fn view_of(
    s: &EndpointSnapshot,
    officials: &[Value],
    warnings: Vec<String>,
) -> CodexEndpointCatalogView {
    let id_view = |m: &endpoint::OpenAiModelId| OpenAiIdView {
        id: m.id.clone(),
        context_window: m.context_window,
        template: endpoint::template_for(&m.id, officials),
    };
    let (models, ids, counts) = match s.format {
        CatalogFormat::Native => {
            let models = endpoint::normalize_native(s.models.as_deref().unwrap_or_default());
            let counts = endpoint::counts(&models);
            (Some(models), None, counts)
        }
        CatalogFormat::OpenaiList => {
            let ids: Vec<OpenAiIdView> = s.ids.iter().flatten().map(id_view).collect();
            let n = ids.len();
            let counts = CatalogCounts {
                total: n,
                listed: n,
                usable: n,
            };
            (None, Some(ids), counts)
        }
    };
    let returned: HashSet<&str> = s.ids.iter().flatten().map(|m| m.id.as_str()).collect();
    let missing = s
        .last_seen
        .values()
        .filter(|m| !returned.contains(m.id.as_str()))
        .map(id_view)
        .collect();
    CodexEndpointCatalogView {
        url: s.url.clone(),
        host: url::Url::parse(&s.url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default(),
        format: s.format,
        models,
        ids,
        missing,
        counts,
        bytes: s.bytes,
        elapsed_ms: s.elapsed_ms,
        client_version: s.client_version.clone(),
        client_version_confirmed: s.client_version_confirmed,
        request_seq: s.request_seq,
        request_started_at: s.request_started_at,
        fetched_at: s.fetched_at,
        diff: s.diff.clone(),
        key_digest: s.key_digest.clone(),
        warnings,
    }
}

/// Fetch a provider's list for the settings page without publishing it. A
/// native catalog is checked as the provider sent it — unique slugs, and the
/// codex that would run loading it — and the answer is cached for the save
/// that follows.
pub(crate) async fn codex_fetch_endpoint_catalog_core(
    db: &AppDatabase,
    params: CodexCatalogRequestParams,
) -> Result<CodexEndpointCatalogView, AppCommandError> {
    let home = crate::commands::acp::codex_home_dir();
    Ok(fetch_at(db, &home, &EndpointCache::default(), &params).await?)
}

pub(crate) async fn fetch_at(
    db: &AppDatabase,
    home: &Path,
    cache: &EndpointCache,
    params: &CodexCatalogRequestParams,
) -> Result<CodexEndpointCatalogView, CatalogError> {
    let published = Published::read(home)?;
    let request = draft_request(db, &published, params).await?;
    let runtime = codex_runtime::current().await;
    let seq = commit::lock::take_seq(home).await?;
    let outcome = endpoint::fetch(&request, &runtime.version).await?;
    let previous_last_seen = published
        .upstream
        .as_ref()
        .filter(|u| u.url == request.url())
        .map(|u| u.last_seen.clone())
        .unwrap_or_default();
    let selected = published
        .intent()
        .and_then(|i| i.catalog)
        .map(|c| c.selected)
        .unwrap_or_default();
    let mut snapshot = endpoint::snapshot_of(
        &request,
        seq,
        &runtime.version,
        runtime.confirmed,
        &outcome,
        &previous_last_seen,
        &selected,
    );
    let mut warnings = Vec::new();
    if snapshot.format == CatalogFormat::Native {
        let models = endpoint::normalize_native(snapshot.models.as_deref().unwrap_or_default());
        endpoint::validate_native(&models)?;
        if let Some(js) = runtime.codex_js.as_deref() {
            let bytes = serde_json::to_vec(&serde_json::json!({ "models": models }))
                .map_err(|e| err("io", format!("serialize catalog: {e}")))?;
            match codex_runtime::judge(js, &bytes).await {
                Ok(_) | Err(JudgeError::NotInstalled) => {}
                Err(e) => return Err(commit::judge_error(e)),
            }
        }
        if endpoint::counts(&models).usable == 0 {
            warnings.push("no_usable_models".to_string());
        }
    }
    if let Err(e) = cache.store(home, &mut snapshot) {
        tracing::warn!("[codex-catalog] could not cache the provider list: {e}");
    }
    let officials = commit::officials_for(&runtime).await;
    Ok(view_of(&snapshot, &officials, warnings))
}

/// A list the page may use as its rows, or why there is none.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogLookup {
    pub catalog: Option<CodexEndpointCatalogView>,
    /// `none` (nothing there), `request` (it answers another URL, key,
    /// parameters or headers), `format` (the other shape).
    pub mismatch: Option<&'static str>,
}

impl CatalogLookup {
    fn mismatch(why: &'static str) -> Self {
        Self {
            catalog: None,
            mismatch: Some(why),
        }
    }
}

/// The published provider list, when it answers the page's request.
pub(crate) async fn codex_endpoint_catalog_published_core(
    db: &AppDatabase,
    params: CodexCatalogRequestParams,
) -> Result<CatalogLookup, AppCommandError> {
    let home = crate::commands::acp::codex_home_dir();
    Ok(published_at(db, &home, &params).await?)
}

pub(crate) async fn published_at(
    db: &AppDatabase,
    home: &Path,
    params: &CodexCatalogRequestParams,
) -> Result<CatalogLookup, CatalogError> {
    let published = Published::read(home)?;
    let request = draft_request(db, &published, params).await?;
    if published.upstream.is_none() {
        return Ok(CatalogLookup::mismatch("none"));
    }
    let Some(up) = published.upstream_answering(&request) else {
        return Ok(CatalogLookup::mismatch("request"));
    };
    if params.format.is_some_and(|f| f != up.format) {
        return Ok(CatalogLookup::mismatch("format"));
    }
    let officials = commit::officials_for(&codex_runtime::current().await).await;
    Ok(CatalogLookup {
        catalog: Some(view_of(up, &officials, Vec::new())),
        mismatch: None,
    })
}

/// The cached answer to exactly the page's request, under the codex that
/// would run. Never fetches.
pub(crate) async fn codex_endpoint_catalog_cached_core(
    db: &AppDatabase,
    params: CodexCatalogRequestParams,
) -> Result<CatalogLookup, AppCommandError> {
    let home = crate::commands::acp::codex_home_dir();
    Ok(cached_at(db, &home, &EndpointCache::default(), &params).await?)
}

pub(crate) async fn cached_at(
    db: &AppDatabase,
    home: &Path,
    cache: &EndpointCache,
    params: &CodexCatalogRequestParams,
) -> Result<CatalogLookup, CatalogError> {
    let published = Published::read(home)?;
    let request = draft_request(db, &published, params).await?;
    let runtime = codex_runtime::current().await;
    let Some(hit) = cache.exact(home, &request, &runtime.version, params.format) else {
        return Ok(CatalogLookup::mismatch("none"));
    };
    let officials = commit::officials_for(&runtime).await;
    Ok(CatalogLookup {
        catalog: Some(view_of(&hit, &officials, Vec::new())),
        mismatch: None,
    })
}

// ─── What a save would write ────────────────────────────────────────────

/// The draft a Codex panel would save.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPlanPreviewParams {
    pub config_toml: String,
    /// The draft auth.json; the published one when absent.
    #[serde(default)]
    pub auth_json: Option<String>,
    /// The draft model list (the intent), serialized.
    #[serde(default)]
    pub model_list: Option<String>,
}

/// What saving the draft would make of the keys codeg manages. Never
/// fetches, judges or writes.
pub(crate) async fn codex_catalog_plan_preview_core(
    params: CodexPlanPreviewParams,
) -> Result<commit::PlanPreview, AppCommandError> {
    let home = crate::commands::acp::codex_home_dir();
    Ok(plan_preview_at(&home, &EndpointCache::default(), &params).await?)
}

pub(crate) async fn plan_preview_at(
    home: &Path,
    cache: &EndpointCache,
    params: &CodexPlanPreviewParams,
) -> Result<commit::PlanPreview, CatalogError> {
    let published = Published::read(home)?;
    let auth = params
        .auth_json
        .as_deref()
        .unwrap_or_else(|| published.auth_text());
    commit::plan_preview(
        params.model_list.as_deref(),
        &params.config_toml,
        auth,
        &published,
        cache,
    )
    .await
}

// ─── What is published ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeView {
    pub version: String,
    pub confirmed: bool,
    pub adapter_version: Option<String>,
}

/// The configuration published under codeg's `CODEX_HOME`, for the status
/// line.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCatalogStatus {
    pub meta: Option<CatalogMeta>,
    /// The published intent's provider source, when it has one.
    pub source: Option<CodexCatalogIntent>,
    /// config.toml points codex at codeg's catalog file.
    pub publishes_catalog: bool,
    pub refresh: refresh::RefreshStatus,
    /// The age limit, in hours; `None` when that trigger is off.
    pub refresh_hours: Option<f64>,
    /// The database (a bound provider) says something the published
    /// configuration does not, yet: "Apply" or "Refresh now" publishes it.
    pub pending_local_changes: bool,
    /// The active provider has a `model_catalog_url` the user wrote.
    pub catalog_url_hint: bool,
    /// The active provider when it is not codeg's (the user's config.toml
    /// manages it).
    pub foreign_provider: Option<String>,
    /// OpenAI list: picked ids the provider no longer returns.
    pub missing_selected: Vec<String>,
    /// OpenAI list: ids the provider added since, not picked.
    pub new_ids: Vec<String>,
    pub runtime: RuntimeView,
    /// "Refresh now" only: why the provider could not be asked.
    pub fetch_error: Option<CatalogError>,
}

fn active_provider(toml_text: &str) -> Option<String> {
    toml_text
        .parse::<toml::Table>()
        .ok()?
        .get("model_provider")?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The active provider's `base_url`.
fn active_base_url(toml_text: &str) -> Option<String> {
    let value = toml_text.parse::<toml::Table>().ok()?;
    let active = value.get("model_provider")?.as_str()?.trim().to_string();
    value
        .get("model_providers")?
        .get(&active)?
        .get("base_url")?
        .as_str()
        .map(|s| s.trim().to_string())
}

/// Whether the published configuration lags behind the bound provider's
/// row (config-sync changed it, or applying it failed).
fn lags_behind(owner: &Owner, published: &Published) -> bool {
    let Owner::Provider {
        id, api_key, model, ..
    } = owner
    else {
        return false;
    };
    let plan = resolve(
        owner,
        &CodexUserChange::reapply(FetchPolicy::Never),
        published,
    );
    let (Ok(config), Ok(auth)) = (
        commit::compose_toml(&plan.toml, published.config_text()),
        commit::compose_auth(&plan.auth, published.auth_text()),
    ) else {
        return true;
    };
    let endpoint_moved = active_base_url(published.config_text()) != active_base_url(&config);
    let key_moved = !api_key.trim().is_empty()
        && commit::auth_api_key(published.auth_text()).as_deref() != Some(api_key.trim());
    let mut intent = catalog::parse_model_config(model.as_deref());
    if intent.catalog.is_some() && commit::codeg_provider_parts(&config).is_none() {
        intent.catalog = None;
    }
    let intent_moved = match &published.meta {
        Some(meta) => {
            meta.binding() != Binding::Provider(*id)
                || meta.intent_hash != commit::intent_hash(&intent)
                || (intent.catalog.is_some()
                    && commit::request_for(&intent, &config, &auth)
                        .ok()
                        .flatten()
                        .map(|r| r.fingerprint())
                        != meta.request_fingerprint)
        }
        None => {
            intent.catalog.is_some()
                || !intent.customs.is_empty()
                || !intent.excluded_officials.is_empty()
        }
    };
    endpoint_moved || key_moved || intent_moved
}

pub(crate) async fn codex_endpoint_catalog_status_core(
    db: &AppDatabase,
) -> Result<CodexCatalogStatus, AppCommandError> {
    let home = crate::commands::acp::codex_home_dir();
    Ok(status_at(db, &home).await?)
}

pub(crate) async fn status_at(
    db: &AppDatabase,
    home: &Path,
) -> Result<CodexCatalogStatus, CatalogError> {
    let published = Published::read(home)?;
    let owner = current_owner(db).await?;
    let runtime = codex_runtime::current().await;
    let source = published.intent().and_then(|i| i.catalog);
    let config = published.config_text();
    let foreign_provider = active_provider(config).filter(|p| p != commit::CODEG_PROVIDER);
    let (missing_selected, new_ids) = match (&source, &published.upstream) {
        (Some(src), Some(up)) if up.format == CatalogFormat::OpenaiList => {
            let returned: HashSet<&str> = up.ids.iter().flatten().map(|m| m.id.as_str()).collect();
            let picked: HashSet<&str> = src.selected.iter().map(String::as_str).collect();
            let missing = src
                .selected
                .iter()
                .filter(|id| !returned.contains(id.as_str()))
                .cloned()
                .collect();
            let added = published
                .meta
                .as_ref()
                .map(|m| m.diff.added.clone())
                .unwrap_or_default()
                .into_iter()
                .filter(|id| !picked.contains(id.as_str()) && returned.contains(id.as_str()))
                .collect();
            (missing, added)
        }
        _ => (Vec::new(), Vec::new()),
    };
    Ok(CodexCatalogStatus {
        pending_local_changes: lags_behind(&owner, &published),
        publishes_catalog: published.references_codeg_catalog(),
        catalog_url_hint: commit::active_provider_has_catalog_url(config),
        foreign_provider,
        meta: published.meta.clone(),
        source,
        refresh: refresh::status(),
        refresh_hours: refresh::refresh_ttl().map(|d| d.num_minutes() as f64 / 60.0),
        missing_selected,
        new_ids,
        runtime: RuntimeView {
            version: runtime.version,
            confirmed: runtime.confirmed,
            adapter_version: runtime.adapter_version,
        },
        fetch_error: None,
    })
}

/// "Refresh now" (and "Apply"): fetch the provider list whatever its age and
/// publish what the current settings make of it.
pub(crate) async fn codex_refresh_endpoint_catalog_core(
    db: &AppDatabase,
    emitter: &EventEmitter,
) -> Result<CodexCatalogStatus, AppCommandError> {
    let home = crate::commands::acp::codex_home_dir();
    let done = commit_user_change_at(
        db,
        &home,
        &EndpointCache::default(),
        &CodexUserChange::reapply(FetchPolicy::Force),
    )
    .await?;
    if !done.outcome.changed.is_empty() {
        crate::commands::acp::emit_acp_agents_updated(
            emitter,
            "config_updated",
            Some(AgentType::Codex),
        );
    }
    let mut status = status_at(db, &home).await?;
    status.fetch_error = done.fetch_error;
    Ok(status)
}

// ─── Tauri commands ─────────────────────────────────────────────────────

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn codex_catalog_plan_preview(
    params: CodexPlanPreviewParams,
) -> Result<commit::PlanPreview, AppCommandError> {
    codex_catalog_plan_preview_core(params).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn codex_fetch_endpoint_catalog(
    params: CodexCatalogRequestParams,
    db: tauri::State<'_, AppDatabase>,
) -> Result<CodexEndpointCatalogView, AppCommandError> {
    codex_fetch_endpoint_catalog_core(&db, params).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn codex_endpoint_catalog_published(
    params: CodexCatalogRequestParams,
    db: tauri::State<'_, AppDatabase>,
) -> Result<CatalogLookup, AppCommandError> {
    codex_endpoint_catalog_published_core(&db, params).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn codex_endpoint_catalog_cached(
    params: CodexCatalogRequestParams,
    db: tauri::State<'_, AppDatabase>,
) -> Result<CatalogLookup, AppCommandError> {
    codex_endpoint_catalog_cached_core(&db, params).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn codex_endpoint_catalog_status(
    db: tauri::State<'_, AppDatabase>,
) -> Result<CodexCatalogStatus, AppCommandError> {
    codex_endpoint_catalog_status_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn codex_refresh_endpoint_catalog(
    db: tauri::State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<CodexCatalogStatus, AppCommandError> {
    let emitter = EventEmitter::Tauri(app);
    codex_refresh_endpoint_catalog_core(&db, &emitter).await
}

#[cfg(test)]
mod tests;
