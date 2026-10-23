use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::sync::Mutex as StdMutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::acp::error::AcpError;
use crate::parsers::antigravity::resolve_antigravity_acp_dir;

pub const ACCOUNTS_FILENAME: &str = "antigravity_accounts.json";
pub const TOKEN_FILENAME: &str = "acp_token.json";
const USER_AGENT: &str = "antigravity/acp/1.2.1 (aidev_client; os_type=windows; arch=amd64; host_path=unknown/unknown; proxy_client=antigravity/sdk)";
const CLOUDCODE_ENDPOINT: &str = "https://daily-cloudcode-pa.googleapis.com";

static PENDING_LOGINS: StdMutex<Option<HashMap<String, PathBuf>>> = StdMutex::new(None);
static ACCOUNTS_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityAccount {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub picture: Option<String>,
    pub token: serde_json::Value,
    #[serde(default)]
    pub is_active: bool,
    #[serde(default)]
    pub added_at: i64,
    #[serde(default)]
    pub last_used_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityAccountsState {
    #[serde(default)]
    pub active_account_id: Option<String>,
    #[serde(default)]
    pub accounts: Vec<AntigravityAccount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityQuotaBucket {
    pub bucket_id: String,
    pub display_name: String,
    pub window: Option<String>,
    pub remaining_fraction: f64,
    pub reset_time: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityQuotaGroup {
    pub display_name: String,
    pub description: Option<String>,
    pub buckets: Vec<AntigravityQuotaBucket>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityQuotaSummary {
    pub email: Option<String>,
    pub is_available: bool,
    pub error: Option<String>,
    pub five_hour_fraction: Option<f64>,
    pub five_hour_reset_time: Option<String>,
    pub weekly_fraction: Option<f64>,
    pub weekly_reset_time: Option<String>,
    pub groups: Vec<AntigravityQuotaGroup>,
    pub updated_at: i64,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn accounts_file_path() -> PathBuf {
    resolve_antigravity_acp_dir().join(ACCOUNTS_FILENAME)
}

pub fn backup_file_path() -> PathBuf {
    resolve_antigravity_acp_dir().join(format!("{ACCOUNTS_FILENAME}.bak"))
}

pub fn token_file_path() -> PathBuf {
    resolve_antigravity_acp_dir().join(TOKEN_FILENAME)
}

pub fn read_accounts_state_from_disk() -> AntigravityAccountsState {
    let main_path = accounts_file_path();
    let bak_path = backup_file_path();

    let parse_file = |path: &Path| -> Option<AntigravityAccountsState> {
        if !path.exists() {
            return None;
        }
        match std::fs::read_to_string(path) {
            Ok(content) => {
                let trimmed = content.trim();
                if trimmed.is_empty() {
                    warn!("[ACP][AntigravityAccounts] File {} is empty", path.display());
                    return None;
                }
                match serde_json::from_str::<AntigravityAccountsState>(trimmed) {
                    Ok(mut state) => {
                        for acc in &mut state.accounts {
                            acc.is_active = state.active_account_id.as_deref() == Some(&acc.id);
                        }
                        Some(state)
                    }
                    Err(e) => {
                        warn!(
                            "[ACP][AntigravityAccounts] Failed to parse accounts JSON in {}: {e}",
                            path.display()
                        );
                        None
                    }
                }
            }
            Err(e) => {
                warn!("[ACP][AntigravityAccounts] Failed to read {}: {e}", path.display());
                None
            }
        }
    };

    if let Some(state) = parse_file(&main_path) {
        // If main file parsed but has 0 accounts, check if backup has accounts
        if state.accounts.is_empty() {
            if let Some(bak_state) = parse_file(&bak_path) {
                if !bak_state.accounts.is_empty() {
                    warn!(
                        "[ACP][AntigravityAccounts] Main file has 0 accounts, recovering {} accounts from backup {}",
                        bak_state.accounts.len(),
                        bak_path.display()
                    );
                    let _ = save_accounts_state_to_disk(&bak_state);
                    return bak_state;
                }
            }
        }
        return state;
    }

    // Main file missing or failed to parse, try backup
    if let Some(bak_state) = parse_file(&bak_path) {
        warn!(
            "[ACP][AntigravityAccounts] Recovering {} accounts from backup {}",
            bak_state.accounts.len(),
            bak_path.display()
        );
        let _ = save_accounts_state_to_disk(&bak_state);
        return bak_state;
    }

    AntigravityAccountsState::default()
}

pub fn save_accounts_state_to_disk(state: &AntigravityAccountsState) -> Result<(), AcpError> {
    let path = accounts_file_path();
    let bak_path = backup_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let content = serde_json::to_string_pretty(state)
        .map_err(|e| AcpError::Protocol(format!("Failed to serialize accounts state: {e}")))?;

    // Atomic write via temporary file
    let tmp_path = path.with_extension(format!("tmp.{}", uuid::Uuid::new_v4()));
    if let Err(e) = std::fs::write(&tmp_path, &content) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(AcpError::Protocol(format!(
            "Failed to write temp accounts file {}: {e}",
            tmp_path.display()
        )));
    }

    #[cfg(windows)]
    {
        if std::fs::rename(&tmp_path, &path).is_err() {
            let _ = std::fs::remove_file(&path);
            if let Err(e) = std::fs::rename(&tmp_path, &path) {
                let _ = std::fs::remove_file(&tmp_path);
                return Err(AcpError::Protocol(format!(
                    "Failed to replace {}: {e}",
                    path.display()
                )));
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Err(e) = std::fs::rename(&tmp_path, &path) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(AcpError::Protocol(format!(
                "Failed to replace {}: {e}",
                path.display()
            )));
        }
    }

    // Update backup file when accounts is non-empty
    if !state.accounts.is_empty() {
        let _ = std::fs::write(&bak_path, &content);
    }

    Ok(())
}

/// Ensures that `acp_token.json` always exists on disk if we have registered accounts.
/// Prevents the Antigravity ACP process from starting with a missing token and prompting
/// for authorization in the browser on startup.
pub fn ensure_active_token_on_disk() {
    ensure_active_token_on_disk_locked();
}

fn ensure_active_token_on_disk_locked() {
    let token_path = token_file_path();
    let state = read_accounts_state_from_disk();
    if state.accounts.is_empty() {
        return;
    }

    let needs_write = if !token_path.exists() {
        true
    } else if let Ok(content) = std::fs::read_to_string(&token_path) {
        content.trim().is_empty() || serde_json::from_str::<serde_json::Value>(&content).is_err()
    } else {
        true
    };

    if needs_write {
        let target = state
            .accounts
            .iter()
            .find(|a| state.active_account_id.as_deref() == Some(&a.id))
            .or_else(|| state.accounts.first());

        if let Some(account) = target {
            if let Ok(content) = serde_json::to_string_pretty(&account.token) {
                if let Some(parent) = token_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&token_path, content);
                info!(
                    "[ACP][AntigravityAccounts] Ensured active token on disk for {}",
                    account.email
                );
            }
        }
    }
}

/// Creates an isolated temporary GEMINI_HOME sandbox for adding an account.
/// The active `acp_token.json` in the user's real ~/.gemini directory is NEVER moved or deleted!
pub fn create_isolated_login_env(base_env: &BTreeMap<String, String>) -> (BTreeMap<String, String>, PathBuf) {
    let temp_home = std::env::temp_dir().join(format!("codeg-agy-auth-{}", uuid::Uuid::new_v4()));
    let temp_acp_dir = temp_home.join("antigravity-acp");
    let _ = std::fs::create_dir_all(&temp_acp_dir);

    let settings = serde_json::json!({
        "auth": {
            "type": "oauth-personal"
        }
    });
    let _ = std::fs::write(
        temp_acp_dir.join("settings.json"),
        serde_json::to_string_pretty(&settings).unwrap_or_default(),
    );

    let mut login_env = base_env.clone();
    login_env.insert("GEMINI_HOME".to_string(), temp_home.to_string_lossy().to_string());
    (login_env, temp_home)
}

pub fn register_pending_login(handle: &str, temp_dir: PathBuf) {
    let mut lock = PENDING_LOGINS.lock().unwrap();
    let map = lock.get_or_insert_with(HashMap::new);
    map.insert(handle.to_string(), temp_dir);
}

pub fn remove_pending_login(handle: &str) -> Option<PathBuf> {
    let mut lock = PENDING_LOGINS.lock().unwrap();
    lock.as_mut().and_then(|m| m.remove(handle))
}

/// Checks if a pending login has already generated the credential in its isolated temp dir
/// (e.g., when the user's browser redirected to http://127.0.0.1:<port> automatically).
pub async fn check_and_consume_login_if_ready(
    handle: &str,
) -> Result<Option<AntigravityAccountsState>, AcpError> {
    let _guard = ACCOUNTS_LOCK.lock().await;
    let temp_dir = {
        let lock = PENDING_LOGINS.lock().unwrap();
        match lock.as_ref().and_then(|m| m.get(handle)).cloned() {
            Some(p) => p,
            None => return Ok(None),
        }
    };

    let token_path = temp_dir.join("antigravity-acp").join(TOKEN_FILENAME);
    if !token_path.exists() {
        return Ok(None);
    }

    let token_content = match std::fs::read_to_string(&token_path) {
        Ok(c) if !c.trim().is_empty() => c,
        _ => return Ok(None),
    };

    let token_json: serde_json::Value = match serde_json::from_str(&token_content) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };

    // Remove from pending map
    remove_pending_login(handle);

    // Cancel helper child in antigravity_login
    let _ = crate::acp::antigravity_login::cancel(handle).await;

    // Ingest the new account into existing state
    let mut state = read_accounts_state_from_disk();
    let state = ingest_new_token_locked(token_json, &mut state).await?;

    // Cleanup temp dir
    let _ = std::fs::remove_dir_all(&temp_dir);

    Ok(Some(state))
}

/// Ingests a new token into `antigravity_accounts.json`
pub async fn ingest_new_token(token_json: serde_json::Value) -> Result<AntigravityAccountsState, AcpError> {
    let _guard = ACCOUNTS_LOCK.lock().await;
    let mut state = read_accounts_state_from_disk();
    ingest_new_token_locked(token_json, &mut state).await
}

async fn ingest_new_token_locked(
    token_json: serde_json::Value,
    state: &mut AntigravityAccountsState,
) -> Result<AntigravityAccountsState, AcpError> {
    let now = now_secs();

    let mut email = None;
    let mut name = None;
    let mut picture = None;
    let mut account_id = None;

    if let Ok(access_token) = refresh_access_token(&token_json).await {
        if let Ok((id, em, nm, pic)) = fetch_user_info(&access_token).await {
            account_id = Some(id);
            email = Some(em);
            name = nm;
            picture = pic;
        }
    }

    let final_email = email.unwrap_or_else(|| {
        let rtoken = token_json.get("refresh_token").and_then(|v| v.as_str()).unwrap_or("");
        let short = if rtoken.len() > 8 { &rtoken[..8] } else { "user" };
        format!("account-{short}@google")
    });

    let final_id = account_id.unwrap_or_else(|| {
        use sha2::{Digest, Sha256};
        let rtoken = token_json.get("refresh_token").and_then(|v| v.as_str()).unwrap_or("");
        let mut hasher = Sha256::new();
        hasher.update(rtoken.as_bytes());
        let hash = format!("{:x}", hasher.finalize());
        if hash.len() > 16 { hash[..16].to_string() } else { hash }
    });

    let mut found = false;
    for acc in &mut state.accounts {
        if acc.email == final_email || acc.id == final_id {
            acc.token = token_json.clone();
            acc.last_used_at = now;
            if name.is_some() {
                acc.name = name.clone();
            }
            if picture.is_some() {
                acc.picture = picture.clone();
            }
            found = true;
            break;
        }
    }

    if !found {
        let is_first = state.accounts.is_empty();
        let new_account = AntigravityAccount {
            id: final_id.clone(),
            email: final_email.clone(),
            name,
            picture,
            token: token_json.clone(),
            is_active: is_first,
            added_at: now,
            last_used_at: now,
        };
        state.accounts.push(new_account);
        if is_first {
            state.active_account_id = Some(final_id);
        }
        info!("[ACP][AntigravityAccounts] Added new account {}", final_email);
    } else {
        info!("[ACP][AntigravityAccounts] Updated existing account {}", final_email);
    }

    save_accounts_state_to_disk(state)?;
    ensure_active_token_on_disk_locked();
    Ok(state.clone())
}

/// Refresh Google OAuth access token from a token JSON blob
pub async fn refresh_access_token(token: &serde_json::Value) -> Result<String, AcpError> {
    let client_id = token.get("client_id").and_then(|v| v.as_str()).unwrap_or_default();
    let client_secret = token.get("client_secret").and_then(|v| v.as_str()).unwrap_or_default();
    let refresh_token = token.get("refresh_token").and_then(|v| v.as_str()).unwrap_or_default();
    let token_uri = token
        .get("token_uri")
        .and_then(|v| v.as_str())
        .unwrap_or("https://oauth2.googleapis.com/token");

    if refresh_token.is_empty() {
        return Err(AcpError::Protocol("Token missing refresh_token".to_string()));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| AcpError::Protocol(format!("Failed to build http client: {e}")))?;

    let res = client
        .post(token_uri)
        .json(&serde_json::json!({
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token"
        }))
        .send()
        .await
        .map_err(|e| AcpError::Protocol(format!("Token refresh network error: {e}")))?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(AcpError::Protocol(format!("Token refresh failed: {text}")));
    }

    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|e| AcpError::Protocol(format!("Token refresh response parse error: {e}")))?;

    body.get("access_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AcpError::Protocol("No access_token in token response".to_string()))
}

/// Fetch user info (id, email, name, picture) using access token
pub async fn fetch_user_info(access_token: &str) -> Result<(String, String, Option<String>, Option<String>), AcpError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| AcpError::Protocol(format!("Failed to build http client: {e}")))?;

    let res = client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| AcpError::Protocol(format!("Failed to fetch userinfo: {e}")))?;

    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(AcpError::Protocol(format!("Userinfo API error: {text}")));
    }

    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|e| AcpError::Protocol(format!("Userinfo parse error: {e}")))?;

    let email = body
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| email.clone());
    let name = body.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
    let picture = body.get("picture").and_then(|v| v.as_str()).map(|s| s.to_string());

    if email.is_empty() {
        return Err(AcpError::Protocol("Userinfo contains no email".to_string()));
    }

    Ok((id, email, name, picture))
}

