use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AcpError {
    #[error("agent process failed to spawn: {0}")]
    SpawnFailed(String),
    #[error("connection not found: {0}")]
    ConnectionNotFound(String),
    #[error("ACP protocol error: {0}")]
    Protocol(String),
    #[error("agent process exited unexpectedly")]
    ProcessExited,
    /// A prompt arrived while this connection already had a turn in flight.
    /// The connection loop processes one turn at a time; a second concurrent
    /// prompt (e.g. two co-controlling clients sending near-simultaneously)
    /// is rejected here rather than silently dropped after a false success.
    /// The frontend recognizes this (via the stable Display text, carried as
    /// the error message on both transports) and re-queues the draft in the
    /// message queue above the input box instead of surfacing an error.
    #[error("turn already in progress for this connection")]
    TurnInProgress,
    /// Live feedback was submitted while no turn was in flight. Feedback only
    /// makes sense while the agent is working (it is pulled mid-turn via the
    /// `check_user_feedback` MCP tool); with no active turn there is nothing to
    /// steer. The frontend recognizes this (stable Display text) and falls back
    /// to sending the text as an ordinary prompt instead.
    #[error("no active turn to send feedback to")]
    NoActiveTurn,
    /// Live feedback was submitted while the feature is disabled. The settings
    /// toggle gates both MCP tool injection and the UI affordance; this is the
    /// backend's defense-in-depth for a direct/stale call.
    #[error("live feedback is disabled")]
    FeedbackDisabled,
    /// The submitted feedback note is empty or exceeds the per-note size bound.
    /// The full text rides in the broadcast event + snapshot + MCP response, so
    /// a sanity bound keeps a single pathological note from bloating them.
    #[error("invalid feedback: {0}")]
    InvalidFeedback(String),
    /// pi was asked to start in a folder that pi's own trust store already marks
    /// trusted, without anyone in codeg having confirmed that grant. Trusting a
    /// folder lets the repository execute its `.pi/extensions` at pi startup, and
    /// older codeg builds wrote those grants automatically for every folder they
    /// opened — so the launch fails closed until the user answers for it. Carries
    /// the explanation shown to the user; the project-trust notice resolves it.
    #[error("{0}")]
    PiProjectTrustRequired(String),
    #[error("binary download failed: {0}")]
    DownloadFailed(String),
    #[error("platform not supported: {0}")]
    PlatformNotSupported(String),
    #[error("{0}")]
    SdkNotInstalled(String),
    #[error("Agent did not respond to Initialize within 60 seconds. The cached binary may be outdated or incompatible. Try upgrading it from Agent Settings.")]
    InitializeTimeout,
    #[error("Agent did not publish its configurable options within 60 seconds. The probe was aborted; the agent may be slow, idle, or not ACP-compliant — try again or check the agent binary.")]
    ProbeTimedOut,
    /// `session/new` failed on a **custom** agent that codeg had just handed
    /// MCP servers on the wire. That is the exact failure
    /// `CustomAgentDef::supports_mcp` exists to let the user avoid: an
    /// arbitrary third-party ACP binary may reject a non-empty `mcpServers`
    /// outright and never open a session.
    ///
    /// codeg cannot distinguish this from an unrelated `session/new` failure,
    /// so it is a *hint*, not a diagnosis — the payload stays the agent's own
    /// message and the frontend renders the suggestion alongside it.
    #[error("{0}")]
    McpRejectedByAgent(String),
    /// The agent refused to OPEN a session with ACP's `authRequired` (-32000):
    /// it launched fine and simply has no credential it can use. Distinct from
    /// the same rejection on `session/prompt`, which is turn-scoped and leaves
    /// the connection alive (`turn_failed_auth_required`).
    ///
    /// It earns a code of its own because the agent's own wording is the part
    /// the user cannot act on. cursor-agent, for one, answers `Please run
    /// 'agent login' first` — and `agent` is not a command that exists: the
    /// binary is `cursor-agent`, and codeg's managed copy is not on `$PATH`
    /// either. The frontend renders codeg's instruction from the code instead
    /// and points at the agent's own settings panel, which knows the path.
    #[error("{0}")]
    AgentAuthRequired(String),
}

