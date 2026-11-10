//! The OpenCode codeg launches: OpenCode 2, and nothing older.
//!
//! codeg pins OpenCode 2 (`AgentType::OpenCode` in `registry.rs`) and writes
//! everything it configures in OpenCode 2's own terms: the `providers`,
//! `permissions`, `update` and `plugins` keys, and credentials in the
//! `credential` table of `opencode.db` instead of `auth.json`. OpenCode 1.x
//! reads none of that, so a 1.x session would run without the providers,
//! permissions and MCP servers the settings page shows as applied. It would
//! also run on a database OpenCode 2 may already have migrated (a 1.x build in
//! a repository whose cached project id changed exits before `initialize` with
//! `no such column: project_id`).
//!
//! Rather than half-work, a 1.x runtime is refused before it starts, with a
//! message naming the version found and where to upgrade. The error is
//! [`AcpError::AgentRuntimeOutdated`](crate::acp::error::AcpError), which the
//! frontend shows with an "Open Agent Settings" action.
//!
//! The launch argv is the bare `opencode acp` the registry declares. OpenCode 2's
//! `acp` takes no `--port`/`--hostname` (the CLI rejects both and prints its
//! usage to stdout, the ACP channel): it starts its own private server on an
//! automatic loopback port and reads no `server.*` config, so the 1.x
//! `ServeError` codeg once passed explicit listen flags for (codeg#860) cannot
//! happen.

use std::path::Path;

use crate::models::agent::AgentType;

/// The oldest OpenCode major codeg launches.
const MIN_SUPPORTED_MAJOR: u64 = 2;

/// Whether `version` names an OpenCode release older than 2.0.
///
/// Only a release can be judged. opencode publishes every preview channel
/// (`dev`, `beta`, `next`, per-branch snapshots) as `0.0.0-<tag>` whatever the
/// build's age, and a source build or an unreadable `--version` has no usable
/// version at all; those launch, because refusing a build that may well be 2.x
/// would be worse than letting an old one show its own errors.
fn is_pre_v2_release(version: &str) -> bool {
    let Ok(version) = semver::Version::parse(version.trim()) else {
        return false;
    };
    if (version.major, version.minor, version.patch) == (0, 0, 0) {
        return false;
    }
    version.major < MIN_SUPPORTED_MAJOR
}

/// The version of the OpenCode about to be launched from `bin` when it is a
/// 1.x (or older) release, `None` when it may launch.
///
/// `cached_version` is the codeg-managed install's version label: the release
/// tag its archive was downloaded from. A binary found on PATH comes without
/// one, so its `--version` is read through the probe the agent list already
/// runs on it (cached per path and mtime), which usually makes this free.
pub(crate) async fn pre_v2_runtime(bin: &Path, cached_version: Option<&str>) -> Option<String> {
    let version = match cached_version {
        Some(version) => version.trim().to_string(),
        None => crate::commands::acp::system_probed_version(AgentType::OpenCode, bin, None).await?,
    };
    is_pre_v2_release(&version).then_some(version)
}

