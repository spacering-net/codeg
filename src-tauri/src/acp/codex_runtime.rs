//! Which codex a Codex session actually runs, and the "judge" that asks that
//! codex whether it accepts a catalog.
//!
//! codeg writes `model_catalog_json` for codex to load, and a single field
//! codex cannot parse makes it reject the whole file — every model then
//! vanishes and codex-acp refuses to open a session. So anything codeg
//! publishes is checked by the codex that will read it, never by a schema
//! codeg mirrors (that would drift on every codex release).
//!
//! The codex is resolved from the **launch's own** codex-acp command
//! ([`crate::commands::acp::resolve_npx_command_for`], the same call
//! `connection::build_agent` makes), then from that package directory the
//! nested `@openai/codex` it drives. codex-acp resolves codex with node's
//! `require.resolve('@openai/codex/bin/codex.js')` relative to its own
//! `dist/index.js` and spawns it with the node running itself; the walk in
//! [`resolve_codex_package`] is that lookup. Before this module the official
//! catalog was read from the codex-acp under the npm prefix, which is not the
//! copy a launch runs when PATH holds another one.
//!
//! The result is cached per process. The key is the command, its realpath and
//! the modification times of both package.json files, so a check costs one
//! realpath and a few stats, and a symlink retargeted, a reinstall or an
//! upgrade made outside codeg all change the key.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::models::agent::AgentType;

/// The command codex-acp installs (`bin` in its package.json).
const CODEX_ACP_CMD: &str = "codex-acp";
const CODEX_ACP_PACKAGE: &str = "@agentclientprotocol/codex-acp";
const CODEX_PACKAGE: &str = "@openai/codex";
/// Upper bound on each codex subprocess the judge or the catalog reader runs.
pub const CODEX_SUBPROCESS_TIMEOUT: Duration = Duration::from_secs(15);
/// How far up from the command's realpath the codex-acp package.json may sit
/// (`dist/index.js` is one level below it today).
const PACKAGE_SEARCH_DEPTH: usize = 6;

/// One codex runtime: the nested codex a launch would run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexRuntime {
    /// The nested `@openai/codex` version, or
    /// [`crate::acp::registry::CODEX_NESTED_VERSION_FALLBACK`] when it could
    /// not be read.
    pub version: String,
    /// Whether `version` was read from the installed package. An unconfirmed
    /// runtime never makes a snapshot count as fresh for a confirmed version,
    /// and never reads as "the runtime changed".
    pub confirmed: bool,
    /// `@openai/codex/bin/codex.js`, run with node. `None` when no codex-acp
    /// install could be found, which is also when nothing can be judged.
    pub codex_js: Option<PathBuf>,
    /// The codex-acp package's own version, for status and logs.
    pub adapter_version: Option<String>,
}

impl CodexRuntime {
    fn fallback() -> Self {
        Self {
            version: crate::acp::registry::CODEX_NESTED_VERSION_FALLBACK.to_string(),
            confirmed: false,
            codex_js: None,
            adapter_version: None,
        }
    }

    /// This runtime as a provenance entry, when it is a real, judgeable one.
    pub fn validated_entry(&self) -> Option<ValidatedRuntime> {
        if !self.confirmed {
            return None;
        }
        let codex_js = self.codex_js.as_ref()?;
        Some(ValidatedRuntime {
            version: self.version.clone(),
            codex_js: codex_js.to_string_lossy().into_owned(),
        })
    }
}

/// A runtime that judged a published catalog, as recorded in its provenance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedRuntime {
    pub version: String,
    pub codex_js: String,
}