impl AcpError {
    pub fn protocol(raw: impl Into<String>) -> Self {
        let raw = raw.into();
        let sanitized = sanitize_protocol_message(&raw);

        if is_executable_format_error(&sanitized) {
            return Self::Protocol(
                "Agent executable appears incompatible or corrupted. Please retry to re-download it."
                    .into(),
            );
        }

        Self::Protocol(sanitized)
    }

    /// [`Self::McpRejectedByAgent`] with the same sanitization
    /// [`Self::protocol`] applies — the agent's message is still shown, so it
    /// must not leak local paths or spawn metadata either.
    pub fn mcp_rejected(raw: impl Into<String>) -> Self {
        Self::McpRejectedByAgent(sanitize_protocol_message(&raw.into()))
    }

    /// [`Self::AgentAuthRequired`] with the same sanitization. The payload is
    /// only a fallback (logs, and any surface that has no code mapping); the
    /// user-facing wording comes from the code.
    pub fn agent_auth_required(raw: impl Into<String>) -> Self {
        Self::AgentAuthRequired(sanitize_protocol_message(&raw.into()))
    }

    /// Stable machine-readable identifier for this error kind.
    ///
    /// Returned to the frontend alongside the human-readable message so
    /// the UI can render a localized message based on the code instead
    /// of parsing English text. `None` means "no stable code — show the
    /// raw message as a fallback".
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::SdkNotInstalled(_) => Some("sdk_not_installed"),
            Self::PiProjectTrustRequired(_) => Some("pi_project_trust_required"),
            Self::PlatformNotSupported(_) => Some("platform_not_supported"),
            Self::InitializeTimeout => Some("initialize_timeout"),
            Self::ProbeTimedOut => Some("probe_timed_out"),
            Self::ProcessExited => Some("process_exited"),
            Self::TurnInProgress => Some("turn_in_progress"),
            Self::NoActiveTurn => Some("no_active_turn"),
            Self::FeedbackDisabled => Some("feedback_disabled"),
            Self::InvalidFeedback(_) => Some("invalid_feedback"),
            Self::SpawnFailed(_) => Some("spawn_failed"),
            Self::DownloadFailed(_) => Some("download_failed"),
            Self::ConnectionNotFound(_) => Some("connection_not_found"),
            Self::McpRejectedByAgent(_) => Some("mcp_rejected_by_agent"),
            Self::AgentAuthRequired(_) => Some("agent_auth_required"),
            Self::Protocol(_) => None,
        }
    }
}

impl Serialize for AcpError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

fn sanitize_protocol_message(raw: &str) -> String {
    let without_spawned_at = regex::Regex::new(r#"\s*,?\s*"spawned_at"\s*:\s*"[^"]*"\s*,?"#)
        .ok()
        .map(|re| re.replace_all(raw, "").into_owned())
        .unwrap_or_else(|| raw.to_string());

    let without_dangling_comma = regex::Regex::new(r#",\s*([}\]])"#)
        .ok()
        .map(|re| re.replace_all(&without_spawned_at, "$1").into_owned())
        .unwrap_or(without_spawned_at);

    regex::Regex::new(r#"/(?:Users|home)/[^"\s]+"#)
        .ok()
        .map(|re| {
            re.replace_all(&without_dangling_comma, "<local-path>")
                .into_owned()
        })
        .unwrap_or(without_dangling_comma)
}

fn is_executable_format_error(message: &str) -> bool {
    let lowered = message.to_lowercase();
    lowered.contains("malformed mach-o file")
        || lowered.contains("exec format error")
        || lowered.contains("bad cpu type in executable")
        || lowered.contains("not a valid win32 application")
        || lowered.contains("is not a valid application for this os platform")
}
