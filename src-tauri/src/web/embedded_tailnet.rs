//! Userspace tailnet join plan for phone reach.
//!
//! The existing Web Service URL + token is the session. This module only
//! plans a `codeg-tsnet` sidecar (auth URL or auth key). It does not install
//! the standalone Tailscale app.

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TailnetAuth {
    AuthKey(String),
    AuthUrl(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailnetJoinPlan {
    pub hostname: String,
    pub target: String,
    pub auth: TailnetAuth,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailnetLaunch {
    pub plan: TailnetJoinPlan,
    pub command: Vec<String>,
    pub binary: PathBuf,
}

pub fn join_plan(
    target: &str,
    hostname: Option<&str>,
    auth_key: Option<&str>,
    auth_url: Option<&str>,
) -> Result<TailnetJoinPlan, String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("target is required (desktop web service)".into());
    }
    let hostname = hostname
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("codeg")
        .to_string();
    let key = auth_key.map(str::trim).unwrap_or("");
    let url = auth_url.map(str::trim).unwrap_or("");
    if !key.is_empty() && !url.is_empty() {
        return Err("use either an auth key or an auth URL, not both".into());
    }
    let auth = if !key.is_empty() {
        TailnetAuth::AuthKey(key.to_string())
    } else if !url.is_empty() {
        TailnetAuth::AuthUrl(url.to_string())
    } else {
        return Err("auth key or auth URL is required".into());
    };
    Ok(TailnetJoinPlan {
        hostname,
        target: target.to_string(),
        auth,
    })
}

pub fn sidecar_args(plan: &TailnetJoinPlan) -> Vec<String> {
    let (flag, value) = match &plan.auth {
        TailnetAuth::AuthKey(v) => ("--authkey", v.as_str()),
        TailnetAuth::AuthUrl(v) => ("--login-server", v.as_str()),
    };
    vec![
        "--hostname".into(),
        plan.hostname.clone(),
        "--target".into(),
        plan.target.clone(),
        flag.into(),
        value.into(),
    ]
}

pub fn resolve_sidecar_binary(search_dir: Option<&Path>) -> Option<PathBuf> {
    let names = if cfg!(windows) {
        ["codeg-tsnet.exe", "codeg-tsnet"]
    } else {
        ["codeg-tsnet", "codeg-tsnet.exe"]
    };
    if let Some(dir) = search_dir {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn launch_sidecar(
    plan: &TailnetJoinPlan,
    search_dir: Option<&Path>,
) -> Result<TailnetLaunch, String> {
    let binary = resolve_sidecar_binary(search_dir)
        .ok_or_else(|| "codeg-tsnet sidecar is not installed beside Codeg".to_string())?;
    let mut command = vec![binary.display().to_string()];
    command.extend(sidecar_args(plan));
    Ok(TailnetLaunch {
        plan: plan.clone(),
        command,
        binary,
    })
}

/// Spawn the sidecar. Tests never call this; production callers must handle
/// a missing binary as unavailable rather than a fake tunnel.
pub fn spawn_sidecar(launch: &TailnetLaunch) -> Result<(), String> {
    Command::new(&launch.binary)
        .args(sidecar_args(&launch.plan))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to start codeg-tsnet: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_plan_is_stable_for_auth_key() {
        let first = join_plan(
            "http://127.0.0.1:3080",
            Some("codeg-desk"),
            Some("tskey-auth-example"),
            None,
        )
        .unwrap();
        let second = join_plan(
            "http://127.0.0.1:3080",
            Some("codeg-desk"),
            Some("tskey-auth-example"),
            None,
        )
        .unwrap();
        assert_eq!(first, second);
        assert!(matches!(first.auth, TailnetAuth::AuthKey(_)));
        assert!(sidecar_args(&first).contains(&"--authkey".into()));
    }

    #[test]
    fn join_plan_is_stable_for_auth_url() {
        let first = join_plan(
            "http://127.0.0.1:3080",
            None,
            None,
            Some("https://login.tailscale.com/a/example"),
        )
        .unwrap();
        let second = join_plan(
            "http://127.0.0.1:3080",
            None,
            None,
            Some("https://login.tailscale.com/a/example"),
        )
        .unwrap();
        assert_eq!(first, second);
        assert_eq!(first.hostname, "codeg");
        assert!(sidecar_args(&first).contains(&"--login-server".into()));
    }

    #[test]
    fn missing_sidecar_is_unavailable_not_a_fake_tunnel() {
        let plan = join_plan("http://127.0.0.1:3080", None, Some("tskey-auth-x"), None)
            .unwrap();
        let missing = tempfile::tempdir().unwrap();
        let err = launch_sidecar(&plan, Some(missing.path())).unwrap_err();
        assert!(err.contains("not installed"), "{err}");
    }
}
