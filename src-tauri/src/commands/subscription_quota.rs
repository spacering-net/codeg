//! Read official plan usage for one saved account, without changing its login.
use crate::acp::{account_auth, agent_accounts, family_isolator};
use crate::{
    app_error::AppCommandError,
    db::{
        service::{agent_account_service, agent_setting_service, custom_agent_service},
        AppDatabase,
    },
    models::AgentType,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::Mutex,
};
#[path = "subscription_quota_credentials.rs"]
mod credentials;

const TTL: Duration = Duration::from_secs(30);
const DEADLINE: Duration = Duration::from_secs(12);
const AGENTS: [AgentType; 5] = [
    AgentType::ClaudeCode,
    AgentType::Codex,
    AgentType::Grok,
    AgentType::Cursor,
    AgentType::OpenCode,
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaRequest {
    pub agent_type: AgentType,
    pub agent_account_id: Option<String>,
    pub conversation_id: Option<i32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaAccount {
    pub agent_type: AgentType,
    pub agent_account_id: Option<String>,
    pub family: String,
    /// None means the native Default account. The client localizes that label.
    pub name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialQuotaRead {
    #[serde(flatten)]
    pub account: QuotaAccount,
    pub payload: Option<Value>,
    pub checked_at: i64,
}

struct Source {
    account: QuotaAccount,
    env: BTreeMap<String, String>,
    isolated: bool,
    provider_override: bool,
}
fn error(message: impl Into<String>) -> AppCommandError {
    AppCommandError::task_execution_failed(message.into())
}
fn family(agent: AgentType) -> Option<&'static str> {
    Some(match agent {
        AgentType::ClaudeCode => "claude",
        AgentType::Codex => "codex",
        AgentType::Grok => "grok",
        AgentType::Cursor => "cursor",
        AgentType::OpenCode => "opencode",
        _ => return None,
    })
}
fn custom_family(env: &BTreeMap<String, String>) -> Option<&'static str> {
    if env
        .get("CURSOR_CONFIG_DIR")
        .is_some_and(|v| !v.trim().is_empty())
    {
        return Some("cursor");
    }
    let (family, _) = family_isolator::isolator_from_env(env)?;
    let name = family.as_str();
    (name != "gemini").then_some(name)
}

pub async fn accounts_core(db: &AppDatabase) -> Result<Vec<QuotaAccount>, AppCommandError> {
    let mut rows: Vec<_> = AGENTS
        .into_iter()
        .map(|agent| QuotaAccount {
            agent_type: agent,
            agent_account_id: None,
            family: family(agent).unwrap().into(),
            name: None,
        })
        .collect();
    for account in agent_account_service::list_all(&db.conn).await? {
        let Some(agent) = AgentType::from_wire(&account.agent_type) else {
            continue;
        };
        let Some(family) = family(agent) else {
            continue;
        };
        rows.push(QuotaAccount {
            agent_type: agent,
            agent_account_id: Some(account.id),
            family: family.into(),
            name: Some(account.name),
        });
    }
    for def in custom_agent_service::list_defs(&db.conn).await? {
        if let Some(family) = custom_family(&family_isolator::spec_env_map(&def.spec)) {
            let Some(agent) = AgentType::from_wire(&format!("custom:{}", def.registry_id)) else {
                continue;
            };
            rows.push(QuotaAccount {
                agent_type: agent,
                agent_account_id: None,
                family: family.into(),
                name: Some(def.name),
            });
        }
    }
    Ok(rows)
}

async fn resolve_source(
    db: &AppDatabase,
    data_dir: &Path,
    request: QuotaRequest,
) -> Result<Source, AppCommandError> {
    let agent = request.agent_type;
    let id = agent_account_service::connection_account(
        &db.conn,
        agent,
        request.agent_account_id,
        request.conversation_id,
    )
    .await?;
    if let Some(custom) = agent.custom_id() {
        if id.is_some() {
            return Err(error("This agent does not support named accounts"));
        }
        let row = custom_agent_service::get(&db.conn, custom)
            .await?
            .ok_or_else(|| error("Agent not found"))?;
        let def = custom_agent_service::def_from_model(&row)
            .ok_or_else(|| error("Agent configuration unavailable"))?;
        let env = family_isolator::spec_env_map(&def.spec);
        let family =
            custom_family(&env).ok_or_else(|| error("Usage is unavailable for this agent"))?;
        return Ok(Source {
            account: QuotaAccount {
                agent_type: agent,
                agent_account_id: None,
                family: family.into(),
                name: Some(def.name),
            },
            env,
            isolated: true,
            provider_override: false,
        });
    }
    let family = family(agent).ok_or_else(|| error("Usage is unavailable for this agent"))?;
    let (name, env, isolated, provider_override) = if let Some(id) = id.as_deref() {
        let account = agent_account_service::resolve(&db.conn, agent, id).await?;
        // Match the account's actual launch settings, including its own API
        // key, without starting a session or synchronizing MCP/skills files.
        let env = account_auth::runtime_env(db, &account, data_dir)
            .await.map_err(|e| error(e.to_string()))?;
        (Some(account.name), env, true, false)
    } else {
        let setting = agent_setting_service::get_by_agent_type(&db.conn, agent).await?;
        let provider_override = setting.as_ref().and_then(|s| s.model_provider_id).is_some();
        let local = super::acp::load_agent_local_config_json(agent);
        let mut env =
            super::acp::build_runtime_env_from_setting(agent, setting.as_ref(), local.as_deref());
        super::acp::apply_model_provider_env(agent, setting.as_ref(), &mut env, &db.conn).await;
        (None, env, false, provider_override)
    };
    Ok(Source {
        account: QuotaAccount {
            agent_type: agent,
            agent_account_id: id,
            family: family.into(),
            name,
        },
        env,
        isolated,
        provider_override,
    })
}

impl Source {
    fn uses_api_provider(&self) -> bool {
        if self.provider_override {
            return true;
        }
        let keys: &[&str] = match self.account.family.as_str() {
            "claude" => &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
            "codex" => &["OPENAI_API_KEY", "CODEX_API_KEY"],
            "grok" => &["XAI_API_KEY", "GROK_API_KEY"],
            _ => &[],
        };
        if keys.iter().any(|key| self.value(key).is_some()) {
            return true;
        }
        if self.account.family == "claude" {
            if self.value("ANTHROPIC_BASE_URL").is_some_and(|base| {
                reqwest::Url::parse(&base)
                    .ok()
                    .and_then(|url| url.host_str().map(str::to_owned))
                    .as_deref()
                    != Some("api.anthropic.com")
            }) {
                return true;
            }
            return [
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_USE_FOUNDRY",
            ]
            .iter()
            .any(|key| {
                self.value(key)
                    .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            });
        }
        false
    }

    fn value(&self, key: &str) -> Option<String> {
        self.env
            .get(key)
            .cloned()
            .or_else(|| (!self.isolated).then(|| std::env::var(key).ok()).flatten())
            .filter(|s| !s.trim().is_empty())
    }
    fn home(&self, key: &str, default: &str) -> Option<PathBuf> {
        self.value(key).map(PathBuf::from).or_else(|| {
            (!self.isolated)
                .then(|| dirs::home_dir().map(|p| p.join(default)))
                .flatten()
        })
    }
    fn credential_path(&self) -> Option<PathBuf> {
        Some(match self.account.family.as_str() {
            "claude" => self
                .home("CLAUDE_CONFIG_DIR", ".claude")?
                .join(".credentials.json"),
            "codex" => self.home("CODEX_HOME", ".codex")?.join("auth.json"),
            "grok" => self.home("GROK_HOME", ".grok")?.join("auth.json"),
            "cursor" if cfg!(windows) => self
                .value("APPDATA")
                .map(PathBuf::from)?
                .join("Cursor/auth.json"),
            "cursor" if cfg!(target_os = "macos") => {
                self.home("HOME", "")?.join(".cursor/auth.json")
            }
            "cursor" => self
                .home("XDG_CONFIG_HOME", ".config")?
                .join("cursor/auth.json"),
            "opencode" => self
                .home("XDG_DATA_HOME", ".local/share")?
                .join("opencode/auth.json"),
            _ => return None,
        })
    }
    fn token(&self) -> Option<String> {
        let env_keys: &[&str] = match self.account.family.as_str() {
            "claude" => &["CLAUDE_CODE_OAUTH_TOKEN"],
            "cursor" => &["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],
            "opencode" => &["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"],
            _ => &[],
        };
        if let Some(value) = env_keys.iter().find_map(|key| self.value(key)) {
            return Some(value);
        }
        let text = std::fs::read_to_string(self.credential_path()?).ok()?;
        match self.account.family.as_str() {
            "claude" => credentials::claude_oauth_access_token_from_credentials(&text),
            "grok" => credentials::grok_cli_bearer_from_auth_json(&text),
            "cursor" => credentials::cursor_access_token_from_auth_json(&text),
            "opencode" => credentials::opencode_go_key_from_auth_json(&text),
            _ => None,
        }
    }
}

type CacheEntry = Arc<Mutex<Option<(Instant, Option<Value>)>>>;
type Cache = Mutex<HashMap<u64, CacheEntry>>;
static CACHE: OnceLock<Cache> = OnceLock::new();

fn cache_key(namespace: &Path, source: &Source) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    namespace.hash(&mut hasher);
    source.account.agent_type.hash(&mut hasher);
    source.account.agent_account_id.hash(&mut hasher);
    source.env.hash(&mut hasher);
    source.provider_override.hash(&mut hasher);
    source.credential_path().hash(&mut hasher);
    account_auth::revision().hash(&mut hasher);
    hasher.finish()
}

pub async fn read_core(
    db: &AppDatabase,
    namespace: &Path,
    request: QuotaRequest,
) -> Result<OfficialQuotaRead, AppCommandError> {
    // Revalidate before the cache: removed accounts cannot retrieve old data,
    // and persisted conversations always own the selected account binding.
    let source = resolve_source(db, namespace, request).await?;
    let key = cache_key(namespace, &source);
    let entry = {
        let mut entries = CACHE.get_or_init(Default::default).lock().await;
        if entries.len() >= 256 {
            entries.retain(|_, entry| Arc::strong_count(entry) > 1);
        }
        entries.entry(key).or_default().clone()
    };
    let mut cached = entry.lock().await;
    if cached.as_ref().is_none_or(|(at, _)| at.elapsed() >= TTL) {
        let payload = tokio::time::timeout(DEADLINE, read_official(&source))
            .await
            .ok()
            .flatten()
            .map(|v| public_payload(&source.account.family, &v));
        *cached = Some((Instant::now(), payload));
    }
    let (at, payload) = cached.as_ref().unwrap();
    Ok(OfficialQuotaRead {
        account: source.account,
        payload: payload.clone(),
        checked_at: chrono::Utc::now().timestamp() - at.elapsed().as_secs() as i64,
    })
}

async fn read_official(source: &Source) -> Option<Value> {
    // A stored subscription login does not describe an API/provider override.
    if source.uses_api_provider() {
        return None;
    }
    if source.account.family == "codex" {
        return read_codex(source).await;
    }
    let token = source.token()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let request = match source.account.family.as_str() {
        "claude" => client
            .get("https://api.anthropic.com/api/oauth/usage")
            .header("anthropic-beta", "oauth-2025-04-20"),
        "grok" => client
            .get("https://cli-chat-proxy.grok.com/v1/billing?format=credits")
            .header("x-xai-token-auth", "xai-grok-cli"),
        "cursor" => client
            .post("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage")
            .json(&json!({})),
        "opencode" => client.get("https://opencode.ai/zen/go/v1/usage"),
        _ => return None,
    };
    let response = request
        .bearer_auth(token)
        .header("Accept", "application/json")
        .header("User-Agent", "codeg")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    if response.content_length().is_some_and(|n| n > 1024 * 1024) {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    if bytes.len() > 1024 * 1024 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

async fn read_codex(source: &Source) -> Option<Value> {
    let relation = crate::acp::registry::acp_adapter_relation(AgentType::Codex)?;
    let executable = super::acp::resolve_vendor_cli("codex", relation.extra_dirs).await?;
    let mut cmd = crate::process::tokio_command(executable);
    cmd.args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if source.isolated {
        for key in agent_accounts::credential_env_keys(AgentType::Codex) {
            cmd.env_remove(key);
        }
    }
    for (key, value) in &source.env {
        if value.is_empty() {
            cmd.env_remove(key);
        } else {
            cmd.env(key, value);
        }
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let mut lines = BufReader::new(child.stdout.take()?).lines();
    let work = async {
        let init = json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"codeg","version":env!("CARGO_PKG_VERSION")},"capabilities":{}}});
        stdin.write_all(format!("{init}\n").as_bytes()).await.ok()?;
        let mut initialized = false;
        while let Some(line) = lines.next_line().await.ok()? {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message.get("id") == Some(&json!(1)) && !initialized {
                if message.get("error").is_some() {
                    return None;
                }
                initialized = true;
                stdin.write_all(b"{\"method\":\"initialized\"}\n{\"id\":2,\"method\":\"account/rateLimits/read\",\"params\":{}}\n").await.ok()?;
            }
            if initialized && message.get("id") == Some(&json!(2)) {
                return message.get("result").cloned();
            }
        }
        None
    };
    let result = tokio::time::timeout(Duration::from_secs(10), work)
        .await
        .ok()
        .flatten();
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

/// Only usage fields cross IPC/HTTP. Extra provider identity/auth fields stay private.
fn pick(value: &Value, keys: &[&str]) -> Value {
    let mut out = serde_json::Map::new();
    for key in keys {
        if let Some(value) = value.get(*key) {
            if value.is_number()
                || value.is_boolean()
                || value.is_null()
                || value.as_str().is_some_and(|s| s.len() <= 200)
            {
                out.insert((*key).into(), value.clone());
            }
        }
    }
    Value::Object(out)
}
fn codex_limit(value: &Value) -> Value {
    let mut out = pick(
        value,
        &["limitId", "limitName", "planType", "rateLimitReachedType"],
    );
    for key in ["primary", "secondary"] {
        out[key] = pick(
            &value[key],
            &["usedPercent", "windowDurationMins", "resetsAt"],
        );
    }
    out["credits"] = pick(&value["credits"], &["hasCredits", "unlimited", "balance"]);
    out
}
fn public_payload(family: &str, value: &Value) -> Value {
    match family {
        "codex" => {
            let mut out = json!({"rateLimits": codex_limit(&value["rateLimits"])});
            if let Some(limits) = value["rateLimitsByLimitId"].as_object() {
                out["rateLimitsByLimitId"] = Value::Object(
                    limits
                        .iter()
                        .take(64)
                        .map(|(k, v)| (k.clone(), codex_limit(v)))
                        .collect(),
                );
            }
            out
        }
        "claude" => {
            let mut out = json!({});
            for key in [
                "five_hour",
                "seven_day",
                "seven_day_opus",
                "seven_day_sonnet",
                "extra_usage",
            ] {
                out[key] = pick(&value[key], &["utilization", "resets_at", "is_enabled"]);
            }
            if let Some(limits) = value["limits"].as_array() {
                out["limits"] = Value::Array(
                    limits
                        .iter()
                        .take(64)
                        .map(|v| {
                            let mut limit = pick(v, &["kind", "percent", "resets_at", "scope"]);
                            if v["scope"]["model"].is_object() {
                                limit["scope"] = json!({"model": pick(&v["scope"]["model"], &["id", "display_name"])});
                            }
                            limit
                        })
                        .collect(),
                );
            }
            out
        }
        "grok" => {
            json!({"config": {"creditUsagePercent": value["config"]["creditUsagePercent"].as_f64(), "currentPeriod": pick(&value["config"]["currentPeriod"], &["end"])}})
        }
        "cursor" => {
            let mut out = pick(value, &["billingCycleEnd", "billing_cycle_end"]);
            out["planUsage"] = pick(
                value
                    .get("planUsage")
                    .or_else(|| value.get("plan_usage"))
                    .unwrap_or(&Value::Null),
                &[
                    "remaining",
                    "limit",
                    "totalPercentUsed",
                    "total_percent_used",
                    "autoPercentUsed",
                    "auto_percent_used",
                    "apiPercentUsed",
                    "api_percent_used",
                ],
            );
            out
        }
        "opencode" => {
            let usage = value.get("usage").unwrap_or(value);
            let mut out = json!({"usage": {}});
            for key in ["rolling", "weekly", "monthly"] {
                out["usage"][key] = pick(
                    &usage[key],
                    &[
                        "percent",
                        "usagePercent",
                        "usage_percent",
                        "resetsAt",
                        "resets_at",
                    ],
                );
            }
            out
        }
        _ => Value::Null,
    }
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn subscription_quota_accounts(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<QuotaAccount>, AppCommandError> {
    accounts_core(&db).await
}
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn subscription_quota_read(
    db: tauri::State<'_, AppDatabase>,
    app: tauri::AppHandle,
    request: QuotaRequest,
) -> Result<OfficialQuotaRead, AppCommandError> {
    use tauri::Manager;
    let namespace = app
        .path()
        .app_data_dir()
        .map_err(|_| error("Application folder unavailable"))?;
    read_core(
        &db,
        &crate::paths::resolve_effective_data_dir(&namespace),
        request,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configured_key_aliases_are_preserved_without_inheriting_default_credentials() {
        for (agent, key) in [
            (AgentType::OpenCode, "OPENCODE_API_KEY"),
            (AgentType::Cursor, "CURSOR_AUTH_TOKEN"),
        ] {
            let mut source = Source {
                account: QuotaAccount {
                    agent_type: agent,
                    agent_account_id: None,
                    family: family(agent).unwrap().into(),
                    name: None,
                },
                env: BTreeMap::from([(key.into(), "own-fixture-key".into())]),
                isolated: true,
                provider_override: false,
            };
            assert_eq!(source.token().as_deref(), Some("own-fixture-key"));
            source.env.clear();
            assert!(source.token().is_none());
            assert!(agent_accounts::credential_env_keys(agent).contains(&key));
        }
    }
    #[test]
    fn response_only_contains_allowlisted_usage() {
        let v = public_payload(
            "claude",
            &json!({"email":"private@example.com", "accessToken":"secret", "limits":[{"kind":"weekly_all","percent":28,"scope":"model","accessToken":"secret"}]}),
        );
        assert_eq!(v["limits"][0]["percent"], 28);
        assert!(!v.to_string().contains("secret"));
        assert!(!v.to_string().contains("private@"));
        let v = public_payload(
            "codex",
            &json!({"rateLimits":{"primary":{"usedPercent":20,"email":"private@example.com"},"credits":{"hasCredits":true,"balance":"10","accessToken":"secret"}},"auth":"secret"}),
        );
        assert_eq!(v["rateLimits"]["primary"]["usedPercent"], 20);
        assert!(!v.to_string().contains("secret"));
    }
    #[tokio::test]
    async fn refuses_removed_and_wrong_family_accounts() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("profile");
        std::fs::create_dir(&home).unwrap();
        let a = agent_account_service::create(
            &db.conn,
            temp.path(),
            AgentType::ClaudeCode,
            "Work",
            home.to_str(),
        )
        .await
        .unwrap();
        let req = QuotaRequest {
            agent_type: AgentType::ClaudeCode,
            agent_account_id: Some(a.id.clone()),
            conversation_id: None,
        };
        let source = resolve_source(&db, temp.path(), req.clone()).await.unwrap();
        let credential = source.credential_path().unwrap();
        assert_eq!(credential.file_name().unwrap(), ".credentials.json");
        // Windows TEMP can use an 8.3 spelling (RUNNER~1), while account
        // creation stores the canonical long name. Compare the actual folder.
        assert_eq!(
            std::fs::canonicalize(credential.parent().unwrap()).unwrap(),
            std::fs::canonicalize(&home).unwrap()
        );
        assert!(source.value("OPENAI_API_KEY").is_none());
        assert!(resolve_source(
            &db,
            temp.path(),
            QuotaRequest {
                agent_type: AgentType::Codex,
                ..req.clone()
            }
        )
        .await
        .is_err());
        agent_account_service::remove(&db.conn, &a.id)
            .await
            .unwrap();
        assert!(resolve_source(&db, temp.path(), req).await.is_err());
    }

    #[tokio::test]
    async fn account_auth_updates_invalidate_quota_and_api_accounts_skip_subscription_probes() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let temp = tempfile::tempdir().unwrap();
        let a = agent_account_service::create(&db.conn, temp.path(), AgentType::ClaudeCode, "Work", None).await.unwrap();
        let req = QuotaRequest { agent_type: AgentType::ClaudeCode, agent_account_id: Some(a.id.clone()), conversation_id: None };
        let source = resolve_source(&db, temp.path(), req.clone()).await.unwrap();
        let old_key = cache_key(temp.path(), &source);
        CACHE.get_or_init(Default::default).lock().await.insert(old_key, Arc::new(Mutex::new(Some((Instant::now(), Some(json!({"five_hour":{"utilization":42}})))))));
        account_auth::changed();
        assert_ne!(old_key, cache_key(temp.path(), &source));
        // No credentials means no network request. The pre-change cached
        // subscription result must not survive a sign-in/status refresh.
        assert!(read_core(&db, temp.path(), req.clone()).await.unwrap().payload.is_none());
        account_auth::set_claude_key(Path::new(&a.home_dir), Some("fixture-only-key")).unwrap();
        let source = resolve_source(&db, temp.path(), req.clone()).await.unwrap();
        assert!(source.uses_api_provider());
        assert!(read_core(&db, temp.path(), req).await.unwrap().payload.is_none());
        assert!(std::fs::read_to_string(Path::new(&a.home_dir).join("settings.json")).unwrap().contains("fixture-only-key"));
    }
    #[test]
    fn profile_credentials_follow_native_runtime_layouts() {
        let temp = tempfile::tempdir().unwrap();
        for agent in [AgentType::Cursor, AgentType::OpenCode] {
            if agent_accounts::unsupported_reason(agent).is_some() {
                assert!(agent_accounts::isolation_env(agent, temp.path()).is_err());
                continue;
            }
            let source = Source {
                account: QuotaAccount {
                    agent_type: agent,
                    agent_account_id: Some("named".into()),
                    family: family(agent).unwrap().into(),
                    name: None,
                },
                env: agent_accounts::isolation_env(agent, temp.path()).unwrap(),
                isolated: true,
                provider_override: false,
            };
            let expected = if agent == AgentType::OpenCode {
                "data/opencode/auth.json"
            } else if cfg!(windows) {
                "appdata/Cursor/auth.json"
            } else if cfg!(target_os = "macos") {
                ".cursor/auth.json"
            } else {
                ".config/cursor/auth.json"
            };
            assert_eq!(source.credential_path(), Some(temp.path().join(expected)));
        }
        let source = Source {
            account: QuotaAccount {
                agent_type: AgentType::Cursor,
                agent_account_id: None,
                family: "cursor".into(),
                name: None,
            },
            env: BTreeMap::from([("CURSOR_CONFIG_DIR".into(), "/profile".into())]),
            isolated: true,
            provider_override: false,
        };
        assert!(source.credential_path().is_none());
    }

    #[tokio::test]
    async fn api_overrides_do_not_probe_a_stored_subscription_login() {
        for (agent, key) in [
            (AgentType::ClaudeCode, "ANTHROPIC_API_KEY"),
            (AgentType::Codex, "OPENAI_API_KEY"),
            (AgentType::Grok, "XAI_API_KEY"),
        ] {
            let mut source = Source {
                account: QuotaAccount {
                    agent_type: agent,
                    agent_account_id: None,
                    family: family(agent).unwrap().into(),
                    name: None,
                },
                env: BTreeMap::new(),
                isolated: true,
                provider_override: false,
            };
            assert!(!source.uses_api_provider());
            source.env.insert(key.into(), "fixture-api-key".into());
            assert!(source.uses_api_provider());
            assert!(read_official(&source).await.is_none());
            source.env.clear();
            source.provider_override = true;
            assert!(read_official(&source).await.is_none());
        }
    }
}
