use crate::models::agent::AgentType;

#[derive(Debug, Clone)]
pub enum AgentDistribution {
    Npx {
        version: &'static str,
        package: &'static str,
        /// The command name provided by this npx package (e.g. "gemini", "openclaw").
        cmd: &'static str,
        args: &'static [&'static str],
        env: &'static [(&'static str, &'static str)],
        /// Minimum Node.js version required, e.g. "22.12.0". None means no specific requirement.
        node_required: Option<&'static str>,
    },
    Binary {
        version: &'static str,
        /// Command name on PATH (fallback launch + `which` probes). For
        /// single-file archives this is also the file name copied out of the
        /// archive into the cache.
        cmd: &'static str,
        args: &'static [&'static str],
        env: &'static [(&'static str, &'static str)],
        platforms: &'static [PlatformBinary],
        /// `None`: the archive contains one self-contained binary named `cmd`,
        /// which is copied out into the cache (OpenCode). `Some`: the archive
        /// is a whole directory tree that must stay intact (bundled runtime,
        /// e.g. Cursor's agent-cli-package); everything is extracted into the
        /// per-version cache dir and the entry path inside it is launched.
        dir_entry: Option<BinaryDirEntry>,
    },
    /// Python agents launched through `uvx` (the `uv` tool runner), which
    /// fetches + caches the pinned package on first use — analogous to npx.
    /// Used for custom ACP agents distributed as PyPI packages (Hermes shipped
    /// this way through 0.19.0, before upstream retired its PyPI channel and
    /// the registry entry moved to the npm bridge — see `AgentType::Hermes`).
    Uvx {
        version: &'static str,
        /// The `uvx --from` package spec, e.g. "some-agent[extra]==1.2.0".
        package: &'static str,
        /// The console-script entry point to run.
        cmd: &'static str,
        args: &'static [&'static str],
        env: &'static [(&'static str, &'static str)],
        /// Minimum `uv` version required, e.g. "0.5.0". None means no specific requirement.
        uv_required: Option<&'static str>,
        /// Interpreter to pin via `uvx --python <ver>`, e.g. `Some("3.13")`.
        /// `None` lets uvx pick its default interpreter. Set this when the
        /// package (or a transitive dep) does not support the machine's default
        /// Python — uv auto-downloads a managed build of the pinned version.
        python: Option<&'static str>,
        /// Fallback command resolvable on PATH when `uvx` is unavailable —
        /// lets users who installed the agent's own CLI (pipx, `uv tool
        /// install`, an official installer) launch it without `uv`.
        system_cmd: Option<(&'static str, &'static [&'static str])>,
    },
}

#[derive(Debug, Clone)]
pub struct PlatformBinary {
    pub platform: &'static str,
    pub url: &'static str,
    /// Expected hex SHA-256 of the downloaded archive, verified before the
    /// archive is unpacked. `None` for built-ins: their URLs are repository
    /// constants reviewed with the code. Custom agents download from
    /// user-supplied URLs, so the ACP registry's `sha256` is carried through
    /// and enforced whenever it is published.
    pub sha256: Option<&'static str>,
}

/// A set of archive-relative paths that differ between platform families
/// (typically only by a `.exe` suffix). Paths are '/'-separated.
#[derive(Debug, Clone, Copy)]
pub struct PlatformFiles {
    pub unix: &'static [&'static str],
    pub windows: &'static [&'static str],
}

impl PlatformFiles {
    pub const NONE: PlatformFiles = PlatformFiles {
        unix: &[],
        windows: &[],
    };

    pub fn for_current_platform(&self) -> &'static [&'static str] {
        if cfg!(windows) {
            self.windows
        } else {
            self.unix
        }
    }
}

/// Launch entry inside an extracted directory-tree archive (see
/// [`AgentDistribution::Binary::dir_entry`]). Paths are relative to the
/// archive root, '/'-separated; `windows` names the `.cmd`/`.bat` shim.
#[derive(Debug, Clone, Copy)]
pub struct BinaryDirEntry {
    pub unix: &'static str,
    pub windows: &'static str,
    /// Files that must sit beside `unix`/`windows` for the install to be
    /// USABLE, not merely present — the cache treats a version dir missing any
    /// of them as not installed, and installing fails loudly rather than
    /// leaving a half-tree behind.
    ///
    /// This is what stops a stale single-file cache from being adopted. Before
    /// an agent becomes a built-in, the same ACP-registry entry can be added as
    /// a CUSTOM agent, and a FLAT archive (`cmd: "./foo"`, no `/`) installs
    /// through the single-file copy-out path — leaving exactly the entry file,
    /// under exactly the same `<registry id>/<version>/<platform>` key the
    /// built-in later uses. Probing for the entry alone would then report that
    /// cache as installed and launch a tree with its helpers missing.
    pub required_siblings: PlatformFiles,
}

impl BinaryDirEntry {
    /// Entry path for the current platform.
    pub fn for_current_platform(&self) -> &'static str {
        if cfg!(windows) {
            self.windows
        } else {
            self.unix
        }
    }
}

#[derive(Debug, Clone)]
pub struct AcpAgentMeta {
    pub agent_type: AgentType,
    /// 是否经 ACP 线缆（session/new 的 `mcpServers` 字段）向该 agent 转发 MCP
    /// 服务器——既包括用户配置的服务器，也包括内置 codeg-mcp 伴生进程。
    /// OpenClaw 拒绝 `mcpServers` 中的任何服务器条目（会使 session/new 失败），
    /// 故置 false。注意空列表 `[]` 仍会按 ACP schema 序列化、OpenClaw 可接受——
    /// 闸门只是保证该列表对 OpenClaw 恒为空（不含任何条目）。
    pub supports_mcp: bool,
    pub name: &'static str,
    pub description: &'static str,
    pub distribution: AgentDistribution,
}

impl AcpAgentMeta {
    pub fn registry_version(&self) -> Option<&'static str> {
        match &self.distribution {
            AgentDistribution::Npx { version, .. }
            | AgentDistribution::Binary { version, .. }
            | AgentDistribution::Uvx { version, .. } => Some(*version),
        }
    }

    /// Whether asking for a version other than the pinned one can actually
    /// FETCH that version on this machine.
    ///
    /// Having a `registry_version` does not imply it: a binary agent's custom
    /// install works by substituting the requested version into the pinned
    /// download URL (`apply_custom_version_to_url`), which only produces a
    /// different URL when the pinned version is a substring of it. An agent
    /// whose archives are named after an opaque build id rather than the
    /// release is therefore excluded: the substitution is a no-op, and the
    /// "install 1.2.3" the user asked for would download the SAME bytes and
    /// cache them under the new number. That is worse than refusing —
    /// `installed_version` then reports a build that was never fetched.
    /// Antigravity was that case until Google renamed its archives after the
    /// release (see its registry entry); no built-in agent is today, so the
    /// rule is covered by a synthetic entry in the tests rather than a real
    /// one.
    ///
    /// Judged per-platform, because only the current platform's URL is ever
    /// downloaded and a future agent may template one target but not another.
    /// An unsupported platform answers `false` — there is nothing to install.
    ///
    /// Uvx pins its version inside the package spec and the download path
    /// rejects it outright, so it is `false` rather than "ignored silently".
    pub fn supports_custom_version(&self) -> bool {
        match &self.distribution {
            AgentDistribution::Npx { .. } => true,
            AgentDistribution::Uvx { .. } => false,
            AgentDistribution::Binary {
                version, platforms, ..
            } => platforms
                .iter()
                .find(|p| p.platform == current_platform())
                .is_some_and(|p| p.url.contains(version)),
        }
    }
}

/// Launch args for Google Antigravity's ACP server, resolved at compile time.
///
/// The ACP registry publishes `--uid=` for the two Linux targets and for
/// nothing else, and that asymmetry is deliberate: the flag comes from the
/// binary's linked-in absl `InitGoogle`, which — when the process runs as root
/// — drops privileges to `nobody` unless told otherwise. Passing it everywhere
/// would risk a hard "unknown flag" startup error on the Windows build, which
/// need not link the same initializer.
const ANTIGRAVITY_LAUNCH_ARGS: &[&str] = if cfg!(target_os = "linux") {
    &["--uid="]
} else {
    &[]
};

pub fn current_platform() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-aarch64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x86_64"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "windows-aarch64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x86_64"
    }
}

/// The fifteen built-in agents. Excludes user-registered custom agents — use
/// [`all_acp_agents`] for the live set.
pub fn builtin_acp_agents() -> Vec<AgentType> {
    vec![
        AgentType::ClaudeCode,
        AgentType::Codex,
        AgentType::Gemini,
        AgentType::OpenClaw,
        AgentType::OpenCode,
        AgentType::Cline,
        AgentType::Hermes,
        AgentType::CodeBuddy,
        AgentType::KimiCode,
        AgentType::Pi,
        AgentType::Grok,
        AgentType::Cursor,
        AgentType::DeepSeek,
        AgentType::Qoder,
        AgentType::Antigravity,
    ]
}

/// Every agent codeg can currently drive: the fifteen built-ins followed by
/// the user's registered custom ACP agents (sorted by id).
pub fn all_acp_agents() -> Vec<AgentType> {
    let mut agents = builtin_acp_agents();
    agents.extend(crate::acp::custom_registry::all());
    agents
}

pub fn registry_id_for(agent_type: AgentType) -> &'static str {
    match agent_type {
        AgentType::ClaudeCode => "claude-acp",
        AgentType::Codex => "codex-acp",
        AgentType::Gemini => "gemini",
        AgentType::OpenClaw => "openclaw-acp",
        AgentType::OpenCode => "opencode",
        AgentType::Cline => "cline",
        AgentType::Hermes => "hermes",
        AgentType::CodeBuddy => "codebuddy-code",
        AgentType::KimiCode => "kimi-code",
        AgentType::Pi => "pi-acp",
        AgentType::Grok => "grok-build",
        AgentType::Cursor => "cursor",
        AgentType::DeepSeek => "deepseek-acp",
        AgentType::Qoder => "qoder-cli",
        AgentType::Antigravity => "antigravity-acp",
        // A custom agent's registry id IS its identity.
        AgentType::Custom(id) => id,
    }
}

pub fn from_registry_id(id: &str) -> Option<AgentType> {
    match id {
        "claude-acp" => Some(AgentType::ClaudeCode),
        "codex-acp" => Some(AgentType::Codex),
        "gemini" => Some(AgentType::Gemini),
        "openclaw-acp" => Some(AgentType::OpenClaw),
        "opencode" => Some(AgentType::OpenCode),
        "cline" => Some(AgentType::Cline),
        "hermes" => Some(AgentType::Hermes),
        "codebuddy-code" => Some(AgentType::CodeBuddy),
        "kimi-code" => Some(AgentType::KimiCode),
        "pi-acp" => Some(AgentType::Pi),
        "grok-build" => Some(AgentType::Grok),
        "cursor" => Some(AgentType::Cursor),
        "deepseek-acp" => Some(AgentType::DeepSeek),
        "qoder-cli" => Some(AgentType::Qoder),
        "antigravity-acp" => Some(AgentType::Antigravity),
        // Only ids the user has actually registered resolve. An unregistered
        // id must stay `None` so the ACP-registry picker still offers it as
        // "addable" rather than treating it as already supported.
        other => crate::acp::custom_registry::is_registered(other)
            .then(|| AgentType::custom(other))
            .flatten(),
    }
}

/// The vendor CLI wrapped by a codeg entry that is really a THIRD-PARTY ACP
/// *adapter*.
///
/// All but two of the built-ins distribute the vendor's own CLI (or, for
/// Antigravity, the vendor's own ACP server), so a user's existing global
/// install is found by the launch gate as-is. Claude Code and
/// Codex are the exceptions: neither `claude` nor `codex` speaks ACP, so codeg
/// installs a separate adapter package (`claude-agent-acp` / `codex-acp`,
/// maintained by the Agent Client Protocol org) whose command name has nothing
/// to do with the vendor CLI's. That mismatch is the single most reported
/// confusion ("I have claude installed, why does codeg say it isn't?"), so
/// preflight and diagnostics probe the vendor CLI too and explain the split.
#[derive(Debug, Clone, Copy)]
pub struct AcpAdapterRelation {
    /// The vendor CLI users install themselves, e.g. "claude".
    pub native_cmd: &'static str,
    /// Display name for that CLI, e.g. "Claude Code CLI".
    pub native_label: &'static str,
    /// Config/credential dir BOTH the vendor CLI and the adapter read, so
    /// installing the adapter needs no second login.
    pub shared_config_dir: &'static str,
    /// Home-relative dirs the vendor's own installers use that a GUI app's PATH
    /// commonly lacks. Probed after PATH and the npm global prefix.
    pub extra_dirs: &'static [&'static str],
    /// Where the "learn more" action points.
    pub docs_url: &'static str,
}

/// Adapter relation for an agent, or `None` when codeg's entry IS the vendor's
/// own CLI (every agent except these two).
///
/// Adding an entry here changes what preflight/diagnostics report — keep the
/// `acp_adapter_relation_covers_only_wrapper_agents` test in sync.
pub fn acp_adapter_relation(agent_type: AgentType) -> Option<AcpAdapterRelation> {
    match agent_type {
        AgentType::ClaudeCode => Some(AcpAdapterRelation {
            native_cmd: "claude",
            native_label: "Claude Code CLI",
            shared_config_dir: "~/.claude",
            // The native installer targets ~/.local/bin; older builds used
            // ~/.claude/local.
            extra_dirs: &[".local/bin", ".claude/local"],
            docs_url: ACP_ADAPTER_DOCS_URL,
        }),
        AgentType::Codex => Some(AcpAdapterRelation {
            native_cmd: "codex",
            native_label: "Codex CLI",
            shared_config_dir: "~/.codex",
            extra_dirs: &[".local/bin"],
            docs_url: ACP_ADAPTER_DOCS_URL,
        }),
        _ => None,
    }
}

/// Home-relative directories a vendor's OWN installer drops the agent binary
/// into, for agents codeg can also manage itself.
///
/// Distinct from [`AcpAdapterRelation::extra_dirs`], which describes a vendor
/// CLI codeg never launches; these are launchable binaries, just not where a
/// GUI-inherited PATH can see them. OpenCode's official install script uses
/// `INSTALL_DIR=$HOME/.opencode/bin` and appends it to the user's shell rc — a
/// file a desktop app launched from Finder or the Dock never reads, which is
/// exactly how a working install reads as missing.
///
/// Probed after PATH and `~/.local/bin`, so a codeg-managed copy and anything
/// genuinely on PATH still win.
pub fn binary_system_dirs(agent_type: AgentType) -> &'static [&'static str] {
    match agent_type {
        AgentType::OpenCode => &[".opencode/bin"],
        _ => &[],
    }
}

/// Docs anchor explaining the adapter/vendor-CLI split. The zh mirror carries
/// the same explicit `{#acp-adapters}` anchor.
const ACP_ADAPTER_DOCS_URL: &str = "https://docs.codeg.app/guide/supported-agents#acp-adapters";

/// Minimum adapter version whose `_session/steering` honors the
/// `_meta.steering.idleBehavior = "promptRequired"` opt-in — one of the three
/// gates for codeg's NATIVE live-feedback push channel (synthesized into
/// `SessionState.native_steering_available` at initialize; see
/// `connection.rs::init_advertises_steering`).
///
/// `None` means "never steer natively" even when the adapter advertises
/// `_meta.steering.supported`: an adapter that ignores the opt-in falls back
/// to `startedNewTurn` on the turn-end race — a detached turn no host request
/// owns, which codeg's turn-scoped runtime must never trigger. codex-acp
/// ships `_session/steering` but not `promptRequired` — re-verified against
/// the published 1.3.0 tarball (zero hits, same as 1.1.9) — so it stays
/// `None` until a release implements the opt-in — then this is a one-line
/// flip plus tests.
///
/// Honoring the opt-in is necessary but not sufficient: the ACTIVE path must
/// also keep the owning `session/prompt` in flight across the steered work
/// (see the per-arm rationale below).
///
/// The static policy alone is NOT enough — launch prefers a PATH-resolved,
/// user-installed adapter over the pinned npx package (see
/// `commands::acp::acp_get_agent_status_core`, "Launch already prefers the
/// PATH resolution"), so the synthesis must ALSO prove the running binary's
/// `agent_info.version` meets this minimum.
pub fn steering_prompt_required_min_version(agent_type: AgentType) -> Option<&'static str> {
    match agent_type {
        // 0.64.0 (#919) added the `promptRequired` opt-in, but the ACTIVE path
        // stayed unsound until 0.65.0 (#958): steering is delivered at priority
        // `now`, which makes the CLI ABORT the running cycle, and that cycle's
        // ordinary result settled the owning `session/prompt` as a clean
        // `end_turn` while the steered work was still going — the continuation
        // then streamed with no turn in flight (#934, reported and reproduced
        // from codeg). 0.65.0 records a steered turn's results instead of
        // settling on them and settles at the SDK `idle` spanning both cycles,
        // so the floor is the FIRST release carrying that fix, not the one that
        // introduced the opt-in. Every 0.64.x — including 0.64.2, which only
        // reverted an unrelated ExitPlanMode change — still carries the bug and
        // is held to the pull channel by the runtime version gate.
        AgentType::ClaudeCode => Some("0.65.0"),
        _ => None,
    }
}

/// Whether this adapter's goal-control request reaches the agent OUT OF BAND —
/// i.e. it changes the goal through its own channel instead of riding the
/// session's prompt stream.
///
/// This is what decides whether pausing/clearing a goal may ALSO interrupt the
/// turn that is running. Neither adapter's control request stops a turn on its
/// own: codex's `pause` is `thread/goal/set{status:"paused"}` and its `clear`
/// is `thread/goal/clear` — pure app-server metadata that only takes effect at
/// the next idle point, so the agent visibly keeps working for as long as the
/// current turn lasts (which, mid goal loop, is "forever" as far as the user is
/// concerned). Interrupting is the missing half of the button, and it is safe
/// there precisely because the goal RPC already landed before the interrupt.
///
/// claude is the counter-example and the reason this is a policy bit rather
/// than an unconditional behavior: `claude-agent-acp`'s `_session/goal` handler
/// rewrites the request into the text `"/goal clear"` and delivers it as a
/// STEERING message (falling back to a fresh `session/prompt` when idle).
/// Cancelling the turn would kill the very message that carries the clear, so
/// the goal would stay armed — strictly worse than doing nothing. Everything
/// else, custom agents included, fails closed onto `false`: an unknown
/// adapter's control channel is not something to guess at with a destructive
/// action.
pub fn goal_control_is_out_of_band(agent_type: AgentType) -> bool {
    matches!(agent_type, AgentType::Codex)
}

/// Whether this agent's resolved launch recipe runs Cursor's ACP adapter
/// (`cursor-agent … acp`). Custom agents that wrap the same binary as the
/// built-in Cursor entry must advertise the same client capabilities.
pub fn uses_cursor_acp_backend(agent_type: AgentType) -> bool {
    distribution_uses_cursor_acp(&get_agent_meta(agent_type).distribution)
}

fn distribution_uses_cursor_acp(distribution: &AgentDistribution) -> bool {
    match distribution {
        AgentDistribution::Npx { cmd, args, .. } | AgentDistribution::Binary { cmd, args, .. } => {
            launch_spec_uses_cursor_acp(cmd, args)
        }
        AgentDistribution::Uvx {
            cmd,
            args,
            system_cmd,
            ..
        } => {
            launch_spec_uses_cursor_acp(cmd, args)
                || system_cmd.is_some_and(|(c, a)| launch_spec_uses_cursor_acp(c, a))
        }
    }
}

/// True when the resolved executable basename is `cursor-agent` and the
/// process is launched in ACP mode (`acp` argument present).
fn launch_spec_uses_cursor_acp(cmd: &str, args: &[&str]) -> bool {
    let trimmed = cmd.trim();
    let base = std::path::Path::new(trimmed)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(trimmed);
    base.eq_ignore_ascii_case("cursor-agent") && args.contains(&"acp")
}

