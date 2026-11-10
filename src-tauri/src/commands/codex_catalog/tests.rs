use super::*;
use crate::acp::codex_catalog_commit::tests::{native_body, serve, Env, AUTH, NATIVE_INTENT};
use crate::acp::codex_catalog_commit::{AUTH_REL, CONFIG_REL};
use crate::db::test_helpers::fresh_in_memory_db;
use serde_json::json;

const CUSTOMS: &str = r#"{"customs":[{"slug":"gw/x","base":"gpt-5.6-sol"}],"default":"gw/x"}"#;

async fn codex_db() -> AppDatabase {
    let db = fresh_in_memory_db().await;
    agent_setting_service::ensure_defaults(
        &db.conn,
        &[agent_setting_service::AgentDefaultInput {
            agent_type: AgentType::Codex,
            registry_id: crate::acp::registry::registry_id_for(AgentType::Codex).to_string(),
            default_sort_order: 0,
        }],
    )
    .await
    .unwrap();
    db
}

async fn add_provider(db: &AppDatabase, url: &str, key: &str, model: Option<&str>) -> i32 {
    model_provider_service::create(
        &db.conn,
        "relay".into(),
        url.into(),
        key.into(),
        "codex".into(),
        model.map(str::to_string),
    )
    .await
    .unwrap()
    .id
}

async fn bind(db: &AppDatabase, provider: Option<i32>) {
    agent_setting_service::update(
        &db.conn,
        AgentType::Codex,
        agent_setting_service::AgentSettingsUpdate {
            enabled: true,
            env_json: None,
            model_provider_id: provider,
        },
    )
    .await
    .unwrap();
}

async fn set_provider_model(db: &AppDatabase, id: i32, model: &str) {
    use sea_orm::{ActiveModelTrait, IntoActiveModel, Set};
    let row = model_provider_service::get_by_id(&db.conn, id)
        .await
        .unwrap()
        .unwrap();
    let mut active = row.into_active_model();
    active.model = Set(Some(model.to_string()));
    active.update(&db.conn).await.unwrap();
}

fn panel_save(intent: &str, toml: &str, baseline: &str) -> CodexUserChange {
    CodexUserChange {
        panel_intent: Some(intent.into()),
        toml_base: Some(toml.into()),
        toml_baseline: Some(baseline.into()),
        sandbox: None,
        auth_text: Some(AUTH.into()),
        fetch: FetchPolicy::IfNeeded,
    }
}

fn inline(base: &str, key: &str) -> CodexCatalogRequestParams {
    CodexCatalogRequestParams {
        base_url: base.into(),
        catalog_url: None,
        key_source: KeySource::Inline {
            api_key: key.into(),
        },
        config_toml: None,
        format: None,
    }
}

#[test]
fn key_sources_arrive_tagged_with_camel_case_fields() {
    let parse = |v: Value| serde_json::from_value::<KeySource>(v).unwrap();
    assert!(matches!(
        parse(json!({"kind": "inline", "apiKey": "sk"})),
        KeySource::Inline { api_key } if api_key == "sk"
    ));
    assert!(matches!(
        parse(json!({"kind": "provider", "providerId": 4})),
        KeySource::Provider {
            provider_id: 4,
            api_key: None
        }
    ));
    assert!(matches!(
        parse(json!({"kind": "codexAuth"})),
        KeySource::CodexAuth
    ));
    let params: CodexCatalogRequestParams = serde_json::from_value(json!({
        "baseUrl": "https://r/v1",
        "keySource": {"kind": "codexAuth"},
        "format": "openai_list",
    }))
    .unwrap();
    assert_eq!(params.format, Some(CatalogFormat::OpenaiList));
}

#[test]
fn catalog_errors_carry_their_code_through_the_save_commands() {
    let e = err("no_usable_models", "nothing usable").with_param("n", "0");
    let text = to_acp_error(e).to_string();
    let (message, tag) = text.rsplit_once(endpoint::ERROR_MARKER).unwrap();
    assert!(message.contains("nothing usable"));
    let tag: Value = serde_json::from_str(tag).unwrap();
    assert_eq!(
        tag,
        json!({"code": "no_usable_models", "params": {"n": "0"}})
    );
}