impl ValidatedRuntime {
    /// Re-read this entry against the disk before it is trusted again: a
    /// codex upgraded in place reports its new version, and one no longer on
    /// disk is gone (`None`).
    pub fn refreshed(&self) -> Option<ValidatedRuntime> {
        let codex_js = PathBuf::from(&self.codex_js);
        if !codex_js.is_file() {
            return None;
        }
        let version = codex_package_dir_of(&codex_js)
            .and_then(|dir| read_package_version(&dir, CODEX_PACKAGE))?;
        Some(ValidatedRuntime {
            version,
            codex_js: self.codex_js.clone(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeKey {
    command: Option<PathBuf>,
    real: Option<PathBuf>,
    adapter_dir: Option<PathBuf>,
    adapter_manifest_mtime: Option<SystemTime>,
}

struct CachedRuntime {
    key: RuntimeKey,
    codex_manifest: Option<PathBuf>,
    codex_manifest_mtime: Option<SystemTime>,
    runtime: CodexRuntime,
}

static RUNTIME_CACHE: Mutex<Option<CachedRuntime>> = Mutex::new(None);

/// The codex a Codex launch would run right now.
pub async fn current() -> CodexRuntime {
    #[cfg(test)]
    if let Some(runtime) = test_hooks::runtime() {
        return runtime;
    }
    let command =
        crate::commands::acp::resolve_npx_command_for(AgentType::Codex, CODEX_ACP_CMD).await;
    let fallback_dirs = npm_prefix_adapter_dirs().await;
    tokio::task::spawn_blocking(move || resolve_blocking(command, &fallback_dirs))
        .await
        .unwrap_or_else(|_| CodexRuntime::fallback())
}

/// Drop the cached resolution, so the next [`current`] reads the disk again
/// even if no key changed (an install that rewrote files within the mtime
/// granularity).
pub fn invalidate() {
    if let Ok(mut cache) = RUNTIME_CACHE.lock() {
        *cache = None;
    }
}

fn resolve_blocking(command: Option<PathBuf>, fallback_dirs: &[PathBuf]) -> CodexRuntime {
    let real = command
        .as_deref()
        .and_then(|c| std::fs::canonicalize(c).ok());
    let launched = command
        .as_deref()
        .and_then(|c| adapter_dir_for_command(c, real.as_deref()));
    // A launch command whose package cannot be found (a wrapper script, a
    // version-manager shim) may run another install than the npm prefix's:
    // that one can still be asked, but is not taken for the launch's runtime.
    let borrowed = launched.is_none();
    let adapter_dir = launched.or_else(|| {
        fallback_dirs
            .iter()
            .find(|dir| is_package(dir, CODEX_ACP_PACKAGE))
            .cloned()
    });
    let key = RuntimeKey {
        command: command.clone(),
        real: real.clone(),
        adapter_manifest_mtime: adapter_dir
            .as_deref()
            .and_then(|dir| mtime(&dir.join("package.json"))),
        adapter_dir: adapter_dir.clone(),
    };

    if let Ok(cache) = RUNTIME_CACHE.lock() {
        if let Some(hit) = cache.as_ref() {
            let codex_mtime = hit.codex_manifest.as_deref().and_then(mtime);
            if hit.key == key && hit.codex_manifest_mtime == codex_mtime {
                return hit.runtime.clone();
            }
        }
    }

    let (mut runtime, codex_manifest) = match adapter_dir.as_deref() {
        Some(dir) => resolve_from_adapter(dir),
        None => (CodexRuntime::fallback(), None),
    };
    if borrowed && command.is_some() {
        runtime.confirmed = false;
    }
    if let Ok(mut cache) = RUNTIME_CACHE.lock() {
        *cache = Some(CachedRuntime {
            key,
            codex_manifest_mtime: codex_manifest.as_deref().and_then(mtime),
            codex_manifest,
            runtime: runtime.clone(),
        });
    }
    runtime
}

fn resolve_from_adapter(adapter_dir: &Path) -> (CodexRuntime, Option<PathBuf>) {
    let adapter_version = read_package_version(adapter_dir, CODEX_ACP_PACKAGE);
    let Some(codex_dir) = resolve_codex_package(adapter_dir) else {
        return (
            CodexRuntime {
                adapter_version,
                ..CodexRuntime::fallback()
            },
            None,
        );
    };
    let codex_js = codex_dir.join("bin").join("codex.js");
    let manifest = codex_dir.join("package.json");
    match read_package_version(&codex_dir, CODEX_PACKAGE) {
        Some(version) if codex_js.is_file() => (
            CodexRuntime {
                version,
                confirmed: true,
                codex_js: Some(codex_js),
                adapter_version,
            },
            Some(manifest),
        ),
        _ => (
            CodexRuntime {
                adapter_version,
                // A codex.js without a readable version still runs; it can be
                // judged against, just not trusted as a version.
                codex_js: codex_js.is_file().then_some(codex_js),
                ..CodexRuntime::fallback()
            },
            Some(manifest),
        ),
    }
}

/// The codex-acp package directory a launch command belongs to.
///
/// npm's unix bin is a symlink into the package (`…/codex-acp/dist/index.js`),
/// so walking up from the realpath finds it. Windows' bin is a `.cmd` shim
/// next to the prefix's `node_modules`, which is where the package sits.
fn adapter_dir_for_command(command: &Path, real: Option<&Path>) -> Option<PathBuf> {
    let start = real.unwrap_or(command);
    let mut dir = start.parent();
    for _ in 0..PACKAGE_SEARCH_DEPTH {
        let Some(d) = dir else { break };
        if is_package(d, CODEX_ACP_PACKAGE) {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    let shim_dir = command.parent()?;
    let beside = shim_dir
        .join("node_modules")
        .join("@agentclientprotocol")
        .join("codex-acp");
    is_package(&beside, CODEX_ACP_PACKAGE).then_some(beside)
}

/// The directories node searches for a bare specifier required from `start`,
/// nearest first: `start/node_modules`, then each ancestor's, skipping
/// ancestors that are themselves a `node_modules` (node's
/// `NODE_MODULES_PATHS`). A pnpm store's sibling layout resolves through the
/// same walk.
fn node_modules_lookup_paths(start: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut current = Some(start);
    while let Some(dir) = current {
        if dir.file_name().is_some_and(|name| name != "node_modules") {
            out.push(dir.join("node_modules"));
        }
        current = dir.parent();
    }
    out
}

/// `@openai/codex` as codex-acp's own `require.resolve` finds it.
fn resolve_codex_package(adapter_dir: &Path) -> Option<PathBuf> {
    node_modules_lookup_paths(adapter_dir)
        .into_iter()
        .map(|nm| nm.join("@openai").join("codex"))
        .find(|dir| is_package(dir, CODEX_PACKAGE))
}

/// `<pkg>/bin/codex.js` → `<pkg>`.
fn codex_package_dir_of(codex_js: &Path) -> Option<PathBuf> {
    codex_js.parent()?.parent().map(Path::to_path_buf)
}

fn is_package(dir: &Path, name: &str) -> bool {
    read_package_field(dir, "name").as_deref() == Some(name)
}

fn read_package_version(dir: &Path, name: &str) -> Option<String> {
    if !is_package(dir, name) {
        return None;
    }
    read_package_field(dir, "version").filter(|v| !v.trim().is_empty())
}

fn read_package_field(dir: &Path, field: &str) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get(field)?.as_str().map(str::to_string)
}

fn mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

/// The codex-acp package directory under an npm prefix.
fn adapter_dir_under_prefix(prefix: &Path) -> PathBuf {
    let base = if cfg!(windows) {
        prefix.join("node_modules")
    } else {
        prefix.join("lib").join("node_modules")
    };
    base.join("@agentclientprotocol").join("codex-acp")
}

/// The last resort when the launch command does not resolve: the global npm
/// prefix and codeg's user prefix (`~/.codeg/npm-global`, used when a global
/// install hit EACCES).
async fn npm_prefix_adapter_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(prefix) = crate::commands::acp::cached_npm_global_prefix().await {
        dirs.push(adapter_dir_under_prefix(&prefix));
    }
    if let Some(prefix) = crate::process::user_npm_prefix() {
        dirs.push(adapter_dir_under_prefix(&prefix));
    }
    dirs
}

/// Why the judge did not accept a catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JudgeError {
    /// No codex to ask: codex-acp is not installed, or node is missing.
    NotInstalled,
    /// codex refused the file; carries codex's own words.
    Rejected(String),
    /// codex accepted the file but printed a different number of models,
    /// i.e. it dropped some.
    CountMismatch {
        expected: usize,
        got: usize,
    },
    Timeout,
    Io(String),
}

impl std::fmt::Display for JudgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JudgeError::NotInstalled => write!(f, "codex is not installed"),
            JudgeError::Rejected(msg) => write!(f, "codex rejected the catalog: {msg}"),
            JudgeError::CountMismatch { expected, got } => {
                write!(f, "codex loaded {got} of the catalog's {expected} models")
            }
            JudgeError::Timeout => write!(f, "codex did not answer in time"),
            JudgeError::Io(msg) => write!(f, "{msg}"),
        }
    }
}

fn oracle_dir() -> PathBuf {
    crate::paths::codeg_home_dir()
        .join("cache")
        .join("codex")
        .join("oracle")
}

/// Ask `codex_js` whether it loads `catalog` as a `model_catalog_json`.
///
/// Runs `codex debug models -c model_catalog_json="<file>"` — the static
/// loader codex itself uses for that key — with `CODEX_HOME` pointed at an
/// empty directory so the user's own config.toml cannot interfere. Accepted
/// means exit 0 **and** as many models printed as went in. codex prints the
/// catalog re-serialized, not byte for byte, so only the count is compared.
///
/// What it does not check — auth filtering, and the URL loader's slug, size
/// and redirect rules — the callers check themselves.
pub async fn judge(codex_js: &Path, catalog: &[u8]) -> Result<usize, JudgeError> {
    #[cfg(test)]
    if let Some(verdict) = test_hooks::judge(codex_js, catalog) {
        return verdict;
    }
    let expected = serde_json::from_slice::<serde_json::Value>(catalog)
        .ok()
        .as_ref()
        .and_then(|v| v.get("models"))
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .ok_or_else(|| JudgeError::Rejected("the catalog has no models array".into()))?;
    let node = which::which("node").map_err(|_| JudgeError::NotInstalled)?;
    if !codex_js.is_file() {
        return Err(JudgeError::NotInstalled);
    }
    let dir = oracle_dir();
    let id = uuid::Uuid::new_v4().simple().to_string();
    let file = dir.join(format!("catalog-{id}.json"));
    let home = dir.join(format!("home-{id}"));
    let write = {
        let (file, home, bytes) = (file.clone(), home.clone(), catalog.to_vec());
        tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            std::fs::create_dir_all(&home)?;
            std::fs::write(&file, bytes)
        })
        .await
    };
    match write {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(JudgeError::Io(format!("write judge file: {e}"))),
        Err(e) => return Err(JudgeError::Io(format!("write judge file: {e}"))),
    }
    let result = run_judge(&node, codex_js, &file, &home, expected).await;
    let _ = tokio::fs::remove_file(&file).await;
    let _ = tokio::fs::remove_dir_all(&home).await;
    result
}

