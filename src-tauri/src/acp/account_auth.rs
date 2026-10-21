//! Account-scoped setup through native credential stores. Secrets are input
//! only; status returns a small projection of the official CLI's response.
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::acp::{agent_accounts, error::AcpError};
use crate::db::{entities::agent_account, AppDatabase};
use crate::models::AgentType;

const OUTPUT_LIMIT: u64 = 64 * 1024;
const SETTINGS_LIMIT: u64 = 2 * 1024 * 1024;
static REVISION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccountAuthMethod {
    SignIn,
    ApiKey,
    Native,
}

pub fn methods(agent: AgentType) -> &'static [AccountAuthMethod] {
    if matches!(agent, AgentType::ClaudeCode | AgentType::Codex) {
        &[AccountAuthMethod::SignIn, AccountAuthMethod::ApiKey]
    } else {
        &[AccountAuthMethod::Native]
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    SignedIn,
    SignedOut,
    Unavailable,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountAuthStatus {
    pub state: AuthState,
    pub method: Option<AccountAuthMethod>,
}

pub fn revision() -> u64 {
    REVISION.load(Ordering::Relaxed)
}

pub fn changed() {
    REVISION.fetch_add(1, Ordering::Relaxed);
}

pub fn ensure_plain(path: &Path, optional: bool) -> Result<(), AcpError> {
    let metadata = match path.symlink_metadata() {
        Ok(value) => value,
        Err(error) if optional && error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => {
            return Err(AcpError::protocol(
                "Restore the account folder before changing sign-in.",
            ))
        }
    };
    let linked = metadata.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(AcpError::protocol(
                "Sign-in settings cannot use a linked file or folder.",
            ));
        }
    }
    if linked {
        return Err(AcpError::protocol(
            "Sign-in settings cannot use a linked file or folder.",
        ));
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(AcpError::protocol(
            "Sign-in settings must use regular files and folders.",
        ));
    }
    Ok(())
}

pub fn check_paths(agent: AgentType, home: &Path) -> Result<(), AcpError> {
    ensure_plain(home, false)?;
    for file in match agent {
        AgentType::ClaudeCode => &[
            "settings.json",
            "settings.local.json",
            ".credentials.json",
            "anthropic",
        ][..],
        AgentType::Codex => &["auth.json", "config.toml"][..],
        _ => &[],
    } {
        ensure_plain(&home.join(file), true)?;
    }
    Ok(())
}

fn read_claude_settings(home: &Path) -> Result<Value, AcpError> {
    check_paths(AgentType::ClaudeCode, home)?;
    let path = home.join("settings.json");
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(_) => {
            return Err(AcpError::protocol(
                "Could not read this account's settings.",
            ))
        }
    };
    let mut bytes = Vec::new();
    file.take(SETTINGS_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| AcpError::protocol("Could not read this account's settings."))?;
    if bytes.len() as u64 > SETTINGS_LIMIT {
        return Err(AcpError::protocol(
            "This account's settings file is too large to update.",
        ));
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        AcpError::protocol("Fix this account's settings.json before changing sign-in.")
    })?;
    if !value.is_object() || value.get("env").is_some_and(|env| !env.is_object()) {
        return Err(AcpError::protocol(
            "Fix this account's settings.json before changing sign-in.",
        ));
    }
    Ok(value)
}

/// Narrow patch, preserving permissions, model choices and unrelated settings.
/// The temporary file is private from creation and replaces the file atomically.
pub fn set_claude_key(home: &Path, key: Option<&str>) -> Result<(), AcpError> {
    if let Some(key) = key {
        validate_key(key)?;
    }
    let mut value = read_claude_settings(home)?;
    let object = value.as_object_mut().expect("validated object");
    for key in ["apiKey", "api_key", "apiKeyHelper"] {
        object.remove(key);
    }
    if key.is_none() {
        object.remove("apiBaseUrl");
        object.remove("api_base_url");
    }
    let env = object
        .entry("env")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("validated env object");
    for name in agent_accounts::CLAUDE_AUTH_ENV_KEYS {
        if key.is_some() && *name == "ANTHROPIC_BASE_URL" {
            continue;
        }
        env.remove(*name);
    }
    if let Some(key) = key {
        env.insert("ANTHROPIC_API_KEY".into(), Value::String(key.trim().into()));
    }
    let mut temp = tempfile::NamedTempFile::new_in(home)
        .map_err(|_| AcpError::protocol("Could not save this account's sign-in settings."))?;
    serde_json::to_writer_pretty(&mut temp, &value)
        .map_err(|_| AcpError::protocol("Could not save this account's sign-in settings."))?;
    temp.write_all(b"\n")
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| AcpError::protocol("Could not save this account's sign-in settings."))?;
    // Refuse a link created while the new file was being prepared too.
    check_paths(AgentType::ClaudeCode, home)?;
    temp.persist(home.join("settings.json"))
        .map_err(|_| AcpError::protocol("Could not save this account's sign-in settings."))?;
    Ok(())
}