#[tokio::test]
async fn a_bound_providers_endpoint_key_and_list_reach_codex() {
    let env = Env::new();
    let db = codex_db().await;
    let (base, _hits) = serve(vec![(200, native_body(&["r1", "r2"]))]).await;
    env.write(
        CONFIG_REL,
        "# mine\nmodel_provider = \"codeg\"\n\n[model_providers.codeg]\nrequires_openai_auth = false\n\n[model_providers.codeg.http_headers]\nx-openai-actor-authorization = \"ext\"\n",
    );
    let id = add_provider(&db, &base, "sk-p", Some(NATIVE_INTENT)).await;
    bind(&db, Some(id)).await;

    let done = commit_user_change_at(
        &db,
        &env.home(),
        &env.cache,
        &CodexUserChange::reapply(FetchPolicy::IfNeeded),
    )
    .await
    .unwrap();
    assert!(done.fetch_error.is_none());
    let config = env.read(CONFIG_REL).unwrap();
    assert!(config.starts_with("# mine\n"), "{config}");
    let parts = commit::codeg_provider_parts(&config).unwrap();
    assert_eq!(parts.base_url, base);
    // The user's own choices on the provider survive a bind.
    assert!(config.contains("requires_openai_auth = false"));
    assert!(config.contains("x-openai-actor-authorization = \"ext\""));
    assert_eq!(
        commit::auth_api_key(&env.read(AUTH_REL).unwrap()).as_deref(),
        Some("sk-p")
    );
    assert_eq!(env.catalog_slugs(), ["r1", "r2"]);
    let meta = env.meta();
    assert_eq!(meta.binding(), Binding::Provider(id));
    assert_eq!(env.read(catalog::SOURCE_REL).unwrap(), NATIVE_INTENT);

    // Nothing left to apply; the provider changing its list in the database
    // (config-sync, say) is.
    let status = status_at(&db, &env.home()).await.unwrap();
    assert!(!status.pending_local_changes);
    assert!(status.publishes_catalog);
    set_provider_model(&db, id, CUSTOMS).await;
    assert!(
        status_at(&db, &env.home())
            .await
            .unwrap()
            .pending_local_changes
    );
}

