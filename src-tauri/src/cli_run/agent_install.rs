//! `codeg-cli agents install SLUG`: an agent installed the way Settings →
//! Agents installs it, so a fresh CI runner needs nothing else.
//!
//! An install can take minutes (npm, a download) and must not depend on the
//! CLI staying connected: axum drops the handler of a request whose client
//! went away, which would leave npm running with nobody to record its
//! outcome. So the install runs on its own here — `install` answers at once
//! with its id, `get` follows it, waiting up to 25 s per call. One install
//! per agent at a time: asking again joins the one under way. A finished
//! install is kept for 30 minutes, for a CLI that lost its connection.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use tokio::sync::watch;

use crate::acp::registry::{self, AgentDistribution};
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::web::event_bridge::EventEmitter;

use super::service::CliError;
use super::wire::{AgentInstallGetRequest, AgentInstallRequest, AgentInstallState, EVENT_VERSION};

const MAX_WAIT: Duration = Duration::from_secs(25);
const RETENTION: Duration = Duration::from_secs(30 * 60);
const MAX_FINISHED: usize = 100;

/// The installs this runtime started for CLIs.
#[derive(Default)]
pub struct AgentInstalls {
    jobs: StdMutex<Jobs>,
}

#[derive(Default)]
struct Jobs {
    by_id: HashMap<String, watch::Sender<AgentInstallState>>,
    /// The install under way for an agent, by its id.
    running: HashMap<AgentType, String>,
    finished: VecDeque<(String, Instant)>,
}

impl Jobs {
    fn prune(&mut self, now: Instant) {
        while let Some((id, at)) = self.finished.front() {
            if self.finished.len() <= MAX_FINISHED && now.duration_since(*at) < RETENTION {
                break;
            }
            self.by_id.remove(id);
            self.finished.pop_front();
        }
    }
}

impl AgentInstalls {
    /// Install `req.agent`, or join its install under way; answers at once.
    pub fn install(
        self: &Arc<Self>,
        db: &AppDatabase,
        emitter: &EventEmitter,
        req: &AgentInstallRequest,
    ) -> Result<AgentInstallState, CliError> {
        let agent = installable(&req.agent)?;
        let version = match req.version.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(raw) => Some(
                crate::commands::acp::sanitize_custom_version(raw).ok_or_else(|| {
                    CliError::usage(
                        "bad_version",
                        format!("--version {raw:?} is not a version such as 1.2.3"),
                    )
                })?,
            ),
        };
        let mut jobs = self.jobs.lock().expect("installs");
        jobs.prune(Instant::now());
        if let Some(id) = jobs.running.get(&agent) {
            if let Some(tx) = jobs.by_id.get(id) {
                return Ok(tx.borrow().clone());
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let state = AgentInstallState {
            v: EVENT_VERSION,
            kind: "agent_install".into(),
            install_id: id.clone(),
            agent: agent.as_wire().into_owned(),
            state: "running".into(),
            version: None,
            error: None,
        };
        let (tx, _) = watch::channel(state.clone());
        jobs.by_id.insert(id.clone(), tx.clone());
        jobs.running.insert(agent, id.clone());
        drop(jobs);

        let installs = Arc::clone(self);
        let db = AppDatabase {
            conn: db.conn.clone(),
        };
        let emitter = emitter.clone();
        tokio::spawn(async move {
            let outcome = perform(agent, version, &db, &emitter).await;
            tx.send_modify(|s| match outcome {
                Ok(version) => {
                    s.state = "installed".into();
                    s.version = version;
                }
                Err(e) => {
                    s.state = "failed".into();
                    s.error = Some(e.body.error);
                }
            });
            let mut jobs = installs.jobs.lock().expect("installs");
            jobs.running.remove(&agent);
            jobs.finished.push_back((id, Instant::now()));
        });
        Ok(state)
    }

    /// Install `req.install_id`, once it ended or `waitMs` passed.
    pub async fn get(&self, req: &AgentInstallGetRequest) -> Result<AgentInstallState, CliError> {
        let mut rx = {
            let jobs = self.jobs.lock().expect("installs");
            jobs.by_id
                .get(&req.install_id)
                .map(watch::Sender::subscribe)
                .ok_or_else(|| {
                    CliError::unavailable(
                        "install_not_found",
                        format!(
                            "this codeg has no install {}: it was never started here, or ended \
                             more than 30 minutes ago",
                            req.install_id
                        ),
                    )
                })?
        };
        let wait = Duration::from_millis(req.wait_ms.unwrap_or(0)).min(MAX_WAIT);
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let state = rx.borrow_and_update().clone();
            if state.state != "running" {
                return Ok(state);
            }
            match tokio::time::timeout_at(deadline, rx.changed()).await {
                Ok(Ok(())) => continue,
                // Timed out, or the install's task is gone: as it stands.
                _ => return Ok(rx.borrow().clone()),
            }
        }
    }
}

