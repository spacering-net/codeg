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
        /// archive into the cache. On Windows a bare command (every built-in)
        /// gets `.exe` appended, while one that already ends in `.exe` (a
        /// custom agent's registry entry) is used as-is: see
        /// `binary_cache::executable_file_name`.
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
    /// An agent codeg never installs or pins: the vendor ships it only through
    /// an installer of its own (a signed `.dmg`, an `.msi`, a shell script that
    /// also wires up shell integrations), which the binary cache cannot
    /// reproduce. The one supported install is the user's, found on PATH the
    /// way [`AgentDistribution::Binary`]'s system fallback finds a CLI — PATH,
    /// then `~/.local/bin`, then [`binary_system_dirs`] — and the Settings page
    /// points at `install_url` instead of offering an Install button. Its
    /// version is whatever `<cmd> --version` reports.
    ///
    /// UPGRADES go through the vendor's own updater when it has one
    /// (`update_args`), so the copy the user's terminal runs and the copy codeg
    /// launches stay one and the same install.
    System {
        /// Command name on PATH.
        cmd: &'static str,
        args: &'static [&'static str],
        env: &'static [(&'static str, &'static str)],
        /// The vendor's own install instructions.
        install_url: &'static str,
        /// Arguments that make `cmd` update ITSELF in place without prompting,
        /// or `None` when the CLI has no such command (no Upgrade button then).
        update_args: Option<&'static [&'static str]>,
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
            // Nothing is pinned: the user's own install is the only version.
            AgentDistribution::System { .. } => None,
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
            AgentDistribution::Uvx { .. } | AgentDistribution::System { .. } => false,
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

/// Where the Settings page sends a user who has no `kiro-cli` yet. The CLI's
/// own `/docs/cli/installation/` redirects here.
const KIRO_INSTALL_URL: &str = "https://kiro.dev/docs/getting-started/installation/";

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

/// The twenty built-in agents. Excludes user-registered custom agents — use
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
        AgentType::Kiro,
        AgentType::ZCode,
        AgentType::Trae,
        AgentType::CommandCode,
        AgentType::MiniMaxCode,
    ]
}

/// Every agent codeg can currently drive: the twenty built-ins followed by
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
        AgentType::Kiro => "kiro-cli",
        // Keep the pre-integration custom:zcode-acp registry and history distinct.
        AgentType::ZCode => "codeg-zcode-acp",
        // TRAE CLI is not in the ACP registry, so before it was built in it ran
        // only as a hand-registered custom agent under an id the user picked
        // (`trae-cli`, `traecli`, …). Prefixed so none of those can collide
        // with the built-in: a custom definition under a built-in registry id
        // stops launching (`custom_registry::validate`), and the id also names
        // the ACP transcript directory both would write to.
        AgentType::Trae => "codeg-trae-cli",
        // Not in the ACP registry either, so the same reasoning as TRAE CLI:
        // a hand-registered custom Command Code most likely sits under the
        // package or bin name (`command-code`, `commandcode`, `cmd`, …).
        AgentType::CommandCode => "codeg-command-code",
        // Preserve pre-existing hand-registered mcode / minimax-code agents.
        AgentType::MiniMaxCode => "codeg-minimax-code",
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
        "kiro-cli" => Some(AgentType::Kiro),
        "codeg-zcode-acp" => Some(AgentType::ZCode),
        "codeg-trae-cli" => Some(AgentType::Trae),
        "codeg-command-code" => Some(AgentType::CommandCode),
        "codeg-minimax-code" => Some(AgentType::MiniMaxCode),
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
/// All but three of the built-ins distribute the vendor's own CLI (or, for
/// Antigravity, the vendor's own ACP server), so a user's existing global
/// install is found by the launch gate as-is. Claude Code and
/// Codex wrap their CLIs through ACP adapters: neither `claude` nor `codex` speaks ACP, so codeg
/// installs a separate adapter package (`claude-agent-acp` / `codex-acp`,
/// maintained by the Agent Client Protocol org) whose command name has nothing
/// to do with the vendor CLI's. That mismatch is the single most reported
/// confusion ("I have claude installed, why does codeg say it isn't?"), so
/// preflight and diagnostics probe the vendor CLI too and explain the split.
/// ZCode uses a community adapter which requires the official ZCode runtime.
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
/// own CLI. ZCode also requires a separate community adapter.
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
        AgentType::ZCode => Some(AcpAdapterRelation {
            native_cmd: "zcode",
            native_label: "ZCode CLI",
            shared_config_dir: "~/.zcode",
            extra_dirs: &[".local/bin"],
            docs_url: "https://github.com/william0wang/zcode-acp",
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
///
/// Npx agents are not listed here: their native-installer fallback (Grok's
/// `~/.grok/bin`) is `npx_native_install` in `commands/acp.rs`.
pub fn binary_system_dirs(agent_type: AgentType) -> &'static [&'static str] {
    match agent_type {
        AgentType::OpenCode => &[".opencode/bin"],
        #[cfg(not(windows))]
        AgentType::MiniMaxCode => &[".minimax-code/bin"],
        #[cfg(windows)]
        AgentType::MiniMaxCode => &[".minimax-code"],
        _ => &[],
    }
}

/// Docs anchor explaining the adapter/vendor-CLI split. The zh mirror carries
/// the same explicit `{#acp-adapters}` anchor.
const ACP_ADAPTER_DOCS_URL: &str = "https://docs.codeg.app/guide/supported-agents#acp-adapters";

/// The oldest pi the pinned pi-acp can open a session with. pi-acp 0.0.34 asks
/// pi for the current model's thinking levels (`get_available_thinking_levels`,
/// new in pi 0.81.0) on every `session/new` and `session/load`, and fails the
/// open without it. Move it with the pin (see `AgentType::Pi` below); the
/// settings panel warns with the same value (`PI_MIN_RUNTIME_VERSION` in
/// `src/lib/pi-config.ts`, held equal by a test).
pub const PI_MIN_RUNTIME_VERSION: &str = "0.81.0";

/// The `@openai/codex` the pinned codex-acp drives (`AgentType::Codex` below),
/// for when the installed copy's own package.json cannot be read. A runtime
/// resolved to this value is marked unconfirmed (`codex_runtime`), so it never
/// counts as the version a catalog was checked against. Move it with the pin.
pub const CODEX_NESTED_VERSION_FALLBACK: &str = "0.165.0";

/// The npm package the built-in Claude Code entry runs — and the name the
/// adapter reports as `agentInfo.name` at `initialize`, which is its
/// `packageJson.name` (read from the 0.58.1 to 0.98.0 sources). A custom agent
/// whose running adapter reports exactly this name follows the Claude Code
/// steering policy (`connection.rs::steering_policy_agent`).
pub const CLAUDE_AGENT_ACP_PACKAGE: &str = "@agentclientprotocol/claude-agent-acp";

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
/// shipped `_session/steering` without the opt-in from 1.1.6 through 2.3.0;
/// 2.4.0 implements it (see the codex arm below).
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
        //
        // Claude Code 2.1.286 (claude-agent-acp 0.85.0) narrows the abort to
        // generation: a steer that lands during a foreground TOOL call moves
        // the tool to the background and may join the running cycle (one result
        // naming both messages). The prompt still settles on the result that
        // answers the steer — measured live; see the claude entry's (qq) for
        // what moving the tool cost codeg.
        AgentType::ClaudeCode => Some("0.65.0"),
        // 2.4.0 (#593) adds the opt-in: when no turn can take the steer, the
        // adapter answers `{outcome:"promptRequired", reason:"noRunningTurn"}`
        // at once, consumes nothing and starts no turn. That includes the
        // window where the prompt waits on its plan-review card. Up to 2.3.0
        // the opt-in was ignored: an idle steer started a detached turn
        // (`startedNewTurn`), and one sent during plan review was answered only
        // after the prompt ended, which wedged codeg's connection loop (the
        // card's answer queues behind the inline await).
        //
        // The ACTIVE path keeps the owning prompt in flight on 2.3.0 and
        // 2.4.0 alike: `turn/steer` answers `injected` within a few ms, the
        // steer preempts the streaming response (codex 0.164 turned
        // `instant_interrupt` on by default), the steered work runs in the
        // same turn, and the prompt answers after it. A steer sent before
        // codex reports the prompt's turn waits for the turn to start (about
        // 40 ms) and is injected. Measured live over stdio with codeg's
        // `clientCapabilities` against a scripted Responses server: idle,
        // plan review, a running turn, the instant after a prompt, and an
        // open approval. The floor is 2.4.0 itself; 2.3.1-preview.* builds
        // stay on the pull channel. An open approval needs one more rule,
        // see [`steering_waits_out_open_permission`].
        AgentType::Codex => Some("2.4.0"),
        _ => None,
    }
}