pub fn validate_key(key: &str) -> Result<(), AcpError> {
    let key = key.trim();
    if key.is_empty()
        || key.len() > 16 * 1024
        || key.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(AcpError::protocol("Enter a valid API key."));
    }
    Ok(())
}

pub async fn runtime_env(
    db: &AppDatabase,
    account: &agent_account::Model,
    data_dir: &Path,
) -> Result<BTreeMap<String, String>, AcpError> {
    let agent = AgentType::from_wire(&account.agent_type)
        .ok_or_else(|| AcpError::protocol("Unknown agent account"))?;
    let home = Path::new(&account.home_dir);
    let mut env = crate::commands::acp::build_runtime_env_for_agent(
        db,
        agent,
        None,
        data_dir,
        true,
        Some(home),
    )
    .await?;
    env.extend(
        agent_accounts::isolation_env_with_base(agent, home, &env).map_err(AcpError::protocol)?,
    );
    Ok(env)
}

/// Do not return CLI output to callers: failures can echo an API key, and
/// successful status output can contain account identity details.
async fn run_private_cli(
    executable: &Path,
    args: &[&str],
    env: &BTreeMap<String, String>,
    home: &Path,
    input: Option<&str>,
) -> Result<(bool, Vec<u8>, Vec<u8>), AcpError> {
    let mut command = crate::process::tokio_command(executable);
    command
        .args(args)
        .current_dir(home)
        .kill_on_drop(true)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        if value.is_empty() {
            command.env_remove(key);
        } else {
            command.env(key, value);
        }
    }
    command
        .env_remove(agent_accounts::ACCOUNT_ENV)
        .env_remove(agent_accounts::ACCOUNT_HOME_ENV);
    let mut child = command.spawn().map_err(|_| {
        AcpError::protocol(
            "Could not start the agent. Check its installation in Settings > Agents.",
        )
    })?;
    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let operation = async {
        let send = async {
            if let (Some(writer), Some(input)) = (&mut stdin, input) {
                writer.write_all(input.as_bytes()).await?;
                writer.write_all(b"\n").await?;
                writer.shutdown().await?;
            }
            drop(stdin);
            Ok::<_, std::io::Error>(())
        };
        let read = async |stream: tokio::process::ChildStdout| {
            let mut bytes = Vec::new();
            stream
                .take(OUTPUT_LIMIT + 1)
                .read_to_end(&mut bytes)
                .await?;
            Ok::<_, std::io::Error>(bytes)
        };
        let errors = async {
            let mut bytes = Vec::new();
            stderr
                .take(OUTPUT_LIMIT + 1)
                .read_to_end(&mut bytes)
                .await?;
            Ok::<_, std::io::Error>(bytes)
        };
        let (_, out, err, status) = tokio::try_join!(send, read(stdout), errors, child.wait())?;
        if out.len() as u64 > OUTPUT_LIMIT || err.len() as u64 > OUTPUT_LIMIT {
            return Err(std::io::Error::other("CLI output limit exceeded"));
        }
        Ok::<_, std::io::Error>((status.success(), out, err))
    };
    match tokio::time::timeout(Duration::from_secs(20), operation).await {
        Ok(Ok(result)) => Ok(result),
        _ => {
            if let Some(pid) = child.id() {
                let config = kill_tree::Config {
                    signal: "SIGKILL".into(),
                    ..Default::default()
                };
                let _ = kill_tree::tokio::kill_tree_with_config(pid, &config).await;
            }
            let _ = child.kill().await;
            Err(AcpError::protocol(
                "The agent could not finish sign-in setup. Try again.",
            ))
        }
    }
}

