use super::*;
use crate::acp::codex_endpoint_catalog::{FetchOutcome, OpenAiModelId};
use crate::acp::codex_runtime::test_hooks;
use serde_json::json;
use std::collections::BTreeMap;

pub(crate) mod hooks {
    use serde_json::Value;
    use std::cell::RefCell;

    thread_local! {
        static OFFICIALS: RefCell<Option<Vec<Value>>> = const { RefCell::new(None) };
    }

    pub fn set_officials(models: Option<Vec<Value>>) {
        OFFICIALS.with(|o| *o.borrow_mut() = models);
    }

    pub fn officials() -> Option<Vec<Value>> {
        OFFICIALS.with(|o| o.borrow().clone())
    }
}

/// A test home with a fake runtime and judge on this thread.
pub(crate) struct Env {
    pub(crate) dir: tempfile::TempDir,
    pub(crate) cache: EndpointCache,
}

impl Env {
    pub(crate) fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cache = EndpointCache::at(dir.path().join("cache"));
        std::fs::create_dir_all(dir.path().join("home")).unwrap();
        test_hooks::set_runtime(Some(test_hooks::runtime_of("0.160.1", "/fake/a/codex.js")));
        test_hooks::set_judge(Some(Box::new(|_, bytes| {
            if String::from_utf8_lossy(bytes).contains("REJECT-ME") {
                Err(JudgeError::Rejected("unknown variant `REJECT-ME`".into()))
            } else {
                Ok(serde_json::from_slice::<Value>(bytes).unwrap()["models"]
                    .as_array()
                    .unwrap()
                    .len())
            }
        })));
        hooks::set_officials(Some(catalog::bundled_snapshot_models()));
        Self { dir, cache }
    }

    pub(crate) fn home(&self) -> PathBuf {
        self.dir.path().join("home")
    }

    pub(crate) fn write(&self, name: &str, text: &str) {
        std::fs::write(self.home().join(name), text).unwrap();
    }

    pub(crate) fn read(&self, name: &str) -> Option<String> {
        std::fs::read_to_string(self.home().join(name)).ok()
    }

    pub(crate) fn published(&self) -> Published {
        Published::read(&self.home()).unwrap()
    }

    pub(crate) fn meta(&self) -> CatalogMeta {
        serde_json::from_str(&self.read(META_REL).unwrap()).unwrap()
    }

    pub(crate) fn catalog_slugs(&self) -> Vec<String> {
        let v: Value = serde_json::from_str(&self.read(catalog::CATALOG_REL).unwrap()).unwrap();
        v["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["slug"].as_str().unwrap().to_string())
            .collect()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        test_hooks::set_runtime(None);
        test_hooks::set_judge(None);
        hooks::set_officials(None);
        crate::acp::provider_models::clock::set(None);
    }
}

pub(crate) const PANEL_TOML: &str = r#"# my notes
model_provider = "codeg"

[model_providers.codeg]
name = "codeg"
base_url = "BASE"
wire_api = "responses"
requires_openai_auth = true
"#;

pub(crate) fn panel_toml(base: &str) -> String {
    PANEL_TOML.replace("BASE", base)
}

pub(crate) const AUTH: &str = r#"{"OPENAI_API_KEY":"sk-test"}"#;

/// Prepare and commit a panel-mode save of `intent` over what is on disk.
pub(crate) async fn save_panel(
    env: &Env,
    intent: Option<&str>,
    fetch: FetchPolicy,
) -> Result<CommitOutcome, CatalogError> {
    let published = env.published();
    let toml = TomlInput::disk();
    let config = compose_toml(&toml, published.config_text())?;
    let prepared = prepare(PrepareInput {
        origin: Origin::User,
        binding: Binding::Panel,
        intent_raw: intent.map(str::to_string),
        toml_text: &config,
        auth_text: published.auth_text(),
        published: &published,
        fetch,
        cache: &env.cache,
    })
    .await?;
    let locked = lock_home(&env.home()).await?;
    locked
        .commit(
            &prepared,
            &CurrentIntent {
                binding: Binding::Panel,
                intent_raw: intent.map(str::to_string),
            },
            &toml,
            &AuthInput::Keep,
            &ReleaseModel::Keep,
        )
        .await
        .map_err(|e| match e {
            CommitError::Failed(e) => e,
            other => err("stale", format!("{other:?}")),
        })
}

fn snapshot_for(
    request: &EndpointRequest,
    seq: u64,
    payload: endpoint::EndpointPayload,
) -> EndpointSnapshot {
    let outcome = FetchOutcome {
        payload,
        bytes: 10,
        elapsed_ms: 1,
        started_at: Utc::now(),
        fetched_at: Utc::now(),
    };
    endpoint::snapshot_of(
        request,
        seq,
        "0.160.1",
        true,
        &outcome,
        &Default::default(),
        &[],
    )
}

fn native(entries: &[(&str, &str)]) -> endpoint::EndpointPayload {
    let base = catalog::bundled_snapshot_models()[0].clone();
    endpoint::EndpointPayload::Native(
        entries
            .iter()
            .map(|(slug, visibility)| {
                let mut m = base.clone();
                m["slug"] = json!(slug);
                m["display_name"] = json!(slug);
                m["visibility"] = json!(visibility);
                m["supported_in_api"] = json!(false);
                m
            })
            .collect(),
    )
}

fn ids(list: &[&str]) -> endpoint::EndpointPayload {
    endpoint::EndpointPayload::OpenAiList(
        list.iter()
            .map(|i| OpenAiModelId {
                id: (*i).into(),
                context_window: None,
            })
            .collect(),
    )
}

// ─── Plan rules ─────────────────────────────────────────────────────────

