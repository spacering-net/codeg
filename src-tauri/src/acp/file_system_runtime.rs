use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1::{
    ReadTextFileRequest, ReadTextFileResponse, WriteTextFileRequest, WriteTextFileResponse,
};
use tokio::sync::Semaphore;

use crate::models::agent::AgentType;
use crate::parsers::expand_home_prefix;

const FS_MAX_CONCURRENT_OPS: usize = 8;
const FS_IO_TIMEOUT: Duration = Duration::from_secs(30);
const FS_MAX_FILE_SIZE_BYTES: u64 = 16 * 1024 * 1024;
const FS_MAX_READ_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const FS_MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;
const FS_SLOW_OPERATION_MS: u128 = 200;

#[derive(Debug)]
pub enum FileSystemRuntimeError {
    InvalidParams(String),
    Internal(String),
}

impl FileSystemRuntimeError {
    pub fn into_rpc_error(self) -> agent_client_protocol::Error {
        match self {
            Self::InvalidParams(message) => agent_client_protocol::Error::invalid_params().data(message),
            Self::Internal(message) => agent_client_protocol::util::internal_error(message),
        }
    }
}

/// Per-agent `env_json` / process-env key selecting the path-containment policy
/// for the ACP `fs/*` channel. `default` | `strict` | `unrestricted`; anything
/// else warns and falls back to `default`.
pub(crate) const FS_POLICY_ENV: &str = "CODEG_ACP_FS_POLICY";
/// Additional **writable** roots, joined with the platform `PATH` separator
/// (`:` on unix, `;` on Windows — parsed with `std::env::split_paths`, so a
/// Windows drive letter's colon is not mistaken for a separator).
pub(crate) const FS_EXTRA_ROOTS_ENV: &str = "CODEG_ACP_FS_EXTRA_ROOTS";

/// Which paths the ACP `fs/read_text_file` / `fs/write_text_file` handlers will
/// serve.
///
/// An EMPTY root list means "unrestricted" for that direction — not "deny
/// everything". Reads default to unrestricted because the gate buys no safety
/// AS LONG AS codeg also advertises `terminal(true)`: an agent refused a read
/// simply `cat`s the file through the shell codeg runs for it (empirically what
/// grok does — it fell back to `run_terminal_command` with a
/// `cat > … << 'PLAN_EOF'` heredoc, re-sending the whole payload as a shell
/// command). Writes keep a root list mirroring the agents' own sandbox model
/// (grok's `workspace` profile: CWD + its own home + temp dirs).
///
/// That "buys no safety" reasoning is conditional, and the condition is
/// [`crate::acp::host_tools_policy::HostToolsPolicy`] — do not read it as "a
/// read gate can never work". Under `CODEG_ACP_HOST_TOOLS=agent` codeg hosts
/// NEITHER channel, and the `cat` fallback stops working: measured against grok
/// 1.0.0 with a kernel `deny`, the read failed `EPERM` and so did every
/// `run_terminal_command` and `grep` retry, because they were children of the
/// agent's own sandboxed process. The escape hatch is codeg's terminal, not
/// some inherent property of shells.
///
/// NOTE: deliberately NOT `Default` — an all-empty policy means "unrestricted",
/// so a derived `Default` would let `..Default::default()` or a stray
/// `FsAccessPolicy::default()` silently open up writes. Construct through the
/// named constructors instead.
#[derive(Clone, Debug)]
pub struct FsAccessPolicy {
    /// Roots a read may resolve into. Empty ⇒ unrestricted.
    read_roots: Vec<PathBuf>,
    /// Roots a write may land in. Empty ⇒ unrestricted.
    write_roots: Vec<PathBuf>,
}

impl FsAccessPolicy {
    /// Today's historical behavior: reads and writes both confined to the
    /// session working directory. Reachable via `CODEG_ACP_FS_POLICY=strict`.
    pub fn strict(workspace_root: &Path) -> Self {
        let roots = vec![canonical_root(workspace_root)];
        Self {
            read_roots: roots.clone(),
            write_roots: roots,
        }
    }

    /// No path gate at all in either direction. `CODEG_ACP_FS_POLICY=unrestricted`.
    pub fn unrestricted() -> Self {
        Self {
            read_roots: Vec::new(),
            write_roots: Vec::new(),
        }
    }

    /// The default: unrestricted reads; writes confined to the workspace, the
    /// agent's own data home (so plan files, skills and session state work),
    /// the temp dirs (attachments), and any `CODEG_ACP_FS_EXTRA_ROOTS` entries.
    pub fn permissive(
        workspace_root: &Path,
        agent_type: AgentType,
        runtime_env: &BTreeMap<String, String>,
    ) -> Self {
        let mut write_roots = vec![canonical_root(workspace_root)];
        for root in agent_data_roots(agent_type, runtime_env) {
            write_roots.push(canonical_root(&root));
        }
        for root in temp_roots() {
            write_roots.push(canonical_root(&root));
        }
        for root in extra_write_roots(runtime_env) {
            write_roots.push(canonical_root(&root));
        }
        write_roots.sort();
        write_roots.dedup();

        Self {
            read_roots: Vec::new(),
            write_roots,
        }
    }

    /// Resolve the policy for a connection from `CODEG_ACP_FS_POLICY`, checking
    /// the agent's `runtime_env` first (so it can be set per agent through the
    /// existing agent-settings `env_json`) then codeg's own process env.
    pub fn from_env(
        workspace_root: &Path,
        agent_type: AgentType,
        runtime_env: &BTreeMap<String, String>,
    ) -> Self {
        match env_value(runtime_env, FS_POLICY_ENV)
            .as_deref()
            .map(str::trim)
        {
            None | Some("") | Some("default") => {
                Self::permissive(workspace_root, agent_type, runtime_env)
            }
            Some("strict") => Self::strict(workspace_root),
            Some("unrestricted") => Self::unrestricted(),
            Some(other) => {
                tracing::warn!(
                    "[ACP] unrecognized {FS_POLICY_ENV}={other:?}; falling back to \"default\""
                );
                Self::permissive(workspace_root, agent_type, runtime_env)
            }
        }
    }

    /// Whether the READ direction is gated at all — i.e. `strict`, the only
    /// policy that sets read roots. Read by the connection log to catch the
    /// combination that promises more than it delivers: a confined fs channel
    /// next to an advertised `terminal`, which an agent simply walks around.
    pub fn confines_reads(&self) -> bool {
        !self.read_roots.is_empty()
    }

    /// One-line summary for the connection log.
    pub fn describe(&self) -> String {
        fn render(roots: &[PathBuf]) -> String {
            if roots.is_empty() {
                "unrestricted".to_string()
            } else {
                roots
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        }
        format!(
            "read={} write={}",
            render(&self.read_roots),
            render(&self.write_roots)
        )
    }
}

/// Read a knob VERBATIM from the agent's `runtime_env` first, then codeg's
/// process env. Used where the value is a path (or path list) and must not be
/// normalized: trimming `" / "` into `/` would turn a relative entry into the
/// filesystem root.
fn raw_env_value(runtime_env: &BTreeMap<String, String>, key: &str) -> Option<OsString> {
    match runtime_env.get(key) {
        Some(value) if value.is_empty() => None,
        Some(value) => Some(OsString::from(value)),
        None => std::env::var_os(key).filter(|value| !value.is_empty()),
    }
}

/// Read a knob from the agent's `runtime_env` first, then codeg's process env,
/// trimmed — for values compared as keywords, never as paths.
///
/// Mirrors `CODEG_ACP_HOST_TOOLS` (`acp::host_tools_policy`): a codeg-only key
/// that rides along in the per-agent `env_json`, so it is configurable per agent
/// from the existing settings UI without a new surface.
///
/// `pub(crate)` so [`crate::acp::host_tools_policy`] resolves its own knob with
/// exactly this precedence — one notion of "a codeg launch knob" across both.
pub(crate) fn env_value(runtime_env: &BTreeMap<String, String>, key: &str) -> Option<String> {
    runtime_env
        .get(key)
        .map(|raw| raw.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var(key)
                .ok()
                .map(|raw| raw.trim().to_string())
                .filter(|value| !value.is_empty())
        })
}

/// Extra writable roots from `CODEG_ACP_FS_EXTRA_ROOTS`. Relative entries are
/// dropped for the same reason as relative agent homes: they would be resolved
/// against codeg's cwd, so `.` or `..` silently widens the policy to an
/// unrelated tree (or to `/`). Dropping is fail-closed.
///
/// The list is read VERBATIM — `split_paths` does not trim entries, so trimming
/// the value first would rewrite a relative `" / "` entry into `/` and hand out
/// the whole filesystem. An entry that IS exactly `/` is still honored: widening
/// is this knob's declared purpose, and then it is the user's explicit choice.
fn extra_write_roots(runtime_env: &BTreeMap<String, String>) -> Vec<PathBuf> {
    let Some(raw) = raw_env_value(runtime_env, FS_EXTRA_ROOTS_ENV) else {
        return Vec::new();
    };

    std::env::split_paths(&raw)
        .filter(|path| !path.as_os_str().is_empty())
        .filter(|path| {
            if path.is_absolute() {
                return true;
            }
            tracing::warn!(
                "[ACP] ignoring relative {FS_EXTRA_ROOTS_ENV} entry {}; use an absolute path",
                path.display()
            );
            false
        })
        .collect()
}

/// Temp roots an agent legitimately writes through the `fs/*` channel (image
/// attachments, scratch files). `std::env::temp_dir()` is the per-user one
/// (`/var/folders/…` on macOS, which canonicalizes to `/private/var/folders/…`
/// — hence `canonical_root` on every entry).
fn temp_roots() -> Vec<PathBuf> {
    let mut roots = vec![std::env::temp_dir()];
    // The shared unix temp dirs are extra roots on top of the per-user one;
    // Windows has none to add. Gated with a runtime `cfg!` rather than
    // `#[cfg(unix)]` so the binding is still mutated on Windows — a `#[cfg]`
    // block leaves `mut` unused there, which `-D warnings` rejects.
    if cfg!(unix) {
        roots.push(PathBuf::from("/tmp"));
        roots.push(PathBuf::from("/var/tmp"));
    }
    roots
}

/// The agent's own data home — where it keeps session state, plan files and
/// skills. Writes there are part of normal operation, not an escape:
/// grok's plan mode writes `<GROK_HOME>/sessions/<cwd>/<sid>/plan.md` and reads
/// `<GROK_HOME>/skills/*/SKILL.md`, both outside any workspace.
///
/// Reuses the per-agent resolvers in `crate::parsers` (the same ones
/// `external_transcript_sources` uses) so codeg has exactly ONE notion of where
/// each agent lives. Where the agent's home is relocatable, the agent's
/// `runtime_env` wins over codeg's process env — a per-agent `GROK_HOME` in
/// `env_json` moves the agent's state, so it must move the allowed root too.
/// Same shape as `commands::acp::pi_agent_dir_for_env`.
fn agent_data_roots(agent_type: AgentType, runtime_env: &BTreeMap<String, String>) -> Vec<PathBuf> {
    agent_root_slots(agent_type)
        .iter()
        .filter_map(|slot| resolve_root_slot(slot, runtime_env))
        .collect()
}