/// Read accounts state. If accounts already exist, return immediately without touching disk.
/// If empty, fall back to `sync_accounts_state` to discover token.
pub async fn get_or_sync_accounts_state() -> Result<AntigravityAccountsState, AcpError> {
    let _guard = ACCOUNTS_LOCK.lock().await;
    let state = read_accounts_state_from_disk();
    if !state.accounts.is_empty() {
        return Ok(state);
    }
    drop(_guard);
    sync_accounts_state().await
}

/// Ensure accounts state is synchronized with existing acp_token.json file
pub async fn sync_accounts_state() -> Result<AntigravityAccountsState, AcpError> {
    let _guard = ACCOUNTS_LOCK.lock().await;
    ensure_active_token_on_disk_locked();
    let mut state = read_accounts_state_from_disk();
    let token_path = token_file_path();

    if token_path.exists() {
        if let Ok(token_content) = std::fs::read_to_string(&token_path) {
            if let Ok(token_json) = serde_json::from_str::<serde_json::Value>(&token_content) {
                let rtoken = token_json.get("refresh_token").and_then(|v| v.as_str()).unwrap_or("");

                // 1. Check if token matches a known account by refresh_token
                let known_idx = if !rtoken.is_empty() {
                    state.accounts.iter().position(|a| {
                        a.token.get("refresh_token").and_then(|v| v.as_str()) == Some(rtoken)
                    })
                } else {
                    None
                };

                if let Some(idx) = known_idx {
                    let acc_id = state.accounts[idx].id.clone();
                    state.active_account_id = Some(acc_id);
                    for (i, acc) in state.accounts.iter_mut().enumerate() {
                        acc.is_active = i == idx;
                    }
                    // Keep latest token from disk
                    state.accounts[idx].token = token_json;
                    let _ = save_accounts_state_to_disk(&state);
                    return Ok(state);
                }

                // 2. If state already has accounts, do NOT drop them! Check by user info before assuming new.
                if !state.accounts.is_empty() {
                    if let Ok(access_token) = refresh_access_token(&token_json).await {
                        if let Ok((id, em, nm, pic)) = fetch_user_info(&access_token).await {
                            if let Some(pos) = state.accounts.iter().position(|a| a.email == em || a.id == id) {
                                state.accounts[pos].token = token_json;
                                state.accounts[pos].is_active = true;
                                if nm.is_some() {
                                    state.accounts[pos].name = nm;
                                }
                                if pic.is_some() {
                                    state.accounts[pos].picture = pic;
                                }
                                let active_id = state.accounts[pos].id.clone();
                                state.active_account_id = Some(active_id);
                                for (i, acc) in state.accounts.iter_mut().enumerate() {
                                    acc.is_active = i == pos;
                                }
                                let _ = save_accounts_state_to_disk(&state);
                                return Ok(state);
                            }
                        }
                    }
                    // It's a token for an account not yet in state: merge it without dropping existing accounts
                    return ingest_new_token_locked(token_json, &mut state).await;
                }

                // 3. State has 0 accounts: ingest initial account from disk token
                return ingest_new_token_locked(token_json, &mut state).await;
            }
        }
    }

    for acc in &mut state.accounts {
        acc.is_active = state.active_account_id.as_deref() == Some(&acc.id);
    }

    Ok(state)
}

