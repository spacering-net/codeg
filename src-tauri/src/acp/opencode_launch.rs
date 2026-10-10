//! Launch flags for OpenCode's `opencode acp` (codeg#860).
//!
//! `opencode acp` is more than a stdio ACP server: its ACP bridge drives an
//! HTTP server embedded in the same process, through the opencode SDK at
//! `http://<hostname>:<port>`. Since 1.0.204 it resolves that listener as CLI
//! flag > the GLOBAL config's `server.port` / `server.hostname`
//! (`~/.config/opencode/opencode.json`) > the subcommand's own default
//! (`--port 0 --hostname 127.0.0.1`). The config block exists for
//! `opencode serve`, but `acp` inherits it all the same.
//!
//! A fixed port there cannot work under codeg, which runs one `opencode acp`
//! per session. The first session binds it; every concurrent session — or any
//! session while some other opencode process holds the port — exits 1 with
//! `Error: Unexpected error` / `ServeError` before `initialize` answers,
//! because opencode gives a non-zero port no fallback. A configured `0.0.0.0`
//! is wrong more quietly: it publishes the session's agent API on every
//! interface, and it is also the host the bridge's own SDK then dials — one
//! codeg's loopback `NO_PROXY` exception (`network::proxy`) does not name.
//!
//! Passing the subcommand's defaults explicitly restores them, since a flag
//! outranks the config. `--port 0` means "4096 if free, else any free port",
//! and that fallback is what isolates concurrent sessions; a codeg-picked
//! non-zero port would bring the failure back through the race between
//! picking it and opencode binding it. `--hostname 127.0.0.1` keeps the
//! listener on loopback, which also stops opencode from announcing it over
//! mDNS (it never publishes a loopback host).
//!
//! The flags only exist from [`LISTEN_FLAGS_MIN_VERSION`], and opencode parses
//! its CLI strictly: an older build exits on them instead of starting, and
//! prints its usage to stdout — the ACP channel. The 2.x line belongs in the
//! same bucket: opencode 2.0 dropped the flags (its `acp` starts a private
//! `serve --stdio --port 0` child server of its own) and the CLI rejects them
//! just the same. Those builds have no user-controlled listener to override
//! anyway, so they keep the bare argv, and the launch has to know which kind
//! of build it is starting. See [`listen_args`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use crate::models::agent::AgentType;

/// Appended after `acp`, whose options they are. Each flag and its value are
/// separate argv elements on purpose: releases such as 1.0.204 detect an
/// explicit flag with `process.argv.includes("--port")`, so a `--port=0`
/// spelling reads as "not given" there and the config wins again.
const LISTEN_ARGS: &[&str] = &["--port", "0", "--hostname", "127.0.0.1"];

/// First release whose `acp` accepts `--port` / `--hostname` (upstream
/// 73cd8a334c). 1.0.42 was never published; 1.0.41's `acp` has neither flag.
const LISTEN_FLAGS_MIN_VERSION: semver::Version = semver::Version::new(1, 0, 43);

/// Bound on the `acp --help` probe, like every other status-path probe.
const HELP_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// What a version string alone settles: `Some` for a release, `None` when it
/// cannot tell. opencode publishes every preview channel (`dev`, `beta`,
/// `next`, per-branch snapshots) as `0.0.0-<tag>` whatever the build's age —
/// npm carries thousands of them, from before `acp` existed to last night —
/// and a source build or a failed probe has no usable version at all. The
/// 2.x line is the same "cannot tell" case at the major: opencode 2.0
/// rearchitected `acp` (it starts its own `serve --stdio --port 0` child) and
/// declares no listen flags, so the 1.x floor stops at the major.
fn release_accepts_listen_flags(version: &str) -> Option<bool> {
    let version = semver::Version::parse(version.trim()).ok()?;
    if (version.major, version.minor, version.patch) == (0, 0, 0) {
        return None;
    }
    // Never infer 2.x from the 1.x floor: `acp` dropped `--port`/`--hostname`
    // in 2.0.0, and the CLI rejects them outright. Ask the binary
    // (`acp --help`) instead, so a later 2.x that re-adds them is handled too.
    if version.major >= 2 {
        return None;
    }
    Some(version.cmp_precedence(&LISTEN_FLAGS_MIN_VERSION) != std::cmp::Ordering::Less)
}

/// Whether `acp --help` output lists both flags, as whole tokens.
fn help_lists_listen_flags(help: &str) -> bool {
    let lists = |flag: &str| help.split_whitespace().any(|token| token == flag);
    lists("--port") && lists("--hostname")
}