/// One independently-relocatable directory belonging to an agent.
///
/// Modelled declaratively because three separate review findings were all the
/// same mistake — hand-rolling one agent's env semantics slightly differently
/// from its own resolver.
struct RootSlot {
    /// Ordered `(env key, sub-path appended to that key's value, tilde rule)`
    /// candidates, in the agent resolver's OWN precedence order. First one that
    /// reaches the child wins. An empty sub-path means the value IS the root.
    candidates: &'static [(&'static str, &'static str, bool)],
    /// Home-relative default when none of the candidates reaches the child.
    default_rel: &'static [&'static str],
    /// Whether the agent's own resolver TRIMS the value before using it. Hermes
    /// (`resolve_hermes_home` / `hermes_home_for_launch`) and Cline
    /// (`cline_data_dir`) do, so a whitespace-only value is genuinely unset for
    /// them; every other resolver takes the raw `OsString` and only rejects an
    /// empty one, so trimming on their behalf would misreport the child's path.
    trims: bool,
}

/// The third element of a candidate: whether the agent's own resolver expands a
/// leading `~` in THAT variable's value.
///
/// Per-candidate rather than per-slot because one slot can mix the two.
/// DeepSeek's session-log root is the case: `resolve_deepseek_sessions_root_from`
/// takes `DEEPSEEK_ACP_SESSIONS_ROOT` as a bare `PathBuf::from`, but falls back
/// through `resolve_dsh_home_from`, which DOES expand `DSH_HOME`. A slot-level
/// flag would have to be wrong for one of them.
///
/// Getting it wrong in either direction names a directory the child does not
/// use. `EXPANDS_TILDE` where the upstream resolver runs the equivalent of
/// `expanduser` — Antigravity's `acp_server/paths.py` on `GEMINI_HOME`,
/// DeepSeek's `expandHomePath` on `DSH_HOME`. `VERBATIM` everywhere else, and
/// notably for Hermes, whose `get_hermes_home` is a bare
/// `Path(os.environ["HERMES_HOME"].strip())`: expanding there would invent
/// `$HOME` as a writable root the user never selected, while NOT expanding for
/// Antigravity left the agent unable to write its own directory, the literal
/// `~/...` having been judged relative and refused.
///
/// Only the leading `~` and `~/` (or `~\`) forms. A `~user` form is passed
/// through rather than resolved — see `parsers::expand_home_prefix`, which
/// records why that is a deliberate divergence from `expanduser` and why it is
/// safe: the unexpanded value is not absolute, so the slot is refused below.
const VERBATIM: bool = false;
const EXPANDS_TILDE: bool = true;

/// Resolve one slot to the directory the LAUNCHED agent will actually use, or
/// `None` when that directory cannot be named safely.
///
/// The value is taken VERBATIM apart from the resolver's sub-path and, for the
/// candidates whose own resolver does it, a leading `~` (see [`EXPANDS_TILDE`]).
/// Expanding for an agent that does not — Hermes reads `HERMES_HOME` as a bare
/// `Path(val)` — would invent `$HOME` as a writable root the user never
/// selected; NOT expanding for one that does left the agent unable to write its
/// OWN directory, because the literal `~/...` was then judged relative and
/// refused below.
fn resolve_root_slot(slot: &RootSlot, runtime_env: &BTreeMap<String, String>) -> Option<PathBuf> {
    for (key, suffix, expands) in slot.candidates {
        // Absent for the child ⇒ try the next candidate, exactly as the agent's
        // own resolver would.
        let Some(value) = child_env_value(runtime_env, key, slot.trims) else {
            continue;
        };

        // A RELATIVE value yields NO root for this slot — and must not fall
        // through to a lower-precedence candidate or the default.
        //
        // Absolutizing it would resolve against CODEG's cwd while the child runs
        // in the workspace cwd, and that mismatch WIDENS rather than merely
        // mismatching: `CODEX_HOME="."` with codeg launched from `/` yields the
        // root `/`, which every absolute path passes `starts_with` against.
        // Falling through would be wrong too — the child DID receive this value
        // and uses it, so the default (`~/.codex`) is an inactive profile holding
        // config and credentials, exactly the tree the isolation invariant keeps
        // unwritable. So: refuse the slot. That is fail-closed (the agent's write
        // is rejected), and the user can still name the directory explicitly via
        // `CODEG_ACP_FS_EXTRA_ROOTS`.
        // Expanded against the CHILD's home, for the same reason the
        // `default_rel` branch below uses it: `merge_agent_env` copies every
        // `runtime_env` entry into the child, `HOME` included, and overriding it
        // is the classic way to isolate a CLI's config. With
        // `HOME=/srv/agy GEMINI_HOME=~/profile` the child's `expanduser` answers
        // `/srv/agy/profile`, so resolving against codeg's own home would
        // authorize a directory the agent never opens while leaving the one it
        // does use unwritable. `None` means the child's home cannot be named at
        // all, which `child_home_dir` has already warned about — treat the slot
        // as unresolvable rather than substituting codeg's answer for it.
        let base = if *expands {
            expand_home_prefix(&value.to_string_lossy(), child_home_dir(runtime_env).as_ref())
        } else {
            PathBuf::from(value)
        };
        if !base.is_absolute() {
            tracing::warn!(
                "[ACP] relative {key}={} cannot be used as an fs write root; \
                 the agent's own directory is NOT writable this launch. \
                 Use an absolute path (or {FS_EXTRA_ROOTS_ENV}).",
                base.display()
            );
            return None;
        }

        let root = if suffix.is_empty() {
            base
        } else {
            base.join(suffix)
        };

        // Same fail-closed rule one level up: a root this broad makes the gate
        // meaningless, because every absolute path under it passes
        // `starts_with`. `GEMINI_HOME=~` is a legal setting that really does put
        // Antigravity's tree directly in the home directory, and honoring it
        // here would hand the agent write access to every other agent's
        // credentials as a side effect. The agent still runs; only codeg's own
        // `fs/*` channel declines to authorize the whole home, and
        // `CODEG_ACP_FS_EXTRA_ROOTS` can still name a narrower directory inside
        // it.
        if is_over_broad_root(&root, runtime_env) {
            tracing::warn!(
                "[ACP] {key}={} resolves to the home directory or the filesystem \
                 root, which is too broad to authorize; the agent's own directory \
                 is NOT writable this launch. Use a subdirectory (or \
                 {FS_EXTRA_ROOTS_ENV}).",
                root.display()
            );
            return None;
        }

        return Some(root);
    }

    // No relocation reaches the child, so it falls back to a home-relative
    // default — resolved against the CHILD's home, not codeg's (see
    // `child_home_dir`).
    let mut root = child_home_dir(runtime_env)?;
    for segment in slot.default_rel {
        root.push(segment);
    }
    Some(root)
}

/// Whether a resolved root would swallow so much that the containment gate
/// stops meaning anything: a home directory itself, the filesystem root, or any
/// path with no parent (a bare `C:\` on Windows).
///
/// Judged on the CANONICAL form, because that is what the policy ultimately
/// stores and compares with (`FsAccessPolicy::permissive` runs every root
/// through `canonical_root`). A syntactic check is trivially bypassable: with
/// `$HOME/work` present, `GEMINI_HOME=~/work/..` is not equal to `$HOME` as
/// written, but canonicalizes to exactly it — and a symlink inside the
/// configured directory pointing at `$HOME` or `/` does the same without any
/// `..` at all.
///
/// BOTH homes are rejected. The child's is the one whose tree this is, and
/// codeg's is the one holding every other agent's credentials; authorizing
/// either wholesale defeats the isolation invariant, and they are only the same
/// path when the launch does not relocate `HOME`.
///
/// Pinned by `no_agent_data_root_is_the_home_dir_or_filesystem_root` and
/// `an_over_broad_root_is_refused_after_canonicalization`.
fn is_over_broad_root(root: &Path, runtime_env: &BTreeMap<String, String>) -> bool {
    let canonical = canonical_root(root);
    if canonical.parent().is_none() || canonical == Path::new("/") {
        return true;
    }
    [child_home_dir(runtime_env), dirs::home_dir()]
        .into_iter()
        .flatten()
        .any(|home| canonical_root(&home) == canonical)
}

/// The home directory the CHILD resolves its defaults against.
///
/// `merge_agent_env` copies EVERY `runtime_env` entry into the child — `HOME`
/// included, and overriding it is the classic way to isolate a CLI's config — so
/// the home-relative defaults must follow the child's home. Using codeg's would
/// both grant the inactive profile (config/credentials the session never opens)
/// and refuse the active one.
///
/// `None` when the child's home cannot be named as an absolute path, in which
/// case the caller refuses the slot rather than guessing at a root.
pub(crate) fn child_home_dir(runtime_env: &BTreeMap<String, String>) -> Option<PathBuf> {
    // `dirs::home_dir()` ignores `$HOME` on Windows, where the home var the
    // agents actually read is `USERPROFILE`.
    #[cfg(windows)]
    const HOME_KEY: &str = "USERPROFILE";
    #[cfg(not(windows))]
    const HOME_KEY: &str = "HOME";

    // The three states are NOT interchangeable, and collapsing the last two is a
    // real bug: `dirs::home_dir()` consults CODEG's `$HOME` before falling back to
    // the passwd entry, so it answers for codeg, not for a child whose `HOME` was
    // removed.
    let home = match runtime_env.get(HOME_KEY) {
        // Explicitly REMOVED (blank ⇒ `env_remove`): the child resolves its home
        // from the OS account database, which we cannot read without duplicating a
        // passwd lookup — and codeg's `$HOME` is NOT that answer whenever the two
        // differ. Refuse rather than guess; the user can still name the directory
        // via `CODEG_ACP_FS_EXTRA_ROOTS`.
        Some(value) if value.is_empty() => {
            tracing::warn!(
                "[ACP] {HOME_KEY} is removed for this launch, so the agent's own \
                 directory cannot be located and is NOT writable; \
                 set {FS_EXTRA_ROOTS_ENV} if it needs to be"
            );
            return None;
        }
        // Overridden: the child sees exactly this.
        Some(value) => PathBuf::from(value),
        // Absent: the child inherits codeg's environment, so codeg's answer is
        // exact — including its own passwd fallback when codeg has no `HOME`.
        None => {
            // On Windows the agents' home also derives from `HOMEDRIVE` +
            // `HOMEPATH` when `USERPROFILE` is absent (Python's rule, which
            // Hermes follows). If the launch relocates that pair without
            // relocating `USERPROFILE`, codeg's answer may not be the child's, so
            // fail closed instead of guessing.
            #[cfg(windows)]
            if runtime_env.contains_key("HOMEDRIVE") || runtime_env.contains_key("HOMEPATH") {
                tracing::warn!(
                    "[ACP] HOMEDRIVE/HOMEPATH are relocated without {HOME_KEY}; \
                     the agent's own directory cannot be located and is NOT writable"
                );
                return None;
            }
            dirs::home_dir()?
        }
    };

    // `dirs` accepts a relative `HOME` on unix, and a relative home would be
    // absolutized against codeg's cwd — the same widening as a relative agent
    // home, so refuse it the same way.
    if !home.is_absolute() {
        tracing::warn!(
            "[ACP] relative {HOME_KEY}={} cannot anchor the fs write roots; \
             the agent's own directory is NOT writable this launch",
            home.display()
        );
        return None;
    }

    Some(home)
}