async fn run_judge(
    node: &Path,
    codex_js: &Path,
    file: &Path,
    home: &Path,
    expected: usize,
) -> Result<usize, JudgeError> {
    // A TOML basic string, escaped the way codex's `-c` parser reads it, so
    // a Windows path's backslashes survive.
    let value = toml_edit::Value::from(file.to_string_lossy().into_owned()).to_string();
    let mut cmd = crate::process::tokio_command(node);
    cmd.arg(codex_js)
        .arg("debug")
        .arg("models")
        .arg("-c")
        .arg(format!("model_catalog_json={}", value.trim()))
        .env("CODEX_HOME", home)
        .kill_on_drop(true);
    let output = match tokio::time::timeout(CODEX_SUBPROCESS_TIMEOUT, cmd.output()).await {
        Err(_) => return Err(JudgeError::Timeout),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(JudgeError::NotInstalled)
        }
        Ok(Err(e)) => return Err(JudgeError::Io(format!("run codex: {e}"))),
        Ok(Ok(output)) => output,
    };
    if !output.status.success() {
        return Err(JudgeError::Rejected(codex_complaint(&output.stderr)));
    }
    let got = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .ok()
        .as_ref()
        .and_then(|v| v.get("models"))
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .ok_or_else(|| JudgeError::Rejected("codex printed no catalog".into()))?;
    if got != expected {
        return Err(JudgeError::CountMismatch { expected, got });
    }
    Ok(got)
}