/// Switch active account
pub async fn switch_account(account_id: &str) -> Result<AntigravityAccountsState, AcpError> {
    let _guard = ACCOUNTS_LOCK.lock().await;
    let mut state = read_accounts_state_from_disk();
    let target = state
        .accounts
        .iter_mut()
        .find(|a| a.id == account_id)
        .ok_or_else(|| AcpError::Protocol(format!("Account {account_id} not found")))?;

    let token_content = serde_json::to_string_pretty(&target.token)
        .map_err(|e| AcpError::Protocol(format!("Failed to serialize token: {e}")))?;

    target.last_used_at = now_secs();
    let token_path = token_file_path();
    if let Some(parent) = token_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&token_path, token_content)
        .map_err(|e| AcpError::Protocol(format!("Failed to write acp_token.json: {e}")))?;

    state.active_account_id = Some(account_id.to_string());
    for acc in &mut state.accounts {
        acc.is_active = acc.id == account_id;
    }

    save_accounts_state_to_disk(&state)?;
    info!("[ACP][AntigravityAccounts] Switched active account to {account_id}");
    Ok(state)
}

/// Delete an account
pub async fn delete_account(account_id: &str) -> Result<AntigravityAccountsState, AcpError> {
    let _guard = ACCOUNTS_LOCK.lock().await;
    let mut state = read_accounts_state_from_disk();
    let was_active = state.active_account_id.as_deref() == Some(account_id);

    state.accounts.retain(|a| a.id != account_id);

    if was_active {
        if let Some(next_active) = state.accounts.first_mut() {
            let next_id = next_active.id.clone();
            next_active.is_active = true;
            next_active.last_used_at = now_secs();
            let token_content = serde_json::to_string_pretty(&next_active.token).unwrap_or_default();
            let _ = std::fs::write(token_file_path(), token_content);
            state.active_account_id = Some(next_id);
        } else {
            state.active_account_id = None;
            let _ = std::fs::remove_file(token_file_path());
        }
    }

    save_accounts_state_to_disk(&state)?;
    info!("[ACP][AntigravityAccounts] Deleted account {account_id}");
    Ok(state)
}