/// What the LAUNCHED child will see for `key`, which is NOT simply
/// "runtime_env else our env":
///
/// * non-blank in `runtime_env` — `merge_agent_env` gives `runtime_env` the
///   highest precedence, so this REPLACES the parent's value in the child.
/// * blank in `runtime_env` — the spawn layer (`acp::agent_process`) treats an
///   empty value as `env_remove` ("an empty value means ensure this var is
///   ABSENT from the child"). The child therefore does NOT
///   inherit our value; the agent falls back to its own default. Reading through
///   to our process env here would point the root at a profile the child never
///   opens, re-breaking the writes this change exists to allow.
/// * absent from `runtime_env` — the child inherits our environment.
///
/// The value is returned VERBATIM. Only an EXACTLY empty string counts as
/// removed, because that is the precise test the spawn layer applies
/// (`if env_var.value.is_empty() { env_remove }`) — a whitespace-only value is
/// passed through to the child untouched. Trimming here would both under-include
/// (treating `"  "` as unset when the child receives it) and, worse, WIDEN:
/// `CODEX_HOME=" / "` reaches the child as a *relative* path, but trimmed it
/// becomes `/` and would make the entire filesystem writable.
///
/// `trims` opts into the normalization the agent's OWN resolver performs: Hermes
/// and Cline trim their value (so a whitespace-only value really is unset for
/// them), while the rest take the raw `OsString` and only reject an empty one.
/// Inherited values go through `var_os` so a non-UTF-8 path is not silently
/// dropped.
fn child_env_value(
    runtime_env: &BTreeMap<String, String>,
    key: &str,
    trims: bool,
) -> Option<OsString> {
    let raw = match runtime_env.get(key) {
        // Exactly empty ⇒ the spawn layer `env_remove`s it.
        Some(value) if value.is_empty() => return None,
        Some(value) => OsString::from(value),
        None => std::env::var_os(key)?,
    };

    if trims {
        let trimmed = raw.to_string_lossy().trim().to_string();
        return (!trimmed.is_empty()).then(|| OsString::from(trimmed));
    }

    (!raw.is_empty()).then_some(raw)
}

/// Every agent's relocatable directories, mirroring the `resolve_*_from` bodies
/// in `crate::parsers` (pinned by `root_slots_match_parser_resolvers`).
///
/// A wrong sub-path is not cosmetic: dropping Gemini's `.gemini` widens the root
/// by a whole level (to the bare home directory when `GEMINI_CLI_HOME` is the
/// home dir), and omitting a key narrows it so the agent's real directory is
/// rejected again.
fn agent_root_slots(agent_type: AgentType) -> &'static [RootSlot] {
    match agent_type {
        AgentType::Grok => &[RootSlot {
            candidates: &[("GROK_HOME", "", VERBATIM)],
            trims: false,
            default_rel: &[".grok"],
        }],
        // Qoder relocates its whole home via `QODER_CONFIG_DIR` (the env form
        // of the CLI's `--config-dir`); the sessions tree lives under
        // `projects/` inside it.
        AgentType::Qoder => &[RootSlot {
            candidates: &[("QODER_CONFIG_DIR", "", VERBATIM)],
            trims: false,
            default_rel: &[".qoder"],
        }],
        // Antigravity's whole tree hangs off `GEMINI_HOME`, which — unlike
        // Gemini CLI's `GEMINI_CLI_HOME` above — names the `.gemini` directory
        // ITSELF rather than its parent, so nothing is joined onto it. The
        // server's settings, conversations, skills and OAuth tokens all live
        // under it (`acp_server/paths.py`).
        AgentType::Antigravity => &[RootSlot {
            candidates: &[("GEMINI_HOME", "", EXPANDS_TILDE)],
            trims: false,
            default_rel: &[".gemini"],
        }],
        AgentType::ClaudeCode => &[RootSlot {
            candidates: &[("CLAUDE_CONFIG_DIR", "", VERBATIM)],
            trims: false,
            default_rel: &[".claude"],
        }],
        AgentType::Codex => &[RootSlot {
            candidates: &[("CODEX_HOME", "", VERBATIM)],
            trims: false,
            default_rel: &[".codex"],
        }],
        // `resolve_gemini_base_dir_from` joins `.gemini` onto GEMINI_CLI_HOME.
        AgentType::Gemini => &[RootSlot {
            candidates: &[("GEMINI_CLI_HOME", ".gemini", VERBATIM)],
            trims: false,
            default_rel: &[".gemini"],
        }],
        AgentType::CodeBuddy => &[RootSlot {
            candidates: &[("CODEBUDDY_CONFIG_DIR", "", VERBATIM)],
            trims: false,
            default_rel: &[".codebuddy"],
        }],
        AgentType::KimiCode => &[RootSlot {
            candidates: &[("KIMI_CODE_HOME", "", VERBATIM)],
            trims: false,
            default_rel: &[".kimi-code"],
        }],
        // `resolve_cursor_config_from` prefers CURSOR_CONFIG_DIR verbatim and
        // only then `<XDG_CONFIG_HOME>/cursor` — order matters.
        AgentType::Cursor => &[RootSlot {
            candidates: &[("CURSOR_CONFIG_DIR", "", VERBATIM), ("XDG_CONFIG_HOME", "cursor", VERBATIM)],
            trims: false,
            default_rel: &[".cursor"],
        }],
        AgentType::Hermes => &[RootSlot {
            candidates: &[("HERMES_HOME", "", VERBATIM)],
            trims: true,
            default_rel: &[".hermes"],
        }],
        // `resolve_opencode_base_dir` is `<XDG_DATA_HOME>/opencode`.
        AgentType::OpenCode => &[RootSlot {
            candidates: &[("XDG_DATA_HOME", "opencode", VERBATIM)],
            trims: false,
            default_rel: &[".local", "share", "opencode"],
        }],
        AgentType::Cline => &[RootSlot {
            candidates: &[("CLINE_DIR", "", VERBATIM)],
            trims: true,
            default_rel: &[".cline", "data"],
        }],
        AgentType::OpenClaw => &[RootSlot {
            candidates: &[],
            trims: false,
            default_rel: &[".openclaw"],
        }],
        // DeepSeek Harness mirrors pi's two-root shape: the harness home
        // (`DSH_HOME`, default `~/.dsh`) and the session-log root, which
        // relocates independently via `DEEPSEEK_ACP_SESSIONS_ROOT` (else
        // `$DSH_HOME/sessions`) — see `resolve_deepseek_sessions_root_from`.
        AgentType::DeepSeek => &[
            RootSlot {
                candidates: &[("DSH_HOME", "", EXPANDS_TILDE)],
                trims: false,
                default_rel: &[".dsh"],
            },
            RootSlot {
                candidates: &[
                    // The sessions override is taken as a bare path;
                    // the DSH_HOME fallback routes through
                    // `resolve_dsh_home_from`, which expands.
                    ("DEEPSEEK_ACP_SESSIONS_ROOT", "", VERBATIM),
                    ("DSH_HOME", "sessions", EXPANDS_TILDE),
                ],
                trims: false,
                default_rel: &[".dsh", "sessions"],
            },
        ],
        // pi's agent home and its session store relocate INDEPENDENTLY, so both
        // are genuine roots rather than alternatives. The sessions slot mirrors
        // `resolve_pi_sessions_dir_from`: the session override wins, else
        // `<agent dir>/sessions`, else `~/.pi/agent/sessions`.
        AgentType::Pi => &[
            RootSlot {
                candidates: &[("PI_CODING_AGENT_DIR", "", VERBATIM)],
                trims: false,
                default_rel: &[".pi", "agent"],
            },
            RootSlot {
                candidates: &[
                    ("PI_CODING_AGENT_SESSION_DIR", "", VERBATIM),
                    ("PI_CODING_AGENT_DIR", "sessions", VERBATIM),
                ],
                trims: false,
                default_rel: &[".pi", "agent", "sessions"],
            },
        ],
        // A custom ACP agent has no codeg-known private directory layout —
        // codeg never reads its store (history comes from codeg's own ACP
        // transcript), so there is nothing to widen the sandbox roots for.
        AgentType::Custom(_) => &[],
    }
}

/// Absolutize + canonicalize a configured root. Falls back to the absolutized
/// raw path when the directory does not exist yet (a non-existent root simply
/// never matches, which is the correct outcome).
fn canonical_root(root: &Path) -> PathBuf {
    let absolute = if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(root)
    };
    std::fs::canonicalize(&absolute).unwrap_or(absolute)
}

#[derive(Clone)]
pub struct FileSystemRuntime {
    policy: Arc<FsAccessPolicy>,
    io_semaphore: Arc<Semaphore>,
}

impl FileSystemRuntime {
    /// Confine both directions to `workspace_root`. Kept as the `new` shape
    /// because that is what the historical constructor meant; production goes
    /// through `with_policy`.
    pub fn new(workspace_root: PathBuf) -> Self {
        Self::with_policy(FsAccessPolicy::strict(&workspace_root))
    }

    pub fn with_policy(policy: FsAccessPolicy) -> Self {
        Self {
            policy: Arc::new(policy),
            io_semaphore: Arc::new(Semaphore::new(FS_MAX_CONCURRENT_OPS)),
        }
    }

    pub async fn read_text_file(
        &self,
        request: ReadTextFileRequest,
    ) -> Result<ReadTextFileResponse, FileSystemRuntimeError> {
        if !request.path.is_absolute() {
            return Err(FileSystemRuntimeError::InvalidParams(
                "fs/read_text_file requires an absolute path".to_string(),
            ));
        }
        if matches!(request.line, Some(0)) {
            return Err(FileSystemRuntimeError::InvalidParams(
                "fs/read_text_file line must be >= 1".to_string(),
            ));
        }

        let _permit = self
            .io_semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| {
                FileSystemRuntimeError::Internal("filesystem runtime closed".to_string())
            })?;

        let policy = self.policy.clone();
        let path = request.path;
        let line = request.line;
        let limit = request.limit;
        let started_at = Instant::now();
        let path_for_log = path.clone();

        let response = run_blocking_with_timeout("fs/read_text_file", move || {
            read_text_file_impl(&path, line, limit, &policy.read_roots)
                .map(ReadTextFileResponse::new)
        })
        .await;