/// The useful part of codex's stderr: its last non-blank lines, bounded.
fn codex_complaint(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let tail = lines
        .iter()
        .rev()
        .take(3)
        .rev()
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    let mut out: String = tail.chars().take(500).collect();
    if out.is_empty() {
        out = "codex exited with an error".into();
    }
    out
}

/// Run `codex_js debug models --bundled`: the official catalog compiled into
/// this codex, in file order.
pub async fn bundled_catalog_output(codex_js: &Path) -> Option<String> {
    let node = which::which("node").ok()?;
    let mut cmd = crate::process::tokio_command(&node);
    cmd.arg(codex_js)
        .arg("debug")
        .arg("models")
        .arg("--bundled")
        .kill_on_drop(true);
    let output = tokio::time::timeout(CODEX_SUBPROCESS_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Remove judge leftovers a crashed run left behind. Best-effort.
pub fn sweep_oracle_dir() {
    let dir = oracle_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let cutoff = SystemTime::now() - Duration::from_secs(10 * 60);
    for entry in entries.flatten() {
        let path = entry.path();
        let old = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .is_some_and(|m| m < cutoff);
        if !old {
            continue;
        }
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Stand-ins for the machine's own codex, per test thread: a test that sets
/// none runs against the real resolution.
#[cfg(test)]
pub(crate) mod test_hooks {
    use super::*;
    use std::cell::RefCell;

    type JudgeFn = Box<dyn Fn(&Path, &[u8]) -> Result<usize, JudgeError>>;

    thread_local! {
        static RUNTIME: RefCell<Option<CodexRuntime>> = const { RefCell::new(None) };
        static JUDGE: RefCell<Option<JudgeFn>> = const { RefCell::new(None) };
    }

    pub fn set_runtime(runtime: Option<CodexRuntime>) {
        RUNTIME.with(|r| *r.borrow_mut() = runtime);
    }

    pub fn set_judge(judge: Option<JudgeFn>) {
        JUDGE.with(|j| *j.borrow_mut() = judge);
    }

    pub(super) fn runtime() -> Option<CodexRuntime> {
        RUNTIME.with(|r| r.borrow().clone())
    }

    pub(super) fn judge(codex_js: &Path, catalog: &[u8]) -> Option<Result<usize, JudgeError>> {
        JUDGE.with(|j| j.borrow().as_ref().map(|f| f(codex_js, catalog)))
    }

    /// A confirmed runtime of `version` whose codex.js is `js` (need not exist).
    pub fn runtime_of(version: &str, js: &str) -> CodexRuntime {
        CodexRuntime {
            version: version.to_string(),
            confirmed: true,
            codex_js: Some(PathBuf::from(js)),
            adapter_version: Some("2.2.2".into()),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn write_package(dir: &Path, name: &str, version: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            format!(r#"{{"name":"{name}","version":"{version}"}}"#),
        )
        .unwrap();
    }

    /// An npm global install: `bin/codex-acp` → the package's `dist/index.js`,
    /// with codex nested under the adapter.
    pub(crate) fn fake_global_install(prefix: &Path, adapter: &str, codex: &str) -> PathBuf {
        let pkg = prefix.join("lib/node_modules/@agentclientprotocol/codex-acp");
        write_package(&pkg, CODEX_ACP_PACKAGE, adapter);
        std::fs::create_dir_all(pkg.join("dist")).unwrap();
        std::fs::write(pkg.join("dist/index.js"), "// adapter").unwrap();
        let codex_dir = pkg.join("node_modules/@openai/codex");
        write_package(&codex_dir, CODEX_PACKAGE, codex);
        std::fs::create_dir_all(codex_dir.join("bin")).unwrap();
        std::fs::write(codex_dir.join("bin/codex.js"), "// codex").unwrap();
        pkg
    }

    #[test]
    fn node_modules_paths_skip_node_modules_ancestors() {
        let paths =
            node_modules_lookup_paths(Path::new("/r/.pnpm/x@1/node_modules/@scope/codex-acp"));
        assert_eq!(
            paths[..3],
            [
                PathBuf::from("/r/.pnpm/x@1/node_modules/@scope/codex-acp/node_modules"),
                PathBuf::from("/r/.pnpm/x@1/node_modules/@scope/node_modules"),
                // `/r/.pnpm/x@1/node_modules` itself, not `…/node_modules/node_modules`.
                PathBuf::from("/r/.pnpm/x@1/node_modules"),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolves_the_nested_codex_through_the_launch_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let pkg = fake_global_install(dir.path(), "2.2.2", "0.160.1");
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::os::unix::fs::symlink(pkg.join("dist/index.js"), bin.join("codex-acp")).unwrap();
        invalidate();

        let runtime = resolve_blocking(Some(bin.join("codex-acp")), &[]);
        assert!(runtime.confirmed);
        assert_eq!(runtime.version, "0.160.1");
        assert_eq!(runtime.adapter_version.as_deref(), Some("2.2.2"));
        let js = runtime.codex_js.clone().unwrap();
        assert!(js.ends_with("node_modules/@openai/codex/bin/codex.js"));

        // Retarget the symlink at another install while the first stays on
        // disk: the realpath changes, so the cache must not answer.
        let other = dir.path().join("other");
        let pkg2 = fake_global_install(&other, "2.3.0", "0.161.0");
        std::fs::remove_file(bin.join("codex-acp")).unwrap();
        std::os::unix::fs::symlink(pkg2.join("dist/index.js"), bin.join("codex-acp")).unwrap();
        let runtime = resolve_blocking(Some(bin.join("codex-acp")), &[]);
        assert_eq!(runtime.version, "0.161.0");
        assert_eq!(runtime.adapter_version.as_deref(), Some("2.3.0"));
        invalidate();
    }

    #[test]
    fn a_shim_beside_node_modules_resolves_like_windows_npm() {
        let dir = tempfile::tempdir().unwrap();
        let pkg = dir
            .path()
            .join("node_modules/@agentclientprotocol/codex-acp");
        write_package(&pkg, CODEX_ACP_PACKAGE, "2.2.2");
        let codex_dir = pkg.join("node_modules/@openai/codex");
        write_package(&codex_dir, CODEX_PACKAGE, "0.160.1");
        std::fs::create_dir_all(codex_dir.join("bin")).unwrap();
        std::fs::write(codex_dir.join("bin/codex.js"), "").unwrap();
        let shim = dir.path().join("codex-acp.cmd");
        std::fs::write(&shim, "@echo off").unwrap();
        assert_eq!(adapter_dir_for_command(&shim, Some(&shim)), Some(pkg));
    }

    /// A launch command codeg cannot trace to a package (a wrapper script, a
    /// version-manager shim) may run another install than the npm prefix's:
    /// that install can still judge, but is never recorded as the runtime.
    #[test]
    fn a_launch_command_outside_any_package_never_confirms_another_install() {
        let dir = tempfile::tempdir().unwrap();
        let pkg = fake_global_install(&dir.path().join("prefix"), "2.2.2", "0.160.1");
        let wrapper = dir.path().join("bin").join("codex-acp");
        std::fs::create_dir_all(wrapper.parent().unwrap()).unwrap();
        std::fs::write(&wrapper, "#!/bin/sh\nexec somewhere-else \"$@\"\n").unwrap();
        invalidate();
        let runtime = resolve_blocking(Some(wrapper), std::slice::from_ref(&pkg));
        assert!(!runtime.confirmed);
        assert!(runtime.codex_js.is_some(), "still asked");
        assert!(runtime.validated_entry().is_none(), "never recorded");
        invalidate();
    }

    #[test]
    fn falls_back_to_the_npm_prefix_then_to_an_unconfirmed_pin() {
        let dir = tempfile::tempdir().unwrap();
        let pkg = fake_global_install(dir.path(), "2.2.2", "0.160.1");
        invalidate();
        let runtime = resolve_blocking(None, std::slice::from_ref(&pkg));
        assert!(runtime.confirmed);
        assert_eq!(runtime.version, "0.160.1");

        invalidate();
        let runtime = resolve_blocking(None, &[dir.path().join("missing")]);
        assert!(!runtime.confirmed);
        assert!(runtime.codex_js.is_none());
        assert_eq!(
            runtime.version,
            crate::acp::registry::CODEX_NESTED_VERSION_FALLBACK
        );
        assert!(runtime.validated_entry().is_none());
        invalidate();
    }

    #[test]
    fn a_validated_entry_follows_an_in_place_upgrade_and_drops_when_gone() {
        let dir = tempfile::tempdir().unwrap();
        let pkg = fake_global_install(dir.path(), "2.2.2", "0.160.1");
        let js = pkg.join("node_modules/@openai/codex/bin/codex.js");
        let entry = ValidatedRuntime {
            version: "0.160.1".into(),
            codex_js: js.to_string_lossy().into_owned(),
        };
        assert_eq!(entry.refreshed().unwrap().version, "0.160.1");
        write_package(
            &pkg.join("node_modules/@openai/codex"),
            CODEX_PACKAGE,
            "0.160.2",
        );
        assert_eq!(entry.refreshed().unwrap().version, "0.160.2");
        std::fs::remove_file(&js).unwrap();
        assert!(entry.refreshed().is_none());
    }

    /// Against the codex-acp installed on this machine: the judge accepts the
    /// bundled catalog and refuses what codex refuses. `--ignored` only — it
    /// needs a real install.
    #[tokio::test]
    #[ignore]
    async fn the_real_judge_agrees_with_codex() {
        invalidate();
        let runtime = current().await;
        let js = runtime.codex_js.clone().expect("codex-acp installed");
        let good = serde_json::to_vec(&serde_json::json!({
            "models": crate::acp::codex_model_catalog::bundled_snapshot_models()
        }))
        .unwrap();
        assert_eq!(judge(&js, &good).await.unwrap(), 11);
        assert!(matches!(
            judge(&js, br#"{"models":[]}"#).await,
            Err(JudgeError::Rejected(msg)) if msg.contains("at least one model")
        ));
        let mut models = crate::acp::codex_model_catalog::bundled_snapshot_models();
        models[0]["shell_type"] = serde_json::json!("bogus");
        let bad = serde_json::to_vec(&serde_json::json!({ "models": models })).unwrap();
        assert!(matches!(
            judge(&js, &bad).await,
            Err(JudgeError::Rejected(msg)) if msg.contains("bogus")
        ));
    }

    #[test]
    fn complaint_keeps_the_last_lines_bounded() {
        let msg =
            codex_complaint(b"\nwarn: x\nError: unknown variant `bogus`, expected one of\n\n");
        assert_eq!(
            msg,
            "warn: x Error: unknown variant `bogus`, expected one of"
        );
        assert_eq!(codex_complaint(b"  \n"), "codex exited with an error");
        assert!(codex_complaint("é".repeat(2000).as_bytes()).chars().count() <= 500);
    }
}