/// Legacy no-op for backward compatibility
pub fn prepare_for_new_account_login() -> Result<(), AcpError> {
    ensure_active_token_on_disk();
    Ok(())
}

/// Legacy no-op for backward compatibility
pub fn restore_backed_up_token() {
    ensure_active_token_on_disk();
}

/// Legacy helper for finish
pub async fn finish_new_account_login() -> Result<AntigravityAccountsState, AcpError> {
    sync_accounts_state().await
}

/// Fetch quota summary for the specified account or active account
pub async fn fetch_account_quota(account_id: Option<&str>) -> AntigravityQuotaSummary {
    let now = now_secs();
    let state = {
        let _guard = ACCOUNTS_LOCK.lock().await;
        read_accounts_state_from_disk()
    };

    let target_token = if let Some(id) = account_id {
        state.accounts.iter().find(|a| a.id == id).map(|a| (a.email.clone(), a.token.clone()))
    } else if let Some(ref active_id) = state.active_account_id {
        state.accounts.iter().find(|a| a.id == *active_id).map(|a| (a.email.clone(), a.token.clone()))
    } else {
        None
    };

    let (email, token_json) = match target_token {
        Some(pair) => pair,
        None => {
            let token_path = token_file_path();
            if let Ok(content) = std::fs::read_to_string(&token_path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    ("unknown".to_string(), val)
                } else {
                    return AntigravityQuotaSummary {
                        email: None,
                        is_available: false,
                        error: Some("No Antigravity token found".to_string()),
                        five_hour_fraction: None,
                        five_hour_reset_time: None,
                        weekly_fraction: None,
                        weekly_reset_time: None,
                        groups: Vec::new(),
                        updated_at: now,
                    };
                }
            } else {
                return AntigravityQuotaSummary {
                    email: None,
                    is_available: false,
                    error: Some("No Antigravity token found".to_string()),
                    five_hour_fraction: None,
                    five_hour_reset_time: None,
                    weekly_fraction: None,
                    weekly_reset_time: None,
                    groups: Vec::new(),
                    updated_at: now,
                };
            }
        }
    };

    let access_token = match refresh_access_token(&token_json).await {
        Ok(t) => t,
        Err(e) => {
            return AntigravityQuotaSummary {
                email: Some(email),
                is_available: false,
                error: Some(format!("Failed to refresh token: {e}")),
                five_hour_fraction: None,
                five_hour_reset_time: None,
                weekly_fraction: None,
                weekly_reset_time: None,
                groups: Vec::new(),
                updated_at: now,
            };
        }
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return AntigravityQuotaSummary {
                email: Some(email),
                is_available: false,
                error: Some(format!("Failed to build http client: {e}")),
                five_hour_fraction: None,
                five_hour_reset_time: None,
                weekly_fraction: None,
                weekly_reset_time: None,
                groups: Vec::new(),
                updated_at: now,
            };
        }
    };

    // Step 1: Query loadCodeAssist to resolve companion project
    let lca_url = format!("{CLOUDCODE_ENDPOINT}/v1internal:loadCodeAssist");
    let lca_res = client
        .post(&lca_url)
        .header("User-Agent", USER_AGENT)
        .bearer_auth(&access_token)
        .json(&serde_json::json!({
            "metadata": { "ideType": "ANTIGRAVITY" }
        }))
        .send()
        .await;

    let mut project_id = "aicode-consumers".to_string();
    if let Ok(res) = lca_res {
        if res.status().is_success() {
            if let Ok(lca_body) = res.json::<serde_json::Value>().await {
                if let Some(p) = lca_body
                    .get("cloudaicompanionProject")
                    .and_then(|v| v.get("id").and_then(|id| id.as_str()).or_else(|| v.as_str()))
                {
                    project_id = p.to_string();
                }
            }
        }
    }

    // Step 2: Query retrieveUserQuotaSummary
    let quota_url = format!("{CLOUDCODE_ENDPOINT}/v1internal:retrieveUserQuotaSummary");
    let quota_res = client
        .post(&quota_url)
        .header("User-Agent", USER_AGENT)
        .bearer_auth(&access_token)
        .json(&serde_json::json!({
            "project": project_id
        }))
        .send()
        .await;

    let quota_body: serde_json::Value = match quota_res {
        Ok(res) if res.status().is_success() => match res.json().await {
            Ok(b) => b,
            Err(e) => {
                return AntigravityQuotaSummary {
                    email: Some(email),
                    is_available: false,
                    error: Some(format!("Failed to parse quota response: {e}")),
                    five_hour_fraction: None,
                    five_hour_reset_time: None,
                    weekly_fraction: None,
                    weekly_reset_time: None,
                    groups: Vec::new(),
                    updated_at: now,
                };
            }
        },
        Ok(res) => {
            let status = res.status();
            let text = res.text().await.unwrap_or_default();
            return AntigravityQuotaSummary {
                email: Some(email),
                is_available: false,
                error: Some(format!("Quota API returned {status}: {text}")),
                five_hour_fraction: None,
                five_hour_reset_time: None,
                weekly_fraction: None,
                weekly_reset_time: None,
                groups: Vec::new(),
                updated_at: now,
            };
        }
        Err(e) => {
            return AntigravityQuotaSummary {
                email: Some(email),
                is_available: false,
                error: Some(format!("Quota request network error: {e}")),
                five_hour_fraction: None,
                five_hour_reset_time: None,
                weekly_fraction: None,
                weekly_reset_time: None,
                groups: Vec::new(),
                updated_at: now,
            };
        }
    };

    let mut groups: Vec<AntigravityQuotaGroup> = Vec::new();
    let mut five_hour_fraction: Option<f64> = None;
    let mut five_hour_reset_time: Option<String> = None;
    let mut weekly_fraction: Option<f64> = None;
    let mut weekly_reset_time: Option<String> = None;

    if let Some(raw_groups) = quota_body.get("groups").and_then(|v| v.as_array()) {
        for rg in raw_groups {
            let display_name = rg
                .get("displayName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let description = rg.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());
            let mut buckets = Vec::new();

            if let Some(raw_buckets) = rg.get("buckets").and_then(|v| v.as_array()) {
                for rb in raw_buckets {
                    let bucket_id = rb.get("bucketId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let b_display_name = rb.get("displayName").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let window = rb.get("window").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let remaining_fraction = rb.get("remainingFraction").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    let reset_time = rb.get("resetTime").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let desc = rb.get("description").and_then(|v| v.as_str()).map(|s| s.to_string());

                    if bucket_id == "gemini-5h" || (five_hour_fraction.is_none() && window.as_deref() == Some("5h")) {
                        five_hour_fraction = Some(remaining_fraction);
                        five_hour_reset_time = reset_time.clone();
                    }
                    if bucket_id == "gemini-weekly" || (weekly_fraction.is_none() && window.as_deref() == Some("weekly")) {
                        weekly_fraction = Some(remaining_fraction);
                        weekly_reset_time = reset_time.clone();
                    }

                    buckets.push(AntigravityQuotaBucket {
                        bucket_id,
                        display_name: b_display_name,
                        window,
                        remaining_fraction,
                        reset_time,
                        description: desc,
                    });
                }
            }

            groups.push(AntigravityQuotaGroup {
                display_name,
                description,
                buckets,
            });
        }
    }

    AntigravityQuotaSummary {
        email: Some(email),
        is_available: true,
        error: None,
        five_hour_fraction,
        five_hour_reset_time,
        weekly_fraction,
        weekly_reset_time,
        groups,
        updated_at: now,
    }
}