        log_if_slow("fs/read_text_file", &path_for_log, started_at);
        response
    }

    pub async fn write_text_file(
        &self,
        request: WriteTextFileRequest,
    ) -> Result<WriteTextFileResponse, FileSystemRuntimeError> {
        if !request.path.is_absolute() {
            return Err(FileSystemRuntimeError::InvalidParams(
                "fs/write_text_file requires an absolute path".to_string(),
            ));
        }
        if request.content.len() > FS_MAX_WRITE_BYTES {
            return Err(FileSystemRuntimeError::InvalidParams(format!(
                "write payload too large ({} bytes, limit {} bytes)",
                request.content.len(),
                FS_MAX_WRITE_BYTES
            )));
        }

        let _permit = self
            .io_semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| {
                FileSystemRuntimeError::Internal("filesystem runtime closed".to_string())
            })?;

        let policy = self.policy.clone();
        let path = request.path;
        let content = request.content;
        let started_at = Instant::now();
        let path_for_log = path.clone();

        let response = run_blocking_with_timeout("fs/write_text_file", move || {
            ensure_path_allowed(&path, &policy.write_roots, true)?;
            atomic_write_text(&path, content.as_bytes())?;
            Ok(WriteTextFileResponse::new())
        })
        .await;

        log_if_slow("fs/write_text_file", &path_for_log, started_at);
        response
    }
}

async fn run_blocking_with_timeout<T, F>(
    operation: &'static str,
    f: F,
) -> Result<T, FileSystemRuntimeError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, FileSystemRuntimeError> + Send + 'static,
{
    let task = tokio::task::spawn_blocking(f);
    let join_result = tokio::time::timeout(FS_IO_TIMEOUT, task)
        .await
        .map_err(|_| {
            FileSystemRuntimeError::Internal(format!(
                "{operation} timed out after {}s",
                FS_IO_TIMEOUT.as_secs()
            ))
        })?;

    let op_result = join_result.map_err(|err| {
        FileSystemRuntimeError::Internal(format!("{operation} worker failed: {err}"))
    })?;

    op_result
}

fn read_text_file_impl(
    path: &Path,
    line: Option<u32>,
    limit: Option<u32>,
    read_roots: &[PathBuf],
) -> Result<String, FileSystemRuntimeError> {
    ensure_path_allowed(path, read_roots, false)?;

    let metadata = std::fs::metadata(path).map_err(|err| map_io_error("read", path, err))?;
    if metadata.len() > FS_MAX_FILE_SIZE_BYTES {
        return Err(FileSystemRuntimeError::InvalidParams(format!(
            "file too large for fs/read_text_file ({} bytes, limit {} bytes)",
            metadata.len(),
            FS_MAX_FILE_SIZE_BYTES
        )));
    }

    let file = File::open(path).map_err(|err| map_io_error("read", path, err))?;
    let mut reader = BufReader::new(file);

    let start_line = usize::try_from(line.unwrap_or(1)).unwrap_or(usize::MAX);
    let max_lines = limit.map(|v| usize::try_from(v).unwrap_or(usize::MAX));

    let mut current_line = 1usize;
    let mut taken = 0usize;
    let mut out = String::with_capacity(
        usize::try_from(metadata.len())
            .unwrap_or(FS_MAX_READ_RESPONSE_BYTES)
            .min(FS_MAX_READ_RESPONSE_BYTES),
    );
    let mut line_buf = String::new();

    loop {
        line_buf.clear();
        let bytes_read = reader
            .read_line(&mut line_buf)
            .map_err(|err| map_io_error("read", path, err))?;
        if bytes_read == 0 {
            break;
        }

        if current_line >= start_line {
            if let Some(max) = max_lines {
                if taken >= max {
                    break;
                }
            }

            if out.len().saturating_add(line_buf.len()) > FS_MAX_READ_RESPONSE_BYTES {
                return Err(FileSystemRuntimeError::InvalidParams(format!(
                    "read result too large (limit {} bytes). Narrow with line/limit.",
                    FS_MAX_READ_RESPONSE_BYTES
                )));
            }

            out.push_str(&line_buf);
            taken += 1;
        }

        current_line = current_line.saturating_add(1);
    }

    Ok(out)
}

fn atomic_write_text(path: &Path, bytes: &[u8]) -> Result<(), FileSystemRuntimeError> {
    let parent = path.parent().ok_or_else(|| {
        FileSystemRuntimeError::InvalidParams(format!(
            "cannot determine parent directory for path: {}",
            path.display()
        ))
    })?;

    if !parent.exists() {
        return Err(FileSystemRuntimeError::InvalidParams(format!(
            "parent directory does not exist: {}",
            parent.display()
        )));
    }

    let temp_path = parent.join(format!(
        ".codeg-fs-{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));

    let existing_permissions = std::fs::metadata(path).ok().map(|m| m.permissions());

    let write_result = (|| {
        let mut tmp = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|err| map_io_error("create temporary file", &temp_path, err))?;

        tmp.write_all(bytes)
            .map_err(|err| map_io_error("write", &temp_path, err))?;
        tmp.sync_all()
            .map_err(|err| map_io_error("flush", &temp_path, err))?;

        if let Some(permissions) = existing_permissions {
            std::fs::set_permissions(&temp_path, permissions)
                .map_err(|err| map_io_error("set permissions", &temp_path, err))?;
        }

        replace_file(&temp_path, path)?;
        sync_directory(parent)?;

        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }

    write_result
}

#[cfg(unix)]
fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), FileSystemRuntimeError> {
    std::fs::rename(temp_path, target_path).map_err(|err| map_io_error("replace", target_path, err))
}

#[cfg(target_os = "windows")]
fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), FileSystemRuntimeError> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    fn to_wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let src = to_wide(temp_path);
    let dst = to_wide(target_path);

    // SAFETY: pointers are valid, null-terminated UTF-16 buffers alive for the call.
    let ok = unsafe {
        MoveFileExW(
            src.as_ptr(),
            dst.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };

    if ok == 0 {
        let err = std::io::Error::last_os_error();
        return Err(map_io_error("atomically replace", target_path, err));
    }

    Ok(())
}

#[cfg(not(any(unix, target_os = "windows")))]
fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), FileSystemRuntimeError> {
    std::fs::rename(temp_path, target_path).map_err(|err| map_io_error("replace", target_path, err))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), FileSystemRuntimeError> {
    let dir = File::open(path).map_err(|err| map_io_error("sync directory", path, err))?;
    dir.sync_all()
        .map_err(|err| map_io_error("sync directory", path, err))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), FileSystemRuntimeError> {
    Ok(())
}

/// Gate a path against a root list. An EMPTY list means unrestricted — and it
/// short-circuits BEFORE canonicalizing, so an unrestricted read reports the
/// natural `NotFound` from the open() below rather than a containment error.
///
/// Containment is checked on the CANONICAL target (`canonical_target_path`
/// resolves the parent for not-yet-existing writes), which is what makes this
/// symlink-safe. `Path::starts_with` compares whole components, so root
/// `/foo/bar` does not admit `/foo/barbaz`.
fn ensure_path_allowed(
    path: &Path,
    roots: &[PathBuf],
    for_write: bool,
) -> Result<(), FileSystemRuntimeError> {
    if roots.is_empty() {
        return Ok(());
    }

    let target = canonical_target_path(path, for_write)?;
    if roots.iter().any(|root| target.starts_with(root)) {
        return Ok(());
    }

    let direction = if for_write { "write" } else { "read" };
    Err(FileSystemRuntimeError::InvalidParams(format!(
        "path is outside the allowed {direction} roots: {} \
         (widen with {FS_EXTRA_ROOTS_ENV}, or set {FS_POLICY_ENV}=unrestricted)",
        path.display()
    )))
}

fn canonical_target_path(path: &Path, for_write: bool) -> Result<PathBuf, FileSystemRuntimeError> {
    if !for_write || path.exists() {
        return std::fs::canonicalize(path).map_err(|err| map_io_error("access", path, err));
    }

    let parent = path.parent().ok_or_else(|| {
        FileSystemRuntimeError::InvalidParams(format!(
            "cannot determine parent directory for path: {}",
            path.display()
        ))
    })?;

    if !parent.exists() {
        return Err(FileSystemRuntimeError::InvalidParams(format!(
            "parent directory does not exist: {}",
            parent.display()
        )));
    }

    std::fs::canonicalize(parent).map_err(|err| map_io_error("access", parent, err))
}

fn map_io_error(action: &str, path: &Path, err: std::io::Error) -> FileSystemRuntimeError {
    match err.kind() {
        ErrorKind::NotFound
        | ErrorKind::PermissionDenied
        | ErrorKind::InvalidInput
        | ErrorKind::InvalidData => FileSystemRuntimeError::InvalidParams(format!(
            "failed to {action} {}: {err}",
            path.display()
        )),
        _ => FileSystemRuntimeError::Internal(format!(
            "failed to {action} {}: {err}",
            path.display()
        )),
    }
}