pub async fn save_codex_key(
    executable: &Path,
    home: &Path,
    env: &BTreeMap<String, String>,
    key: &str,
) -> Result<(), AcpError> {
    validate_key(key)?;
    check_paths(AgentType::Codex, home)?;
    let (success, _, _) = run_private_cli(
        executable,
        &["login", "--with-api-key"],
        env,
        home,
        Some(key.trim()),
    )
    .await?;
    if !success {
        return Err(AcpError::protocol(
            "Could not save the API key. Check the key and the agent's sign-in settings.",
        ));
    }
    Ok(())
}

pub fn parse_status(
    agent: AgentType,
    success: bool,
    stdout: &[u8],
    stderr: &[u8],
) -> AccountAuthStatus {
    let unavailable = AccountAuthStatus {
        state: AuthState::Unavailable,
        method: None,
    };
    if agent == AgentType::ClaudeCode {
        let Ok(value) = serde_json::from_slice::<Value>(stdout) else {
            return unavailable;
        };
        return match value.get("loggedIn").and_then(Value::as_bool) {
            Some(true) if success => AccountAuthStatus {
                state: AuthState::SignedIn,
                method: Some(match value.get("authMethod").and_then(Value::as_str) {
                    Some("api_key" | "api_key_helper") => AccountAuthMethod::ApiKey,
                    Some("claude.ai" | "oauth_token") => AccountAuthMethod::SignIn,
                    _ => AccountAuthMethod::Native,
                }),
            },
            Some(false) => AccountAuthStatus {
                state: AuthState::SignedOut,
                method: None,
            },
            _ => unavailable,
        };
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    )
    .to_ascii_lowercase();
    if success && text.contains("logged in using") {
        AccountAuthStatus {
            state: AuthState::SignedIn,
            method: Some(if text.contains("api key") {
                AccountAuthMethod::ApiKey
            } else if text.contains("chatgpt") {
                AccountAuthMethod::SignIn
            } else {
                AccountAuthMethod::Native
            }),
        }
    } else if !success && text.lines().any(|line| line.trim() == "not logged in") {
        AccountAuthStatus {
            state: AuthState::SignedOut,
            method: None,
        }
    } else {
        unavailable
    }
}