/// What [`AcpError::AgentRuntimeOutdated`](crate::acp::error::AcpError)
/// carries for a refused 1.x OpenCode: which build was found, and the way out
/// for that kind of install. A managed install upgrades from the agent's
/// settings; a binary from PATH is the user's own, so the message offers both
/// codeg's managed copy (which takes precedence once installed) and upgrading
/// their install.
pub(crate) fn runtime_outdated_message(
    version: &str,
    bin: &Path,
    managed: bool,
    pinned: &str,
) -> String {
    if managed {
        format!(
            "OpenCode {version} is no longer supported: this version of Codeg runs OpenCode 2. \
             Upgrade it to {pinned} in Agent Settings → OpenCode."
        )
    } else {
        format!(
            "The OpenCode found on PATH ({}) is version {version}, which this version of Codeg \
             no longer supports: it runs OpenCode 2. Install OpenCode {pinned} in Agent Settings → \
             OpenCode, or upgrade your own install to OpenCode 2 (`opencode upgrade --major`).",
            bin.display()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::registry::{self, AgentDistribution};
    #[cfg(unix)]
    use std::path::PathBuf;

    #[test]
    fn a_1x_release_is_refused_and_2x_is_not() {
        assert!(is_pre_v2_release("1.19.3"));
        assert!(is_pre_v2_release("1.19.4"));
        assert!(is_pre_v2_release(" 1.18.33\n"));
        assert!(is_pre_v2_release("1.0.41"));
        assert!(is_pre_v2_release("0.15.31"));
        // A prerelease of a 1.x line is still 1.x.
        assert!(is_pre_v2_release("1.19.5-beta.1"));

        assert!(!is_pre_v2_release("2.0.0"));
        assert!(!is_pre_v2_release("2.2.0"));
        assert!(!is_pre_v2_release("2.0.0-rc.1"));
        assert!(!is_pre_v2_release("3.0.0"));
    }

    #[test]
    fn a_preview_or_unreadable_version_is_never_refused() {
        // Real npm versions from both preview-number schemes: their age is
        // unknowable from the number, so they launch.
        assert!(!is_pre_v2_release("0.0.0-1748650942428"));
        assert!(!is_pre_v2_release("0.0.0-dev-202609282300"));
        assert!(!is_pre_v2_release("0.0.0"));
        assert!(!is_pre_v2_release("local"));
        assert!(!is_pre_v2_release(""));
        assert!(!is_pre_v2_release("1.19"));
    }

    /// The pin itself must launch, or every managed install would be refused.
    #[test]
    fn the_pinned_release_is_not_refused() {
        let AgentDistribution::Binary { version, args, .. } =
            registry::get_agent_meta(AgentType::OpenCode).distribution
        else {
            panic!("OpenCode is a binary agent");
        };
        assert!(!is_pre_v2_release(version));
        assert_eq!(args, ["acp"], "OpenCode 2's acp takes no listen flags");
    }

    #[tokio::test]
    async fn a_managed_label_decides_without_running_anything() {
        // Nothing exists at this path, so no probe could have answered.
        let missing = Path::new("/nonexistent/codeg-443/opencode");
        assert_eq!(
            pre_v2_runtime(missing, Some("1.19.3")).await.as_deref(),
            Some("1.19.3")
        );
        assert_eq!(pre_v2_runtime(missing, Some("2.2.0")).await, None);
        // A PATH binary that cannot be asked is not refused.
        assert_eq!(pre_v2_runtime(missing, None).await, None);
    }

    /// A stand-in `opencode` answering `--version` with `banner`.
    #[cfg(unix)]
    fn fake_opencode(dir: &Path, banner: &str) -> PathBuf {
        let bin = dir.join("opencode");
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo '{banner}'; exit 0; fi\nexit 1\n"
        );
        crate::process::write_test_script(&bin, &script);
        bin
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_path_binary_is_judged_by_its_version_banner() {
        // 1.x prints the bare version; 2.x prints `opencode v<version>`.
        let dir = tempfile::tempdir().expect("tempdir");
        let old = fake_opencode(dir.path(), "1.19.3");
        assert_eq!(pre_v2_runtime(&old, None).await.as_deref(), Some("1.19.3"));

        let dir = tempfile::tempdir().expect("tempdir");
        let current = fake_opencode(dir.path(), "opencode v2.2.0");
        assert_eq!(pre_v2_runtime(&current, None).await, None);
    }

    #[test]
    fn the_message_names_the_version_and_the_way_out() {
        let bin = Path::new("/usr/local/bin/opencode");
        let managed = runtime_outdated_message("1.19.3", bin, true, "2.2.0");
        assert!(managed.contains("OpenCode 1.19.3"), "{managed}");
        assert!(managed.contains("2.2.0"), "{managed}");
        assert!(managed.contains("Agent Settings"), "{managed}");

        let system = runtime_outdated_message("1.18.33", bin, false, "2.2.0");
        assert!(system.contains("/usr/local/bin/opencode"), "{system}");
        assert!(system.contains("1.18.33"), "{system}");
        assert!(system.contains("opencode upgrade --major"), "{system}");
    }
}