/// A bound provider without a key of its own must not have the key already
/// in auth.json (the user's, for another endpoint) sent to its `/models`.
#[tokio::test]
async fn a_keyless_bound_provider_never_borrows_the_panels_key() {
    let env = Env::new();
    let db = codex_db().await;
    let (base, hits) = serve(vec![(200, native_body(&["r1"]))]).await;
    let personal = r#"{"OPENAI_API_KEY":"sk-personal","tokens":{"keep":"me"}}"#;
    env.write(AUTH_REL, personal);
    env.write(CONFIG_REL, "model_provider = \"codeg\"\n");
    let id = add_provider(&db, &base, "  ", Some(NATIVE_INTENT)).await;
    bind(&db, Some(id)).await;

    for fetch in [FetchPolicy::IfNeeded, FetchPolicy::Force] {
        let e = commit_user_change_at(
            &db,
            &env.home(),
            &env.cache,
            &CodexUserChange::reapply(fetch),
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, "missing_api_key");
    }
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert_eq!(env.read(AUTH_REL).unwrap(), personal);
    assert_eq!(
        env.read(CONFIG_REL).unwrap(),
        "model_provider = \"codeg\"\n"
    );

    // Without a provider source there is nothing to fetch: the bind goes on.
    set_provider_model(&db, id, CUSTOMS).await;
    commit_user_change_at(
        &db,
        &env.home(),
        &env.cache,
        &CodexUserChange::reapply(FetchPolicy::IfNeeded),
    )
    .await
    .unwrap();
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_bound_providers_model_decides_the_root_model() {
    let env = Env::new();
    let db = codex_db().await;
    env.write(CONFIG_REL, "model = \"old\"\n");
    let reapply = CodexUserChange::reapply(FetchPolicy::IfNeeded);
    // No model at all: codex's own list, and its own default.
    let id = add_provider(&db, "https://relay.test/v1", "sk-p", None).await;
    bind(&db, Some(id)).await;
    commit_user_change_at(&db, &env.home(), &env.cache, &reapply)
        .await
        .unwrap();
    let config: toml::Table = env.read(CONFIG_REL).unwrap().parse().unwrap();
    assert!(config.get("model").is_none());
    assert!(config.get("model_catalog_json").is_none());
    assert_eq!(config["model_provider"].as_str(), Some("codeg"));

    // A legacy plain slug is a custom model of its own, and the default.
    set_provider_model(&db, id, "gw/legacy").await;
    commit_user_change_at(&db, &env.home(), &env.cache, &reapply)
        .await
        .unwrap();
    let config: toml::Table = env.read(CONFIG_REL).unwrap().parse().unwrap();
    assert_eq!(config["model"].as_str(), Some("gw/legacy"));
    assert_eq!(
        config["model_catalog_json"].as_str(),
        Some(catalog::CATALOG_REL)
    );
    assert_eq!(env.catalog_slugs()[0], "gw/legacy");
}

#[tokio::test]
async fn a_panel_save_publishes_its_intent_and_refuses_hand_edits_of_managed_keys() {
    let env = Env::new();
    let db = codex_db().await;
    let toml = "model_provider = \"codeg\"\n\n[model_providers.codeg]\nbase_url = \"https://relay.test/v1\"\n";
    env.write(CONFIG_REL, toml);
    commit_user_change_at(
        &db,
        &env.home(),
        &env.cache,
        &panel_save(CUSTOMS, toml, toml),
    )
    .await
    .unwrap();
    let written = env.read(CONFIG_REL).unwrap();
    assert!(written.contains("model_catalog_json = \"codeg-model-catalog.json\""));
    assert!(written.contains("model = \"gw/x\""));
    assert_eq!(env.read(catalog::SOURCE_REL).unwrap(), CUSTOMS);

    // The raw editor changed root `model` while codeg manages it.
    let edited = written.replace("model = \"gw/x\"", "model = \"other\"");
    let e = commit_user_change_at(
        &db,
        &env.home(),
        &env.cache,
        &panel_save(CUSTOMS, &edited, &written),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, "managed_key_edited");
    assert_eq!(env.read(CONFIG_REL).unwrap(), written);

    // Cleared: codex's own list again, the user's model choice is theirs.
    let mine = written.replace("model = \"gw/x\"", "model = \"mine\"");
    commit_user_change_at(&db, &env.home(), &env.cache, &panel_save("", &mine, &mine))
        .await
        .unwrap();
    let released = env.read(CONFIG_REL).unwrap();
    assert!(!released.contains("model_catalog_json"), "{released}");
    assert!(released.contains("model = \"mine\""));
    assert!(env.read(catalog::SOURCE_REL).is_none());
}

/// The preview says what a save would set codeg's keys to, and writes
/// nothing — nor asks the provider or codex.
#[tokio::test]
async fn a_preview_shows_the_managed_keys_a_save_would_set_and_writes_nothing() {
    let env = Env::new();
    let toml = "model = \"mine\"\nmodel_provider = \"codeg\"\n\n[model_providers.codeg]\nbase_url = \"https://relay.test/v1\"\n";
    env.write(CONFIG_REL, toml);
    let params = |model_list: &str, config: &str| CodexPlanPreviewParams {
        config_toml: config.to_string(),
        auth_json: Some(AUTH.to_string()),
        model_list: Some(model_list.to_string()),
    };
    let preview = plan_preview_at(&env.home(), &env.cache, &params(CUSTOMS, toml))
        .await
        .unwrap();
    assert!(preview.manages_catalog);
    assert_eq!(preview.default_model.as_deref(), Some("gw/x"));
    assert!(preview
        .final_toml
        .contains("model_catalog_json = \"codeg-model-catalog.json\""));
    assert!(preview.final_toml.contains("model = \"gw/x\""));
    // Nothing on disk moved.
    assert_eq!(env.read(CONFIG_REL).unwrap(), toml);
    assert!(env.read(catalog::CATALOG_REL).is_none());

    // Codex's own list: codeg's reference goes, the user's model stays.
    let published = toml.replace(
        "model = \"mine\"",
        "model = \"mine\"\nmodel_catalog_json = \"codeg-model-catalog.json\"",
    );
    let preview = plan_preview_at(&env.home(), &env.cache, &params("", &published))
        .await
        .unwrap();
    assert!(!preview.manages_catalog);
    assert!(!preview.final_toml.contains("model_catalog_json"), "{}", preview.final_toml);
    assert!(preview.final_toml.contains("model = \"mine\""));

    // A provider source with no list anywhere: the stand-in a save would
    // build, and it says so.
    let source = r#"{"customs":[],"default":"glm-5.2","catalog":{"format":"native"}}"#;
    let preview = plan_preview_at(&env.home(), &env.cache, &params(source, toml))
        .await
        .unwrap();
    assert!(preview.manages_catalog);
    assert_eq!(preview.default_model.as_deref(), Some("glm-5.2"));
    assert_eq!(preview.warnings, ["no_provider_list"]);
}

#[tokio::test]
async fn the_panels_key_cannot_fetch_a_bound_providers_list() {
    let env = Env::new();
    let db = codex_db().await;
    let id = add_provider(&db, "https://relay.test/v1", "sk-p", None).await;
    bind(&db, Some(id)).await;
    let params = CodexCatalogRequestParams {
        key_source: KeySource::CodexAuth,
        ..inline("https://relay.test/v1", "")
    };
    let e = fetch_at(&db, &env.home(), &env.cache, &params)
        .await
        .unwrap_err();
    assert_eq!(e.code, "key_source_not_allowed");
    // Without a key nothing is sent at all.
    bind(&db, None).await;
    let e = fetch_at(&db, &env.home(), &env.cache, &params)
        .await
        .unwrap_err();
    assert_eq!(e.code, "missing_api_key");
}

#[tokio::test]
async fn a_fetched_list_is_cached_for_its_request_and_published_by_the_save() {
    let env = Env::new();
    let db = codex_db().await;
    let (base, hits) = serve(vec![(200, native_body(&["r1", "r2"]))]).await;
    let view = fetch_at(&db, &env.home(), &env.cache, &inline(&base, "sk-test"))
        .await
        .unwrap();
    assert_eq!(view.format, CatalogFormat::Native);
    assert_eq!(view.counts.total, 2);
    assert_eq!(view.host, "127.0.0.1");

    let cached = cached_at(&db, &env.home(), &env.cache, &inline(&base, "sk-test"))
        .await
        .unwrap();
    assert_eq!(cached.catalog.unwrap().request_seq, view.request_seq);
    // Another key is another request.
    let other = cached_at(&db, &env.home(), &env.cache, &inline(&base, "sk-other"))
        .await
        .unwrap();
    assert_eq!(other.mismatch, Some("none"));
    let nothing = published_at(&db, &env.home(), &inline(&base, "sk-test"))
        .await
        .unwrap();
    assert_eq!(nothing.mismatch, Some("none"));

    // The save right after uses the fetch instead of asking again.
    let toml =
        format!("model_provider = \"codeg\"\n\n[model_providers.codeg]\nbase_url = \"{base}\"\n");
    env.write(CONFIG_REL, &toml);
    commit_user_change_at(
        &db,
        &env.home(),
        &env.cache,
        &panel_save(NATIVE_INTENT, &toml, &toml),
    )
    .await
    .unwrap();
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(env.catalog_slugs(), ["r1", "r2"]);
    let params = CodexCatalogRequestParams {
        key_source: KeySource::CodexAuth,
        ..inline(&base, "")
    };
    let published = published_at(&db, &env.home(), &params).await.unwrap();
    assert_eq!(published.catalog.unwrap().counts.total, 2);
    let other_shape = CodexCatalogRequestParams {
        format: Some(CatalogFormat::OpenaiList),
        ..params
    };
    assert_eq!(
        published_at(&db, &env.home(), &other_shape)
            .await
            .unwrap()
            .mismatch,
        Some("format")
    );
}

#[tokio::test]
async fn an_openai_list_says_which_template_each_id_would_use() {
    let env = Env::new();
    let db = codex_db().await;
    let body = json!({"object": "list", "data": [
        {"id": "gpt-5.5"},
        {"id": "gpt-5.5-mini-preview"},
        {"id": "glm-5.2", "context_length": 200000},
    ]})
    .to_string();
    let (base, _hits) = serve(vec![(200, body)]).await;
    let view = fetch_at(&db, &env.home(), &env.cache, &inline(&base, "sk-test"))
        .await
        .unwrap();
    assert_eq!(view.format, CatalogFormat::OpenaiList);
    let ids = view.ids.unwrap();
    let kind = |i: usize| serde_json::to_value(&ids[i].template).unwrap()["kind"].clone();
    assert_eq!(kind(0), "official");
    assert_eq!(kind(1), "prefix");
    assert_eq!(kind(2), "compat");
    assert_eq!(ids[2].context_window, Some(200000));
}

/// Saving preferences (enabled, env, native files) keeps a bound provider
/// bound, and its row keeps deciding codex's endpoint and key.
#[tokio::test]
async fn saving_preferences_keeps_the_provider_bound() {
    let env = Env::new();
    let db = codex_db().await;
    let id = add_provider(&db, "https://relay.test/v1", "sk-p", Some(CUSTOMS)).await;
    bind(&db, Some(id)).await;
    // The coordinator writes the configured CODEX_HOME; point it here.
    temp_env::async_with_vars([("CODEX_HOME", Some(env.home()))], async {
        crate::commands::acp::acp_update_agent_preferences_core(
            AgentType::Codex,
            true,
            std::collections::BTreeMap::new(),
            None,
            None,
            Some("model_provider = \"codeg\"\n".into()),
            &db,
            &crate::web::event_bridge::EventEmitter::Noop,
        )
        .await
        .unwrap();
    })
    .await;
    let setting = agent_setting_service::get_by_agent_type(&db.conn, AgentType::Codex)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(setting.model_provider_id, Some(id));
    assert!(setting.enabled);
    let config = env.read(CONFIG_REL).unwrap();
    assert_eq!(
        commit::codeg_provider_parts(&config).unwrap().base_url,
        "https://relay.test/v1"
    );
    assert_eq!(
        commit::auth_api_key(&env.read(AUTH_REL).unwrap()).as_deref(),
        Some("sk-p")
    );
}

/// The preferences write is one UPDATE without the provider column, so it
/// can never put back a binding a bind replaced.
#[tokio::test]
async fn a_preferences_write_never_touches_the_binding() {
    let db = codex_db().await;
    let a = add_provider(&db, "https://a.test/v1", "sk-a", None).await;
    let b = add_provider(&db, "https://b.test/v1", "sk-b", None).await;
    for bound in [Some(a), Some(b), None] {
        bind(&db, bound).await;
        agent_setting_service::update_preferences(
            &db.conn,
            AgentType::Codex,
            false,
            Some("{}".into()),
        )
        .await
        .unwrap();
        let now = agent_setting_service::get_by_agent_type(&db.conn, AgentType::Codex)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(now.model_provider_id, bound);
        assert!(!now.enabled);
        assert_eq!(now.env_json.as_deref(), Some("{}"));
    }
}