fn log_if_slow(operation: &str, path: &Path, started_at: Instant) {
    let elapsed = started_at.elapsed();
    if elapsed.as_millis() >= FS_SLOW_OPERATION_MS {
        tracing::info!(
            "[ACP] {operation} slow path={} elapsed_ms={}",
            path.display(),
            elapsed.as_millis()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_workspace() -> PathBuf {
        let path = std::env::temp_dir().join(format!("codeg-fs-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create test workspace");
        path
    }

    /// Drive prefix that makes a rooted path ABSOLUTE on this platform. On
    /// Windows `\tmp\x` is rooted but not absolute (it is relative to the
    /// current drive), so a literal unix path would be dropped by the very
    /// relative-path guards these tests exercise.
    #[cfg(windows)]
    const ABS_PREFIX: &str = "C:";
    #[cfg(not(windows))]
    const ABS_PREFIX: &str = "";

    /// An absolute path for the HOST platform, built from unix-style segments.
    /// `absolute_path("")` is the filesystem root itself (`/`, or `C:/`).
    ///
    /// None of these paths are ever opened — they only have to be absolute, so
    /// the synthetic drive letter needs no counterpart on disk.
    fn absolute_path(segments: &str) -> PathBuf {
        PathBuf::from(format!("{ABS_PREFIX}/{segments}"))
    }

    #[tokio::test(flavor = "current_thread")]
    async fn read_honors_line_and_limit() {
        let workspace = temp_workspace();
        let file = workspace.join("sample.txt");
        fs::write(&file, "a\nb\nc\nd\n").expect("write file");

        let runtime = FileSystemRuntime::new(workspace.clone());
        let response = runtime
            .read_text_file(ReadTextFileRequest::new("sid", &file).line(2).limit(2))
            .await
            .expect("read file");

        assert_eq!(response.content, "b\nc\n");

        let _ = fs::remove_dir_all(workspace);
    }

    /// The default policy's shape, pinned to an explicit root list so the
    /// assertions don't depend on where this machine's temp dir / HOME live.
    fn reads_open_writes_confined_to(workspace: &Path) -> FsAccessPolicy {
        FsAccessPolicy {
            read_roots: Vec::new(),
            write_roots: vec![canonical_root(workspace)],
        }
    }

    fn invalid_params(error: FileSystemRuntimeError) -> String {
        match error {
            FileSystemRuntimeError::InvalidParams(message) => message,
            other => panic!("expected InvalidParams, got: {other:?}"),
        }
    }

    /// `strict` is the historical behavior — keep a regression net on it, since
    /// it is what `CODEG_ACP_FS_POLICY=strict` promises to restore.
    #[tokio::test(flavor = "current_thread")]
    async fn strict_rejects_read_and_write_outside_workspace() {
        let workspace = temp_workspace();
        let outside = std::env::temp_dir().join(format!("outside-{}.txt", uuid::Uuid::new_v4()));
        fs::write(&outside, "x").expect("write outside file");

        let runtime = FileSystemRuntime::with_policy(FsAccessPolicy::strict(&workspace));

        let read_err = invalid_params(
            runtime
                .read_text_file(ReadTextFileRequest::new("sid", &outside))
                .await
                .expect_err("strict should reject an outside read"),
        );
        assert!(
            read_err.contains("outside the allowed read roots"),
            "unexpected message: {read_err}"
        );

        let write_err = invalid_params(
            runtime
                .write_text_file(WriteTextFileRequest::new("sid", &outside, "nope"))
                .await
                .expect_err("strict should reject an outside write"),
        );
        assert!(
            write_err.contains("outside the allowed write roots"),
            "unexpected message: {write_err}"
        );
        assert_eq!(
            fs::read_to_string(&outside).expect("outside file survives"),
            "x",
            "a rejected write must not touch the file"
        );

        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(workspace);
    }

    /// The regression this whole change exists for: an agent reading its own
    /// out-of-workspace state (grok's `<GROK_HOME>/skills/*/SKILL.md`,
    /// attachment images under the temp dir) must succeed by default.
    #[tokio::test(flavor = "current_thread")]
    async fn default_allows_read_outside_workspace() {
        let workspace = temp_workspace();
        let outside = std::env::temp_dir().join(format!("outside-{}.txt", uuid::Uuid::new_v4()));
        fs::write(&outside, "agent-owned\n").expect("write outside file");

        let runtime = FileSystemRuntime::with_policy(reads_open_writes_confined_to(&workspace));
        let response = runtime
            .read_text_file(ReadTextFileRequest::new("sid", &outside))
            .await
            .expect("outside read should be allowed");
        assert_eq!(response.content, "agent-owned\n");

        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(workspace);
    }

    /// Unrestricted reads must still surface a real missing file as such, not as
    /// a containment error (the gate short-circuits before canonicalizing).
    #[tokio::test(flavor = "current_thread")]
    async fn unrestricted_read_reports_missing_file_naturally() {
        let workspace = temp_workspace();
        let missing = workspace.join("nope.txt");

        let runtime = FileSystemRuntime::with_policy(reads_open_writes_confined_to(&workspace));
        let message = invalid_params(
            runtime
                .read_text_file(ReadTextFileRequest::new("sid", &missing))
                .await
                .expect_err("missing file should error"),
        );
        assert!(
            message.contains("failed to read") && !message.contains("allowed read roots"),
            "unexpected message: {message}"
        );

        let _ = fs::remove_dir_all(workspace);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn default_rejects_write_outside_every_root() {
        let workspace = temp_workspace();
        let other = temp_workspace();
        let target = other.join("stray.txt");

        let runtime = FileSystemRuntime::with_policy(reads_open_writes_confined_to(&workspace));
        let message = invalid_params(
            runtime
                .write_text_file(WriteTextFileRequest::new("sid", &target, "stray"))
                .await
                .expect_err("write outside every root should be rejected"),
        );
        assert!(
            message.contains("outside the allowed write roots")
                && message.contains(FS_EXTRA_ROOTS_ENV),
            "message should name the widening knob: {message}"
        );
        assert!(!target.exists(), "rejected write must not create the file");

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(other);
    }

    /// A symlink inside the workspace pointing out of it must not become a
    /// write tunnel: containment is checked on the canonicalized parent.
    #[cfg(unix)]
    #[tokio::test(flavor = "current_thread")]
    async fn rejects_symlink_escape_on_write() {
        let workspace = temp_workspace();
        let outside = temp_workspace();
        let link = workspace.join("escape");
        std::os::unix::fs::symlink(&outside, &link).expect("create symlink");

        let runtime = FileSystemRuntime::with_policy(reads_open_writes_confined_to(&workspace));
        let message = invalid_params(
            runtime
                .write_text_file(WriteTextFileRequest::new(
                    "sid",
                    link.join("pwned.txt"),
                    "pwned",
                ))
                .await
                .expect_err("symlink escape should be rejected"),
        );
        assert!(
            message.contains("outside the allowed write roots"),
            "unexpected message: {message}"
        );
        assert!(!outside.join("pwned.txt").exists(), "escape must not write");

        let _ = fs::remove_file(link);
        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unrestricted_policy_writes_anywhere() {
        let workspace = temp_workspace();
        let elsewhere = temp_workspace();
        let target = elsewhere.join("free.txt");

        let runtime = FileSystemRuntime::with_policy(FsAccessPolicy::unrestricted());
        runtime
            .write_text_file(WriteTextFileRequest::new("sid", &target, "free"))
            .await
            .expect("unrestricted write should succeed");
        assert_eq!(fs::read_to_string(&target).expect("read back"), "free");

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(elsewhere);
    }

    #[test]
    fn permissive_write_roots_include_workspace_agent_home_and_temp() {
        let workspace = temp_workspace();
        let policy = FsAccessPolicy::permissive(&workspace, AgentType::Grok, &BTreeMap::new());

        assert!(
            policy.read_roots.is_empty(),
            "default reads must be unrestricted"
        );
        for expected in [
            canonical_root(&workspace),
            canonical_root(&crate::parsers::grok::resolve_grok_home_dir()),
            canonical_root(&std::env::temp_dir()),
        ] {
            assert!(
                policy.write_roots.contains(&expected),
                "missing write root {}: {:?}",
                expected.display(),
                policy.write_roots
            );
        }

        let _ = fs::remove_dir_all(workspace);
    }

    /// The reported regression, reproduced in its exact shape: grok's plan mode
    /// writes `<GROK_HOME>/sessions/<encoded-cwd>/<sid>/plan.md`, which is by
    /// design outside the workspace. Before this policy existed the write was
    /// refused and grok fell back to shelling out a `cat > … << 'PLAN_EOF'`
    /// heredoc — so this asserts the delegated write now simply lands.
    #[tokio::test(flavor = "current_thread")]
    async fn permissive_policy_writes_agent_plan_file_outside_workspace() {
        let workspace = temp_workspace();
        let grok_home = temp_workspace();
        let session_dir = grok_home
            .join("sessions")
            .join("%2FUsers%2Fme%2Fwork%2Fmy-app")
            .join("019f9517-cbde-7f63-ae52-d04fa96b4b6b");
        fs::create_dir_all(&session_dir).expect("create grok session dir");
        let plan = session_dir.join("plan.md");

        let runtime_env = BTreeMap::from([(
            "GROK_HOME".to_string(),
            grok_home.to_string_lossy().to_string(),
        )]);
        let runtime = FileSystemRuntime::with_policy(FsAccessPolicy::permissive(
            &workspace,
            AgentType::Grok,
            &runtime_env,
        ));

        runtime
            .write_text_file(WriteTextFileRequest::new("sid", &plan, "# Plan\n"))
            .await
            .expect("grok must be able to write its own plan file");
        assert_eq!(fs::read_to_string(&plan).expect("read back"), "# Plan\n");

        // …and read it back, which is how grok fetches the plan body after the
        // user approves `exit_plan_mode`.
        let response = runtime
            .read_text_file(ReadTextFileRequest::new("sid", &plan))
            .await
            .expect("grok must be able to read its own plan file back");
        assert_eq!(response.content, "# Plan\n");

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(grok_home);
    }

    /// End-to-end on the REAL default policy, which is what catches root
    /// canonicalization mismatches: on macOS the temp dir is handed to us as
    /// `/var/folders/…` but canonicalizes to `/private/var/folders/…`, and the
    /// rejected attachment paths in the bug report were the `/private/…` form.
    /// A raw `starts_with` against the un-canonicalized root would fail here.
    #[tokio::test(flavor = "current_thread")]
    async fn permissive_policy_writes_into_temp_dir() {
        let workspace = temp_workspace();
        let elsewhere_in_temp = temp_workspace();
        let target = elsewhere_in_temp.join("attachment.txt");

        let runtime = FileSystemRuntime::with_policy(FsAccessPolicy::permissive(
            &workspace,
            AgentType::Grok,
            &BTreeMap::new(),
        ));
        runtime
            .write_text_file(WriteTextFileRequest::new("sid", &target, "payload"))
            .await
            .expect("temp dir should be writable under the default policy");
        assert_eq!(fs::read_to_string(&target).expect("read back"), "payload");

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(elsewhere_in_temp);
    }

    #[test]
    fn extra_roots_env_adds_writable_roots() {
        let workspace = temp_workspace();
        let extra_a = temp_workspace();
        let extra_b = temp_workspace();
        let joined = std::env::join_paths([&extra_a, &extra_b]).expect("join paths");

        let runtime_env = BTreeMap::from([(
            FS_EXTRA_ROOTS_ENV.to_string(),
            joined.to_string_lossy().to_string(),
        )]);
        let policy = FsAccessPolicy::permissive(&workspace, AgentType::Grok, &runtime_env);

        for extra in [&extra_a, &extra_b] {
            assert!(
                policy.write_roots.contains(&canonical_root(extra)),
                "extra root {} not honored",
                extra.display()
            );
        }

        for dir in [workspace, extra_a, extra_b] {
            let _ = fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn policy_from_env_reads_runtime_env_first() {
        let workspace = temp_workspace();
        let policy_for = |value: &str| {
            FsAccessPolicy::from_env(
                &workspace,
                AgentType::Grok,
                &BTreeMap::from([(FS_POLICY_ENV.to_string(), value.to_string())]),
            )
        };

        let strict = policy_for("strict");
        assert_eq!(strict.read_roots, vec![canonical_root(&workspace)]);
        assert_eq!(strict.write_roots, vec![canonical_root(&workspace)]);

        let unrestricted = policy_for("unrestricted");
        assert!(unrestricted.read_roots.is_empty());
        assert!(unrestricted.write_roots.is_empty());

        // An unrecognized value must degrade to the default, never to a
        // fail-open or fail-closed surprise.
        for value in ["default", "totally-bogus"] {
            let fallback = policy_for(value);
            assert!(fallback.read_roots.is_empty(), "{value}: reads open");
            assert!(
                fallback.write_roots.contains(&canonical_root(&workspace)),
                "{value}: workspace writable"
            );
        }

        let _ = fs::remove_dir_all(workspace);
    }

    /// A per-agent home relocation must move the allowed root with it, or the
    /// agent's own state directory falls outside the policy again.
    ///
    /// Only the keys whose value IS the data root verbatim belong here; the ones
    /// their resolver appends a sub-path to (Gemini, OpenCode, Cursor's XDG
    /// fallback) are covered by `relocation_suffixes_match_the_agents_own_resolvers`.
    #[test]
    fn agent_data_roots_honor_runtime_env_relocation() {
        let relocated = absolute_path("tmp/codeg-relocated-agent-home");
        let cases = [
            (AgentType::Grok, "GROK_HOME"),
            (AgentType::ClaudeCode, "CLAUDE_CONFIG_DIR"),
            (AgentType::Codex, "CODEX_HOME"),
            (AgentType::CodeBuddy, "CODEBUDDY_CONFIG_DIR"),
            (AgentType::KimiCode, "KIMI_CODE_HOME"),
            (AgentType::Cursor, "CURSOR_CONFIG_DIR"),
            (AgentType::Hermes, "HERMES_HOME"),
            (AgentType::Cline, "CLINE_DIR"),
            (AgentType::Pi, "PI_CODING_AGENT_DIR"),
        ];

        for (agent_type, key) in cases {
            let runtime_env =
                BTreeMap::from([(key.to_string(), relocated.to_string_lossy().to_string())]);
            let roots = agent_data_roots(agent_type, &runtime_env);
            assert!(
                roots.contains(&relocated),
                "{agent_type:?}: {key} not honored, got {roots:?}"
            );
        }
    }

    /// Each agent's relocation key must land on the SAME directory its own
    /// resolver would compute for that value — not one level above it. Getting
    /// Gemini's `.gemini` suffix wrong would make the bare relocation target
    /// writable, which for `GEMINI_CLI_HOME=$HOME` is the whole home directory.
    #[test]
    fn relocation_suffixes_match_the_agents_own_resolvers() {
        let base = absolute_path("tmp/codeg-relocation-base");
        let cases = [
            (AgentType::Gemini, "GEMINI_CLI_HOME", ".gemini"),
            (AgentType::OpenCode, "XDG_DATA_HOME", "opencode"),
            (AgentType::Cursor, "XDG_CONFIG_HOME", "cursor"),
        ];

        for (agent_type, key, suffix) in cases {
            let runtime_env =
                BTreeMap::from([(key.to_string(), base.to_string_lossy().to_string())]);
            let roots = agent_data_roots(agent_type, &runtime_env);

            assert!(
                roots.contains(&base.join(suffix)),
                "{agent_type:?}: expected {key} to resolve to <value>/{suffix}, got {roots:?}"
            );
            assert!(
                !roots.contains(&base),
                "{agent_type:?}: the bare {key} value must NOT become a root \
                 (that widens it by a level): {roots:?}"
            );
        }
    }

    /// For the agents whose own resolver takes the value verbatim, `~` must NOT
    /// be expanded: they treat it literally, so expanding here would hand out
    /// `$HOME` as a writable root the user never selected. Hermes' contract is
    /// the explicit one — `get_hermes_home` is `Path(val.strip())`, no
    /// `expanduser`, which `commands::acp::hermes_home_for_launch` mirrors — and
    /// a BLANK value falls back to `~/.hermes` rather than re-inheriting the
    /// parent.
    ///
    /// The agents that DO expand are covered by
    /// `relocation_expands_tilde_only_for_the_agents_that_do`; the rule is
    /// per-candidate, not global.
    #[test]
    fn relocation_never_expands_tilde_into_home() {
        let home = dirs::home_dir().expect("home dir");
        let cases = [
            (AgentType::Grok, "GROK_HOME"),
            (AgentType::Codex, "CODEX_HOME"),
            (AgentType::ClaudeCode, "CLAUDE_CONFIG_DIR"),
            (AgentType::Hermes, "HERMES_HOME"),
            (AgentType::Pi, "PI_CODING_AGENT_DIR"),
        ];

        for (agent_type, key) in cases {
            // Pi's sessions slot has a second candidate that could be satisfied
            // from this machine's environment; skip when that applies.
            if agent_relocated_by_process_env(agent_type) {
                continue;
            }
            let runtime_env = BTreeMap::from([(key.to_string(), "~".to_string())]);
            let roots = agent_data_roots(agent_type, &runtime_env);

            // The security property: `~` is never expanded into the home dir.
            assert!(
                !roots.contains(&home),
                "{agent_type:?}: {key}=~ must not add $HOME as a root, got {roots:?}"
            );
            // A bare `~` is a RELATIVE path, so the slot yields NO root — not the
            // inactive default either, since the child really does use the value
            // it was given (see `relative_agent_root_is_refused_not_absolutized`).
            assert!(
                roots.is_empty(),
                "{agent_type:?}: {key}=~ should yield no root at all, got {roots:?}"
            );
        }
    }

    /// A `~` follows the CHILD's home, not codeg's.
    ///
    /// `merge_agent_env` copies `HOME` into the child like any other variable,
    /// and overriding it is the standard way to isolate a CLI's config — so
    /// `HOME=/srv/agy GEMINI_HOME=~/profile` means `/srv/agy/profile` to the
    /// server's own `expanduser` and nothing else. Expanding against
    /// `dirs::home_dir()` authorized a directory the agent never opens while
    /// leaving the one it does use unwritable. The `default_rel` branch already
    /// went through `child_home_dir`; this makes the override branch agree.
    #[test]
    fn tilde_expands_against_the_childs_home_not_codegs() {
        let codeg_home = dirs::home_dir().expect("home dir");
        // Platform-native: `child_home_dir` refuses a relative home, and a
        // unix-style `/srv/agy` is NOT absolute on Windows (no drive prefix),
        // so a shared literal would make this pass on unix and fail in the
        // Windows server CI cell, which runs these lib tests for real.
        let (home_key, child_home) = CHILD_HOME_FIXTURE;

        let runtime_env = BTreeMap::from([
            (home_key.to_string(), child_home.to_string()),
            ("GEMINI_HOME".to_string(), "~/profile".to_string()),
        ]);
        let roots = agent_data_roots(AgentType::Antigravity, &runtime_env);
        assert!(
            roots.contains(&PathBuf::from(child_home).join("profile")),
            "the child's own home must anchor the expansion, got {roots:?}"
        );
        assert!(
            !roots.contains(&codeg_home.join("profile")),
            "codeg's home must not: {roots:?}"
        );
    }

    /// The over-broad guard has to judge the CANONICAL root, because that is
    /// what the policy stores and compares against.
    ///
    /// A syntactic check is trivially bypassable: `~/work/..` is not `$HOME` as
    /// written but canonicalizes to exactly it, and `FsAccessPolicy::permissive`
    /// canonicalizes every root before storing it — so the agent would have been
    /// handed write access to the whole home, and with it every other agent's
    /// credentials.
    #[test]
    fn an_over_broad_root_is_refused_after_canonicalization() {
        let home = dirs::home_dir().expect("home dir");
        if agent_relocated_by_process_env(AgentType::Antigravity) {
            return;
        }
        // Needs a directory that really exists, since `canonicalize` is what
        // collapses the `..` — a non-existent path stays syntactic.
        let existing = std::fs::read_dir(&home)
            .expect("readable home")
            .flatten()
            .find(|e| e.path().is_dir() && !e.path().is_symlink())
            .map(|e| e.file_name().to_string_lossy().into_owned());
        let Some(subdir) = existing else {
            return; // no real subdirectory to build the alias from
        };

        for value in [format!("~/{subdir}/.."), format!("{}/{subdir}/..", home.display())] {
            let runtime_env = BTreeMap::from([("GEMINI_HOME".to_string(), value.clone())]);
            let roots = agent_data_roots(AgentType::Antigravity, &runtime_env);
            for root in &roots {
                assert_ne!(
                    canonical_root(root),
                    canonical_root(&home),
                    "{value} aliases the home directory and must be refused, got {roots:?}"
                );
            }
        }
    }

    /// The other half of the rule: Antigravity and DeepSeek DO expand, so their
    /// relocated tree has to be authorized under the expanded path.
    ///
    /// Both upstreams run the equivalent of `expanduser` on their home variable
    /// (`acp_server/paths.py`; `dsh-home-paths`' `expandHomePath`), so with
    /// `GEMINI_HOME=~/relocated` the agent's files really are at
    /// `$HOME/relocated`. Treating the value verbatim judged it RELATIVE and
    /// refused the slot, which left the agent unable to write its own directory
    /// — while codeg, separately, created a literal `~` folder next to wherever
    /// it happened to be running.
    ///
    /// A BARE `~` is still refused. It is a legal setting that puts the tree
    /// directly in the home directory, but authorizing `$HOME` wholesale would
    /// make the containment gate meaningless and hand this agent every other
    /// agent's credentials.
    #[test]
    fn relocation_expands_tilde_only_for_the_agents_that_do() {
        let home = dirs::home_dir().expect("home dir");
        for (agent_type, key) in [
            (AgentType::Antigravity, "GEMINI_HOME"),
            (AgentType::DeepSeek, "DSH_HOME"),
        ] {
            if agent_relocated_by_process_env(agent_type) {
                continue;
            }

            let runtime_env = BTreeMap::from([(key.to_string(), "~/relocated".to_string())]);
            let roots = agent_data_roots(agent_type, &runtime_env);
            assert!(
                roots.contains(&home.join("relocated")),
                "{agent_type:?}: {key}=~/relocated must resolve to $HOME/relocated, got {roots:?}"
            );
            // And never as the literal, cwd-relative directory.
            assert!(
                !roots.iter().any(|r| r.starts_with("~")),
                "{agent_type:?}: a literal ~ survived into {roots:?}"
            );

            let bare = BTreeMap::from([(key.to_string(), "~".to_string())]);
            assert!(
                !agent_data_roots(agent_type, &bare).contains(&home),
                "{agent_type:?}: {key}=~ must not authorize the whole home directory"
            );
        }
    }

    /// A blank relocation value must fall back to Hermes' default home, not
    /// re-inherit codeg's process env — mirroring the launch contract.
    #[test]
    fn hermes_blank_relocation_falls_back_to_default_home() {
        let runtime_env = BTreeMap::from([("HERMES_HOME".to_string(), "   ".to_string())]);
        let roots = agent_data_roots(AgentType::Hermes, &runtime_env);
        let expected = dirs::home_dir().expect("home dir").join(".hermes");
        assert_eq!(roots, vec![expected]);
    }

    /// When `runtime_env` relocates a profile, `merge_agent_env` gives it the
    /// highest precedence so the child NEVER reads the process-env default. That
    /// inactive tree holds config and credentials, so it must not stay writable.
    #[test]
    fn relocation_excludes_the_inactive_default_root() {
        let relocated = absolute_path("tmp/codeg-isolated-profile");
        let cases = [
            (AgentType::Codex, "CODEX_HOME"),
            (AgentType::Grok, "GROK_HOME"),
            (AgentType::ClaudeCode, "CLAUDE_CONFIG_DIR"),
            (AgentType::Hermes, "HERMES_HOME"),
        ];

        for (agent_type, key) in cases {
            let runtime_env =
                BTreeMap::from([(key.to_string(), relocated.to_string_lossy().to_string())]);
            let roots = agent_data_roots(agent_type, &runtime_env);

            assert!(
                roots.contains(&relocated),
                "{agent_type:?}: relocated root missing, got {roots:?}"
            );
            for default_root in builtin_default_roots(agent_type) {
                assert!(
                    !roots.contains(&default_root),
                    "{agent_type:?}: inactive default {} must not stay writable, got {roots:?}",
                    default_root.display()
                );
            }
        }
    }

    /// Whether THIS machine's environment already relocates the agent (e.g. an
    /// exported `CODEX_HOME` / `XDG_DATA_HOME`). Such a relocation legitimately
    /// produces a root without ever consulting the home directory, so tests that
    /// assert "no root" for a broken home must skip these agents to stay
    /// deterministic across developer machines.
    fn agent_relocated_by_process_env(agent_type: AgentType) -> bool {
        agent_root_slots(agent_type)
            .iter()
            .flat_map(|slot| slot.candidates.iter())
            .any(|(key, _, _)| std::env::var_os(key).is_some())
    }

    /// Force every candidate key "absent for the child" (blank ⇒ `env_remove`)
    /// so the slots fall through to their home-relative defaults, independent of
    /// whatever this machine's environment happens to set.
    fn builtin_default_roots(agent_type: AgentType) -> Vec<PathBuf> {
        let blanked: BTreeMap<String, String> = agent_root_slots(agent_type)
            .iter()
            .flat_map(|slot| slot.candidates.iter())
            .map(|(key, _, _)| ((*key).to_string(), String::new()))
            .collect();
        agent_data_roots(agent_type, &blanked)
    }

    /// A BLANK value in `env_json` is not "unset, use ours" — the spawn layer
    /// (`acp::agent_process`) `env_remove`s it, so the child falls back to its
    /// OWN default. Reading through to codeg's process env would aim the root
    /// at a profile the child never opens, re-breaking the writes this change
    /// exists to allow.
    #[test]
    fn blank_runtime_value_falls_back_to_the_agents_default_not_our_env() {
        let home = dirs::home_dir().expect("home dir");

        // Deterministic regardless of this machine's env: blank short-circuits
        // before any process-env lookup.
        assert_eq!(
            agent_data_roots(
                AgentType::Codex,
                &BTreeMap::from([("CODEX_HOME".to_string(), String::new())])
            ),
            vec![home.join(".codex")]
        );
        assert_eq!(
            agent_data_roots(
                AgentType::Cursor,
                &BTreeMap::from([
                    ("CURSOR_CONFIG_DIR".to_string(), String::new()),
                    ("XDG_CONFIG_HOME".to_string(), String::new()),
                ])
            ),
            vec![home.join(".cursor")]
        );
        assert_eq!(
            agent_data_roots(
                AgentType::Pi,
                &BTreeMap::from([
                    ("PI_CODING_AGENT_DIR".to_string(), String::new()),
                    ("PI_CODING_AGENT_SESSION_DIR".to_string(), String::new()),
                ])
            ),
            vec![
                home.join(".pi").join("agent"),
                home.join(".pi").join("agent").join("sessions")
            ]
        );
    }

    /// A masked higher-precedence key must fall through to the NEXT candidate,
    /// not to the masked key's inherited value.
    #[test]
    fn blank_runtime_value_falls_through_to_the_next_candidate() {
        let xdg = absolute_path("tmp/codeg-xdg");
        let roots = agent_data_roots(
            AgentType::Cursor,
            &BTreeMap::from([
                ("CURSOR_CONFIG_DIR".to_string(), String::new()),
                (
                    "XDG_CONFIG_HOME".to_string(),
                    xdg.to_string_lossy().to_string(),
                ),
            ]),
        );
        assert_eq!(roots, vec![xdg.join("cursor")]);
    }

    /// `child_env_value` must distinguish the ways a var reaches (or fails to
    /// reach) the child, and must NOT normalize the value for resolvers that
    /// don't. Uses a private key so it cannot race another test.
    #[test]
    fn child_env_value_models_the_spawn_layers_env_remove() {
        let key = "CODEG_TEST_FS_CHILD_ENV";
        let os = OsString::from;

        temp_env::with_var(key, Some("/parent/value"), || {
            let runtime = |value: &str| BTreeMap::from([(key.to_string(), value.to_string())]);

            // Silent in runtime_env ⇒ the child inherits codeg's value.
            assert_eq!(
                child_env_value(&BTreeMap::new(), key, false),
                Some(os("/parent/value"))
            );
            // EXACTLY empty ⇒ `env_remove` ⇒ the child sees NOTHING, and we must
            // NOT read through to codeg's value.
            assert_eq!(child_env_value(&runtime(""), key, false), None);
            // Whitespace-only is NOT removed by the spawn layer — it reaches the
            // child verbatim, so a non-trimming resolver must see it verbatim.
            assert_eq!(child_env_value(&runtime("  "), key, false), Some(os("  ")));
            // …but IS unset for the resolvers that trim (Hermes, Cline).
            assert_eq!(child_env_value(&runtime("  "), key, true), None);
            // Non-empty replaces codeg's value, verbatim when not trimming.
            assert_eq!(
                child_env_value(&runtime(" /child/value "), key, false),
                Some(os(" /child/value "))
            );
            assert_eq!(
                child_env_value(&runtime(" /child/value "), key, true),
                Some(os("/child/value"))
            );
        });

        temp_env::with_var_unset(key, || {
            assert_eq!(child_env_value(&BTreeMap::new(), key, false), None);
        });
    }

    /// A RELATIVE agent home must never become a root. It would be resolved
    /// against codeg's cwd while the child runs in the workspace cwd, and that
    /// mismatch widens: `"."` with codeg launched from `/` yields `/`, which every
    /// absolute path passes `starts_with` against; `".."` grants an unrelated tree.
    #[test]
    fn relative_agent_root_is_refused_not_absolutized() {
        let workspace = temp_workspace();

        for value in [".", "..", "relative/sub", "./x"] {
            for (agent_type, key) in [
                (AgentType::Codex, "CODEX_HOME"),
                (AgentType::Grok, "GROK_HOME"),
                (AgentType::Hermes, "HERMES_HOME"),
                (AgentType::Pi, "PI_CODING_AGENT_DIR"),
            ] {
                let runtime_env = BTreeMap::from([(key.to_string(), value.to_string())]);
                let roots = agent_data_roots(agent_type, &runtime_env);

                assert!(
                    roots.iter().all(|root| root.is_absolute()),
                    "{agent_type:?}: {key}={value:?} produced a relative root: {roots:?}"
                );
                assert!(
                    roots.iter().all(|root| root != Path::new("/")),
                    "{agent_type:?}: {key}={value:?} must not admit /: {roots:?}"
                );
                // And it must NOT fall through to the inactive default: the child
                // received this value and uses it, so the default tree holds
                // config/credentials the session never opens.
                for inactive in builtin_default_roots(agent_type) {
                    assert!(
                        !roots.contains(&inactive),
                        "{agent_type:?}: {key}={value:?} leaked the inactive default {}: {roots:?}",
                        inactive.display()
                    );
                }

                // End-to-end: the gate must not gain a cwd-derived root either.
                let policy = FsAccessPolicy::permissive(&workspace, agent_type, &runtime_env);
                let cwd = std::env::current_dir().expect("cwd");
                assert!(
                    !policy.write_roots.contains(&PathBuf::from("/"))
                        && !policy.write_roots.contains(&cwd),
                    "{agent_type:?}: {key}={value:?} leaked a cwd-derived write root: {:?}",
                    policy.write_roots
                );
            }
        }

        let _ = fs::remove_dir_all(workspace);
    }

    /// `merge_agent_env` copies every `runtime_env` entry into the child, `HOME`
    /// included — the classic way to isolate a CLI's config. The home-relative
    /// defaults must therefore follow the CHILD's home: anchoring them on codeg's
    /// would grant the inactive profile and refuse the active one.
    #[cfg(not(windows))]
    #[test]
    fn home_relative_defaults_follow_the_childs_home() {
        let codeg_home = dirs::home_dir().expect("home dir");
        let isolated = PathBuf::from("/tmp/codeg-isolated-home");
        let runtime_env =
            BTreeMap::from([("HOME".to_string(), isolated.to_string_lossy().to_string())]);

        for (agent_type, rel) in [
            (AgentType::Codex, ".codex"),
            (AgentType::Grok, ".grok"),
            (AgentType::ClaudeCode, ".claude"),
        ] {
            let roots = agent_data_roots(agent_type, &runtime_env);
            assert!(
                roots.contains(&isolated.join(rel)),
                "{agent_type:?}: active root {} missing, got {roots:?}",
                isolated.join(rel).display()
            );
            assert!(
                !roots.contains(&codeg_home.join(rel)),
                "{agent_type:?}: inactive {} must not stay writable, got {roots:?}",
                codeg_home.join(rel).display()
            );
        }
    }

    /// A relative child `HOME` would be absolutized against codeg's cwd — the same
    /// widening as a relative agent home — so the slot is refused instead.
    #[cfg(not(windows))]
    #[test]
    fn relative_child_home_refuses_the_slot() {
        for value in [".", "..", "relative/home"] {
            let runtime_env = BTreeMap::from([("HOME".to_string(), value.to_string())]);
            for agent_type in ALL_AGENT_TYPES {
                if agent_relocated_by_process_env(agent_type) {
                    continue;
                }
                let roots = agent_data_roots(agent_type, &runtime_env);
                assert!(
                    roots.is_empty(),
                    "{agent_type:?}: HOME={value:?} should yield no root, got {roots:?}"
                );
            }
        }
    }

    /// A BLANK `HOME` is `env_remove`d, so the child resolves its home from the OS
    /// account database — which codeg cannot read without duplicating a passwd
    /// lookup, and `dirs::home_dir()` does NOT answer because it consults codeg's
    /// own `$HOME` first. So the slot is refused rather than guessed at.
    ///
    /// Asserting "no roots" is stronger than asserting "not codeg's root", and it
    /// needs no `temp_env`, so it cannot race other tests that read `$HOME`.
    #[cfg(not(windows))]
    #[test]
    fn removed_child_home_refuses_the_slot() {
        let runtime_env = BTreeMap::from([("HOME".to_string(), String::new())]);
        let codeg_home = dirs::home_dir().expect("home dir");

        for agent_type in ALL_AGENT_TYPES {
            if agent_relocated_by_process_env(agent_type) {
                continue;
            }

            let roots = agent_data_roots(agent_type, &runtime_env);
            assert!(
                roots.is_empty(),
                "{agent_type:?}: a removed HOME must yield no root (never codeg's \
                 {}), got {roots:?}",
                codeg_home.display()
            );
        }
    }

    /// Refusing a slot must never widen the gate: `permissive` still seeds the
    /// workspace root, so an empty agent-root list cannot collapse into the
    /// "empty ⇒ unrestricted" sentinel.
    #[cfg(not(windows))]
    #[tokio::test(flavor = "current_thread")]
    async fn refused_agent_slot_does_not_produce_an_unrestricted_policy() {
        let workspace = temp_workspace();
        let runtime_env = BTreeMap::from([("HOME".to_string(), String::new())]);

        let policy = FsAccessPolicy::permissive(&workspace, AgentType::Codex, &runtime_env);
        assert!(
            !policy.write_roots.is_empty(),
            "write roots must never be empty (that means unrestricted)"
        );
        assert!(policy.write_roots.contains(&canonical_root(&workspace)));

        // The gate must still refuse an unrelated path.
        let outside = temp_workspace();
        let runtime = FileSystemRuntime::with_policy(FsAccessPolicy {
            read_roots: Vec::new(),
            write_roots: vec![canonical_root(&workspace)],
        });
        assert!(runtime
            .write_text_file(WriteTextFileRequest::new(
                "sid",
                outside.join("x.txt"),
                "nope"
            ))
            .await
            .is_err());

        let _ = fs::remove_dir_all(workspace);
        let _ = fs::remove_dir_all(outside);
    }

    /// Same hazard through the user-facing knob.
    #[test]
    fn relative_extra_roots_are_dropped() {
        let absolute = absolute_path("tmp/codeg-abs-extra");
        let runtime_env = BTreeMap::from([(
            FS_EXTRA_ROOTS_ENV.to_string(),
            std::env::join_paths([Path::new("."), absolute.as_path()])
                .expect("join paths")
                .to_string_lossy()
                .to_string(),
        )]);

        let roots = extra_write_roots(&runtime_env);
        assert_eq!(roots, vec![absolute]);
    }

    /// The extra-roots list must be read VERBATIM. `split_paths` does not trim
    /// entries, so trimming the value first would rewrite the relative entry
    /// `" / "` into `/` and hand out the entire filesystem.
    #[test]
    fn whitespace_padded_extra_root_is_not_trimmed_into_filesystem_root() {
        let root = absolute_path("");
        let raw = root.to_string_lossy().to_string();

        for padded in [format!(" {raw} "), format!("\t{raw}"), format!("{raw} ")] {
            let runtime_env = BTreeMap::from([(FS_EXTRA_ROOTS_ENV.to_string(), padded.clone())]);
            let roots = extra_write_roots(&runtime_env);
            assert!(
                !roots.contains(&root),
                "{padded:?} must not become the filesystem root, got {roots:?}"
            );
        }

        // An entry that IS exactly the filesystem root stays honored — widening
        // is this knob's declared purpose, so that is the user's explicit choice.
        let runtime_env = BTreeMap::from([(FS_EXTRA_ROOTS_ENV.to_string(), raw)]);
        assert_eq!(extra_write_roots(&runtime_env), vec![root]);
    }

    /// Trimming a relocation value can WIDEN the policy, not just fail to match:
    /// `" / "` reaches the child as a relative path, but trimmed it becomes the
    /// filesystem root and would make everything writable.
    #[test]
    fn whitespace_padded_root_never_becomes_the_filesystem_root() {
        let root = absolute_path("");
        let padded = format!(" {} ", root.to_string_lossy());

        for (agent_type, key) in [
            (AgentType::Codex, "CODEX_HOME"),
            (AgentType::Grok, "GROK_HOME"),
            (AgentType::Pi, "PI_CODING_AGENT_DIR"),
        ] {
            let runtime_env = BTreeMap::from([(key.to_string(), padded.clone())]);
            let roots = agent_data_roots(agent_type, &runtime_env);
            assert!(
                !roots.contains(&root),
                "{agent_type:?}: {key}={padded:?} must not resolve to the filesystem \
                 root, got {roots:?}"
            );
        }

        // And the same value must not slip through the write gate either. Compared
        // against the CANONICAL root because that is the form `permissive` stores —
        // on Windows `canonicalize("C:/")` is the verbatim `\\?\C:\`, so comparing
        // the raw spelling would make this assertion unfalsifiable there.
        let workspace = temp_workspace();
        let runtime_env = BTreeMap::from([("CODEX_HOME".to_string(), padded)]);
        let policy = FsAccessPolicy::permissive(&workspace, AgentType::Codex, &runtime_env);
        assert!(
            !policy.write_roots.contains(&canonical_root(&root)),
            "write roots must not include {}: {:?}",
            root.display(),
            policy.write_roots
        );

        let _ = fs::remove_dir_all(workspace);
    }

    /// Pins the declarative slot table against the `crate::parsers` resolvers it
    /// mirrors, so a change to either side cannot drift silently. Skips any agent
    /// whose relocation vars are set in THIS process, where the resolver would
    /// legitimately return a relocated path instead of the default.
    #[test]
    fn root_slots_match_parser_resolvers() {
        use crate::parsers;

        let expected: [(AgentType, PathBuf); 12] = [
            (AgentType::Grok, parsers::grok::resolve_grok_home_dir()),
            (
                AgentType::ClaudeCode,
                parsers::claude::resolve_claude_config_dir(),
            ),
            (AgentType::Codex, parsers::codex::resolve_codex_home_dir()),
            (
                AgentType::Gemini,
                parsers::gemini::resolve_gemini_base_dir(),
            ),
            (
                AgentType::CodeBuddy,
                parsers::codebuddy::resolve_codebuddy_config_dir(),
            ),
            (
                AgentType::KimiCode,
                parsers::kimi_code::resolve_kimi_code_home_dir(),
            ),
            (
                AgentType::Cursor,
                parsers::cursor::resolve_cursor_config_dir(),
            ),
            (
                AgentType::Hermes,
                parsers::hermes::resolve_hermes_home_dir(),
            ),
            (
                AgentType::OpenCode,
                parsers::opencode::resolve_opencode_base_dir(),
            ),
            (AgentType::Cline, parsers::cline::cline_data_dir()),
            (AgentType::Pi, parsers::pi::resolve_pi_sessions_dir()),
            (
                AgentType::DeepSeek,
                parsers::deepseek::resolve_deepseek_sessions_root(),
            ),
        ];

        for (agent_type, resolver_root) in expected {
            let env_configured = agent_root_slots(agent_type)
                .iter()
                .flat_map(|slot| slot.candidates.iter())
                .any(|(key, _, _)| std::env::var_os(key).is_some());
            if env_configured {
                continue;
            }

            let roots = builtin_default_roots(agent_type);
            assert!(
                roots.contains(&resolver_root),
                "{agent_type:?}: slot default {roots:?} drifted from resolver {}",
                resolver_root.display()
            );
        }
    }

    /// Cursor's resolver prefers `CURSOR_CONFIG_DIR` over `XDG_CONFIG_HOME`;
    /// first match must win rather than both being admitted.
    #[test]
    fn cursor_relocation_respects_resolver_precedence() {
        let config_dir = absolute_path("tmp/codeg-cursor");
        let runtime_env = BTreeMap::from([
            (
                "CURSOR_CONFIG_DIR".to_string(),
                config_dir.to_string_lossy().to_string(),
            ),
            (
                "XDG_CONFIG_HOME".to_string(),
                absolute_path("tmp/codeg-xdg").to_string_lossy().to_string(),
            ),
        ]);

        let roots = agent_data_roots(AgentType::Cursor, &runtime_env);
        assert_eq!(roots, vec![config_dir]);
    }

    /// pi relocates its session store independently of its agent home, so a
    /// `PI_CODING_AGENT_SESSION_DIR` supplied through `env_json` must widen the
    /// roots on its own — the process-env-only resolver cannot see it.
    #[test]
    fn pi_session_dir_relocation_is_honored() {
        let sessions = absolute_path("tmp/codeg-pi-sessions-elsewhere");
        let runtime_env = BTreeMap::from([(
            "PI_CODING_AGENT_SESSION_DIR".to_string(),
            sessions.to_string_lossy().to_string(),
        )]);

        let roots = agent_data_roots(AgentType::Pi, &runtime_env);
        assert!(
            roots.contains(&sessions),
            "pi session-dir relocation not honored: {roots:?}"
        );
    }

    /// No agent may resolve a root so broad that the gate becomes meaningless —
    /// checked both with a clean env AND with every relocation key set to `~`,
    /// since a tilde-expanding bug would only show up in the latter.
    #[test]
    fn no_agent_data_root_is_the_home_dir_or_filesystem_root() {
        let home = dirs::home_dir().expect("home dir");

        let tilde_env: BTreeMap<String, String> = ALL_AGENT_TYPES
            .iter()
            .flat_map(|agent_type| agent_root_slots(*agent_type).iter())
            .flat_map(|slot| slot.candidates.iter())
            .map(|(key, _, _)| ((*key).to_string(), "~".to_string()))
            .collect();

        for env in [BTreeMap::new(), tilde_env] {
            for agent_type in ALL_AGENT_TYPES {
                for root in agent_data_roots(agent_type, &env) {
                    assert!(
                        root != home && root.parent().is_some() && root != Path::new("/"),
                        "{agent_type:?} resolved an over-broad root: {}",
                        root.display()
                    );
                }
            }
        }
    }

    /// `(home var, an absolute home path)` for the platform the test runs on.
    /// `dirs::home_dir()` reads `USERPROFILE` on Windows and `HOME` elsewhere,
    /// and `child_home_dir` rejects a home that is not absolute — which a
    /// unix-style literal is not on Windows.
    #[cfg(windows)]
    const CHILD_HOME_FIXTURE: (&str, &str) = ("USERPROFILE", "C:\\srv\\agy");
    #[cfg(not(windows))]
    const CHILD_HOME_FIXTURE: (&str, &str) = ("HOME", "/srv/agy");

    const ALL_AGENT_TYPES: [AgentType; 13] = [
        AgentType::ClaudeCode,
        AgentType::Codex,
        AgentType::OpenCode,
        AgentType::Gemini,
        AgentType::OpenClaw,
        AgentType::Cline,
        AgentType::Hermes,
        AgentType::CodeBuddy,
        AgentType::KimiCode,
        AgentType::Pi,
        AgentType::Grok,
        AgentType::Cursor,
        AgentType::DeepSeek,
    ];

    #[test]
    fn every_agent_type_has_a_data_root() {
        for agent_type in ALL_AGENT_TYPES {
            let roots = agent_data_roots(agent_type, &BTreeMap::new());
            assert!(!roots.is_empty(), "{agent_type:?} resolved no data root");
            assert!(
                roots.iter().all(|root| root.is_absolute()),
                "{agent_type:?} produced a relative root: {roots:?}"
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn write_replaces_existing_content() {
        let workspace = temp_workspace();
        let file = workspace.join("target.txt");
        fs::write(&file, "old").expect("write old content");

        let runtime = FileSystemRuntime::new(workspace.clone());
        runtime
            .write_text_file(WriteTextFileRequest::new("sid", &file, "new-content"))
            .await
            .expect("write file");

        let content = fs::read_to_string(&file).expect("read file");
        assert_eq!(content, "new-content");

        let leaked_tmp = fs::read_dir(&workspace)
            .expect("read workspace")
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".codeg-fs-")
            });
        assert!(!leaked_tmp, "temporary file should be cleaned up");

        let _ = fs::remove_dir_all(workspace);
    }
}