#[test]
fn plan_rows_pick_the_catalog_the_intent_needs() {
    let officials = catalog::bundled_snapshot_models();
    // Row 3: nothing deviates — removing officials codex has since hidden
    // does not either.
    let (plan, _) = build_plan(&CodexModelConfig::default(), &officials, None).unwrap();
    assert_eq!(plan, PlanKind::Release);
    let ghosts = catalog::parse_model_config(Some(
        r#"{"customs":[],"excludedOfficials":["gpt-5.4","gpt-5.4-mini"]}"#,
    ));
    assert_eq!(
        build_plan(&ghosts, &officials, None).unwrap().0,
        PlanKind::Release
    );
    // Row 2: a custom expands against the officials.
    let customs = catalog::parse_model_config(Some(
        r#"{"customs":[{"slug":"gw/x","base":"gpt-6.1-sol"}]}"#,
    ));
    let (plan, degraded) = build_plan(&customs, &officials, None).unwrap();
    let PlanKind::Static(built) = plan else {
        panic!()
    };
    assert!(degraded.is_none());
    assert_eq!(built.counts.total, officials.len() + 1);
    assert_eq!(built.default_model.as_deref(), Some("gw/x"));

    let request = EndpointRequest::new("https://r/v1", None, &[], &[], "sk").unwrap();
    // Row 1, native: the provider's entries, the blocklist applied, listed
    // entries made API-usable.
    let intent = catalog::parse_model_config(Some(
        r#"{"customs":[],"excludedOfficials":["b"],"catalog":{"format":"native"}}"#,
    ));
    let up = snapshot_for(
        &request,
        1,
        native(&[("a", "list"), ("b", "list"), ("h", "hide")]),
    );
    let (plan, _) = build_plan(&intent, &officials, Some(&up)).unwrap();
    let PlanKind::Static(built) = plan else {
        panic!()
    };
    let cat: Value = serde_json::from_slice(&built.bytes).unwrap();
    let slugs: Vec<&str> = cat["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["slug"].as_str().unwrap())
        .collect();
    assert_eq!(slugs, ["a", "h"]);
    assert_eq!(cat["models"][0]["supported_in_api"], json!(true));
    assert_eq!(built.default_model.as_deref(), Some("a"));

    // Row 1, OpenAI list: only the picks, the blocklist ignored.
    let intent = catalog::parse_model_config(Some(
        r#"{"customs":[],"excludedOfficials":["glm-5"],"catalog":{"format":"openai_list","selected":["glm-5","kimi-k3"]}}"#,
    ));
    let up = snapshot_for(&request, 1, ids(&["glm-5", "kimi-k3", "embed-1"]));
    let (plan, _) = build_plan(&intent, &officials, Some(&up)).unwrap();
    let PlanKind::Static(built) = plan else {
        panic!()
    };
    let cat: Value = serde_json::from_slice(&built.bytes).unwrap();
    let slugs: Vec<&str> = cat["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["slug"].as_str().unwrap())
        .collect();
    assert_eq!(slugs, ["glm-5", "kimi-k3"]);
}

#[test]
fn without_a_provider_list_the_stand_ins_apply() {
    let officials = catalog::bundled_snapshot_models();
    // OpenAI list: the picks are rebuilt from templates.
    let intent = catalog::parse_model_config(Some(
        r#"{"customs":[],"catalog":{"format":"openai_list","selected":["glm-5"]}}"#,
    ));
    let (plan, degraded) = build_plan(&intent, &officials, None).unwrap();
    assert!(matches!(plan, PlanKind::Static(_)));
    assert_eq!(degraded, Some("no_provider_list"));
    // Native with a default: just that default, next to the customs.
    let intent = catalog::parse_model_config(Some(
        r#"{"customs":[{"slug":"mine","base":"gpt-6.1-sol"}],"default":"relay-x","catalog":{"format":"native"}}"#,
    ));
    let (plan, _) = build_plan(&intent, &officials, None).unwrap();
    let PlanKind::Static(built) = plan else {
        panic!()
    };
    let cat: Value = serde_json::from_slice(&built.bytes).unwrap();
    let slugs: Vec<&str> = cat["models"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["slug"].as_str().unwrap())
        .collect();
    assert_eq!(slugs, ["mine", "relay-x"]);
    assert_eq!(built.default_model.as_deref(), Some("relay-x"));
    // Native with neither: codex's own list.
    let intent =
        catalog::parse_model_config(Some(r#"{"customs":[],"catalog":{"format":"native"}}"#));
    let (plan, degraded) = build_plan(&intent, &officials, None).unwrap();
    assert_eq!(plan, PlanKind::Release);
    assert_eq!(degraded, Some("no_provider_list"));
}

#[test]
fn a_catalog_with_nothing_usable_is_refused() {
    let officials = catalog::bundled_snapshot_models();
    let request = EndpointRequest::new("https://r/v1", None, &[], &[], "sk").unwrap();
    let intent =
        catalog::parse_model_config(Some(r#"{"customs":[],"catalog":{"format":"native"}}"#));
    let up = snapshot_for(&request, 1, native(&[("h1", "hide"), ("h2", "hide")]));
    assert_eq!(
        build_plan(&intent, &officials, Some(&up)).unwrap_err().code,
        "no_usable_models"
    );
    // Removing every listed official leaves only hidden ones.
    let listed: Vec<String> = officials
        .iter()
        .filter(|m| m["visibility"] == "list")
        .map(|m| format!("\"{}\"", m["slug"].as_str().unwrap()))
        .collect();
    let intent = catalog::parse_model_config(Some(&format!(
        r#"{{"customs":[],"excludedOfficials":[{}]}}"#,
        listed.join(",")
    )));
    assert_eq!(
        build_plan(&intent, &officials, None).unwrap_err().code,
        "no_usable_models"
    );
}

// ─── config.toml ────────────────────────────────────────────────────────

/// codeg's `requires_openai_auth = true` goes in only where codex would not
/// read the provider as on actor authorization — `!requires_openai_auth`
/// and a non-blank `x-openai-actor-authorization` header, any letter case,
/// in a sub-table or inline — and whatever the user set stays.
#[test]
fn codegs_auth_default_follows_how_codex_reads_actor_authorization() {
    let input = TomlInput {
        base: None,
        baseline: None,
        edits: vec![TomlEdit::ProviderEndpoint {
            base_url: "https://new/v1".into(),
        }],
    };
    let flag = |table: &str| -> Option<bool> {
        let out = compose_toml(&input, &format!("model_provider = \"codeg\"\n{table}")).unwrap();
        let value: toml::Table = out.parse().unwrap();
        value["model_providers"]["codeg"]
            .get("requires_openai_auth")
            .and_then(toml::Value::as_bool)
    };
    let header = "x-openai-actor-authorization = \"local-image-extension\"";
    assert_eq!(
        flag("[model_providers.codeg]\nbase_url = \"https://x/v1\"\n"),
        Some(true)
    );
    assert_eq!(
        flag("[model_providers.codeg]\nrequires_openai_auth = false\n"),
        Some(false)
    );
    assert_eq!(
        flag("[model_providers.codeg]\nrequires_openai_auth = true\n"),
        Some(true)
    );
    assert_eq!(
        flag(&format!("[model_providers.codeg.http_headers]\n{header}\n")),
        None
    );
    assert_eq!(
        flag("[model_providers.codeg.http_headers]\nX-OpenAI-Actor-Authorization = \"t\"\n"),
        None
    );
    assert_eq!(
        flag("[model_providers.codeg]\nhttp_headers = { \"x-openai-actor-authorization\" = \"t\" }\n"),
        None
    );
    // A blank value does not turn the path on in codex.
    assert_eq!(
        flag("[model_providers.codeg.http_headers]\nx-openai-actor-authorization = \"  \"\n"),
        Some(true)
    );
    // Contradictory, but the user's.
    assert_eq!(
        flag(&format!(
            "[model_providers.codeg]\nrequires_openai_auth = true\n\n[model_providers.codeg.http_headers]\n{header}\n"
        )),
        Some(true)
    );
    // A quoted key with dots is one literal key, not the header table.
    assert_eq!(
        flag("[model_providers.codeg]\n\"http_headers.x-openai-actor-authorization\" = \"t\"\n"),
        Some(true)
    );
}

#[test]
fn a_bound_provider_endpoint_keeps_the_users_keys_and_comments() {
    let input = TomlInput {
        base: None,
        baseline: None,
        edits: vec![TomlEdit::ProviderEndpoint {
            base_url: "https://new/v1".into(),
        }],
    };
    let disk = "# keep me\napi_base_url = \"old\"\n\n[model_providers.codeg]\nbase_url = \"https://old/v1\"\nmodel_catalog_url = \"https://mine/models\"\n\n[model_providers.codeg.http_headers]\nX-Org = \"o\"\n";
    let out = compose_toml(&input, disk).unwrap();
    assert!(out.contains("# keep me"));
    assert!(!out.contains("api_base_url"));
    let parts = codeg_provider_parts(&out).unwrap();
    assert_eq!(parts.base_url, "https://new/v1");
    assert_eq!(parts.headers, [("X-Org".to_string(), "o".to_string())]);
    // The user's own URL stays: codeg never writes or removes it.
    assert!(out.contains("model_catalog_url = \"https://mine/models\""));
    assert!(out.contains("requires_openai_auth = true"));
    assert!(!out.contains("api_key_model_discovery"));

    // A provider on actor authorization does not get `requires_openai_auth`;
    // an explicit `false` stays.
    let actor = "[model_providers.codeg.http_headers]\nx-openai-actor-authorization = \"t\"\n";
    let out = compose_toml(&input, actor).unwrap();
    assert!(!out.contains("requires_openai_auth"));
    let explicit =
        "model_provider = \"codeg\"\n[model_providers.codeg]\nrequires_openai_auth = false\n";
    let out = compose_toml(&input, explicit).unwrap();
    assert!(out.contains("requires_openai_auth = false"));

    // A provider the user named gets the endpoint and nothing of codeg's; a
    // built-in id cannot be configured, so codeg's own provider takes over.
    let custom =
        "model_provider = \"custom\"\n\n[model_providers.custom]\nbase_url = \"https://old/v1\"\n";
    let out = compose_toml(&input, custom).unwrap();
    let value: toml::Table = out.parse().unwrap();
    assert_eq!(value["model_provider"].as_str(), Some("custom"));
    let table = value["model_providers"]["custom"].as_table().unwrap();
    assert_eq!(table["base_url"].as_str(), Some("https://new/v1"));
    assert_eq!(table.len(), 1, "{out}");
    let out = compose_toml(&input, "model_provider = \"openai\"\n").unwrap();
    assert_eq!(
        codeg_provider_parts(&out).unwrap().base_url,
        "https://new/v1"
    );
    // codex 0.165 builds in `gcp` (Vertex AI), whose table takes only
    // `base_url`, `auth` and `http_headers`: the binding moves to codeg's own
    // provider and leaves the user's `gcp` table as written.
    let gcp = "model_provider = \"gcp\"\n\n[model_providers.gcp]\nbase_url = \"https://vertex.example/v1\"\n";
    let out = compose_toml(&input, gcp).unwrap();
    let value: toml::Table = out.parse().unwrap();
    assert_eq!(value["model_provider"].as_str(), Some("codeg"));
    assert_eq!(
        value["model_providers"]["gcp"]["base_url"].as_str(),
        Some("https://vertex.example/v1")
    );
    assert_eq!(
        codeg_provider_parts(&out).unwrap().base_url,
        "https://new/v1"
    );
}

/// Only codeg's own file is ever codeg's: a catalog the user wrote (or
/// typed into the raw editor) keeps its reference through every save, and
/// codeg never deletes it.
#[test]
fn a_catalog_the_user_wrote_is_never_taken_for_codegs() {
    let home = Path::new("/codex-home");
    for foreign in [
        "manual.json",
        "/abs/path/to/manual.json",
        "~/my-catalog.json",
        "nested/codeg-model-catalog.json",
        "  ",
    ] {
        assert!(!is_codeg_catalog_ref(foreign, home), "{foreign}");
    }
    let absolute = home.join(catalog::CATALOG_REL);
    assert!(is_codeg_catalog_ref(&absolute.to_string_lossy(), home));
    assert!(is_codeg_catalog_ref(catalog::CATALOG_REL, home));
}

#[test]
fn removing_a_root_key_keeps_the_comments_above_it() {
    let removed = |text: &str, key: &str| {
        let mut doc = parse_doc(text).unwrap();
        remove_root(&mut doc, key);
        doc.to_string()
    };
    assert_eq!(
        removed(
            "# header\nmodel_catalog_json = \"x\"\nmodel = \"m\"\n",
            "model_catalog_json"
        ),
        "# header\nmodel = \"m\"\n"
    );
    // The last root value hands them to the first table header.
    assert_eq!(
        removed(
            "# header\nmodel_catalog_json = \"x\"\n\n[c]\nk = 2\n\n[a.b]\nk = 1\n",
            "model_catalog_json"
        ),
        "# header\n\n[c]\nk = 2\n\n[a.b]\nk = 1\n"
    );
    assert_eq!(
        removed(
            "model_catalog_json = \"x\"\n# trailing\n",
            "model_catalog_json"
        ),
        "# trailing\n"
    );
    assert_eq!(removed("model = \"m\"\n", "absent"), "model = \"m\"\n");
}

#[test]
fn leaving_codegs_provider_prunes_only_a_table_that_is_all_codegs() {
    // The subscription switch drops `model_provider`; a table of codeg's
    // own keys goes with it…
    let switched = "[model_providers.codeg]\nname = \"codeg\"\nbase_url = \"https://r/v1\"\nwire_api = \"responses\"\nrequires_openai_auth = true\n";
    let input = TomlInput {
        base: Some(switched.to_string()),
        baseline: None,
        edits: vec![],
    };
    let out = compose_toml(&input, "").unwrap();
    assert!(!out.contains("model_providers"), "{out}");
    // …but one with a key of the user's stays whole, `name` included: codex
    // refuses a provider without it.
    let mixed = format!("{switched}model_catalog_url = \"https://mine\"\n");
    let input = TomlInput {
        base: Some(mixed.clone()),
        baseline: None,
        edits: vec![],
    };
    let out = compose_toml(&input, "").unwrap();
    assert_eq!(out, mixed);
    let loaded: toml::Table = out.parse().unwrap();
    assert_eq!(
        loaded["model_providers"]["codeg"]["name"].as_str(),
        Some("codeg")
    );
    // Still the active provider: never touched.
    let active = format!("model_provider = \"codeg\"\n{switched}");
    let input = TomlInput {
        base: Some(active.clone()),
        baseline: None,
        edits: vec![],
    };
    assert_eq!(compose_toml(&input, "").unwrap(), active);
}

#[test]
fn auth_inputs_compose_as_asked() {
    assert_eq!(compose_auth(&AuthInput::Keep, "x").unwrap(), "x");
    assert_eq!(
        compose_auth(&AuthInput::Text("  ".into()), "x").unwrap(),
        "x"
    );
    assert!(compose_auth(&AuthInput::Text("[1]".into()), "").is_err());
    let set = compose_auth(
        &AuthInput::SetKey {
            base: None,
            key: "sk-new".into(),
        },
        r#"{"OPENAI_API_KEY":"sk-old","tokens":{"a":1}}"#,
    )
    .unwrap();
    let v: Value = serde_json::from_str(&set).unwrap();
    assert_eq!(v["OPENAI_API_KEY"], "sk-new");
    assert_eq!(v["tokens"]["a"], 1);
    assert_eq!(
        compose_auth(
            &AuthInput::SetKey {
                base: None,
                key: "".into()
            },
            AUTH
        )
        .unwrap(),
        AUTH
    );
}

// ─── Commit ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_custom_takes_over_the_managed_keys_and_releasing_hands_them_back() {
    let env = Env::new();
    env.write(CONFIG_REL, "# mine\nmodel = \"gpt-5.5\"\n");
    let intent = r#"{"customs":[{"slug":"gw/x","base":"gpt-6.1-sol"}],"default":"gw/x"}"#;
    save_panel(&env, Some(intent), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    let config = env.read(CONFIG_REL).unwrap();
    assert!(config.contains("# mine"));
    assert!(config.contains("model = \"gw/x\""));
    assert!(config.contains("model_catalog_json = \"codeg-model-catalog.json\""));
    assert_eq!(env.read(catalog::SOURCE_REL).as_deref(), Some(intent));
    let meta = env.meta();
    assert_eq!(meta.binding, "panel");
    assert_eq!(meta.validated_versions(), ["0.160.1"]);
    assert_eq!(meta.default_model.as_deref(), Some("gw/x"));
    assert!(env.catalog_slugs().contains(&"gw/x".to_string()));

    // Removing it: the reference and the bookkeeping go; the file waits.
    save_panel(&env, Some(r#"{"customs":[]}"#), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    let config = env.read(CONFIG_REL).unwrap();
    assert!(!config.contains("model_catalog_json"));
    assert!(env.read(catalog::SOURCE_REL).is_none());
    assert!(env.read(META_REL).is_none());
    assert!(env.read(catalog::CATALOG_REL).is_some(), "deferred");
    cleanup_released(&env.home()).await.unwrap();
    assert!(env.read(catalog::CATALOG_REL).is_none());
}

#[tokio::test]
async fn a_users_own_catalog_reference_is_never_removed() {
    let env = Env::new();
    env.write(
        CONFIG_REL,
        "model_catalog_json = \"/elsewhere/mine.json\"\n",
    );
    save_panel(&env, None, FetchPolicy::IfNeeded).await.unwrap();
    assert!(env
        .read(CONFIG_REL)
        .unwrap()
        .contains("model_catalog_json = \"/elsewhere/mine.json\""));
    // Taking over for a custom points at codeg's file; theirs stays on disk.
    let intent = r#"{"customs":[{"slug":"gw/x","base":"gpt-6.1-sol"}]}"#;
    save_panel(&env, Some(intent), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    assert!(env
        .read(CONFIG_REL)
        .unwrap()
        .contains("model_catalog_json = \"codeg-model-catalog.json\""));
}

#[tokio::test]
async fn editing_a_managed_key_by_hand_is_refused_but_a_disk_change_is_not() {
    let env = Env::new();
    let intent = r#"{"customs":[{"slug":"gw/x","base":"gpt-6.1-sol"}]}"#;
    env.write(CONFIG_REL, "model = \"a\"\n");
    save_panel(&env, Some(intent), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    let loaded = env.read(CONFIG_REL).unwrap();

    let commit_text = |text: String, baseline: String| {
        let env = &env;
        async move {
            let published = env.published();
            let toml = TomlInput {
                base: Some(text),
                baseline: Some(baseline),
                edits: vec![],
            };
            let config = compose_toml(&toml, published.config_text()).unwrap();
            let prepared = prepare(PrepareInput {
                origin: Origin::User,
                binding: Binding::Panel,
                intent_raw: Some(intent.to_string()),
                toml_text: &config,
                auth_text: "",
                published: &published,
                fetch: FetchPolicy::IfNeeded,
                cache: &env.cache,
            })
            .await
            .unwrap();
            lock_home(&env.home())
                .await
                .unwrap()
                .commit(
                    &prepared,
                    &CurrentIntent {
                        binding: Binding::Panel,
                        intent_raw: Some(intent.to_string()),
                    },
                    &toml,
                    &AuthInput::Keep,
                    &ReleaseModel::Keep,
                )
                .await
        }
    };
    // The raw editor changed root `model`: refused, with the key named.
    let edited = loaded.replace("model = \"gw/x\"", "model = \"typed\"");
    match commit_text(edited, loaded.clone()).await {
        Err(CommitError::Failed(e)) => {
            assert_eq!(e.code, "managed_key_edited");
            assert_eq!(e.params["key"], "model");
        }
        other => panic!("{other:?}"),
    }
    // The draft is older than the disk (another window, a refresh): its stale
    // managed keys are recomputed, not taken for an edit.
    let old_draft = "model = \"a\"\n".to_string();
    commit_text(old_draft.clone(), old_draft).await.unwrap();
    assert!(env.read(CONFIG_REL).unwrap().contains("model = \"gw/x\""));
}

#[tokio::test]
async fn the_commit_check_drops_results_built_on_something_that_changed() {
    let env = Env::new();
    env.write(CONFIG_REL, "");
    let intent = r#"{"customs":[{"slug":"gw/x","base":"gpt-6.1-sol"}]}"#;
    let published = env.published();
    let prepared = prepare(PrepareInput {
        origin: Origin::Background,
        binding: Binding::Panel,
        intent_raw: Some(intent.into()),
        toml_text: "",
        auth_text: "",
        published: &published,
        fetch: FetchPolicy::Never,
        cache: &env.cache,
    })
    .await
    .unwrap();
    let commit = |current: CurrentIntent| {
        let env = &env;
        let prepared = &prepared;
        async move {
            lock_home(&env.home())
                .await
                .unwrap()
                .commit(
                    prepared,
                    &current,
                    &TomlInput::disk(),
                    &AuthInput::Keep,
                    &ReleaseModel::Keep,
                )
                .await
        }
    };
    // Re-bound meanwhile.
    let r = commit(CurrentIntent {
        binding: Binding::Provider(3),
        intent_raw: Some(intent.into()),
    })
    .await;
    assert!(matches!(r, Err(CommitError::Stale(_))));
    // Intent edited meanwhile.
    let r = commit(CurrentIntent {
        binding: Binding::Panel,
        intent_raw: Some(r#"{"customs":[]}"#.into()),
    })
    .await;
    assert!(matches!(r, Err(CommitError::Stale(_))));
    // Runtime upgraded meanwhile.
    test_hooks::set_runtime(Some(test_hooks::runtime_of("0.161.0", "/fake/b/codex.js")));
    let r = commit(CurrentIntent {
        binding: Binding::Panel,
        intent_raw: Some(intent.into()),
    })
    .await;
    assert!(matches!(r, Err(CommitError::Stale(_))));
    test_hooks::set_runtime(Some(test_hooks::runtime_of("0.160.1", "/fake/a/codex.js")));
    // Another process published a catalog meanwhile.
    env.write(catalog::CATALOG_REL, "{\"models\":[]}");
    let r = commit(CurrentIntent {
        binding: Binding::Panel,
        intent_raw: Some(intent.into()),
    })
    .await;
    assert!(matches!(r, Err(CommitError::Stale(_))));
    std::fs::remove_file(env.home().join(catalog::CATALOG_REL)).unwrap();
    // Unchanged: it goes through.
    commit(CurrentIntent {
        binding: Binding::Panel,
        intent_raw: Some(intent.into()),
    })
    .await
    .unwrap();
}

// ─── Provider lists ─────────────────────────────────────────────────────

/// A loopback server answering each request with the next of `responses`,
/// counting what it served.
pub(crate) async fn serve(
    responses: Vec<(u16, String)>,
) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = hits.clone();
    tokio::spawn(async move {
        for (status, body) in responses {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let mut buf = vec![0u8; 8192];
            let _ = sock.read(&mut buf).await;
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let text = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(text.as_bytes()).await;
            let _ = sock.shutdown().await;
        }
    });
    (format!("http://{addr}/v1"), hits)
}

pub(crate) fn native_body(slugs: &[&str]) -> String {
    let base = catalog::bundled_snapshot_models()[0].clone();
    let models: Vec<Value> = slugs
        .iter()
        .map(|s| {
            let mut m = base.clone();
            m["slug"] = json!(s);
            m["visibility"] = json!("list");
            m
        })
        .collect();
    json!({ "models": models }).to_string()
}

pub(crate) const NATIVE_INTENT: &str = r#"{"customs":[],"catalog":{"format":"native"}}"#;

#[tokio::test]
async fn a_provider_list_is_fetched_published_and_kept_through_an_outage() {
    let env = Env::new();
    let (base, hits) = serve(vec![
        (200, native_body(&["r1", "r2"])),
        (500, "down".into()),
        (500, "down".into()),
    ])
    .await;
    env.write(CONFIG_REL, &panel_toml(&base));
    env.write(AUTH_REL, AUTH);
    save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    assert_eq!(env.catalog_slugs(), ["r1", "r2"]);
    let meta = env.meta();
    assert_eq!(meta.format, Some(CatalogFormat::Native));
    assert_eq!(meta.request_seq, Some(1));
    assert!(meta.checked_at.is_some());
    assert!(!meta.stale && meta.degraded.is_none());
    assert!(env.read(UPSTREAM_REL).is_some());
    let first = env.read(catalog::CATALOG_REL);

    // Up to date: a plain save does not fetch again.
    save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);

    // A forced refresh during an outage keeps what is published, untouched.
    let published = env.published();
    let prepared = prepare(PrepareInput {
        origin: Origin::Background,
        binding: Binding::Panel,
        intent_raw: published.sidecar.clone(),
        toml_text: published.config_text(),
        auth_text: published.auth_text(),
        published: &published,
        fetch: FetchPolicy::Force,
        cache: &env.cache,
    })
    .await
    .unwrap();
    assert!(prepared.is_noop(), "{:?}", prepared.plan);
    assert_eq!(prepared.fetch_error.as_ref().unwrap().code, "http_status");
    assert_eq!(env.read(catalog::CATALOG_REL), first);
}

#[tokio::test]
async fn an_unchanged_answer_only_updates_when_it_was_confirmed() {
    let env = Env::new();
    let (base, _) = serve(vec![
        (200, native_body(&["r1"])),
        (200, native_body(&["r1"])),
    ])
    .await;
    env.write(CONFIG_REL, &panel_toml(&base));
    env.write(AUTH_REL, AUTH);
    save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    let before = env.meta();
    let catalog_before = env.read(catalog::CATALOG_REL);
    let upstream_before = env.read(UPSTREAM_REL);
    // The judge must not run for an answer that changed nothing.
    test_hooks::set_judge(Some(Box::new(|_, _| panic!("judged an unchanged list"))));
    let published = env.published();
    let prepared = prepare(PrepareInput {
        origin: Origin::Background,
        binding: Binding::Panel,
        intent_raw: published.sidecar.clone(),
        toml_text: published.config_text(),
        auth_text: published.auth_text(),
        published: &published,
        fetch: FetchPolicy::Force,
        cache: &env.cache,
    })
    .await
    .unwrap();
    let locked = lock_home(&env.home()).await.unwrap();
    let out = locked
        .commit(
            &prepared,
            &CurrentIntent {
                binding: Binding::Panel,
                intent_raw: published.sidecar.clone(),
            },
            &TomlInput::disk(),
            &AuthInput::Keep,
            &ReleaseModel::Keep,
        )
        .await
        .unwrap();
    assert_eq!(out.changed, [META_REL]);
    let after = env.meta();
    assert_eq!(after.request_seq, Some(2));
    assert!(after.checked_at >= before.checked_at);
    assert_eq!(after.snapshot_id, before.snapshot_id);
    assert_eq!(env.read(catalog::CATALOG_REL), catalog_before);
    assert_eq!(env.read(UPSTREAM_REL), upstream_before);
}

#[tokio::test]
async fn a_slow_old_request_cannot_overwrite_a_newer_publication() {
    let env = Env::new();
    let (base, _) = serve(vec![
        (200, native_body(&["old"])),
        (200, native_body(&["new"])),
    ])
    .await;
    env.write(CONFIG_REL, &panel_toml(&base));
    env.write(AUTH_REL, AUTH);
    env.write(catalog::SOURCE_REL, NATIVE_INTENT);
    let published = env.published();
    let input = || PrepareInput {
        origin: Origin::Background,
        binding: Binding::Panel,
        intent_raw: Some(NATIVE_INTENT.into()),
        toml_text: published.config_text(),
        auth_text: published.auth_text(),
        published: &published,
        fetch: FetchPolicy::Force,
        cache: &env.cache,
    };
    // A is issued first (seq 1), B second (seq 2); B publishes first.
    let a = prepare(input()).await.unwrap();
    let b = prepare(input()).await.unwrap();
    assert_eq!((a.request_seq, b.request_seq), (Some(1), Some(2)));
    let current = CurrentIntent {
        binding: Binding::Panel,
        intent_raw: Some(NATIVE_INTENT.into()),
    };
    let commit = |p: Prepared| {
        let env = &env;
        let current = current.clone();
        async move {
            lock_home(&env.home())
                .await
                .unwrap()
                .commit(
                    &p,
                    &current,
                    &TomlInput::disk(),
                    &AuthInput::Keep,
                    &ReleaseModel::Keep,
                )
                .await
        }
    };
    commit(b).await.unwrap();
    assert_eq!(env.catalog_slugs(), ["new"]);
    // A arrives late: dropped by the snapshot check, and by the order if the
    // content had matched.
    assert!(commit(a.clone()).await.is_err());
    let mut a_same = a;
    a_same.basis.snapshot_id = env.published().snapshot_id();
    a_same.basis.meta_id = env.published().meta_id();
    assert!(matches!(commit(a_same).await, Err(CommitError::Superseded)));
    assert_eq!(env.catalog_slugs(), ["new"]);
    assert_eq!(env.meta().request_seq, Some(2));
}

#[tokio::test]
async fn fallbacks_come_from_the_same_url_only_and_say_so() {
    let env = Env::new();
    let (base, _) = serve(vec![(200, native_body(&["k1"]))]).await;
    env.write(CONFIG_REL, &panel_toml(&base));
    env.write(AUTH_REL, AUTH);
    save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    assert_eq!(env.catalog_slugs(), ["k1"]);

    // A new key, and the provider is down: the same URL's earlier list stands
    // in, marked stale.
    env.write(AUTH_REL, r#"{"OPENAI_API_KEY":"sk-other"}"#);
    let (_dead, _) = serve(vec![]).await;
    save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::Never)
        .await
        .unwrap();
    let meta = env.meta();
    assert!(meta.stale, "{meta:?}");
    assert_eq!(env.catalog_slugs(), ["k1"]);

    // Another provider entirely: nothing of the first stands in for it.
    let (other, _) = serve(vec![(500, "down".into())]).await;
    env.write(CONFIG_REL, &panel_toml(&other));
    let err = save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
        .await
        .unwrap_err();
    assert_eq!(err.code, "http_status");
}

#[tokio::test]
async fn a_list_in_the_other_shape_is_not_published_as_this_intent() {
    let env = Env::new();
    let (base, _) = serve(vec![
        (200, native_body(&["r1"])),
        (200, r#"{"data":[{"id":"x"}]}"#.into()),
        (200, r#"{"data":[{"id":"x"}]}"#.into()),
    ])
    .await;
    env.write(CONFIG_REL, &panel_toml(&base));
    env.write(AUTH_REL, AUTH);
    save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    // A user's forced save is told.
    let err = save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::Force)
        .await
        .unwrap_err();
    assert_eq!(err.code, "format_changed");
    // The background keeps what is published and remembers.
    let published = env.published();
    let prepared = prepare(PrepareInput {
        origin: Origin::Background,
        binding: Binding::Panel,
        intent_raw: published.sidecar.clone(),
        toml_text: published.config_text(),
        auth_text: published.auth_text(),
        published: &published,
        fetch: FetchPolicy::Force,
        cache: &env.cache,
    })
    .await
    .unwrap();
    assert!(matches!(prepared.plan, PlanKind::Keep { .. }));
    assert_eq!(
        prepared.meta.as_ref().unwrap().pending_format,
        Some(CatalogFormat::OpenaiList)
    );
    assert_eq!(env.catalog_slugs(), ["r1"]);
}

#[tokio::test]
async fn an_answer_codex_refuses_is_reported_to_the_user() {
    let env = Env::new();
    let (base, _) = serve(vec![(200, native_body(&["REJECT-ME"]))]).await;
    env.write(CONFIG_REL, &panel_toml(&base));
    env.write(AUTH_REL, AUTH);
    let err = save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
        .await
        .unwrap_err();
    assert_eq!(err.code, "codex_rejected");
    assert!(env.read(catalog::CATALOG_REL).is_none());
}

// ─── Runtimes ───────────────────────────────────────────────────────────

#[tokio::test]
async fn compatible_runtimes_share_a_catalog_and_incompatible_ones_conflict() {
    let env = Env::new();
    let root = env.dir.path().join("installs");
    let a =
        crate::acp::codex_runtime::tests::fake_global_install(&root.join("a"), "2.2.2", "0.160.1");
    let b =
        crate::acp::codex_runtime::tests::fake_global_install(&root.join("b"), "2.3.0", "0.161.0");
    let js = |p: &Path| {
        p.join("node_modules/@openai/codex/bin/codex.js")
            .to_string_lossy()
            .into_owned()
    };
    let (js_a, js_b) = (js(&a), js(&b));
    test_hooks::set_runtime(Some(test_hooks::runtime_of("0.160.1", &js_a)));
    let intent = r#"{"customs":[{"slug":"gw/x","base":"gpt-6.1-sol"}]}"#;
    save_panel(&env, Some(intent), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    assert_eq!(env.meta().validated_versions(), ["0.160.1"]);

    // The other runtime accepts it too: both recorded, newest first.
    test_hooks::set_runtime(Some(test_hooks::runtime_of("0.161.0", &js_b)));
    let intent2 = r#"{"customs":[{"slug":"gw/y","base":"gpt-6.1-sol"}]}"#;
    save_panel(&env, Some(intent2), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    assert_eq!(env.meta().validated_versions(), ["0.161.0", "0.160.1"]);
    assert!(env.meta().conflict.is_empty());

    // The older one refuses what the newer one builds: still published (this
    // launch can use it), the conflict recorded.
    let refusing = js_a.clone();
    test_hooks::set_judge(Some(Box::new(move |js, bytes| {
        if js.to_string_lossy() == refusing {
            Err(JudgeError::Rejected("unknown field".into()))
        } else {
            Ok(serde_json::from_slice::<Value>(bytes).unwrap()["models"]
                .as_array()
                .unwrap()
                .len())
        }
    })));
    let intent3 = r#"{"customs":[{"slug":"gw/z","base":"gpt-6.1-sol"}]}"#;
    save_panel(&env, Some(intent3), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    let meta = env.meta();
    assert_eq!(meta.validated_versions(), ["0.161.0"]);
    assert_eq!(meta.conflict.len(), 1);
    assert_eq!(meta.conflict[0].version, "0.160.1");
}

// ─── Review regressions ─────────────────────────────────────────────────

/// Prepare and commit what is published, as a background refresh does.
async fn refresh_as_background(
    env: &Env,
    fetch: FetchPolicy,
) -> Result<CommitOutcome, CommitError> {
    let published = env.published();
    let prepared = prepare(PrepareInput {
        origin: Origin::Background,
        binding: Binding::Panel,
        intent_raw: published.sidecar.clone(),
        toml_text: published.config_text(),
        auth_text: published.auth_text(),
        published: &published,
        fetch,
        cache: &env.cache,
    })
    .await
    .map_err(CommitError::Failed)?;
    let locked = lock_home(&env.home()).await.map_err(CommitError::Failed)?;
    let current = CurrentIntent {
        binding: Binding::Panel,
        intent_raw: locked.published().sidecar.clone(),
    };
    locked
        .commit(
            &prepared,
            &current,
            &TomlInput::disk(),
            &AuthInput::Keep,
            &ReleaseModel::Keep,
        )
        .await
}

/// A provider source that a stand-in left without a catalog file keeps
/// having none when the provider then answers in the other shape: it must
/// not gain a `model_catalog_json` pointing at nothing.
#[tokio::test]
async fn a_format_change_with_nothing_published_publishes_no_reference() {
    let env = Env::new();
    let body = json!({"data": [{"id": "glm-5.2"}]}).to_string();
    let (base, _) = serve(vec![(200, body)]).await;
    env.write(CONFIG_REL, &panel_toml(&base));
    env.write(AUTH_REL, AUTH);
    env.write(catalog::SOURCE_REL, NATIVE_INTENT);
    env.write(
        META_REL,
        &serde_json::to_string(&CatalogMeta {
            version: 1,
            intent_hash: intent_hash(&catalog::parse_model_config(Some(NATIVE_INTENT))),
            binding: "panel".into(),
            degraded: Some("no_provider_list".into()),
            format: Some(CatalogFormat::Native),
            ..Default::default()
        })
        .unwrap(),
    );
    refresh_as_background(&env, FetchPolicy::Force)
        .await
        .unwrap();
    assert!(!env.read(CONFIG_REL).unwrap().contains("model_catalog_json"));
    assert!(env.read(catalog::CATALOG_REL).is_none());
    assert_eq!(env.meta().pending_format, Some(CatalogFormat::OpenaiList));
    assert_eq!(env.read(catalog::SOURCE_REL).unwrap(), NATIVE_INTENT);
}

/// codeg's file reached through `..` or a symlink is still codeg's file:
/// the cleanup must not delete what config.toml points at.
#[tokio::test]
async fn an_alias_of_codegs_catalog_is_codegs_catalog() {
    let env = Env::new();
    let home = env.home();
    let name = home.file_name().unwrap().to_string_lossy().into_owned();
    let alias = format!("../{name}/{}", catalog::CATALOG_REL);
    assert!(is_codeg_catalog_ref(&alias, &home));
    env.write(catalog::CATALOG_REL, "{\"models\":[]}");
    env.write(CONFIG_REL, &format!("model_catalog_json = \"{alias}\"\n"));
    cleanup_released(&home).await.unwrap();
    assert!(env.read(catalog::CATALOG_REL).is_some(), "still referenced");

    #[cfg(unix)]
    {
        let link = env.dir.path().join("link");
        std::os::unix::fs::symlink(&home, &link).unwrap();
        let through = link
            .join(catalog::CATALOG_REL)
            .to_string_lossy()
            .into_owned();
        assert!(is_codeg_catalog_ref(&through, &home));
    }
}

/// Another process confirming the same catalog under a later request changes
/// only the provenance; a result built on the older one must not overwrite it
/// (which would lower the request watermark).
#[tokio::test]
async fn a_result_built_on_older_provenance_is_dropped() {
    let env = Env::new();
    env.write(CONFIG_REL, "");
    let intent = r#"{"customs":[{"slug":"gw/x","base":"gpt-6.1-sol"}]}"#;
    save_panel(&env, Some(intent), FetchPolicy::Never)
        .await
        .unwrap();
    let published = env.published();
    test_hooks::set_runtime(Some(test_hooks::runtime_of("0.161.0", "/fake/b/codex.js")));
    let prepared = prepare(PrepareInput {
        origin: Origin::Prelaunch,
        binding: Binding::Panel,
        intent_raw: Some(intent.into()),
        toml_text: published.config_text(),
        auth_text: "",
        published: &published,
        fetch: FetchPolicy::Never,
        cache: &env.cache,
    })
    .await
    .unwrap();
    // Meanwhile another process records something about the same catalog.
    let mut meta = env.meta();
    meta.request_seq = Some(12);
    env.write(META_REL, &serde_json::to_string(&meta).unwrap());

    let locked = lock_home(&env.home()).await.unwrap();
    let r = locked
        .commit(
            &prepared,
            &CurrentIntent {
                binding: Binding::Panel,
                intent_raw: Some(intent.into()),
            },
            &TomlInput::disk(),
            &AuthInput::Keep,
            &ReleaseModel::Keep,
        )
        .await;
    assert!(matches!(r, Err(CommitError::Stale(_))), "{r:?}");
    assert_eq!(env.meta().request_seq, Some(12));
}

/// Going back to an endpoint whose list was fetched moments ago uses that
/// list, even though the endpoint saved in between was fetched later: the
/// two are different requests, not an older and a newer answer to one.
#[tokio::test]
async fn switching_back_to_an_endpoint_fetched_earlier_saves() {
    let env = Env::new();
    let (a, a_hits) = serve(vec![(200, native_body(&["a1"]))]).await;
    let (b, _) = serve(vec![(200, native_body(&["b1"]))]).await;
    env.write(AUTH_REL, AUTH);
    for base in [&a, &b] {
        env.write(CONFIG_REL, &panel_toml(base));
        save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
            .await
            .unwrap();
    }
    assert_eq!(env.catalog_slugs(), ["b1"]);
    env.write(CONFIG_REL, &panel_toml(&a));
    save_panel(&env, Some(NATIVE_INTENT), FetchPolicy::IfNeeded)
        .await
        .unwrap();
    assert_eq!(env.catalog_slugs(), ["a1"]);
    assert_eq!(a_hits.load(std::sync::atomic::Ordering::SeqCst), 1);
}

// ─── Interrupted saves ──────────────────────────────────────────────────

/// Every file under `CODEX_HOME`, by name.
fn files(env: &Env) -> BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(env.home())
        .unwrap()
        .flatten()
        .filter(|e| e.path().is_file())
        .map(|e| {
            (
                e.file_name().to_string_lossy().into_owned(),
                std::fs::read(e.path()).unwrap(),
            )
        })
        .collect()
}

pub(crate) const CUSTOM_X: &str =
    r#"{"customs":[{"slug":"gw/x","base":"gpt-6.1-sol"}],"default":"gw/x"}"#;
pub(crate) const CUSTOM_Y: &str =
    r#"{"customs":[{"slug":"gw/y","base":"gpt-6.1-sol"}],"default":"gw/y"}"#;

/// Publish `CUSTOM_X`, then let a save of `CUSTOM_Y` die just before its
/// commit point and someone change the catalog it had already put in place.
pub(crate) async fn interrupted_and_edited(env: &Env) {
    env.write(CONFIG_REL, "");
    save_panel(env, Some(CUSTOM_X), FetchPolicy::Never)
        .await
        .unwrap();
    txn::tests::crash_before(Some(CONFIG_REL));
    let crashed = save_panel(env, Some(CUSTOM_Y), FetchPolicy::Never).await;
    txn::tests::crash_before(None);
    assert!(crashed.is_err(), "{crashed:?}");
    assert!(interrupted(&env.home()));
    env.write(catalog::CATALOG_REL, r#"{"models":[]}"#);
}

/// An interrupted save whose file someone else then changed blocks every
/// commit: a save names the file and where its old version is, and writes
/// nothing. Once that version is copied back, the next save undoes the
/// interrupted one and lands.
#[tokio::test]
async fn an_unresolved_interrupted_save_blocks_saves_until_its_file_is_put_back() {
    let env = Env::new();
    interrupted_and_edited(&env).await;
    let before = files(&env);
    let refused = save_panel(&env, Some(CUSTOM_X), FetchPolicy::Never)
        .await
        .unwrap_err();
    assert_eq!(refused.code, "repair_needed");
    assert_eq!(
        refused.params.get("path").map(String::as_str),
        Some(env.home().join(catalog::CATALOG_REL).to_str().unwrap())
    );
    assert_eq!(
        refused.params.get("fix").map(String::as_str),
        Some("copy_back")
    );
    let backup = refused.params["backup"].clone();
    assert_eq!(files(&env), before, "nothing written");

    std::fs::copy(&backup, env.home().join(catalog::CATALOG_REL)).unwrap();
    // The first save after the fix undoes the interrupted one under the
    // lock, which moves what it prepared on: it has to prepare again, as a
    // user's save does on its own (`commit_user_change_at` tries twice).
    let first = save_panel(&env, Some(CUSTOM_Y), FetchPolicy::Never).await;
    assert_eq!(first.unwrap_err().code, "stale");
    assert!(!interrupted(&env.home()));
    save_panel(&env, Some(CUSTOM_Y), FetchPolicy::Never)
        .await
        .unwrap();
    assert_eq!(env.read(catalog::SOURCE_REL).as_deref(), Some(CUSTOM_Y));
    assert!(env.catalog_slugs().contains(&"gw/y".to_string()));
    assert!(env.read(CONFIG_REL).unwrap().contains("model = \"gw/y\""));
    let leftovers: Vec<_> = files(&env)
        .into_keys()
        .filter(|n| n.starts_with(".codeg-txn-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

/// The order the files go out in, read off a save that changes all six:
/// each before what references it, config.toml — the commit point — last.
#[tokio::test]
async fn a_save_that_changes_everything_publishes_the_commit_point_last() {
    let env = Env::new();
    let (base, _) = serve(vec![(200, native_body(&["r1", "r2"]))]).await;
    env.write(CONFIG_REL, &panel_toml(&base));
    env.write(AUTH_REL, AUTH);
    let new_auth = r#"{"OPENAI_API_KEY":"sk-other"}"#;
    let published = env.published();
    let toml = TomlInput::disk();
    let config = compose_toml(&toml, published.config_text()).unwrap();
    let prepared = prepare(PrepareInput {
        origin: Origin::User,
        binding: Binding::Panel,
        intent_raw: Some(NATIVE_INTENT.to_string()),
        toml_text: &config,
        auth_text: new_auth,
        published: &published,
        fetch: FetchPolicy::IfNeeded,
        cache: &env.cache,
    })
    .await
    .unwrap();
    let locked = lock_home(&env.home()).await.unwrap();
    let out = locked
        .commit(
            &prepared,
            &CurrentIntent {
                binding: Binding::Panel,
                intent_raw: Some(NATIVE_INTENT.to_string()),
            },
            &toml,
            &AuthInput::Text(new_auth.to_string()),
            &ReleaseModel::Keep,
        )
        .await
        .unwrap();
    assert_eq!(
        out.changed,
        [
            catalog::CATALOG_REL,
            UPSTREAM_REL,
            META_REL,
            catalog::SOURCE_REL,
            AUTH_REL,
            CONFIG_REL,
        ]
    );
}

/// Against the codex-acp installed on this machine (`--ignored` only): the
/// config.toml a switch to the ChatGPT subscription leaves loads in codex —
/// codeg's provider table gone when it held only codeg's keys, kept whole
/// when it held one of the user's own — while the table a removal of
/// codeg's keys alone would leave (no `name`) is refused, which is why the
/// switch keeps it whole.
#[tokio::test]
#[ignore]
async fn the_real_codex_loads_what_a_switch_to_the_subscription_leaves() {
    crate::acp::codex_runtime::invalidate();
    let runtime = codex_runtime::current().await;
    let js = runtime.codex_js.clone().expect("codex-acp installed");
    let node = which::which("node").expect("node on PATH");
    let loads = |toml: String| {
        let (node, js) = (node.clone(), js.clone());
        async move {
            let home = tempfile::tempdir().unwrap();
            std::fs::write(home.path().join("config.toml"), &toml).unwrap();
            let out = crate::process::tokio_command(&node)
                .arg(&js)
                .args(["debug", "models"])
                .env("CODEX_HOME", home.path())
                .output()
                .await
                .unwrap();
            (
                out.status.success(),
                String::from_utf8_lossy(&out.stderr).into_owned(),
            )
        }
    };
    // The panel's text after the switch: no root `model_provider`.
    let switched = |table: &str| {
        let text = format!("model = \"gpt-5.5\"\n\n[model_providers.codeg]\n{table}");
        compose_toml(
            &TomlInput {
                base: Some(text),
                baseline: None,
                edits: Vec::new(),
            },
            "",
        )
        .unwrap()
    };
    let codegs = "name = \"codeg\"\nbase_url = \"https://relay.example/v1\"\n\
                  wire_api = \"responses\"\nrequires_openai_auth = true\n";

    let only_codegs = switched(codegs);
    assert!(!only_codegs.contains("model_providers"), "{only_codegs}");
    let (ok, stderr) = loads(only_codegs).await;
    assert!(ok, "{stderr}");

    let with_users = switched(&format!(
        "{codegs}http_headers = {{ \"X-Team\" = \"a\" }}\n"
    ));
    assert!(with_users.contains("X-Team") && with_users.contains("name = \"codeg\""));
    let (ok, stderr) = loads(with_users).await;
    assert!(ok, "{stderr}");

    let (ok, _) =
        loads("[model_providers.codeg]\nhttp_headers = { \"X-Team\" = \"a\" }\n".into()).await;
    assert!(!ok, "codex took a provider without `name`");
}