/// The agent `slug` names, if it is one this codeg installs.
fn installable(slug: &str) -> Result<AgentType, CliError> {
    let unknown = || {
        CliError::usage("unknown_agent", format!("{slug:?} is not an agent"))
            .with_next_steps(["codeg-cli agents".to_string()])
    };
    let agent = AgentType::from_wire(slug).ok_or_else(unknown)?;
    if let Some(id) = agent.custom_id() {
        if !crate::acp::custom_registry::is_registered(id) {
            return Err(unknown());
        }
    }
    if !registry::all_acp_agents().contains(&agent) {
        return Err(unknown());
    }
    if let AgentDistribution::System { install_url, .. } =
        registry::get_agent_meta(agent).distribution
    {
        return Err(CliError::usage(
            "not_installable",
            format!(
                "{} comes with its own installer, which codeg does not run: {install_url}",
                agent.as_wire()
            ),
        ));
    }
    Ok(agent)
}

/// The install itself, as Settings → Agents runs it; the version installed.
async fn perform(
    agent: AgentType,
    version: Option<String>,
    db: &AppDatabase,
    emitter: &EventEmitter,
) -> Result<Option<String>, CliError> {
    use crate::commands::acp;
    let failed =
        |e: crate::acp::error::AcpError| CliError::execution("install_failed", e.to_string());
    let task_id = format!("cli-install-{}", uuid::Uuid::new_v4());
    let meta = registry::get_agent_meta(agent);
    let installed = match meta.distribution {
        AgentDistribution::Npx { .. } | AgentDistribution::Uvx { .. } => {
            if matches!(meta.distribution, AgentDistribution::Uvx { .. }) {
                acp::acp_install_uv_tool_core(task_id.clone(), emitter)
                    .await
                    .map_err(failed)?;
            }
            // Another version than the pinned one replaces what is there,
            // as the settings page does it.
            let clean_first = version.is_some();
            let installed = acp::acp_prepare_npx_agent_core(
                agent,
                meta.registry_version().map(str::to_owned),
                version,
                clean_first,
                task_id.clone(),
                db,
                emitter,
            )
            .await
            .map_err(failed)?;
            if agent == AgentType::Pi {
                // pi-acp drives the `pi` program, which is a package of its own.
                acp::acp_install_pi_binary_core(task_id.clone(), emitter)
                    .await
                    .map_err(failed)?;
            }
            Some(installed)
        }
        AgentDistribution::Binary { .. } => {
            if version.is_some() {
                // A cached build of another version would win at launch.
                acp::acp_clear_binary_cache(agent).await.map_err(failed)?;
            }
            acp::acp_download_agent_binary_core(agent, version, task_id.clone(), emitter)
                .await
                .map_err(failed)?;
            acp::acp_detect_agent_local_version_core(agent, &db.conn, emitter)
                .await
                .ok()
                .flatten()
        }
        AgentDistribution::System { .. } => unreachable!("refused by installable()"),
    };
    // What a run will check before it starts the agent.
    acp::verify_agent_installed(agent).await.map_err(|e| {
        CliError::execution(
            "agent_not_found_after_install",
            format!(
                "{} was installed, but codeg still cannot find it: {e}",
                agent.as_wire()
            ),
        )
    })?;
    Ok(installed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_agent_codeg_installs_is_taken() {
        assert_eq!(installable("claude_code").unwrap(), AgentType::ClaudeCode);
        for (slug, code) in [
            ("claud", "unknown_agent"),
            ("custom:not-registered", "unknown_agent"),
            ("kiro", "not_installable"),
        ] {
            let err = installable(slug).unwrap_err();
            assert_eq!(err.body.error.code, code, "{slug}");
            assert_eq!(err.status, 400, "{slug}");
        }
    }

    #[tokio::test]
    async fn an_install_nobody_started_is_not_found() {
        let installs = AgentInstalls::default();
        let err = installs
            .get(&AgentInstallGetRequest {
                install_id: "nope".into(),
                wait_ms: None,
            })
            .await
            .unwrap_err();
        assert_eq!(err.body.error.code, "install_not_found");
        assert_eq!(err.status, 404);
    }

    #[tokio::test]
    async fn a_version_that_is_not_one_is_refused_before_anything_runs() {
        let installs = Arc::new(AgentInstalls::default());
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let err = installs
            .install(
                &db,
                &EventEmitter::Noop,
                &AgentInstallRequest {
                    agent: "claude_code".into(),
                    version: Some("latest".into()),
                },
            )
            .unwrap_err();
        assert_eq!(err.body.error.code, "bad_version");
        assert!(installs.jobs.lock().unwrap().by_id.is_empty());
    }
}