/// Whether a live-feedback note that would be steered natively goes to the
/// next-turn queue instead while a permission card is open on the session
/// (`ConnectionManager::submit_feedback_native` answers `NoActiveTurn`, the
/// reroute the composer already handles).
///
/// codex holds a steer injected during an approval as the turn's pending
/// input until the model's next step. Its command and file-change approvals
/// offer `cancel` ("No, and tell Codex what to do differently"), which aborts
/// the turn and drops that input unseen. Measured on codex-acp 2.4.0 with
/// codex 0.165.0: a steer during an exec approval came back `injected` in
/// 4 ms. After "Yes" the note reached the next model request. After the
/// `cancel` answer the prompt ended `cancelled`, and neither the rollout nor
/// any later request carried the note, which codeg had already recorded as
/// delivered. Queued, the note becomes the next prompt, which is what that
/// button asks the user for. The pull channel needs no such rule: an unread
/// note outlives its turn and offers to be resent.
///
/// Only codex is known to drop an injected note this way, so only codex waits.
pub fn steering_waits_out_open_permission(agent_type: AgentType) -> bool {
    matches!(agent_type, AgentType::Codex)
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
        AgentDistribution::Npx { cmd, args, .. }
        | AgentDistribution::Binary { cmd, args, .. }
        | AgentDistribution::System { cmd, args, .. } => launch_spec_uses_cursor_acp(cmd, args),
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
            // "Summary" toggle; the history divider opens onto the same summary,
            // folded in by `parsers::claude` from the transcript's continuation
            // record.
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
            //
            // 0.81.2 + 0.82.0 are four upstream changes (#1170, #1173, #1153,
            // #1179) and move no dependency that reaches codeg:
            // `@anthropic-ai/claude-agent-sdk` stays 0.3.280 (CLI 2.1.280), the
            // ACP SDK 1.5.0, `engines.node` ">=22"; the one new runtime
            // dependency is `diff` (the adapter now builds Git patches). The
            // effect on codeg was MEASURED rather than read: both versions' own
            // scenario harness (`src/tests/acp-scenarios`, a mocked SDK, 40
            // scenarios) re-run with codeg's exact `clientCapabilities`, and the
            // two recordings diffed frame by frame.
            //
            // (ii) **The AIR tool-call contract** (#1153) — BREAKING for codeg,
            // because codeg is an AIR client: the adapter switches the whole
            // contract on the mere presence of
            // `clientCapabilities._meta.jetbrains.air` (`isAirClient`), which
            // codeg sends for `sessionFailure` / `asyncTasks` /
            // `recommendedValue`. Plain and Zed clients keep the old fields.
            // For an AIR client, and where codeg absorbs it
            // (`crate::acp::air_contract` unless named otherwise):
            //   * a `tool_call_update`'s `_meta` carries only the keys that
            //     changed, per key inside `claudeCode` and `jetbrains.air`, so
            //     `toolName` / `parentToolUseId` ride the OPENING frame only.
            //     Merged per call by `ToolCallMetaLedger`; codeg replaces a
            //     call's `_meta` whole, so the first partial update used to
            //     un-nest a subagent's child from its capsule.
            //   * `claudeCode.title` / `subagent` / `skill` / `skillPath` go to
            //     NO client; AIR reads `jetbrains.air.commandTitle` /
            //     `subagent` / `skill {name, path}`. Re-derived under the old
            //     names (`translate_air_meta`).
            //   * `rawInput` loses the file text — Edit keeps `{file_path,
            //     replace_all}`, Write `{file_path}` — which then lives only in
            //     the diff block of the same frame. Every edit card reads the
            //     input, so `claude_complete_file_edit_input` (connection.rs)
            //     rebuilds it from that block.
            //   * the permission request's `toolCall` shrinks to `{toolCallId,
            //     title, rawInput}` — an update to merge into the call the
            //     client already holds — and the request-level record moves to
            //     `_meta.jetbrains.air.permission`. Read from both homes
            //     (`permission_record`); the edit text is filled from the live
            //     call on the frontend (`fillStrippedEditInput`).
            //   * a Read, and a Grep/Glob that names a path, completes with NO
            //     result text ("AIR shows … the list of viewed files"). codeg
            //     already subscribes to the raw SDK stream
            //     (`emitRawSDKMessages`), where the `tool_result` arrives just
            //     before the completion: `claude_viewed_results` fills a BARE
            //     completion from it, with the transcript parser's own text
            //     extraction, so live and reloaded cards read the same.
            //   * `rawOutput` goes out only when no other field carries the
            //     result, and the first `tool_call` no longer sends `rawInput:
            //     {}`. Nothing to do: the cards read `content` either way.
            //   * `_meta.contextCompaction` → `_meta.jetbrains.air.
            //     contextCompaction`, on `compaction_update` too, and a completed
            //     update no longer repeats the summary its chunks carried.
            //     Hoisted in `session_compaction_event`; an absent summary keeps
            //     the streamed one.
            //   * the goal extension (`initialize._meta.goal`,
            //     `session_info_update._meta.goal`) → `_meta.jetbrains.air.goal`.
            //     `init_advertises_goal` / `session_info_goal_value` read both.
            //   * mode `_meta.kind`, the `_askUserQuestionCustomAnswer` marker
            //     (→ `customAnswer`) and `diffStats` move or go. codeg maps no
            //     mode meta, never reaches claude's elicitation, and never read
            //     `diffStats`; `question.rs` reads both marker spellings anyway.
            //   Free with it: a subagent's streamed text is no longer re-sent in
            //   full after its chunks (codeg's capsule transcript showed that
            //   paragraph twice), and a plan that repeats the previous one is
            //   not re-sent.
            //
            // The new opt-in AIR capabilities stay OUT for claude:
            // `diffPatch` puts the approval preview patch in the PERMISSION
            // REQUEST, whose `oldText: null` placeholders the permission card
            // would read as an emptied file, and shows a live Write no diff at
            // all until approval; `rawInputRendering` and `planFile` remove the
            // description / prompt / plan copies codeg's cards render.
            //
            // (jj) #1179: a sign-in failure is ONLY the ACP `authRequired`
            // rejection now — no AIR `access` record with a `login` action,
            // which is where the Sign in button on codeg's notification came
            // from. The `turn_failed_auth_required` verdict carries that button
            // itself now (frontend `notifyTurnFailure`), for every agent.
            //
            // (kk) 0.81.2, both free: #1170 continues a clear-context plan
            // approved in a background followup instead of settling the held
            // turn (the plan was dropped with the mode still `plan`); #1173
            // announces a resumed native subagent generation on time — native
            // subagent sessions stay unadopted, so inert here.
            //
            // 0.83.0 + 0.84.0 are two upstream changes (#1186, #1189), both
            // dependency bumps: `@anthropic-ai/claude-agent-sdk` 0.3.280 →
            // 0.3.283 → 0.3.284, i.e. the bundled CLI 2.1.280 → 2.1.284; the
            // ACP SDK 1.5.0 → 1.5.1; `engines.node` still ">=22". The ACP
            // traffic codeg reads was measured the same way as for 0.82.0 and
            // did not move: the adapter's scenario harness (40 scenarios, mocked
            // SDK) re-run on both tags with codeg's exact `clientCapabilities`,
            // and with each opt-in AIR capability added, is byte-identical, and
            // so is `initialize` minus the version. What moved is the CLI behind
            // it — including the raw SDK stream codeg also reads, see (nn) —
            // measured live over stdio with no model call (a `UserPromptSubmit`
            // hook blocks the prompt).
            //
            // (ll) **Sonnet 5.5** (`claude-sonnet-5-5`, CLI 2.1.284): the
            // default `sonnet` alias and `latest_per_family.sonnet` move to it —
            // a natively 1M-context model whose default effort is `medium`. The
            // per-provider Sonnet aliases (Bedrock / Vertex / Foundry …) are
            // unchanged from 2.1.280. The picker's `sonnet` / `sonnet[1m]` rows
            // keep their ids and simply resolve to 5.5 (measured through an
            // `ANTHROPIC_BASE_URL` gateway), so there is no saved pick to
            // migrate. The settings panels' model placeholders name it.
            //
            // (mm) The Opus row can drop its `[1m]` spelling (CLI 2.1.283): the
            // adapter's own live test records `opus[1m]` "Opus (1M context)"
            // becoming plain `opus` "Opus" (Opus is natively 1M), while the same
            // gateway on 2.1.284 still lists `opus[1m]` (measured) — the CLI
            // builds either row depending on the account. A pick saved
            // as `opus[1m]` would then be screened out by
            // `config_option_rejects_value` on every connect, landing the user
            // on the default model; `heal_retired_context_lane_pick` replays it
            // as `opus` instead, off the agent's own list.
            //
            // (nn) Plugin load failures (CLI 2.1.283, `system/init`'s
            // `plugin_errors`) have "no ACP surface": the adapter only writes
            // them to its stderr. codeg reads them off the raw SDK stream it
            // already takes (`claude_plugin_load_failures`) and raises one
            // warning per new list. Measured: an ENABLED plugin that is merely
            // absent — an unknown marketplace plugin, or the `<id>@local` MCP
            // gate markers `commands::mcp` writes into `enabledPlugins` — is not
            // reported; a plugin that exists and fails to load (bad manifest,
            // hooks that do not parse, a missing path) is.
            //
            // (oo) ⚠️ An accepted cost, fixable only upstream. #1186 refines a
            // guessed context window with a BACKGROUND `getContextUsage()` after
            // `session/new` and after every model switch. The window is a free
            // fix (the context ring stops reading 200K until the first result),
            // but the call takes the default `detail: 'full'`, which sends a
            // burst of `count_tokens` requests (about 20 per call, counted at a
            // local gateway; 0.82.0 sends none), and SDK control requests are
            // serialized — so the NEXT control request waits for it, and so
            // does a prompt. Measured with codeg's connect-time replay shape:
            // the first `set_config_option` after `session/new` took ~0.5 s
            // (fast local gateway) / ~2 s (a remote gateway) instead of ~0.03 s,
            // the effort replay after a model switch the same again, and a
            // first prompt sent right after `session/new` 2.2–2.5 s instead of
            // 0.05 s; against a gateway that never answers `count_tokens`, both
            // were still blocked when the probe gave up (90–120 s).
            // `getContextUsage({ detail: "summary" })` returns the same
            // `rawMaxTokens` in ~0.1 s with no request at all (measured on both
            // gateways), so the fix is a one-liner in the adapter. codeg has no
            // lever on the call: the adapter is a global npm install, and the
            // CLI offers no setting for the default `detail`. Reported upstream
            // with a repro as agentclientprotocol/claude-agent-acp#1192; check
            // it on the next bump.
            //
            // (pp) Inert: managed `deniedModels` now also filters the picker
            // (#1186); the adapter ignores the new `mcp_tool_listing` stream
            // event; `conversation_reset` gains `trigger` / `user_message_uuid`
            // / `timestamp` and `system/init` gains `view_mode` — codeg reads
            // none of those frames.
            //
            // 0.85.0 is three upstream changes (#1208, #1210, #1211). The
            // bundled `@anthropic-ai/claude-agent-sdk` goes 0.3.284 → 0.3.286,
            // i.e. CLI 2.1.284 → **2.1.286**; the ACP SDK stays 1.5.1 and
            // `engines.node` ">=22". As on 0.84.0, the adapter's own traffic did
            // not move for codeg — its scenario harness (40 scenarios, mocked
            // SDK) re-run on both tags with codeg's exact `clientCapabilities`
            // is byte-identical, and so is `initialize` minus the version — but
            // the CLI behind it did. (qq) and (rr) were measured live over stdio
            // against a local fake Anthropic API (no model call), 0.84.0 and
            // 0.85.0 side by side.
            //
            // (qq) **A steer no longer waits on a foreground tool** (CLI
            // 2.1.286, #1211). codeg steers claude natively, and a
            // `_session/steering` that lands while a foreground Bash, MCP or
            // Agent call runs now moves that call to the background and lets the
            // steer through. 2.1.284 held a Bash steer until the command
            // finished, and interrupted an MCP call outright. Measured: a 10 s
            // `sleep` steered after 1.5 s completes at once with "Command was
            // moved to the background (ID: …) so that a message that arrived
            // while it was running can reach you; it was not interrupted. …" and
            // `_meta.jetbrains.air.asyncTasks.backgrounded`; an
            // `async_task_spawned` (shell) takes over, the steer is answered and
            // the prompt settles; when the command exits, the CLI runs a turn of
            // its own on the task notification. Two consequences for codeg:
            //   * The command card printed that notice as its output.
            //     `parseBackgroundLaunch` (frontend) now knows all four wordings
            //     the CLI acknowledges a background command with —
            //     `run_in_background`, Ctrl+B, a steer, a timeout — so the card
            //     shows its Background badge and one line instead, live and from
            //     history alike.
            //   * An MCP call moves the same way ("MCP tool "…" was moved to the
            //     background as task …"), and codeg's own blocking
            //     `ask_user_question` is one. Steering while its card was up left
            //     the question parked past the turn: the card gone with the
            //     turn, the one-per-connection slot held, every later ask on the
            //     connection declined. The Steer arm of `run_conversation_loop`
            //     now declines a parked question before the steer goes out —
            //     what 2.1.284's interrupt amounted to — and every turn end sweeps
            //     whatever is still parked. Only a main-thread MCP call moves,
            //     never a subagent's, and in an SDK session only on a steer
            //     unless the user's environment sets `CLAUDE_AUTO_BACKGROUND_TASKS`,
            //     which adds a timer (120 s by default); all three read from the
            //     2.1.286 binary.
            //   A steered Agent call answers with the `async_launched` shape a
            //   `run_in_background` agent always had (read from the binary).
            //
            // (rr) The gateway model picker loses its `[1m]` rows. CLI 2.1.285's
            // changelog: sessions behind a custom `ANTHROPIC_BASE_URL` "use the
            // 1M context window of models that have one (Opus 4.7+, Sonnet 5+,
            // Fable)". Measured through one gateway: 0.84.0 lists `opus[1m]`,
            // Fable, `sonnet`, `sonnet[1m]`, `haiku` and recommends `opus[1m]`;
            // 0.85.0 lists `opus`, Fable, `sonnet`, `haiku` and recommends
            // `opus`. `heal_retired_context_lane_pick` already replays a saved
            // `[1m]` pick as its plain twin — the same model on the same 1M
            // window now — and a test pins the measured list. The CLI's advice
            // for a gateway that stops at 200K is `/autocompact 200k`.
            //
            // (ss) Inert here, each checked:
            //   * #1208 hides other agents' and sessions' messages (`is_meta`
            //     user records whose `origin.kind` is peer, channel, observer,
            //     observer-activity or slack-ping) from `session/load` replay.
            //     codeg never renders claude's replay (it resumes, and discards
            //     a load's), and `parsers::claude` skips every `isMeta` record;
            //     the 2.1.286 binary writes peer and channel messages with
            //     `isMeta: true`.
            //   * #1208's other half keeps a settings-enabled `ultracode` on
            //     across the adapter's effort applies; codeg writes neither key.
            //   * #1210 sends the root `_askUserQuestionCustomAnswer` marker to
            //     AIR again. codeg advertises no elicitation to claude, so the
            //     adapter disallows AskUserQuestion here.
            //   * SDK 0.3.286: a `system/session_title_changed` raw frame (new
            //     in the binary, not seen on the probes; no consumer, and
            //     `_claude/sdkMessage` stays quiet), `usage.fallback_credit`
            //     (usage is read by key), `provider_not_allowed` as a startup
            //     failure (the managed-only `allowedProviders`), Artifact
            //     pin/unpin (generic card). A background Bash now stops at its
            //     `timeout` (30 min by default, 2 h at most), and the task
            //     notification says it "stopped after reaching its background
            //     time limit" (read from the binary).
            //   * The hand-back header (w), `SDKAPIRetryMessage` and
            //     `latest_per_family` are unchanged in 2.1.286.
            // (oo) still holds: 0.85.0's background `getContextUsage()` still
            // takes the default `detail` (15 `count_tokens` on a measured
            // `session/new`, the same as 0.84.0), and the fix (#1201) is still
            // open.
            //
            // 0.85.1 is four upstream changes (#1212, #1205, #1216, #1217) and
            // the ACP SDK 1.5.1 → 1.6.0. The Claude SDK stays 0.3.286, so the
            // CLI is the same 2.1.286 binary (byte-identical in both installs),
            // and `engines.node` stays ">=22". The scenario harness is again
            // byte-identical on both tags with codeg's `clientCapabilities`,
            // and so are `initialize` and `session/new` over stdio. The probes
            // below ran live against the local fake Anthropic API, 0.85.0 and
            // 0.85.1 side by side.
            //
            // (tt) #1212 fails a turn that ends `end_turn` while one of its
            // foreground tool calls never got a result. Read from the source:
            // each such call gets a `failed` update ("Claude ended the turn
            // without returning a result for this tool."), and with AIR session
            // failures negotiated the prompt settles `end_turn` carrying an
            // `internal_error` `sessionFailure` titled "Claude ended the turn
            // without returning results for tool calls: <ids>" — the generic
            // failure banner shows it like any other. No probe trips it: a
            // steered Bash or MCP call completes with its background notice
            // before the turn ends; a tool call cut off at the output limit gets
            // an `InputValidationError` result from 2.1.286; approving or
            // cancelling a plan answers `ExitPlanMode` (codeg is offered no
            // clear-context option); and a CLI killed mid-tool ends with "The
            // connection to Claude was lost.", as on 0.85.0. A steer that lands
            // while a tool call is still streaming does trip it, see (fff). The
            // transcript keeps no trace of the failure, so a reload shows such a
            // call with no result.
            //
            // (uu) #1205 restores background-task stops on `session/load`
            // replay instead of showing the `<task-notification>` as a prompt.
            // codeg never renders that replay, and `parsers::claude` already
            // hides those records and strips one embedded in a prompt. But a
            // background shell's notification names the `Bash` call that started
            // it in `<tool-use-id>` — the probes show it, and so do transcripts
            // from 2.1.257 on — and codeg's live settle path took every named
            // call for a sub-agent launch: it rewrote a background command's
            // card into the sub-agent lifecycle marker, which the command card
            // printed raw. Since 2.1.286 a steer that lands during a command
            // sends it to the background, so this hit whenever such a command
            // finished. The runtime store now rewrites launch cards only
            // (`applyBackgroundSettlementToTurns`).
            //
            // (vv) #1216 answers `session/close` without awaiting the interrupt
            // reply: a fresh session closed in 519 ms on 0.85.0 and 2 ms on
            // 0.85.1. codeg sends one close only, for the parent a fork leaves,
            // and never awaits its answer, so the parent's CLI just exits
            // sooner.
            //
            // (ww) #1217's draft ACP v2 is opt-in
            // (`CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1`) and routes by the protocol
            // version `initialize` asks for. codeg asks for 1; with the variable
            // set, a whole codeg turn is frame-for-frame the same.
            //
            // (oo) still holds on 0.85.1: 15 `count_tokens` per `session/new`,
            // and #1201 is still open.
            //
            // 0.86.0 moves the Claude SDK 0.3.286 → 0.3.287, i.e. CLI 2.1.286 →
            // **2.1.287**, and the ACP SDK 1.6.0 → 1.7.0; `engines.node` stays
            // ">=22". Most of its commits build the draft ACP v2 surface, which
            // stays opt-in (see (ww)); the rest add `/mcp` (#1218) and fix the
            // cancel, close and context-window paths. The scenario harness
            // re-run on both tags with codeg's exact `clientCapabilities`
            // differs in one frame, the same in all 40 scenarios:
            // `available_commands_update` now ends with the adapter's own `mcp`
            // entry. `initialize` is the same minus the version. The probes
            // below ran live against the local fake Anthropic API (no model
            // call), 0.85.1 and 0.86.0 side by side.
            //
            // (oo) is closed: #1258 has the background `getContextUsage` ask
            // for `detail: "summary"`, and a measured `session/new` sends no
            // `count_tokens` at all (15 on 0.85.1).
            //
            // (xx) **The Fable row is re-spelled `fable`** (CLI 2.1.287). Both
            // of the CLI's model-row builders now value a Fable row by the
            // family alias, as Opus, Sonnet and Haiku already were. Through a
            // gateway the row goes from `claude-fable-5-1` to `fable` under the
            // same name and description. A Fable pick codeg saved before is
            // `claude-fable-5-1`, which the selector no longer lists, so every
            // connect would have dropped it for the default model (Opus there).
            // `heal_respelled_model_pick` replays it as the one row that names
            // the same model, and a test pins the measured list.
            //
            // (yy) `/mcp` is answered in chat (#1218). The adapter advertises
            // its own `mcp` command (hint `[reconnect|enable|disable
            // [<server>|all]]`), replaces Claude Code's one-line summary with a
            // server list, and runs a reconnect, enable or disable through the
            // SDK control API, which 2.1.286 refused in an SDK session.
            // Measured: `/mcp` lists the probe server with its tool count, and
            // `/mcp reconnect probe` reconnects it. codeg's slash menu lists it
            // like any other command, and the reply renders as Markdown. The
            // transcript keeps only the command and Claude Code's own text, and
            // `parsers::claude` hides a local command with its output, so a
            // reload shows neither, as for `/usage`. A reconnect starts OAuth
            // only for a client with URL elicitation, which codeg does not
            // advertise.
            //
            // (zz) The main-thread `agent` option is back (#1250, undoing
            // 0.77.0's #1112). With a custom agent defined (an `agents/*.md` of
            // the user, the project or a plugin), `session/new` lists `agent`
            // with `default` and each custom agent, and a pick applies that
            // agent's prompt from the next turn (measured: the persona reaches
            // the system prompt). codeg renders it as any other select and
            // replays a saved pick through `config_option_rejects_value`, so an
            // agent no longer defined is skipped. With no custom agent the
            // option is absent, and an `agent` pick saved before 0.77.0 is still
            // sent and refused ("Unknown config option: agent", logged).
            //
            // (aaa) A resume continues in the transcript's permission mode
            // (#1218): the mode of the last prompt, unless a plan was exited
            // after it. Measured: set `acceptEdits`, prompt, resume in a new
            // process — 0.85.1 comes back in `default`, 0.86.0 in `acceptEdits`.
            // codeg still sets the saved composer mode at connect when it
            // differs (`apply_preferred_session_options`), so only a user who
            // never picked a mode sees the transcript's.
            //
            // (bbb) Cancel and close (#1228, #1229, #1242, #1243). A cancel now
            // drops the user messages it abandons from Claude Code's queue
            // before the interrupt, so they no longer run after all. Measured
            // with a prompt queued behind a slow turn: 0.85.1 still sent it to
            // the model after the cancel, 0.86.0 did not. codeg never queues a
            // prompt behind a running turn (the `turn_in_flight` gate), so what
            // it gains is a steer the CLI still holds when the user stops (read
            // from the source); a steer the CLI has already taken in runs on
            // both, as measured. `session/close` now answers after the turns it
            // cancels have ended (5 s at most); codeg's one close is for an idle
            // fork parent and is never awaited. Read from the source: a held
            // turn cancelled mid-follow-up now ends at its interrupt's idle,
            // after the follow-up's flushed output, and a force-cancel that
            // fires while an update is being sent no longer leaves the turn
            // open.
            //
            // (ccc) Nothing to change in codeg, each checked:
            //   * #1241 counts a subagent's permission request as the turn
            //     waiting on the user. Over v1 that only makes a steer sent
            //     while such a card is open non-interrupting, as the main
            //     thread's cards already did.
            //   * #1252 reports an exit code only when the result states one,
            //     but an AIR client keeps the numbers it always got: 1 for a
            //     failed or interrupted command, else the code, else 0.
            //   * An AIR skill command now carries
            //     `_meta.jetbrains.air.{kind: "skill", skillPath}`. Not adopted:
            //     the adapter resolves SKILL.md only under the session cwd and
            //     the home directory, so plugin and bundled skills never carry
            //     it, and a marker in the slash menu would split codeg's skills
            //     into two looks. (0.99.1 marks them all; adopted, see (uuuu).)
            //   * Write/Edit diffs and permission titles change only for the v2
            //     surface or a `diffPatch` client, and codeg is neither for
            //     Claude.
            //   * CLI 2.1.287 offers MCP servers on the 2025-11-25 protocol
            //     `elicitation: {form, url}` where 2.1.286 sent `{}`. codeg-mcp
            //     answers 2024-11-05 and reads no client capability, and a probe
            //     server with the same handshake still lists its tools.
            //   * A `context: fork` skill typed as `/<skill>` now streams its
            //     fork, parented to a synthetic `forked-command-<skill>` id that
            //     no tool call carries. codeg drops parented text whose parent
            //     never arrived, and shows such tool calls as ordinary cards
            //     (under an Agent card instead while one is still running, by
            //     the positional fallback); the main thread's answer still
            //     arrives once, and the transcript is unchanged.
            //   * The changelog's "a message sent with priority now no longer
            //     cancels a running web fetch or web search" does not reach a
            //     `_session/steering`: on both CLIs a steer still cancels
            //     WebFetch (`nonExecutionKind: "interrupted"`) and ends
            //     WebSearch with no results.
            //   * A 300 KB MCP result is persisted and reported in the same
            //     `<persisted-output>` form as on 2.1.286.
            //   * The hand-back header (w), `api_retry` and `latest_per_family`
            //     are unchanged in 2.1.287.
            //
            // 0.87.0 changes the adapter only (#1249, #1233; #1260 bumps dev
            // dependencies). 0.88.0 (#1276) moves the Claude SDK 0.3.287 →
            // 0.3.293, i.e. CLI 2.1.287 → **2.1.293**. The ACP SDK stays 1.7.0
            // and `engines.node` stays ">=22". 0.88.0's scenario harness, run
            // on the sources of both tags with codeg's exact
            // `clientCapabilities`, is byte-identical in all 40 scenarios; the
            // Monitor scenario it replaced differs as (eee) says. The probes
            // below ran live against the local fake Anthropic API (no model
            // call), 0.86.0 and 0.88.0 side by side.
            //
            // (ddd) **A prompt folded into a turn Claude Code started itself
            // now settles** (#1233). When a background task's notification
            // starts a turn and the user's prompt arrives while that turn runs
            // a tool, the CLI folds the prompt into the running turn and
            // answers it with that turn's result. The transcript records the
            // prompt as a `queued_command` attachment, which `parsers::claude`
            // renders as a user turn (`queued_human_prompt`) and the background
            // watcher matches against the prompts codeg sent, so the rest of
            // the turn stays off the overlay. 0.86.0 took the result for an
            // autonomous one and left the prompt open: measured, no answer in
            // 45 s, so codeg's turn kept spinning. 0.88.0 settles it
            // (`end_turn`, 4.8 s after the send). A prompt that arrives while
            // the autonomous turn is still waiting on the model is not folded
            // on either version; it runs as its own turn afterwards.
            //
            // (eee) **Monitor tasks leave the async-task channel** (#1249;
            // 0.98.0 brings them back as monitors, see (mmmm)). The
            // task of a `Monitor` call (the SDK reports it as `local_bash`) and
            // a `local_monitor` task are no longer published. codeg's task strip
            // therefore lists no running monitor and offers no stop for one,
            // and codeg cannot bring the control back:
            // `_session/async_task/stop` refuses a task the adapter does not
            // publish. Measured on 0.86.0's Monitor scenario: 0.86.0 sends
            // `async_task_spawned` and two progress frames, 0.88.0 neither. The
            // rest of #1249 stays inside the adapter: a task now comes only from
            // structured data (a result's `backgroundTaskId` or the SDK's task
            // events), never from result text; a late frame of an earlier run
            // (`run_id`, SDK 0.3.292+) is dropped; and a subagent's task keeps
            // reporting to the subagent's session after the subagent finished.
            // codeg's Bash card reads the launch text itself
            // (`parseBackgroundLaunch`), so a backgrounded command looks the
            // same.
            //
            // (fff) **A steer during a streamed tool call no longer fails the
            // turn** (#1249). A steer that lands while a `tool_use` is still
            // streaming cuts that stream, and the CLI starts over with the
            // steer, so the half-streamed call never runs. 0.86.0 then failed
            // the turn through (tt): the prompt settled `end_turn` with an AIR
            // `sessionFailure` titled "Claude ended the turn without returning
            // results for tool calls: <id>" (actions retry and new session),
            // and codeg's failure banner showed it over a turn that went fine.
            // 0.88.0 reports no failure. It closes only that card as `failed`,
            // with "Claude stopped this tool call before it ran." The call never
            // reaches a complete assistant message, so the transcript has no
            // trace of it and a reload drops the card.
            //
            // (ggg) **Haiku 5.5** (`claude-haiku-5-5`, CLI 2.1.293) becomes the
            // first-party Haiku: `latest_per_family.haiku` moves to it from
            // `claude-haiku-4-5`, which stays the per-provider default (Bedrock,
            // Vertex, Foundry, Mantle and the catalog's `gateway` key). Through
            // an `ANTHROPIC_BASE_URL` gateway the `haiku` row keeps its value
            // and now reads "Haiku 5.5 · Fastest for quick answers ·
            // $0.10/$0.50 per Mtok ($0.50/$2.50 for prompts over 100k)", so a
            // saved `haiku` pick replays as is. The model is natively 1M and
            // takes effort: with `haiku` picked, 0.86.0 drops the `effort`
            // option and 0.88.0 keeps low to max. The settings panels' Haiku
            // placeholders name it, and the shared history gauge
            // (`parsers::infer_context_window_max_tokens`) now sizes it and the
            // other natively 1M Claude models at 1M.
            //
            // (hhh) **Tool inputs** (CLI 2.1.290, 2.1.292). Grep accepts
            // `file_path` for `path`, through the same `coerceInput` hook (bb)
            // found for Write and Edit (read from the 2.1.293 binary): the CLI
            // repairs only the copy it runs (`path` from a non-empty
            // `file_path` when `path` is absent, a repeat dropped), while the
            // stream, `rawInput` and the JSONL keep the model's spelling, and
            // the result gains "Note: Grep's parameter for where to search is
            // named `path`. …", which codeg's search parser keeps as a note.
            // `canonical_file_tool_input` makes the same repair, so the search
            // card shows the path. The native CLI offers no Grep tool by
            // default (it searches through Bash), so no probe reached it and
            // few setups will. The
            // Agent tool takes `effort`, and WebFetch takes `offset` to read on
            // past 100,000 characters. The adapter adds both to its own titles,
            // which codeg does not show, so codeg's Agent and WebFetch cards
            // read them from `rawInput`.
            //
            // (iii) **MCP handshake** (CLI 2.1.292). A stdio server is first
            // offered protocol 2026-07-28 through a `server/discover` probe, with
            // up to 3 s to answer before the 2025-11-25 `initialize`. codeg-mcp
            // answers it at once with -32601 (method not found), and the CLI
            // falls back at once. Measured with the real binary: `initialize`
            // follows 6 ms after the probe, and `session/new` takes as long as
            // on 0.86.0.
            //
            // (jjj) Nothing to change in codeg, each checked:
            //   * A resume and a load both come back in plan mode after a plan
            //     mode prompt, on both versions.
            //   * An async Agent launch keeps its result text; the structured
            //     result adds `canContinueAgent: true`.
            //   * `latest_per_family` keeps Fable 5.1, Opus 5.5 and Sonnet 5.5,
            //     and the Fable row keeps the value `fable`.
            //   * 2.1.292 honours `NO_PROXY` for the CLI's own sign-in and
            //     policy requests, so the bypass list codeg exports with its
            //     proxy setting now reaches them too.
            //
            // 0.89.0 changes the adapter only: the Claude SDK stays 0.3.293
            // (CLI 2.1.293), the ACP SDK moves 1.7.0 → 1.8.0 and
            // `engines.node` stays ">=22". Each tag's own scenario harness, run
            // with codeg's exact `clientCapabilities`, is byte-identical in all
            // 40 scenarios apart from `initialize`, whose AIR capability list
            // gains "customInstructions" (codeg reads nothing off that list).
            // A live conversation against the local fake Anthropic API (a new
            // session, a Bash turn, then resume and load in fresh processes)
            // matches 0.88.0's frame for frame apart from timing.
            //
            // (kkk) **Archived titles** (#1268). JetBrains AIR archives a
            // session by appending its title again as `[archived] <title>` (a
            // `custom-title` and an `agent-name` record). The adapter now
            // publishes such a title to an AIR client, which codeg is, without
            // the marker, while the transcript keeps it: measured live, 0.88.0
            // publishes "[archived] Probe title" and 0.89.0 "Probe title" (the
            // prefixed one still to a client that is not AIR). codeg's two
            // title producers, the wire and the transcript, would then disagree
            // and the sidebar row flip between them, so both read a title
            // through `parsers::claude::displayed_session_title`, which drops
            // the marker by AIR's rule.
            //
            // (lll) The session index (`sessionIndex`, #1268: an indexed
            // `session/list`, `_session/rename` / `archive` / `unarchive` and a
            // pushed `_session/list/subscribe`) is not adopted. It lives inside
            // a running adapter, while codeg's list is read offline from the
            // transcripts, for every agent, and must work with none running.
            // Undeclared it is inert: a live trace shows the same one settings
            // watcher as 0.88.0, no timer and no extra scan of the projects
            // directory, about 0.6 MB more heap, and the new methods answer
            // -32601. Without it an AIR client's `session/delete` ARCHIVES
            // (appends the title records above and keeps the transcript) and
            // `session/list` hides archived sessions; codeg sends neither.
            //
            // (mmm) Custom instructions (#1177: `_meta.jetbrains.air.
            // customInstructions` on `session/new`, appended to the
            // `claude_code` preset, honoured from any client) are not adopted:
            // no codeg surface supplies session-level instructions. Measured
            // live, CLI 2.1.293 freezes a session's system prompt at its first
            // model request (a `prompt_snapshot` attachment replayed on every
            // resume, load and fork, and across a `/compact`), so instructions
            // sent later never apply; 0.88.0's CLI does the same.
            // `_meta.systemPrompt` replaces them outright and is the knob to
            // reach for if a feature ever needs one: it also works on 0.88.0
            // and takes `snapshot: false`.
            //
            // (nnn) The ACP SDK 1.8.0 checks `session/new` / `load` / `resume`
            // strictly: a malformed `mcpServers` entry (a stdio server without
            // `args` or `env`, an http one without `headers`, `env` as an
            // object) or a non-string `additionalDirectories` item now fails the
            // request with -32602 where 0.88.0 dropped it. codeg builds its
            // entries through the Rust crate's typed constructors, which always
            // write those fields, and they pass on both versions.
            //
            // (ooo) Nothing else reaches codeg. `session/close` of a session
            // that is not loaded answers `{}` instead of -32603
            // (`close_forked_parent` only logs either way). The message drain
            // yields to the event loop every 8 ms: timing only, and a
            // 30,000-delta flood with a cancel measured no difference. #1278
            // recreates live sessions on the ACP `logout`, which codeg never
            // sends to Claude, and #1288–#1290 change the experimental ACP v2
            // surface only.
            //
            // 0.89.1 changes the adapter's session index only (#1293). Its
            // dependencies are 0.89.0's exactly (the Claude SDK 0.3.293, so the
            // CLI binary is byte for byte the same 2.1.293; the ACP SDK 1.8.0)
            // and `engines.node` stays ">=22". The published package differs
            // from 0.89.0's in `dist/session-index/*` and `package.json`, as
            // the tag diff does. Each tag's scenario harness, run with codeg's
            // exact `clientCapabilities`, is byte-identical in all 40
            // scenarios, `initialize` included. A live conversation against the
            // local fake Anthropic API (a new session, three turns, then a
            // resume in a fresh process and a turn) sends the same ACP frames
            // in the same order on both, apart from timing and paths.
            //
            // (ppp) #1293 sends a session this connection renamed, archived,
            // unarchived or deleted to a `_session/list/subscribe` subscriber
            // at once; lets the page after a `session/list` cursor reuse the
            // previous page's enumeration for up to 30 s while no listed
            // directory changed; and reads each listed transcript's titles
            // itself rather than through the SDK's `getSessionInfo`, whose
            // lookup listed the whole project directory per row and could read
            // another copy of the session. All of it serves a client that
            // declared `sessionIndex` (see (lll)), or the archive behind an
            // AIR client's `session/delete`, which has no subscriber. codeg
            // declares neither and sends none of these requests.
            //
            // (qqq) The rule the index now applies itself is the SDK's title
            // rule, which the live `session_info_update.title` follows too:
            // the custom title (the last in the transcript's last 64 KB, cut
            // line included, then the `<session id>/custom-title.json` sidecar
            // the CLI writes beside the transcript, then the first 64 KB),
            // else the AI title, else the newest `last-prompt` record, a
            // `summary` record or the first prompt. The adapter then collapses
            // white space and cuts at 256 UTF-16 units (`sanitizeTitle`).
            // codeg's history parser titles an untitled session by its first
            // prompt, reference links folded, and both of codeg's transcript
            // readers keep a stored title's spacing. Measured with the CLI's
            // title request refused (a gateway may refuse it), adopting the
            // wire title flipped the row against every detail fetch: after
            // the first turn the wire published "Fix the login flow please
            // look at [auth.ts](file:///tmp/auth.ts) first" (the `last-prompt`
            // record of a two-line prompt with a file mention), on the next
            // two turns nothing (this run's CLI rewrote that record after
            // each process's first turn and at exit), after a resume and a turn
            // "and one more turn after resume", while the parser read "Fix the
            // login flow\n\nplease  look at auth.ts first" throughout. A
            // generated title that came back with a double space was stored
            // with it as an `ai-title` record and published collapsed. So for
            // Claude codeg no longer writes the wire title while it can read
            // the transcript: the notification loop holds it and wakes the
            // transcript watcher, which drops it, publishing it only while it
            // has no transcript it can read, as with a `CLAUDE_CONFIG_DIR` set
            // only in the agent's environment
            // (`session_title::accept_wire_title`). Every title the wire
            // reports apart from that fallback is a transcript record too: the
            // CLI appends a custom title before it writes the sidecar, and
            // stores a generated one as an `ai-title` record.
            // codeg keeps its first-prompt fallback; showing the SDK's newest
            // prompt instead would be a separate choice.
            //
            // 0.90.0 moves the Claude SDK 0.3.293 → 0.3.296, i.e. CLI 2.1.293 →
            // **2.1.296**. The ACP SDK stays 1.8.0 and `engines.node` stays
            // ">=22". The published package differs from 0.89.1's in exactly
            // the files the tag diff touches. 0.90.0's scenario harness, run on
            // the sources of both tags with codeg's exact `clientCapabilities`,
            // is byte-identical in all 40 scenarios, `initialize` included
            // (live, the handshake differs only in the version). The harness has
            // no cancel and no fork scenario, which is where this release moved;
            // the probes below ran live against the local fake Anthropic API (no
            // model call), 0.89.1 and 0.90.0 side by side.
            //
            // (rrr) **A fork starts its session** (#1317). The fork now starts
            // the forked session, a Claude Code process of its own, from the
            // request's `cwd`, MCP servers and `_meta`, and answers with its
            // modes and config options, so the client can prompt it at once. A
            // later `session/resume` returns that session only when it names the
            // same settings (the adapter's session fingerprint); otherwise it
            // tears the session down and starts another. codeg's fork named
            // only the `cwd` while its resume names the connection's servers
            // and `_meta.claudeCode` too, so, measured live, every fork started
            // two processes, the resume spending ~240 ms on the restart. The fork
            // now names exactly what the resume names
            // (`crate::acp::fork::build_fork_request`): one process, and the
            // resume answers in 1 ms. 0.73.0 through 0.89.x read neither field
            // on a fork, so one request serves them all, and there the resume
            // is still what makes the fork usable.
            //
            // (sss) **Cancel** (#1309, #1313, #1327, #1221). A cancelled prompt
            // settles at its interrupted result instead of waiting out the
            // follow-up Claude Code queued behind it, and that follow-up (the
            // summary turn of a background command that finished meanwhile)
            // now streams after the `cancelled` response rather than inside the
            // cancelled turn: measured, 0.89.1 sent its text before the
            // response and 0.90.0 after. Streamed output of prompts the cancel
            // abandoned is dropped. Before the response, every tool call still
            // open is closed, where 0.89.1 left them open: a root Bash with
            // Claude Code's own result (`failed`, the CLI's "The user doesn't
            // want to proceed with this tool use. …" text and
            // `nonExecutionKind: "user-rejected"`, as the transcript records
            // it), a foreground subagent's call with "The turn was cancelled
            // before this tool call returned a result." codeg emits its own
            // `TurnComplete` the moment the user stops a turn, so the closings
            // and the follow-up arrive out of turn. The frontend folds the
            // closings into the stopped turn's message and settles the cards of
            // the turn it already promoted with them, as they would have
            // settled inside it (`cancelledTurn`; before that, a stopped
            // command read as completed until the conversation was reloaded
            // from the transcript, which carries the same results). The
            // follow-up is a turn Claude Code started on its own, as when a
            // background command finishes while idle. A background subagent's
            // calls get no closing on either version (it may run on through a
            // cancel), and the CLI reports its stop after the response.
            //
            // (ttt) The subagents RFD form (#1320–#1322, #1324, #1328) goes only
            // to a client that declares `subagents` and is not AIR. An AIR
            // client keeps the earlier draft whichever signal it sends, so
            // `build_client_capabilities` still declares neither. #1312 (a
            // background command's terminal exits when its task ends) applies
            // to terminal-rendering clients that are not AIR; AIR keeps the
            // exit at the tool result. #1265 merges `CLAUDE_MODEL_CONFIG` into
            // `_meta.claudeCode.options.settings`, neither of which codeg sets.
            // #1266 relabels an API key helper in `_auth/status_update`, which
            // codeg only logs. An approved ExitPlanMode plan becomes a
            // `plan_update` only for a client with plan operations, which codeg
            // does not declare. The rest changes the experimental ACP v2
            // surface.
            //
            // (uuu) **CLI 2.1.294–2.1.296.** The tool list and the
            // `latest_per_family` catalog (Fable 5.1, Opus 5.5, Sonnet 5.5,
            // Haiku 5.5, unchanged through 2.1.299) are 2.1.293's, so the
            // settings panels' model placeholders stand; the probes'
            // transcripts use the same record and attachment types. What
            // reaches codeg:
            //   * Tool inputs (2.1.295, read from the 2.1.296 binary). Bash
            //     takes `command_description` for `description`, and Grep reads
            //     grep's `-l` / `-c` as `output_mode` and drops `-r`, repaired
            //     only on the copy the CLI runs, as with (bb) and (hhh).
            //     `canonical_file_tool_input` makes the same repairs, and Bash's
            //     older `timeout_ms` alias with them. Read takes `allow_large`
            //     to read a text file past the usual size limits; the read card
            //     shows it as a badge.
            //   * Assistant records gain `requestedModel`, the model Claude
            //     Code asked for, beside `message.model`, the one that
            //     answered. It keeps a `[1m]` suffix (`claude-sonnet-4-6[1m]`),
            //     but its absence proves nothing, since a gateway session runs
            //     at 1M without one, so the history gauge keeps assuming 1M and
            //     labels and pricing keep the answering model.
            //
            // 0.91.0 moves the Claude SDK 0.3.296 → 0.3.300, i.e. CLI 2.1.296 →
            // **2.1.300** (the CLI changelog has no 2.1.297 or 2.1.298). The
            // ACP SDK stays 1.8.0 and `engines.node` stays ">=22". The
            // published package differs from 0.90.0's in exactly the files the
            // tag diff touches (`turn-events.ts` changed a comment only and
            // compiles the same). The scenario harness, the same in both tags,
            // is byte-identical in all 40 scenarios with codeg's exact
            // `clientCapabilities`, `initialize` included. It has no cancel,
            // fork or self-started-cycle scenario, which is where the adapter
            // moved; the probes below ran live against the local fake Anthropic
            // API (no model call), 0.90.0 and 0.91.0 side by side.
            //
            // (vvv) **Cancel** (#1334, #1336, #1339, #1342, #1344, #1345).
            // Measured with codeg's capabilities: a root Bash and a foreground
            // subagent's command are closed before the `cancelled` response
            // exactly as on 0.90.0. A background subagent the cancel stops
            // (an AIR client's interrupt still stops them; #1348 spares them
            // only for a subagents RFD client) now gets its open command
            // closed `failed`, with "The turn was cancelled before this tool
            // call returned a result.", after the response, where 0.90.0 left
            // it open for good. codeg ends the turn itself when the user stops
            // it, so this closing lands out of turn like (sss)'s, but the call
            // sits in the subagent's launch card, which settled when the launch
            // was acknowledged and which such closings never revise
            // (`applyLateToolCallReports`): it reads as before until a reload.
            // #1339, #1342 and #1344 close the tool calls of a model cycle
            // Claude Code started on its own (its follow-up after a background
            // task) at the cycle's end, which a cancel codeg sends between its
            // prompts can stop (a `/goal` that lands, say); codeg renders those
            // cycles from the transcript (`background_watch`), never from the
            // wire, so the closings change nothing it shows. #1334 (read from
            // the source and its tests, a race no probe hits on demand): a tool
            // that the stopped work asks to run after the cancel was reported,
            // such as one of a steer the CLI had already taken in, is denied
            // with "The user cancelled this prompt." and shows nothing, where
            // it used to raise a permission request with no tool call behind
            // it.
            //
            // (www) Nothing to change in codeg, each checked:
            //   * The subagents RFD surface (#1332, #1337, #1347, #1348) and
            //     the ACP v2 one (#1346) serve neither an AIR client nor v1;
            //     see (ttt).
            //   * #1340 narrows the model picker to what a `providers/set`
            //     gateway lists. codeg routes Claude through a gateway with
            //     `ANTHROPIC_BASE_URL`, which the adapter does not list, and
            //     the picker is the same on both versions, values included
            //     (`opus` recommended, `fable`, `sonnet`, `haiku`).
            //   * #1338 races an elicitation against Claude Code withdrawing
            //     it. codeg declares no elicitation to Claude, and a withdrawn
            //     permission request (`$/cancel_request`) already closes its
            //     card.
            //   * #1335 ends a terminal for a client that renders terminals;
            //     codeg takes no terminal `_meta` from Claude (see
            //     `hosted_terminal_output_key`).
            //   * #1351 (`session/delete`) and #1352 (`agentWorktree`, for a
            //     `sessionIndex` client) answer requests codeg never sends.
            //   * #1353 keeps a live session that was never prompted when a
            //     resume or load names other settings. codeg's resume of a fork
            //     names the settings the fork did (see (rrr)); measured, a fork
            //     and its resume run one CLI process on both versions, and the
            //     resume answers in 2 to 4 ms.
            //   * The SDK now runs adaptive thinking for `MAX_THINKING_TOKENS=0`
            //     on a model that cannot turn thinking off; codeg never sets it.
            //
            // (xxx) **CLI 2.1.299 and 2.1.300.** What reaches codeg:
            //   * Transcripts record each main-loop API request (2.1.300):
            //     `api-request-shape` (the system prompt and tools, once per
            //     shape; 69 KB in the probe), `api-request-blob` (the messages
            //     the transcript does not already hold, the prompt as sent with
            //     its system reminders among them) and `api-request` (the
            //     parameters and a digest), and the reply's assistant records
            //     name theirs in `requestRef`. Title and compaction requests are
            //     not recorded (measured: 4 of the probe's 11 requests). Every
            //     codeg reader of a Claude transcript dispatches on the record
            //     `type`, so none of these is conversation, though a blob
            //     carries a user `message`; a parser test pins that such a
            //     transcript parses exactly as the same session without them.
            //   * A background sub-agent that ends its run while background work
            //     of its own still runs notifies `completed`, then notifies
            //     again once that work is done and the agent has finished
            //     (measured on both CLIs). The first notification's note says
            //     its result "may be interim", 2.1.300 words its summary "… is
            //     waiting on its own background work", and 2.1.300's note says
            //     an agent resumed with messages that reached it too late "will
            //     notify again". codeg took the first one for the end: the card
            //     read "Background task completed" over that summary, a
            //     "finished" notification went out, and the task left the count
            //     that holds off the idle sweeps (the adapter's async-task table
            //     still covers a background shell of the sub-agent, not a
            //     sub-agent of its own). `task_notification_is_interim` reads
            //     the note: the card reads as an interim result, nothing is
            //     announced, and the task stays counted until the final one.
            //   * A `/compact` writes the same records as on 2.1.296. Tool
            //     inputs and the `latest_per_family` catalog are unchanged (the
            //     one new input repair is the Claude Projects `project_write`
            //     tool's), so the model placeholders stand.
            //   * A steered message now keeps its documents and sends its images
            //     at reduced size, and `ScheduleWakeup` fires while a background
            //     task runs in an SDK session. codeg already sends both kinds of
            //     attachment with a steer and renders such wakeups from the
            //     transcript.
            //
            // 0.92.0 moves the ACP SDK 1.8.0 → 1.9.0 and keeps the Claude SDK
            // at 0.3.300, so the CLI is the same 2.1.300 binary. The published
            // package differs from 0.91.0's in exactly the files the tag diff
            // touches. The scenario harness, the same in both tags, is
            // byte-identical in all 40 scenarios with codeg's exact
            // `clientCapabilities` except for two additions: `initialize`
            // advertises `sessionCapabilities.systemPrompt`, and an MCP tool
            // call carries `_meta.jetbrains.air.mcp`. No scenario predicts a
            // prompt, so (yyy) was measured live against the local fake
            // Anthropic API (no model call), 0.91.0 and 0.92.0 side by side.
            //
            // (yyy) **Predicted follow-up prompt** (#1356). The adapter turns
            // the SDK's `promptSuggestions` on for every session and forwards
            // the prediction to an AIR client as `session_info_update._meta.
            // promptSuggestions = {suggestions: [{text}]}`, cleared with
            // `suggestions: []` when the next prompt arrives. Measured: 0.91.0
            // sends no prediction request, and 0.92.0 sends one after every
            // turn but the first, with the whole conversation, the main model,
            // its adaptive thinking and every tool, so that it reads the turn's
            // prompt cache. Claude Code predicts nothing before the
            // conversation holds two assistant messages, after an API error, in
            // plan mode, or at the usage limit, and does predict after a turn
            // the user stopped. The prediction is never written to the
            // transcript (both versions write the same records, line for line)
            // and `session/load` and `session/resume` do not replay it. It
            // lands 10 to 100 ms after the turn's response. A prompt sent before
            // it lands aborts the request, and the adapter drops the late
            // answer. A `session/close` with one in flight still answers in
            // 5 ms. codeg offers it as gray text in the empty composer, where
            // Tab fills it in (`AcpEvent::PromptSuggestion`). The sessions of
            // an automation run and of a chat-channel bot, which nobody types
            // into, ask for none (`_meta.claudeCode.options.promptSuggestions:
            // false`, see `claude_raw_sdk_session_meta`). A user who wants none
            // anywhere sets Claude Code's own `promptSuggestionEnabled: false`
            // or `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` (each measured: no
            // request).
            //
            // (zzz) Nothing to change in codeg, each checked:
            //   * `_meta.jetbrains.air.mcp = {server, tool}` (#1359) names an MCP
            //     call's server and tool, split from `mcp__<server>__<tool>` the
            //     way Claude Code splits it. codeg reads the same name from
            //     `claudeCode.toolName`, which the history parsers keep as well,
            //     so a live card and its reloaded twin stay alike.
            //   * `sessionCapabilities.systemPrompt` (ACP SDK 1.9.0, #1366)
            //     accepts a client system prompt (`append` or `override`) on
            //     session requests. codeg sends none, and the schema crate skips
            //     the capability it does not know (pinned by a parse test of this
            //     version's `initialize`).
            //   * #1366 also ends a stopped turn `cancelled` when the cancel's
            //     abort kills the stream (it failed with the stream's error
            //     before), and a `session/close` that lands while a prompt
            //     starts ends that prompt `cancelled`. codeg ends a stopped turn
            //     itself (see (sss)), and closes a session only when a fork
            //     leaves it, which happens between turns.
            //   * #1357 (subagent edits in the file-change report) and #1364
            //     (resumed subagents restored after a restart, in the AIR
            //     native-subagent form) serve capabilities codeg does not
            //     declare (see `build_client_capabilities`). The rest of #1366
            //     changes the experimental ACP v2 surface.
            //
            // 0.93.0 keeps the Claude SDK at 0.3.300 and the ACP SDK at 1.9.0,
            // so the CLI is the same 2.1.300 binary, and `engines.node` stays
            // ">=22". The published package differs from 0.92.0's in exactly
            // the files the tag diff touches. The scenario harness, the same in
            // both tags, is byte-identical in all 40 scenarios with codeg's
            // exact `clientCapabilities`; its mocked SDK query cannot enable
            // Remote Control, so no scenario reaches the new command. A live
            // `initialize` differs from 0.92.0's in the version only, so the
            // 0.92.0 parse test in connection.rs covers it. (aaaa) was measured
            // live against the local fake Anthropic API (no model call), 0.92.0
            // and 0.93.0 side by side.
            //
            // (aaaa) **`/remote-control`** (#1197). The adapter offers a
            // `remote-control` command (hint `[session name | off]`) whenever
            // the SDK query can enable Remote Control, which 0.3.300's can. It
            // answers a prompt that is exactly `/remote-control`,
            // `/remote-control <name>` or `/remote-control off`, in one text
            // block, by itself and without a model turn: one
            // `agent_message_chunk`, then `end_turn` with no usage. On success
            // the chunk carries the session's claude.ai/code link. Measured:
            // 0.92.0 passed the text on to Claude Code, which answered
            // "/remote-control isn't available in this environment." and wrote
            // two `local_command` records, while 0.93.0 writes nothing to the
            // transcript, so the exchange is gone from a reloaded conversation.
            // Through a custom `ANTHROPIC_BASE_URL` (codeg's gateway providers)
            // Claude Code refuses ("Remote Control is only available when using
            // Claude via api.anthropic.com …") and the reply says so. While a
            // turn, or a cycle Claude Code started on its own, is running, the
            // prompt is rejected with -32600 "Remote Control can't be changed
            // while Claude is working. Try again when the turn ends.", which
            // codeg reports and survives like any rejected prompt
            // (`prompt_rejection_is_terminal`). The CLI also emits
            // `system/bridge_state` frames, but they reach the client only with
            // the next model turn (held back 10 s and more while idle), so they
            // cannot carry live state. What codeg does with it:
            //   * The reply and the response leave the adapter back to back,
            //     and the turn loop's select could take the response first: the
            //     turn ended `empty` (an error toast) and the reply landed on the
            //     idle loop, where a Claude chunk is dropped (a test of 40 such
            //     turns failed on its second). The select now takes queued
            //     updates first (`biased`), for every agent.
            //   * Remote Control lives in the CLI process, and the idle sweeps
            //     disconnect a connection that no open tab shows (the frontend
            //     after a minute idle, the backend after three without a
            //     touch), which ended it soon after the user closed the tab or
            //     the page. `remote_control_command` and `remote_control_reply`
            //     read the command and the adapter's reply into
            //     `AcpEvent::RemoteControl`; while it is on, both sweeps leave
            //     the connection alone (`manager::sweep_idle`), and a strip
            //     above the transcript keeps the link, a QR code for the phone
            //     and a way to turn it off.
            // Read from the CLI binary, not measurable without a claude.ai
            // account: a message sent from claude.ai/code or the app is queued
            // into Claude Code as a turn of its own, which codeg renders from
            // the transcript like the other cycles Claude Code starts
            // (`background_watch`), and a permission request goes to both
            // sides, an answer from the phone withdrawing codeg's card with
            // `$/cancel_request`.
            //
            // (bbbb) Nothing to change in codeg: #1368 holds a fork back from
            // `session/list` and `_session/list/subscribe` until its
            // `session/fork` response is out, and codeg sends neither. Its own
            // import is a scan the user starts, so no list of codeg's can show
            // a fork before the fork's response binds it.
            //
            // 0.94.0 moves the Claude SDK 0.3.300 → 0.3.303 (CLI 2.1.300 →
            // 2.1.303) and the ACP SDK 1.9.0 → 2.0.0, and keeps `engines.node`
            // at ">=22". Each tag's scenario harness (they differ only in the
            // SDK import paths) is byte-identical in all 40 scenarios with
            // codeg's exact `clientCapabilities`, and a live `initialize`
            // differs from 0.93.0's in the version only, so the 0.92.0 parse
            // test in connection.rs covers it. (cccc) was measured live against
            // the local fake Anthropic API (no model call), 0.93.0 and 0.94.0
            // side by side.
            //
            // (cccc) **Fork subagents.** CLI 2.1.302 offers
            // `subagent_type: "fork"` in every Agent SDK session, as the
            // terminal has since 2.1.232 (`CLAUDE_CODE_FORK_SUBAGENT=0` turns it
            // off); 0.93.0's CLI answered such a call "Agent type 'fork' not
            // found". A fork inherits the conversation and ignores the call's
            // `model` and `effort` (the tool's schema says so; measured: the
            // fork's requests name the parent's model). One the main thread
            // launches runs in the background (an `async_launched` result, then
            // a task notification, like any background agent) unless the call
            // passes `run_in_background: false`, which 2.1.303 honours with a
            // foreground result (`agentType: "fork"`); one a subagent launches
            // runs in the foreground (measured on 2.1.303, and on 0.93.0's
            // 2.1.300 with forks turned on). The fork's transcript opens with
            // what it inherited — a `fork-context-ref` record and a copy of the
            // launching record (the parent's `message.id` and usage), or a copy
            // of the launching subagent's whole history, original timestamps
            // included — then the `<fork-boilerplate>` directive. What codeg
            // does:
            //   * `parse_subagent_tool_calls` reads a fork from its directive on
            //     (`is_fork_directive_record`). Read whole, the parent's own
            //     `Agent` call showed in the fork's card with "Fork started —
            //     processing in background" as its result, the copied usage was
            //     counted again in the session's spend (11,000 input tokens for
            //     the 10,000 the probe's gateway served), and the clock started
            //     at the copied history. The token-usage facts are rebuilt once
            //     (`FACT_SCHEMA_VERSION` 6): the terminal has written such
            //     transcripts since 2.1.232.
            //   * A fork in the foreground: the adapter streams the copied
            //     directive as the fork's own output and reports its "Fork
            //     started" result as the launching call's, so the card completed
            //     when the fork began, and the real result then found the call
            //     settled and was never sent (#1384 fixes the same copy for the
            //     `session/load` replay only; the live frame is reported as
            //     agentclientprotocol/claude-agent-acp#1389). codeg drops that
            //     update (`claude_fork_inherited_result`: a call is never its own
            //     child) and completes the card from the raw SDK message that
            //     carries the real result (`take_claude_fork_results`), while
            //     the turn is live. Replayed from both recordings, the card now
            //     completes with the fork's report.
            //   * The Agent card shows neither `model` nor `effort` for a fork.
            //
            // (dddd) **`loadReplayEnd`** (#1361) stays undeclared. A client that
            // lists it in `_meta.jetbrains.air.capabilities` gets one more
            // `session_info_update` (`_meta.jetbrains.air.loadReplayEnd: true`)
            // after the whole `session/load` replay, before the response (the
            // harness with it declared differs by that update alone). codeg
            // opens a Claude session with `session/resume`, which replays
            // nothing, and loads only when the resume fails; the adapter starts
            // the CLI the same way for both, so they fail together. And codeg
            // drains a replay only once the load has answered, when the whole
            // replay has already arrived, so its 100 ms quiet window cannot cut
            // one short.
            //
            // (eeee) **ACP SDK 2.0.0 and the draft ACP v2** (#1386). The SDK's
            // default exports are now its stable v1 schema; the adapter imports
            // `@agentclientprotocol/sdk/unstable`, keeping every v1 method codeg
            // calls, and the v1 wire is unchanged (above). Its draft v2 surface
            // (since 0.85.1, #1217) still needs `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1`
            // on the adapter AND a client that asks for protocol 2 in
            // `initialize`. Measured: without the variable a protocol-2 request
            // is answered in v1; with it the v2 answer drops `_meta.steering`
            // (the v2 surface does not serve `_session/steering` yet), which
            // codeg's live-feedback channel needs, and the session model changes
            // (no client file system or terminals, subagents as child
            // sessions). codeg sets neither; not adopted while the protocol is a
            // draft.
            //
            // (ffff) Nothing to change in codeg, each checked:
            //   * #1365 matches OpenRouter's model ids
            //     (`anthropic/claude-opus-5.5:batch[1m]`) in the gateway model
            //     listing, so the model selector behind OpenRouter is no longer
            //     empty. codeg shows the list the adapter sends.
            //   * #1372 finds a skill's SKILL.md by its declared `name`, so more
            //     skills carry a SKILL.md path. codeg reads only a Skill call's
            //     name and still does not mark skills in the slash menu (see
            //     (ccc)): built-in skills carry no path. (Marked from 0.99.1,
            //     see (uuuu).)
            //   * CLI 2.1.301–2.1.303 otherwise: a full disk's login error no
            //     longer says "Please run /login" (the adapter answers it as a
            //     plain error, not `auth_required`), an omitted permission mode
            //     starts in `default` on third-party providers (the adapter
            //     always names one), and switching to a model with a smaller
            //     context window summarizes first. Both CLIs write the same
            //     record types (2.1.300 with forks turned on); a fork's own
            //     transcript adds a `fork-context-ref` record, and 2.1.303 adds
            //     `finished` to its `.meta.json`, both of which codeg ignores.
            //
            // 0.97.0 (over 0.95.0 and 0.96.0) moves the Claude SDK 0.3.303 →
            // 0.3.310 (CLI 2.1.303 → 2.1.310) and the ACP SDK 2.0.0 → 2.0.2,
            // and keeps `engines.node` at ">=22". Its scenario harness is
            // byte-identical to 0.94.0's recording in all 40 scenarios with
            // codeg's exact `clientCapabilities`, but for one entry: the
            // `initialize` response lists `backgroundSubagents` among the
            // agent's AIR capabilities (see (iiii)). A live `initialize`
            // differs from 0.94.0's in that entry and the version only, and a
            // live `session/new` only adds the `ultracode` option (see (hhhh));
            // model rows and slash commands are unchanged. No harness scenario
            // reaches the paths this release changed, so (gggg)–(kkkk) were
            // measured live against the local fake Anthropic API (no model
            // call), 0.94.0 and 0.97.0 side by side.
            //
            // (gggg) **Autonomous turns as async tasks** (#1390, #1413). A turn
            // Claude Code starts on its own after the prompt ended (for the
            // notification of a finished background task, a ScheduleWakeup or a
            // cron fire) is announced to a client with `asyncTasks` as
            // `async_task_spawned {asyncTaskId: "autonomous-turn-<uuid>", name:
            // "Claude is working", taskType: "turn", showInTranscript: false,
            // canStop: true}`, with no tool call. Its description is the
            // notification's summary (measured: `Background command "…"
            // completed (exit code 0)`) or one of a few fixed sentences. It ends
            // with the turn's result (`completed` or `failed`), or when a prompt
            // is folded into the turn. `_session/async_task/stop` on it
            // interrupts the turn. Measured: `{stopped: true}`, the task
            // `stopped`, the turn's running Bash rejected, a "Task stopped by
            // user" notice, and the next prompt answered normally. While a
            // prompt waits to be folded in, it answers `{stopped: false}`.
            // 0.94.0 sent nothing for the same turn. codeg reads the channel
            // already (`air_async_task_delta`), so the turn gets a row in the
            // async-task strip, and a live row keeps the connection from the
            // idle sweeps (`has_live_async_task`), which is right while the
            // CLI works. The strip names the agent in the user's language and
            // words the fixed causes itself (`AUTONOMOUS_TURN_TASK_TYPE` and
            // `autonomousTurnCause` in `src/lib/async-tasks.ts`). The turn's
            // content still comes from the transcript (`background_watch`).
            //
            // (hhhh) **Ultracode** (#1438): an `ultracode` On/Off select
            // (`category: "model_config"`), which turns on dynamic workflows
            // for every task. It is a boolean only for a client that declares
            // `session.configOptions.boolean`, which codeg does not (see
            // `build_client_capabilities`). The adapter offers it while dynamic
            // workflows are enabled and the model supports `xhigh` effort.
            // Measured through the gateway: it is offered on all four model
            // rows, where Fast mode is offered on Opus only, and an effort
            // change leaves it on (the adapter now sends the toggle with every
            // effort change; before, an effort pick turned it off). The
            // composer shows it as a switch, as it does Fast mode, with no
            // change. A saved "on" replays at connect like any preference. On a
            // model that hides the option the adapter answers "Unknown config
            // option", which `apply_preferred_session_options` logs and skips,
            // as it already does for Fast mode.
            //
            // (iiii) **`backgroundSubagents`** (#1262) stays undeclared. With
            // it, a turn ends at its result while its background subagents
            // still run, and their updates, permission requests and the model's
            // follow-up go out after the prompt response, as a cycle Claude
            // Code runs on its own. Without it the adapter keeps the hold codeg
            // is built on (#864, #866): the turn stays open until the subagents
            // settle, their tool calls nest under the Agent card as they run,
            // and their permission requests come inside the turn. codeg draws a
            // Claude cycle outside a turn from the transcript only, so opting in
            // would trade that live card for one that fills in later.
            //
            // (jjjj) **Advisor results** (#1247). With the `advisorModel`
            // setting (or `--advisor`), the model can call the `advisor` server
            // tool, whose result comes back inside the response as an
            // `advisor_tool_result` block. 0.94.0 dropped the block: the call
            // ended `failed` ("Claude ended the turn without returning a result
            // for this tool.") and the prompt response carried a session
            // failure. 0.97.0 completes the call with the advice (measured with
            // a scripted advisor call). Claude Code writes the block as an
            // assistant record of its own, which codeg's history parser
            // dropped, so a reloaded session showed the call without a result.
            // `parsers::claude::advisor_tool_result` now reads it as the
            // adapter does, in the main transcript and in a subagent's.
            //
            // (kkkk) **Foreground forks** (#1431) fix the live frame of
            // agentclientprotocol/claude-agent-acp#1389, which codeg reported:
            // the fork's copied "Fork started" result is no longer reported as
            // the launching call's result, and the call completes with the
            // fork's report (measured: one completion, with the report). The fix
            // codeg carries for it (`claude_fork_inherited_result`, see (cccc))
            // never arms on 0.97.0, and stays for an older adapter. CLI 2.1.307
            // rewords the copied results ("Fork started — that fork is you." for
            // the fork's own call), while the `<fork-boilerplate>` directive
            // that `is_fork_directive_record` reads is unchanged.
            //
            // (llll) Nothing to change in codeg, each checked:
            //   * ACP v2 is served by default (#1400): the adapter connects
            //     through the SDK's protocol router and answers a client that
            //     asks for protocol 2 in v2 (`CLAUDE_AGENT_ACP_PROTOCOL` limits
            //     it to one version). codeg asks for 1 and gets v1; every live
            //     probe above went through that router.
            //   * #1371 forwards a message typed in another Remote Control
            //     client as a `user_message_chunk`, and starts reading the SDK
            //     stream right after `/remote-control`. codeg drops user chunks
            //     and draws a turn it did not prompt from the transcript, which
            //     has the message too (see (aaaa)).
            //   * #1406 asks for the session title as the prompt is sent, so
            //     the title arrives mid-turn. codeg holds Claude's wire title
            //     for the transcript's `ai-title` record anyway
            //     (`acp::session_title`), and the CLI writes that record within
            //     seconds.
            //   * #1185 settles a steer folded into a cycle Claude Code started,
            //     which left `session/prompt` pending. #1377 keeps a usage-limit
            //     failure that arrives after a compaction in the same turn.
            //     #1286 appends the model value to duplicate model labels, which
            //     only an `availableModels` allowlist of aliases produces. #1392
            //     fixes the auth-status probe of a session with
            //     `options.settings`, as codeg's model-picker rows send; codeg
            //     does not read `_auth/status_update`.
            //   * #1399, #1405, #1417, #1423, #1424 and #1432–#1434 serve the
            //     session index and native subagent sessions, which codeg does
            //     not declare (see `build_client_capabilities`). Measured with a
            //     foreground subagent: the same frames as 0.94.0, and no
            //     `config_option_update`.
            //   * CLI 2.1.304–2.1.310 otherwise: transcripts add a
            //     `deferred_tools_delta` attachment (tool search is on by
            //     default behind a custom `ANTHROPIC_BASE_URL`, so the model may
            //     call `ToolSearch` before using a deferred tool) and a
            //     `sandboxed` key on tool-result records, both of which codeg
            //     ignores. Per the changelog, subagent transcripts now record
            //     real usage for streamed responses, and the Monitor tool is
            //     offered on more providers.
            //
            // 0.98.0 keeps every dependency of 0.97.0 (Claude SDK 0.3.310, so
            // CLI 2.1.310; ACP SDK 2.0.2; `engines.node` ">=22"), so only the
            // adapter moves. Its scenario harness, run on the 0.98.0 sources
            // with codeg's exact `clientCapabilities`, is byte-identical to
            // 0.97.0's recording in 39 of the 40 scenarios; the
            // `network-permission` one adds the update (nnnn) describes. A
            // live `initialize` and `session/new` differ from 0.97.0's in the
            // version only. No harness scenario runs a Monitor, so (mmmm) was
            // measured live against the local fake Anthropic API (no model
            // call), 0.97.0 and 0.98.0 side by side, and both through
            // codeg-server in a browser.
            //
            // (mmmm) **Monitor tasks are published again, as monitors**
            // (#1452), undoing what (eee) recorded. The task of a `Monitor`
            // call (the SDK reports it as `local_bash`) and a `local_monitor`
            // task arrive as `async_task_spawned {taskType: "monitor",
            // showInTranscript: false, canStop: false, toolCallId: <the Monitor
            // call>}`, named by the call's `description`, and end `completed`
            // when the script exits (a second update adds the output file).
            // Measured: 0.97.0 sends nothing for the same monitor; on both, each
            // event starts an autonomous turn, a `turn` task of its own (see
            // (gggg)). The strip shows the monitor's row with no Stop, as
            // `can_stop` says, and `_session/async_task/stop` on it answers
            // `{stopped: false}` (stopping it would only end the agent's wait;
            // the agent's own TaskStop still ends it). A live monitor now also
            // holds its connection off the idle sweeps (`has_live_async_task`),
            // as a background shell does. Before, nothing did: its result
            // (`toolUseResult {taskId, timeoutMs, persistent}`) has no
            // `backgroundTaskId` for the transcript watcher to count, so a quiet
            // monitor died with a connection whose tab was closed. The Monitor
            // call itself was drawn as a shell command while it ran (its
            // `command` input won the input-shape rule) and as a generic tool
            // after a reload; the activity timeline now draws it as a monitor on
            // both paths (`META_NAMED_TOOLS` and the `monitor` step kind in
            // `src/lib/activity`), by the task id its result names.
            //
            // (nnnn) **A SandboxNetworkAccess call settles** (#1448). With
            // `sandbox.enabled`, Claude Code asks before a sandboxed command
            // reaches a new host: the adapter announces a `tool_call`
            // `SandboxNetworkAccess {host}` under a synthetic id, then asks with
            // a bare request (`{toolCallId, title: <host>, rawInput: {host}}`).
            // 0.97.0 left that call pending for good; 0.98.0 settles it as soon
            // as the request is answered, `completed` when allowed and `failed`
            // when denied (measured both ways, a curl through the sandbox
            // proxy). codeg's live approval record draws the denied one as
            // declined. The transcript never records the call, so a reload
            // drops the row, while the Bash result keeps a denial in its
            // `<sandbox_violations>` block. The row and the permission card now
            // name it as a network request for the host; the card used to dump
            // the request as JSON (it reads the tool from the live call,
            // `mergePermissionToolCallWithLiveInfo`).
            //
            // (oooo) Nothing to change in codeg, each checked:
            //   * #1408 adds `_session/batch_get` and the `sessionBatchGet`
            //     capability for a client that declares `sessionIndex`, which
            //     codeg does not (see (lll) and `build_client_capabilities`).
            //   * #1447 leaves the status out of a permission subject for a
            //     client that is not AIR and speaks ACP v2. codeg is an AIR
            //     client on v1, whose branch is unchanged.
            //
            // 0.99.0 moves both SDKs: the Claude Agent SDK to 0.3.312 (CLI
            // 2.1.310 → 2.1.312) and the ACP SDK to 2.1.0 (schema v1.27.0),
            // whose new peer dependency `@modelcontextprotocol/server` is
            // optional, so npm does not install it. `engines.node` stays
            // ">=22". The scenario harness, run on the 0.99.0 sources with
            // codeg's exact `clientCapabilities`, is byte-identical to
            // 0.98.0's recording in all 40 scenarios, and a live `initialize`
            // and `session/new` differ in the version only. What changed for
            // codeg is on paths no harness scenario runs, measured live
            // against the local fake Anthropic API (no model call), 0.98.0
            // and 0.99.0 side by side:
            //
            // (pppp) **Embedded blob resources reach Claude** (#1460). A blob
            // resource used to be dropped from the prompt whole. Now an image
            // (PNG, JPEG, GIF, WebP) becomes an image block and a PDF a
            // document block, each right after the link `formatUriAsLink`
            // writes for the resource, and a text type is decoded and sent
            // like a text resource. Any other type (zip, docx) is still
            // dropped on v1. codeg sends a blob for a file pasted with no path
            // on disk, so a pasted PDF now reaches the model; 0.98.0 sent the
            // typed text alone (measured on the request both times). Two codeg
            // readers followed the old shape:
            //   * the transcript watcher's prompt fingerprint
            //     (`background_watch::first_transcript_texts`) assumed a blob
            //     writes no text. A PDF sent with nothing typed, whose record
            //     now opens with its `clipboard://` link, read as a turn codeg
            //     did not send, and the overlay drew it a second time. The
            //     ledger now keeps both readings of such a prompt.
            //   * the history parser dropped the document block and kept the
            //     link as prose. It now reads the link as the attachment the
            //     live turn shows (`parsers::claude::user_content_blocks`).
            //
            // (qqqq) **Thinking summaries on request** (#1081).
            // `CLAUDE_CODE_THINKING_DISPLAY` (`summarized` or `omitted`) in
            // the ADAPTER's environment becomes the session's
            // `thinking.display` (no effect with thinking turned off, and a
            // title request carries no `thinking` at all). Claude Code asks
            // for `display: "updates"` by default (measured on 2.1.310 and
            // 2.1.312 for Opus 5.5, Fable 5.1, Sonnet 5.5, Haiku 5.5, Opus 5,
            // Sonnet 5 and a custom model id through a gateway), so a thinking
            // block carries only the notes Claude writes between tool calls.
            // Set to `summarized`, 0.99.0 asks for `summarized`, which adds
            // summaries of the reasoning; display decides what comes back, not
            // what is billed. 0.98.0 ignores the variable. The settings.json
            // `env` reaches only the CLI process, so the Claude Code settings
            // write it into the agent's `env_json` (the thinking-summaries
            // switch under its environment variables), and switching it off
            // removes it. settings.json `showThinkingSummaries: true` is no
            // substitute under the SDK: it drops `display` from the request,
            // and the API's default for these models is `omitted`.
            //
            // (rrrr) **An MCP server that fails to start is reported** (#1464)
            // as a warning notice, `MCP server "<name>" failed to start` with
            // "Its tools are unavailable in this session. Run /mcp for the
            // error.", once per server per session. Only the servers
            // `session/new` passed count (codeg-mcp among them), not the ones
            // in Claude Code's own settings. It arrives within the first
            // prompt's turn, when the CLI reports its MCP state, and codeg
            // shows it as a toast like any notice. `/mcp` works over ACP and
            // names the server and its error. A server that needs OAuth gets
            // an info notice instead, since codeg offers Claude no URL
            // elicitation.
            //
            // (ssss) **ACP error codes** (#1458). An unknown session answers
            // -32002 with `data.sessionId`, where 0.98.0 answered -32603 with
            // "Session not found" in `data.details` (and a `session/load` miss
            // carried `data.uri`). An invalid config option, value or mode
            // answers -32602 "Invalid params: …" instead of -32603. codeg's
            // prompt and load ladders read the code first, so both versions
            // land the same (`claude_session_not_found_reads_the_same_before_and_after_0_99_0`).
            //
            // (tttt) Nothing to change in codeg, each checked:
            //   * #1467 reports EnterPlanMode with the `switch_mode` kind
            //     (`other` before). Its title, `_meta.claudeCode.toolName` and
            //     input are unchanged and it asks no permission, so it still
            //     draws as the plan-mode row.
            //   * #1466 denies a background subagent's permission request
            //     that the client answers `cancelled`, as codeg answers every
            //     pending request on Stop. The subagent now reads a refusal
            //     instead of "Tool permission request failed", which it could
            //     retry.
            //   * #1465 answers an MCP elicitation the client cannot show with
            //     `cancel` rather than `decline`. codeg offers Claude no
            //     elicitation, so that is every one.
            //   * #1463 lists a current model the picker lacks among the model
            //     values. With a custom `ANTHROPIC_MODEL` the CLI already
            //     listed it (both versions, measured); the other cases, a
            //     resume onto a model an allowlist excludes and a refusal
            //     fallback, only add a row.
            //   * SDK 0.3.312 records unanswered AskUserQuestion questions in
            //     `annotations`, on the elicitation path codeg does not take.
            //   * #1459, #1461, #1462 and the `type: "command"` tag on
            //     commands are v2 only; codeg asks for protocol 1.
            //   * CLI 2.1.311 and 2.1.312: a Bash call that outlives its
            //     `timeout` was already moved to the background as a shell
            //     task, and 2.1.312 puts the output so far before the "did not
            //     complete within its Ns timeout" sentence, which codeg finds
            //     anywhere in the result. Model ids drop a `[1m]` suffix that
            //     has no effect, which `heal_retired_context_lane_pick`
            //     already maps. A failed title request is retried once.
            //
            // 0.99.1 changes the adapter only: the Claude Agent SDK stays
            // 0.3.312 (CLI 2.1.312), the ACP SDK 2.1.0 and `engines.node`
            // ">=22", and the published `dist` differs from 0.99.0's in the
            // five changes below and nothing else. The scenario harness, run
            // on the 0.99.1 sources with codeg's exact `clientCapabilities`,
            // is byte-identical to 0.99.0's recording in all 40 scenarios (its
            // mocked query lists no command and no skill). Measured live
            // against the local fake Anthropic API (no model call), 0.99.0 and
            // 0.99.1 side by side:
            //
            // (uuuu) **Every Claude skill is marked as one** (#1473). An AIR
            // command's `_meta.jetbrains.air` carries `kind: "skill"`, with
            // `skillPath`, for a skill. 0.99.0 marked only a skill whose
            // SKILL.md it found under the cwd or the home directory (codeg's
            // own skills, linked into `~/.claude/skills`, among them), which
            // is why (ccc) left the slash menu unmarked. 0.99.1 also reads
            // Claude Code's skill list (`getContextUsage()`) on the session's
            // first `system/init` and on every `commands_changed`, and sends
            // the list again with every skill marked: a plugin or nested skill
            // with its path, one bundled with the CLI (`simplify`, `loop`,
            // `init`, …, 12 in 2.1.312) with the kind alone; built-in commands,
            // MCP prompts and `.claude/commands` files stay unmarked.
            // Measured: the list `session/new` sends marks the user and the
            // project skill only (both versions); about 0.9 s after the first
            // prompt 0.99.1 sends it again with all 15 skills marked, and a
            // skill under `sub/.claude/skills` joins, marked, once a file in
            // `sub/` is read. codeg now reads the mark
            // (`connection::air_command_skill`), the reducer takes a list that
            // changed in its marks only, and the `/` menus draw a skill with
            // the icon a disk skill has. They do so only for a list holding a
            // skill without a path (`skillMarkedCommands`), which only that
            // read produces: the list before the first prompt, and the
            // agent-options probe that never prompts, keep every row as it
            // was, so no menu shows some skills marked and others not.
            //
            //   The read costs requests codeg cannot turn off.
            //   `getContextUsage()` defaults to `detail: "full"`, which counts
            //   each context category with the token-count API. Measured: 26
            //   `count_tokens` requests (about 85 KB) at a session's first
            //   prompt where 0.99.0 sends none, and 1 at a later
            //   `commands_changed`. They are free on the first-party API and
            //   run beside the turn, not before it. A gateway that rejects
            //   `count_tokens` (404 measured) still gets every mark; the CLI
            //   then sends the uncounted ones again at each read (28).
            //
            // (vvvv) **A fork may name another working directory** (#1483).
            // The fork no longer looks the source session up only under the
            // request's `cwd` (the SDK's `dir`). codeg forks with the
            // connection's own cwd, which forked on both versions (measured);
            // with another cwd 0.99.0 answered -32603 and 0.99.1 forks. So a
            // session whose transcript lives under another project directory
            // than the cwd codeg opened it with now forks instead of failing.
            //
            // (wwww) **More sign-in failures are `auth_required`** (#1481).
            // The adapter matched "Please run /login" in a failed result; it
            // now matches "run /login" in any case, and on replay leaves out
            // the usage-limit banners that mention `/login`. In CLI 2.1.312
            // that adds "Login expired · Run /login to sign in again, or
            // re-authenticate your Anthropic profile" (an expired Anthropic
            // profile login) and the organization-disabled-API-key messages
            // ("… run /login to sign in with your claude.ai account"), which
            // 0.99.0 settled as an ordinary failure without the Login action.
            // codeg consumes the kind as it is (see (e)): the access strip with
            // its Login button, and the `authRequired` rejection kept to the
            // turn. The history parser reads the CLI's error record by
            // `isApiErrorMessage`, not by its wording, so history is unchanged.
            // No 2.1.312 usage-limit text says "run /login"; they say
            // "· /login to switch …".
            //
            // (xxxx) Nothing to change in codeg, each checked:
            //   * #1469 gives an approved plan the id `plan-mode:<tool call
            //     id>` for an AIR client, but sends `plan_update` only to a
            //     client with plan operations, and codeg declares no `plan`
            //     (see `build_client_capabilities`): both ExitPlanMode
            //     scenarios are byte-identical.
            //   * #1479 titles a native subagent by its task, in the RFD form
            //     a client gets only when it declares `subagents` and is not
            //     AIR; codeg is AIR and declares none.
            distribution: AgentDistribution::Npx {
                version: "0.99.1",
                package: "@agentclientprotocol/claude-agent-acp@0.99.1",
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
            // (`isGrepNoMatchResult`).
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
            //
            // 2.0.0 is the codex half of the AIR contract claude-agent-acp
            // 0.82.0 shipped the same day (#530, the reason for the major),
            // plus #480, #517, #536, #550 and three `@openai/codex` bumps
            // (^0.156.1 → **^0.158.0**). `engines` is still absent, so the
            // 20.0.0 floor stays. Measured like the claude side: both versions'
            // own scenario harness (33 scenarios, a mocked app-server) re-run
            // with codeg's exact `clientCapabilities` and diffed.
            //
            // (m) The AIR tool-call contract (#530), codex side
            // (`crate::acp::air_contract` unless named otherwise):
            //   * `_meta` merge: codex leaves an unchanged TOP-LEVEL `_meta` key
            //     off an update (`ToolCallReports`); same ledger as claude, with
            //     codex's whole-key rule.
            //   * `_meta.codex.subagent` and `_meta.codex.collaboration` go to NO
            //     client. A `subAgentActivity` is recognised by its `rawInput`
            //     (`{agentThreadId, agentPath, activityKind}`, on every version)
            //     and its bare-status follow-up by id (`codex_activity_calls`).
            //     The collab card never read the meta — it keys on the input's
            //     three thread keys, still there — and `rawInput.status` is gone,
            //     but the capsule's state comes from the ACP status.
            //   * plan review: `_meta.codex.{kind, planItemId}` gone. Recognised
            //     by its `plan-review:` id (`codex_plan_review_meta`), which also
            //     writes the legacy marker onto the seeded card the frontend
            //     names by it.
            //   * `_meta.permission` (request and option level) → `_meta.
            //     jetbrains.air.permission`; `_meta.commandAction` →
            //     `jetbrains.air.commandAction` (`is_config_option_state_command`);
            //     the goal → `jetbrains.air.goal`; `_meta.codex.phase` →
            //     `jetbrains.air.phase` (codeg reads no chunk `_meta` live).
            //   * fileChange: ONE diff block PER HUNK — context and changed lines,
            //     no line numbers — for EVERY client; 1.13.x read the file and
            //     sent its whole old and new text in one block. Keyed by path,
            //     `synthesize_edit_input_from_diffs` kept only the last hunk; it
            //     joins them now. And codex TAKES `diffPatch`
            //     (`build_client_capabilities`): one exact Git patch per file,
            //     headers rewritten to absolute paths (`diff_block_payload`), so
            //     the edit card gets its real hunk positions back.
            //   * a read/search/list command action has no terminal: search and
            //     list output arrives as a `rawOutput` STRING at completion, and
            //     a read-file action's not at all (a viewed file). codex has no
            //     raw stream to recover it from; the live card shows the path,
            //     the reloaded rollout the text.
            //   * stdin is `_meta.terminal_input` instead of a `\n<stdin>\n`
            //     output delta — bridged as that delta
            //     (`hosted_terminal_output_delta`).
            //   * a web search's `rawInput` is `{query, action}`, no `type:
            //     "webSearch"` — `is_codex_web_search_input` reads both shapes,
            //     or the context ring would read a search's usage as occupancy.
            //   * a dynamic tool's result now lands in `content`, image
            //     generation drops its `rawOutput`, a Guardian review regroups
            //     its content — generic cards absorb all three.
            //   `rawInputRendering` stays OUT: it removes the question text a
            //   message-only MCP elicitation's permission card shows.
            //
            // (n) #480 restores the read-only sandbox under `read-only` and adds
            // a `workspace-write` preset ("Workspace access": writable, every
            // escalation to the user); `agent` is now "Auto review". See
            // `codex_initial_agent_mode`, which maps a workspace-write config to
            // the new preset (an older adapter falls back to `agent`, the old
            // answer), and the Codex panel copy. A composer preference saved as
            // `read-only` under 1.7–1.13 now means a real read-only sandbox —
            // stricter, never looser, so it is left alone.
            //
            // (o) #550: an auth failure is ONLY `authRequired` now — no session
            // failure, no chat text — handled as claude's (jj).
            //
            // (p) #517 `_meta.mcpStartupAwaitTimeoutMs` (opt-in wait on new /
            // resume / fork for the REQUESTED MCP servers to settle) is not
            // sent. It would close codex's first-turn race against a slow
            // server, but it waits for every forwarded server, the user's slow
            // npx ones included, on the session-creation path — worth taking
            // only with evidence that the race bites.
            //
            // (q) #536 (acp-tck conformance), all free: resume / load / delete
            // of a never-prompted session no longer fail with "no rollout
            // found", `session/load` waits out a running title generation, and a
            // cancel that lands before the turn is interruptible now cancels.
            //
            // (r) `@openai/codex` 0.158.0 deletes the hidden `gpt-5.4` stub (11 →
            // 10 slugs) and adds no `ModelInfo` field; the offline snapshot is
            // regenerated and the strictness re-probed (`codex_model_catalog.rs`).
            //
            // 2.0.1 is two upstream changes (#562, #565), both `@openai/codex`
            // bumps: ^0.158.0 → **^0.159.1**, which a fresh install resolves to
            // 0.159.2 (a Windows console fix; its bundled catalog is
            // byte-identical to 0.159.1's). `engines` is still absent, so the
            // 20.0.0 floor stays. The adapter's own code moves by one table row
            // (see (v)): its scenario harness (33 scenarios, a mocked app-server)
            // replays byte-identically under codeg's exact `clientCapabilities`
            // on both tags, and the live `initialize` response matches 2.0.0's
            // field for field apart from the version.
            //
            // (s) **GPT-6.1 Sol** (0.159.1) is codex's new DEFAULT: priority 1,
            // ahead of GPT-6 Astra, taking the catalog from 10 slugs to 11. Live
            // on a throwaway `CODEX_HOME` in codeg's bound-provider shape, a
            // fresh `session/new` opens on `gpt-6.1-sol` (2.0.0: `gpt-6-astra`),
            // the AIR `recommendedValue` follows, and the `model` option reads
            // 6.1 Sol / 6 Astra / 6 Sol / 6 Luna / 5.6 Sol / 5.6 Terra /
            // 5.6 Luna / 5.5. A session with neither a root `model` nor a saved
            // composer pick to replay moves with it — so a gateway that does not
            // serve the new slug refuses such sessions until a model is picked.
            // Its recommended effort is `low` (6 Sol's is `medium`). No
            // `ModelInfo` field was added; the offline snapshot is regenerated
            // from the 0.159.2 binary and the strictness re-probed
            // (`codex_model_catalog.rs`).
            //
            // (t) The catalog's FILE order stopped being priority order: GPT-6.1
            // Sol sits second in `models.json`, and in `debug models --bundled`,
            // behind GPT-6 Astra's priority 2. codex sorts by priority, but
            // codeg's generated `model_catalog_json` renumbered the officials by
            // position — a user with custom models or removed officials would
            // have got 6 Astra ahead of 6.1 Sol, and as the default. Both catalog
            // loaders now sort (`codex_model_catalog::sort_by_priority`), and so
            // do the expansion and the root-`model` fallback.
            //
            // (u) That generated catalog is a whole-table replace which codeg
            // only rewrote on a settings save, so those same users would not
            // have seen GPT-6.1 Sol at all after upgrading. Installing or
            // upgrading codex-acp now refreshes the official catalog from the
            // codex it drives and re-expands codeg's catalog from its stored
            // intent (`resync_codex_generated_catalog` in commands/acp.rs).
            //
            // (v) Inert or not adopted. A live stdio diff shows one more change:
            // the `$plugin-creator` skill command is gone (0.159.0 removed the
            // bundled skill; codeg never referenced it). `tooManyDenials` joins
            // the error table as `provider_error` — the typed cause 0.159 gives
            // its Guardian circuit breaker behind the opt-in
            // `auto_review.circuit_break_action = "strict"`, which codeg does
            // not write. Strict mode puts it on an INTERRUPTED turn's `error`
            // and sends no `error` notification, while `handleFailedTurn`
            // reports FAILED turns only, so codeg sees no typed failure from it
            // either way; the rollout's `turn_aborted` gains the same optional
            // `error`, and `parsers::codex` does not read `turn_aborted`.
            // `features.instant_interrupt` (new input preempting a streaming
            // response) is `Stage::UnderDevelopment` — "not ready for external
            // use" — so it stays off. Item anchors for `thread/items/list` and
            // the single-server `serverName` filter on `mcpServerStatus/list` are
            // new app-server parameters the adapter does not send (it pages with
            // opaque string cursors and lists every server). `.aws` directories
            // under a writable root are now protected by the sandbox: stricter,
            // never looser.
            //
            // 2.1.0 is two fixes, #570 and #564. Its changelog also lists #552
            // "ACP v2 support" — the reason for the minor — but #573 reverted
            // it before the release, so the tag's source differs from 2.0.1's
            // by the two fixes alone; when #552 lands again it needs its own
            // measurement. Dependencies are unchanged (`@openai/codex`
            // ^0.159.1, which a fresh install now resolves to 0.159.3: a
            // TUI-only backport whose `debug models --bundled` output is
            // byte-identical to the snapshot), and `engines` is still absent.
            // Live over stdio with codeg's exact `clientCapabilities`, the
            // `initialize` and `session/new` responses and every frame after
            // them match 2.0.1's apart from the version.
            //
            // (w) #570, `request_user_input` for AIR clients, which codeg is.
            // An `isOther` question no longer gets the synthetic "None of the
            // above" choice, its note field gains
            // `_meta.jetbrains.air.customAnswer: true`, and a choice-field
            // string that matches no option is the user's own answer, handed
            // to codex as `["None of the above", "user_note: <text>"]` —
            // codex's own encoding, the one its TUI writes for "Other". codeg
            // already sent the card's "Other" text that way (main field,
            // verbatim), so the round trip needs nothing. What changed is the
            // reloaded rollout: 2.0.1 handed codex `["<text>"]`, and the pair
            // would have read back as two picks, so the frontend's
            // `parseCodexAnswers` decodes it to the text. The same decode reads
            // answers given in codex's TUI, which writes notes the same way.
            // The marker is a bare `true` here and `{questionId,
            // isCustomAnswer: true}` on claude; `question::
            // is_custom_answer_property` reads both. Recorded off the adapter's
            // own handler driven with codeg's capabilities, on both tags.
            //
            // (x) #564: a `session/load` / `session/resume` of a thread another
            // app-server holds — the Codex app, the CLI, an IDE extension, or
            // codeg's own forking connection — fails with -32600 and
            // `data.reason: "thread_active_writer"` instead of a -32603
            // carrying codex's raw text. `classify_session_load_error` keys the
            // `session_busy` banner on the reason; the text match stays for
            // older adapters, and the banner copy now names both kinds of
            // holder (it named only the fork). Reproduced live on both tags
            // with two adapter processes on one `CODEX_HOME`; once the holder
            // exits, the same load succeeds, so the banner's Reload recovers.
            // codeg's own forking connection no longer holds on until it
            // exits: it closes the parent right after the step that resumes
            // the child (`connection::close_forked_parent`), and codex then
            // unloads the thread after `thread_unload_delay_secs` (60 by
            // default). Live on 2.1.0, the sibling's load succeeded 61 s after
            // the close, at once with the delay set to 0, and never without
            // the close.
            //
            // 2.1.1 is three fixes, #572, #577 and #571. Dependencies are
            // unchanged (a fresh install still resolves `@openai/codex`
            // 0.159.3) and `engines` is still absent; the published bundle
            // differs from 2.1.0's by the three fixes and the version. Measured
            // live over stdio with codeg's exact `clientCapabilities` against a
            // scripted Responses server: a plain turn's frames match 2.1.0's
            // apart from the version, and each fix shows up as below.
            //
            // (y) #572: when codex's turn error is a service error envelope —
            // `{"type":"error","status":4xx|5xx,"error":{"type":…,"message":…}}`
            // with one of nine known error types, the body codex passes on
            // verbatim for an HTTP 400 — the `sessionFailure` title (and the
            // legacy text chunk codeg does not get) carry `error.message`
            // instead of the JSON. codeg shows the title as sent, so the
            // banner reads the sentence with no change here. Live, a 400 with
            // that body ends the prompt `end_turn` with the failure on its
            // `_meta`, titled with the JSON on 2.1.0 and with the message on
            // 2.1.1. The adapter leaves one place undecoded: a failed
            // compaction's `error` (`compaction_update`), which the compaction
            // card shows. Live, a compaction whose request got that 400 put the
            // JSON on the card beside the readable banner, so codeg reads the
            // card's error down itself (`acp::service_error`, the adapter's
            // rule ported, with JavaScript's idea of a blank message; only a
            // body escaping a lone surrogate, which serde_json refuses, stays
            // as written).
            //
            // (z) #577: the `request_user_input` note field also carries the
            // root `_meta._askUserQuestionCustomAnswer: true`, because released
            // AIR builds read only that key. `question::
            // is_custom_answer_property` now reads a bare `true` under either
            // key. Recorded live (plan mode, a model that calls the tool), the
            // form differs from 2.1.0's by that key alone, and codex is handed
            // the same answers on both: `["Run tests"]` for a pick,
            // `["None of the above", "user_note: <text>"]` for typed text.
            //
            // (aa) #571: `session/load` replays the attachment envelope the
            // Codex desktop app writes into a user message (`# Files mentioned
            // by the user:` … `## My request:`) as one `resource_link` per file
            // plus the request text, and a native local image, audio file or
            // file mention as a `resource_link`. codeg never renders that
            // replay (the transcript comes from the rollout), so
            // `parsers::codex` decodes the same envelope itself
            // (`parsers::codex_desktop_attachments`): each file becomes the
            // link codeg renders any attachment as, a badge plus a chip, with
            // the request after it. It also reads the early desktop marker
            // `## My request for Codex:`, which 2.1.1 replays as text. Live on
            // both tags: 2.1.0 replays either envelope as one text block, 2.1.1
            // splits the current one and leaves the early one whole. Across a
            // local corpus of 4,137 rollouts, the one message that decodes is
            // the one desktop envelope in it.
            //
            // 2.2.1 follows 2.2.0, which was tagged but never published to
            // npm. `@openai/codex` moves ^0.159.1 → **^0.160.1** (a fresh
            // install resolves 0.160.1), whose `debug models --bundled` output
            // is byte-identical to 0.159.3's, so the offline snapshot stands;
            // `engines` is still absent. Under codeg's exact
            // `clientCapabilities` the adapter's 33-scenario harness differs
            // between the tags only by two AIR capabilities in `initialize`
            // ("customInstructions", "codexHooks") and the `/mcp` entry of (ee).
            // A live plain turn and shell turn add to those only the `$skill`
            // paths of (ee) and the prompt response's `usage` of (ff).
            //
            // (bb) **Node 20.3.0 floor.** 2.2.1 calls `AbortSignal.any` on every
            // `session/prompt`, and Node has it from 20.3.0: live on Node
            // 20.2.0 every prompt fails with -32603 "AbortSignal.any is not a
            // function", while 2.1.1 runs there. `node_required` is 20.3.0, and
            // the diagnostics page now compares the whole version, as the
            // launch preflight always did.
            //
            // (cc) **The app-server is supervised for every client** (#590,
            // #604). Up to 2.1.1 a dead `codex app-server` left the adapter up
            // but useless: a turn in flight never answered (a cancel did not
            // help), an open permission card was never withdrawn, every later
            // prompt ended in an internal-error failure and every open failed
            // with "Connection is disposed." until codeg respawned the adapter.
            // Now a turn in flight settles at once, `end_turn` with a
            // `connection` `sessionFailure`, its open tool calls failed and its
            // permission requests withdrawn by `$/cancel_request` (all of which
            // codeg already renders), and the next request restarts the
            // app-server and reopens the session. A request that meets the loss
            // fails with code 1001 and `data.restartable`
            // (`connection::codex_app_server_lost`). A restartable loss costs
            // that request only. An unrestartable one (a session that never
            // reached disk, #604; the crash-loop guard after 5 crashes in 5
            // min; a thread whose open crashed the app-server twice) ends the
            // connection, since every later prompt would fail the same way. On
            // an open, either kind now raises the `session_unavailable` banner
            // instead of the `session/new` fallback, which 2.2 lets succeed on
            // the restarted app-server and which would orphan the history. All
            // measured live by SIGKILLing the app-server, bar the refused
            // thread, which is read from the source.
            //
            // (dd) A fork stays subscribed (#590), so it takes a prompt at once.
            // codeg's resume after the fork is redundant on 2.2 but harmless
            // (measured: fork → resume → close the parent → prompt works on
            // both tags) and stays for older adapters. The fork still never
            // releases the parent, so `close_forked_parent` stays as well.
            //
            // (ee) `/mcp` (#579) reports each server's live status in markdown
            // and takes `reconnect`, which its entry now names as the input
            // hint `[reconnect]`. Every status read briefly starts one more copy
            // of each session MCP server, codeg-mcp included, which is harmless:
            // codeg-mcp opens its socket on `tools/call` only. `$skill` commands
            // carry their SKILL.md path in `_meta.jetbrains.air.skillPath`,
            // which codeg does not show.
            //
            // (ff) Inert for codeg. #587 reports the servers config.toml
            // replaces only when `DISABLE_MCP_CONFIG_FILTERING` is not "true",
            // and `apply_codex_env_policy` sets it. That has to stay: codeg
            // forwards config.toml's servers under their own names, and each
            // would otherwise come back as a failed `mcp__<name>__startup` card.
            // #588's hook trust needs `CODEX_CONFIG.hooks` (and cross-spawn a
            // Windows `CODEX_PATH`), neither of which codeg sets. #546's custom
            // instructions are read from `session/new`'s `_meta` only (they
            // become the thread's developer instructions and persist in the
            // rollout), which codeg does not send. #594 changes `authenticate`,
            // which codeg never calls for codex. The session index (#590) needs
            // the `sessionIndex` capability, as on claude (lll). The prompt
            // response's `usage` now sums the whole prompt and reports
            // `cachedWriteTokens`; codeg reads neither, and the context ring
            // follows `usage_update`, which is unchanged.
            //
            // (gg) codex 0.160 itself. The rollout gains one record, a
            // developer-role `<content_filter_guidance>` message after a
            // response a content filter blocked, which `parsers::codex` skips
            // like every developer message; the app-server protocol and the
            // persisted formats are otherwise unchanged. The catalog's new
            // `model_messages.content_filter_guidance` is strict
            // (`codex_model_catalog::model_messages_override_is_safe`). A
            // provider's `model_catalog_url` is now authoritative; codeg never
            // writes one. Hooks behave as on 0.159: an untrusted hook in the
            // user's config.toml is skipped silently.
            //
            // (hh) Found on the way, and older than this pin: codex counts a
            // prompt-cache WRITE inside `input_tokens`
            // (`cache_write_input_tokens`, which codeg's bound provider
            // reports), and `parsers::codex` split out only the read, so every
            // write read as fresh input. 2.2.0 corrected its own counter the
            // same way (`TokenCount`); the parser now splits both
            // (`codex_usage_counters`, token-usage `FACT_SCHEMA_VERSION` 4).
            //
            // 2.2.2 changes one thing (#606), and nothing codeg reads: a
            // `session/list` row, and a pushed `_session/list/changes` row, is
            // titled by the first non-blank of the thread's `name`, `title`,
            // `summary` and `preview`, collapsed to one line and no longer cut
            // to 256. codeg sends no `session/list` and subscribes to no list.
            // The published bundle differs from 2.2.1's by that change and the
            // version only. Fresh installs of the two pins lock the same
            // package versions bar the adapter's own and the same codex 0.160.1
            // binary, and `initialize` (bar the version) is identical. The
            // `session_info_update` titles codeg does read are unchanged, still
            // collapsed and cut at 256 — measured live on both tags: the
            // first-prompt fallback, the generated title, a `/rename` echo and
            // the title `session/load` republishes (`session/resume` publishes
            // none).
            //
            // (ii) Found through #606, and older than this pin: codex stores a
            // thread name only trimmed, so `/rename   Fix  the\nflaky\ttest`
            // leaves `"Fix  the\nflaky\ttest"` in `session_index.jsonl` while
            // the live title reads "Fix the flaky test", and `parsers::codex`
            // read the raw name — the live path and every list or detail load
            // kept rewriting the row with each other's spelling. A thread name
            // now goes through the adapter's own title function
            // (`codex_acp_session_title`, cut included) and then the live
            // path's (`codex_thread_title`).
            //
            // 2.3.0 moves `@openai/codex` ^0.160.1 → **^0.164.0** (a fresh
            // install resolves 0.164.0) and `@agentclientprotocol/sdk`
            // ^1.5.0 → ~2.0.2, the SDK claude-agent-acp 0.97.0 already runs.
            // `engines` is still absent, and the published bundle is a build of
            // the tag. The 20.3.0 floor stands: the new Node APIs (`URL.canParse`,
            // `AbortSignal.timeout`, `structuredClone`, `fetch`, `Object.hasOwn`)
            // are all in 20.3, and live on 20.3.0 a session opens, runs a plain
            // and a shell turn and compacts, while on 20.2.0 every prompt still
            // fails on `AbortSignal.any`. ACP v2 is back (#620, with #650–#652
            // and #622), but a v1 `initialize` is still answered with
            // `protocolVersion: 1` and the v1 handlers are the same thirty.
            // Under codeg's exact `clientCapabilities` the adapter's
            // 33-scenario harness differs between the tags only by
            // `sessionCapabilities.systemPrompt: {}` in `initialize`
            // (`connection::tests::codex_230_initialize_response_parses_past_
            // its_new_capabilities`). Live runs against a scripted Responses
            // server show the rest, below.
            //
            // (jj) **#667 turns Codex's Visualize skill off for every client.**
            // The adapter appends `{name: "visualize:visualize", enabled:
            // false}` last to `skills.config` in the config of every thread it
            // starts, resumes or forks, and drops the skill from `skills/list`.
            // Nothing gates it, and config.toml cannot turn it back on: codex
            // applies the rules layer by layer, and that thread config is the
            // last layer (measured, by name and by path). codeg renders the
            // skill's `visualize{…}` references inline
            // (`codex-visualize-card.tsx`), so codex replies in codeg no longer
            // carry them. History still renders them, and an HTML file a reply
            // names still gets its on-demand preview. A user skill of another
            // name survives (measured with a plain `visualize`), so a skill
            // that teaches the same reference would bring them back; that is a
            // product decision, not taken here.
            //
            // (kk) #668: an `invalid_encrypted_content` error — codex resends
            // earlier turns' encrypted reasoning, which only the provider or
            // account that encrypted it can read, so a thread whose provider
            // changed fails every turn — gets a sentence for its
            // `sessionFailure` title instead of the provider's JSON, in all
            // three shapes (bare, in codex's envelope, inside a gateway's
            // `metadata`). Only the title: a failed compaction's `error` and
            // the rollout keep the JSON, so `acp::service_error` ports the
            // rule, and the reloaded failure line and the compaction card read
            // the sentence the banner does.
            //
            // (ll) What #620 changed for a v1 client on the way, unannounced,
            // all measured live:
            //   * Every `session/resume` and `session/load` (and the reopen
            //     after an app-server crash) is followed by a
            //     `session_info_update` carrying `_meta.codex.threadStatus`
            //     and a `usage_update` with the restored context use, so the
            //     ring is right before the first turn. `threadStatus` also
            //     marks each turn's start and end; codeg reads none of it
            //     (see the idle loop's note on `codex_context_readings`).
            //   * A goal still active when its session is reopened is resumed
            //     by codex on both tags; 2.2.2 forwarded none of that turn,
            //     2.3.0 streams it with no prompt in flight, which codeg's idle
            //     loop shows like any `/goal` continuation.
            //   * `/compact` (#654) answers its prompt after
            //     `compaction_update` completes and the thread goes idle;
            //     2.2.2 answered first and let both land in the next prompt.
            //   * `session/cancel` withdraws the open permission requests
            //     (`$/cancel_request`), even one already answered, which the
            //     card's watcher then finds settled.
            //   * A plan review stopped with `cancelled` ends the prompt
            //     `cancelled` (was `end_turn`); that first turn then gets no
            //     generated title.
            //   * A second prompt during a turn is queued (2.2.2 never
            //     answered the first); codeg sends one at a time.
            //   * `/review-branch` outside a git repository fails at once with
            //     a `sessionFailure` instead of hanging the prompt.
            //   * A config-load error carries `data: {details}` (was a
            //     string); codeg shows the error as sent.
            //   * New skill files republish `available_commands_update`
            //     within half a second while idle (#643).
            //
            // (mm) codex 0.161–0.164 (#666), as codeg meets it:
            //   * A thread stays loaded **30 minutes** after its last subscriber
            //     leaves (`thread_unload_delay_secs`, 60 s up to 0.163), so a
            //     forked parent's row met `session_busy` for half an hour after
            //     `close_forked_parent`. codeg asks for 60 s through
            //     `CODEX_CONFIG` (`connection::apply_codex_env_policy`), which
            //     codex reads per thread from 0.164. Measured: the parent
            //     still locked 65 s after the close without it, open with it.
            //   * The rollout swaps an MCP result over 64 KiB for one text
            //     block holding the result's JSON, cut in the middle, so a
            //     reloaded code-mode script showed 65,000 characters of JSON
            //     (escaped base64 for an image). `parsers::codex` reads the
            //     stand-in back (`codex_truncated_mcp_result_preview`):
            //     measured on a 0.164.0 rollout, the text result reads as its
            //     text up to the cut, the image one is capped at 4,000
            //     characters as on 0.160.1.
            //   * The bundled catalog is 0.160.1's minus
            //     `model_messages.instructions_variables`, which 0.164 no
            //     longer reads; the offline snapshot is regenerated
            //     (`codex_model_catalog.rs` has the re-probe), and
            //     `CODEX_NESTED_VERSION_FALLBACK` moves with it.
            //   * The "Heads up: Long threads and multiple compactions…"
            //     warning is gone, and with it the notice codeg filtered
            //     (`isCompactionEchoNotice` keeps the filter for older pins).
            //   * `features.instant_interrupt` is on by default, which (v)
            //     said stays off: pending input — a sub-agent's mailbox
            //     message — now preempts a streaming response. codeg sends
            //     codex no input mid-turn.
            //   * Since 0.162 a Responses request for a model without
            //     Responses-Lite (codeg's OpenAI-compatible preset among them)
            //     carries the base instructions as its first `developer`
            //     message instead of `instructions`, which a gateway that maps
            //     `developer` to a user turn will notice.
            //   * A thread named before its first turn (the Codex TUI or app;
            //     codex-acp names after the first prompt) leaves a header-only
            //     rollout, which codeg lists with its name and no messages.
            //   * `approval_policy = "untrusted"` is refused outright ("no
            //     longer supported; remove this setting") — on 0.160.1 as
            //     well — so no Codex session starts with it, in codeg or the
            //     CLI. The Codex panel offered it: it no longer does, and it
            //     flags one config.toml already has
            //     (`commands::acp::CODEX_RETIRED_APPROVAL_POLICY`).
            //   * Not read by codeg: an incomplete response is no longer
            //     retried, and its error drops the "stream disconnected before
            //     completion:" prefix; usage now counts it.
            //
            // (nn) Inert or not adopted. #653 accepts a
            // `systemPrompt: {mode: "append", content: [text…]}` on v1
            // `session/new`, `load`, `resume` and `fork` (-32602 for
            // `override` or a non-text block), persisted as the thread's first
            // developer message and lost after a compaction unless resent on
            // every open; codeg sends none (it would also need the schema
            // crate's `unstable_session_system_prompt`). #627 narrows models to
            // what a `providers/set` gateway lists; codeg binds its provider
            // through config.toml and never sends `providers/set`. #678, #634
            // and #632 need `subagents`, AIR `nativeSubagentSessions` or
            // `agentFileChangeReport`, none of which codeg advertises. #631,
            // #639, #642 and the session index (#622) shape `session/list`,
            // which codeg does not send. #589 is the `_auth/status_update`
            // codeg drops, for a `wire` provider codeg does not have. #626
            // explains a config that cannot load because the working directory
            // was deleted, which codex 0.164 now tolerates. The SDK 2.0 move
            // (#649) converts errors as before, and every request shape codeg
            // sends parses identically under both SDKs' v1 schemas; 2.0 is
            // stricter only about a null or missing `mcpServers` and a bad
            // `additionalDirectories`, which codeg never sends.
            //
            // 2.4.0 moves `@openai/codex` ^0.164.0 → **^0.165.0** (a fresh
            // install resolves 0.165.0); `@agentclientprotocol/sdk` stays
            // ~2.0.2 and `engines` is still absent. The 20.3.0 floor stands:
            // the new code reaches for no Node API past 20.3, and live on
            // 20.3.0 a session runs a plain, a shell, a steered and a citing
            // turn. Under codeg's exact `clientCapabilities` the adapter's
            // 33-scenario harness replays byte for byte as on 2.3.0, and so do
            // `initialize` (bar the version) and a live plain and shell turn,
            // bar the model list of (pp). Live runs show the rest, below.
            //
            // (oo) **#593 honors the steering `promptRequired` opt-in**, so
            // codex steers natively from this release
            // (`steering_prompt_required_min_version`, measured there). A
            // note sent while an approval card is open goes to the queue
            // instead (`steering_waits_out_open_permission`).
            //
            // (pp) codex 0.165 adds **GPT-6.1 Terra** (`gpt-6.1-terra`,
            // priority 7: listed after 5.6 Sol, ahead of 5.6 Terra; 500K
            // context window). It is not the default, which stays GPT-6.1
            // Sol. The offline snapshot is regenerated (12 slugs, no
            // `ModelInfo` field added; `codex_model_catalog.rs` has the
            // re-probe), and `CODEX_NESTED_VERSION_FALLBACK` moves with it.
            //
            // (qq) #698 rewrites the model's file citations,
            // `:codex-file-citation{path="…" purpose="…"}`, as Markdown links
            // for every client, live and on replay: a relative path resolves
            // against the session cwd, and citations in code or escaped with
            // `\` stay as written. No setting turns the directive off. Live
            // text is held back while a directive or a backtick run may still
            // continue, and flushed when the message completes. The rollout
            // keeps the directive, so `parsers::codex` applies the same
            // rewrite (`parsers::codex_file_citations`).
            //
            // (rr) #697: a turn whose ChatGPT login cannot reach chatgpt.com
            // to look up its workspace ("workspace routing discovery failed" /
            // "… timed out") gets an explanation for its `sessionFailure`
            // title, and the record's category moves from `service` to
            // `connection` (actions retry and new session). codeg shows the
            // record as sent, and `acp::service_error` ports the title rule
            // for the reloaded failure line and the compaction card.
            //
            // (ss) codex 0.165 itself, as codeg meets it:
            //   * `gcp` (Google Cloud Vertex AI) is a new built-in provider id.
            //     A `[model_providers.gcp]` table may now set only `base_url`,
            //     `auth` and `http_headers`; any other field fails the whole
            //     config. codeg's provider binding treats it like the other
            //     built-ins (`codex_catalog_commit::BUILT_IN_PROVIDERS`), and
            //     so does the panel's WebSocket switch.
            //   * `reasoning_effort_override` is on by default: a mid-thread
            //     effort change reaches a Responses-Lite model as a
            //     `configuration_update` input item, which the rollout
            //     records as a `response_item`. It applies to the built-in
            //     OpenAI provider only (`is_openai()`), so a bound provider
            //     gets none, and `parsers::codex` renders nothing for it.
            //   * A model-not-found provider error ends the turn at once
            //     (`codexErrorInfo: "modelNotFound"`) instead of retrying.
            //     The adapter's error table has no entry for the new value,
            //     so the record is a `service` failure offering Retry.
            //   * Not read by codeg: attached forks (`session_meta
            //     .attached_thread`, behind an experimental `thread/fork`
            //     flag the adapter does not send), the Guardian review timeout
            //     (`[auto_review] timeout_ms`), memory v2 defaults, and the
            //     new nested catalog members (`model_messages
            //     .permissions.writable_root(s)`, `tools.history` / `notes` /
            //     `context_management`).
            //
            // (tt) Inert or not adopted. #682, #684–#688 bring standard ACP
            // subagent sessions (a child session id per sub-agent, its
            // history replayed under it, permissions routed through it, a
            // cancel capability). The adapter serves them only to a client
            // that is not AIR (v1 opts in with `clientCapabilities.subagents`,
            // v2 gets them unasked); an AIR client keeps the
            // `nativeSubagentSessions` contract, which codeg does not declare
            // (see `build_client_capabilities` in connection.rs), so codeg
            // gets the same tool-call fallback as on 2.3.0. #669 (batch
            // session lookup) and #689 (a faster session list) shape
            // `session/list`, which codeg does not send.
            //
            // 2.5.0 keeps `@openai/codex` at ^0.165.0 (a fresh install
            // resolves the same 0.165.0 binary, so the offline catalog
            // snapshot stands) and moves `@agentclientprotocol/sdk`, which
            // the bundle carries inline, ~2.0.2 → ~2.1.0. `engines` is still
            // absent, and the 20.3.0 floor stands: the new code reaches for
            // no Node API newer than 16.9, and live on 20.3.0 a session runs
            // a plain, a shell, a steered and a predicted turn. Under codeg's
            // exact `clientCapabilities` the 33-scenario harness replays byte
            // for byte as on 2.4.0, and so does `initialize` (bar the
            // version). Live against a scripted Responses server, 2.5.0
            // matches 2.4.0 frame for frame (plain, shell and citing turns;
            // steers while a turn streams, while idle, before the turn starts,
            // under an approval and under a plan review; a replayed load),
            // bar the frames of (uu).
            //
            // (uu) **#703 predicts the user's next prompt** after a turn that
            // ends normally, for an AIR client, as `session_info_update
            // ._meta.promptSuggestions = {suggestions: [{text}]}`. That is
            // claude-agent-acp's key and shape, so `prompt_suggestion_update`
            // already reads it and the composer offers it. Codex predicts
            // nothing itself: the adapter makes one more model call per turn,
            // an ephemeral thread on the title model `gpt-5.6-luna` with a
            // JSON output schema, fed the turn's prompt text and its last
            // final answer (each cut at 4000 UTF-16 units). Measured: the
            // offer lands one model call after the prompt response, and the
            // next prompt sends `suggestions: []` before its turn starts. A
            // prediction still in flight when the next prompt starts is
            // dropped, never sent late. A cancelled turn predicts nothing, an
            // empty prediction sends nothing, and `session/load` replays
            // none. The ephemeral thread leaves no rollout and no `threads`
            // row. On a provider without the title model the call fails once
            // (no retry, even with default retry settings) and nothing
            // reaches the session; the title generator has made the same
            // failing call once per session since 1.8.0, and this one makes
            // it once per turn. `CODEX_ACP_PROMPT_SUGGESTIONS=false` turns it
            // off, with no request at all. codeg sets it for the connections
            // nobody types into
            // (`connection::apply_codex_prompt_suggestion_policy`), which is
            // also why a Claude session of theirs asks for none.
            //
            // (vv) #704 aligns errors with the protocol text of SDK 2.1. A
            // request naming a session the adapter does not hold
            // (`session/prompt`, `set_config_option`, `set_mode`,
            // `_session/steering`) answers -32002 with `data.sessionId`,
            // where 2.4.0 answered -32603 "Session <id> not found" (and a
            // steer `{outcome: "failed"}`). codeg reads -32002 on a prompt as
            // the end of the connection's session
            // (`prompt_rejection_is_terminal`), which is what it means, and
            // codeg only ever prompts the session it opened. `session/load`
            // and `session/resume` of an unknown thread still answer -32603
            // "no rollout found", so `classify_session_load_failure` sees no
            // change. The rest reaches nothing codeg sends: an `audio` block
            // is refused -32602 before any of the prompt is inserted (codex
            // advertises no audio, and codeg sends none), an SSE or ACP MCP
            // server -32602 instead of -32600 (codex advertises HTTP only,
            // and codeg filters on that), and an unknown authentication
            // method -32602 instead of -32600 (codeg never authenticates
            // codex). The SDK's v1 schema changes reach nothing codeg sends
            // either: a `null` list now reads as empty, and an integer field
            // (a request id, a token count, a resource link's `size`) takes
            // any 64-bit integer but no longer a fraction. codeg's request ids
            // are integers, and its resource links carry no `size`. The v2
            // command discriminator and initialize rules do not apply to
            // codeg's v1 connection.
            distribution: AgentDistribution::Npx {
                version: "2.5.0",
                package: "@agentclientprotocol/codex-acp@2.5.0",
                cmd: "codex-acp",
                args: &[],
                env: &[],
                node_required: Some("20.3.0"),
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
                version: "2026.9.8",
                package: "openclaw@2026.9.8",
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
                // 26.0.x windows.) 2026.9.4 through 2026.9.8 leave that range
                // and those floors untouched (`node-version.mjs` is
                // byte-identical), and the `supports_mcp: false` anchor still
                // reads verbatim: `assertSupportedSessionSetup` throws "ACP
                // bridge mode does not support per-session MCP servers" from
                // `dist/server-*.mjs` at the same 3 call sites (`newSession`,
                // `loadSession`, `resumeSession`), with `acp` registered in
                // `dist/acp-cli-*.mjs`.
                //
                // 2026.9.8 moves nothing codeg touches. Its ACP bridge
                // (`dist/server-*.mjs`) matches 2026.9.7's line for line apart
                // from the order and hashed names of its imports;
                // `dist/acp-cli-*.mjs`, which defines the `--url`, `--session`
                // and `--reset-session` flags codeg passes, is unchanged; and
                // `@agentclientprotocol/sdk` stays at 1.4.0. The one launch-path
                // change is Windows-only: a compile-cache path longer than 200
                // characters now turns the cache off and says so on stderr.
                //
                // 2026.9.7 leaves `initialize` and the update kinds alone and
                // changes two paths codeg only sees through their output. A
                // streamed reply is merged from delta-only gateway frames
                // (`mergeChatStreamMessage`), still reaching codeg as message
                // and thought chunks. And a prompt cut off by a gateway
                // disconnect is now rebuilt from the session's chat history;
                // when that fails, the bridge sends an `agent_message_chunk`
                // "[OpenClaw interruption] Full reply recovery unavailable
                // (<reason>). Check the session history." and fails the
                // `session/prompt` with that message, which codeg reports like
                // any other failed prompt.
                //
                // 2026.9.6's one wire-visible change is ORDER: `session/update`s
                // for a session are now held until that session's
                // `session/new` answer has been written
                // (`AcpSessionNewOrdering`). The ACP SDK writes a result only
                // after its handler returns, so updates sent from inside
                // `session/new` used to reach the wire first. codeg is
                // indifferent to which order it gets: it can only register a
                // session's router once the answer names the id, and anything
                // that arrives before then is parked and replayed into that
                // router (see `acp/agent_session.rs`), so both orders deliver
                // the same updates.
                node_required: Some("24.16.0"),
            },
        },
        AgentType::Cline => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "Cline",
            description: "Autonomous coding agent CLI",
            // 3.0.66 moved cline's build from Bun 1.3.13 to 1.4.2, and from
            // then on its darwin-arm64 binary passes `codesign --verify
            // --strict` (3.0.74's still does, still on Bun 1.4.2). Its
            // darwin-x64 binary fails that check from 3.0.66 through 3.0.74: it
            // keeps the Developer ID signature of Bun's own runtime over a file
            // that no longer matches it; whether macOS kills it was not tested.
            // The earlier pins checked (3.0.55, 3.0.60–3.0.65) all shipped
            // Bun's broken ad-hoc signature (the last, partial page hashed as
            // if zero-padded), and macOS 27 SIGKILLs such a binary when its
            // exit path reads that page (`atexit` → `dladdr`): there even
            // `cline --version` exited 137, and ACP sessions died within a
            // second of `initialize`.
            //
            // 3.0.74 changes one thing on the ACP surface: the `provider`
            // selector's `category` moves from `model` to `_provider` (the
            // Account selector's from `account` to `_account`), so `model` is
            // now the only `category: "model"` option. Before, on a sign-in
            // launch, where codeg leaves the provider selector visible, the
            // provider came first under that category, so the model codeg
            // records for each turn (`current_model_id_from_opts`) was the
            // provider id (`cline`); it is now the model. codeg's own handling of
            // `provider` goes by its id, which did not change.
            // Otherwise `initialize` (`protocolVersion: 1`), `session/new`,
            // `session/load` and prompt turns (text, a `read_files` call with
            // its permission request, failed turns) match 3.0.73 but for the
            // version, as do the session files those turns write. A session
            // still gets thinking only from an explicit `--thinking` (3.0.71
            // made the flag count there, not reasoning saved in cline's
            // provider settings), which codeg does not pass, so it runs with
            // thinking off and no effort. `--acp` still sets
            // `enableAgentTeams: false`, and the SDK still scans a workspace's
            // `.claude/skills`, which codeg's skill spec for Cline lists.
            //
            // What else 3.0.74 changes reaches codeg through its SDK, which went
            // from 0.0.95 to 0.2.0 only so that `@cline/ui` can share its
            // version. A request that fails with a retryable HTTP error is now
            // retried 3 times instead of 5 (live, an HTTP 500 failed the prompt
            // after 4 attempts and about 14 s, where 3.0.73 made 6 attempts over
            // about 62 s). A turn whose connection drops after the model has
            // streamed only reasoning is now retried instead of failing the
            // prompt: codeg keeps the reasoning it already received and then
            // gets the retry's, while cline stores only the retry's. The model
            // catalog changed: the `cline` provider drops 17 ids and adds 8, and
            // `cline-pass` drops 4, adds 6 and now defaults to
            // `cline-pass/kimi-k3.1-pro`; a saved pick of a dropped id is no
            // longer offered. The `cline` provider's bundled default (used when
            // `CLINE_MODEL` is unset) is still `anthropic/claude-sonnet-5.5`.
            // Since 3.0.73 a request whose model id names gpt-6 through gpt-9
            // (`gpt-6-sol`, `gpt-6.1-sol`) sends its token limit as
            // `max_completion_tokens`, which gpt-5 ids already did, on the
            // `cline` and `cline-pass` providers and the OpenAI-compatible ones
            // (seen live again on an OpenAI-compatible model on 3.0.74).
            //
            // Since 3.0.72 a provider error that arrives after a reply has
            // started streaming is retried up to 3 times, back to back, and
            // what the failed attempt already streamed is not taken back: codeg
            // receives that partial text followed by the retry's full reply,
            // cline stores the two as one assistant message, and later turns
            // send the model that message. When every attempt fails, the
            // partial text repeats once per attempt. A provider's HTTP error
            // ends its message with "(Request ID: <x-request-id>)", in the
            // `session/prompt` error and in the display-only error record
            // alike. A 3.0.74 `cline --acp` loads and continues the sessions
            // 3.0.73 wrote.
            //
            // codeg runs each Cline session inside the `cline --acp` process it
            // spawned (`CLINE_SESSION_BACKEND_MODE=local` below, unless a
            // per-agent env row overrides it), not on cline's hub daemon,
            // because a model switch is lost there. By
            // default ("auto") a session runs on whatever compatible hub is
            // already up, normally the detached one an earlier `cline --acp`
            // started (only a process that finds none runs its session itself).
            // The hub runtime has no `updateSessionModel`, so once a session
            // has started (its first prompt, or `session/load`) the ACP agent's
            // call to it does nothing: `session/set_config_option` and
            // `config_option_update` report the new model while every request
            // keeps the old one, and a reopened session never takes the model
            // codeg re-applies. The in-process runtime applies the switch to
            // the next request. Both seen live on 3.0.72 and 3.0.73; on 3.0.74
            // the in-process switch was seen live again, and the hub runtime
            // still has no `updateSessionModel`. In local mode, with the updater
            // below off, cline neither looks for a hub nor starts one (live on
            // 3.0.74, nothing connected to the hub port), so codeg leaves no hub
            // daemon behind and never replaces one the user's own cline is
            // running (live, a 3.0.72 hub kept its pid while 3.0.73 sessions
            // ran). A `plan`/`act` mode switch after the first prompt is still
            // lost on either runtime: the ACP agent only records it, and a mode
            // reaches the model's prompt and tools only when the session is
            // built. Since each session now lives and dies with its own process,
            // the next Cline launch closes it for that dead process (`status:
            // "failed"`, `ended_at` = the launch), and `parsers::cline` keeps the
            // transcript's last write as its end.
            //
            // Every `cline` process, `--acp` included, also asks npm for a newer
            // release at startup, and on a normal exit (its stdin closing) with
            // one found it spawns a detached `npm update -g cline --tag latest`
            // unless another CLI is attached to a hub. Under codeg's `npm
            // install -g` that moves the pinned install to an unaudited release
            // (live, a 3.0.72 install was on 3.0.73 about 48 s after its
            // session ended), and in-process sessions are attached to no hub,
            // so it could swap the binary under the Cline sessions codeg still
            // runs. `CLINE_NO_AUTO_UPDATE=1` turns the updater off (live,
            // nothing is spawned and the install stays put); Cline upgrades
            // through this pin.
            //
            // MCP reaches cline only through its own settings file. Its ACP
            // agent keeps the `mcpServers` of `session/new` and `session/load`
            // and never connects them (the same in every release from 3.0.55
            // through 3.0.74; live on 3.0.71 through 3.0.74, a stdio server sent
            // there is never started), so codeg forwards none and injects no
            // codeg-mcp companion (see `agent_delivers_wire_mcp`). The servers
            // codeg's MCP settings write to
            // `~/.cline/data/settings/cline_mcp_settings.json` are started, and
            // their tools reach the model. Their connect budget has been 10 s
            // since 3.0.69 (`DEFAULT_MCP_CONNECT_TIMEOUT_MS`, still 10 s in
            // 3.0.74).
            //
            // Earlier releases moved what reaches codeg through the SDK. Since
            // 3.0.69 a reply whose finish reason the AI SDK does not recognise
            // is continued once, and the nudge cline sends for it ("Previous
            // turn ended unexpectedly. Continue from where you left off.") is
            // persisted as a `role:"user"` message flagged `displayRole:
            // "system"`, which `parsers::cline` keeps out of the transcript
            // along with cline's other model-only messages; live, the two
            // halves arrive as one message. What moved in 3.0.66 is token
            // accounting; see `outputTokens` in `parsers::cline`.
            distribution: AgentDistribution::Npx {
                version: "3.0.74",
                package: "cline@3.0.74",
                cmd: "cline",
                args: &["--acp"],
                // In-process runtime, not the hub, and no self-update: see
                // above. A per-agent env row still overrides either.
                env: &[
                    ("CLINE_SESSION_BACKEND_MODE", "local"),
                    ("CLINE_NO_AUTO_UPDATE", "1"),
                ],
                node_required: Some("22.0.0"),
            },
        },
        AgentType::OpenCode => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "OpenCode",
            description: "The open source coding agent",
            // OpenCode 2. 2.2.0 (2026-10-27) is the first 2.x release on
            // GitHub, and the ACP registry's `opencode` entry moved to it the
            // same day (GitHub's "latest" still marks 1.19.4). The archives
            // keep the 1.x names and layout, a single `opencode` /
            // `opencode.exe` at the root, and the darwin binaries carry the
            // Developer ID signature 1.18.34 introduced: 2.2.0's darwin-arm64
            // passes `codesign --verify --strict`.
            //
            // codeg no longer runs 1.x (`opencode_launch` refuses it). 2.x
            // reads only `opencode.json` / `opencode.jsonc` and normalizes the
            // 1.x keys it still accepts in memory, keeps credentials in the
            // `credential` table of `opencode.db` (it imports `auth.json` once,
            // when it first upgrades a 1.x database), and stores sessions in
            // `session_v2` / `session_message`, into which it migrates 1.x
            // sessions once. codeg's settings write the 2.x shapes.
            //
            // `acp` takes no options besides `--login` (an interactive `auth
            // login`). It starts a private `serve --stdio` server on an
            // automatic loopback port that reads no `server.*` config, so the
            // listen flags 1.x needed (codeg#860) are gone, and the CLI would
            // reject them. It never runs the self-updater, which only the
            // default (TUI) command starts. The ACP bridge is byte-identical
            // between 2.1.4 and 2.2.0 and differs from 2.0.28 only in how the
            // server is wired up.
            distribution: AgentDistribution::Binary {
                version: "2.2.0",
                cmd: "opencode",
                args: &["acp"],
                env: &[],
                platforms: &[
                    PlatformBinary {
                        platform: "darwin-aarch64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v2.2.0/opencode-darwin-arm64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "darwin-x86_64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v2.2.0/opencode-darwin-x64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "linux-aarch64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v2.2.0/opencode-linux-arm64.tar.gz",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "linux-x86_64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v2.2.0/opencode-linux-x64.tar.gz",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "windows-aarch64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v2.2.0/opencode-windows-arm64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "windows-x86_64",
                        url: "https://github.com/anomalyco/opencode/releases/download/v2.2.0/opencode-windows-x64.zip",
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
            // postinstall clones the OFFICIAL repo at tag v0.22.2 verifying the
            // full commit SHA (d923a5eb…), bootstraps an isolated, uv-managed
            // Python 3.14 venv with a checksum-pinned uv, and runs `uv sync
            // --frozen --extra all --no-dev` (⊇ the acp+mcp extras) from
            // upstream's lockfile — all inside the npm package directory;
            // config/credentials stay in `~/.hermes`. Its `hermes` bin execs
            // the venv's real upstream console script, so `hermes acp` is the
            // same adapter the official install runs. Keep the pin EXACT on
            // version bumps and re-audit the wrapper diff — the exact pin is
            // what bounds the third-party trust surface. `--frozen` (since
            // 0.21.4, which replaced `--locked`) still installs strictly from
            // upstream's `uv.lock` with its per-artifact hashes and never
            // re-resolves; it only skips the assertion that the lock is in sync
            // with `pyproject.toml`, a check whose strictness varies by uv
            // version. Since the checkout is pinned to an exact commit, that
            // lockfile is fixed content, so the installed dependency set is
            // exactly the pinned one, and `fetchAndVerifyPinnedTag` still
            // hard-compares `rev-parse <tag>^{commit}` against the 40-hex pin
            // before the `checkout --detach`.
            //
            // 0.22.2 audited: every file but `package.json` is byte-identical to
            // 0.22.0 (and to 0.22.1 and 0.21.6), `scripts/postinstall.js`,
            // `bin/` and all of `lib/` (including `uv-installer.js` and its uv
            // 0.12.13 digest table) among them. `package.json` moves the
            // version, its description and the upstream tag and commit;
            // `pythonVersion` stays 3.14. The install marker keys on the
            // version, tag and commit as well as the Python version, so
            // upgrading rebuilds the checkout and its venv. The annotated tag
            // v0.22.2 dereferences to exactly d923a5eb…, tagged by "Hermes
            // Release Automation" on 2026-10-15 (unsigned). That commit is a
            // merge whose tree is the `release/0.22.1` branch head, with v0.22.1
            // (297552a9…) as its second parent: upstream cut v0.22.1 from
            // `main` by mistake, and v0.22.2 is the release it was meant to be,
            // so this pin skips 0.22.1. Its `uv.lock` moves `httpx2` and
            // `httpcore2` from 2.7.0 to 2.12.0 and adds an emscripten-only
            // `httpx2-jsfetch`; on macOS arm64 `--extra all` still installs 106
            // packages.
            //
            // Upstream's `acp_adapter/` is byte-identical from v0.22.0 to
            // v0.22.2, as are the `hermes_state*.py` modules and the toolset
            // code, and `state.db` stays at schema 31 with the same DDL; the
            // live ACP answers match 0.22.0's apart from `agentInfo.version`.
            // At stdio shutdown the adapter stamps `ended_at` (`end_reason =
            // 'acp_disconnect'`) on every session it holds, and `session/load` /
            // `session/resume` clear it, so the column does not mean the
            // transcript's end; `parsers::hermes` reads a session's last
            // activity from its newest message instead. Load and resume also
            // rewrite the session's active message rows: each row gets a new
            // `id` and keeps its `message_uid`, timestamp and order. A literal
            // message that begins with the `\x00json:` content sentinel is
            // stored escaped, which `parsers::hermes` decodes as text, until
            // that rewrite stores it decoded, as a parts array. The rest leaves
            // codeg's assumptions standing: the per-platform toolset resolver
            // (`platform_toolsets.acp`, `agent.disabled_toolsets`; codeg writes
            // neither), every enabled `mcp_servers` entry switched on by
            // default, and servers handed over on `session/new` (codeg-mcp
            // included) appended unconditionally as `mcp-<name>`, their tools
            // named `mcp__<server>__<tool>`. A fresh session's default toolset
            // carries `browser_exec` and a single `browser_vault` tool; by
            // default `browser_vault` and every MCP tool are reached through
            // the `tool_search` / `tool_describe` / `tool_call` bridge rather
            // than listed to the model directly. The adapter installs the OS
            // trust store before any outbound call, and `agentInfo.version`
            // comes from the pinned tag ("0.22.2").
            //
            // Held at 0.22.2. From 0.22.3 `hermes acp` is a viewer: sessions,
            // turns and MCP servers run in a shared `gateway run --idle-exit`
            // daemon, which the first viewer for a `HERMES_HOME` starts with its
            // own environment and later viewers share. Measured on 0.22.5,
            // codeg's process-tree stop takes the daemon down with the viewer
            // that started it, so the other Hermes conversations lose it too
            // (their next prompt starts a new one). And in a session that also
            // got MCP servers over the wire, as every session with codeg-mcp
            // injected does, each call to a config.yaml `mcp_servers` entry
            // fails with "MCP server '<name>' is not connected" (upstream issue
            // #143502, open as of 0.22.5). Re-check both before moving the pin.
            //
            // Launch preference: `resolve_npx_command("hermes")` checks PATH,
            // then `~/.local/bin` (the official installer's target), then the
            // npm global prefix. Whatever is on the app's PATH wins first; past
            // that, an official-installer `hermes` (which self-updates)
            // outranks the npm-managed copy even when the app's PATH lacks
            // `~/.local/bin`. The npm global install is the managed/one-click
            // channel codeg's Install button drives.
            distribution: AgentDistribution::Npx {
                version: "0.22.2",
                package: "hermes-agent@0.22.2",
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
            // 2.160.0 through 2.161.2 loaded `esbuild` unguarded at startup
            // while listing it only as an OPTIONAL dependency, so an install
            // that skipped optional deps died on `--acp` ("Cannot find module
            // 'esbuild'"); codeg's own `npm install -g` passes
            // `--include=optional`, so managed installs always had it. 2.161.3
            // dropped `esbuild` entirely (no dependency lists it, no bundle
            // loads it), and 2.168.2 still answers `initialize`, and runs whole
            // turns, from an install without optional dependencies. Neither
            // declared dependency is loaded at runtime: the bundles carry their
            // own copies of `@openai/agents-core` and of the ACP TypeScript
            // SDK. 2.167.0 swapped `@agentclientprotocol/sdk-server` (an alias
            // of `@agentclientprotocol/sdk@1.4.0`) for
            // `@agentclientprotocol/sdk@1.7.0` and moved the inlined copy to
            // 1.7.0 with it. `--acp` runs `dist/codebuddy-headless.js`, which
            // the launcher picks for it, not `dist/codebuddy.js`.
            //
            // The 1.7.0 transport caps an incoming line at 32 MiB, and a longer
            // one gets no error reply: 2.168.0 and 2.168.2 stop reading stdin
            // and never answer again, though the process stays up, where
            // 2.164.0 read and answered the same 33 MiB line. A prompt reaches that size with
            // roughly 24 MiB of images, which codeg's attachment limits allow.
            // The transport also honours `$/cancel_request` now, but a
            // `session/prompt` it names keeps running until `session/cancel`,
            // as before.
            //
            // Otherwise 2.167.0 and 2.168.0 (2.165.0 and 2.166.0 were never
            // published) leave the wire codeg reads alone: `initialize` and the
            // unauthenticated `session/new` answer match 2.164.0, no
            // `sessionUpdate` kind or `session/*` method came or went, and
            // argument streaming is the same code. Recorded turns (text, a Read
            // over `fs/read_text_file`, a Bash call over `terminal/create`, a
            // sub-agent, an MCP tool behind `DeferExecuteTool`) match 2.164.0
            // frame for frame apart from usage numbers and the notifications
            // below. Argument-streaming `tool_call_update` frames carry the
            // sub-agent link (`codebuddy.ai/parentToolCallId`) inside `_meta`,
            // where codeg nests child calls from, and after a call's first frame
            // they are merged over a 100 ms window (flushed early at 64 KiB),
            // each merged frame carrying the latest `rawInput` and `_meta`.
            //
            // 2.168.2 (2.168.1 was never published; 2.168.2 republishes it)
            // leaves that wire alone too: the inlined ACP SDK is the same 1.7.0
            // copy, no `sessionUpdate` kind, `session/*` method or
            // `_codebuddy.ai/*` notification came or went, and the recorded
            // turns, `/init` with its `session/load` replay, a denied
            // permission, both cancel paths and the 33 MiB stall match 2.168.0
            // frame for frame apart from usage numbers. It ships sandbox-cli
            // 5.9.0-beta.8, an older build than 2.168.0's beta.9, which runs
            // only while a session's `sandbox` config option is on (off by
            // default); Bash goes over `terminal/create` either way.
            //
            // Mods (function hooks) load by default. While loaded they send
            // `_codebuddy.ai/modRenderInvalidate` to every connection and, since
            // 2.167.0, `_codebuddy.ai/modSlots` only to connections that hold a
            // session; neither names one, so they are never parked for a
            // session router. 2.167.0 added `_codebuddy.ai/modResidentInvalidate`
            // `{sessionId, generation}`, sent whenever the mods reload,
            // including right after `session/new` and `session/load` with no mod
            // installed. It names the session, so it reaches that session's
            // router, which ignores it like any ext notification codeg does not
            // know. 2.168.0 and 2.168.2 also repeat `available_commands_update`
            // (same list) about two seconds after `session/new`.
            //
            // Three changes reach the history parser. 2.162.0 through 2.164.0
            // persisted task-list reminders for the model as `<system-reminder>`
            // user records flagged `isMeta`; 2.167.0 stopped writing them but
            // leaves those already on disk, which `parsers::codebuddy` drops like
            // every injected record. Since 2.167.0 a built-in prompt command
            // such as `/init` is stored as its `<command-message>` /
            // `<command-name>` (and `<command-args>`) tags followed by the prompt
            // it expands to, where 2.164.0 stored the expansion alone; custom
            // commands were already stored that way. CodeBuddy's own replay
            // shows the command as typed, and `parsers::codebuddy` folds the
            // record back to it the same way. And `--acp` no longer prunes old
            // sessions: the 30-day cleanup runs only when
            // `CODEBUDDY_SESSION_HISTORY_CLEANUP` is `1`/`true`, which the
            // launcher sets for interactive launches only, so CodeBuddy's own
            // interactive runs still clean the directory codeg reads. The usage
            // writer is the same code from 2.164.0 through 2.168.2: a Chat
            // Completions model's records carry the provider's `prompt_tokens`
            // / `completion_tokens`, a custom Responses-API model's (2.163.0+)
            // the agents SDK's `inputTokens` / `outputTokens`, on the last item
            // of each response (a `function_call` when the request ends in a
            // tool call); the parser reads both. 2.168.2 adds a
            // `providerData.contextTokens` to the compaction summary record,
            // which the parser does not read, and a `request-recovery` record
            // that only CodeBuddy's SDK server writes, never `--acp`; the
            // parser skips it like any record type it does not know.
            //
            // 2.168.2's interactive TUI starts a new blank session in PTC mode
            // (Code Mode), where the model's only direct tool is `REPL`, whose
            // JavaScript calls the other tools. `--acp` sessions skip that
            // default, and a host that does not declare `mainAgentSupport`
            // (codeg does not) gets standard mode even for a session the TUI
            // ran in PTC: `session/load` and `session/resume` then offer the
            // standard tools, and the load replay announces the old `REPL`
            // calls like any tool call. On disk a PTC step is one
            // `function_call` named `REPL`, with `code` and `description` as
            // its arguments, and a result whose text is a `{result, stdout,
            // stderr}` JSON object; the tools that code called leave no records
            // of their own (2.171.0 adds a `replToolCalls` list of them to the
            // result, which the parser does not read). The `session-meta`
            // records keep saying `codebuddy.ai/mainAgent: "ptc"` after
            // standard turns join the file; each record's `providerData.agent`
            // (`ptc`, then `cli`) is what tells the turns apart.
            // `parsers::codebuddy` shows each step as a `REPL` tool card and
            // skips `session-meta`.
            //
            // 2.170.0, after 2.168.3 and 2.169.0, keeps `bin/codebuddy` and the
            // inlined ACP SDK byte for byte. It still answers `initialize` with
            // `protocolVersion: 1` and runs whole turns from an install without
            // optional dependencies, and no `sessionUpdate` kind, `session/*`
            // method or `_codebuddy.ai/*` notification came or went. Recorded
            // turns (text, Read and Write/Edit over `fs/*`, Bash over
            // `terminal/create`, a sub-agent, an MCP tool behind
            // `DeferExecuteTool`, a denied permission, both cancel paths, `/init`
            // with its `session/load` replay) match 2.168.2 frame for frame apart
            // from usage numbers and a new `_meta.effortOptions` list on each
            // `models.availableModels` entry, which codeg does not read, and the
            // 33 MiB line still stalls stdin. `session/load` now replays an image
            // the user attached as a `resource_link` to its file under
            // `~/.codebuddy/blobs/` rather than a base64 `image` block, whatever
            // the client advertises; codeg drains that replay unread. The
            // transcript records the parser reads keep their shape, and
            // sandbox-cli 5.11.0-beta.1 still runs only while a session's
            // `sandbox` option is on. A codeg-launched CodeBuddy does not update
            // itself: the auto-update scheduler, and the `autoUpdates` /
            // `DISABLE_AUTOUPDATER` gate on it, ship only in the interactive
            // `dist/codebuddy.js`, not in the headless bundle `--acp` runs.
            //
            // 2.171.0 keeps `bin/codebuddy` byte for byte, and its inlined ACP
            // SDK is the same 1.7.0 copy apart from minified names;
            // `package.json` changes only its version. `initialize` answers
            // exactly as before (`protocolVersion: 1`), no `sessionUpdate`
            // kind, `session/*` method or `_codebuddy.ai/*` notification came or
            // went, and the recorded turns (2.170.0's set, plus an attached
            // image and a sandboxed Bash) match 2.170.0 frame for frame apart
            // from usage numbers. So do the transcripts and blob store the
            // parser reads. The 33 MiB line still stalls stdin, the headless
            // bundle still has no auto-update scheduler, and an install without
            // optional dependencies still runs whole turns. A turn can now take
            // longer: a model request that fails before generation starts is
            // retried as the gateway's `retry_policy` allows or, without one,
            // on 429, 408, 409 and 5xx other than 570–579, up to 8 times with
            // waits from 1 s doubling to 32 s (longer when the server's
            // `Retry-After` asks). Nothing new reaches the wire while it waits,
            // and stopping the turn ends the wait.
            //
            // 2.177.0 (after 2.172.1, 2.173.0, 2.174.0, 2.175.0 and 2.176.0;
            // 2.172.0 was never published) changes `bin/codebuddy` only by a
            // `daemon status` shortcut behind `CODEBUDDY_DAEMON_STATUS_BRIEF=1`;
            // `--acp` still runs `dist/codebuddy-headless.js`. Its inlined ACP
            // SDK is now 1.9.0 with the same transport, so the 33 MiB line still
            // stalls stdin and `$/cancel_request` still leaves a prompt running
            // until `session/cancel`. One SDK change is stricter: a
            // `session/new` or `session/load` whose `mcpServers` holds an entry
            // that fails the schema is now refused whole (-32602) where 2.171.0
            // dropped that entry. codeg's typed entries always pass, and a stdio
            // server handed over on `session/new` still starts and reaches the
            // model. `initialize` still answers `protocolVersion: 1` (adding
            // `codeModeSupport`), no `sessionUpdate` kind or `session/*` method
            // came or went, and an install without optional dependencies still
            // runs whole turns. `delegate` left the modes and the `mode` option
            // (`session/set_mode` to it now fails; codeg skips a saved mode the
            // session no longer lists), `/delegate` joined the commands, and a
            // `codeMode` option (`off` by default, `all` for PTC) joined the
            // selectors; it locks after the first reply. With `all`, the calls
            // the REPL makes arrive as tool calls of their own, without their
            // input and linked to the REPL call only by
            // `_meta["codebuddy.ai"].toolMetaData.replOrigin.containerToolCallId`.
            // codeg nests a CodeBuddy tool call only under a sub-agent's Agent
            // call (`codebuddy.ai/parentToolCallId`), so they show as cards of
            // their own. Models, `thought_level`, `sandbox` and `multitask` keep
            // their values. Otherwise the recorded turns match 2.171.0 frame for
            // frame apart from usage numbers, a `timestamp` in a cancelled
            // prompt's `_meta`, and a sandboxed Bash's `tool_executing` phase
            // update arriving when the command starts. Transcripts gain
            // `session-meta` records with a `contextWindow` and, in Code Mode, a
            // `replPresentation` in the REPL result; the parser reads neither.
            // The headless bundle still has no auto-update scheduler, and a
            // retry now waits 90–110% (was 75–100%) of 1 s doubling to 32 s.
            //
            // 2.177.1 changes `bin/codebuddy` only by a comment, and `--acp`
            // still runs `dist/codebuddy-headless.js` with the same inlined ACP
            // SDK 1.9.0, so the 33 MiB line still stalls stdin and
            // `$/cancel_request` still leaves a prompt running until
            // `session/cancel`. `initialize` and the unauthenticated
            // `session/new` answer exactly as before (`protocolVersion: 1`),
            // every selector offers the same values, no `sessionUpdate` kind or
            // `session/*` method came or went, and an install without optional
            // dependencies still runs whole turns. The recorded turns (2.177.0's
            // set, plus a Stop while a permission request is pending) and their
            // transcripts match 2.177.0 apart from usage numbers. One
            // notification is new: when an auxiliary model call (the Explore
            // sub-agent's, say) on a lite model the user set in
            // `variantModels.lite` fails with HTTP 401, CodeBuddy deletes that
            // setting and sends `_codebuddy.ai/liteModelReset` `{sessionId,
            // previousModelId, defaultModelId}`, possibly after the turn's
            // answer. It names the session, so that session's router ignores it
            // like any ext notification codeg does not know. The headless bundle
            // still has no auto-update scheduler, the retry policy is unchanged,
            // and the new background-session prewarm pool serves only the
            // daemon's job workers.
            //
            // Two behaviours around a Stop, the same in 2.171.0, 2.177.0 and
            // 2.177.1, need codeg's help. CodeBuddy answers a `session/prompt`
            // that starts within 500 ms of a `session/cancel` it took mid-turn
            // with `cancelled`, without running the prompt or keeping it in its
            // history, so codeg holds the first prompt after a Stop until 600 ms
            // after the cancelled prompt's answer (`CODEBUDDY_CANCEL_BARRIER` in
            // `acp::connection`). And after a Stop that caught a permission
            // request, CodeBuddy answers the next prompt it runs `cancelled`
            // although it finished, with `_meta["codebuddy.ai/finishReason"]:
            // "stop"`, which codeg ends as `end_turn` (`codebuddy_stop_reason`).
            //
            // Held at 2.177.1. In 2.178.1 (after 2.178.0) an MCP tool cannot be
            // allowed once. The model reaches an MCP tool through
            // `DeferExecuteTool`, and 2.178.1 asks for permission twice under
            // the same `toolCallId`, first for `DeferExecuteTool` and then for
            // the MCP tool itself. It resolves the second ask as a denial
            // (`_meta["codebuddy.ai/decision"]: "deny"`) whether the client
            // answers it Allow or Always Allow. So the server's tool is never
            // called, the call fails with "The user doesn't want to proceed
            // with this tool use…", and the prompt answers `cancelled` with
            // `codebuddy.ai/outcome: "PERMISSION_DENIED"`. Only Always Allow on
            // the first ask lets the call through, and codeg cannot choose that
            // for the user. Measured with a stdio MCP server handed over on
            // `session/new`, the way codeg-mcp arrives; 2.177.1 asks once and
            // runs the tool. 2.178.1 also stops offering Code Mode to a client
            // that does not declare `mainAgentSupport`, as codeg does not
            // (`codeModeSupport: false`, and setting `codeMode` fails -32602).
            // Re-check both before moving the pin.
            distribution: AgentDistribution::Npx {
                version: "2.177.1",
                package: "@tencent-ai/codebuddy-code@2.177.1",
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
            //
            // 2.1.1 ROLLS BOTH BACK — upstream's own words are "Roll back some
            // of the overly defensive changes in 2.1.0", plus a separate
            // "Revert filesystem watchers for config and workspace files to on
            // by default". The symlink-escape guard's region
            // is deleted outright: no `checkRealPathWithinWorkspace` /
            // `checkRealPathWriteTarget` call and no "through a symbolic link"
            // message is left anywhere in the bundle. The six file tools,
            // `path-access`, `workspaceDirsService`, `projectLocalConfigService`
            // and `watch` are back to their 2.0.2 regions once bundler
            // renumbering is ignored — the build that read through both of
            // codeg's link shapes — and `local.toml` is read without the trust
            // gate again. With watching back on, the 2.1.0 note above about
            // settings changes landing only on the next connect no longer
            // applies. The same rollback also drops 2.1.0's hardening of
            // Kimi's background git calls against repository git config.
            // The mandated check passes verbatim (byte-identical converter
            // body, the same three entry points, `session/fork` still ignoring
            // `mcpServers`, neither `acpMcpServersToConfigs` nor the
            // runtime-identity throw anywhere), `engines.node` is unmoved at
            // >=22.19.0, and all 25 `packages/acp-server/` regions are
            // byte-identical to 2.1.0. The bundled models.dev refresh lifts
            // `kimi-k3`'s output cap but leaves every `moonshotai` context
            // window as it was, so the `infer_context_window_max_tokens`
            // mirror still holds.
            //
            // 2.2.0 leaves the ACP server alone: `packages/acp-server` differs
            // from 2.1.1 only in its changelog and version. The mandated check
            // passes verbatim (byte-identical converter body with
            // `runtime_id: "local"`, the same three entry points,
            // `session/fork` still ignoring `mcpServers`, neither
            // `acpMcpServersToConfigs` nor the runtime-identity throw in the
            // bundle). `engines.node` (>=22.19.0) and the runtime dependencies
            // are unmoved. So are the sources of everything else codeg mirrors:
            // config.toml's provider/model schemas, `KIMI_MODEL_*`, the skill
            // roots, the auth gate, the bundled models.dev rows and the
            // `wire.jsonl` writer. A live A/B against 2.1.1, driven with
            // codeg's config.toml block, gate token and client capabilities,
            // matched on `initialize`, `session/new` (modes, config options,
            // slash commands), the `session/update` kinds and the wire record
            // types. A stdio server handed over on `session/new` is spawned,
            // listed and called, and 2.2.0 resumes and loads a session that
            // 2.1.1 wrote.
            //
            // Four engine changes still reach codeg:
            //
            // - `UserPromptSubmit` hook output is folded into the prompt
            //   message, tagged `meta.source = "user prompt submit hook"`,
            //   instead of a separate `hook_result` message. It now sits in
            //   `turn.prompt`'s input ahead of the typed text, so
            //   `parsers/kimi_code.rs` projects that record the way Kimi does
            //   (`prompt_display`).
            // - The stdio MCP `executor` enum drops the never-implemented
            //   `kaos`. An entry still naming it now fails the whole `mcp.json`
            //   at load, where 2.1.1 refused only that server, so
            //   `commands/mcp.rs` drops it from any entry it saves. An entry
            //   codeg does not touch stays as written: failing the file is
            //   upstream's choice, and quietly turning a `kaos` server into a
            //   local launch is not codeg's to make.
            // - The output cap no longer comes from the declared context size
            //   for a model with no output limit of its own. An `openai` /
            //   `openai_responses` provider then sends no cap at all, a `kimi`
            //   one caps output at the window minus what is in use, and
            //   `anthropic` keeps a default that drops from 128000 to 64000 for
            //   a model Kimi does not recognize. 2.1.1 used codeg's declared
            //   `max_context_size` (`llm.request.maxTokens = 262144`), which an
            //   OpenAI-compatible server rejects when it is above the model's
            //   own output limit. See `KIMI_DEFAULT_MAX_CONTEXT_SIZE`.
            // - `WaitFor`, on by default, caps a wait at 90 s and tells the
            //   model to move on instead of waiting again. More replies
            //   therefore land in a turn Kimi opens itself when a background
            //   task finishes. ACP never forwards such a turn; the parser keeps
            //   its reply and does not show the task `<notification>` as a user
            //   message.
            //
            // One new lever stays unused. `KIMI_CODE_TRUST_WORKSPACE=1` marks
            // the workspace trusted, and trust is what loads a repository's own
            // `.mcp.json` and `.kimi-code/mcp.json`, i.e. commands the
            // repository chooses. Set from codeg, it would start them on the
            // next session with nobody approving them, the hole codeg's old
            // seeding of pi's trust opened (see
            // `commands::acp::pi_project_trust_launch_block`). A user who wants
            // it sets it in the agent's environment. The rest is inert for
            // codeg. NotifyUser now also needs a host that declares the
            // `update_panel` UI capability, which ACP never does. Tower mode,
            // `kimi app`, the TUI work and the opt-in
            // `KIMI_CODE_LLM_HEADERS_TIMEOUT_MS` do not touch `kimi acp`.
            //
            // 2.3.0 passes the mandated check verbatim (the same converter arm
            // with `runtime_id: "local"`, the same three entry points,
            // `session/fork` still ignoring `mcpServers`, neither
            // `acpMcpServersToConfigs` nor the runtime-identity throw in the
            // bundle), and `engines.node` stays at >=22.19.0. One runtime
            // dependency is new: `chokidar`, which earlier releases bundled and
            // `dist/main.mjs` now imports, so the package needs its
            // dependencies installed, as npx does. `packages/acp-server` changes
            // only to map two new session errors, and the sources of the rest
            // of what codeg mirrors are unchanged: config.toml's provider and
            // model schemas (bar two optional keys), `KIMI_MODEL_*`, the skill
            // roots, the auth gate, the `mcp.json` schema, the prompt
            // projection and title rule, the output cap and the `moonshotai`
            // models.dev rows. The `wire.jsonl` writer adds one record type,
            // `changeNotifier.snapshot`, which the parser skips like any record
            // it does not read. A live A/B against 2.2.0, driven like the last
            // one, matched on `initialize` (`protocolVersion: 1`),
            // `session/new`, text and Bash turns, a stdio server handed over on
            // `session/new`, and resuming and loading a session 2.2.0 wrote.
            //
            // What reaches codeg is a session lock: one process at a time holds
            // a session, from opening it or starting a turn until 3 s after it
            // goes idle. Opening a held session from another process fails, and
            // codeg shows that as a busy session with Reload instead of
            // replacing it with a new one (`classify_session_load_failure`). A
            // prompt while another process holds the session answers
            // `session.occupied`, which costs only that turn. Once another
            // process has written the session, every prompt on a connection
            // that opened it earlier answers `session.stale`, so codeg drops
            // that connection and the next one loads the other process's turns
            // (`kimi_session_stale`).
            //
            // 2.3.3 (with 2.3.1 and 2.3.2 in between) passes the mandated check
            // verbatim, and `engines.node` (>=22.19.0), the runtime dependencies
            // and `bin` are unmoved. All 25 `packages/acp-server` regions are
            // byte-identical to 2.3.0, and so are the sources of the rest of what
            // codeg mirrors: config.toml's provider and model schemas,
            // `KIMI_MODEL_*`, the skill roots, the auth gate, the `mcp.json`
            // schema, the prompt projection and title rule, the output cap and
            // the `wire.jsonl` writer. The bundled models.dev catalog adds
            // `kimi-k3.1-pro` and `kimi-k3.1-pro-highspeed` at 1048576 under
            // `moonshotai` and leaves the existing rows alone; the `kimi-k3`
            // prefix in `infer_context_window_max_tokens` already covers them. A
            // live A/B against 2.3.0 matched on `initialize` (`protocolVersion:
            // 1`), `session/new` (the model, thinking and mode values, the slash
            // commands), text, Bash and MCP turns, and the `wire.jsonl` record
            // and loop-event types; neither version sends `max_tokens` to an
            // `openai` provider, and 2.3.3 resumes and loads a session 2.3.0
            // wrote.
            //
            // What reaches codeg is the wording of the session lock. From 2.3.1
            // the holder writes its client's name into the lock file, and opening
            // a held session from another process answers "This session is in
            // use by another Kimi Code CLI instance. Stop the session in that
            // instance or exit it, then try again." (`kimi acp` and the TUI say
            // "Kimi Code CLI"); only a holder that records no name still gets the
            // 2.3.0 sentence, and `classify_session_load_failure` matches the
            // stem both share. The error codes, the 3 s idle release,
            // `session.occupied` and `session.stale` are unchanged. New and
            // unused by codeg: `KIMI_CODE_SESSION_LOCK=0` turns the lock off, the
            // TUI and `kimi web` can take over a lock another process holds, and
            // a zombie holder no longer keeps its lock. Since 2.3.2 the model
            // cannot start an `AgentSwarm` by itself: the tool stays in the list
            // but returns an error until the user turns swarm mode on, and ACP
            // offers no command for that.
            //
            // 2.4.0 is a minor release, and the mandated check passes verbatim:
            // the converter's absent-`type` arm still emits `{transport:
            // "stdio", command, args, env, runtime_id: "local"}`, `newSession`,
            // `loadSession` and `resumeSession` still route through it,
            // `session/fork` still ignores `mcpServers`, and neither
            // `acpMcpServersToConfigs` nor the runtime-identity throw is in the
            // bundle. `engines.node` (>=22.19.0), `bin` and the runtime
            // dependencies are unmoved. The optional `node-pty` is gone with its
            // only user, the `kimi web` terminal panel, which `kimi acp` never
            // loaded, and Bash still runs through ACP `terminal/*`.
            // `packages/acp-server` changes only in bundler output and a no-op
            // edit, and the sources of the rest of what codeg mirrors are
            // unchanged: config.toml's provider and model schemas (`[mcp]` gains
            // two optional reconnect delays), `KIMI_MODEL_*`, the skill roots,
            // the auth gate, the `mcp.json` schema, the prompt projection and
            // title rule, the output cap, the `moonshotai` models.dev rows and
            // the `wire.jsonl` writer. A live A/B against 2.3.3, driven like the
            // last one, matched on `initialize` (`protocolVersion: 1`),
            // `session/new` (the model, thinking and mode values, the 14 slash
            // commands), text, Bash, MCP and question turns, a turn cancelled
            // mid-tool, the plan approval request, the wire record and
            // loop-event types, and the session lock (the same codes, bodies and
            // 3 s release). Neither version sends `max_tokens` to an `openai`
            // provider, and 2.4.0 resumes and loads a session 2.3.3 wrote.
            //
            // The model can no longer enter plan mode itself: `EnterPlanMode` is
            // gone from its tools, so plan mode starts only from the `plan` mode,
            // and a plan still arrives as a `session/request_permission` with
            // Approve, Revise and Reject and Exit (2.3.3 let the model enter plan
            // mode in `auto` and approved its plan without asking). That one way
            // in never worked through codeg: in plan mode Kimi reads its plan
            // file before every model request and tool call, the model writes the
            // file only once it has a plan, and the `fs/read_text_file` of a plan
            // not written yet failed and ended the turn at its first tool call.
            // codeg now reads a missing plan file as empty, as Kimi does from its
            // own disk (see `file_system_runtime::kimi_sessions_roots`). A server
            // from `mcp.json` that fails to start is now retried with backoff,
            // and Kimi logs `mcp.server_failed` / `mcp.server_failure_resolved`
            // in `wire.jsonl`, which the parser skips; a stdio server handed over
            // on `session/new`, like codeg-mcp, is not retried. `/import-sessions`
            // belongs to the TUI: over ACP it answers "Unknown ACP command". The
            // interrupted-turn and cancelled-question fixes live in the `kimi
            // web` transcript and change nothing on disk, and only the TUI's
            // terminal writes OSC 7501 status reports.
            distribution: AgentDistribution::Npx {
                version: "2.4.0",
                package: "@moonshot-ai/kimi-code@2.4.0",
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
            // pi-acp 0.0.34 spawns `pi --mode rpc` as a child, so `pi` (npm
            // `@earendil-works/pi-coding-agent`, at least
            // `PI_MIN_RUNTIME_VERSION`) must be resolvable on PATH — or
            // pointed at a custom build via the `PI_ACP_PI_COMMAND` env (see
            // BYO-pi). Args are empty: the ACP server is the default mode
            // (`npx -y pi-acp`, no subcommand). `node_required` follows pi's
            // 22+ requirement (pi-acp's own engines say >=20). The embedded
            // context env lets pi-acp advertise `promptCapabilities.embeddedContext`.
            distribution: AgentDistribution::Npx {
                version: "0.0.34",
                package: "pi-acp@0.0.34",
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
            // the package's `postinstall` decompresses it into `$GROK_HOME/bin`
            // (default `~/.grok/bin`) during `npm install`, and the npm
            // `bin/grok` trampoline does so on first run if that never happened.
            // Public mirrors (e.g. registry.npmmirror.com, a common CN default)
            // lag behind this package and are incomplete: re-checked for the
            // 1.0.70 bump, its `latest` there is still 0.1.4, which predates the
            // `grok agent stdio` ACP subcommand. It now lists the 1.0.x releases
            // up to 1.0.70 except 1.0.69 (404 there, as is the 1.0.71 alpha), so
            // the pin resolves there, but an unpinned install there still gets
            // 0.1.4.
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
            // 1.0.70 patches add nothing further here: re-probed live against
            // the 1.0.70 binary (with 1.0.62 as the A/B; both refuse
            // `session/new` and `session/resume` without a credential, so those
            // ran with a placeholder `XAI_API_KEY`, and the turns ran on a local
            // `[model.<id>]` endpoint), `initialize` still answers
            // `sessionCapabilities: {list, resume, close}` plus the same
            // `promptCapabilities.embeddedContext` (and `mcpCapabilities`
            // http+sse, `loadSession: true`; 1.0.70 also advertises `image:
            // true`, where 1.0.62 said `false`, which changes nothing because
            // codeg already treats Grok as image-capable), and `session/resume`
            // from a fresh
            // process still restores the conversation without replaying it and
            // carries `x.ai/sessionConfig` and the per-model `models`, so the
            // resume rung stands. Every scenario probed (turns with foreground
            // and background commands, a permission request, grok's
            // ask-question and exit-plan-mode requests, resume and load) gives
            // the same frames on both once ids, timing, the number of
            // terminal-output polls, the order of `terminal/create`'s env
            // entries and the interleaving of grok's asynchronous notifications
            // are normalized, except that 1.0.70's answered ask-question result
            // also carries a structured `rawOutput.UserAnswered.answers` list
            // beside its `message`, which codeg does not read. That includes the
            // turn grok starts by itself
            // over ACP a few seconds after a background command finishes,
            // which is why 1.0.62's fix for headless `grok -p` (it now waits
            // for that turn before exiting) does not reach codeg. The `_meta`
            // keys added since 1.0.0 are ones codeg does not read:
            // `x.ai/memoryNotesWritable` in those replies (1.0.51, in place of
            // `x.ai/memoryMode`), and from 1.0.52 `requestTrimmedTokens` beside
            // `totalTokens` on `session/update` and `x.ai/requestingSessionId`
            // on a permission request's tool call; no probe of 1.0.53–1.0.70
            // saw another (the binary also knows an `x.ai/hostInitiated` key
            // beside `x.ai/requestingSessionId`, which no probe of 1.0.62 or
            // 1.0.70 produced, not even a permission request inside that
            // self-started turn). Nor
            // does codeg map the two status updates 1.0.50 added on
            // `_x.ai/session/update`, `login_refused` (with a `remedy` text)
            // and `backend_responsive`, any more than grok's other status
            // updates. A session's directory, its `summary.json` keys and the
            // `updates.jsonl` envelope are unchanged after a turn; by 1.0.60
            // the directory also holds a `usage.json.lock` beside `usage.json`,
            // neither of which codeg reads. All six
            // `@xai-official/grok-<os>-<arch>` optional deps are published at
            // 1.0.70 — they are OPTIONAL, so a platform that lags would fail
            // only for that platform's users, at run time, in the trampoline.
            // The pin tracks `dist-tags.latest`, NOT the highest version
            // number, since `alpha` often runs ahead of it; 1.0.70 is `latest`
            // and `alpha` is 1.0.71.
            //
            // Since 1.0.64 a `[model.<id>]` table without a `context_window`
            // takes the window of another table that sends the same model,
            // where it used to get 200,000; `parsers::grok` reads `config.toml`
            // the same way for a history view's ring (seen live on 1.0.70, see
            // `grok_context_window_from_config_toml`), while a live ring reads
            // the window grok reports on the wire.
            //
            // One tool input codeg renders did change after 1.0.41:
            // `run_terminal_command` dropped `background` and `timeout` for
            // `block_until_ms` (how long to wait before backgrounding the
            // command: 30000 by default, 0 at once), so a grok shell card no
            // longer has a timeout to show; 1.0.70 still takes it. A background
            // launch answers with the text "Background task <id> started"
            // (seen live through 1.0.70), which is what codeg's launch matcher
            // (`parseBackgroundLaunch`) reads. Since 1.0.52 a background task's
            // `command` (its poll card title, result and completion snapshot)
            // is the command the model wrote rather than the `/bin/bash -lc
            // '…'` line that runs it; codeg shows it as it arrives.
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
            // together with that guard. 1.0.70 still sends exactly those five
            // (`auth`, `resolve_workspace`, `folder_trust`, `plugin_registry`,
            // `mcp_merge`), also ahead of a `session/new` it then
            // refuses for want of a credential; every later phase, from
            // `persistence_init` on (`agent_build` among them), carries the id.
            // `_x.ai/mcp/servers_updated` has no `sessionId` field at all, and
            // it follows the MCP servers' own startup rather than those phases,
            // so where it lands is a race: on 1.0.62 and 1.0.70 it came either
            // right after `persistence_init` or ahead of the phases (straight
            // after the `initialize` answer), and when no session was
            // being created, after `initialize` or once `session/resume` or
            // `session/load` was sent (those two narrate no phases). codeg does
            // not read it, and a frame without the field is never parked, so
            // where it lands changes nothing.
            distribution: AgentDistribution::Npx {
                version: "1.0.70",
                package: "@xai-official/grok@1.0.70",
                cmd: "grok",
                // Only the ACP subcommand lives here. Grok's ROOT-level launch
                // flags (`--no-auto-update` always, `--permission-mode <value>`
                // only for a non-default permission mode) MUST precede this
                // subcommand — `grok agent stdio` itself rejects them (re-verified
                // against 1.0.70: it still only accepts --debug/--debug-file/
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
                // `@xai-official/grok@1.0.70` declares `engines.node: ">=20"`;
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
            //
            // 2026.10.14-0f9edde changes the ACP layer, though `initialize` and
            // the unauthenticated `session/new` answer are identical to
            // 2026.10.01-14929f9's. Compared module by module with minified
            // names normalized, three changes reach codeg:
            //
            // * The completion drain at the end of a prompt (now
            //   `background-completion-drain.ts`, formerly
            //   `subagent-completion-drain.ts`) also runs for shells the model
            //   asked to watch (a shell call with an `outputNotification`
            //   pattern), on every client, where it used to run only for a
            //   client that negotiated `subagents`, which codeg never does.
            //   While a watched shell runs, `session/prompt` stays open and
            //   Cursor shows a `watch-<uuid>` tool call (kind `other`, titled
            //   "Watching: <reason>" or "Watching N shells", `rawInput.shells`
            //   listing them) that it completes when the watch ends. When the
            //   shell's output matches, Cursor runs a follow-up turn
            //   (`backgroundTaskCompletionAction`) inside the same request; a
            //   follow-up that fails puts the completion back in the queue and
            //   fails the request. `cursor_acp_retry_compat` gives each
            //   follow-up its own retry policy, as the TUI does.
            // * `newSession`, `loadSession` and `prompt` first check that the
            //   account's effective team is still the one the agent started
            //   with. If it is not, they answer -32603 "Your team has switched
            //   to <team>. Create a new session to continue." and the process
            //   exits with status 0 ten milliseconds later. codeg keeps the
            //   connection over a rejected prompt, then loses it when the agent
            //   exits.
            // * A new `generateVideoToolCall` presents as kind `other`, titled
            //   "Generate Video: <prompt>", with `rawInput._toolName:
            //   "generateVideo"`; codeg shows it as a generic tool card.
            //
            // 2026.10.14-941492e is a second build of that day. Its 19 ACP
            // modules match 0f9edde's in all six archives once build paths, the
            // version string and chunk numbers are normalized, and `initialize`
            // and the unauthenticated `session/new` answer are identical. Its
            // one code change is in the private-worker controller (`cursor-agent
            // worker`), which codeg never runs: `--identity-audience <aud>` asks
            // each claim for a signed identity token and hands it to the spawn
            // hook. Because the two builds share a date, the agent settings page
            // tells them apart by build (`isBehindRecommended`): compared by
            // numbers alone they tie, so an install of 0f9edde would read
            // "Already latest" while connect, which never downloads, kept
            // launching it.
            //
            // 2026.10.16-e3cb207, checked against 941492e in all six archives:
            // `initialize` and the unauthenticated `session/new` answer are
            // identical, and with minified names, build paths and chunk
            // numbers normalized the ACP modules differ in three places.
            // `generateVideoToolCall`'s `rawInput` gains `lastFramePath`, which
            // codeg still shows on the generic card, and the shell executor is
            // now imported from `shell-exec/dist/api`. The third is the ACP
            // SDK's import path, and it marks the larger change: the ACP SDK
            // (still 0.14.1), the MCP SDK and Cursor's own config schemas moved
            // from zod 3.25.76 to zod 4.6.5. Replayed against unauthenticated
            // processes of both builds, every request codeg sends Cursor
            // (`initialize`, `session/new` and `session/load` carrying
            // codeg-mcp, `session/prompt` with each content block kind,
            // `session/set_mode`, `session/set_config_option` with a select
            // value, `session/cancel`) gets the same answer. Only a
            // request that fails validation is reported differently: -32602
            // "Invalid params" with zod's formatted tree, where 941492e
            // answered -32603 with the raw issue list, because the SDK's
            // `ZodError` check now names the class its schemas throw. codeg's
            // requests never take that path. The `cli-config.json` schema still
            // reads `sandbox.mode` and `permissions.allow`/`deny`, the keys the
            // Cursor panel writes, and `mcp.json` stdio entries gain an
            // optional `startupTimeoutSec`.
            //
            // 2026.10.18-ea085cb, checked against e3cb207 in all six archives:
            // `initialize` and the unauthenticated `session/new` answer are
            // identical (`protocolVersion: 1`), the ACP SDK and zod versions are
            // unchanged, and with minified names, build paths and chunk numbers
            // normalized the only ACP module that differs is the tool-call
            // presenter: `generateVideoToolCall`'s `rawInput` gains `keyframes`
            // (image path and timestamp pairs), which codeg still shows on the
            // generic card. The agent protobufs only gain messages and fields
            // (voice calls, video keyframes, a `thinkingNote` interaction update
            // the ACP presenter does not forward), which `parsers::cursor` skips
            // like any field it does not read. Outside the ACP layer, the MCP
            // SDK's local patch now retries OAuth client registration with other
            // redirect URIs (remote servers only), and the shells Cursor runs no
            // longer inherit `AGENT_HOST_DAEMON_*` variables. The
            // `cli-config.json` schema and the `mcp.json` loader and entry schema
            // are unchanged.
            //
            // 2026.10.19-6bbf2c4, checked against ea085cb in all six archives:
            // `initialize` and the unauthenticated `session/new` answer are
            // identical (`protocolVersion: 1`), the bundled package versions are
            // unchanged, and with minified names, build paths and chunk numbers
            // normalized no ACP module differs. Replayed against unauthenticated
            // darwin/arm64 processes of both builds, every request codeg sends
            // Cursor gets the same answer. The code changes are all in the
            // private worker (`cursor-agent worker start` and `worker debug`),
            // which codeg never runs: a worker now sends the team picked with
            // `team switch` as `x-cursor-team-id`, and stops with a message when
            // the bridge refuses it because that team denies the user cloud
            // agents.
            //
            // 2026.10.22-27dcf5f, checked against 6bbf2c4 in all six archives,
            // is a larger build: 242 modules differ once minified names, build
            // paths and chunk numbers are normalized. `initialize` and the
            // unauthenticated `session/new` answer are still identical
            // (`protocolVersion: 1`), and the ACP SDK is still 0.14.1. Seven ACP
            // modules changed, the same seven in every archive, and they now
            // read their inputs through shared type guards; the tool titles and
            // kinds, the `session/update` kinds and the `cursor/*` extension
            // methods are unchanged, an MCP call announced before its arguments
            // is still titled `MCP: tool`, and the `mcpServers` of `session/new`
            // and `session/load` convert to server configs exactly as before. The
            // one new setting: the terminal executor now runs PowerShell with a
            // UTF-8 console and child environment. The MCP SDK no longer ships as
            // its own package (its code is in the MCP executor module), and
            // signed out, `cursor-agent mcp list-tools` sends a stdio server from
            // `~/.cursor/mcp.json` the same `initialize` (protocol 2025-11-25),
            // `notifications/initialized` and `tools/list` on both builds; the
            // `mcp.json` loader and entry schema and the `cli-config.json` schema
            // are unchanged. The `agent.v1` protobufs drop the `pi_*` tools
            // (`ToolCall` fields 61–67) and add `update_tracked_task_tags`,
            // `stop_project_updates` and `start_project_updates` (91, 93, 94); no
            // other `ToolCall` field moved, and `parsers::cursor` names every
            // variant this build declares. The rest (computer use, canvas, WSL
            // support, the private worker) is outside the ACP layer.
            //
            // Every pin still has to be triaged in `cursor_acp_retry_compat`.
            distribution: AgentDistribution::Binary {
                version: "2026.10.22-27dcf5f",
                cmd: "cursor-agent",
                args: &["acp"],
                env: &[],
                platforms: &[
                    PlatformBinary {
                        platform: "darwin-aarch64",
                        url: "https://downloads.cursor.com/lab/2026.10.22-27dcf5f/darwin/arm64/agent-cli-package.tar.gz",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "darwin-x86_64",
                        url: "https://downloads.cursor.com/lab/2026.10.22-27dcf5f/darwin/x64/agent-cli-package.tar.gz",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "linux-aarch64",
                        url: "https://downloads.cursor.com/lab/2026.10.22-27dcf5f/linux/arm64/agent-cli-package.tar.gz",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "linux-x86_64",
                        url: "https://downloads.cursor.com/lab/2026.10.22-27dcf5f/linux/x64/agent-cli-package.tar.gz",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "windows-aarch64",
                        url: "https://downloads.cursor.com/lab/2026.10.22-27dcf5f/windows/arm64/agent-cli-package.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "windows-x86_64",
                        url: "https://downloads.cursor.com/lab/2026.10.22-27dcf5f/windows/x64/agent-cli-package.zip",
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
        AgentType::ZCode => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "ZCode",
            description: "Official ZCode runtime via the community ACP bridge",
            // Validated end to end on Windows with ZCode CLI 0.16.9 and bridge
            // 0.69.2. The bridge requires an existing official ZCode
            // installation; zcode::resolve_runtime supplies explicit Node/CLI
            // paths. Codeg owns history through its ACP transcript in this
            // phase.
            //
            // Bridge 0.72.0 keeps everything codeg's launch and session handling
            // rely on: `dist/cli.js`, the runtime selection (Bun re-exec unless
            // `ZCODE_ACP_RUNTIME=node`) and the backend resolver are
            // byte-identical to 0.69.2's, and `initialize` answers the same
            // apart from the version. The mode gate still works as codeg drives
            // it (`set_mode`, then `set_config_option("mode")` echoing the
            // mode), and fork, attachments and MCP forwarding are unchanged.
            // Since 0.69.3 a new session's placeholder reports the configured
            // initial mode (the bridge config's `session.mode`, then
            // `ZCODE_ACP_MODE`, else `yolo`) where it reported `yolo`
            // regardless; codeg's gate confirms its own choice either way.
            // 0.72.0 adds `usage` and `turnMs` to the `_zcode/turnState`
            // notification that ends a turn; codeg records these as per-turn
            // metadata without adding context-occupancy usage updates. The
            // rest (quota cards, CLIProxy, sandbox pacing when a workspace arms
            // the sandbox) is opt-in and outside what codeg drives.
            //
            // Bridge 0.75.0, after 0.73.0 and 0.74.0, still ships `dist/cli.js`,
            // the runtime selection, the backend resolver and the backend client
            // byte for byte as 0.72.0 did, and `initialize` answers the same
            // apart from the version, with `protocolVersion: 1`. Against a
            // stand-in backend given codeg's env and capabilities, `session/new`
            // (with and without `ZCODE_ACP_MODE`), the mode gate and stdio MCP
            // forwarding produce the same client and backend frames as 0.72.0's.
            // Since 0.73.0 the bridge writes the disabled
            // `.zcode/acp/sandbox.json` template into a workspace only while the
            // sandbox is armed globally (`sandbox.enabled` in the bridge's user
            // config, or `ZCODE_ACP_SANDBOX=1`), so a bridge codeg starts no
            // longer creates it unless the user arms the sandbox. 0.75.0 adds a
            // `messageId` to the tool calls it replays from history. codeg
            // reconnects through `session/resume`, which replays nothing, and its
            // `session/load` fallback records a replay only for a session codeg
            // has no transcript of, as typed updates whose tool calls carry no
            // `messageId` field. The remaining changes (the remote hub, an
            // Opencode Go quota source read from `OPENCODE_GO_API_KEY`, a
            // CLIProxy User-Agent) are outside what codeg drives.
            //
            // Bridge 0.76.2, after 0.76.0 and 0.76.1, differs from 0.75.0 on the
            // stdio path codeg launches by two lines. `package.json` changes only
            // its version (the dependency tree resolves the same), `initialize`
            // answers the same apart from the version (`protocolVersion: 1`),
            // and against the stand-in backend `session/new`, the mode gate (the
            // plan mirror still needs `set_mode` first) and stdio MCP forwarding
            // produce the same client and backend frames as 0.75.0's. The two
            // lines are 0.76.1's: the `_zcode/turnState` report that opens a
            // prompt and the ones that close each of its rounds no longer name a
            // target, so they reach every attached client. Over stdio the
            // recipients stay the same, because the only `session/prompt`
            // handler already passed the client registry's broadcast proxy as
            // that target, and an untargeted report goes through the same proxy.
            // codeg therefore still gets each start and end once under each
            // name, with the `usage` and `turnMs` on the end that `zcode_turn`
            // sums. The rest (a settings API that edits provider endpoints and
            // probes model connectivity, the hub's Desktop Presence tier and
            // heartbeat) runs only in the separate hub process or in the remote
            // endpoint, which codeg's launch turns off with `ZCODE_ACP_REMOTE=0`
            // unless the user's own bridge config turns it back on.
            //
            // Bridge 0.76.3 changes what one backend request carries, and the
            // client side not at all. `package.json` changes only its version,
            // and against the stand-in backend `initialize` (`protocolVersion:
            // 1`), `session/new`, the mode gate (the plan mirror still needs
            // `set_mode` first) and stdio MCP forwarding give the client the same
            // frames as 0.76.2. The backend's `session/create`
            // and `session/resume` now carry the bridge's tool denylist as
            // `toolDenylist`: by the bridge's account the backend's `app-server`
            // parses the `--disallowed-tools` flag it was launched with but never
            // applies it, and upstream ZCode's `session/create` turns the key into
            // the session's tool disallow list. codeg sets neither
            // `ZCODE_DISALLOWED_TOOLS` nor `ZCODE_ENABLE_AUTOMATION_TOOLS`, so the
            // list is the bridge's default, `CronCreate`, `CronList`, `CronUpdate`
            // and `CronDelete`, and a ZCode session codeg starts no longer offers
            // the model those four tools. A backend too old for the key gets the
            // request again without it, and the bridge warns once on stderr. The
            // other change keeps the remote endpoint from advertising a
            // conversation again after a remote close.
            //
            // Bridge 0.78.0, after 0.77.0, changes `package.json` only in its
            // version, and against the stand-in backend `initialize`
            // (`protocolVersion: 1`), `session/new`, the mode gate (the plan
            // mirror still needs `set_mode` first) and stdio MCP forwarding give
            // the client and the backend the same frames as 0.76.3, apart from
            // the auth method's description. The bridge now answers
            // `authenticate` as a readiness check: `{}` when it finds a ZCode
            // credential, else -32000 saying how to get one. codeg never sends
            // it to ZCode. Two credential sources are new. A Coding Plan key the
            // desktop app saved through "Use API key" (`provider_config.json`)
            // now entitles that plan's models and supplies their request key.
            // The new `zcode-acp setup` terminal command saves an individual
            // Coding Plan key in `~/.zcode/v2/acp-accounts.json`, which
            // overrides the desktop's key and enablement for that plan in
            // memory. A `session/load` whose `_meta.zcode.intent` is `"auto"` no
            // longer re-advertises a remotely closed conversation; codeg sends
            // no intent, which keeps the old behaviour. A replayed tool call
            // keeps its `messageId` only when its message also carries text, and
            // codeg records a replay without that field. The rest (the hub's
            // close tombstones, an orderly exit after a remote close) runs only
            // in the separate hub process or in the remote endpoint.
            //
            // Bridge 0.79.1, after 0.79.0, changes `package.json` only in its
            // version, and against the stand-in backend `initialize`
            // (`protocolVersion: 1`), `session/new`, the mode gate (the plan
            // mirror still needs `set_mode` first), stdio MCP forwarding,
            // `session/fork`, `authenticate` and a completed prompt give the
            // client and the backend the same frames as 0.78.0, apart from the
            // version and each turn's `turnMs`. What moved is how a failed turn
            // ends. A `turn.failed` whose cause is `model_request_failed`,
            // `invalid_model_request` or `provider_not_configured` is now resent
            // even when the backend marks it non-retryable, where 0.78.0
            // rejected the prompt at once with -32603 "ZCode turn failed: …".
            // And once the bridge has sent a prompt six times over about 15
            // seconds, with a "[Network error, retrying (n/5)…]" text before
            // each of the five resends, it answers `end_turn` after a "[Request
            // failed: …. The session is still usable — please resend.]" text,
            // where 0.78.0 rejected the prompt with -32603. A
            // failure the bridge does not retry, such as an exceeded context
            // window, still rejects the prompt at once. codeg treats neither
            // ending specially: the error or the text shows in the turn. The
            // rest runs only in the remote endpoint or the hub: a remote close
            // (or, from 0.79.1, the hub's shutdown route) now records the
            // conversation in `~/.zcode/v2/acp-closed-sessions.json`, which only
            // a `session/load` whose `_meta.zcode.intent` is `"auto"` consults,
            // and codeg sends no intent.
            distribution: AgentDistribution::Npx {
                version: "0.79.1",
                package: "zcode-acp-server@0.79.1",
                cmd: "zcode-acp-server",
                args: &["server"],
                env: &[],
                node_required: Some("22.0.0"),
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
            // is no API-key env to manage. Model, mode and reasoning effort
            // arrive through standard `configOptions`, so the composer
            // selectors need no per-agent code. The modes are default/
            // acceptEdits/auto/dontAsk/yolo, `yolo` being the one labelled
            // "Bypass Permissions" (`bypassPermissions` is accepted as an alias
            // for it, `plan` is rejected) — re-read live on 1.1.64, 1.1.65,
            // 1.1.67, 1.1.71, 1.1.72, 1.1.73, 1.1.74, 1.1.75 and 1.1.81, and
            // nothing in codeg names them.
            // Session logs land as
            // `$QODER_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>.jsonl`
            // (default `~/.qoder/...`) in the Claude-Code-style chunk-log
            // envelope, which `parsers::qoder` reads for history — including
            // the `custom-title` / `ai-title` records that carry the session's
            // name in plaintext (the sibling `<sessionId>/state.json` keeps its
            // own copy AES-GCM-encrypted under the machine key, so it is not
            // the source). `engines.node: ">=20"`.
            //
            // 1.1.66 and 1.1.67 change only the two bundles and the version
            // strings (`postinstall.cjs` and the npm dispatcher are
            // byte-identical). A live A/B against 1.1.65 under the CLI's
            // `--fake-responses` replay gives identical `initialize`,
            // `session/new`, `set_mode` and config-option answers, and a
            // scripted turn writes the same transcript record types and
            // shapes; `/rename` still writes a plaintext `custom-title` record
            // (`ai-title` comes only from the interactive TUI, never an ACP
            // session). The one protocol change is in 1.1.67: the
            // `reasoning_effort` option moves from `category: "model"` to
            // `"thought_level"`. codeg needs nothing for it: the model-label
            // store finds the model selector by its `model` id first, the
            // composer's model-only handling (search, provider groups) never
            // applied to a short effort list, and saved preferences still
            // replay `model` before the effort.
            //
            // 1.1.68 through 1.1.71 change the bundles, the version strings and
            // the vendored qoder-security plugin (0.9.5 from 1.1.68, which keeps
            // its data in `~/.qodersec` whatever `QODERSEC_HOME` says);
            // `postinstall.cjs` and the npm dispatcher are still
            // byte-identical. A live A/B of 1.1.71 against 1.1.67 under
            // `--fake-responses` (a read, a write behind a permission request,
            // an `AskUserQuestion` form, a foreground sub-agent and `/rename`,
            // then `session/load` from a new process) gives identical answers,
            // update streams, load replay and transcript records once ids,
            // times and paths are normalized.
            //
            // 1.1.72 changes only the two bundles and the version strings: the
            // vendored qoder-security plugin is still the byte-identical 0.9.5,
            // and `postinstall.cjs`, the npm dispatcher and the macOS and Linux
            // ripgrep binaries are byte-identical (the Windows `rg.exe` differs
            // only in its signature: with the Authenticode table and PE
            // checksum stripped, the 1.1.71, 1.1.72 and 1.1.73 images are
            // identical). Its code changes sit outside the ACP layer (WebSearch
            // and VideoGenRetrieve move into the built-in `qoder-tools` plugin
            // and stay available over ACP, `/model` and `/release-notes` move
            // into the account plugin, the model catalog cache becomes
            // `catalog-v7`), and the ACP module is structurally unchanged. A
            // live A/B of 1.1.72 against 1.1.71 under `--fake-responses` (the
            // same scenario, with the `AskUserQuestion` form answered once with
            // an option and once with free text) gives identical answers,
            // update streams, load replay and transcript records once ids,
            // times, paths and the per-request `requestTokenAnchor` hashes are
            // normalized. The token-usage gate below and the `AskUserQuestion`
            // form handling are the same code in every release from 1.1.67 to
            // 1.1.75, and the config-dir resolution in every release from 1.1.67
            // to 1.1.74.
            //
            // 1.1.73 changes the two bundles, the version strings and how Qoder
            // Sites ships, and the ACP module is structurally unchanged.
            // `postinstall.cjs`, the npm dispatcher, qoder-security 0.9.5 and
            // the macOS and Linux ripgrep binaries are still byte-identical, and
            // `engines.node` is unchanged. Sites used to be a plugin running its
            // own MCP server and is now built in: every session, ACP ones
            // included, gets four `sites:*` skills (the advertised commands go
            // from 18 to 22, the transcript's skill listing from 11 to 15), and
            // the CLI creates `<config dir>/sites/{resources,sessions}`. A live
            // A/B of 1.1.73 against 1.1.72 under `--fake-responses` (the same
            // scenario) gives identical answers, update streams, load replay and
            // transcript records once ids, times, paths, `requestTokenAnchor`
            // hashes and `promptId`s are normalized, apart from those skills and
            // one field: a Bash result now carries `processStarted: true`, which
            // codeg does not read. On both versions a stdio MCP server sent in
            // `session/new` is started with the session and its tools reach the
            // model as `mcp__<server>__<tool>`.
            //
            // 1.1.74 changes the two bundles (`qodercli.js` and
            // `qoder-worker-runtime.mjs`) and the version strings.
            // `postinstall.cjs`, the npm dispatcher, qoder-security 0.9.5 and the
            // macOS and Linux ripgrep binaries are byte-identical, `engines.node`
            // is unchanged, and both versions answer `initialize` with
            // `protocolVersion: 1`. Unlike 1.1.72 and 1.1.73, it changes the ACP
            // agent itself. `session/new` now writes the session's transcript
            // before any prompt: null `active-leaf` markers,
            // `workspace-directories` and `worktree-state`. A session nobody
            // prompted, such as a draft codeg opened and left, therefore shows in
            // Qoder's own session list as "Empty conversation" and can be
            // loaded; 1.1.73 wrote nothing for it and refused the load.
            // `parsers::qoder` lists no transcript without content, so codeg's
            // history is unchanged. And a prompt whose run throws after it was
            // cancelled now answers `stopReason: "cancelled"` instead of
            // rejecting the request. A live A/B of 1.1.74 against 1.1.73 under
            // `--fake-responses` (the same scenario) gives identical answers,
            // update streams, load replay and transcript records once ids, times,
            // paths, `requestTokenAnchor` hashes and `promptId`s are normalized,
            // apart from a new `imagegen` skill (23 advertised commands) and
            // those leading `active-leaf` markers. A stdio MCP server sent in
            // `session/new` still starts with the session.
            //
            // 1.1.75 changes the two bundles and the version strings again.
            // `postinstall.cjs`, the npm dispatcher, qoder-security 0.9.5 and the
            // macOS and Linux ripgrep binaries are byte-identical (the Windows
            // `rg.exe` differs only in its signature), `engines.node` is
            // unchanged, and both versions answer `initialize` with
            // `protocolVersion: 1`. The change codeg follows is the home lookup:
            // 1.1.75 no longer falls back to `GEMINI_CLI_HOME`, so
            // `parsers::qoder` stopped reading it too (see
            // `resolve_qoder_config_dir`). A live A/B of 1.1.75 against 1.1.74
            // under `--fake-responses` (the same scenario, plus `session/resume`
            // from a new process, a prompt carrying `resource_link` files,
            // `session/fork` and a never-prompted session) gives identical
            // answers, update streams, load and resume replay, and transcript
            // records once ids, times, paths, `requestTokenAnchor` hashes and
            // `promptId`s are normalized. The one record that differs: a fork's
            // transcript now ends with an `active-leaf` marker on its last
            // message, and `parsers::qoder` shows both versions' forks the same.
            // A stdio MCP server sent in `session/new` still starts with the
            // session.
            //
            // 1.1.81 follows 1.1.76 to 1.1.80, which codeg skipped. It changes
            // the two bundles and the version strings and adds
            // `bundle/codemode-worker.mjs`; `postinstall.cjs`, the npm
            // dispatcher, qoder-security 0.9.5 and the macOS and linux-x64
            // ripgrep binaries are byte-identical (linux-arm64's is now a
            // static musl build, and the Windows `rg.exe` differs only in its
            // signature), and `engines.node` is unchanged. The bundle's ACP
            // agent is a rewrite from 1.1.76. From 1.1.76 to 1.1.80 Bypass
            // Permissions could not be selected: `setSessionMode` mapped the
            // `bypassPermissions` alias to `yolo` and handed that to a
            // permission manager that accepts only `bypassPermissions`, so
            // `session/set_mode` and the `mode` config option answered -32603
            // "unknown permission_mode: yolo". 1.1.81 maps it back first, and
            // live both switch to `yolo` again and a Write under it asks
            // nothing. Against 1.1.75 under `--fake-responses`, 1.1.81 gives
            // the same answers, update streams, `AskUserQuestion` forms and
            // answers, commands, load and resume replay, config-dir cases and
            // token gate, and `parsers::qoder` shows its sessions, sub-agents
            // included, as it shows 1.1.75's, except that a fork now takes its
            // source's title. Its new Code Mode stays off unless
            // `QODER_ENABLE_CODE_MODE` is set or Qoder's config service turns
            // on `code_mode`.
            //
            // Three changes matter to codeg. The turn Qoder runs by itself when
            // a background sub-agent finishes after the prompt that launched it
            // has been answered is no longer streamed. 1.1.75 sends that turn's
            // reply; 1.1.80 and 1.1.81 run it and record it in the transcript
            // without sending codeg a frame (the rewrite dropped the agent's
            // task-notification turns), so the reply shows only once the
            // conversation is reopened. Only Claude Code's out-of-turn activity
            // is followed through its transcript (`acp::background_watch`);
            // re-check this on the next bump. 1.1.81 also waits only 5 seconds
            // for MCP servers before it answers `session/new`, where 1.1.75
            // waits 30 (`QODERCLI_MCP_INIT_BUDGET_MS` sets it): a server that
            // takes longer comes up later in the session, and a call to its
            // tools before then fails as not found. And it leaves a tool call
            // open when a Stop cancels the call's permission request, which
            // codeg then closes itself (`stopped_call_reports` in
            // `acp::connection`).
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
            // prefix (`Sr(A) = `${vv}${A}``, `ebA = Sr("EXPOSE_TOKEN_USAGE")`
            // in 1.1.54, `yr` / `CRA` in 1.1.67, `Dr` / `qMA` in 1.1.71, `yr` /
            // `VMA` in 1.1.72, `Or` / `m1A` in 1.1.73, `Or` / `_1A` in 1.1.74,
            // `Lr` / `xGA` in 1.1.75, `xr` / `K4A` in 1.1.81; the minified
            // names change every build), so grepping the bundle for the full
            // literal returns nothing — grep the bare suffix instead, the same
            // trap `parsers::qoder` documents for the config-dir vars.
            //
            // Registry env is only the base: `merge_agent_env` lets a per-agent
            // `runtime_env` override it, so a user who wants the redaction back
            // sets `QODER_EXPOSE_TOKEN_USAGE=0` in the agent's env settings.
            distribution: AgentDistribution::Npx {
                version: "1.1.81",
                package: "@qoder-ai/qodercli@1.1.81",
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
            // "antigravity-acp"`. Model, thinking level (since 1.4.0) and
            // session mode (default/auto_edit/yolo) arrive as standard
            // `configOptions`, so the composer selectors need no per-agent
            // code.
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
            //
            // 1.3.0, checked against 1.2.1: every archive is still flat with
            // the same two executables and modes, and `tools.py`,
            // `config_options.py`, `paths.py`, `settings.py` and `oauth/` are
            // byte-identical. So the MCP `rawInput` codeg folds, the mode
            // values, the token paths and the loopback OAuth flow the login
            // relay drives are unchanged. `initialize` matches, and
            // `session/new` still fails `-32000 Authentication required` until
            // settings.json declares `auth.type`, which gained a `gateway`
            // value codeg does not offer. New on the wire is `usage_update`,
            // which reaches the context ring like any agent's, and the Windows
            // server is still the PyInstaller onefile that codeg's TMP/TEMP
            // scratch and `_MEI*` reaping are built for. One launch detail
            // moved: `main.py` now appends `localhost,127.0.0.1,::1` to both
            // `NO_PROXY` spellings whenever a proxy variable is set. codeg
            // already exports those hosts, so its value passes through, except
            // `*`, which codeg sends alone because Python skips a `*` inside a
            // list. The server turns it into `*,localhost,127.0.0.1,::1`, so
            // with a proxy configured and a `*` bypass list, its urllib and
            // requests traffic is proxied again.
            //
            // 1.4.0, checked against 1.3.0: every archive is still flat with
            // the same two executables and modes. `main.py`, `tools.py`,
            // `paths.py`, `settings.py` and `oauth/` are byte-identical, and
            // the mode and `auth.type` values are unchanged, so the MCP
            // `rawInput` codeg folds, the token paths, the login relay's OAuth
            // flow and the `NO_PROXY` rewrite above all still hold. `initialize`
            // only adds `agentCapabilities._meta.antigravity` (`tier`,
            // `systemPrompt.append`), `session/new` still fails `-32000` until
            // `auth.type` is declared, and the Windows server is still the
            // PyInstaller onefile. What moved is the model picker. The `model`
            // option lists one row per model family and a new `thinking_level`
            // option (category `thought_level`) picks the variant, while the
            // flat `models` list keeps every variant id, the ids 1.3.0's picker
            // listed. A model saved under 1.3.0 is such an id, and
            // `session_model_list_offers` in connection.rs replays it as saved
            // for the server to map. A model switch now takes effect at the
            // next prompt, and `start_subagent` became `invoke_subagent` beside
            // a new `run_workflow` tool; codeg maps neither name.
            //
            // 1.4.1, checked against 1.4.0: every archive is still flat with
            // the same two executables and modes. Of the server's own Python
            // only `server.py`, `model_selection.py`, `client_info.py`, the
            // gateway modules and the version string changed; `main.py`,
            // `tools.py`, `config_options.py`, `paths.py`, `settings.py`,
            // `oauth/` and the MCP modules are byte-identical, the protobuf
            // descriptors the history parser reads are unchanged, and the Go
            // harness differs only in build stamps. `initialize` (apart from
            // the version), `session/new` with its `model`, `thinking_level`
            // and `mode` values and flat `models` list, the slash commands, a
            // model then thinking-level switch, and a gateway turn that calls a
            // tool on a wire MCP server all answer as 1.4.0 does. What moved:
            // an Agent Platform session now defaults to `gemini-4-argon-high`
            // and lists Gemini 4 Argon first, a Google-login model list drops
            // the models the plan marks disabled, and the Windows server, still
            // the PyInstaller onefile, embeds Python 3.14 where it embedded
            // 3.10.
            //
            // 1.4.3, checked against 1.4.1 (1.4.2 came out four hours earlier
            // the same day, was never listed by the ACP registry, and differs
            // from 1.4.3 in the server's own Python only by the version string):
            // every archive is still flat with the same two executables and
            // modes, and the ACP registry now lists a `sha256` per archive.
            // `main.py`, `config_options.py`, `model_selection.py`, `paths.py`,
            // `settings.py`, `oauth/`, `hooks.py` and the MCP modules are
            // byte-identical, `server.py::_ask_user_handler` is unchanged, and so
            // are the protobuf fields the history parser reads, Step 154
            // included. `initialize` (`protocolVersion: 1`), `session/new` with
            // its `model`, `thinking_level` and `mode` values and flat `models`
            // list, the slash commands, a model then thinking-level switch, a
            // saved 1.3.0 variant id, a gateway turn that calls a tool on a wire
            // MCP server, `session/load` replay and the native question frames
            // (answered and cancelled) all answer as 1.4.1 does. What moved: a
            // `usage_update` with `used: 0` now follows `session/new` and each
            // model change, and prompt answers carry a `usage` breakdown that
            // codeg does not record for this agent (`PromptUsageMode`). An
            // auto-approved MCP call now gets the same MCP title, `rawInput` and
            // `_meta` as a permission-gated one. The skill directories are no
            // longer passed to the harness as workspaces, so the system prompt
            // names the session folder as the command directory, the server no
            // longer creates empty `.gemini/skills` and `.agents/skills` folders
            // in the project, and a read-only folder no longer fails
            // `session/new`. Instead the harness writes its built-in
            // `run-workflow` skill to `<cwd>/skills/system/run-workflow/SKILL.md`
            // at every `session/new` and leaves it there (it is skipped for a
            // read-only folder, and a run with `run_workflow` disabled through
            // `_meta.antigravity.disabledTools` did not write it). The Windows
            // x86_64 server is still the PyInstaller onefile with Python 3.14.
            //
            // 1.4.4, checked against 1.4.3: every archive is still flat with the
            // same two executables and modes, the Windows server is still the
            // PyInstaller onefile with Python 3.14 on both architectures, and
            // the macOS arm64 harness's strings differ only in build stamps. Of
            // the server's own Python only `server.py`, `tools.py`,
            // `model_selection.py`, `client_info.py` and the version string
            // changed. `main.py`, `config_options.py`, `paths.py`, `settings.py`,
            // `oauth/`, `hooks.py`, the MCP and gateway modules and the vendored
            // ACP SDK are byte-identical, `server.py::_ask_user_handler` is
            // unchanged, and so are all 264 protobuf descriptors. `initialize`
            // (`protocolVersion: 1`) adds only `additionalDirectories` to
            // `sessionCapabilities`, which codeg never sends. `session/new` with
            // its `model`, `thinking_level` and `mode` values and flat `models`
            // list (API key, gateway and Agent Platform), the slash commands, a
            // model then thinking-level switch, a saved 1.3.0 variant id, a
            // gateway turn that calls a tool on a wire MCP server (asked and
            // auto-approved), `session/load` replay and the native question
            // frames with their Step 154 records (answered and cancelled) all
            // answer as 1.4.3 does. What moved is file access. The harness's
            // own `view_file` replaces the server's: its live call reports
            // `file_path` and zero-based `start_line`/`end_line`, and history
            // stores a `view_file` step rather than an `agency_tool_call`.
            // `client_view_file` now asks `fs/read_text_file` for the whole file,
            // with no `line` or `limit`, and slices out the lines itself, so
            // codeg lets Antigravity's reads return up to the 16 MiB a file may
            // have rather than 2 MiB (`read_response_limit` in
            // `acp::file_system_runtime`). Lines read that way from a
            // 16,480,000-byte file reached the model. And `client_create_file`
            // and `client_edit_file` refuse content that looks like
            // `view_file`'s numbered output, without sending
            // `fs/write_text_file`, though the call still ends `completed`.
            distribution: AgentDistribution::Binary {
                version: "1.4.4",
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
                        url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.4-darwin-arm64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "darwin-x86_64",
                        url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.4-darwin-x86_64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "linux-aarch64",
                        url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.4-linux-arm64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "linux-x86_64",
                        url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.4-linux-x86_64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "windows-aarch64",
                        url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.4-windows-arm64.zip",
                        sha256: None,
                    },
                    PlatformBinary {
                        platform: "windows-x86_64",
                        url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.4-windows-x86_64.zip",
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
        AgentType::Kiro => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "Kiro CLI",
            description: "Amazon's Kiro agent in the terminal (native ACP via kiro-cli acp)",
            // `kiro-cli acp` is the CLI's OWN ACP server. Verified handshake
            // against 2.24.1: `agentInfo.name = "Kiro CLI Agent"`,
            // `loadSession: true`, empty `sessionCapabilities`, image prompts
            // (no embeddedContext), MCP http but NOT sse, and no
            // `authMethods` — sign-in is the CLI's own `kiro-cli login`, which
            // the ACP server reuses. `session/new` answers with standard
            // `modes` (the agent configs: kiro_default / kiro_planner /
            // kiro_guide, plus any user agent under `~/.kiro/agents`) and the
            // pre-config-options `models`, but no `configOptions`; reasoning
            // effort and thinking arrive on `_kiro.dev/metadata`. The composer
            // selectors are therefore built per agent in `acp::connection`
            // (see `synthesize_kiro_model_option`).
            //
            // SYSTEM, NOT BINARY. Kiro ships only through its own installers:
            // a universal `Kiro CLI.dmg` on macOS (an app bundle that links
            // its binaries into `~/.local/bin` on first launch), an `.msi` on
            // Windows, and Linux archives whose bundled `install.sh` places
            // them in `~/.local/bin`. The binary cache can do none of the
            // first two, and `kiro-cli` is a dispatcher that execs a sibling
            // `kiro-cli-chat` (the ACP server itself), so it is not a
            // single-file install either. A codeg-managed copy would also
            // diverge from the one the user's terminal runs, while both share
            // `~/.kiro` (sessions, settings, agents, sign-in) and the CLI
            // updates itself in place (`kiro-cli update`). So codeg launches
            // the user's install and never pins one; `~/.local/bin` is probed
            // by the system resolver even when a Finder-launched app's PATH
            // lacks it.
            //
            // Sessions land in `~/.kiro/sessions/cli/<id>.json` (metadata) +
            // `<id>.jsonl` (the event log) for every entrypoint, ACP included,
            // which `parsers::kiro` reads for history. MCP servers come from
            // `~/.kiro/settings/mcp.json`, which the CLI loads natively, so
            // codeg manages that file and does not forward the same servers
            // over `session/new` (see `load_mcp_servers_for_agent`).
            distribution: AgentDistribution::System {
                cmd: "kiro-cli",
                args: &["acp"],
                env: &[],
                install_url: KIRO_INSTALL_URL,
                // `kiro-cli update --non-interactive` checks Kiro's release
                // channel and installs a newer build without asking (2.24.1:
                // "No updates available, 2.24.1 is the latest version." when
                // current, exit 0) — the same updater `kiro-cli update` runs
                // in the terminal, so the install stays the vendor's.
                update_args: Some(&["update", "--non-interactive"]),
            },
        },
        AgentType::Trae => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "TRAE CLI",
            description: "ByteDance's TRAE coding agent in the terminal (native ACP via traecli acp serve)",
            // `traecli acp serve` is the CLI's OWN ACP server (the docs also
            // accept `traecli --acp`; codeg uses the subcommand they lead
            // with). Verified handshake against 0.209.1: `agentInfo =
            // {name: "traecli-acp", title: "TRAE CLI"}`, `loadSession: true`,
            // `sessionCapabilities` with list / additionalDirectories / fork /
            // resume / close, image + embeddedContext prompts, MCP http but
            // NOT sse, and two auth methods (`trae-tob-browser`, the
            // enterprise SSO browser flow, and `trae-tob-pat`; see
            // `acp::trae`). `session/new` answers with standard `configOptions`
            // — `mode` (default "Workspace Edit" / plan / auto /
            // bypass_permissions "Full Access"), `model`, `reasoning_effort` —
            // beside the older `modes` / `models`, so the composer's generic
            // selectors cover it. Tool calls, permission requests, diffs and
            // `usage_update` use the plain ACP shapes (its ACP layer descends
            // from codex-acp): with codeg's default capabilities it runs
            // commands and edits files itself and reports them as `execute` /
            // `read` / `edit` tool calls.
            //
            // SYSTEM, NOT BINARY. TRAE CLI 2.0 ships only through its own
            // install scripts (`install_v2.sh` / `install_v2.ps1`), which stage
            // each release under `~/.local/share/traecli/releases`, flip a
            // `current` symlink and link `traex` plus the `traecli` command
            // into `~/.local/bin`. On Windows the script uses
            // `%LOCALAPPDATA%\Programs\TraeCLI\bin` instead, adds it to the
            // user PATH, and writes `traecli.cmd` wrappers that `which`
            // resolves through PATHEXT. A codeg-managed copy would diverge
            // from the one the user's terminal runs while both share `~/.trae`
            // (login, config, skills, sessions). So codeg launches the user's
            // install and pins none; `~/.local/bin` is probed by the system
            // resolver even when a Finder-launched app's PATH lacks it.
            //
            // Message history is codeg's own ACP transcript
            // (`AgentType::uses_acp_transcript`); only exact
            // `token_usage_record` rows are read from TRAE CLI's rollouts —
            // see `acp::trae` for why. MCP servers
            // come from `<TRAE_HOME>/traecli.toml`, which the CLI loads itself
            // and codeg's MCP settings manage, so codeg does not forward the
            // same servers over `session/new` (see `load_mcp_servers_for_agent`).
            distribution: AgentDistribution::System {
                cmd: "traecli",
                args: &["acp", "serve"],
                env: &[],
                install_url: crate::acp::trae::TRAE_INSTALL_URL,
                // `traecli update` asks the release service for the newest
                // build and, when there is one, re-runs the official installer
                // with `TRAECLI_INSTALL_ASSUME_YES=1` (0.209.1's `--dry-run`
                // prints exactly that command), so nothing prompts. Current
                // already: "TRAE CLI is already up to date (0.209.1).", exit 0.
                update_args: Some(&["update"]),
            },
        },
        AgentType::CommandCode => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "Command Code",
            description: "Command Code's coding agent in the terminal (native ACP via command-code acp)",
            // `command-code acp` is the CLI's OWN ACP server, the one its docs
            // (https://commandcode.ai/docs/acp) have editors launch. Verified
            // handshake against 1.84.0: `agentInfo = {name: "Command Code",
            // version}`, `loadSession: true`, `sessionCapabilities` with list /
            // resume / close (no fork), image + embeddedContext prompts, MCP
            // http but NOT sse, and one auth method, `command-code-cli`, which
            // only checks that a login exists. (A second, terminal-auth method
            // that runs `cmd login` is offered only to clients advertising
            // `auth.terminal`, which codeg does not.) `session/new` answers with
            // standard `modes` (default "Standard" / auto-accept / plan /
            // dont-ask / bypass "Bypass Permissions") and two `configOptions`,
            // `model` and `effort` (category `thought_level`), so the
            // composer's generic selectors cover it. Tool calls, permission
            // requests (allow or reject, once or always — "always" per tool for
            // the thread), diffs, plans (from `todo_write`, when the user has
            // Command Code's todos mod on), `usage_update` with the thread's
            // cost and `session_info_update` titles all use the plain ACP
            // shapes; its questions arrive as `session/request_permission` with
            // one option per answer. With codeg's default capabilities it reads,
            // writes and runs commands itself, never through `fs/*` or
            // `terminal/*`.
            //
            // NPX. The vendor ships the CLI as the npm package `command-code`
            // (`npm i -g command-code`, which is exactly codeg's install), with
            // four bins for one entry point: `cmd`, `cmdc`, `commandcode` and
            // `command-code`. codeg launches `command-code`, the only name that
            // works on every platform: on Windows `cmd` is the system shell
            // (the docs switch to `cmdc` there), and a PATH probe for `cmd`
            // would find `cmd.exe` and report the agent installed. In the
            // terminal the CLI updates itself in the background (a staged
            // `npm i -g command-code@<latest>`), but `acp` is on its own list of
            // commands that never run the updater, so a launch from codeg
            // changes nothing; a copy newer than the pin just reads as current.
            //
            // Sign-in is the CLI's own `command-code login` (browser sign-in or
            // a pasted API key, kept in `~/.commandcode/auth.json`), which the
            // ACP server reuses; `COMMAND_CODE_API_KEY` in its environment
            // outranks that file (see `acp::command_code`). With neither,
            // `session/new` answers `authRequired`, which reaches the user as
            // "sign in from the agent's settings".
            //
            // Sessions are Command Code's own (`~/.commandcode/projects/<slug>/
            // <id>.jsonl`, the ones `cmd --resume` lists) and `session/load`
            // replays them, but codeg's history is its own ACP transcript
            // (`AgentType::uses_acp_transcript`), as for TRAE CLI. MCP servers
            // come from `~/.commandcode/mcp.json`, which the CLI loads itself and
            // codeg's MCP settings manage, so codeg does not forward the same
            // servers over `session/new` (see `load_mcp_servers_for_agent`).
            //
            // 1.88.0, after 1.87.0–1.87.3, changes only its version and two
            // dev-only `@byokkit` provider pins in `package.json` (the same
            // engines, bins and dependencies, still no install scripts), and
            // `acp` is still on the updater's skip list. `initialize` and the
            // signed-out `session/new` answer as 1.86.3 did apart from the
            // version (`protocolVersion: 1`). Zero-cost turns (text, Shell behind
            // a permission, Read and Edit, a question, MCP calls, the title and
            // usage, a `session/load` replay in a new process) match 1.86.3 frame
            // for frame, still without a single `fs/*` or `terminal/*` request,
            // and so do the modes, the `effort` values, the MCP sources, the
            // skill roots and the session store. The one difference is in the
            // `model` option: the bundled catalog drops `xiaomi/mimo-v2.5-pro`
            // and `xiaomi/mimo-v2.5`, selecting either now fails with "Unknown
            // model", and a saved pick of one is skipped like any value the list
            // no longer offers. Since 1.85.1 the `model` option, and
            // `models.availableModels`, also list the user's own-key models from
            // `providers.json` (as `<provider>/<model>`, or `<catalog
            // id>@byok-<provider>` for a catalog model served that way), and
            // selecting one over ACP works; the composer's generic model selector
            // lists them like any other. 1.86.0's artifact tools, which publish a
            // workspace HTML file to Command Code's service, load in every session
            // that is not local-only unless `artifactsEnabled: false` turns them
            // off, and would reach codeg as ordinary tool calls. `command-code
            // acp` also takes the global `--mod` / `--safe-mode` /
            // `--mod-option` flags since 1.87.2; codeg passes none of them. The
            // rest (`/btw`, Claude Code's permission-mode names for
            // `--permission-mode` while `session/set_mode` still takes only the
            // advertised ids, background tasks on a free session model, provider
            // error text, updater messages) is outside what codeg drives.
            //
            // 1.88.1 changes only its version and one dev-only `@byokkit`
            // provider pin in `package.json`, and `acp` is still on the
            // updater's skip list. `initialize` and the signed-out
            // `session/new` answer as 1.88.0 did apart from the version
            // (`protocolVersion: 1`). The same zero-cost turns, plus turns with
            // one and with eight attached images, match 1.88.0 frame for frame,
            // still without an `fs/*` or `terminal/*` request, and so do the
            // modes, the `effort` values, the MCP sources, the skill roots and
            // the session store. The `model` option gains `gpt-6.1-terra` and
            // `moonshotai/Kimi-K3.1-Pro` and drops nothing. What changed is how
            // images reach the model. Before each model request Command Code
            // walks the conversation's images oldest first, and whenever their
            // running total passes 20 MiB of base64 it replaces the oldest ones
            // still in (the current prompt's included) with an "[image left
            // out: …]" note until the total is back under 10 MiB, so up to
            // 20 MiB can remain. That happens in the request only: the session
            // file and a `session/load` replay keep every image, and no ACP
            // frame reports it. When the provider refuses a request as too large
            // (HTTP 413 or its wording), Command Code drops older images to a
            // 4 MiB budget and retries, or compacts the conversation when there
            // is no image to drop, and says so in an `agent_message_chunk` ("The
            // server could not take this request as sent: …"), where 1.88.0
            // failed the prompt with -32603. Once a retry that dropped images
            // succeeds, the session keeps the 4 MiB budget while the process
            // runs; it is not saved. Images an MCP tool returns are compressed
            // toward 2048 px, and a resized one adds a "(resized from …)" text
            // block to its `tool_call_update`. One that does not shrink stays
            // as it was, or is left out when it is over 5,000,000 base64
            // characters. Below the budget, images codeg attaches reach the
            // model unchanged. Sub-agents now also run the user's own tool
            // hooks, which codeg never configures.
            //
            // 1.88.2 fixes a crash at launch, and a fresh install of 1.88.1 no
            // longer runs at all. The package ships no lockfile, so its
            // dependencies resolve at install time, and
            // `@opentelemetry/semantic-conventions` 1.44.0 (published
            // 2026-10-28, inside 1.88.1's `^1.30.0`) is an ES module without a
            // default export. 1.88.1 imports that package and three other
            // OpenTelemetry packages by their default export, so a copy
            // installed since then exits before it starts, `acp` included:
            // "SyntaxError: The requested module
            // '@opentelemetry/semantic-conventions' does not provide an export
            // named 'default'". 1.88.2 imports the names it uses instead. With
            // the minified names normalized, those imports and the version
            // string are the only change in `dist/cli.mjs`, and `package.json`
            // changes only its version. `initialize` and the signed-out
            // `session/new` answer as 1.88.1 did apart from the version
            // (`protocolVersion: 1`). Zero-cost turns (text, Shell behind a
            // permission, Read and Edit, a question, MCP calls), the
            // `session/load` replay and the model and effort selections match
            // 1.88.1 frame for frame, still without an `fs/*` or `terminal/*`
            // request. So do the modes, the `effort` values, the MCP sources,
            // the skill roots and the session store.
            distribution: AgentDistribution::Npx {
                version: "1.88.2",
                package: "command-code@1.88.2",
                cmd: "command-code",
                args: &["acp"],
                env: &[],
                // package.json declares `engines.node: ">=22"`, and the bin
                // refuses to start on anything older.
                node_required: Some("22.0.0"),
            },
        },
        AgentType::MiniMaxCode => AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "MiniMax Code",
            description: "MiniMax's terminal coding agent (native ACP via mcode acp)",
            // Launch the user's installation, retaining its native login and
            // config. No wrapper, copied credentials or managed binary cache.
            // Models/modes, streaming and permission requests use the generic
            // ACP pipeline. Models are advertised through configOptions, not
            // a hard-coded catalogue or the legacy session/set_model method.
            // History is the Codeg-owned ACP transcript; native CLI history
            // is deliberately not scanned without a stable import contract.
            distribution: AgentDistribution::System {
                cmd: "mcode",
                args: &["acp"],
                env: &[],
                install_url: "https://github.com/MiniMax-AI/minimax-code#quick-start",
                // Leave upgrades to the official CLI installer until an
                // unattended updater contract is verified.
                update_args: None,
            },
        },
        // Handled by the early return above; keep this match exhaustive.
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
                assert_eq!(version, "1.4.4");
                assert_eq!(cmd, "agy_acp_server");
                let entry = dir_entry.expect("antigravity must use dir-tree extraction");
                assert_eq!(entry.unix, "agy_acp_server.par");
                assert_eq!(entry.windows, "agy_acp_server.exe");
                // Six targets: upstream added the Intel macOS build in 1.2.1.
                assert_eq!(platforms.len(), 6);
                assert!(platforms.iter().any(|p| p.platform == "darwin-x86_64"));
                for platform in platforms {
                    assert!(
                        platform.url.contains("/agy-acp-server-1.4.4-"),
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
            "2026.10.22-27dcf5f",
            "/lab/2026.10.22-27dcf5f/",
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

    // Kiro is the one SYSTEM agent: its installers (a .dmg, an .msi, a Linux
    // install.sh) are nothing the binary cache can replay, so there is no pin,
    // no custom version, and the launch is the user's own `kiro-cli acp` —
    // upgraded in place by the CLI's own updater.
    #[test]
    fn kiro_launches_the_system_cli_without_a_pin() {
        let meta = get_agent_meta(AgentType::Kiro);
        assert_eq!(registry_id_for(AgentType::Kiro), "kiro-cli");
        assert_eq!(from_registry_id("kiro-cli"), Some(AgentType::Kiro));
        assert_eq!(meta.registry_version(), None);
        assert!(!meta.supports_custom_version());
        assert!(!uses_cursor_acp_backend(AgentType::Kiro));
        match meta.distribution {
            AgentDistribution::System {
                cmd,
                args,
                env,
                install_url,
                update_args,
            } => {
                assert_eq!(cmd, "kiro-cli");
                assert_eq!(args, &["acp"]);
                assert!(env.is_empty());
                assert!(install_url.starts_with("https://kiro.dev/"));
                assert_eq!(update_args, Some(&["update", "--non-interactive"][..]));
            }
            other => panic!("expected system distribution for Kiro, got {other:?}"),
        }
        // Kiro, TRAE CLI and MiniMax Code use the system distribution; every other
        // built-in has a pinned version codeg installs itself.
        for agent_type in builtin_acp_agents() {
            if !matches!(
                agent_type,
                AgentType::Kiro | AgentType::Trae | AgentType::MiniMaxCode
            ) {
                assert!(
                    get_agent_meta(agent_type).registry_version().is_some(),
                    "{agent_type:?} lost its pin"
                );
            }
        }
    }

    // TRAE CLI is the second SYSTEM agent: only its own install scripts set it
    // up, so there is no pin, the launch is the user's `traecli acp serve`,
    // and Upgrade runs the CLI's own `traecli update`. Its registry id must
    // stay clear of every id a hand-registered custom TRAE entry could carry.
    #[test]
    fn minimax_code_launches_native_acp_without_overriding_configuration() {
        let meta = get_agent_meta(AgentType::MiniMaxCode);
        assert_eq!(meta.name, "MiniMax Code");
        assert!(meta.supports_mcp);
        assert_eq!(
            registry_id_for(AgentType::MiniMaxCode),
            "codeg-minimax-code"
        );
        assert_eq!(
            from_registry_id("codeg-minimax-code"),
            Some(AgentType::MiniMaxCode)
        );
        assert!(meta.registry_version().is_none());
        assert!(!meta.supports_custom_version());
        assert!(acp_adapter_relation(AgentType::MiniMaxCode).is_none());
        match meta.distribution {
            AgentDistribution::System {
                cmd,
                args,
                env,
                install_url,
                update_args,
            } => {
                assert_eq!(cmd, "mcode");
                assert_eq!(args, &["acp"]);
                assert!(env.is_empty());
                assert_eq!(
                    install_url,
                    "https://github.com/MiniMax-AI/minimax-code#quick-start"
                );
                assert!(update_args.is_none());
            }
            other => panic!("expected native system distribution, got {other:?}"),
        }
        #[cfg(not(windows))]
        assert_eq!(
            binary_system_dirs(AgentType::MiniMaxCode),
            &[".minimax-code/bin"]
        );
        #[cfg(windows)]
        assert_eq!(
            binary_system_dirs(AgentType::MiniMaxCode),
            &[".minimax-code"]
        );
    }

    #[test]
    fn trae_launches_the_system_cli_without_a_pin() {
        let meta = get_agent_meta(AgentType::Trae);
        assert!(meta.supports_mcp);
        assert_eq!(meta.name, "TRAE CLI");
        assert_eq!(registry_id_for(AgentType::Trae), "codeg-trae-cli");
        assert_eq!(from_registry_id("codeg-trae-cli"), Some(AgentType::Trae));
        for hand_registered in ["trae", "traecli", "trae-cli"] {
            assert_ne!(registry_id_for(AgentType::Trae), hand_registered);
        }
        assert_eq!(meta.registry_version(), None);
        assert!(!meta.supports_custom_version());
        assert!(!uses_cursor_acp_backend(AgentType::Trae));
        assert!(acp_adapter_relation(AgentType::Trae).is_none());
        match meta.distribution {
            AgentDistribution::System {
                cmd,
                args,
                env,
                install_url,
                update_args,
            } => {
                assert_eq!(cmd, "traecli");
                assert_eq!(args, &["acp", "serve"]);
                assert!(env.is_empty());
                assert!(install_url.starts_with("https://docs.trae.cn/"));
                assert_eq!(update_args, Some(&["update"][..]));
            }
            other => panic!("expected system distribution for TRAE CLI, got {other:?}"),
        }
    }

    // Command Code is an npm CLI whose own `acp` subcommand is the server. It
    // must launch as `command-code`, never `cmd` (Windows' shell), and its
    // registry id must stay clear of every id a hand-registered custom entry
    // could carry.
    #[test]
    fn command_code_launches_the_portable_bin_with_the_acp_subcommand() {
        let meta = get_agent_meta(AgentType::CommandCode);
        assert!(meta.supports_mcp);
        assert_eq!(meta.name, "Command Code");
        assert_eq!(
            registry_id_for(AgentType::CommandCode),
            "codeg-command-code"
        );
        assert_eq!(
            from_registry_id("codeg-command-code"),
            Some(AgentType::CommandCode)
        );
        for hand_registered in ["command-code", "commandcode", "command_code", "cmd", "cmdc"] {
            assert_ne!(registry_id_for(AgentType::CommandCode), hand_registered);
        }
        assert!(!uses_cursor_acp_backend(AgentType::CommandCode));
        assert!(acp_adapter_relation(AgentType::CommandCode).is_none());
        match meta.distribution {
            AgentDistribution::Npx { cmd, args, env, .. } => {
                assert_eq!(cmd, "command-code");
                assert_eq!(args, &["acp"]);
                assert!(env.is_empty());
            }
            other => panic!("expected npx distribution for Command Code, got {other:?}"),
        }
    }

    #[test]
    fn steering_prompt_required_min_version_gates_claude_and_codex_only() {
        // The native-steering policy bit: only an adapter that honors the
        // `promptRequired` opt-in AND keeps the owning prompt in flight across
        // a steered turn gets a minimum version. The floor is the release that
        // fixed the latter (claude-agent-acp 0.65.0 / #958), NOT the one that
        // introduced the opt-in — every 0.64.x settles the prompt early (#934).
        // codex-acp's active path always kept the prompt in flight, and 2.4.0
        // (#593) is the first release with the opt-in. Everyone else stays
        // None and rides the MCP pull channel. Flipping an agent on here
        // without the runtime `agent_info.version` proof is not enough by
        // design.
        assert_eq!(
            steering_prompt_required_min_version(AgentType::ClaudeCode),
            Some("0.65.0")
        );
        assert_eq!(
            steering_prompt_required_min_version(AgentType::Codex),
            Some("2.4.0")
        );
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
    fn only_codex_steering_waits_out_an_open_permission_card() {
        // codex drops a note injected during an approval when the answer is
        // `cancel`, so its notes queue while a card is open. Claude keeps
        // steering through one, as it always has.
        assert!(steering_waits_out_open_permission(AgentType::Codex));
        for agent in [
            AgentType::ClaudeCode,
            AgentType::Gemini,
            AgentType::Grok,
            AgentType::Custom("acme"),
        ] {
            assert!(!steering_waits_out_open_permission(agent), "{agent:?}");
        }
    }

    #[test]
    fn claude_agent_acp_package_is_the_package_claude_code_pins() {
        // A custom agent gets the Claude Code steering policy when its adapter
        // reports exactly this name, so the name must stay the package the
        // built-in entry actually runs.
        let AgentDistribution::Npx {
            package, version, ..
        } = get_agent_meta(AgentType::ClaudeCode).distribution
        else {
            panic!("Claude Code is an npx agent");
        };
        assert_eq!(package, format!("{CLAUDE_AGENT_ACP_PACKAGE}@{version}"));
    }

    #[test]
    fn cline_launch_env_keeps_sessions_in_process_and_the_pin_in_place() {
        // On cline's hub runtime a model switch after a session's first prompt
        // never reaches the requests, and in "auto" mode a session lands on the
        // hub whenever an earlier `cline --acp` left one running. Every launch
        // pins the in-process runtime instead (see the registry entry).
        let AgentDistribution::Npx { env, .. } = get_agent_meta(AgentType::Cline).distribution
        else {
            panic!("Cline is an npx agent");
        };
        // Nor may a session's exit move codeg's pinned install: cline's own
        // updater would `npm update -g cline` to whatever is latest.
        assert_eq!(
            env,
            &[
                ("CLINE_SESSION_BACKEND_MODE", "local"),
                ("CLINE_NO_AUTO_UPDATE", "1"),
            ]
        );
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
            "0.99.1",
            "@agentclientprotocol/claude-agent-acp@0.99.1",
            Some("22.0.0"),
        );
        assert_npx_version(
            AgentType::Gemini,
            "0.60.0",
            "@google/gemini-cli@0.60.0",
            Some("20.0.0"),
        );
        // OpenClaw's floor is a RUNTIME gate (`node-version.mjs`), not just
        // `engines` metadata: 2026.9.3 retired the Node 22 lane and 2026.9.8
        // keeps that range, so this must stay at the lowest release the guard
        // admits (see the registry entry).
        assert_npx_version(
            AgentType::OpenClaw,
            "2026.9.8",
            "openclaw@2026.9.8",
            Some("24.16.0"),
        );
        assert_npx_version(
            AgentType::Cline,
            "3.0.74",
            "cline@3.0.74",
            Some("22.0.0"),
        );
        assert_npx_version(
            AgentType::CodeBuddy,
            "2.177.1",
            "@tencent-ai/codebuddy-code@2.177.1",
            Some("22.0.0"),
        );
        // Kimi Code must never land on 0.37.0–0.38.0: every session in that
        // range dies on the codeg-mcp stdio entry (see the registry entry).
        assert_npx_version(
            AgentType::KimiCode,
            "2.4.0",
            "@moonshot-ai/kimi-code@2.4.0",
            Some("22.19.0"),
        );
        assert_npx_version(
            AgentType::Codex,
            "2.5.0",
            "@agentclientprotocol/codex-acp@2.5.0",
            Some("20.3.0"),
        );
        assert_npx_version(AgentType::Pi, "0.0.34", "pi-acp@0.0.34", Some("22.0.0"));
        assert_npx_version(
            AgentType::Grok,
            "1.0.70",
            "@xai-official/grok@1.0.70",
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
            "1.1.81",
            "@qoder-ai/qodercli@1.1.81",
            Some("20.0.0"),
        );
        assert_npx_version(
            AgentType::CommandCode,
            "1.88.2",
            "command-code@1.88.2",
            Some("22.0.0"),
        );
        assert_binary_version(AgentType::OpenCode, "2.2.0", "/releases/download/v2.2.0/");
        // Hermes rides the community npm bridge (upstream retired its PyPI
        // channel at 0.19.0; see the registry entry). The npm package version
        // tracks the upstream version 1:1, and the pin must stay EXACT — the
        // audited wrapper code is only what the pinned version ships.
        assert_npx_version(
            AgentType::Hermes,
            "0.22.2",
            "hermes-agent@0.22.2",
            Some("20.0.0"),
        );
    }

    /// The settings panel's "this pi is too old" warning and the backend's
    /// upgrade message must name the same floor.
    #[test]
    fn pi_min_runtime_version_matches_the_settings_panel() {
        let panel = include_str!("../../../src/lib/pi-config.ts");
        let declaration = format!("PI_MIN_RUNTIME_VERSION = \"{PI_MIN_RUNTIME_VERSION}\"");
        assert!(
            panel.contains(&declaration),
            "src/lib/pi-config.ts must declare {declaration}"
        );
    }

    // The Hermes launch command must be the wrapper's `hermes` bin with the
    // `acp` subcommand — the package's OTHER bins (`hermes-agent`,
    // `hermes-npm`) map to different console scripts (`agent.legacy_cli:main`
    // and the bridge maintenance CLI), not the ACP adapter. `resolve_npx_command`
    // checks PATH and `~/.local/bin` before the npm prefix, so an
    // official-installer `hermes` keeps outranking the npm-managed copy
    // without any policy bit.
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
            let expected = matches!(
                agent_type,
                AgentType::ClaudeCode | AgentType::Codex | AgentType::ZCode
            );
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