pub async fn check(
    agent: AgentType,
    executable: &Path,
    home: &Path,
    env: &BTreeMap<String, String>,
) -> Result<AccountAuthStatus, AcpError> {
    let args: &[&str] = match agent {
        AgentType::ClaudeCode => &["auth", "status"],
        AgentType::Codex => &["login", "status"],
        _ => {
            return Ok(AccountAuthStatus {
                state: AuthState::Unavailable,
                method: None,
            })
        }
    };
    let (success, out, err) = run_private_cli(executable, args, env, home, None).await?;
    if agent == AgentType::ClaudeCode {
        if let Some(directory) = serde_json::from_slice::<Value>(&out)
            .ok()
            .and_then(|value| {
                value
                    .get("configDirectory")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
        {
            if !crate::parsers::path_eq_for_matching(&directory, &home.to_string_lossy()) {
                return Ok(AccountAuthStatus {
                    state: AuthState::Unavailable,
                    method: None,
                });
            }
        }
    }
    Ok(parse_status(agent, success, &out, &err))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_auth_patch_preserves_preferences_and_separates_api_from_subscription() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let original = json!({"permissions":{"allow":["Read"]},"model":"sonnet", "apiKeyHelper":"old-helper", "env":{"ANTHROPIC_AUTH_TOKEN":"old-token", "CLAUDE_CODE_USE_VERTEX":"1", "ANTHROPIC_PROFILE":"old-profile", "ANTHROPIC_BASE_URL":"https://api.example.test", "EDITOR":"vim"}});
        std::fs::write(&path, original.to_string()).unwrap();
        set_claude_key(dir.path(), Some("fixture-key")).unwrap();
        let api: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(api["permissions"], original["permissions"]);
        assert_eq!(api["model"], "sonnet");
        assert_eq!(api["env"]["EDITOR"], "vim");
        assert_eq!(api["env"]["ANTHROPIC_API_KEY"], "fixture-key");
        assert_eq!(api["env"]["ANTHROPIC_BASE_URL"], "https://api.example.test");
        assert!(api.get("apiKeyHelper").is_none());
        for key in [
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_USE_VERTEX",
            "ANTHROPIC_PROFILE",
        ] {
            assert!(api["env"].get(key).is_none());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o077,
                0
            );
        }
        set_claude_key(dir.path(), None).unwrap();
        let subscription: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(subscription["env"], json!({"EDITOR":"vim"}));
        assert_eq!(subscription["permissions"], original["permissions"]);
    }

    #[test]
    fn account_auth_refuses_invalid_settings_and_keys_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        for original in ["{broken", "[]", "{\"env\":null}"] {
            std::fs::write(&path, original).unwrap();
            assert!(set_claude_key(dir.path(), Some("fixture-key")).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        }
        std::fs::write(&path, "{}").unwrap();
        for key in ["", " ", "key\nother", "key other"] {
            assert!(set_claude_key(dir.path(), Some(key)).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn account_auth_refuses_linked_native_stores_without_touching_the_target() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let original = other.path().join("settings.json");
        std::fs::write(&original, "{}").unwrap();
        symlink(&original, dir.path().join("settings.json")).unwrap();
        assert!(set_claude_key(dir.path(), Some("fixture-key")).is_err());
        assert_eq!(std::fs::read_to_string(original).unwrap(), "{}");
    }

    #[test]
    fn account_auth_status_never_projects_identity_or_errors_as_signed_out() {
        let status = parse_status(AgentType::ClaudeCode, true, br#"{"loggedIn":true,"authMethod":"api_key","email":"private@example.test","apiKey":"fixture-secret"}"#, b"");
        assert_eq!(status.method, Some(AccountAuthMethod::ApiKey));
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!({"state":"signed_in", "method":"api_key"})
        );
        assert_eq!(
            parse_status(
                AgentType::ClaudeCode,
                false,
                b"error with fixture-secret",
                b""
            )
            .state,
            AuthState::Unavailable
        );
        assert_eq!(
            parse_status(AgentType::ClaudeCode, false, br#"{"loggedIn":false}"#, b"").state,
            AuthState::SignedOut
        );
        assert_eq!(
            parse_status(
                AgentType::Codex,
                true,
                b"",
                b"Logged in using an API key - fixture-secret"
            )
            .method,
            Some(AccountAuthMethod::ApiKey)
        );
        assert_eq!(
            parse_status(AgentType::Codex, true, b"", b"Logged in using ChatGPT").method,
            Some(AccountAuthMethod::SignIn)
        );
        assert_eq!(
            parse_status(AgentType::Codex, false, b"", b"Not logged in\n").state,
            AuthState::SignedOut
        );
        assert_eq!(
            parse_status(
                AgentType::Codex,
                false,
                b"",
                b"Keyring error: not logged in? fixture-secret"
            )
            .state,
            AuthState::Unavailable
        );
    }

    #[cfg(unix)]
    fn fake_cli(home: &Path, script: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let executable = home.join("fake-cli");
        std::fs::write(&executable, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        executable
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn account_auth_codex_key_goes_only_to_stdin_in_its_own_home() {
        let dir = tempfile::tempdir().unwrap();
        let executable = fake_cli(dir.path(), "printf '%s\\n' \"$@\" > args\nprintf '%s' \"$CODEX_HOME\" > scope\ncat > input\nprintf '%s' 'fixture-secret' >&2\nexit 1");
        let env = agent_accounts::isolation_env(AgentType::Codex, dir.path()).unwrap();
        let error = save_codex_key(&executable, dir.path(), &env, "fixture-secret")
            .await
            .unwrap_err();
        assert!(!error.to_string().contains("fixture-secret"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("args")).unwrap(),
            "login\n--with-api-key\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("input")).unwrap(),
            "fixture-secret\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("scope")).unwrap(),
            dir.path().to_str().unwrap()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn account_auth_rejects_status_from_another_claude_home() {
        let dir = tempfile::tempdir().unwrap();
        let executable = fake_cli(dir.path(), "printf '%s' '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"configDirectory\":\"/another/home\"}'");
        let env = agent_accounts::isolation_env(AgentType::ClaudeCode, dir.path()).unwrap();
        assert_eq!(
            env.get("ANTHROPIC_CONFIG_DIR"),
            Some(&dir.path().join("anthropic").to_string_lossy().into_owned())
        );
        let result = check(AgentType::ClaudeCode, &executable, dir.path(), &env)
            .await
            .unwrap();
        assert_eq!(result.state, AuthState::Unavailable);
    }
}