pub fn get_agent_meta(agent_type: AgentType) -> AcpAgentMeta {
    if let AgentType::Custom(id) = agent_type {
        return crate::acp::custom_registry::get(id)
            .cloned()
            .unwrap_or_else(|| crate::acp::custom_registry::unregistered_meta(id));
    }
    debug_assert_eq!(
        from_registry_id(registry_id_for(agent_type)),
        Some(agent_type)
    );
    match agent_type {
        AgentType::ClaudeCode => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "Claude Code",
            description: "ACP wrapper for Anthropic's Claude",
            // 0.63.0 (claude-agent-sdk 0.3.220) adds the opt-in
            // `clientCapabilities._meta["subagent-transcript"]` capability
            // (#881): when advertised (see `build_client_capabilities`),
            // subagent text/thought chunks stream with update-level
            // `_meta.claudeCode.parentToolUseId` instead of being filtered;
            // codeg routes them into the live Agent capsule. Independent of
            // the capability, every tool_call now carries
            // `_meta.claudeCode.subagent: true` on Agent/Task launches and
            // `_meta.claudeCode.title` (the Bash `description` input) on
            // normal AND eager-permission tool calls. 0.63.0 also fixes
            // phantom `tool_progress` heartbeat entries under never-announced
            // ids (#916), Bash terminal metas keyed off an empty id (#917),
            // and `permission_denied` resolving unannounced tool calls
            // (#923). Fast mode's config option now folds the SDK's
            // `fast_mode_disabled_reason` into its description (#921).
            // 0.64.0 carries the SAME claude-agent-sdk (0.3.220) and ACP SDK
            // (1.3.0), so Claude Code's own behavior is unchanged. It adds an
            // opt-in host-owned steering fallback (#919): a `_session/steering`
            // request may carry `_meta.steering.idleBehavior = "promptRequired"`,
            // and when the turn it meant to steer already settled the adapter
            // returns `{outcome:"promptRequired", reason:"noRunningTurn"}`
            // WITHOUT consuming the content, so the host resubmits it through a
            // normal `session/prompt` it owns. 0.64.0 also marks the
            // per-question
            // free-text "Other" elicitation field with the deliberately
            // un-namespaced `_meta._askUserQuestionCustomAnswer` (#929, omitted
            // from the release notes) — see `question::is_custom_answer_property`.
            // 0.64.1 (#930, likewise absent from its notes) adopts the
            // option-level `_meta.permission = {version, changes[]}` contract
            // codex already speaks, so Claude permission cards now spell out
            // what each button grants; its `lifetime` is what
            // `parsePermissionOptionChanges` reads for the duration, since
            // Claude — unlike codex — never states it in the description.
            // 0.65.0 (#958) completes the steering contract the opt-in started:
            // a steered turn's results now only RECORD their outcome and the
            // turn settles at the SDK `idle` spanning both the interrupted and
            // the steered cycle, so the owning prompt stays in flight until the
            // steered work is actually done. That is the fix for #934, which
            // had forced codeg's native push channel off; it is back on for
            // Claude alone via `steering_prompt_required_min_version` (see
            // `manager::submit_feedback` for the two channels). Its other
            // releases carry nothing else for codeg: 0.64.2 reverted #938's
            // ExitPlanMode `plan_update` experiment outright, and 0.65.0's
            // remaining commits are devDependency bumps — the runtime deps and
            // the Node floor still match 0.64.0's.
            // 0.66.0 (#964) introduces the provider-neutral goal extension:
            // initialize advertises `_meta.goal = {version: 1, controlMethod:
            // "_session/goal", actions}` (claude offers ["set", "clear"]) and
            // goal state arrives as `session_info_update._meta.goal` snapshots
            // — {objective, status (active|paused|blocked|limited|complete),
            // iterations?, lastReason?, createdAt/updatedAt (Unix ms),
            // tokenBudget?, tokensUsed?, timeUsedSeconds?, controlMethod},
            // `goal: null` clears. codeg picks the goal channel per connection
            // at initialize (advertised ⇒ neutral only; see the
            // SessionInfoUpdate arm in connection.rs), the same selection that
            // keeps codex goals alive after its silent 1.2.0 switch. #967
            // fixes goal publish/replace reliability.
            // 0.67.0 bumps claude-agent-sdk 0.3.220→0.3.232 and joins the
            // JetBrains AIR extension codex 1.2.0 speaks (#979; record shape
            // finalized in 0.68.0/#992): typed session failures ride
            // `session_info_update._meta.jetbrains.air.sessionFailure` as
            // {id, revision (per-id from 1), category (connection|access|
            // limit|request|service|unknown), severity (warning|error), title,
            // details?, actions (subset of retry|login|new_session)} — upsert
            // records ONLY, no resolve/tombstone wire; publication is STRICTLY
            // gated on the client advertising
            // `clientCapabilities._meta.jetbrains.air = {version >= 1,
            // capabilities: ["sessionFailure"]}`. codeg advertises it
            // (`build_client_capabilities`) and projects the records into the
            // session-failure banner (`AcpEvent::SessionFailure`); on
            // session/load the adapter re-publishes still-active failures
            // (deliberate; id+revision merging absorbs it). A model fallback
            // (`model_refusal_fallback`)
            // publishes an AIR "advisory" record behind the same gate (#990).
            // Skill tool calls now carry `_meta.claudeCode.skill` plus
            // `skillPath` when a SKILL.md is located (#986) — input for a
            // future dedicated card. Task plans survive across prompts
            // (#974), file-preparing tool calls get a pending title (#978),
            // and the default model option description names the resolved
            // model (#982) — all through existing generic render paths.
            // Compaction remains plain text ("Compacting...") with NO
            // `contextCompaction` meta, so the compaction card stays a
            // codex/grok surface. 0.68.0 (#992) only realigns the failure
            // record (categories narrowed to the six above, actions to the
            // three above). The steering `promptRequired` path is intact
            // across 0.66–0.68 (tarball-verified), so the 0.65.0 floor keeps
            // holding, and `engines.node` stays ">=22".
            // 0.69.0 adds exactly ONE thing (tarball-diffed: the only new
            // string literals in `acp-agent.js` are "collecting",
            // "notReported", "providerError", plus the new
            // `dist/file-change-audit.js`) — the AIR `agentFileChangeReport`
            // capability, shipped in lockstep with codex-acp 1.4.0. It is
            // OFF unless the client asks for it twice, and codeg deliberately
            // asks for neither; see `build_client_capabilities` in
            // connection.rs for the reasoning. The only ambient change is that
            // `airSessionFailureCapabilityMeta` became variadic so the agent
            // can advertise `["sessionFailure", "agentFileChangeReport"]` — an
            // ADDITIVE element in an array codeg only ever membership-tests,
            // so the session-failure gate is unaffected.
            //
            // 0.70.0–0.73.0 is a large release (the package grows 692K → 1.1M
            // and gains twelve modules), but the `initialize` response barely
            // moves: a function-body diff shows ONLY
            // `sessionCapabilities.subagents: {}` and two new AIR capability
            // names. `sessionCapabilities.fork` was already there in 0.69.0, so
            // `supports_fork` has been on for Claude all along. Wire-visible
            // changes, in the order they matter to codeg:
            //
            // (a) The permission layer was rebuilt into `dist/permissions/**`
            // and option-level `_meta.permission.changes[]` is GONE — the whole
            // subtree contains exactly ONE `_meta`, the REQUEST-level
            // `{version: 1, title, description?}` that `presentation.js` emits
            // (`description` is `Reason: <decisionReason>`). This is the same
            // move codex made in 1.7.0, so `hoist_request_permission_meta` in
            // connection.rs already carries it onto the card — and it is now
            // the ONLY source of a Claude permission heading, because
            // `buildClaudePermissionPresentation` builds its tool call from
            // `toolInfoFromToolUse`, which returns `{title, kind, content}` and
            // no `_meta.claudeCode` at all. What is genuinely lost is the
            // per-option scope chip (`lifetime.scope`), and that is ACCEPTED:
            // 0.73.0 writes the grant AND its duration into the option NAME
            // instead ("Yes, and always allow access to <paths> from this
            // project", "Yes, during this session", "Yes, and don't ask again
            // for <prefix> commands"), which the button already renders. The
            // option IDs were renamed too (`allow-once`, `allow-with-updates`,
            // `allow-skill-exact`, `allow-skill-prefix`, `exit-plan-*`,
            // `reject`) — inert, codeg only echoes the selected id back.
            // `parsePermissionOptionChanges` is NOT dead code: `supports_custom_version()`
            // is true for npx, so a user pinned to 0.64.1–0.72.0 still gets
            // `changes[]`.
            //
            // (b) `session-titles.js`: Claude Code's own auto-title generation
            // never runs under the Agent SDK (the latch that arms it is pre-set
            // on the headless path), so `SDKSessionInfo.summary` degraded to the
            // raw first prompt. 0.73.0 asks the CLI for a real title via the
            // `generate_session_title` control request and publishes it as
            // `session_info_update.title` — the channel `acp::session_title`
            // already consumes. It generates at most ONCE per session and adopts
            // `info.customTitle` (a user `/rename` or an earlier generated title)
            // without re-titling, so codeg needs no extra guard.
            //
            // (c) `fork-session.js` reads the SAME AIR fork point codex 1.8.0
            // does — `_meta.jetbrains.air.fork = {version: 1, messageId}`, with
            // the same `:segment:\d+$` suffix stripped before matching — and
            // falls back to a tail fork when the block is absent. It ignores
            // `messageFingerprint`/`messageOccurrence` (codex reads those), so
            // sending all three is forward-compatible. The `messageId` to send
            // is the top-level one `applyMessageId` stamps on message/thought
            // chunks (present since ≤0.69.0; typed as the stable
            // `ContentChunk::message_id` in the 1.x schema). codeg derives it
            // from the parsed transcript rather than the live chunks — see
            // `acp::fork::ForkPoint`.
            //
            // (d) The AIR capability array grew to `["sessionFailure",
            // "agentFileChangeReport", "nativeSubagentSessions", "asyncTasks"]`
            // (0.76.0 appends a fifth, "recommendedValue" — see (k)). codeg
            // adopted `asyncTasks` and deliberately leaves the other two out, so
            // `native-subagents.js` and `file-change-audit.js` stay dark. See
            // `build_client_capabilities` for why each is in or out.
            //
            // Also new and reachable through existing generic paths:
            // `exit-plan.js` + `clear-context-coordinator.js` give ExitPlanMode
            // its own option set, including three "accept the plan AND clear
            // context" variants (`exit-plan-clear-{auto,bypass,accept-edits}`,
            // named `Yes, clear context (N% used) and …`) that swap Claude's
            // private conversation while the ACP turn stays open;
            // `tool-result-meta.js` parses the SDK's `tool_result_meta` sidecar
            // (`nonExecutionKind` + `userFeedback`) but only feeds exit-plan's
            // internal reconciliation. `engines.node` stays ">=22".
            //
            // 0.74.0 is a small, focused release (`diff -rq` against 0.73.0:
            // `acp-agent.js`, `session-failure-extension.js`, one new
            // `hide-claude-auth.js`, and `package.json`). `initialize` does not
            // move at all — same `sessionCapabilities`, same AIR capability
            // array, same `engines.node`, same `@anthropic-ai/claude-agent-sdk`
            // 0.3.257 — so every capability decision above still holds. What
            // DOES change, in the order it matters:
            //
            // (e) BREAKING for AIR clients, and the reason this bump needed
            // code: `auth_required` no longer settles the turn. 0.73.0's
            // `failActiveWithSessionFailure` resolved an AIR client's prompt
            // with a disguised `end_turn` carrying the record on the response
            // `_meta`; 0.74.0 special-cases the kind BEFORE that path and does
            // both halves instead — it publishes ONE session-scoped `access`
            // record (severity `error`, `actions: ["login"]`, title
            // "Sign in to continue using Claude.", the CLI's own
            // "… Please run /login" prose demoted to `details`) on the UPDATE
            // channel, and then REJECTS the prompt with the `authRequired`
            // JSON-RPC error, because ACP defines that rejection as the signal
            // that starts a client's own auth flow. Both halves already have a
            // consumer here — `air_session_failure` renders the strip with its
            // Login button — but the rejection did not: `run_conversation_loop`
            // propagated every prompt error, so a mid-session sign-out would
            // have torn the whole connection down (terminal `Error` →
            // `Disconnected`, conversation row flipped to Cancelled) where
            // 0.73.0 just ended the turn. `run_conversation_loop` now keeps an
            // `ErrorCode::AuthRequired` prompt rejection turn-scoped; see the
            // `Err(e) if e.code == AuthRequired` arm there.
            //
            // (f) Three fixes that land for free. A 401 no longer publishes a
            // "Retrying Claude, attempt N of M" WARNING before the sign-out
            // error (upstream #1072) — that strip used to outlive the refusal
            // with no action to clear it. A record whose `recoveryPolicy` is
            // `auth_status` now also clears (agent-side bookkeeping; nothing
            // goes on the wire) when a real model answers, so an out-of-band
            // sign-in no longer leaves a stale row that makes the adapter
            // dedupe away the NEXT sign-out — and codeg's `login` action is
            // exactly that case, since it opens /settings/agents and the
            // credential is then fixed outside the query process. And
            // `createSession` now discards a query it spawned but never
            // registered, so a failed `session/new` stops leaking a live CLI
            // child.
            //
            // (g) Inert here. `--hide-claude-auth` (new `hide-claude-auth.js`:
            // refuse turns a claude.ai subscription would pay for, plus the
            // sign-out respawn machinery) is argv-gated and `args` below is
            // empty — codeg has no per-agent argv override, and a user who
            // builds a CUSTOM agent around that flag gets `AgentType::Custom`,
            // which is not advertised AIR at all. That also makes the record's
            // new `reason` field unreachable: `CLAUDE_SUBSCRIPTION_NOT_SUPPORTED_REASON`
            // is its only producer, so `parse_session_failure_record`
            // deliberately does not read it. Likewise the hardening of the
            // legacy gateway `authenticate` (an absent payload still succeeds;
            // a PRESENT one must now carry an absolute http(s) `baseUrl`) and
            // the containment of a per-session failure during
            // `providers/set`/`providers/disable` — codeg calls neither method
            // on claude.
            //
            // 0.75.0 + 0.75.1 (four feature commits) are additive: an
            // `initialize` handshake replayed against both 0.74.0 and 0.75.1
            // with codeg's own `clientCapabilities` differs by exactly two
            // things — the version string and a new
            // `agentCapabilities._meta.authStatus: {}`. `sessionCapabilities`,
            // the AIR capability array, `steering`, `goal` and
            // `promptCapabilities` are byte-identical, so every decision above
            // still holds.
            //
            // (h) Context compaction became an ACP tool-call lifecycle
            // (upstream #991) instead of untyped "Compacting…" prose. The frames
            // are provider-neutral — the SAME `_meta.contextCompaction` key
            // codex-acp 1.3.0 introduced: a `tool_call` (title "Compact
            // conversation", kind `think`, `status: in_progress`) followed by a
            // `tool_call_update` carrying `{version: 1, trigger, preTokens,
            // postTokens, durationMs, error?}`. `isContextCompactionMeta`
            // matches on the `_meta` key and is not agent-gated, so
            // `<ContextCompactionCard>` lights up for claude with no wiring —
            // and claude is the FIRST agent to actually populate the token/
            // duration fields (codex sends a bare `{version: 1}`). The SDK's
            // `compact_boundary` also drives a fresh `usage_update {used:
            // post_tokens, size: contextWindowSize}`, so the occupancy bar
            // snaps to the compacted value instead of staying stale. The
            // matching HISTORY card is synthesized in `parsers::claude` from the
            // transcript's own `compact_boundary` record; see the
            // `"compact_boundary"` arm there for the field mapping (the
            // transcript is camelCase where the wire is snake_case, and
            // `trigger: "auto"` maps to `"automatic"` exactly as the adapter's
            // `contextCompactionMetadataFromBoundary` does).
            //
            // (i) `fork-session.js` grew a third resolution level (upstream
            // #1089), which retires the note in (c) that claude "ignores
            // `messageFingerprint`". Resolution is now: live `messageId` map →
            // `getSessionMessages` (the ACTIVE parentUuid chain only) →
            // `resolveFromFullHistory`, which imports the full persisted
            // transcript INCLUDING abandoned branches, retries the id there, and
            // only then falls back to `messageFingerprint` + `messageOccurrence`
            // (both required, or it bails; a single fingerprint match wins
            // regardless of occurrence). The hash semantics are the ones
            // `acp::fork` already computes: `sha256:<hex>` over the concatenated
            // text blocks, occurrence counted along the parentUuid chain
            // including the target. So `acp::fork` now sends all three for
            // claude, which turns a fork point sitting on an abandoned branch
            // from a silent tail-fork into an exact hit. Same release also cuts
            // `session/load` on a forked session from ~20–29s to ~1.9s.
            //
            // (j) `authStatus` (upstream #1080) — the agent pushes its own
            // sign-in identity over `_auth/status_update`, the connection-level
            // notification codex-acp 1.9.0 introduced. codeg registers that
            // handler unconditionally (not per agent), so claude's pushes are
            // already claimed and nothing changes; see `handle_auth_status_update`
            // for what claude adds over codex (a per-prompt probe, so a push can
            // land mid-turn). 0.75.1 additionally drops the automatic
            // `getContextUsage` control requests, and `/usage` output now comes
            // back as Markdown, which the transcript renderer already handles.
            //
            // 0.76.0 + 0.77.0 are sixteen commits, and the bundled SDK moves
            // 0.3.257 → 0.3.270 with it — i.e. the Claude Code CLI behind the
            // adapter goes 2.1.257 → 2.1.270 (`manifest.json` `version`).
            //
            // (k) `recommendedValue` (upstream #1111), the release's headline
            // and a NEW AIR capability codeg now advertises — to claude here,
            // and to codex from 1.11.0, which shipped its own half of the same
            // capability (see the codex entry (a)); 1.10.0's bundle contained
            // zero occurrences of the string, so this was claude-only for
            // exactly one pin. It is opt-in in both directions: the adapter
            // transforms nothing unless the client names it in
            // `clientCapabilities._meta.jetbrains.air.capabilities`, and it
            // re-advertises the same name in its own initialize `_meta`.
            //
            // Captured off a live 0.77.0 over stdio — identical `session/new`,
            // the capability withheld and then sent:
            //
            //   WITHOUT: model  options ["default", "opus[1m]", "sonnet", …]
            //            effort options ["default", "low", "medium", …]
            //            …and `set_config_option(model, "default")` → Ok.
            //   WITH:    model  options ["opus[1m]", "sonnet", …]
            //                   + _meta.jetbrains.air.recommendedValue "opus[1m]"
            //            effort options ["low", "medium", …]
            //                   + _meta.jetbrains.air.recommendedValue "medium"
            //            …and the same set → `Invalid value for config option
            //            model: default`.
            //
            // The ambiguous row is the point. `current_model_id_from_opts` reads
            // the model selector's `current_value`, and that is the model id
            // `record_turn_end` stamps onto every turn codeg journals — on the
            // `default` row it is the literal string `"default"`, which no
            // consumer can resolve to a model. With the capability on, a session
            // still riding the SDK default reports the concrete model instead.
            //
            // The cost, stated: a user with NO effort setting anywhere now gets
            // the recommendation (`medium`) applied to the SDK at session
            // creation and on every model switch, where a legacy client let the
            // SDK resolve automatic effort. Everybody else is unaffected — the
            // adapter's `settingsEffortForModel` reads per-model
            // `modelSettings.effortLevel` first, then the legacy top-level one,
            // and only falls through to the recommendation when both are absent.
            //
            // Stale `"default"` picks in `codeg:selector-prefs` are the
            // migration hazard: the connect-time replay would re-send a value
            // the agent now rejects, on every connect, forever, and the row the
            // user would have to re-pick to overwrite it is the one that went
            // away. `config_option_rejects_value` handles it off the agent's
            // OWN advertised value list rather than off this pin — which
            // matters, because the pin only governs what codeg installs, while
            // `resolve_npx_command` launches whatever `claude-agent-acp` is on
            // PATH.
            //
            // Label normalization needs no opt-in and lands for legacy clients
            // too (same capture): `opus[1m]` renders "Opus 5" instead of "Opus
            // (1M context)" (the context stays in the description), and a custom
            // `haiku` alias pointing at `claude-sonnet-5` renders "Sonnet 5"
            // with "Custom Haiku model (claude-sonnet-5)" beneath it, where
            // 0.75.1 put the raw model id in the NAME.
            //
            // (l) BREAKING (upstream #1112): the main-thread `agent` config
            // option is gone, along with custom-agent discovery. This one is NOT
            // gated on the capability — 0.77.0 answers `set_config_option(agent,
            // …)` with `Unknown config option: agent` no matter what the client
            // advertised (verified on the same live build). codeg never built a
            // picker for it, but the option WAS advertised (and rendered by the
            // generic selector path) whenever the cwd had a custom agent
            // configured, so a user who picked a persona has it saved in
            // `codeg:selector-prefs`.
            //
            // That preference is deliberately left alone. The option is no
            // longer advertised at all, so `config_option_rejects_value` cannot
            // and must not judge it — the generic rule there is that an
            // unadvertised id belongs to the agent — and pruning it on the
            // agent id instead would silently discard a still-working persona
            // for anyone whose PATH still holds a ≤0.76 adapter. The cost of
            // leaving it is one `set_config_option` error log per connect on
            // 0.77.0. ACP subagent sessions and the `Agent`/`Task` tool are
            // untouched — only the main-thread selector went away.
            //
            // (m) `_meta.permission.defaultToNo` (SDK 0.3.268+, forwarded by
            // `presentation.js`): "the ask must not be approvable by a stray
            // keystroke". The adapter already lists the reject options FIRST for
            // such an ask, and codeg renders options in wire order and
            // pre-selects nothing, so the hard half was free. What codeg adds is
            // the emphasis: `PermissionDialog` paints the decline as the primary
            // button and demotes every approve option to an outline, so the one
            // accent-coloured control on a dangerous card is not "Allow". Read
            // under the same `version: 1` gate as the sibling `description`.
            //
            // Its companion `suppressAlwaysAllowRule` needs nothing: it is
            // consumed inside `buildClaudePermissionOptions`, so the
            // always-allow button simply is not offered.
            //
            // (n) `<system-reminder>` blocks are stripped from replayed prompts
            // (upstream #1040) — a codeg-visible fix that arrives for free. The
            // CLI appends them to a user turn to steer the model; live they
            // never reach a client, but `session/load` replayed them verbatim
            // INSIDE the user's own bubble. `parsers::claude` has stripped them
            // from the history path all along (see `STRIP_PATTERNS`), so 0.75.1
            // drew the same turn two different ways depending on which path fed
            // it. Nothing to do here beyond the bump.
            //
            // (o) Inert. Tool calls now carry the standard ACP `name` field
            // (#1128, the tool-call-name RFD) — but the value is the same SDK
            // tool name `_meta.claudeCode.toolName` already carries, which
            // `inferLiveToolName` reads, and upstream explicitly keeps that key
            // populated "for clients that key off it". Schema 1.9 types it
            // (`ToolCall::name`, stable), so reading it no longer needs a raw
            // reader — it would simply be a second source for information codeg
            // already has, and one the other agents fill differently (see the
            // codex entry's (d)). The
            // multi-select custom-answer fix (#1031) lands in `elicitation.ts`,
            // which claude never reaches: codeg advertises
            // `elicitation.form` for Codex and DeepSeek only. The `TaskList`
            // ReDoS fix (#1006) and the `allowDangerouslySkipPermissions: false`
            // host opt-out (#1129) are adapter-internal — codeg WANTS the
            // `bypassPermissions` mode in the catalog, so it deliberately does
            // not send the opt-out.
            //
            // 0.78.0 is four upstream changes and the bundled
            // `@anthropic-ai/claude-agent-sdk` does NOT move (0.3.270 on both
            // sides), so the CLI behind the adapter is the same 2.1.270 0.77.0
            // shipped and `engines.node` stays ">=22". A set diff of the QUOTED
            // STRING LITERALS in the emitted bundle (`dist/**/*.js`; the
            // qualifier matters, see below) adds exactly six — "PostCompact",
            // "compaction_update", "compaction_summary_chunk", "diffStats",
            // plus "invalidOutput" and "timeout", which 0.77.0 already listed in
            // `file-change-audit.d.ts` as `FileChangeReportUnavailableReason`
            // members and used `timeout` for as a plain identifier, but never
            // emitted as a value — and removes seven, all
            // of them the retired file-change audit's vocabulary
            // ("claude_agent_acp", "report_changed_files",
            // "claude-agent-acp-file-change-audit", "anthropic/alwaysLoad",
            // "claude/endTurn", plus the "PreToolUse"/"Stop" hook names it was
            // the only user of). So (p)–(s) below enumerate the entire
            // wire-visible delta. None of it needs code beyond this bump; two of
            // the four invalidate a reason recorded elsewhere, which is why they
            // are written down rather than skipped.
            //
            // (p) `compaction_update` (#1134), the release headline.
            // `clientSupportsCompactionUpdates` gates on
            // `clientCapabilities.session.compaction` being an object — a real
            // typed field, NOT an `_meta` key, so unlike every other opt-in on
            // this list it cannot be smuggled through `ClientCapabilities.meta`:
            // the `agent-client-protocol-schema` 0.11.7 codeg pinned at the
            // time had no `session` field on `ClientCapabilities` at all, and no
            // `CompactionUpdate` / `CompactionSummaryChunk` on `SessionUpdate`
            // (both arrived in schema 1.9 behind `unstable_session_compaction`).
            //
            // ⚠️ THIS ENTRY USED TO CALL THAT "out of reach at this schema pin".
            // It is not, and the correction is worth stating because the same
            // wrong inference was drawn twice more below. The pin limits what
            // the TYPED STRUCTS can say, not what codeg can put on the wire:
            // `session/new` and `session/load` already go out as
            // `UntypedMessage`s, and `air_async_task_delta` already reads three
            // variants this very `SessionUpdate` cannot deserialize. Opting in
            // cost exactly those two established moves — an untyped
            // `initialize` that grafted the capability on, and a raw
            // pre-dispatch reader (`session_compaction_event`). The move to the
            // official `agent-client-protocol` 2.2 runtime (schema 1.9.1) has
            // since made the capability a typed `ClientSessionCapabilities`
            // member, set in `build_client_capabilities`; the reader stays raw
            // by choice (see its doc).
            //
            // The `nativeSubagentSessions` trade does NOT repeat here, which is
            // what makes this one worth taking. True: with the capability on,
            // `ContextCompactionLifecycle` returns before its `tool_call`
            // branch, so the `_meta.contextCompaction` call that
            // `<ContextCompactionCard>` renders from stops being sent. But
            // unlike a subagent capsule, that call carries no information the
            // new frames lack — `compaction_update` repeats the same `_meta`
            // block — so the reader translates it straight back into the legacy
            // shape and the card, the timeline's `"compaction"` render kind and
            // all four history parsers keep working untouched. What it buys on
            // top: the retained summary text (`summary` plus streaming
            // `compaction_summary_chunk`s, which the legacy presentation never
            // carries — `recordSummary` early-returns unless the presentation
            // is `compaction_update`), and real `failed`/`cancelled` states.
            // The summary rides the synthetic call's `raw_output` under a
            // `codeg.compactionSummary` claim and opens behind the divider's
            // "Summary" toggle; history dividers stay summary-less because the
            // transcript already shows it as the continuation turn beneath.
            //
            // (q) The file-change report went native (#1138), and with it the
            // COST half of the "agentFileChangeReport stays out" record in
            // `build_client_capabilities` expires on the claude side too —
            // codex-acp 1.12.0 did the same thing two weeks earlier. The hidden
            // `claude_agent_acp` SDK MCP server, its `report_changed_files`
            // tool, the PreToolUse/Stop hook pair and the whole hidden model
            // continuation are GONE (that is the seven removed literals above);
            // `createNativeFileChangeReporter` now answers from Claude Code's
            // own checkpoint store via `query.rewindFiles(promptUuid,
            // { dryRun: true })` under a 2s budget, with no model round-trip.
            //
            // It stays out, and this release strengthens the reason that
            // actually mattered rather than weakening it: `declaredComplete` is
            // now hard-coded `false`, upstream's own comment being that
            // checkpoints "cover Claude file tools, but not every mutation
            // source (notably Bash and most subagents)" — the same widening
            // codex's hard-coded `uncertainty` string made. Two costs are also
            // NEW here and did not exist under the audit: the adapter flips
            // `enableFileCheckpointing: true` on the SDK for any client that
            // negotiates the report, so every turn pays snapshot I/O; and
            // `settleActive` became async specifically to await the bounded
            // preview BEFORE the prompt response settles, which puts up to 2s on
            // the end of every turn — paid on turns that changed no file at all.
            //
            // (r) `diffStats` (#1122) — the twin of the codex-acp 1.12.0 key
            // (see the codex entry), and likewise NOT consumed.
            // `AIR_DIFF_STATS_KEY` is a plain `_meta` key rather than a
            // capability, so it is ungated: every Edit/Write `diff` content
            // block whose `structuredPatch` coordinates, line prefixes and EOF
            // markers all validate now carries
            // `_meta.jetbrains.air.diffStats = {version: 1, added, removed}`.
            //
            // These blocks DO reach the card, which is worth stating precisely
            // because it is easy to get backwards. Claude's opening `tool_call`
            // carries `rawInput` (a deep clone of the SDK tool input), but the
            // `tool_call_update` the PostToolUse hook emits for Edit/Write
            // carries the diff content and NO `rawInput` at all. codeg's update
            // arm reads `raw_input` off THAT frame, finds none, and so runs
            // `synthesize_edit_input_from_diffs`, whose result REPLACES the
            // opening frame's input — so the card's "+N −M" ends up being
            // `estimateChangedLineStats` over the very old/new text these
            // `diffStats` describe.
            //
            // It is still declined, for the same reason as on codex's side. The
            // collapsed count and the expanded body are held to a per-input
            // parity contract by the shared `exceedsLineDiffBudget` gate, and
            // both sides of it re-diff that text here; taking the adapter's
            // numbers for the header while the body stays codeg's own re-diff
            // reintroduces exactly the drift the gate exists to prevent, for a
            // number codeg can already compute exactly. And it would help
            // precisely where it is absent: the per-hunk blocks it marks are far
            // too small to reach the LCS budget, while the whole-file `Write`
            // fallback (`oldText: originalFile`) — the one shape that could — is
            // the branch that deliberately emits no `_meta` at all.
            //
            // Inert as received, which is why nothing had to change: the
            // schema's `Diff` does carry `_meta`, but every consumer drops the
            // content-level block —`synthesize_edit_input_from_diffs` and
            // `serialize_tool_call_content` both ignore `Diff.meta`, live
            // (connection.rs) and on the `session/load` projection
            // (`parsers::acp_native::upsert_tool_call`) alike — and the only
            // generic `jetbrains.air` reader on the consuming side
            // (`toolCallMovedToBackground`) reads CALL-level `_meta` and demands
            // `asyncTasks.backgrounded === true`.
            //
            // One PRE-EXISTING limitation of that synthesis, noted here because
            // this is where the shape is written down and it long predates
            // 0.78.0 (0.77.0's `toolUpdateFromDiffToolResponse` already emitted
            // one block per hunk): a multi-hunk Edit — `replaceAll` across
            // several sites — sends N `Diff` blocks that all carry the SAME
            // path, and the multi-diff arm of `synthesize_edit_input_from_diffs`
            // builds a `changes` map KEYED BY PATH, so the hunks overwrite each
            // other and only the last survives. The serialized diff text is
            // suppressed on that same branch (`include_diffs` is false once an
            // edit was synthesized), so the earlier hunks are not shown
            // elsewhere either. Out of scope for a pin bump; `diffStats` would
            // not fix it, since the counts collapse with the blocks.
            //
            // (s) Inert, for the same reason (o) gave one release earlier
            // (#1131): a single-select AskUserQuestion no longer lets typed
            // custom text REPLACE the picked option — the pick stays the answer
            // and the text rides beside it as the tool's own
            // `annotations[question].notes` — and the "Other" box is relabelled
            // to say so. It lands in `elicitation.ts`, which claude never
            // reaches, because codeg advertises `elicitation.form` for Codex and
            // DeepSeek only. Recorded because it is the near-twin of codex-acp
            // 1.12.0's `request_user_input` reshape (codex entry (a)): the same
            // "a free-text note must not eat the selection" idea, arriving in
            // the same fortnight, on the one adapter where codeg is not the
            // client that sees it.
            //
            // 0.79.0 is two upstream changes (#1070, #1143) plus the release
            // chore, touching three emitted files — `tools.js`,
            // `permissions/presentation.js`, `acp-agent.js`. The set diff of
            // QUOTED STRING LITERALS over `dist/**/*.js` that (p)–(s) leaned on
            // adds and removes NOTHING here: `"PowerShell"` was already in the
            // bundle (0.78.0 read it in `buildClaudePermissionPresentation`
            // alone), so the whole wire-visible delta is control flow and the
            // literal diff cannot see it. `@anthropic-ai/claude-agent-sdk` moves
            // 0.3.270 → 0.3.274, i.e. CLI 2.1.270 → 2.1.274 (`manifest.json`);
            // `engines.node` stays ">=22".
            //
            // (t) **A shell approval's heading is now the COMMAND, not the
            // model's summary** (#1070, upstream #1068) — the one delta in this
            // release that costs codeg code. Through 0.78.0
            // `buildClaudePermissionPresentation` gave a `Bash`/`PowerShell`
            // request `shellTitle = compactText(input.description) ?? toolName`
            // and used it for BOTH the presentation's `toolCall.title` and its
            // `_meta.permission.title`. 0.79.0 drops `shellTitle`: the title is
            // `info.title` (i.e. `input.command`), and for those two tools it is
            // no longer passed through `humanText` at all — upstream's stated
            // reason being that "shell titles are executable input", so
            // whitespace compaction would move quoting and comment boundaries
            // and a length cap could hide what runs.
            //
            // One half of that is pure gain here. `ensureToolCallEmitted` emits
            // the presentation's `toolCall`, and when the command actually runs
            // `toolCallNotification` refines the SAME id from
            // `toolInfoFromToolUse` — the command. Through 0.78.0 those two
            // disagreed, so an approved Bash card silently renamed itself from
            // the summary to the command the moment it started. They are now the
            // same string.
            //
            // The other half is a regression codeg has to absorb, and it lands
            // exactly where the client was most careful. `_meta.permission.title`
            // is now byte-identical to `toolCall.title` AND to the command
            // codeg renders in the card's own block; `parsePermissionToolCall`
            // prefers that meta title over the title precisely BECAUSE the title
            // used to be the command. So the heading turns into a second copy of
            // the command block, and the model's one-line label leaves the card
            // altogether: with no `terminal_output` capability advertised (see
            // `build_client_capabilities`) the adapter still puts
            // `input.description` in `toolCall.content`, but the dialog shows
            // `contentText` only when NO structured view exists, and a command
            // card always has one. The fix is in `permission-request.ts`, keyed
            // on the shape rather than on a version: a meta heading equal to the
            // command being displayed is not a heading, so it yields to
            // `rawInput.description` — the same field 0.78.0's `shellTitle` read.
            //
            // (u) **PowerShell joins Bash everywhere else** (same PR). On
            // Windows without Git Bash the CLI's shell tool IS `PowerShell` —
            // SDK 0.3.274 spells the failure mode out in
            // `SDKStartupFailureReason.shell_tool_missing` ("Git Bash is
            // missing, and PowerShell is missing or turned off by
            // CLAUDE_CODE_USE_POWERSHELL_TOOL"). Until now it fell through
            // `toolInfoFromToolUse`'s default arm to `{title: "PowerShell",
            // kind: "other", content: []}`, so a Windows user's every shell call
            // arrived with no command on it. It now shares Bash's arm in all
            // four places: `toolInfoFromToolUse` (`title` = the command, `kind:
            // "execute"`, the description as `content`), `claudeCodeMetaFromToolUse`
            // (`_meta.claudeCode.title` = the description), the terminal
            // `_meta` on the opening frame, and the error-result arm that yields
            // to the terminal channel. The terminal half is gated on the client
            // `_meta.terminal_output` capability, which codeg does not advertise,
            // so it stays inert and the description keeps riding `content`.
            //
            // codeg only half-knew the name, and the halves it knew were the
            // cheap ones. `getToolIcon` and `classifyToolKind` both carried a
            // `powershell` arm (added for pi, which swaps the same name in on
            // Windows), but `normalizeToolName` did not — so every dispatch
            // keyed on the NORMALIZED name (`isCommandTool`, `deriveToolTitle`,
            // `StructuredToolInput`) missed it, and the card rendered a terminal
            // icon over a raw-JSON dump with no command line and no terminal
            // body. One alias entry in `tool-call-normalization.ts` settles live
            // claude, `parsers::claude` history (the CLI's JSONL names the tool
            // `PowerShell` verbatim, so this was broken there independently of
            // any adapter version) and pi at once.
            //
            // (v) Two things that arrive free and need no code.
            //
            // `#1143` also carries "hold through placeholder task results": CLI
            // 2.1.274+ answers background-task completions that were already
            // QUEUED with one model call, so every queued notification still
            // gets a result but all except the last are placeholders
            // (`num_turns: 0`, empty text) emitted BEFORE the shared followup
            // runs. Settling the deferred turn on one of those would release
            // `session/prompt` with the promised text still ahead — the
            // out-of-turn delivery class upstream fixed in #864–#866 — so the
            // hold now waits for `num_turns > 0`. codeg advertises `asyncTasks`
            // and runs claude background shells/workflows/monitors through it,
            // so this is a fix codeg gets by bumping.
            //
            // `_meta.claudeCode.mcpServer` (SDK 0.3.274's `McpServerProvenance`,
            // `{name, source}`) is NOT consumed. It answers "which server serves
            // this `mcp__*` tool, and was it registered in-process by the host
            // (`source: "sdk"`) or configured"; codeg injects codeg-mcp over
            // stdio, which is a configured source and never reads `sdk`, and the
            // only trust question codeg asks of an MCP tool call — is this one of
            // the companions I minted? — it already answers from the tool name
            // it chose itself. What DOES change without asking is its sibling:
            // the block is now emitted when `mcpServer` is present even with no
            // `parentToolUseId`, so `_meta.claudeCode.toolName` reaches a
            // top-level MCP tool's PERMISSION frame for the first time. That is
            // the signal `inferLiveToolName` resolves the codeg-mcp companion
            // cards on, so a pending MCP approval now shows the right card
            // instead of flipping to it once the call runs and the streamed
            // frame (which always carried `toolName`) refines it.
            //
            // 0.80.0 + 0.81.0 are four upstream changes (#1150, #1147, #1154,
            // #1155) plus an SDK bump, and `@agentclientprotocol/sdk` moves
            // 1.4.0 → 1.5.0 on both adapters in lockstep. The bundled
            // `@anthropic-ai/claude-agent-sdk` goes 0.3.274 → 0.3.280, i.e. CLI
            // 2.1.274 → **2.1.280** (`manifest.json`); `engines.node` stays
            // ">=22". Three of the four need nothing here; the fourth is the
            // only item in this whole bump that costs codeg code, and it costs
            // it in the HISTORY parser rather than on the wire.
            //
            // (w) **The subagent hand-back frame** (CLI-side, arrives with the
            // SDK bump — `CLAUDE_CODE_HANDBACK_PROVENANCE`, default on, CLI
            // 2.1.277+). The CLI now prefixes a subagent's report inside the raw
            // `Agent`/`Task` tool_result with a ~470-char model-directed
            // provenance paragraph and indents every line of the report two
            // spaces. 0.81.0's `tools.ts` unwraps it (`unwrapHandbackFrame`)
            // before the report reaches a client, so the LIVE path is clean by
            // bumping — but codeg also renders `Agent`/`Task` results from the
            // CLI's own JSONL (`parsers::claude::extract_tool_result_text` takes
            // the tool_result text; `toolUseResult` is only mined for
            // `structuredPatch` and agent stats), and there the frame is still
            // sitting on the record. Without a matching unwrap every subagent
            // card in history opens with the paragraph and shows the report
            // indented underneath. `parsers::claude` now carries the same
            // verbatim-anchored unwrap, with the header copied byte-for-byte out
            // of the 2.1.280 binary rather than transcribed from the adapter.
            // Note this is NOT gated on the adapter: a user whose standalone
            // Claude Code CLI reaches 2.1.277 writes the frame into every
            // transcript codeg imports, adapter or no adapter.
            //
            // (x) `terminal_output_delta` (#1150, the twin of codex-acp 1.13.0's
            // #528). A client may now advertise `_meta.terminal_output_delta`
            // instead of `_meta.terminal_output`; the adapter treats EITHER as
            // "this client takes terminal output" and renames the key it emits.
            // codeg advertises neither to claude, deliberately — see
            // `build_client_capabilities`, and (u) above for what the `content`
            // channel is still carrying because of it. Inert.
            //
            // (y) Compaction lifecycles now close on interrupt (#1154). A
            // cancelled or errored turn calls `ContextCompactionLifecycle
            // ::interrupt()`, which settles the entity and refuses the late,
            // uncorrelated hooks the abandoned work keeps emitting until a new
            // turn's dispatch calls `resume()`. codeg renders compaction from
            // the legacy `_meta.contextCompaction` tool call (the
            // the `compaction_update` presentation too, see (p)),
            // and that call is exactly what used to be left `in_progress`
            // forever when a `/compact` was interrupted. A free fix.
            //
            // (z) **A resumed session's first result no longer charges the whole
            // pre-resume history to one turn** (#1147, SDK 0.3.277+). The CLI
            // continues `result.modelUsage`'s running total from the totals the
            // transcript saved, so the first reading after a resume has no
            // predecessor to subtract from; `modelUsageIncrement` used to treat
            // that as "the running total restarted" and take the reading itself
            // as the increment. `lastModelUsageReading` is now `undefined` on a
            // resumed session and the first result's rows come from its own
            // per-turn `usage` instead. This lands straight in codeg's
            // `_meta.quota.model_usage` consumer — the per-model rows on the
            // first turn after a resume were inflated by the entire prior
            // session. Nothing to do beyond the bump.
            //
            // (aa) Session Notices (#1155), the release headline, and taken —
            // by the same two moves as `compaction_update` in (p), which see
            // for why the "out of reach at this schema pin" reading this entry
            // originally carried was wrong. `clientSupportsNotices` gates on
            // `clientCapabilities.session.notices` being an object, so
            // `build_client_capabilities` advertises it (grafted onto an untyped
            // `initialize` until schema 1.9.1 made it a typed member) and
            // `session_notice` reads the variant ahead of the typed pipeline.
            // Probed live over stdio against 0.81.0:
            // the handshake is accepted and the `initialize` RESPONSE is
            // byte-identical to the same run with the block withheld.
            //
            // Advertising is not a pure win, and both halves of the trade are
            // paid for rather than absorbed:
            //
            // * It takes over the AIR lane. The model-fallback advisory is
            //   `if (!supportsNotices && supportsAirSessionFailures(...))`, so
            //   turning notices on stops feeding codeg's existing
            //   `SessionFailure` banner; codex-acp says the same in its
            //   readme-dev ("notices take precedence over AIR advisory
            //   records"). ACCEPTED: advisories become notifications (a
            //   toast, kept in the alert list — `lib/session-notices.ts`);
            //   mirroring them into the banner as well showed every one
            //   twice. Only
            //   ADVISORY-class records move — the real failures that carry
            //   `retry`/`login` actions never went through this lane (the
            //   extension doc: a `warning` "may still succeed and normally has
            //   no actions"), so no button is lost.
            // * It DROPS `informational` frames at `level === "info"` outright
            //   (`if (message.level === "info") break;`). Those are plain
            //   transcript text today. ACCEPTED: upstream's reason is that
            //   they only show in Claude Code's own transcript mode, and
            //   `warning`, `notice` and `suggestion` all still arrive.
            //   Everything else that becomes a notice — model fallback,
            //   Auto-mode fallback, Fast mode turned off, hook block reasons,
            //   "Task stopped by user" — is currently a `**bold label:** …`
            //   agent message, which is the presentation worth replacing.
            //
            // 0.81.1 is fourteen upstream fixes (#968, #1032, #1035, #1055,
            // #1097, #1103, #1104, #1132, #1146, #1161, #1163, #1164, #1165,
            // #1166) and moves NO dependency: `@anthropic-ai/claude-agent-sdk`
            // stays 0.3.280 (so the CLI is still 2.1.280), the ACP SDK stays
            // 1.5.0, `engines.node` stays ">=22", and the `initialize` response
            // to codeg's handshake matches 0.81.0's field for field apart from
            // the version (both probed live over stdio). Two items cost
            // codeg code, (bb) and (cc). The rest arrive free or are inert, and
            // they are written down because three of them settle something
            // codeg reported upstream or already works around.
            //
            // (bb) **File-tool argument aliases** (#1161). CLI 2.1.280 accepts
            // `path` for Write's `file_path` and `file_text` / `file_content`
            // for its `content`, and renames them for itself (`coerceInput`)
            // — but only on the copy it executes. The streamed `tool_use`
            // block, and with it `rawInput` and the JSONL, keeps the model's
            // spelling. The adapter fixed only its OWN title, diff and
            // locations (`normalizeWriteInput`); `rawInput` is still the raw
            // clone, and every codeg card reads `rawInput`, so an aliased
            // Write rendered with no path and no body. Edit has carried the
            // same kind of renames for longer — `path`, `old_str`, `new_str`,
            // `replace_name`, all already in the 2.1.274 binary — and the
            // adapter has never handled those at all.
            //
            // `parsers::claude::canonical_file_tool_input` applies the CLI's
            // renames for both tools (read out of the 2.1.280 binary, not the
            // adapter) on the history path — `extract_assistant_content` and
            // subagent transcripts — and live, in `tool_call_raw_input_text`,
            // keyed on `_meta.claudeCode.toolName`. A permission request needs
            // nothing: the CLI parses, and so coerces, the input before
            // `canUseTool` sees it. Like (w), this is not gated on the adapter:
            // any 2.1.280 CLI writes these spellings into the transcripts codeg
            // reads. On success the CLI also appends a model-directed note to
            // the Write result ("Note: Write's parameters are named `file_path`
            // and `content`. …"); it is short and true, and stays visible.
            //
            // (cc) **`permissions.disableBypassPermissionsMode` is honoured**
            // (#1165). `allowBypass` now also requires that no settings tier,
            // project included, sets it to "disable" — the CLI refuses the mode
            // then too — and that one value drives the mode catalog, the SDK's
            // `allowDangerouslySkipPermissions` and the spawn-time mode clamp.
            // Measured live: with the setting in the cwd's
            // `.claude/settings.json`, `session/new` lists default /
            // acceptEdits / plan / auto only, and `session/set_mode
            // bypassPermissions` fails with `Mode bypassPermissions is not
            // available in this session`; the control run without it lists
            // and accepts the mode.
            //
            // The composer already falls back to the agent's current mode for
            // a pick the agent no longer offers (`selectedModeId`), and a saved
            // `mode` CONFIG value was already screened by
            // `config_option_rejects_value` — but a saved `preferred_mode_id`
            // was replayed blind, i.e. one failing `set_mode` on every connect,
            // for good. `session_modes_reject_id` screens it off the session's
            // own mode list, the same way.
            //
            // (dd) Plan approval: two of the three defects codeg reported as
            // #1077 are fixed, and the third is not. #1163 — an allowed
            // ExitPlanMode now publishes the mode it leaves the session in, as
            // a `current_mode_update` plus a `mode` `config_option_update`, and
            // publishes it AFTER `applyPermissionFallback`, so an Auto that
            // fell back to acceptEdits reads as acceptEdits. Through 0.81.0
            // only the clear-context options did, and the composer kept
            // showing Plan while the session ran in Auto. Both frames land on
            // paths codeg already has; claude's composer is driven by its
            // `mode` config option, which is not re-asserted at send time, so
            // the published mode holds for the rest of the connection. #1164 —
            // bypass is offered NEXT TO Auto instead of being dead code behind
            // it: Auto leads unless the session was in bypass before it
            // entered plan (`prePlanMode`), and the clear-context row takes
            // the same lead. The dialog renders options generically, in wire
            // order, so the extra row needs nothing. Still open: clear-context
            // still gives the Claude-side session a fresh uuid
            // (`options.sessionId = publicSessionId ? randomUUID() :
            // sessionId`), so a later `session/load` of the public id is
            // silently truncated at the plan. codeg still does not work
            // around it.
            //
            // (ee) A steered turn settles on the result that answers the steer
            // (#1166). codeg steers claude natively
            // (`steering_prompt_required_min_version`), and through 0.81.0 a
            // steered turn settled only at an SDK `idle` after the steer's
            // echo — so a steer the CLI never replayed, or an idle swallowed by
            // the owed-idle debt of an aborted autonomous follow-up, left
            // `session/prompt` parked until cancel or the next prompt (#1114).
            // A result whose `user_message_uuids` names the steer now settles
            // it, and the idle stays as the fallback. A free fix to exactly
            // the turn boundary codeg's in-flight tracking keys on.
            //
            // (ff) Usage. #1132: the CLI's synthetic frames (spend limit,
            // sign-in prompt, local command output — `model: "<synthetic>"`,
            // all-zero usage) no longer overwrite the last real context
            // measurement, and a turn with no real frame sends no
            // `usage_update` at all; that used to drop the context ring to
            // zero right as a quota ran out. `composer-context-usage.tsx`
            // keeps reading a live `used: 0` as "no data" (an older adapter
            // on PATH still sends one), and `parsers::claude` already keeps
            // `<synthetic>` records out of turns and stats
            // (`is_synthetic_assistant`). #1032: every `usage_update` now
            // names the model it measured, as `_meta["_claude/model"]` — the
            // PR text's top-level `model` field did not ship, since ACP's
            // `usage_update` has none. Not consumed: the ring reads only
            // `used` / `size`, and per-model token attribution comes from the
            // transcript's own `message.model`, never from the live stream.
            //
            // (gg) Inert: a warm `session/load` / `session/resume` now rebuilds
            // the query whenever ANY session-defining parameter changed
            // (#968, #1097) — additionalDirectories, `_meta.additionalRoots` /
            // `systemPrompt` / `disableBuiltInTools`,
            // `_meta.claudeCode.emitRawSDKMessages` and every process-level
            // `_meta.claudeCode.options` key, skills normalized as a set — not
            // just cwd and MCP servers. codeg sends the same `_meta`
            // (`emitRawSDKMessages: true`, nothing else) on new, load and
            // resume, and the resume that follows a fork creates its session
            // cold (`unstable_forkSession` never enters the adapter's session
            // map, so there is no fingerprint to compare), so no codeg flow
            // rebuilds a query it did not rebuild before.
            //
            // (hh) The rest need nothing. #1035: a marker-only custom slash-
            // skill prompt (`<command-name>/skill</command-name>` plus
            // `<command-args>`) now replays over `session/load` as `/skill
            // args` instead of vanishing — what
            // `parsers::claude::slash_command_display` has always shown on the
            // history path, so the two paths now agree. #1055 tags the
            // informational fallback line with `_meta.claudeCode.kind =
            // "informational"`, which only a client WITHOUT the notices
            // capability ever receives; codeg advertises it (see (aa)). #1103:
            // a successful result that merely MENTIONS `Please run /login` no
            // longer fails the turn as `auth_required`, nor rolls a goal back.
            // #1104 touches only `providers/set`, which codeg never sends.
            // #1146: an unreadable managed-policy tier no longer kills the
            // adapter before it answers `initialize`.
            distribution: AgentDistribution::Npx {
                version: "0.81.1",
                package: "@agentclientprotocol/claude-agent-acp@0.81.1",
                cmd: "claude-agent-acp",
                args: &[],
                env: &[],
                node_required: Some("22.0.0"),
            },
        },
        AgentType::Codex => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "Codex CLI",
            description: "ACP adapter for OpenAI's coding assistant",
            // codex-acp moved from zed-industries (Rust binary) to the
            // agentclientprotocol org (TypeScript rewrite, npx-distributed).
            // 1.1.8 depends on `@openai/codex` ^0.145.0 and drives `codex
            // app-server`; since 1.0.1 it also resolves the resumed
            // `model_provider` from `~/.codex/config.toml` (#224), so codeg no
            // longer injects `MODEL_PROVIDER` to keep resumed sessions on the
            // custom provider. 1.1.0 (#263) reports `/goal` transitions as a
            // structured `session_info_update` (`_meta.codex.goal`) rather than
            // live agent text — see `crate::acp::codex_goal`. 1.1.3+ adds three
            // new live signals codeg handles in `connection::emit_conversation_update`:
            // `subAgentActivity` tool calls (#304, suppressed via
            // `is_codex_subagent_activity` — redundant with the collab capsule),
            // retryable turn errors (#289, `_meta.codex.error` → a transient
            // retry banner via `codex_retry_indicator`), and the
            // context-compaction lifecycle (#288, `_meta.contextCompaction` tool
            // call → a dedicated frontend card). 1.1.x also adds Plan mode: the
            // `collaboration_mode` config option (rendered by the generic
            // config-option path) and native `request_user_input`, delivered as
            // an ACP `elicitation/create` request — codeg advertises
            // `elicitation.form` for Codex and bridges the WHOLE form surface
            // (Plan-mode questions, MCP-server forms, MCP tool-call approvals)
            // in `handle_elicitation_request` / `question::classify_elicitation`.
            // 1.1.5 (#322) also widened codex-acp's MCP config filtering to
            // project `.codex` layers, which is why codeg forces
            // `DISABLE_MCP_CONFIG_FILTERING` (see `apply_codex_env_policy`) so
            // the injected `codeg-mcp` server always survives. 1.1.6 adds
            // steering (#309): `_session/steering` injects a user prompt into
            // the LIVE turn (initialize advertises `_meta.steering.supported`)
            // — codeg keeps codex on the MCP pull channel because 1.1.9 still
            // lacks the `promptRequired` idle opt-in
            // (`steering_prompt_required_min_version` → None; flipping it on
            // is a one-liner once a release implements the opt-in AND its
            // active `injected` path provably keeps the owning prompt pending
            // — claude's 0.64.0 didn't, see #934 in the fn comment). 1.1.7
            // (#326) emits Plan-mode plan
            // contents as a plain `agent_message_chunk`
            // (`_meta.codex.phase = "final_answer"`, no `<proposed_plan>` tags),
            // which the adapter's tag-splitter simply no-ops on — tagged output
            // from older codex still renders as the proposed-plan card. 1.1.8
            // (#351) gates Plan mode behind a review confirmation: when a plan
            // item completes while `collaboration_mode` is `plan`, codex-acp
            // sends a `session/request_permission` marked
            // `_meta.codex = {kind:"plan_review", planItemId}` whose `toolCall`
            // (`plan-review:<itemId>`, kind `switch_mode`, `rawInput.plan`) was
            // NEVER announced as a `tool_call` — codeg seeds it from the request
            // (see `is_codex_plan_review` / `handle_permission_request`) so the
            // follow-up `tool_call_update` has a card to merge into. On approval
            // codex flips the mode back to default (a mid-turn
            // `config_option_update`) and runs the implementation turn inside
            // the SAME `session/prompt`. 1.1.8 (#342) also hangs a structured
            // `_meta.permission = {version, changes[]}` on each permission
            // option, whose `changes[].description` codeg surfaces in the
            // permission card — the contract claude-agent-acp joined in 0.64.1
            // (#930), so that rendering is no longer codex-only. The
            // `clientCapabilities.plan` path (structured
            // `plan_update`s) does NOT apply: codeg does not advertise that
            // capability (see `build_client_capabilities`), so plans keep
            // arriving as `agent_message_chunk`s. That also makes 1.1.9 (#354,
            // which coalesces streamed plan snapshots to one `plan_update`
            // every 150ms and flushes them at item/turn/permission boundaries)
            // inert here — it only runs behind that capability, and its
            // dependency set is byte-identical to 1.1.8's. 1.1.9 still declares
            // no `engines.node`, so the 20.0.0 floor is retained.
            // 1.2.0 rewires two surfaces UNANNOUNCED in its release notes (the
            // #929/#930 pattern again; both tarball-verified): (a) `/goal`
            // transitions move to the provider-neutral
            // `session_info_update._meta.goal` snapshot the claude adapter
            // speaks since 0.66.0 — the legacy `_meta.codex.goal` key is GONE,
            // so codeg's initialize-pinned channel selection (SessionInfoUpdate
            // arm, connection.rs) is what keeps GoalCard alive from this
            // release on. The neutral snapshot collapses usageLimited/
            // budgetLimited into status "limited", adds paused/blocked,
            // carries createdAt/updatedAt in Unix ms and embeds controlMethod
            // "_session/goal" (actions [set, pause, resume, clear]; the old
            // "_codex/session/goal_control" name is kept as an accepted
            // alias). (b) It joins the JetBrains AIR extension (#383; aligned
            // to the final record shape in 1.3.0/#393, same wire as
            // claude-agent-acp 0.67.0 — see that entry): typed session
            // failures gated STRICTLY on the client advertising
            // `clientCapabilities._meta.jetbrains.air`, which codeg does
            // (`build_client_capabilities`). Advertising REPLACES the legacy
            // surfaces on the wire: `_meta.codex.error` (both willRetry
            // branches), warning/config-warning text chunks and dropped
            // deprecation notices all become AIR records (willRetry ⇒
            // severity "warning", terminal ⇒ "error" that deliberately stays
            // active; recovery is implied by turn progress, never published).
            // `codex_retry_indicator` therefore no longer fires on these
            // connections; severity-"warning" records take over the
            // retry-banner role (see the SessionFailure consumer in
            // connection.rs). #377 also normalizes cwd
            // filters for Windows session listing. 1.3.0 (#396) upgrades the
            // compaction lifecycle to the claude-aligned synthetic tool call
            // (kind "think", title "Compact conversation") whose meta is now
            // the versioned object `{contextCompaction: {version: 1}}` — the
            // `contextCompaction: true` boolean marker from 1.1.3 is gone
            // (the schema reserves trigger/preTokens/postTokens/durationMs/
            // error, but 1.3.0 emits none of them). The frontend predicate
            // (`src/lib/context-compaction.ts`) accepts both shapes: the Grok
            // bridge still synthesizes the boolean. #400 restores native
            // provider state after overrides (matters for BYO-provider model
            // switching). New in the bundle and fine on generic cards:
            // synthetic "Guardian Review" tool calls (kind "think") and
            // fuzzyFileSearch ids. Structured plan_update stays inert — its
            // gate is the TOP-LEVEL `clientCapabilities.plan`, which codeg does
            // not advertise. 1.3.0 still ships NO steering `promptRequired`
            // opt-in (tarball grep: zero hits ⇒ the arm below stays None) and
            // still declares no `engines.node`, so the 20.0.0 floor is
            // retained.
            // 1.4.0 is the codex half of the same AIR `agentFileChangeReport`
            // release as claude-agent-acp 0.69.0 and carries nothing else
            // (tarball-diffed: the only new string literals are that feature's
            // plus the `thread/fork` app-server method it is built on;
            // `@openai/codex` stays ^0.147.0, so the CLI and its native
            // team-of-agents surface are unchanged). codex implements the
            // audit by forking the thread (`approvalPolicy: "never"`,
            // `sandbox: "read-only"`, `ephemeral: true`) and running an extra
            // turn on the fork; claude uses a Stop hook plus a hidden
            // continuation. Either way it is an extra model round-trip per
            // prompt, and it is gated on a client advertisement codeg does not
            // make — see `build_client_capabilities` in connection.rs.
            // 1.6.0/1.6.2 (no 1.5.0 or 1.6.1 was published) add NO new modules
            // and nothing wire-visible: `@openai/codex` moves to ^0.148.0,
            // `thread/reverted` + `thread/queue/changed` join the adapter's
            // IGNORED-notification list (so they never reach a client), and
            // `misalignmentPolicyViolation` becomes a second codex error name
            // mapping onto the EXISTING `policy_denied` bucket —
            // `SESSION_FAILURE_POLICY` (the codex→AIR category/actions table)
            // is byte-identical to 1.3.0's, so the six-category vocabulary in
            // `AcpEvent::SessionFailure` is unchanged. The rest is logging.
            // 1.7.0 rebuilds the permission layer (`src/permissions/*`) and
            // redefines the three approval presets. Both are wire-visible:
            //
            // (a) Option-level `_meta.permission.changes[]` is GONE. Codex's
            // reason moves from `toolCall.title` (1.4.0's
            // `params.reason ?? "Permissions Request"`) to REQUEST-level
            // `_meta.permission = {version: 1, title, description?}`, with
            // `{version: 1, description}` on individual options (MCP
            // elicitation approvals only). Titles are now four fixed strings
            // ("Run command?" / "Allow network access?" / "Make edits?" /
            // "Grant permissions?") and the action itself is described through
            // standard ACP fields `parse_permission_tool_call` already reads
            // (`rawInput.command/cwd/url/additionalPermissions`, `locations`,
            // `content`). `handle_permission_request` hoists the request meta
            // onto the card so the reason survives; claude-agent-acp 0.69.0
            // still emits `changes[]`, so that parser stays. Codex's option
            // IDs were also renamed (`allow_for_session`,
            // `accept_execpolicy_amendment`, `apply_network_policy_amendment:N`
            // …) — inert here, codeg only echoes back the selected id — and
            // network deny amendments introduce codex's first `reject_always`
            // option kind, which `handle_permission_request` already maps.
            // `_meta.codex = {kind: "plan_review", planItemId}` is unchanged,
            // so `is_codex_plan_review` still fires.
            //
            // (b) `AgentMode`: the `read-only` preset's sandbox became
            // `workspaceWrite` (it was `readOnly`) and the presets are now
            // separated by a new `approvalsReviewer` axis — `read-only` =
            // "Ask for approval" (reviewer `user`), `agent` = "Approve for me"
            // (reviewer `auto_review`, i.e. a model decides which escalations
            // to show), `agent-full-access` unchanged. Each preset also gains
            // `_meta.kind` (`standard` / `auto_review` / `full_access`) on both
            // `SessionMode` and the `mode` config option. There is NO read-only
            // sandbox preset any more, which is why
            // `codex_initial_agent_mode` (commands/acp.rs) can no longer
            // promise to preserve one — see its doc comment.
            //
            // NOT adopted: native ACP subagent sessions (the draft subagent
            // RFD). The gate is bilateral — `clientCapabilities.subagents: {}`
            // or AIR `nativeSubagentSessions` — and codeg advertises neither,
            // so the lifecycle stays the legacy `subAgentActivity` tool call
            // whose shape (`_meta.codex.subagent = {threadId, path, activity}`)
            // is byte-identical to 1.4.0's. This entry used to call opting in
            // undeliverable because the schema crate could neither advertise
            // the capability nor deserialize `subagent_spawned` /
            // `subagent_state_update`. The v1 schema still carries neither (as
            // of 1.9), but that was never the blocker — a raw pre-dispatch
            // reader gets past it, as the AIR task frames show. What keeps it
            // out is that advertising DELETES the tool call codeg anchors the
            // sub-agent capsule on; `build_client_capabilities` records the
            // whole trade.
            // Likewise still not adopted: `agentFileChangeReport` (unchanged
            // since 1.4.0). `compaction_update` / `compaction_summary_chunk`
            // appear in the bundle but come from the vendored
            // `@agentclientprotocol/sdk` 1.4.0 SCHEMA only — codex-acp keeps
            // emitting the `contextCompaction` synthetic tool call, so the
            // compaction card is untouched. Steering still ships no
            // `promptRequired` opt-in (tarball grep: zero hits ⇒ the arm below
            // stays None), and there is still no `engines.node`, so the 20.0.0
            // floor is retained.
            //
            // 1.8.0 adds two modules (`src/SessionFork.ts`,
            // `src/TitleGenerator.ts`) and REMOVES no string literal, so every
            // surface above still holds. Its `initialize` response differs from
            // 1.7.0's by exactly one field — `sessionCapabilities.fork: {}` —
            // which is what `supports_fork` is derived from, so codex sessions
            // gain the fork entry point on this bump alone.
            //
            // (a) `session/fork` forwards to the app-server `thread/fork`, and
            // honours an AIR fork point in the request `_meta`:
            // `jetbrains.air.fork = {version: 1, messageId,
            // messageFingerprint?: "sha256:<64 hex>", messageOccurrence?: >=1}`.
            // It resolves the id against `thread.turns[].items[].id` (stripping
            // a `:segment:\d+$` suffix first), then falls back to hashing each
            // `agentMessage` text and taking the Nth match. Absent the block it
            // forks at the tail — codeg's current behaviour. claude-agent-acp
            // 0.73.0 reads the same block (messageId only), so ONE client-side
            // implementation covers both.
            //
            // (b) `TitleGenerator` runs an ephemeral thread on `gpt-5.6-luna`
            // with a JSON output schema for a 3–7 word title, then
            // `thread/name/set`; the resulting `thread/name/updated` surfaces as
            // `session_info_update.title`, which `acp::session_title` already
            // consumes. It tracks a three-state `sessionTitleSource`
            // (explicit / fallback / unset) and never overwrites a `/rename`.
            // 1.8.0 also publishes a fallback title (first user message, else
            // the thread preview) on load.
            //
            // (c) Chunks now carry the top-level ACP `messageId`
            // (`createAgentMessageChunk` / `createUserMessageChunk` /
            // `createAgentThoughtChunk`) — the id (a) wants back.
            //
            // (d) `@openai/codex` moves ^0.148 → ^0.152, four minors of core.
            // New app-server literals in the bundle include `writeStdin`,
            // `mcpServer/oauth/login`, `mcpServer/event/stream/notification`,
            // `modelProvider/authRecovery{Started,Completed}`,
            // `reauthenticationRequired`, `project/changed` +
            // `thread/project/updated`, `thread/realtime/item/*` and
            // `autoApprovalReview/strictReviewRequired`. None of them is
            // reachable over ACP today, but the jump is large enough that the
            // 1.7.0 approval-preset table above (sandbox/reviewer per preset)
            // must be re-audited against codex core before anything is derived
            // from it again.
            //
            // Still NOT adopted, unchanged from 1.7.0: native subagent
            // sessions and `agentFileChangeReport` (the AIR array is the same
            // three names). Steering still ships no `promptRequired` opt-in
            // (tarball grep: zero hits), and there is still no `engines.node`,
            // so the 20.0.0 floor is retained.
            //
            // 1.9.0 + 1.10.0 add exactly five wire methods between them (diff of
            // the two bundles' method literals: nothing was REMOVED), of which
            // three are internal app-server calls and two face the client:
            //
            // (a) 1.10.0 — AIR **`asyncTasks`**, and this is the bump's reason.
            // codex's background terminals (a shell the model leaves running,
            // e.g. via the `unified_exec` tool) now publish the same lifecycle
            // claude-agent-acp 0.73.0 does, so `build_client_capabilities` now
            // advertises the capability to Codex as well. It is purely
            // additive: `CodexBackgroundTerminalTasks` is constructed with
            // `enabled = clientSupportsAirCapability(…, "asyncTasks")` and every
            // method short-circuits on `isActive()`, so NOT advertising is
            // byte-identical to 1.8.0. Verified against a live 1.10.0 over
            // stdio, WITH and WITHOUT the advertisement — see the wire trace in
            // `build_client_capabilities`. The control run is the argument for
            // opting in: without it the launching `execute` tool call sits at
            // `in_progress` for the rest of the connection and codeg learns
            // nothing at all about the process behind it.
            //
            // (b) 1.9.0 — **`_auth/status_update`**, a connection-level (NO
            // `sessionId`) notification pushed unconditionally: once just after
            // the `initialize` response, then on each authenticate / logout /
            // session create, and on the app-server's `account/updated`. It is
            // NOT capability-gated in either direction; the agent only
            // ANNOUNCES it via `agentCapabilities._meta.authStatus = {}`. codeg
            // claims and drops it in `handle_auth_status_update` — see there for
            // why a silent drop is not an option.
            //
            // (c) 1.9.0 — `account/rateLimits/read` (internal): `/status` now
            // refreshes the rate limits before printing instead of showing
            // whatever the last turn happened to report, prints an extra
            // "individual spend limit" line, and flips the context line from
            // "N% left" to "N% used". All three are agent TEXT that codeg
            // renders as markdown — the whole repo has no `/status` parser
            // (`lib/codex-command-action.ts`, codeg's only codex-text reader,
            // handles tool-call titles and command-result envelopes, never a
            // slash-command's reply), so this is display-only.
            //
            // (d) 1.9.0 — `sessionState.lastTokenUsage` is reset when a turn
            // actually STARTS rather than when a prompt is received, so a prompt
            // that dies before its turn opens no longer blanks the last usage.
            // codeg reads `usage_update` frames and is unaffected.
            //
            // `thread/backgroundTerminals/{list,terminate}` are the app-server
            // half of (a) and never reach ACP. Steering STILL ships no
            // `promptRequired` opt-in (tarball grep: zero hits ⇒ the arm below
            // stays None), `agentFileChangeReport` / native subagent sessions
            // are still not adopted, and there is still no `engines.node`, so
            // the 20.0.0 floor is retained. `@openai/codex` moves ^0.152 →
            // ^0.153.3 (one minor plus patches).
            //
            // 1.11.0 is a SMALL bump — the whole bundle diff is +148/-63 lines,
            // and the literal-set delta is six strings in (`recommendedValue`,
            // `thread/turns/list`, `paginated`, `legacy`, `desc`, the version)
            // against three out (`GPT`, `Mini`, the version). Four changes reach
            // codeg:
            //
            // (a) AIR **`recommendedValue`** — the reason for the bump, and the
            // only new client-facing surface. `createSessionConfigOptions` now
            // attaches `_meta.jetbrains.air = {version: 1, recommendedValue}` to
            // the `model` option (the model codex marks `isDefault`) and to
            // `reasoning_effort` (the CURRENT model's `defaultReasoningEffort`).
            // The effort one therefore re-derives on a model switch, and it
            // arrives on the `session/set_config_option` RESPONSE rather than as
            // a separate `config_option_update` — measured live: switching
            // `gpt-6-astra` → `gpt-5.6-luna` moved the effort recommendation
            // `low` → `medium` while the model one stayed `gpt-6-astra`.
            // Both paths land in `map_session_config_option`. Bilaterally gated:
            // nothing is attached unless the client lists the string, which
            // `build_client_capabilities` does for BOTH AIR speakers —
            // claude-agent-acp implements the same capability from 0.76.0 (see
            // the claude entry (k), where it also retires the `default` row).
            // See `build_client_capabilities` for the live three-run trace and
            // why it is safe.
            //
            // (b) Model display names are REFORMATTED, and codeg shows them
            // verbatim. `MODEL_NAME_TOKEN_OVERRIDES` (gpt→GPT, mini→Mini,
            // codex→Codex, dashes kept) is replaced by `formatModelDisplayName`,
            // which STRIPS a leading `gpt-`, splits on `[-/]+` and title-cases
            // the rest. Measured on the same account: `GPT-6-Astra` /
            // `GPT-5.6-Sol` / `GPT-5.5` became `6 Astra` / `5.6 Sol` / `5.5`.
            // Non-`gpt-` names are untouched. This is display-only: the option
            // VALUES (`gpt-6-astra`, …) are unchanged, and the model picker
            // groups by value prefix (`lib/model-config-groups.ts`), so nothing
            // regroups — but the composer chip now reads `5.5` rather than
            // `GPT-5.5`, which is a deliberate upstream change, not a codeg bug.
            //
            // (c) `session/load` history now pages through `thread/turns/list`
            // (50/page, `sortDirection: "desc"`, `itemsView: "full"`, with a
            // repeated-cursor guard) whenever the thread reports
            // `historyMode: "paginated"`, instead of one `thread/read
            // {includeTurns: true}`. `session/resume`, `session/fork` and the
            // audit fork additionally pass `excludeTurns: true`, so the turns no
            // longer ride the resume response at all. codeg's codex sessions
            // take the resume path and do not drain a replay (see the "No drain"
            // note in connection.rs), so this is invisible to the timeline and
            // strictly cheaper on long threads.
            //
            // (d) A standalone MCP-elicitation tool call is now FINALIZED. When
            // codex falls back to `session/request_permission` for an
            // elicitation — a message-only form, or a `url` elicitation, both of
            // which codeg hits because it advertises `elicitation.form` but
            // deliberately not `elicitation.url` — 1.10.0 posted a `pending`
            // tool call and never updated it, leaving it pending for the life of
            // the connection. 1.11.0 answers with a `tool_call_update`
            // (`completed`, `rawOutput: {action}`) and the request now carries a
            // `title` ("MCP tool call approval" / "Question from MCP server" /
            // "MCP server requests to open a URL") plus `rawInput.description`.
            // Pure gain for codeg's permission card and tool-call row; no client
            // change needed.
            //
            // Everything else holds: no literal was removed except the two
            // model-name tokens, steering still ships no `promptRequired`
            // (tarball grep: zero hits), `agentFileChangeReport` and native
            // subagent sessions are still not adopted, there is still no
            // `engines.node` (so the 20.0.0 floor stays), and `@openai/codex`
            // moves ^0.153.3 → ^0.153.4 (a patch).
            //
            // 1.12.0 is a MUCH bigger bump than 1.11.0 — +624/-599 bundle lines
            // — and unlike that one it carries a REGRESSION for codeg as well as
            // gains. Five deltas, in descending order of what they cost us:
            //
            // (a) **`request_user_input` was reshaped**, and reading it the old
            // way is not cosmetic. `buildUserInputRequest` swapped its two
            // strings — `title` was the short tab header and `description` the
            // question; now `title` IS the question and `description` the
            // header (emitted only when the model supplied one). codeg reads
            // `description`-first, so the card would have shown a codex ask
            // BACKWARDS: on a single-question ask there is no tab strip, so the
            // only thing on screen would be the header ("Approach") and the
            // question itself would never be displayed. The companion field
            // moved too: `<id>__other` / `_meta.codex.isOtherAnswer` (titled
            // "Other") became `<id>_note` / `_meta.codex.role = "user_note"`
            // (titled "Additional answer or note"), so codeg's companion skip
            // missed it and rendered it as a duplicate question; and an
            // `isOther` question's `oneOf` now ends with an injected "None of
            // the above" pointing at that hidden note field. `question.rs`
            // handles all three.
            //
            // Which reading applies is decided from the RUNNING adapter's
            // `agentInfo.version`, not from the pin: launch prefers a
            // PATH-resolved install, and a custom pinned version is supported
            // (`supports_custom_version`), so an older codex-acp keeps the old
            // reading for every form — not just the ones carrying a companion
            // marker. See `codex_user_input_shape` in connection.rs (pinned once
            // at initialize, exactly like the native-steering version gate) and
            // `CodexUserInputShape` in question.rs for the fallback ladder when
            // an adapter reports no version.
            //
            // WHETHER any of it applies at all is a separate gate, and a
            // stricter one: `ElicitationPeer`, taken from the connection's agent
            // type. codeg advertises `elicitation.form` to DeepSeek too, and
            // either adapter can relay an arbitrary MCP server's form down the
            // same handler, so the parser may not decide "this is codex" from
            // `_meta.codex.*` in the payload — `_meta` is an open namespace and
            // the ACP spec says as much. Off a codex peer, the orientation flip,
            // the companion skip and the injected-option filter are all dead
            // regardless of what the form carries.
            //
            // Two more deltas of the same rework need no client change: every
            // question is now in `required` (codeg's card requires an answer or
            // a decline either way), and the request `message` is the constant
            // "Codex needs your input to continue." instead of the single
            // question's text — which codeg drops on the Questions path and
            // never displayed.
            //
            // (b) The AIR **`agentFileChangeReport`** is no longer a model
            // round-trip. 1.4.0–1.11.0 answered it by forking an ephemeral
            // read-only thread and asking a model to list the changed paths
            // (`AgentFileChangeReportBudget`, a 30s budget, interrupt/unsubscribe
            // plumbing); 1.12.0 deletes all of that and parses the
            // `turn/diff/updated` unified diff instead, buffered per turn behind
            // the same capability gate (`collectTurnDiffs`), 8MiB cap. codeg
            // still does not advertise it, and the cost half of that decision is
            // now moot — but the coverage half got STRONGER, not weaker: the
            // report hard-codes `uncertainty` to "Codex turn diffs may omit
            // same-content renames and changes made outside apply_patch,
            // including shell commands, version-control commands, generators,
            // and child processes", i.e. it is now explicitly narrower than the
            // model audit it replaced, and far narrower than the recursive
            // `notify` watcher codeg already runs. See `build_client_capabilities`.
            //
            // (c) **`diffStats`** — a new AIR key, and the only one here that is
            // NOT capability-gated: `withAirMeta(…, AIR_DIFF_STATS_KEY, …)` is
            // called unconditionally on every add/update/delete file-change
            // `_meta` (`{version: 1, added, removed}`, derived from the real
            // patch hunks; `null` and therefore omitted when the patch does not
            // parse). So it already arrives, and codeg already ignores it —
            // deliberately. The edit card's collapsed "+N −M" and its expanded
            // diff body are held to a hard per-input parity contract
            // (`exceedsLineDiffBudget`, one shared budget across
            // `estimateChangedLineStats` and `generateUnifiedDiff`), and codex
            // ships FULL old/new file text in the ACP `Diff` block, which codeg
            // re-diffs itself. Taking the agent's hunk counts for the header
            // while the body stays codeg's own re-diff is exactly the drift that
            // contract exists to prevent. claude-agent-acp 0.78.0 shipped the
            // same key from the other direction (claude entry (r)) — per
            // structuredPatch hunk rather than per file — and is declined for
            // the same reason.
            //
            // (d) ACP **`tool_call.name`** is now populated: `exec_command` /
            // `write_stdin` for unified-exec command executions (an `agent` or
            // `userShell` source stays unnamed), `view_image`,
            // `request_permissions`, and `<namespace><tool>` for dynamic tool
            // calls — on the live stream, the completion updates, the permission
            // request and the `session/load` function-call replay alike. When
            // this was written the schema crate codeg pinned (0.11.x) dropped
            // the field; schema 1.9 types it as a stable `ToolCall::name`, so
            // reading it no longer takes a raw reader — but it is still not
            // read, because it adds nothing: every surface it names is one
            // codeg already classifies from `kind` + `title` — command
            // executions are `kind: "execute"` with the command as the title,
            // `view_image` is `kind: "read"` with a resource_link, and a dynamic
            // tool call's title already IS the tool name (`name` only adds the
            // namespace prefix, which codeg does not render). MCP tool calls,
            // the one place an exact name would help, get NO `name` at all —
            // they keep `mcp.<server>.<tool>` plus `_meta.is_mcp_tool_call`.
            //
            // (e) `@openai/codex` ^0.153.4 → **^0.154.0**, one minor. The model
            // set is unchanged (the same 11 slugs), but every `ModelInfo` gains
            // `supports_experimental_context`, a STRICT bool — so it joins
            // `BOOL_FIELDS` in `codex_model_catalog.rs`, because a stored
            // override holding a string there would take the whole generated
            // catalog down and make every model vanish. All seven enum variant
            // sets re-probed against the 0.154.0 binary: unchanged. The bundled
            // offline snapshot is regenerated from it (0.153.4's is still
            // ACCEPTED by 0.154.0 — the new field defaults — so this is
            // freshness, not a gate).
            //
            // Everything else holds: steering still ships no `promptRequired`
            // (tarball grep: zero hits), native subagent sessions are still not
            // adopted, `recommendedValue` is untouched, and there is still no
            // `engines.node`, so the 20.0.0 floor stays. One config delta needs
            // no action: `forceGitRootTurnDiffPaths` now pins
            // `features.cwd_relative_turn_diffs = false` in the merged config so
            // turn-diff paths are git-root relative — codeg writes no such key
            // (repo grep: zero hits) and reads no turn diff.
            //
            // 1.13.0 is six upstream changes (#515, #523, #525, #528, #531,
            // #532) and ships the SAME two capabilities claude-agent-acp 0.81.0
            // did, in the same week and behind the same two typed client
            // capabilities — `@agentclientprotocol/sdk` moves 1.4.0 → 1.5.0 on
            // both. `engines` is still absent, so the 20.0.0 floor stays.
            //
            // (f) Session Notices (#532) and ACP session compaction (#515) are
            // both TAKEN, the way the claude entry's (aa) and (p) describe —
            // advertised through `clientCapabilities.session.notices` /
            // `.compaction` (typed `ClientSessionCapabilities` members since
            // schema 1.9; grafted onto an untyped `initialize` before that) and
            // read back before the typed pipeline. Probed live over stdio
            // against 1.13.0 alongside claude: handshake accepted, `initialize`
            // response byte-identical to the withheld run.
            //
            // What codex adds to the claude-side note is the LIST of what
            // moves: with notices on, config warnings, deprecation notices,
            // plain warnings, model rerouting and the legacy `thread/compacted`
            // advisory all leave the channels codeg reads today for `notice`
            // updates. Two of those are a straight UPGRADE rather than a
            // trade, because their current channel is not a surface at all:
            // `modelRerouted` is a THOUGHT chunk today (it pollutes reasoning
            // with "Model rerouted from X to Y"), and a deprecation notice
            // reaches a client only through AIR. The rest become toasts, same
            // as claude's — except codex's post-compaction "multiple
            // compactions" warning, which the frontend drops because the
            // compaction card already covers it.
            //
            // Compaction is where codex gains most. Its legacy call carries
            // none of the reserved fields (the card's full label was only ever
            // reachable on claude), it cannot express a failed or interrupted
            // compaction at all, and `thread/compacted` "cannot distinguish
            // multiple compactions within one turn" (upstream's own words).
            // `compaction_update` fixes all three and adds history-position
            // replay — and `session_compaction_event` translates it back into
            // the legacy `_meta.contextCompaction` shape, so none of that costs
            // the card a line.
            //
            // (g) **codeg now reads codex's terminal output channel** (#528 is
            // what made this legible, but the channel itself is older). codex
            // has always had pi's #519 shape and codeg never noticed, because
            // codex ALSO repeats the output as `rawOutput` at the end:
            // `createTerminalCommandEvent` names a terminal by the item's own id
            // (codeg never created it — every poll misses and ages out at
            // `TERMINAL_POLL_MISSING_LIMIT`), and the real output streams as
            // `_meta.terminal_output_delta` deltas that codeg dropped on the
            // floor. So a codex shell card sat on the `[Terminal: …]`
            // placeholder for the whole command and then filled in at once.
            // `hosted_terminal_*` in `connection.rs` now covers codex alongside
            // pi: the placeholder block is stripped, the call is kept out of the
            // terminal poller, the deltas bridge onto `raw_output`, and the
            // duplicate cumulative `rawOutput` is dropped for those calls.
            //
            // The client capability #528 adds IS advertised (codex only; see
            // `build_client_capabilities`). `resolveTerminalOutputMode` already
            // returns `terminal_output_delta` by DEFAULT, so the streaming above
            // needed nothing on the wire; what the flag buys is that
            // `completeCommandExecutionEvent` stops repeating the whole
            // aggregated output as `rawOutput`, which codeg used to parse only to
            // discard. It was first held back for the `search`/`listFiles`
            // cards, on the premise that they render from the
            // `{formatted_output, exit_code}` envelope — but that premise was
            // already half gone: codex forwards `outputDelta` for EVERY command,
            // so any command action that prints something reaches its card
            // through the same bridge, as plain text, and the envelope only ever
            // spoke for a command that printed nothing. With the flag, that one
            // completes as a bare status with no exit code anywhere
            // (`terminal_exit` is for shell commands only), and the single
            // reader that needed one — grep's "No matches", rg's exit 1 — now
            // reads the live `failed`-with-no-output shape instead
            // (`isCodexGrepNoMatchResult`).
            //
            // (h) `@openai/codex` ^0.154.0 → **^0.155.1** (caret on a 0.x minor
            // pins it inside 0.155.x, so this does not drift to 0.156.0). Two
            // models are RETIRED — `gpt-5.2` and `gpt-5.4-mini` — taking the
            // catalog from 11 slugs to 9; the bundled offline snapshot is
            // regenerated from the 0.155.1 binary. This is the removal case
            // `types.ts` calls a *ghost* (a stored per-conversation override
            // naming a slug the catalog no longer lists), which is handled
            // there and needs nothing here. No new fields on `ModelInfo`; the
            // re-probe against the 0.155.1 binary did turn up two strict
            // booleans `BOOL_FIELDS` had never covered
            // (`node_repl_auto_review_required` / `node_repl_disabled`, both
            // already in 0.154), which it now does.
            //
            // (i) Three fixes that arrive free. A root turn that fails or is
            // interrupted now closes ALL child sessions rather than only the one
            // whose thread id matched (`closingChildSessions`), and `wait()`
            // returns `"timed_out"` so the caller finalizes pending child
            // updates before closing them — both of which used to leave codeg's
            // collab capsules hanging. `/compact` now reports a real turn
            // (`onTurnStarted` + a returned `turn/completed`) instead of
            // resolving with nothing. `thread/attachment/updated` and the
            // `ThreadAttachment*` app-server v2 types are new upstream surface
            // the adapter itself maps to nothing (`return null`), and
            // `FeedbackUploadResponse.promptHash` belongs to a feedback upload
            // codeg does not drive.
            //
            // 1.13.1 is one upstream change (#541): `@openai/codex` ^0.155.1 →
            // **^0.156.1** (a caret on a 0.x minor, so it stays inside
            // 0.156.x). The adapter's own code moves by a single function (see
            // (l)), and the `initialize` response to codeg's handshake matches
            // 1.13.0's field for field apart from the version (both probed
            // live over stdio). `engines` is still absent, so the 20.0.0 floor
            // stays.
            //
            // (j) **GPT-6 Sol and GPT-6 Luna** (the 0.156.1 hotfix) take the
            // catalog from 9 slugs to 11, and every GPT-5.x entry now points an
            // `upgrade` block at one of them (5.6 Luna → gpt-6-luna, the rest →
            // gpt-6-sol; 5.4's retirement stub aimed at 5.6 Terra before),
            // which codex's TUI raises as a migration prompt. Live on a
            // throwaway `CODEX_HOME`, the `model` option reads
            // 6 Astra / 6 Sol / 6 Luna / 5.6 Sol / 5.6 Terra / 5.6 Luna / 5.5,
            // and switching to gpt-6-sol re-derives the effort recommendation
            // to `medium`. The offline snapshot is regenerated from the 0.156.1
            // binary; a custom cloned from a GPT-5.x base still gets `upgrade:
            // null`, which `expand_to_catalog` has always forced and which is
            // now load-bearing (a test pins it). The model-provider placeholder
            // moves to the new pair.
            //
            // Two catalog keys are new to the snapshot.
            // `supports_reasoning_effort_updates` is a strict boolean on every
            // entry, so it joins `BOOL_FIELDS` — a string or a `null` there
            // takes the whole generated catalog down (probed on the binary,
            // which also re-confirmed every enum set). `default_service_tier:
            // "priority"` on the two GPT-6 models is the TUI's client-side
            // default (`effective_service_tier` uses it only when the user
            // configured no tier). codex-acp never reads `defaultServiceTier` —
            // its Fast option follows the thread's `serviceTier` — and live,
            // after switching to gpt-6-sol, `fast-mode` stays `off`. A custom
            // cloned from either GPT-6 model inherits the key along with
            // `service_tiers`; only the TUI would act on it.
            //
            // (k) Inert: codex 0.156 retires the `friendly` / `pragmatic`
            // personality styles and removes the deprecated `thread/rollback`
            // API (a legacy `thread_rolled_back` rollout record still parses).
            // codeg exposes no personality, never calls the API, and
            // `parsers::codex` has never read the record. `ThreadResumeResponse`
            // gains `collaborationMode`, which 1.13.1 does not read: its
            // `collaboration_mode` option still comes from the
            // `thread/settings/updated` cache.
            //
            // (l) Rollout and replay shapes. A user image can now be a FILE
            // reference — `input_image` with `file_id` instead of `image_url`,
            // and `user_message` gains `file_ids` / `image_order` — which only
            // a client uploading to the Files API produces; codeg sends inline
            // and local images. `parsers::codex` skips an image with no inline
            // data (an image-only turn still renders as "Attached resources").
            // The adapter's one code change renders such an input as
            // `image:<fileId>` text in `session/load` replay (and audio /
            // mention inputs as nothing), which never reaches codeg: codex
            // sessions are resumed without draining a replay. The other new
            // fields (`root_turn_id`, MCP `turn_id` / `mcp_app_ui`,
            // `disabledPluginIds`, `availableAccessPrograms`, MCP
            // `serverCapabilities`) are additive, and the parser reads rollouts
            // as untyped JSON.
            distribution: AgentDistribution::Npx {
                version: "1.13.1",
                package: "@agentclientprotocol/codex-acp@1.13.1",
                cmd: "codex-acp",
                args: &[],
                env: &[],
                node_required: Some("20.0.0"),
            },
        },
        AgentType::Gemini => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "Gemini CLI",
            description: "Google's official CLI for Gemini",
            // 0.59.0 → 0.60.0 is a sandbox / path-security release and touches
            // nothing codeg reads. Verified by slicing both bundles on their
            // `// packages/<pkg>/src/<file>.ts` source markers and diffing per
            // source file, after normalising two esbuild artefacts that make an
            // unnormalised diff useless here: identifier renumbering (`fs30` →
            // `fs32`) and inconsistent const-enum inlining (`"proceed_once" /*
            // ProceedOnce */` on one side, `ToolConfirmationOutcome.ProceedOnce`
            // on the other — the dispatcher shows BOTH directions at once, which
            // is what proves it is bundling noise and not a rename). That takes
            // 425 changed files down to 41 real ones.
            //
            // What survives is all sandbox managers (new, per-OS), the
            // extensions registry, MCP OAuth, the policy engine and path
            // security. Of the surfaces codeg depends on:
            //
            // - `loadConversationRecord` (the parser's contract — the four
            //   record kinds) is byte-identical modulo the renumbering.
            // - All four `packages/cli/src/acp/*` files normalise to identical:
            //   the permission option IDs, `toAcpToolKind` and the auth methods
            //   are unchanged.
            // - `tokenLimits.ts` does not appear in the diff at all, so the
            //   1 << 20 window still holds.
            // - `--acp` and `--skip-trust` are both still registered, and the
            //   sandbox is opt-in (`argv.sandbox ?? settings.tools?.sandbox`,
            //   undefined by default), so the launch line is unaffected.
            //
            // One change is worth naming because it is adjacent to us:
            // `mcp-client.ts` now drops MCP-server env entries whose key is in
            // `BLOCKED_EXECUTION_ENVS`. That list is loader/interpreter hijacks
            // (`NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*`, `PYTHONPATH`, `BASH_ENV`,
            // …); codeg injects `codeg-mcp` with `CODEG_*`, so nothing we send
            // is dropped. `engines.node` stays `>=20`.
            distribution: AgentDistribution::Npx {
                version: "0.60.0",
                package: "@google/gemini-cli@0.60.0",
                cmd: "gemini",
                args: &["--acp", "--skip-trust"],
                env: &[],
                node_required: Some("20.0.0"),
            },
        },
        AgentType::OpenClaw => AcpAgentMeta {
            agent_type,
            // OpenClaw 拒绝 `mcpServers` 中的任何服务器条目（会使 session/new 失败），
            // 故不向其转发任何 MCP 条目（含 codeg-mcp 伴生进程）。详见 supports_mcp 字段注释。
            supports_mcp: false,
            name: "OpenClaw",
            description: "OpenClaw is a personal AI assistant you run on your own devices.",
            distribution: AgentDistribution::Npx {
                version: "2026.9.4",
                package: "openclaw@2026.9.4",
                cmd: "openclaw",
                args: &["acp"],
                env: &[],
                // 2026.9.3 DROPPED the Node 22 lane: `engines.node` went from
                // `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0` to
                // `>=24.16.0 <25 || >=26.1.0`, and this is not just metadata —
                // the package ships `node-version.mjs`, a runtime guard both
                // the source and the packaged entry points call, whose
                // `NODE_RELEASE_FLOORS` are literally `{24,16,0}` and
                // `{26,1,0}`. A Node 22 user with the old floor would pass
                // preflight and then hard-fail at launch, so the floor tracks
                // the LOWEST supported release. (codeg's `node_required` is a
                // single minimum, so it cannot express the excluded 25.x and
                // 26.0.x windows.) 2026.9.4 leaves that range untouched, and
                // the `supports_mcp: false` anchor still reads verbatim:
                // `assertSupportedSessionSetup` throws "ACP bridge mode does
                // not support per-session MCP servers" from `dist/server-*.mjs`
                // at the same 4 call sites, with `acp` registered in
                // `dist/acp-cli-*.mjs`.
                node_required: Some("24.16.0"),
            },
        },
        AgentType::Cline => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "Cline",
            description: "Autonomous coding agent CLI",
            distribution: AgentDistribution::Npx {
                version: "3.0.64",
                package: "cline@3.0.64",
                cmd: "cline",
                args: &["--acp"],
                env: &[],
                node_required: Some("22.0.0"),
            },
        },
        AgentType::OpenCode => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "OpenCode",
            description: "The open source coding agent",
            distribution: AgentDistribution::Binary {
                version: "1.18.32",
                cmd: "opencode",
                args: &["acp"],
                env: &[],
                platforms: &[
                    PlatformBinary {
                        platform: "darwin-aarch64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v1.18.32/opencode-darwin-arm64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "darwin-x86_64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v1.18.32/opencode-darwin-x64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "linux-aarch64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v1.18.32/opencode-linux-arm64.tar.gz",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "linux-x86_64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v1.18.32/opencode-linux-x64.tar.gz",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "windows-aarch64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v1.18.32/opencode-windows-arm64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "windows-x86_64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v1.18.32/opencode-windows-x64.zip",
                        sha256: None,
                    },
                ],
                dir_entry: None,
            },
        },
        AgentType::Hermes => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "Hermes Agent",
            description: "Nous Research's self-improving agent (ACP)",
            // DISTRIBUTION STORY (since 0.20.0): upstream retired the pip/PyPI
            // wheel channel (PyPI stops at 0.19.0), ships no wheels on the
            // GitHub release, and blocks git-tag source builds with an
            // install-channel guard (HERMES_NIX_BUILD) — shell installer /
            // Docker / Nix are the supported channels. The npm `hermes-agent`
            // package is a COMMUNITY bridge (wyrtensi/hermes-agent-npm, not
            // Nous Research), pinned here at an exact, audited version: its
            // postinstall clones the OFFICIAL repo at tag v2026.9.21 verifying
            // the full commit SHA (d337b736…), bootstraps an isolated Python
            // 3.11 venv with a checksum-pinned uv, and `uv sync --frozen
            // --extra all` (⊇ the acp+mcp extras) from upstream's lockfile —
            // all inside the npm package directory; config/credentials stay in
            // `~/.hermes`. Its `hermes` bin execs the venv's real upstream
            // console script, so `hermes acp` is the same adapter the official
            // install runs. Keep the pin EXACT on version bumps and re-audit
            // the wrapper diff — the exact pin is what bounds the third-party
            // trust surface. 0.21.4 audited: the whole of `lib/` (incl.
            // `uv-installer.js` and its uv 0.12.13 digest table) and `bin/` are
            // byte-identical to the audited 0.21.3, and `package.json` moves
            // only the version and the upstream pin. The one code change is in
            // `scripts/postinstall.js`, and it is a single argument:
            // `uv sync --locked` → `--frozen`. Both install strictly from
            // upstream's `uv.lock` with its per-artifact hashes and neither
            // re-resolves; `--frozen` drops only the assertion that the lock is
            // in sync with `pyproject.toml`, a check whose strictness varies by
            // uv version. Since the checkout is pinned to an exact commit, that
            // lockfile is fixed content — so the installed dependency set stays
            // exactly as pinned, and `fetchAndVerifyPinnedTag` still hard-compares
            // `rev-parse <tag>^{commit}` against the 40-hex pin before the
            // `checkout --detach`. That new pin resolves as advertised: the
            // annotated tag v2026.9.21 dereferences to exactly d337b736…, tagged
            // by Teknium on 2026-09-21.
            //
            // Launch preference: `resolve_npx_command("hermes")` checks PATH
            // first, so an official-installer `hermes` (which self-updates)
            // naturally outranks the npm-managed copy; the npm global install
            // is the managed/one-click channel codeg's Install button drives.
            distribution: AgentDistribution::Npx {
                version: "0.21.4",
                package: "hermes-agent@0.21.4",
                cmd: "hermes",
                args: &["acp"],
                env: &[],
                // The wrapper declares engines.node >=20; its bins are plain
                // passthrough scripts (no build step at require time).
                node_required: Some("20.0.0"),
            },
        },
        AgentType::CodeBuddy => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "CodeBuddy",
            description: "Tencent Cloud's official AI coding assistant (ACP)",
            distribution: AgentDistribution::Npx {
                version: "2.157.0",
                package: "@tencent-ai/codebuddy-code@2.157.0",
                cmd: "codebuddy",
                args: &["--acp"],
                env: &[],
                node_required: Some("22.0.0"),
            },
        },
        AgentType::KimiCode => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "Kimi Code",
            description: "Moonshot AI's official CLI coding assistant (ACP)",
            // NEVER PIN INTO 0.37.0–0.38.0. Those releases hard-fail
            // `session/new` (and `session/load` / `session/resume`) with "ACP
            // stdio MCP server <name> does not declare a runtime identity" as
            // soon as any stdio server rides the wire — for Kimi that is always
            // the codeg-mcp companion, so the whole agent was unusable, not
            // just delegation. codeg sat on 0.36.1 until 0.39.0 restored it.
            //
            // Root cause, if it ever regresses: 0.37.x added a SECOND converter
            // (`acpMcpServersToConfigRecord`), pointed the three session entry
            // points at it, and left the old `acpMcpServersToConfigs` in the
            // bundle as dead code. The new one handled only `http`/`sse` and
            // threw on an absent `type` — which is how ACP spells stdio. 0.39.0
            // gives it a stdio arm again (`{transport:"stdio", …,
            // runtime_id:"local"}`), feeding the `runtime_id` that Kimi's own
            // session-scoped connection manager demands; codeg sends nothing
            // extra. Diffing the old converter or the handshake proves nothing
            // — both were byte-identical across the break.
            //
            // 0.39.0 was verified live before adopting it rather than assumed
            // from the version number: a stdio server handed over on
            // `session/new` is spawned, its tools reach the model as
            // `mcp__<server>__<tool>`, `tools/call` runs, and the result comes
            // back — same for a server in Kimi's own `~/.kimi-code/mcp.json`.
            // From 0.39.1 on the check is the cheaper source-level one, since
            // the failure is a single missing match arm: `dist/main.mjs` still
            // gives `acpMcpServersToConfigRecord` its absent-`type` arm
            // emitting `{transport:"stdio", …, runtime_id:"local"}`, and the
            // "does not declare a runtime identity" throw is nowhere in the
            // bundle. Any future bump must re-check at least this much.
            //
            // 0.41.0 passes that check unchanged: the converter's absent-`type`
            // arm still emits `{transport:"stdio", command, args, env,
            // runtime_id:"local"}`, all three session entry points still route
            // through it (`session/fork` deliberately warns and ignores
            // `mcpServers`, inheriting the source session's), and the "does not
            // declare a runtime identity" throw is nowhere in the bundle. The
            // rest of the surface codeg touches is unmoved too: the same
            // `mcp.json` Zod schema (see `commands/mcp.rs`) and an `initialize`
            // answering `sessionCapabilities: {list, resume, close, delete,
            // fork, additionalDirectories}` with image + embeddedContext
            // prompts and MCP http+sse. Reading those off the bundle is safe
            // again only because 0.40.0 deleted the legacy ACP server class
            // that still called the dead `acpMcpServersToConfigs`: before that,
            // grepping capabilities without checking which class you landed in
            // found the stale copy first and reported `sessionCapabilities:
            // {list, resume}` — a phantom regression. Both names are gone from
            // the bundle now, so a single hit is the live one.
            //
            // 0.42.0 is the first bump where that check earns its keep. The
            // release is a large INTERNAL rewrite — the agent loop is rebuilt
            // on xstate actors and the whole LLM provider layer is replaced
            // (`KimiChatProvider` and friends are gone as named classes), which
            // drops ~2.2 MB off `dist/main.mjs` and moves hundreds of symbols.
            // None of it reaches codeg: every surface we touch is byte-identical
            // once bundler renumbering (`init_src$7` → `init_src$8`) is ignored.
            // The mandated check passes verbatim — same absent-`type` stdio arm
            // with `runtime_id:"local"`, same three entry points routing through
            // it, no "does not declare a runtime identity" throw, and
            // `acpMcpServersToConfigs` still absent. Because the rewrite is this
            // large the source-level check was backed by a live one, as for
            // 0.39.0: driving `kimi acp` with a stdio server on `session/new`
            // returns a `sessionId`, and the server is spawned and answers
            // `initialize` → `notifications/initialized` → `tools/list`. Beyond
            // it, the entire `packages/acp-server` region set is unchanged
            // except `convert.ts`, which stops gating image formats at the ACP
            // edge and defers to the engine's per-provider gate (same
            // user-visible outcome: rejected parts become a text notice,
            // accepted MIME aliases are canonicalized). `initialize` still
            // answers the same capabilities;
            // config.toml's provider/model Zod schemas are identical (so
            // `max_context_size` is still mandatory — see `commands/acp.rs`);
            // `mcp.json`, `KIMI_MODEL_*`, the skill roots (all four of them —
            // see `commands/acp.rs::skill_storage_spec`), and the
            // `agents/main/wire.jsonl` event log our parser reads are all
            // untouched. What is new is inert for us: a `NotifyUser` tool behind
            // `KIMI_CODE_EXPERIMENTAL_NOTIFY_USER` (default false) and a
            // remote-control tunnel. The sub-agent story is unmoved too — the
            // ACP session still follows main-agent events only, so live nested
            // tool calls remain a history-side concern (`parsers/kimi_code.rs`).
            //
            // 0.43.1 is back to the cheap kind, so the source-level check is the
            // whole story: the converter's absent-`type` arm still emits
            // `{transport:"stdio", command, args, env, runtime_id:"local"}`; the
            // same three session entry points still route through it
            // (`newSession`, `loadSession`, `resumeSession` — `session/fork`
            // keeps inheriting the source session's); `acpMcpServersToConfigs`
            // is still absent from the bundle, and so is the "does not declare
            // a runtime identity" throw. `engines.node` is unmoved at >=22.19.0.
            //
            // 2.0.0 IS NOT A BREAKING RELEASE — do not let the major bump
            // trigger a rewrite hunt. Upstream uses changesets, and the only
            // entry filed as "major" is a new `/desktop` slash command plus a
            // `kimi install-app` subcommand that print a URL and open a
            // browser. The mandated check passes verbatim (same absent-`type`
            // stdio arm with `runtime_id:"local"`, same three entry points,
            // neither `acpMcpServersToConfigs` nor the runtime-identity throw
            // anywhere in the bundle), and `engines.node` is still >=22.19.0.
            // Region-by-region the whole `packages/acp-server` set is
            // byte-identical to 0.43.1 except one line of `slash.ts`, and every
            // other surface codeg touches (`config.toml`'s provider/model Zod
            // schemas — `max_context_size` still `int().min(1)` and still the
            // same six provider types; `mcp.json`; the credentials gate;
            // `skillRoots`; `wire/wireService`) differs only by bundler
            // renumbering (`init_dist$4` → `init_dist$5`).
            //
            // That one `slash.ts` line is the only user-visible delta and it is
            // an improvement: skills carrying the new `scopes: ("tui"|"web")[]`
            // field are dropped from ACP `availableCommands`, so the TUI-only
            // `custom-theme` theme editor (and the new `/desktop`) stop showing
            // up in codeg's slash menu. Live A/B confirms it — 17 commands on
            // 0.43.1, the same 16 minus `custom-theme` on 2.0.0.
            //
            // Backed by a live run as for 0.39.0 and 0.42.0, because a major
            // bump deserves one: `kimi acp` driven with the codeg-managed
            // config.toml block and the synthetic gate token answers
            // `initialize` / `session/new` / `session/prompt` / `session/list`
            // with byte-identical payloads (same capabilities, same four modes,
            // same `configOptions`, same `session_update` kinds), spawns a
            // stdio MCP server handed over on `session/new`, and lands its tools
            // in the model's tool list as `mcp__<server>__<tool>`. The
            // `agents/main/wire.jsonl` our parser reads comes out structurally
            // identical too — same `protocol_version 1.5`, same record types,
            // same `context.append_loop_event` event types, same on-disk home
            // layout. The upstream steering fixes in this release ride on
            // `transcript`'s `groupTurns`, which the ACP replay does not use
            // (`replay.ts` projects the raw context history), so they do not
            // reach codeg.
            //
            // 2.0.1 is a patch release and reads like one. The mandated check
            // passes verbatim — the converter's absent-`type` arm is
            // byte-identical (`{transport: "stdio", command, args, env,
            // runtime_id: "local"}`), the same three entry points
            // (`newSession` / `loadSession` / `resumeSession`) still route
            // through it while `session/fork` still ignores `mcpServers`, and
            // neither `acpMcpServersToConfigs` nor the "does not declare a
            // runtime identity" throw is anywhere in the bundle.
            // `engines.node` is unmoved at >=22.19.0. Region-by-region, 109 of
            // the 121 changed regions differ only by bundler renumbering; the
            // 12 real ones are all TUI/CLI (a `kimi provider` custom-registry
            // import refactor, the survey controller, editor keyboard, TUI
            // session-event handler, `catalog-fetch`) plus a rename of the
            // `install-app` subcommand region to `install-desktop`. Nothing
            // under the ACP server path moved: the regions holding the
            // converter, `max_context_size`, `skillRoots`, `availableCommands`
            // and `protocol_version` are byte-identical, so no live run was
            // needed this time.
            //
            // 2.0.2 is another patch and the mandated check passes verbatim
            // again: byte-identical converter body (`{transport: "stdio",
            // command, args, env, runtime_id: "local"}`), the same three entry
            // points routing through it with `session/fork` still ignoring
            // `mcpServers`, and neither `acpMcpServersToConfigs` nor the "does
            // not declare a runtime identity" throw anywhere in the bundle.
            // `engines.node` is unmoved at >=22.19.0. The region diff is much
            // larger than 2.0.1's but every bit of it points away from us: 315
            // of 339 changed regions are bundler renumbering, and 52 regions
            // are DELETED outright — all of them `packages/kap-server/` (ws v3,
            // projection, protocol messages, history routes). That is the
            // `kimi web` server, booted only from `cli/sub/web` and the TUI
            // `/web` command; codeg drives `kimi acp` over stdio and never
            // reaches it. Every `packages/acp-server/` region is renumber-only,
            // as are `wire/record` + `wireService`, `skillRoots`, config.toml's
            // `max_context_size` Zod and `mcp.json`. The 24 real regions are
            // engine-internal: a steering dedupe (`loopService` no longer
            // dispatches `TurnSteer` when the nudge message IS the active
            // prompt's own message — strictly one duplicate fewer, and
            // `parsers/kimi_code.rs` reads `context.append_loop_event` records,
            // not `turn.steer`), a resume fix that seeds the synthetic
            // `turnEnded` by appending to a non-empty journal instead of
            // skipping it (with `nextTurnId` now advancing monotonically),
            // pre-shrinking history to the window budget before compaction, an
            // additive optional `goods_version` on the managed userinfo, one
            // dropped sentence in the built-in system prompt, and a models.dev
            // catalog refresh (21 models added, 8 dropped, 19 limit tweaks)
            // that leaves all 378 kimi rows untouched — `moonshotai` still
            // reads `kimi-k3` = 1048576 and `kimi-k2.*` = 262144, so the
            // `parsers/mod.rs::infer_context_window_max_tokens` mirror still
            // holds. No live run, same as 2.0.1.
            //
            // 2.1.0 is a minor release and the mandated check passes verbatim:
            // byte-identical converter body (`{transport: "stdio", command,
            // args, env, runtime_id: "local"}`), the same three entry points
            // routing through it, and neither `acpMcpServersToConfigs` nor the
            // "does not declare a runtime identity" throw anywhere in the
            // bundle. `engines.node` is unmoved at >=22.19.0. Every
            // `packages/acp-server/` region is renumber-only, and so are the
            // engine's `wire/*` regions, the auth gate (`server.ts` →
            // `authService.summarize()`), `skillRoots` and `mcp.json`. What
            // does reach disk is additive: `tool.result` gains
            // `result.durationMs`, the sub-agent lifecycle events
            // (`subagent.spawned` … `subagent.cancelled`) become durable wire
            // records that `parsers/kimi_code.rs` passes over, and config.toml
            // gains an optional `auto_session_title` that `dist/main.mjs` only
            // parses — the `kimi web` UI shows a toggle for it, but nothing in
            // the engine acts on it yet. File watching is now OFF by default
            // (`KIMI_CODE_WATCH=1` or `[watch] enabled = true` turn it back
            // on), so config.toml, `mcp.json` and skill roots are no longer
            // watched mid-process.
            // Nothing codeg does at launch depends on that — config.toml is
            // written before the spawn and codeg-mcp rides `session/new` — but
            // an MCP server or skill added from codeg's settings while a Kimi
            // session is open now lands on the next connect. The bundled
            // models.dev catalog grew, yet its `moonshotai` rows are untouched,
            // so the `infer_context_window_max_tokens` mirror still holds. A
            // live A/B against 2.0.2 matched on `initialize`, the
            // `session/update` kinds, a stdio MCP server handed over on
            // `session/new` (spawned, listed, called as
            // `mcp__<server>__<tool>`), and the `agents/main/wire.jsonl` record
            // and loop-event type sets.
            //
            // ONE change does reach codeg: a new symlink-escape guard in the
            // `Read` / `Glob` / `Grep` / `ReadMediaFile` / `Edit` / `Write`
            // tools refuses a path that is lexically inside `cwd` +
            // `additionalDirectories` + the skill roots but whose real path
            // lands outside all of them ("… through a symbolic link that
            // points outside the working directory. Access is blocked; use the
            // real path directly or add the target directory to the
            // workspace."). codeg builds two things in exactly that shape, and
            // 2.0.2 read through both: a multi-folder workspace's folders are
            // real symlinks under the cwd (codeg sends no
            // `additionalDirectories`), and an expert or office skill is
            // `~/.kimi-code/skills/<id>` linked to `~/.codeg/skills/<id>` —
            // still listed as `skill:<id>`, but a `Read` of the skill's own
            // supporting files through the link is now refused. Both degrade
            // rather than break: the error names the real path, and reading
            // the real path goes through with no approval prompt. Passing the
            // link targets as `additionalDirectories` on `session/new` lifts
            // the block for that process only — `session/resume` and
            // `session/load` ignore the field and nothing persists it, so
            // every reconnect would lose it again. The one persistent lever is
            // the project's `.kimi-code/local.toml` (`[workspace]
            // additional_dir`), which 2.1.0 reads only for a trusted
            // workspace.
            distribution: AgentDistribution::Npx {
                version: "2.1.0",
                package: "@moonshot-ai/kimi-code@2.1.0",
                cmd: "kimi",
                args: &["acp"],
                env: &[],
                node_required: Some("22.19.0"),
            },
        },
        AgentType::Pi => AcpAgentMeta {
            agent_type,
            // pi-acp accepts ACP-wire `mcpServers` but drops them (does not
            // forward to pi), and pi has no native MCP. supports_mcp stays
            // `true` only to satisfy the `only_openclaw_opts_out_of_mcp`
            // invariant — actual wire forwarding is short-circuited in
            // `connection.rs` (see the skip-list), so neither user servers nor
            // the codeg-mcp companion are futilely forwarded.
            supports_mcp: true,
            name: "Pi",
            description: "Self-extensible coding agent (ACP via pi-acp)",
            // pi-acp 0.0.33 spawns `pi --mode rpc` as a child, so `pi` (npm
            // `@earendil-works/pi-coding-agent`) must be resolvable on PATH —
            // or pointed at a custom build via the `PI_ACP_PI_COMMAND` env
            // (see BYO-pi). Args are empty: the ACP server is the default mode
            // (`npx -y pi-acp`, no subcommand). `node_required` follows pi's
            // 22+ requirement (pi-acp's own engines say >=20). The embedded
            // context env lets pi-acp advertise `promptCapabilities.embeddedContext`.
            distribution: AgentDistribution::Npx {
                version: "0.0.33",
                package: "pi-acp@0.0.33",
                cmd: "pi-acp",
                args: &[],
                env: &[("PI_ACP_ENABLE_EMBEDDED_CONTEXT", "true")],
                node_required: Some("22.0.0"),
            },
        },
        AgentType::Grok => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "Grok",
            description: "xAI's official coding agent and CLI (ACP via grok agent stdio)",
            // `@xai-official/grok` ships each platform's native binary as a
            // brotli-compressed **optional dependency** (`@xai-official/grok-<os>-<arch>`);
            // the npm `bin/grok` trampoline decompresses it into `~/.grok/bin` on
            // first run. Public mirrors (e.g. registry.npmmirror.com, a common CN
            // default) lag far behind this package — at time of writing only 0.1.4,
            // which predates the `grok agent stdio` ACP subcommand — so the pinned
            // version isn't resolvable there.
            //
            // Both concerns are handled by codeg's shared `npm install -g` path
            // (`install_npm_global_package_streaming` in commands/acp.rs), which
            // always passes `--include=optional` (pulls the platform binary) and
            // `--registry=https://registry.npmjs.org` (bypasses lagging mirrors)
            // for every npx agent — so no per-agent launch env is needed here.
            // (It couldn't live here anyway: the launch env is serialized as
            // leading `KEY=value` argv and the spawn layer's `parse_env_var` only accepts
            // `[A-Za-z0-9_]` env names, which npm's `@scope:registry` key is not.)
            //
            // 1.0.0 changed ONE thing that reaches codeg without any code change
            // here: its `initialize` advertises `sessionCapabilities.resume`
            // (0.2.118 advertised only `list`), so reconnecting to an existing
            // Grok session takes `connect_agent`'s resume → load → new chain at
            // the FIRST rung instead of the second. Verified live against the
            // 1.0.0 binary: `session/resume` restores conversation context, its
            // reply carries the `_meta["x.ai/sessionConfig"]` and per-model
            // `models` that the composer's selectors and context ring read, and
            // prompting straight after it works. It also skips `session/load`'s
            // history replay, which codeg only drained to discard. The 1.0.1–
            // 1.0.41 patches add nothing further here: re-probed live against
            // the 1.0.41 binary, `initialize` still answers
            // `sessionCapabilities: {list, resume, close}` plus the same
            // `promptCapabilities.embeddedContext` (and `mcpCapabilities`
            // http+sse, `loadSession: true`), so the resume rung stands. All
            // six `@xai-official/grok-<os>-<arch>` optional deps are published
            // at 1.0.41 — they are OPTIONAL, so a platform that lags would fail
            // only for that platform's users, at run time, in the trampoline.
            // The pin tracks `dist-tags.latest`, NOT the highest version
            // number; at 1.0.41 `latest` and `alpha` point at the same version,
            // so nothing is staged ahead of it.
            //
            // 1.0.40 DID add one thing that reaches codeg, and it needed a fix
            // on our side: it narrates `session/new` progress on the
            // `_x.ai/session/setup` notification, whose first five phases carry
            // `"sessionId": null` because they run before the id exists. The
            // runtime routes on field PRESENCE, and under sacp 11 it then failed
            // to parse the null, which tore the connection down with `Invalid
            // params: "invalid type: null, expected a string"` (#794). The 2.x
            // runtime survives the parse, but nothing would ever claim such a
            // frame and it would sit in the retry queue for the connection's
            // life. `ClaimNullSessionIds` in connection.rs claims
            // those frames before they can be parked, so this bump is safe only
            // together with that guard.
            distribution: AgentDistribution::Npx {
                version: "1.0.41",
                package: "@xai-official/grok@1.0.41",
                cmd: "grok",
                // Only the ACP subcommand lives here. Grok's ROOT-level launch
                // flags (`--no-auto-update` always, `--permission-mode <value>`
                // only for a non-default permission mode) MUST precede this
                // subcommand — `grok agent stdio` itself rejects them (re-verified
                // against 1.0.41: it still only accepts --debug/--debug-file/
                // --leader-socket) — so `build_agent` inserts them ahead of these
                // args rather than appending after. Since 1.0.3 `grok --help` no
                // longer LISTS `--no-auto-update`, but it is still accepted:
                // clap hard-errors on an unknown argument, and
                // `grok --no-auto-update agent stdio` initializes clean. The
                // root `--permission-mode` still takes exactly the six values
                // `GrokSettings::permission_mode` can hold (default/acceptEdits/
                // auto/dontAsk/bypassPermissions/plan).
                args: &["agent", "stdio"],
                env: &[],
                // `@xai-official/grok@1.0.41` declares `engines.node: ">=20"`;
                // surface that in preflight so Node 18 isn't silently accepted.
                node_required: Some("20.0.0"),
            },
        },
        AgentType::Cursor => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "Cursor",
            description: "Cursor's coding agent (ACP via cursor-agent acp)",
            // Cursor's CLI ships as a ~230MB directory-tree archive (webpack
            // chunks + bundled Node runtime + ripgrep); the `cursor-agent`
            // entry is a shell script that resolves its own directory and
            // execs the sibling `node`, so the tree must stay intact —
            // `dir_entry` switches the binary cache to whole-tree extraction.
            // codeg deliberately does NOT run Cursor's official install
            // script: it symlinks `~/.local/bin/agent`, which collides with
            // Grok's CLI of the same name (observed overwriting it).
            // URL layout follows the ACP registry's `cursor` entry
            // (downloads.cursor.com/lab/<version>/<os>/<arch>/...); custom
            // versions substitute into the same pattern.
            distribution: AgentDistribution::Binary {
                version: "2026.09.18-9a7762b",
                cmd: "cursor-agent",
                args: &["acp"],
                env: &[],
                platforms: &[
                    PlatformBinary {
                        platform: "darwin-aarch64",
                        url: "https://downloads.cursor.com/lab/2026.09.18-9a7762b/darwin/arm64/agent-cli-package.tar.gz",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "darwin-x86_64",
                        url: "https://downloads.cursor.com/lab/2026.09.18-9a7762b/darwin/x64/agent-cli-package.tar.gz",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "linux-aarch64",
                        url: "https://downloads.cursor.com/lab/2026.09.18-9a7762b/linux/arm64/agent-cli-package.tar.gz",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "linux-x86_64",
                        url: "https://downloads.cursor.com/lab/2026.09.18-9a7762b/linux/x64/agent-cli-package.tar.gz",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "windows-aarch64",
                        url: "https://downloads.cursor.com/lab/2026.09.18-9a7762b/windows/arm64/agent-cli-package.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "windows-x86_64",
                        url: "https://downloads.cursor.com/lab/2026.09.18-9a7762b/windows/x64/agent-cli-package.zip",
                        sha256: None,
                    },
                ],
                dir_entry: Some(BinaryDirEntry {
                    unix: "dist-package/cursor-agent",
                    windows: "dist-package/cursor-agent.cmd",
                    // Cursor's tree ships a bundled `node` the entry shim
                    // execs, but the shim resolves it at RUN time and the
                    // package layout is upstream's to change, so it is
                    // chmod'd opportunistically rather than required here.
                    required_siblings: PlatformFiles::NONE,
                }),
            },
        },
        AgentType::DeepSeek => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "DeepSeek Harness",
            description: "Editor-facing DeepSeek Harness agent (ACP via deepseek-acp)",
            // `deepseek-acp` is the community editor bridge for DeepSeek
            // Harness (DSH): the harness's own `@deepseek-ai/dsh-acp` is an
            // automation-only transport (no streaming, no tool presentation,
            // rejects MCP), so codeg drives this adapter instead. It speaks
            // ACP over stdio with NO arguments; auth is the `DEEPSEEK_API_KEY`
            // env (or `~/.dsh/.credentials.yaml`), and per-session model /
            // reasoning-effort / sandbox selection arrives through standard
            // `configOptions`, so the composer selectors need no per-agent
            // code. Session logs land under `$DSH_HOME/sessions` (default
            // `~/.dsh/sessions`), which `parsers::deepseek` reads for history.
            // It advertises loadSession + sessionCapabilities.list/resume and
            // accepts wire `mcpServers` (stdio + streamable HTTP; SSE and the
            // `acp` transport are explicitly rejected), so both the resume rung
            // and the codeg-mcp companion work out of the box. Since 0.3.0 it
            // mounts the upstream skills chain (`skill_storage_spec` mirrors
            // its roots) and, since 0.2.0, offers `--setup` terminal auth for
            // storing the key in `$DSH_HOME/.credentials.yaml`.
            //
            // 0.4.0 guards chunked tool-call headers whose later fragments
            // repeat an explicit null/empty name (which used to overwrite the
            // first fragment's id/name and dispatch an empty tool name); 0.5.0
            // sends a terminal `tool_call`'s `rawInput` as the
            // `{command, description?, cwd?}` OBJECT rather than a bare command
            // string, i.e. the codex-acp shape codeg's tool cards already parse.
            //
            // 0.6.0 is the first bump that MOVES the handshake, because its
            // `dsh-*` deps went 0.1.0-rc.7 → 0.1.1-rc.2 and it wired up what
            // that unlocked. Four of the five new capabilities cost codeg
            // nothing — they land on paths that already read the agent's own
            // advertisement:
            //
            // * `sessionCapabilities.fork` is now advertised unconditionally,
            //   so `supports_fork` flips on by itself and `acp::fork`'s
            //   `{sessionId, cwd}` request is exactly what it accepts (it
            //   rejects `additionalDirectories`, which codeg never sends).
            // * `promptCapabilities.image` went from a hardwired `false` to
            //   "true whenever the attachment store is mounted", which the
            //   stock composition always does — so the composer's upload path
            //   un-gates through `effective_prompt_capabilities` with no
            //   per-agent branch. Sending pixels to a text-only model is
            //   refused by the agent with a message naming the model to switch
            //   to, which is a better failure than hiding the button.
            // * Multi-provider deployments re-encode the model config value as
            //   `provider::model` and ship SERVER-SIDE `configOptions` groups.
            //   `deriveModelGroups` already yields to server groups verbatim,
            //   and single-provider installs (i.e. nearly all of them) keep
            //   emitting bare model ids, so the selector is unaffected either
            //   way. codeg does not drive the new `providers/*` UNSTABLE plane;
            //   routes are configured in `settings.yaml`, and the DeepSeek
            //   settings panel still owns `DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY`
            //   for the built-in `deepseek-official` route.
            // * `session/load` + `session/resume` + `session/fork` now answer
            //   `-32002 Resource not found` (was `-32603`) for a session id with
            //   no log, which `classify_load_failure` already maps to the
            //   `resource_not_found` copy — a stale workspace id stops looking
            //   like an agent crash.
            //
            // The fifth, context compaction, stays off for DEEPSEEK
            // specifically — and the reason is no longer "the pinned schema
            // can neither advertise nor deserialize it", which is what this
            // entry used to say (see the claude entry's (p) for the correction:
            // `build_client_capabilities` advertises the capability and
            // `session_compaction_event` reads the variants back). It stays off
            // because `build_client_capabilities` only advertises it to the two
            // agents that BUILT these — the same "advertise nothing an agent
            // hasn't implemented" rule every other opt-in follows. Nothing here
            // reports deepseek-acp implementing the RFD; if a release does, it
            // joins that match arm and needs no other change.
            // Meanwhile compaction still HAPPENS (auto at the window limit, or
            // `/compact`) and still lands in the log, so `parsers::deepseek`
            // renders it from there — see its `compaction/*` arm.
            //
            // What `parsers::deepseek` did have to learn is the log's two new
            // shapes: `image` content blocks (bytes live in the content-
            // addressed `$DSH_HOME/attachments/v1` store, the log keeps only a
            // `sha256:` ref) and the `compaction/*` lifecycle. The three
            // upstream layouts codeg mirrors — `dsh-home-paths`'
            // `resolveDshHome`, `dsh-skill-filesystem`'s roots,
            // `dsh-session-persistence-jsonl`'s `session.jsonl[.zstd]` tree —
            // are unchanged across rc.7 → rc.2, so nothing else moved.
            //
            // 0.7.0 moves NOTHING on the wire — `protocol/initialize.js`差异
            // 只有 `AGENT_INFO.version` 一行，`@agentclientprotocol/sdk` 和上面
            // 那三个被镜像的 `dsh-*` 依赖都停在原版本，所以上述能力断言与
            // `parsers::deepseek` 都不用动。两处值得知道的行为变化：
            //
            // * `session/load` + `session/fork` 的 cwd 校验从裸字符串相等换成
            //   `sameWorkspace()`（realpath.native，fail-closed）。这是**放宽**：
            //   codeg 送的工作区路径以前只要拼写与日志里记的不同就被拒——macOS
            //   的 `/var` → `/private/var`、Windows 8.3 短名——恢复会莫名失败。
            //   `session/list` 的 cwd 过滤同样改成按目录判定。
            // * Windows 上模型面向的 shell 工具从 `bash` 换成 `pwsh`
            //   (`composition/shell.js` 的 `mountNativeShell`)；非 Windows 仍是
            //   `bash`。`dsh-tool-pwsh` 的 `presentCall` 与 `dsh-tool-bash` 逐字
            //   同形（前台 `card: "terminal"` + `{title, description, cwd?}`，
            //   后台才是 `card: "generic"` + 裸字符串 `rawInput`），所以 codeg
            //   的终端工具卡在两个平台上拿到的形状一致。
            //
            // 0.8.0 加的是**消息级 fork**，读的就是 claude-agent-acp 0.73.0 与
            // codex-acp 1.8.0 那个 `_meta.jetbrains.air.fork` 块（同样先剥
            // `:segment:\d+$`，块缺席时仍退化成尾部 fork），所以接线全在
            // `acp::fork::resolve_fork_point` 的新 arm 里，协议层不用动：
            //
            // * id 侧**两种都认**：它自己盖在 message/thought chunk 上的 wire id
            //   （`<turn>:<step>`），以及会话日志里那条 `message.id`。后者是
            //   `parsers::deepseek` 现在记进 `agent_message_id` 的那个——上游把它
            //   明写成「留给直接读 JSONL 的客户端」，codeg 正是。
            //   `dependencies` 与 0.7.0 逐字节相同（`dsh-*` 全停在 0.1.1-rc.2，
            //   `@agentclientprotocol/sdk` 停在 1.4.0），日志布局因此没动。
            // * 指纹侧**同时按逐条消息和逐回合两种口径算**，两边都中且指向不同回合
            //   时报 `-32602`（而不是被 `rethrowMissingSession` 误判成 `-32002`，
            //   那会让客户端把一条好会话从列表里摘掉）。codeg 一个日志回合只渲染
            //   一条 assistant 气泡，命中的是逐回合那一档；id 命中时指纹压根不看，
            //   所以那条歧义路径实际走不到。
            // * `initialize.js` 的 diff 只有 `AGENT_INFO.version` 一行，
            //   `sessionCapabilities`（含无条件的 `fork: {}`）与
            //   `promptCapabilities` 都没动，上面那串能力断言仍然成立。
            // * `agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk`
            //   现在带 `messageId`。对 codeg 是**惰性**的：1.x schema 里它是稳定的
            //   `ContentChunk::message_id`（当年 pin 的 0.11 把它放在没开的
            //   `unstable_message_id` feature 后面、被 serde 当未知字段丢掉），但
            //   codeg 不读它——分叉点取自解析出来的日志而不是 live 转写。
            //
            // 0.9.0 唯一需要 codeg 跟着改的是**模型目录**，而它落在设置面板那条线上
            // （`commands::deepseek_settings`），不在协议层：
            //
            // * 目录的来源换人了。`boot.ts` 现在把自己的 `DEEPSEEK_MODELS` 作为
            //   **composition base** 传给 `LlmDeepSeek`，而 `dsh-settings` 的分层是
            //   「schema 默认 → composition base → 用户文档 section」——于是没配
            //   `llm-deepseek.models` 时继承到的是 agent 这份（`deepseek-flash` 收图
            //   + `deepseek-v4-pro`），**不是**适配器 schema 默认那份。后者还留着
            //   `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 两个已下线 id，
            //   照抄它等于给用户列出两个不存在的模型。默认启动模型同步改成
            //   `deepseek-flash`。用户文档仍然压过一切，面板的写入路径不受影响。
            // * `imageDetail` **被撤销成硬报错**：`resolveModels` 第一行就
            //   `throw` on `Object.hasOwn(model, "imageDetail")`，而拒绝一条等于
            //   整份 section 无法 resolve、agent 退回 last-good（= 内置目录）——
            //   用户的模型列表一条都不生效且不报错。替代品是 `imagePixelBudget`
            //   现在接受字面量 `"low"`（= 512×512）。
            // * 新增 `systemPromptUpdate: "in-history"`，agent 自己的默认条目就带着
            //   它；漏写不报错，只是让那个模型静默换一种系统提示投递方式。
            // * prompt 现在等 `sessions.flush()` 才结算，落盘失败以 `-32603` 拒绝
            //   而不是照回 `end_turn`。codeg 把它渲染成一次失败的回合，正是要的
            //   结局——回成功再把这一轮历史丢掉才是无声的。
            // * **`assistant/chunk` / `*-chunks` 不再逐条落库**（紧凑流搬进
            //   `assistant/message` 的 `stream` 字段）。`parsers::deepseek` 里那条
            //   跳过列表**要留着**：旧日志里还有那些行，而新形状是 `assistant/message`
            //   自己的一个字段，本来就不会被当成事件行读。
            //
            // Keep `version` and `package` moving together: `version` is what
            // the agents list shows as the upgrade target beside the installed
            // version, so a drift leaves the Upgrade button installing one
            // version while the row keeps calling it stale.
            distribution: AgentDistribution::Npx {
                version: "0.9.0",
                package: "deepseek-acp@0.9.0",
                cmd: "deepseek-acp",
                args: &[],
                env: &[],
                // package.json declares `engines.node: ">=22"`.
                node_required: Some("22.0.0"),
            },
        },
        AgentType::Qoder => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "Qoder",
            description: "Alibaba's Qoder coding agent CLI (native ACP via --acp)",
            // `qoder --acp` is the CLI's OWN first-party ACP server (not a
            // community bridge): verified handshake advertises `loadSession`
            // plus the full `sessionCapabilities` set (list/resume/fork/close/
            // delete/additionalDirectories), image + embeddedContext prompts,
            // and MCP http+sse — so the resume rung and the codeg-mcp
            // companion work with no adapters in between. Auth is the qoder
            // account (`qoder login`, or the IDE's qoder-browser flow); there
            // is no API-key env to manage. Model, mode (default/acceptEdits/
            // bypassPermissions/plan) and reasoning effort arrive through
            // standard `configOptions`, so the composer selectors need no
            // per-agent code. Session logs land as
            // `$QODER_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>.jsonl`
            // (default `~/.qoder/...`) in the Claude-Code-style chunk-log
            // envelope, which `parsers::qoder` reads for history — including
            // the `custom-title` / `ai-title` records that carry the session's
            // name in plaintext (the sibling `<sessionId>/state.json` keeps its
            // own copy AES-GCM-encrypted under the machine key, so it is not
            // the source). `engines.node: ">=20"`.
            //
            // `QODER_EXPOSE_TOKEN_USAGE` turns OFF qoder's own token-count
            // redaction, and without it every qoder session reports zero tokens
            // everywhere codeg can see. The CLI passes each response's usage
            // through a sanitizer that keeps the real counters only when the
            // model came from a BYO/custom provider or that env is truthy
            // (`1`/`true`/`yes`); otherwise it rewrites `input_tokens`,
            // `output_tokens` and both cache counters to 0 before the usage
            // reaches the transcript, leaving `credits` and
            // `context_usage_ratio` as the only surviving signal. Its own
            // process log is redacted by the same pass, so the zeros there are
            // not evidence that the backend returned none. Verified on the
            // 1.1.54 bundle: `-p` with the env set writes
            // `input_tokens: 2803, output_tokens: 19` where the default run
            // writes zeros.
            //
            // The name is assembled at runtime from a `QODER_`/`QODERCN_`
            // prefix (`Sr(A) = `${vv}${A}``, `ebA = Sr("EXPOSE_TOKEN_USAGE")`),
            // so grepping the bundle for the full literal returns nothing —
            // grep the bare suffix instead, the same trap `parsers::qoder`
            // documents for the config-dir vars.
            //
            // Registry env is only the base: `merge_agent_env` lets a per-agent
            // `runtime_env` override it, so a user who wants the redaction back
            // sets `QODER_EXPOSE_TOKEN_USAGE=0` in the agent's env settings.
            distribution: AgentDistribution::Npx {
                version: "1.1.62",
                package: "@qoder-ai/qodercli@1.1.62",
                cmd: "qoder",
                args: &["--acp"],
                env: &[("QODER_EXPOSE_TOKEN_USAGE", "1")],
                // package.json declares `engines.node: ">=20.0.0"`.
                node_required: Some("20.0.0"),
            },
        },
        AgentType::Antigravity => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "Google Antigravity",
            description: "Google's AI coding agent (first-party ACP server)",
            // `agy_acp_server` is Google's OWN ACP server, not a community
            // bridge: the verified handshake advertises `loadSession`,
            // `sessionCapabilities` list+resume, image/audio/embeddedContext
            // prompts and MCP http+sse, with `agentInfo.name =
            // "antigravity-acp"`. Model and session mode (default/auto_edit/
            // yolo) arrive as standard `configOptions`, so the composer
            // selectors need no per-agent code.
            //
            // WHOLE-TREE, NOT SINGLE-FILE. The archive is FLAT but holds TWO
            // executables:
            //
            //   agy_acp_server.par     the server (a compiled binary despite
            //                          the `.par` name — it embeds a whole
            //                          CPython runtime)
            //   localharness_external  the Go harness the server drives
            //
            // `main.py::_configure_localharness_path` looks for
            // `localharness_external` (then `localharness`) beside
            // `dirname(argv[0])` / `dirname(sys.executable)` and logs
            // "Localharness not found." when it is missing. Copying the
            // single `cmd` file out of the archive (`dir_entry: None`) would
            // strand that sibling, so this uses the same whole-tree
            // extraction Cursor does — and `install_extracted_tree` also
            // marks the harness executable.
            //
            // AUTH IS A FILE, NOT AN ENV VAR. `session/new` FAILS with
            // `-32000 Authentication required` unless
            // `$GEMINI_HOME/antigravity-acp/settings.json` declares
            // `auth.type` (env-based selection was removed upstream; the
            // server's own message says so). codeg does not implement the ACP
            // `authenticate` request, so the launch path writes that file
            // instead — see `sync_antigravity_settings_file` in connection.rs
            // and the Antigravity settings panel that feeds it. With
            // `auth.type` set, the server runs its own browser OAuth loopback
            // flow inside `session/new`.
            //
            // VERSION vs URL. These used to disagree: `version` was the ACP
            // registry's `1.0.0` while the archives carried a dated build id
            // (`agy_acp_server_20260818_01_RC01`), so substituting a requested
            // version into the URL was a no-op and `supports_custom_version()`
            // answered false. Google has since renamed the archives after the
            // release itself, so the version now templates into the URL like
            // every other binary agent and the custom-version control appears
            // for Antigravity. The name has moved twice since: 1.0.0–1.1.x are
            // `agy-acp-server-agy_acp_server_<version>-<target>.zip` (1.0.0 is
            // the old build, back-published), and from 1.2.0 the infix is gone
            // (`agy-acp-server-<version>-<target>.zip`). Only the current shape
            // is templated, so a typed version below 1.2.0 404s at download —
            // as does one never published (1.0.1) — rather than caching the
            // wrong bytes, which is the same contract Cursor and OpenCode
            // already have. `darwin-x86_64` first shipped with 1.2.1 (1.2.0
            // still covered only the other five targets), so on an Intel Mac
            // anything older 404s the same way.
            distribution: AgentDistribution::Binary {
                version: "1.2.1",
                // Never resolvable on PATH (there is no standalone CLI by
                // this name); it exists because `Binary` requires one, and
                // for dir-tree agents `installed_binary_path` ignores it in
                // favour of `dir_entry`.
                cmd: "agy_acp_server",
                // `--uid=` is an absl/InitGoogle flag ("If root, switch to
                // this user id (or empty-string not to switch)"), not an ACP
                // one: without it a root process (Docker) drops to `nobody`.
                // The ACP registry passes it on Linux ONLY, and so do we —
                // the Windows build need not link the same InitGoogle, and an
                // unknown flag is a hard startup error there.
                args: ANTIGRAVITY_LAUNCH_ARGS,
                env: &[],
                platforms: &[
                    PlatformBinary {
                        platform: "darwin-aarch64",
                        url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-arm64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "darwin-x86_64",
                        url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-x86_64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "linux-aarch64",
                        url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.2.1-linux-arm64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "linux-x86_64",
                        url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.2.1-linux-x86_64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "windows-aarch64",
                        url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.2.1-windows-arm64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "windows-x86_64",
                        url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.2.1-windows-x86_64.zip",
                        sha256: None,
                    },
                ],
                dir_entry: Some(BinaryDirEntry {
                    unix: "agy_acp_server.par",
                    windows: "agy_acp_server.exe",
                    // The Go harness the server execs. Required, not just
                    // chmod'd: without it the server starts and then logs
                    // "Localharness not found." — a working handshake
                    // attached to a broken agent, which is worse than a
                    // failed install. It also invalidates any single-file
                    // cache left behind by a pre-integration CUSTOM entry
                    // for `antigravity-acp` (see `required_siblings`).
                    required_siblings: PlatformFiles {
                        unix: &["localharness_external"],
                        windows: &["localharness_external.exe"],
                    },
                }),
            },
        },
        // Handled by the early return above; kept so the match stays
        // exhaustive without a catch-all that could swallow a new built-in.
        AgentType::Custom(_) => unreachable!("custom agents resolve via custom_registry"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_npx_version(
        agent_type: AgentType,
        expected_version: &str,
        expected_package: &str,
        expected_node_required: Option<&str>,
    ) {
        let meta = get_agent_meta(agent_type);
        match meta.distribution {
            AgentDistribution::Npx {
                version,
                package,
                node_required,
                ..
            } => {
                assert_eq!(version, expected_version);
                assert_eq!(package, expected_package);
                assert_eq!(node_required, expected_node_required);
                assert_eq!(meta.registry_version(), Some(expected_version));
            }
            other => {
                panic!("expected npx distribution for {agent_type:?}, got {other:?}");
            }
        }
    }

    fn assert_binary_version(
        agent_type: AgentType,
        expected_version: &str,
        expected_release_path: &str,
    ) {
        let meta = get_agent_meta(agent_type);
        match meta.distribution {
            AgentDistribution::Binary {
                version, platforms, ..
            } => {
                assert_eq!(version, expected_version);
                assert_eq!(meta.registry_version(), Some(expected_version));
                for platform in platforms {
                    assert!(
                        platform.url.contains(expected_release_path),
                        "{} URL did not use {expected_release_path}: {}",
                        platform.platform,
                        platform.url
                    );
                }
            }
            other => {
                panic!("expected binary distribution for {agent_type:?}, got {other:?}");
            }
        }
    }

    // Google Antigravity's archive is FLAT but holds two executables — the
    // server and the `localharness_external` binary it spawns — so it must
    // use whole-tree extraction (the single-file copy-out would strand the
    // harness and the server would log "Localharness not found."). The Linux
    // targets, and only those, carry the absl `--uid=` flag.
    #[test]
    fn antigravity_pins_dir_tree_binary_and_linux_only_uid_flag() {
        let meta = get_agent_meta(AgentType::Antigravity);
        assert!(meta.supports_mcp);
        assert_eq!(registry_id_for(AgentType::Antigravity), "antigravity-acp");
        match meta.distribution {
            AgentDistribution::Binary {
                version,
                cmd,
                args,
                platforms,
                dir_entry,
                ..
            } => {
                assert_eq!(version, "1.2.1");
                assert_eq!(cmd, "agy_acp_server");
                let entry = dir_entry.expect("antigravity must use dir-tree extraction");
                assert_eq!(entry.unix, "agy_acp_server.par");
                assert_eq!(entry.windows, "agy_acp_server.exe");
                // Six targets: upstream added the Intel macOS build in 1.2.1.
                assert_eq!(platforms.len(), 6);
                assert!(platforms.iter().any(|p| p.platform == "darwin-x86_64"));
                for platform in platforms {
                    assert!(
                        platform.url.contains("/agy-acp-server-1.2.1-"),
                        "{} URL lost the release name: {}",
                        platform.platform,
                        platform.url
                    );
                }
                if cfg!(target_os = "linux") {
                    assert_eq!(args, &["--uid="]);
                } else {
                    assert!(args.is_empty(), "--uid= is a Linux-only absl flag");
                }
                // The harness must be REQUIRED, not merely chmod'd. It is what
                // stops a stale single-file cache — which a pre-integration
                // CUSTOM `antigravity-acp` entry would have written under the
                // same key, because the archive is flat — from being adopted
                // and launched without it.
                let required = entry.required_siblings.for_current_platform();
                assert_eq!(required.len(), 1);
                assert!(
                    required[0].starts_with("localharness_external"),
                    "unexpected required sibling: {required:?}"
                );
            }
            other => panic!("expected binary distribution for Antigravity, got {other:?}"),
        }
    }

    /// A binary agent whose archives are named after an opaque build id rather
    /// than the release: substituting a requested version into its URL is a
    /// no-op, so the same archive would come down and get cached under whatever
    /// number was typed. Every platform carries the same build id so the
    /// assertion below holds whichever one `current_platform()` resolves to.
    ///
    /// Antigravity was this shape until Google renamed its archives after the
    /// release; the entry is kept synthetic so the rule stays covered without
    /// waiting for another agent to ship an untemplatable URL.
    const BUILD_ID_URL_PLATFORMS: &[PlatformBinary] = &[
        PlatformBinary {
            platform: "darwin-aarch64",
            url: "https://example.invalid/agent_20260818_01_RC01-darwin-arm64.zip",
            sha256: None,
        },
        PlatformBinary {
            platform: "darwin-x86_64",
            url: "https://example.invalid/agent_20260818_01_RC01-darwin-x64.zip",
            sha256: None,
        },
        PlatformBinary {
            platform: "linux-aarch64",
            url: "https://example.invalid/agent_20260818_01_RC01-linux-arm64.zip",
            sha256: None,
        },
        PlatformBinary {
            platform: "linux-x86_64",
            url: "https://example.invalid/agent_20260818_01_RC01-linux-x86_64.zip",
            sha256: None,
        },
        PlatformBinary {
            platform: "windows-aarch64",
            url: "https://example.invalid/agent_20260818_01_RC01-windows-arm64.zip",
            sha256: None,
        },
        PlatformBinary {
            platform: "windows-x86_64",
            url: "https://example.invalid/agent_20260818_01_RC01-windows-x86_64.zip",
            sha256: None,
        },
    ];

    /// The URL is what decides whether a custom version can be installed, not
    /// the presence of a `version`.
    ///
    /// An agent can have both a registry version and download URLs that never
    /// mention it, and then substituting a requested version into the URL is a
    /// no-op: the same archive comes down and gets cached under whatever number
    /// was typed, leaving `installed_version` describing a build that was never
    /// fetched. The settings page used to offer the control to every binary
    /// agent with a version, which is exactly that inference.
    #[test]
    fn custom_version_install_follows_the_url_not_the_version_field() {
        let build_id_agent = AcpAgentMeta {
            agent_type: AgentType::Custom("build-id-agent"),
            supports_mcp: true,
            name: "Build Id Agent",
            description: "an agent whose archives are named after a build id",
            distribution: AgentDistribution::Binary {
                version: "1.0.0",
                cmd: "agent",
                args: &[],
                env: &[],
                platforms: BUILD_ID_URL_PLATFORMS,
                dir_entry: None,
            },
        };
        assert!(
            !build_id_agent.supports_custom_version(),
            "a build-id URL carries no version, so one cannot be templated in"
        );
        // Cursor is the control: a binary agent whose release path IS its
        // pinned version, so the substitution genuinely selects a build.
        assert!(get_agent_meta(AgentType::Cursor).supports_custom_version());
        // Antigravity joined it once Google's archives took the release name.
        assert!(get_agent_meta(AgentType::Antigravity).supports_custom_version());
        // npx installs `<package>@<version>` directly — no URL involved.
        assert!(get_agent_meta(AgentType::Codex).supports_custom_version());
    }

    // Cursor is one of two dir-tree binary agents: the archive must be kept
    // intact (bundled Node runtime) and launched via the in-tree entry
    // script, never copied out as a single file.
    #[test]
    fn cursor_pins_dir_tree_binary() {
        let meta = get_agent_meta(AgentType::Cursor);
        assert_binary_version(
            AgentType::Cursor,
            "2026.09.18-9a7762b",
            "/lab/2026.09.18-9a7762b/",
        );
        match meta.distribution {
            AgentDistribution::Binary {
                cmd,
                args,
                platforms,
                dir_entry,
                ..
            } => {
                assert_eq!(cmd, "cursor-agent");
                assert_eq!(args, &["acp"]);
                assert_eq!(platforms.len(), 6);
                let entry = dir_entry.expect("cursor must use dir-tree extraction");
                assert_eq!(entry.unix, "dist-package/cursor-agent");
                assert_eq!(entry.windows, "dist-package/cursor-agent.cmd");
            }
            other => panic!("expected binary distribution for Cursor, got {other:?}"),
        }
        // OpenCode stays on the single-binary copy-out path.
        match get_agent_meta(AgentType::OpenCode).distribution {
            AgentDistribution::Binary { dir_entry, .. } => assert!(dir_entry.is_none()),
            other => panic!("expected binary distribution for OpenCode, got {other:?}"),
        }
    }

    #[test]
    fn steering_prompt_required_min_version_gates_claude_only() {
        // The native-steering policy bit: only an adapter that honors the
        // `promptRequired` opt-in AND keeps the owning prompt in flight across
        // a steered turn gets a minimum version. The floor is the release that
        // fixed the latter (claude-agent-acp 0.65.0 / #958), NOT the one that
        // introduced the opt-in — every 0.64.x settles the prompt early (#934).
        // Everyone else stays None and rides the MCP pull channel; codex-acp
        // ships steering without the opt-in at all (re-verified on the 1.3.0
        // tarball). Flipping an agent on here without the runtime
        // `agent_info.version` proof is not enough by design.
        assert_eq!(
            steering_prompt_required_min_version(AgentType::ClaudeCode),
            Some("0.65.0")
        );
        assert_eq!(steering_prompt_required_min_version(AgentType::Codex), None);
        for agent in [
            AgentType::Gemini,
            AgentType::OpenClaw,
            AgentType::Grok,
            AgentType::Antigravity,
            AgentType::Custom("acme"),
        ] {
            assert_eq!(steering_prompt_required_min_version(agent), None);
        }
    }

    #[test]
    fn goal_control_is_out_of_band_gates_codex_only() {
        // codex changes the goal through an app-server RPC, so codeg may follow
        // a pause/clear with the interrupt that actually stops the work. claude
        // delivers the same request as the prompt text "/goal clear" — killing
        // that turn would kill the clear — and every unverified adapter fails
        // closed onto the same "don't touch the turn".
        assert!(goal_control_is_out_of_band(AgentType::Codex));
        assert!(!goal_control_is_out_of_band(AgentType::ClaudeCode));
        for agent in [
            AgentType::Gemini,
            AgentType::OpenClaw,
            AgentType::Grok,
            AgentType::Antigravity,
            AgentType::Custom("acme"),
        ] {
            assert!(!goal_control_is_out_of_band(agent));
        }
    }

    #[test]
    fn registry_pins_current_acp_agent_versions() {
        assert_npx_version(
            AgentType::ClaudeCode,
            "0.81.1",
            "@agentclientprotocol/claude-agent-acp@0.81.1",
            Some("22.0.0"),
        );
        assert_npx_version(
            AgentType::Gemini,
            "0.60.0",
            "@google/gemini-cli@0.60.0",
            Some("20.0.0"),
        );
        // OpenClaw's floor is a RUNTIME gate (`node-version.mjs`), not just
        // `engines` metadata: 2026.9.3 retired the Node 22 lane and 2026.9.4
        // keeps that range, so this must stay at the lowest release the guard
        // admits (see the registry entry).
        assert_npx_version(
            AgentType::OpenClaw,
            "2026.9.4",
            "openclaw@2026.9.4",
            Some("24.16.0"),
        );
        assert_npx_version(
            AgentType::Cline,
            "3.0.64",
            "cline@3.0.64",
            Some("22.0.0"),
        );
        assert_npx_version(
            AgentType::CodeBuddy,
            "2.157.0",
            "@tencent-ai/codebuddy-code@2.157.0",
            Some("22.0.0"),
        );
        // Kimi Code must never land on 0.37.0–0.38.0: every session in that
        // range dies on the codeg-mcp stdio entry (see the registry entry).
        assert_npx_version(
            AgentType::KimiCode,
            "2.1.0",
            "@moonshot-ai/kimi-code@2.1.0",
            Some("22.19.0"),
        );
        assert_npx_version(
            AgentType::Codex,
            "1.13.1",
            "@agentclientprotocol/codex-acp@1.13.1",
            Some("20.0.0"),
        );
        assert_npx_version(AgentType::Pi, "0.0.33", "pi-acp@0.0.33", Some("22.0.0"));
        assert_npx_version(
            AgentType::Grok,
            "1.0.41",
            "@xai-official/grok@1.0.41",
            Some("20.0.0"),
        );
        assert_npx_version(
            AgentType::DeepSeek,
            "0.9.0",
            "deepseek-acp@0.9.0",
            Some("22.0.0"),
        );
        assert_npx_version(
            AgentType::Qoder,
            "1.1.62",
            "@qoder-ai/qodercli@1.1.62",
            Some("20.0.0"),
        );
        assert_binary_version(AgentType::OpenCode, "1.18.32", "/releases/download/v1.18.32/");
        // Hermes rides the community npm bridge (upstream retired its PyPI
        // channel at 0.19.0; see the registry entry). The npm package version
        // tracks the upstream version 1:1, and the pin must stay EXACT — the
        // audited wrapper code is only what the pinned version ships.
        assert_npx_version(
            AgentType::Hermes,
            "0.21.4",
            "hermes-agent@0.21.4",
            Some("20.0.0"),
        );
    }

    // The Hermes launch command must be the wrapper's `hermes` bin with the
    // `acp` subcommand — the package's OTHER bins (`hermes-agent`,
    // `hermes-npm`) map to different console scripts (`run_agent:main` and
    // the bridge maintenance CLI), not the ACP adapter. `resolve_npx_command`
    // checks PATH before the npm prefix, so an official-installer `hermes`
    // keeps outranking the npm-managed copy without any policy bit.
    #[test]
    fn hermes_launches_the_hermes_bin_with_acp_subcommand() {
        let meta = get_agent_meta(AgentType::Hermes);
        match meta.distribution {
            AgentDistribution::Npx { cmd, args, .. } => {
                assert_eq!(cmd, "hermes");
                assert_eq!(args, &["acp"]);
            }
            other => panic!("expected npx distribution for Hermes, got {other:?}"),
        }
    }

    // qoder redacts its own token counters unless this env is truthy, and a
    // transcript full of zeros parses cleanly — the gauge just reads 0 forever
    // with nothing to flag it. Pin the pair so dropping it fails loudly here
    // instead of silently in the UI.
    #[test]
    fn qoder_launches_with_token_usage_exposed() {
        let meta = get_agent_meta(AgentType::Qoder);
        match meta.distribution {
            AgentDistribution::Npx { env, .. } => {
                assert!(
                    env.contains(&("QODER_EXPOSE_TOKEN_USAGE", "1")),
                    "qoder must launch with token redaction off, got {env:?}"
                );
            }
            other => panic!("expected npx distribution for Qoder, got {other:?}"),
        }
    }

    #[test]
    fn uses_cursor_acp_backend_matches_resolved_launch_spec() {
        assert!(uses_cursor_acp_backend(AgentType::Cursor));
        assert!(!uses_cursor_acp_backend(AgentType::Codex));
        assert!(!uses_cursor_acp_backend(AgentType::ClaudeCode));
        assert!(!uses_cursor_acp_backend(AgentType::Custom("acme")));

        assert!(launch_spec_uses_cursor_acp("cursor-agent", &["acp"]));
        assert!(launch_spec_uses_cursor_acp("cursor-agent.cmd", &["acp"]));
        assert!(launch_spec_uses_cursor_acp(
            "./dist-package/cursor-agent.cmd",
            &["acp"]
        ));
        assert!(!launch_spec_uses_cursor_acp("cursor-agent", &[]));
        assert!(!launch_spec_uses_cursor_acp("codex-acp", &[]));
        assert!(!launch_spec_uses_cursor_acp("cursor-agent", &["stdio"]));
    }

    // Only Claude Code and Codex ship as a third-party ACP adapter wrapping a
    // vendor CLI of a different name. Every other agent's registry `cmd` IS the
    // vendor CLI, so claiming an adapter relation for one would make preflight
    // explain a split that doesn't exist.
    #[test]
    fn acp_adapter_relation_covers_only_wrapper_agents() {
        for agent_type in all_acp_agents() {
            let relation = acp_adapter_relation(agent_type);
            let expected = matches!(agent_type, AgentType::ClaudeCode | AgentType::Codex);
            assert_eq!(
                relation.is_some(),
                expected,
                "unexpected adapter relation for {agent_type:?}"
            );
            // The whole point is that the vendor CLI's name differs from the
            // adapter command codeg actually launches.
            if let Some(relation) = relation {
                match get_agent_meta(agent_type).distribution {
                    AgentDistribution::Npx { cmd, .. } => {
                        assert_ne!(cmd, relation.native_cmd, "{agent_type:?}")
                    }
                    other => panic!("expected npx distribution for {agent_type:?}, got {other:?}"),
                }
            }
        }
    }

    // OpenClaw rejects MCP server entries inside `mcpServers` (the empty `[]`
    // field is still serialized and tolerated) and fails session/new on any
    // entry, so it must be the only BUILT-IN with `supports_mcp == false`.
    // Every other built-in (current and future) keeps it `true`, so a newly
    // added agent that wrongly opts out — or a regression flipping OpenClaw
    // back on — trips this assert. Custom agents are deliberately out of
    // scope: their flag is a stored, user-set declaration
    // (`CustomAgentDef::supports_mcp`), so a registry hydrated by another test
    // may legitimately hold an opted-out one.
    #[test]
    fn only_builtin_openclaw_opts_out_of_mcp() {
        for agent_type in builtin_acp_agents() {
            let meta = get_agent_meta(agent_type);
            assert_eq!(
                meta.supports_mcp,
                agent_type != AgentType::OpenClaw,
                "unexpected supports_mcp for {agent_type:?}"
            );
        }
    }
}