/// `acp --help` verdicts, per binary path, stamped with the binary's mtime so
/// an upgrade in place is probed afresh.
static HELP_PROBE_CACHE: Mutex<Option<HashMap<PathBuf, (SystemTime, bool)>>> = Mutex::new(None);

/// Ask the binary itself: run `<bin> acp --help` and look for the flags. `None`
/// when the probe gave no answer: it failed to spawn, timed out (a first start
/// under an antivirus scan can be slow), or exited unsuccessfully — help that
/// works exits 0, so a crash or a kill leaves output that proves nothing. Only
/// an answer is cached; the rest is retried at the next launch, so a transient
/// failure cannot pin the bare argv on a build that has the flags for the life
/// of the process.
async fn help_probe(bin: &Path) -> Option<bool> {
    let mtime = std::fs::metadata(bin).and_then(|m| m.modified()).ok();
    if let (Some(mtime), Ok(cache)) = (mtime, HELP_PROBE_CACHE.lock()) {
        if let Some(&(cached_mtime, verdict)) = cache.as_ref().and_then(|map| map.get(bin)) {
            if cached_mtime == mtime {
                return Some(verdict);
            }
        }
    }

    let mut cmd = crate::process::tokio_command(bin);
    cmd.args(["acp", "--help"])
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(HELP_PROBE_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // Either stream: 1.18 prints its help on stderr.
    let verdict = help_lists_listen_flags(&String::from_utf8_lossy(&output.stdout))
        || help_lists_listen_flags(&String::from_utf8_lossy(&output.stderr));

    if let (Some(mtime), Ok(mut cache)) = (mtime, HELP_PROBE_CACHE.lock()) {
        cache
            .get_or_insert_with(HashMap::new)
            .insert(bin.to_path_buf(), (mtime, verdict));
    }
    Some(verdict)
}

/// The flags to append after `acp` when launching `bin`.
///
/// `cached_version` is the codeg-managed install's version label: the release
/// tag its archive was downloaded from. A binary found on PATH comes without
/// one, so its `--version` is read through the same cached probe the agent
/// list already runs on it, which usually makes this free. A release version
/// below 2.0 settles the question outright; anything else — a preview build,
/// a release from 2.0 on, no usable version — asks the binary for its
/// `acp --help`.
///
/// When even that fails, the launch keeps the bare argv. That is exactly how
/// it behaved before, so the worst case is the old behaviour — never a launch
/// that used to start and now does not.
pub(crate) async fn listen_args(
    bin: &Path,
    cached_version: Option<&str>,
) -> &'static [&'static str] {
    let probed = match cached_version {
        Some(_) => None,
        None => crate::commands::acp::system_probed_version(AgentType::OpenCode, bin, None).await,
    };
    let version = cached_version.or(probed.as_deref());
    let verdict = match version.and_then(release_accepts_listen_flags) {
        Some(verdict) => Some(verdict),
        None => help_probe(bin).await,
    };
    match verdict {
        Some(true) => LISTEN_ARGS,
        Some(false) => {
            // Nothing lost: no build without the flags has a listener the
            // config can move. Before 1.0.43 `acp` starts no HTTP server, and
            // 2.x puts its private `serve --stdio` child on an automatic
            // loopback port.
            tracing::info!(
                "[ACP][OpenCode] {} (version {}) does not accept `acp --port/--hostname`; launching without them",
                bin.display(),
                version.unwrap_or("unknown"),
            );
            &[]
        }
        None => {
            tracing::warn!(
                "[ACP][OpenCode] could not tell whether {} (version {}) accepts `acp --port/--hostname`; \
                 launching without them, so a fixed `server.port` in opencode's global config can \
                 still fail concurrent sessions with ServeError",
                bin.display(),
                version.unwrap_or("unknown"),
            );
            &[]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::registry::{self, AgentDistribution};

    #[test]
    fn a_release_version_settles_it_at_the_floor() {
        assert_eq!(release_accepts_listen_flags("1.0.43"), Some(true));
        assert_eq!(release_accepts_listen_flags("1.0.204"), Some(true));
        assert_eq!(release_accepts_listen_flags("1.18.33"), Some(true));
        assert_eq!(release_accepts_listen_flags(" 1.18.33\n"), Some(true));
        // A later release's prerelease is still past the floor.
        assert_eq!(release_accepts_listen_flags("1.18.34-beta.1"), Some(true));

        assert_eq!(release_accepts_listen_flags("1.0.41"), Some(false));
        assert_eq!(release_accepts_listen_flags("0.15.31"), Some(false));
        // Precedence: a prerelease OF the floor precedes it.
        assert_eq!(release_accepts_listen_flags("1.0.43-rc.1"), Some(false));
    }

    #[test]
    fn a_preview_or_unreadable_version_settles_nothing() {
        // Real npm versions from both preview-number schemes; the first
        // predates `acp`, the second is a nightly from this month.
        assert_eq!(release_accepts_listen_flags("0.0.0-1748650942428"), None);
        assert_eq!(release_accepts_listen_flags("0.0.0-dev-202609282300"), None);
        assert_eq!(release_accepts_listen_flags("0.0.0"), None);
        assert_eq!(release_accepts_listen_flags("local"), None);
        assert_eq!(release_accepts_listen_flags(""), None);
        assert_eq!(release_accepts_listen_flags("1.18"), None);
    }

    #[test]
    fn a_2x_release_is_never_settled_by_the_1x_floor() {
        // opencode 2.0 rearchitected `acp`: it starts its own
        // `serve --stdio --port 0` child and declares no listen flags (absent
        // from v2.0.0 through v2.0.26). The 1.x floor must not carry across
        // the major — a 2.x answer has to come from `acp --help`, so a build
        // that re-adds the flags is answered by its own help, not by a guess.
        assert_eq!(release_accepts_listen_flags("2.0.0"), None);
        assert_eq!(release_accepts_listen_flags("2.0.18"), None);
        assert_eq!(release_accepts_listen_flags("2.0.24"), None);
        // Any later major is equally unknown.
        assert_eq!(release_accepts_listen_flags("3.0.0-rc.1"), None);
    }

    /// `opencode acp --help` from 1.18.33 and 1.0.41, trimmed to the options.
    const HELP_1_18_33: &str = "opencode acp\n\nstart ACP (Agent Client Protocol) server\n\nOptions:\n  -h, --help         show help  [boolean]\n      --port         port to listen on  [number] [default: 0]\n      --hostname     hostname to listen on  [string] [default: \"127.0.0.1\"]\n      --mdns         enable mDNS service discovery (defaults hostname to 0.0.0.0)\n      --cwd          working directory  [string]\n";
    const HELP_1_0_41: &str = "opencode acp\n\nStart ACP (Agent Client Protocol) server\n\nOptions:\n  -h, --help        show help  [boolean]\n      --print-logs  print logs to stderr  [boolean]\n      --cwd         working directory  [string]\n";

    /// `opencode acp --help` from 2.0.24, verbatim; 2.x prints it on stdout.
    /// Its `acp` declares no options of its own — every flag listed is one of
    /// the CLI's global flags.
    const HELP_2_0_24: &str = "DESCRIPTION\n  Start an Agent Client Protocol server\n\nUSAGE\n  opencode acp [flags]\n\nGLOBAL FLAGS\n  --help, -h                                                          Show help information\n  --version, -v                                                       Show version information\n  --wizard                                                            Start wizard mode for a command\n  --completions <bash|zsh|fish|sh>                                    Print shell completion script (choices: bash, zsh, fish, sh)\n  --log-level <all|trace|debug|info|warn|warning|error|fatal|none>    Sets the minimum log level (choices: all, trace, debug, info, warn, warning, error, fatal, none)\n  --print-logs                                                        Print logs to stderr (server logs require --standalone)\n";

    #[test]
    fn help_needs_both_flags_as_whole_tokens() {
        assert!(help_lists_listen_flags(HELP_1_18_33));
        assert!(!help_lists_listen_flags(HELP_1_0_41));
        assert!(!help_lists_listen_flags(HELP_2_0_24));
        assert!(!help_lists_listen_flags(""));
        assert!(!help_lists_listen_flags("--port only"));
        assert!(!help_lists_listen_flags("--portal --hostnames"));
    }

    #[test]
    fn flags_and_values_are_separate_argv_elements() {
        assert_eq!(LISTEN_ARGS, ["--port", "0", "--hostname", "127.0.0.1"]);
        assert!(LISTEN_ARGS.iter().all(|arg| !arg.contains('=')));
    }

    /// The shipped pin gets the flags, and they land after the subcommand they
    /// belong to — the exact argv the Binary launch branch assembles.
    #[test]
    fn the_pinned_release_launches_with_the_flags_after_acp() {
        let AgentDistribution::Binary { version, args, .. } =
            registry::get_agent_meta(AgentType::OpenCode).distribution
        else {
            panic!("OpenCode is a binary agent");
        };
        assert_eq!(release_accepts_listen_flags(version), Some(true));
        let argv: Vec<&str> = args.iter().chain(LISTEN_ARGS).copied().collect();
        assert_eq!(argv, ["acp", "--port", "0", "--hostname", "127.0.0.1"]);
    }

    #[tokio::test]
    async fn a_managed_release_label_decides_on_its_own() {
        // Nothing exists at this path, so no probe could have answered: the
        // label alone decided. (That none even runs is proven below, on unix.)
        let missing = Path::new("/nonexistent/codeg-860/opencode");
        assert_eq!(listen_args(missing, Some("1.18.33")).await, LISTEN_ARGS);
        assert!(listen_args(missing, Some("1.0.41")).await.is_empty());
    }

    #[tokio::test]
    async fn a_binary_that_cannot_be_asked_keeps_the_bare_argv() {
        let missing = Path::new("/nonexistent/codeg-860/opencode");
        assert!(listen_args(missing, Some("0.0.0-dev-202609282300"))
            .await
            .is_empty());
        assert!(listen_args(missing, None).await.is_empty());
    }

    /// A stand-in `opencode`: answers `--version` with `version` (or fails
    /// when `None`), and `acp --help` with `help` on stderr — where 1.18
    /// prints it — and exit status `acp_status`. Every call is logged; see
    /// [`invocations`].
    #[cfg(unix)]
    async fn fake_opencode(
        dir: &Path,
        version: Option<&str>,
        help: &str,
        acp_status: u8,
    ) -> PathBuf {
        fake_opencode_with_help_on(dir, version, help, acp_status, 2).await
    }

    /// [`fake_opencode`], printing its `acp --help` on file descriptor
    /// `help_fd` instead: 1 for a 2.x stand-in, since 2.x prints it on stdout.
    #[cfg(unix)]
    async fn fake_opencode_with_help_on(
        dir: &Path,
        version: Option<&str>,
        help: &str,
        acp_status: u8,
        help_fd: u8,
    ) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let bin = dir.join("opencode");
        let version_arm = match version {
            Some(v) => format!("echo '{v}'; exit 0"),
            None => "exit 1".to_string(),
        };
        let script = format!(
            "#!/bin/sh\n\
             if [ \"$1\" = \"--noop\" ]; then exit 1; fi\n\
             echo \"$1\" >> '{}'\n\
             if [ \"$1\" = \"--version\" ]; then {version_arm}; fi\n\
             if [ \"$1\" = \"acp\" ]; then printf '%s' '{help}' >&{help_fd}; exit {acp_status}; fi\n\
             exit 1\n",
            dir.join("invocations").display()
        );
        std::fs::write(&bin, script).expect("write script");
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        // Linux refuses to exec a file while any process still holds a write
        // fd on it — including a child another test thread forked mid-write —
        // and the probes under test do not retry that. One exec that gets
        // through proves every such fd is gone, so the probes that follow
        // cannot trip over it. (`--noop` exits at once, unlogged.)
        crate::process::spawn_retrying_exec_busy(|| {
            std::process::Command::new(&bin).arg("--noop").output()
        })
        .await
        .expect("fake opencode runs");
        bin
    }

    /// The first argument of every call `fake_opencode` answered, in order.
    /// Only a missing log means "none": any other read error must not pass
    /// for an empty one.
    #[cfg(unix)]
    fn invocations(dir: &Path) -> Vec<String> {
        match std::fs::read_to_string(dir.join("invocations")) {
            Ok(log) => log.lines().map(str::to_string).collect(),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(err) => panic!("read the invocation log: {err}"),
        }
    }

    /// Pin `bin`'s mtime through a READ-only handle: the owner may set times
    /// on any fd, and a write fd would reopen the exec window `fake_opencode`
    /// just closed.
    #[cfg(unix)]
    fn set_mtime(bin: &Path, mtime: SystemTime) {
        std::fs::File::open(bin)
            .and_then(|f| f.set_modified(mtime))
            .expect("set mtime");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_managed_release_label_never_runs_the_binary() {
        // Asked, this binary would say "no flags", so the flags can only come
        // from the label — and the empty log shows it was not asked at all.
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = fake_opencode(dir.path(), Some("0.0.0-1748650942428"), HELP_1_0_41, 0).await;
        assert_eq!(listen_args(&bin, Some("1.18.33")).await, LISTEN_ARGS);
        assert!(listen_args(&bin, Some("1.0.41")).await.is_empty());
        assert!(invocations(dir.path()).is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_path_release_is_read_from_its_version_alone() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = fake_opencode(dir.path(), Some("1.18.29"), HELP_1_0_41, 0).await;
        assert_eq!(listen_args(&bin, None).await, LISTEN_ARGS);
        assert_eq!(invocations(dir.path()), ["--version"]);

        let dir = tempfile::tempdir().expect("tempdir");
        let bin = fake_opencode(dir.path(), Some("1.0.41"), HELP_1_18_33, 0).await;
        assert!(listen_args(&bin, None).await.is_empty());
        assert_eq!(invocations(dir.path()), ["--version"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_preview_build_is_asked_for_its_help() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = fake_opencode(dir.path(), Some("0.0.0-dev-202609282300"), HELP_1_18_33, 0).await;
        assert_eq!(listen_args(&bin, None).await, LISTEN_ARGS);
        assert_eq!(invocations(dir.path()), ["--version", "acp"]);

        let dir = tempfile::tempdir().expect("tempdir");
        let bin = fake_opencode(dir.path(), Some("0.0.0-1748650942428"), HELP_1_0_41, 0).await;
        assert!(listen_args(&bin, None).await.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_2x_build_keeps_the_bare_argv() {
        // The codeg#860 floor must not leak into opencode 2.x: 2.0.24 rejects
        // the listen flags outright (the CLI exits and prints its usage to
        // stdout — the ACP channel), so the bare argv is the only launch that
        // starts. The binary is asked (`--version`, whose real banner reads as
        // 2.0.24, then `acp --help`) and its answer — no flags — is what keeps
        // that launch.
        let dir = tempfile::tempdir().expect("tempdir");
        let bin =
            fake_opencode_with_help_on(dir.path(), Some("opencode v2.0.24"), HELP_2_0_24, 0, 1)
                .await;
        assert!(listen_args(&bin, None).await.is_empty());
        assert_eq!(invocations(dir.path()), ["--version", "acp"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_2x_label_is_answered_by_its_help_both_ways() {
        // A managed install's 2.x label settles nothing on its own either: the
        // binary is asked for `acp --help` straight away (its `--version` is
        // not needed) ...
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = fake_opencode_with_help_on(dir.path(), None, HELP_2_0_24, 0, 1).await;
        assert!(listen_args(&bin, Some("2.0.24")).await.is_empty());
        assert_eq!(invocations(dir.path()), ["acp"]);

        // ... and a later 2.x whose help declares both flags again launches
        // with them, read from stdout, where 2.x prints its help. (1.18.33's
        // option list stands in for that help.)
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = fake_opencode_with_help_on(dir.path(), None, HELP_1_18_33, 0, 1).await;
        assert_eq!(listen_args(&bin, Some("2.1.0")).await, LISTEN_ARGS);
        assert_eq!(invocations(dir.path()), ["acp"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_unreadable_version_is_asked_for_its_help() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = fake_opencode(dir.path(), None, HELP_1_18_33, 0).await;
        assert_eq!(listen_args(&bin, None).await, LISTEN_ARGS);
        assert_eq!(invocations(dir.path()), ["--version", "acp"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_help_verdict_is_cached_until_the_binary_changes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = fake_opencode(dir.path(), None, HELP_1_0_41, 0).await;
        assert_eq!(help_probe(&bin).await, Some(false));
        assert_eq!(help_probe(&bin).await, Some(false));
        assert_eq!(invocations(dir.path()), ["acp"]);

        // Upgraded in place. Pin a distinct mtime rather than trusting the
        // filesystem's timestamp granularity to separate the two writes.
        let bin = fake_opencode(dir.path(), None, HELP_1_18_33, 0).await;
        set_mtime(&bin, SystemTime::now() + Duration::from_secs(60));
        assert_eq!(help_probe(&bin).await, Some(true));
        assert_eq!(invocations(dir.path()), ["acp", "acp"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_help_probe_that_fails_is_neither_trusted_nor_cached() {
        // Dies mid-help, before listing any options.
        let dir = tempfile::tempdir().expect("tempdir");
        let truncated = "opencode acp\n\nstart ACP (Agent Client Protocol) server\n";
        let bin = fake_opencode(dir.path(), None, truncated, 1).await;
        assert_eq!(help_probe(&bin).await, None);
        assert!(listen_args(&bin, None).await.is_empty());
        assert_eq!(invocations(dir.path()), ["acp", "--version", "acp"]);

        // Healthy again at the same path AND mtime, so a cached verdict from
        // the failed probes would still be served.
        let failed_at = std::fs::metadata(&bin)
            .and_then(|m| m.modified())
            .expect("mtime");
        let bin = fake_opencode(dir.path(), None, HELP_1_18_33, 0).await;
        set_mtime(&bin, failed_at);
        assert_eq!(listen_args(&bin, None).await, LISTEN_ARGS);
    }
}
