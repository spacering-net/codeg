//! The host adapters against stand-ins: a fake `claude` (a shell script in
//! the test's own directory, run with nothing of the test's environment)
//! that logs its arguments and edits the test's Claude config the way
//! Claude Code 2.1.326 does (design §14 「P3 第 0 步」). No real host, no
//! PATH, no real home.
#![cfg(unix)]

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::claude::{ClaudeAdapter, MARKETPLACE};
use super::{
    codes, trimmed, CliVia, Detect, HostAdapter, HostCx, HostEnv, HostId, HostPlugin, HostRunner,
    ProcessRunner, RunError, SandboxRunner,
};
use crate::acp::opencode_config;
use crate::harness::plugins::ctx::{InstallName, PluginsCtx};
use crate::harness::plugins::switches::AdapterSwitches;
use crate::process::write_test_script;

/// Claude Code's plugin commands as 2.1.326 answers them, on files under
/// `$CLAUDE_CONFIG_DIR` (else `$HOME/.claude`). Its own state is in
/// `<config>/.fake`; the files Codeg reads are written from it after every
/// change. `FAKE_FAIL` (a `case` pattern over the arguments) makes a
/// command fail; `FAKE_SLEEP` makes every command slow; `FAKE_VERSION` is
/// what `--version` prints.
pub(crate) const FAKE_CLAUDE: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_LOG"
[ "$1" = "--cli" ] && shift
if [ -n "$FAKE_FAIL" ]; then
  case "$*" in $FAKE_FAIL) printf 'boom: %s\n' "$*" >&2; exit 3;; esac
fi
[ -n "$FAKE_SLEEP" ] && /bin/sleep "$FAKE_SLEEP"
if [ "$1" = "--version" ]; then
  printf '%s (Claude Code)\n' "${FAKE_VERSION:-2.1.326}"
  exit 0
fi
die() { printf '\033[31m✘ %s\033[0m\n' "$1" >&2; exit 1; }
[ "$1" = "plugin" ] || die "unknown command: $*"
C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
S="$C/.fake"
/bin/mkdir -p "$S/plugins" "$C/plugins"
gen() {
  en=""; inst=""; sep=""
  for f in "$S/plugins/"*; do
    [ -f "$f" ] || continue
    k="${f##*/}"; read -r v < "$f"
    en="$en$sep\"$k\": $v"
    inst="$inst$sep\"$k\": [{\"scope\": \"user\", \"installPath\": \"$C/plugins/cache/codeg-harness/${k%@*}/fake\", \"version\": \"fake\"}]"
    sep=", "
  done
  mk=""; km=""
  if [ -f "$S/market" ]; then
    read -r m < "$S/market"
    mk="\"codeg-harness\": {\"source\": {\"source\": \"directory\", \"path\": \"$m\"}}"
    km="\"codeg-harness\": {\"source\": {\"source\": \"directory\", \"path\": \"$m\"}, \"installLocation\": \"$m\"}"
  fi
  printf '{\n  // the user'"'"'s own\n  "model": "opus",\n  "enabledPlugins": {%s},\n  "extraKnownMarketplaces": {%s}\n}\n' "$en" "$mk" > "$C/settings.json"
  printf '{"version": 2, "plugins": {%s}}\n' "$inst" > "$C/plugins/installed_plugins.json"
  printf '{%s}\n' "$km" > "$C/plugins/known_marketplaces.json"
}
scoped() { case "$*" in *"--scope user"*) ;; *) die "no scope: $*";; esac; }
case "$2" in
  marketplace)
    case "$3" in
      add) printf '%s\n' "$4" > "$S/market"; gen; echo "✔ Successfully added marketplace: codeg-harness";;
      remove)
        [ -f "$S/market" ] || die "Failed to remove marketplace: Marketplace '$4' not found"
        /bin/rm -f "$S/market"; gen;;
      *) die "unknown: $*";;
    esac;;
  install)
    scoped "$@"
    key="$3"; name="${key%@*}"
    [ -f "$S/market" ] || die "Marketplace not found"
    read -r m < "$S/market"
    listing=$(/bin/cat "$m/.claude-plugin/marketplace.json") || die "no marketplace file"
    case "$listing" in *"\"name\": \"$name\""*) ;; *) die "Plugin \"$name\" not found in marketplace";; esac
    [ -f "$S/plugins/$key" ] || echo true > "$S/plugins/$key"
    /bin/mkdir -p "$C/plugins/cache/codeg-harness/$name/fake"
    gen;;
  uninstall)
    scoped "$@"
    key="$3"
    [ -f "$S/plugins/$key" ] || die "Plugin \"$key\" not found in installed plugins"
    /bin/rm -f "$S/plugins/$key"
    : > "$C/plugins/cache/codeg-harness/${key%@*}/fake/.orphaned_at"
    gen;;
  enable|disable)
    scoped "$@"
    key="$3"
    if [ "$2" = enable ]; then want=true; else want=false; fi
    [ -f "$S/plugins/$key" ] || die "Plugin \"$key\" is already ${2}d at user scope"
    read -r v < "$S/plugins/$key"
    [ "$v" = "$want" ] && die "Plugin \"$key\" is already ${2}d"
    echo "$want" > "$S/plugins/$key"
    gen;;
  *) die "unknown: $*";;
esac
"#;

const WRAPPER_PACKAGE: &str = "@agentclientprotocol/claude-agent-acp";
const NAME: &str = "superpowers";

/// The wrapper as npm installs it under `<root>/npm` — Claude Code's SDK
/// beside it (2.1.326) and [`FAKE_CLAUDE`] as its program. Returns
/// `npm/bin/claude-agent-acp`, a link into the package.
pub(crate) fn fake_claude_wrapper(root: &Path) -> PathBuf {
    // The wrapper as npm installs it, with the SDK beside it.
    let package = root.join("npm/lib/node_modules").join(WRAPPER_PACKAGE);
    fs::create_dir_all(package.join("dist")).unwrap();
    fs::write(
        package.join("package.json"),
        json!({ "name": WRAPPER_PACKAGE, "version": "0.109.0", "bin": { "claude-agent-acp": "dist/index.js" } })
            .to_string(),
    )
    .unwrap();
    write_test_script(&package.join("dist/index.js"), FAKE_CLAUDE);
    let sdk = package.join("node_modules/@anthropic-ai/claude-agent-sdk");
    fs::create_dir_all(&sdk).unwrap();
    fs::write(
        sdk.join("package.json"),
        json!({ "name": "@anthropic-ai/claude-agent-sdk", "version": "0.3.326", "claudeCodeVersion": "2.1.326" })
            .to_string(),
    )
    .unwrap();
    let bin = root.join("npm/bin");
    fs::create_dir_all(&bin).unwrap();
    let wrapper = bin.join("claude-agent-acp");
    std::os::unix::fs::symlink(
        "../lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
        &wrapper,
    )
    .unwrap();

    wrapper
}

struct Sandbox {
    _dir: tempfile::TempDir,
    /// The test's directory, its real path.
    root: PathBuf,
    ctx: PluginsCtx,
    home: PathBuf,
    config: PathBuf,
    log: PathBuf,
    /// `npm/bin/claude-agent-acp`, a link into the wrapper's package.
    wrapper: PathBuf,
    /// `bin/claude`.
    native: PathBuf,
    mcp_lock: PathBuf,
}

fn sandbox() -> Sandbox {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let ctx = PluginsCtx::at(&root.join("codeg"));
    fs::create_dir_all(&ctx.root).unwrap();
    let home = root.join("home");
    let config = home.join("claude-config");
    fs::create_dir_all(&config).unwrap();

    let wrapper = fake_claude_wrapper(&root);

    fs::create_dir_all(root.join("bin")).unwrap();
    let native = root.join("bin/claude");
    write_test_script(&native, FAKE_CLAUDE);

    Sandbox {
        ctx,
        home,
        config,
        log: root.join("argv.log"),
        wrapper,
        native,
        mcp_lock: root.join("locks/mcp.lock"),
        root,
        _dir: dir,
    }
}

impl Sandbox {
    fn env(&self, extra: &[(&str, &str)]) -> HostEnv {
        let config = self.config.to_str().unwrap();
        let log = self.log.to_str().unwrap();
        let home = self.home.to_str().unwrap();
        let mut pairs = vec![
            ("CLAUDE_CONFIG_DIR", config),
            ("FAKE_LOG", log),
            ("HOME", home),
        ];
        pairs.extend_from_slice(extra);
        HostEnv::sandboxed(&self.home, &pairs)
    }

    fn adapter(&self, wrapper: bool, native: bool) -> ClaudeAdapter {
        ClaudeAdapter::sandboxed(
            Arc::new(SandboxRunner::new(&self.root)),
            wrapper.then(|| self.wrapper.clone()),
            native.then(|| self.native.clone()),
            self.mcp_lock.clone(),
        )
    }

    /// Revision `revision` of `name` in the store, its Claude manifest
    /// naming it `manifest_name` (none when `None`).
    fn stage(&self, name: &str, revision: u64, manifest_name: Option<&str>) {
        self.stage_at(name, revision, ".claude-plugin/plugin.json", manifest_name);
    }

    fn stage_at(&self, name: &str, revision: u64, manifest: &str, manifest_name: Option<&str>) {
        let dir = self
            .ctx
            .revision_dir(&InstallName::parse(name).unwrap(), revision);
        fs::create_dir_all(dir.join("skills/brainstorming")).unwrap();
        fs::write(
            dir.join("skills/brainstorming/SKILL.md"),
            "---\nname: brainstorming\n---\n",
        )
        .unwrap();
        if let Some(manifest_name) = manifest_name {
            let path = dir.join(manifest);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(
                path,
                json!({ "name": manifest_name, "version": "7.0.2" }).to_string(),
            )
            .unwrap();
        }
    }

    /// The commands run so far, one line each, and forget them.
    fn take_log(&self) -> Vec<String> {
        let text = fs::read_to_string(&self.log).unwrap_or_default();
        let _ = fs::remove_file(&self.log);
        text.lines().map(str::to_string).collect()
    }

    fn settings(&self) -> Value {
        opencode_config::parse(&fs::read_to_string(self.config.join("settings.json")).unwrap())
            .unwrap()
    }

    fn marketplace_path(&self) -> PathBuf {
        self.ctx.root.join(".claude-plugin/marketplace.json")
    }

    fn marketplace(&self) -> Value {
        serde_json::from_slice(&fs::read(self.marketplace_path()).unwrap()).unwrap()
    }

    fn cache(&self) -> PathBuf {
        self.config.join("plugins/cache").join(MARKETPLACE)
    }

    fn root_text(&self) -> String {
        self.ctx.root.to_str().unwrap().to_string()
    }
}

fn website_switches() -> AdapterSwitches {
    AdapterSwitches::from_config(&json!({
        "plugins": { "adapters": {
            "claude": { "enabled": true, "minVersion": "2.1.185", "maxVersion": null }
        } }
    }))
}

fn name(text: &str) -> InstallName {
    InstallName::parse(text).unwrap()
}

/// The plugin as the install info has it (no manifest path: the usual one).
fn plugin(name: &InstallName, revision: u64) -> HostPlugin<'_> {
    HostPlugin {
        name,
        revision,
        manifest: None,
        info_name: Some(NAME),
        host_name: None,
    }
}

/// Run `body` with a [`HostCx`] for `env` and `detect`'s CLI.
macro_rules! with_cx {
    ($sandbox:expr, $env:expr, $detect:expr, |$cx:ident| $body:expr) => {{
        let guard = $sandbox.ctx.lock().await.unwrap();
        let $cx = HostCx {
            ctx: &$sandbox.ctx,
            env: &$env,
            cli: $detect.cli.as_ref(),
            lock: &guard,
        };
        $body
    }};
}

async fn detect(sandbox: &Sandbox, adapter: &ClaudeAdapter, env: &HostEnv) -> Detect {
    let detect = adapter.detect(env, &website_switches()).await;
    sandbox.take_log();
    detect
}

#[tokio::test]
async fn install_writes_the_marketplace_and_runs_the_two_commands() {
    let s = sandbox();
    let adapter = s.adapter(true, true);
    let env = s.env(&[]);
    let found = adapter.detect(&env, &website_switches()).await;
    assert_eq!(adapter.host(), HostId::Claude);
    assert!(found.supported, "{found:?}");
    assert_eq!(found.version.as_ref().unwrap().to_string(), "2.1.326");
    let cli = found.cli.clone().unwrap();
    assert_eq!(cli.via, CliVia::Wrapper);
    assert_eq!(cli.program, s.wrapper);
    assert!(
        s.take_log().is_empty(),
        "the version came from the SDK package"
    );

    s.stage(NAME, 4, Some(NAME));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(
            s.take_log(),
            vec![
                format!("--cli plugin marketplace add {}", s.root_text()),
                "--cli plugin install superpowers@codeg-harness --scope user".to_string(),
            ]
        );
        assert_eq!(
            s.marketplace(),
            json!({
                "name": "codeg-harness",
                "owner": { "name": "Codeg" },
                "plugins": [{ "name": "superpowers", "source": "./superpowers/4" }]
            })
        );
        let settings = s.settings();
        assert_eq!(settings["model"], "opus");
        assert_eq!(
            settings["enabledPlugins"]["superpowers@codeg-harness"],
            true
        );
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert!(verify.ok(), "{verify:?}");
        assert_eq!(verify.enabled, Some(true));
    });
}

#[tokio::test]
async fn installing_again_adds_the_marketplace_again_and_changes_nothing() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, Some(NAME));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        let settings = s.settings();
        let market = s.marketplace();
        s.take_log();
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(
            s.take_log(),
            vec![
                format!("--cli plugin marketplace add {}", s.root_text()),
                "--cli plugin install superpowers@codeg-harness --scope user".to_string(),
            ]
        );
        assert_eq!(s.settings(), settings);
        assert_eq!(s.marketplace(), market);
        assert!(adapter.verify(&cx, &plugin(&n, 4)).await.ok());
    });
}

#[tokio::test]
async fn an_update_only_rewrites_the_source() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, Some(NAME));
    s.stage(NAME, 5, Some(NAME));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        let settings = s.settings();
        s.take_log();
        adapter
            .update(&cx, &plugin(&n, 4), &plugin(&n, 5))
            .await
            .unwrap();
        assert!(s.take_log().is_empty(), "no command");
        assert_eq!(s.settings(), settings);
        assert_eq!(
            s.marketplace()["plugins"],
            json!([{ "name": "superpowers", "source": "./superpowers/5" }])
        );
        assert!(adapter.verify(&cx, &plugin(&n, 5)).await.ok());
        let stale = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert_eq!(
            stale
                .problems
                .iter()
                .map(|r| r.code.as_str())
                .collect::<Vec<_>>(),
            vec![codes::MARKETPLACE_SOURCE_MISMATCH]
        );

        // To a revision that is not in the store: refused, nothing changed.
        let missing = adapter
            .update(&cx, &plugin(&n, 5), &plugin(&n, 6))
            .await
            .unwrap_err();
        assert_eq!(missing.code, codes::REVISION_MISSING);
        assert_eq!(s.marketplace()["plugins"][0]["source"], "./superpowers/5");

        // A revision whose manifest names the plugin differently.
        s.stage(NAME, 7, Some("superpowers-next"));
        let renamed = adapter
            .update(&cx, &plugin(&n, 5), &plugin(&n, 7))
            .await
            .unwrap_err();
        assert_eq!(renamed.code, codes::NAME_CHANGED);
        assert_eq!(renamed.params["to"], "superpowers-next");
        assert_eq!(s.marketplace()["plugins"][0]["source"], "./superpowers/5");
    });
}

#[tokio::test]
async fn disable_and_enable_go_through_the_cli_and_may_be_repeated() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, Some(NAME));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        s.take_log();
        adapter.disable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(
            s.take_log(),
            vec!["--cli plugin disable superpowers@codeg-harness --scope user"]
        );
        assert_eq!(
            s.settings()["enabledPlugins"]["superpowers@codeg-harness"],
            false
        );
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert!(verify.ok(), "{verify:?}");
        assert_eq!(verify.enabled, Some(false));
        // Claude Code refuses to disable it twice; it is disabled.
        adapter.disable(&cx, &plugin(&n, 4)).await.unwrap();

        adapter.enable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(
            s.settings()["enabledPlugins"]["superpowers@codeg-harness"],
            true
        );
        adapter.enable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(
            adapter.verify(&cx, &plugin(&n, 4)).await.enabled,
            Some(true)
        );

        // Not installed at all: refused, nothing run.
        s.stage("other", 1, Some("other"));
        let other = name("other");
        s.take_log();
        let refused = adapter.disable(&cx, &plugin(&other, 1)).await.unwrap_err();
        assert_eq!(refused.code, codes::MARKETPLACE_ENTRY_MISSING);
        assert!(s.take_log().is_empty());
        // Known by the name the record kept, but not in Claude Code.
        let recorded = plugin(&other, 1).with_host_name(Some("other"));
        let refused = adapter.disable(&cx, &recorded).await.unwrap_err();
        assert_eq!(refused.code, codes::COMMAND_FAILED);
    });
}

#[tokio::test]
async fn uninstalling_the_last_plugin_removes_the_marketplace_and_the_cache() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, Some(NAME));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        assert!(s.cache().join("superpowers/fake").is_dir());
        s.take_log();
        adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(
            s.take_log(),
            vec![
                "--cli plugin uninstall superpowers@codeg-harness --scope user".to_string(),
                "--cli plugin marketplace remove codeg-harness".to_string(),
            ]
        );
        assert!(!s.marketplace_path().exists());
        assert!(!s.ctx.root.join(".claude-plugin").exists());
        assert!(!s.cache().exists(), "the orphaned copy is gone");
        let settings = s.settings();
        assert_eq!(settings["enabledPlugins"], json!({}));
        assert_eq!(settings["extraKnownMarketplaces"], json!({}));
        assert_eq!(settings["model"], "opus");
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert_eq!(verify.enabled, None);
        assert!(verify
            .problems
            .iter()
            .any(|r| r.code == codes::NOT_INSTALLED));

        // Again, by the name the record kept: both commands refuse, there
        // is nothing left — done.
        let recorded = plugin(&n, 4).with_host_name(Some(NAME));
        adapter.uninstall(&cx, &recorded).await.unwrap();
        assert_eq!(s.take_log().len(), 2);
        // Without it nothing is provably the plugin's: nothing is run.
        adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap();
        assert!(s.take_log().is_empty());
        // The revision folder is the store's, not the adapter's.
        assert!(s.ctx.revision_dir(&n, 4).is_dir());
    });
}

#[tokio::test]
async fn uninstalling_one_of_two_keeps_the_marketplace() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage("alpha", 1, Some("alpha"));
    s.stage("beta", 3, Some("beta"));
    let alpha = name("alpha");
    let beta = name("beta");
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&alpha, 1)).await.unwrap();
        adapter.install(&cx, &plugin(&beta, 3)).await.unwrap();
        s.take_log();
        adapter.uninstall(&cx, &plugin(&alpha, 1)).await.unwrap();
        assert_eq!(
            s.take_log(),
            vec!["--cli plugin uninstall alpha@codeg-harness --scope user"]
        );
        assert_eq!(
            s.marketplace()["plugins"],
            json!([{ "name": "beta", "source": "./beta/3" }])
        );
        assert!(!s.cache().join("alpha").exists());
        assert!(s.cache().join("beta/fake").is_dir());
        assert!(adapter.verify(&cx, &plugin(&beta, 3)).await.ok());
    });
}

#[tokio::test]
async fn a_failing_or_slow_command_is_a_reason() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[("FAKE_FAIL", "plugin install*")]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, Some(NAME));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        let reason = adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err();
        assert_eq!(reason.code, codes::COMMAND_FAILED);
        assert_eq!(reason.params["command"], "plugin install");
        assert_eq!(reason.params["status"], "3");
        assert_eq!(
            reason.detail.as_deref(),
            Some("boom: plugin install superpowers@codeg-harness --scope user")
        );
        // Rolled back while the marketplace cannot be removed: the entry
        // stays, so the retry still knows the plugin.
        let failing_remove = s.env(&[("FAKE_FAIL", "plugin marketplace remove*")]);
        let cx2 = HostCx {
            ctx: cx.ctx,
            env: &failing_remove,
            cli: cx.cli,
            lock: cx.lock,
        };
        let reason = adapter.uninstall(&cx2, &plugin(&n, 4)).await.unwrap_err();
        assert_eq!(reason.params["command"], "plugin marketplace remove");
        assert_eq!(s.marketplace()["plugins"][0]["name"], "superpowers");
        assert!(s.settings()["extraKnownMarketplaces"][MARKETPLACE].is_object());
        // What it left — the marketplace — goes with an uninstall.
        adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap();
        assert!(!s.marketplace_path().exists());
    });

    // No host to run.
    let none = Detect {
        cli: None,
        ..found.clone()
    };
    let env = s.env(&[]);
    with_cx!(s, env, none, |cx| {
        let reason = adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err();
        assert_eq!(reason.code, codes::HOST_NOT_FOUND);
    });

    // Past its time: stopped.
    let slow = s
        .adapter(true, false)
        .with_timeout(Duration::from_millis(300));
    let env = s.env(&[("FAKE_SLEEP", "5")]);
    with_cx!(s, env, found, |cx| {
        let started = std::time::Instant::now();
        let reason = slow.install(&cx, &plugin(&n, 4)).await.unwrap_err();
        assert_eq!(reason.code, codes::COMMAND_TIMED_OUT);
        assert_eq!(reason.params["command"], "plugin marketplace add");
        assert!(started.elapsed() < Duration::from_secs(4));
    });
}

#[tokio::test]
async fn the_version_gate() {
    let s = sandbox();
    let switches = website_switches();

    // The wrapper's SDK: read, nothing run.
    let wrapper = s.adapter(true, true);
    let found = wrapper.detect(&s.env(&[]), &switches).await;
    assert!(found.supported);
    assert!(s.take_log().is_empty());

    // The switch off, or no switch at all.
    for config in [
        json!({}),
        json!({ "plugins": { "adapters": { "claude": { "enabled": false, "minVersion": null, "maxVersion": null } } } }),
    ] {
        let found = wrapper
            .detect(&s.env(&[]), &AdapterSwitches::from_config(&config))
            .await;
        assert!(!found.supported);
        assert_eq!(found.why_not.unwrap().code, codes::ADAPTER_OFF);
        assert!(
            found.cli.is_some(),
            "the host is still there to take it out"
        );
    }

    // Above the server's maximum.
    let capped = AdapterSwitches::from_config(&json!({
        "plugins": { "adapters": { "claude": { "enabled": true, "minVersion": null, "maxVersion": "2.1.300" } } }
    }));
    let found = wrapper.detect(&s.env(&[]), &capped).await;
    let why = found.why_not.unwrap();
    assert_eq!(why.code, codes::HOST_VERSION_UNSUPPORTED);
    assert_eq!(why.params["version"], "2.1.326");

    // Another CLI named for the wrapper to run: asked through the wrapper.
    let found = wrapper
        .detect(
            &s.env(&[
                ("CLAUDE_CODE_EXECUTABLE", "/elsewhere/claude"),
                ("FAKE_VERSION", "2.1.200"),
            ]),
            &switches,
        )
        .await;
    assert_eq!(s.take_log(), vec!["--cli --version"]);
    assert_eq!(found.version.unwrap().to_string(), "2.1.200");
    assert!(found.supported);

    // No wrapper: the native CLI, below the minimum.
    let native = s.adapter(false, true);
    let found = native
        .detect(&s.env(&[("FAKE_VERSION", "2.1.100")]), &switches)
        .await;
    assert_eq!(s.take_log(), vec!["--version"]);
    assert_eq!(found.cli.as_ref().unwrap().via, CliVia::Native);
    assert!(!found.supported);
    assert_eq!(found.why_not.unwrap().code, codes::HOST_VERSION_UNSUPPORTED);

    // A home that is not there yet: the probe still runs.
    let fresh = s.root.join("not-yet");
    let log = s.log.to_str().unwrap().to_string();
    let fresh_text = fresh.to_str().unwrap().to_string();
    let found = native
        .detect(
            &HostEnv::sandboxed(
                &fresh,
                &[("FAKE_LOG", log.as_str()), ("HOME", fresh_text.as_str())],
            ),
            &switches,
        )
        .await;
    assert!(found.supported, "{found:?}");
    assert!(!fresh.exists());
    s.take_log();

    // A version that cannot be read.
    let found = native
        .detect(&s.env(&[("FAKE_VERSION", "nightly")]), &switches)
        .await;
    assert!(!found.supported);
    assert!(found.version.is_none());
    assert_eq!(found.why_not.unwrap().code, codes::HOST_VERSION_UNKNOWN);
    let found = native
        .detect(&s.env(&[("FAKE_FAIL", "--version")]), &switches)
        .await;
    assert_eq!(found.why_not.unwrap().code, codes::HOST_VERSION_UNKNOWN);
    s.take_log();

    // A wrapper whose SDK cannot be found: asked.
    fs::remove_dir_all(
        s.root
            .join("npm/lib/node_modules")
            .join(WRAPPER_PACKAGE)
            .join("node_modules"),
    )
    .unwrap();
    let found = wrapper
        .detect(&s.env(&[("FAKE_VERSION", "2.1.190")]), &switches)
        .await;
    assert_eq!(s.take_log(), vec!["--cli --version"]);
    assert_eq!(found.version.unwrap().to_string(), "2.1.190");

    // Neither.
    let found = s.adapter(false, false).detect(&s.env(&[]), &switches).await;
    assert!(found.cli.is_none());
    assert!(!found.supported);
    assert_eq!(found.why_not.unwrap().code, codes::HOST_NOT_FOUND);
}

#[tokio::test]
async fn the_entry_is_named_by_the_plugin_s_claude_manifest() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    let n = name(NAME);
    // The install info's manifest path for `claude`.
    s.stage_at(NAME, 4, "claude/manifest.json", Some("sp-claude"));
    with_cx!(s, env, found, |cx| {
        let at_path = HostPlugin {
            manifest: Some("claude/manifest.json"),
            ..plugin(&n, 4)
        };
        assert_eq!(adapter.install(&cx, &at_path).await.unwrap(), "sp-claude");
        assert_eq!(
            s.take_log()[1],
            "--cli plugin install sp-claude@codeg-harness --scope user"
        );
        assert_eq!(
            s.marketplace()["plugins"],
            json!([{ "name": "sp-claude", "source": "./superpowers/4" }])
        );
        // The entry's name is what later commands use, manifest or not.
        adapter.disable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(
            s.settings()["enabledPlugins"]["sp-claude@codeg-harness"],
            false
        );
        assert!(adapter.verify(&cx, &plugin(&n, 4)).await.ok());

        // Another plugin whose manifest takes the same name: refused.
        s.stage("other", 1, Some("sp-claude"));
        let other = name("other");
        let taken = adapter.install(&cx, &plugin(&other, 1)).await.unwrap_err();
        assert_eq!(taken.code, codes::NAME_TAKEN);
        assert_eq!(taken.params["plugin"], NAME);
        // Its install never ran a command; undoing it touches nothing of the
        // plugin that has the name.
        s.take_log();
        adapter.uninstall(&cx, &plugin(&other, 1)).await.unwrap();
        let refused = adapter.disable(&cx, &plugin(&other, 1)).await.unwrap_err();
        assert_eq!(refused.code, codes::MARKETPLACE_ENTRY_MISSING);
        // Not even by a name the record claims that another entry holds.
        let claimed = plugin(&other, 1).with_host_name(Some("sp-claude"));
        adapter.uninstall(&cx, &claimed).await.unwrap();
        let refused = adapter.disable(&cx, &claimed).await.unwrap_err();
        assert_eq!(refused.code, codes::MARKETPLACE_ENTRY_MISSING);
        assert!(s.take_log().is_empty());
        assert_eq!(
            s.settings()["enabledPlugins"]["sp-claude@codeg-harness"],
            false
        );
        assert!(s.cache().join("sp-claude/fake").is_dir());
        assert_eq!(s.marketplace()["plugins"].as_array().unwrap().len(), 1);

        // No manifest: `PluginInfo.name`, else the install name.
        s.stage("bare", 2, None);
        let bare = name("bare");
        let named = HostPlugin {
            info_name: Some("bare-info"),
            ..plugin(&bare, 2)
        };
        adapter.install(&cx, &named).await.unwrap();
        let plain = name("plain");
        let unnamed = HostPlugin {
            info_name: None,
            ..plugin(&plain, 1)
        };
        s.stage("plain", 1, None);
        adapter.install(&cx, &unnamed).await.unwrap();
        let names: Vec<Value> = s.marketplace()["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].clone())
            .collect();
        assert_eq!(
            names,
            vec![json!("sp-claude"), json!("bare-info"), json!("plain")]
        );
    });
}

#[tokio::test]
async fn the_default_config_folder_is_under_the_home() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let log = s.log.to_str().unwrap().to_string();
    // No CLAUDE_CONFIG_DIR: `.claude` in the home the host sees — the
    // agent's own HOME here, not Codeg's.
    let agent_home = s.root.join("agent-home");
    let home = agent_home.to_str().unwrap().to_string();
    let env = HostEnv::sandboxed(
        &s.home,
        &[("FAKE_LOG", log.as_str()), ("HOME", home.as_str())],
    );
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, Some(NAME));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        assert!(agent_home.join(".claude/settings.json").is_file());
        assert!(!s.home.join(".claude").exists());
        assert!(adapter.verify(&cx, &plugin(&n, 4)).await.ok());
        adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap();
        assert!(!agent_home
            .join(".claude/plugins/cache")
            .join(MARKETPLACE)
            .exists());
    });
}

#[tokio::test]
async fn a_relative_config_folder_is_refused() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    s.stage(NAME, 4, Some(NAME));
    let n = name(NAME);
    let found = detect(&s, &adapter, &s.env(&[])).await;
    assert!(found.supported, "{found:?}");
    // A relative CLAUDE_CONFIG_DIR: each session takes it from its own
    // project, so there is no one config to install into.
    let env = s.env(&[("CLAUDE_CONFIG_DIR", "relative-config")]);
    let relative = detect(&s, &adapter, &env).await;
    assert!(!relative.supported);
    assert_eq!(relative.version, found.version);
    let why = relative.why_not.clone().unwrap();
    assert_eq!(why.code, codes::HOST_HOME_RELATIVE);
    assert_eq!(why.params["variable"], "CLAUDE_CONFIG_DIR");
    assert_eq!(why.params["path"], "relative-config");
    with_cx!(s, env, found, |cx| {
        for reason in [
            adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err(),
            adapter.enable(&cx, &plugin(&n, 4)).await.unwrap_err(),
            adapter.disable(&cx, &plugin(&n, 4)).await.unwrap_err(),
            adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap_err(),
        ] {
            assert_eq!(reason.code, codes::HOST_HOME_RELATIVE);
        }
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert!(verify
            .problems
            .iter()
            .any(|reason| reason.code == codes::HOST_HOME_RELATIVE));
        assert!(s.take_log().is_empty(), "no command ran");
        assert!(!s.marketplace_path().exists(), "the store is untouched");
        assert!(!s.ctx.root.join("relative-config").exists());
    });
}

#[tokio::test]
async fn a_lost_marketplace_file_never_takes_another_plugin_with_it() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage("alpha", 1, Some("alpha"));
    s.stage("beta", 3, Some("beta"));
    let alpha = name("alpha");
    let beta = name("beta");
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&alpha, 1)).await.unwrap();
        adapter.install(&cx, &plugin(&beta, 3)).await.unwrap();
        fs::remove_file(s.marketplace_path()).unwrap();
        s.take_log();
        // No entry and no recorded name: nothing is provably alpha's.
        adapter.uninstall(&cx, &plugin(&alpha, 1)).await.unwrap();
        assert!(s.take_log().is_empty());
        let recorded = plugin(&alpha, 1).with_host_name(Some("alpha"));
        adapter.uninstall(&cx, &recorded).await.unwrap();
        assert_eq!(
            s.take_log(),
            vec!["--cli plugin uninstall alpha@codeg-harness --scope user"]
        );
        assert!(!s.cache().join("alpha").exists());
        assert!(s.cache().join("beta/fake").is_dir());
        let settings = s.settings();
        assert_eq!(settings["enabledPlugins"]["beta@codeg-harness"], true);
        assert!(settings["extraKnownMarketplaces"][MARKETPLACE].is_object());
    });
}

#[tokio::test]
async fn verify_reports_a_marketplace_elsewhere_and_an_unreadable_one() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, Some(NAME));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        let settings = s.config.join("settings.json");
        let text = fs::read_to_string(&settings).unwrap();
        fs::write(&settings, text.replace(&s.root_text(), "/somewhere/else")).unwrap();
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert_eq!(verify.problems.len(), 1, "{verify:?}");
        assert_eq!(verify.problems[0].code, codes::MARKETPLACE_ELSEWHERE);
        assert_eq!(verify.problems[0].params["path"], "/somewhere/else");

        fs::write(&settings, "{ not json").unwrap();
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert_eq!(verify.problems[0].code, codes::SETTINGS_UNREADABLE);
        assert_eq!(verify.enabled, None);

        fs::write(s.marketplace_path(), "[]").unwrap();
        let reason = adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err();
        assert_eq!(reason.code, codes::MARKETPLACE_UNREADABLE);
        assert_eq!(fs::read_to_string(s.marketplace_path()).unwrap(), "[]");

        // A name that is no plain name never reaches a command or a path.
        fs::write(&settings, "{}").unwrap();
        let outside = s.config.join("plugins/kept");
        fs::create_dir_all(&outside).unwrap();
        let odd = json!({ "name": "codeg-harness", "owner": { "name": "Codeg" },
            "plugins": [{ "name": "../../kept", "source": "./superpowers/4" }] });
        fs::write(s.marketplace_path(), odd.to_string()).unwrap();
        s.take_log();
        let reason = adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err();
        assert_eq!(reason.code, codes::MARKETPLACE_UNREADABLE);
        assert!(s.take_log().is_empty());
        let reason = adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap_err();
        assert_eq!(reason.code, codes::MARKETPLACE_UNREADABLE);
        assert!(s.take_log().is_empty(), "nothing is run on a guess");
        assert!(outside.is_dir());
    });
}

#[tokio::test]
async fn a_marketplace_folder_that_is_a_link_is_never_used() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, Some(NAME));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        // The folder moved out of the store and linked back in.
        let outside = s.root.join("outside");
        fs::rename(s.ctx.root.join(".claude-plugin"), &outside).unwrap();
        std::os::unix::fs::symlink(&outside, s.ctx.root.join(".claude-plugin")).unwrap();
        s.take_log();
        for reason in [
            adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap_err(),
            adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err(),
            adapter.disable(&cx, &plugin(&n, 4)).await.unwrap_err(),
        ] {
            assert_eq!(reason.code, codes::MARKETPLACE_UNREADABLE);
        }
        assert!(s.take_log().is_empty());
        assert!(outside.join("marketplace.json").is_file());
    });
}

#[tokio::test]
async fn the_sandbox_runner_runs_nothing_outside_the_test_s_directory() {
    let s = sandbox();
    let runner = SandboxRunner::new(&s.root);
    let env = s.env(&[]);
    for program in ["/bin/sh", "sh", "../bin/claude"] {
        let outcome = runner
            .run(
                Path::new(program),
                &[],
                &env,
                &s.root,
                Duration::from_secs(5),
            )
            .await;
        assert!(matches!(outcome, Err(RunError::NotStarted(_))), "{program}");
    }
    // A link out of it is outside it.
    let out = s.root.join("bin/out");
    std::os::unix::fs::symlink("/bin/sh", &out).unwrap();
    let outcome = runner
        .run(&out, &[], &env, &s.root, Duration::from_secs(5))
        .await;
    assert!(matches!(outcome, Err(RunError::NotStarted(_))));
}

#[tokio::test]
async fn the_process_runner_lays_the_agent_s_overrides_over_codeg_s_environment() {
    let s = sandbox();
    let script = s.root.join("bin/env-probe");
    write_test_script(
        &script,
        "#!/bin/sh\nprintf '%s|%s|%s|%s\\n' \"$PROBE_SET\" \"${HOME-unset}\" \"${CODEG_LAUNCH_X-unset}\" \"$1\"\nprintf 'to stderr\\n' >&2\nexit 4\n",
    );
    let env = HostEnv {
        overrides: BTreeMap::from([
            ("PROBE_SET".to_string(), "set".to_string()),
            ("HOME".to_string(), String::new()),
            ("CODEG_LAUNCH_X".to_string(), "launch only".to_string()),
        ]),
        ..HostEnv::sandboxed(&s.home, &[])
    };
    let output = ProcessRunner
        .run(
            &script,
            &[OsString::from("arg one")],
            &env,
            &s.root,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
    assert_eq!(output.status.code(), Some(4));
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "set|unset|unset|arg one\n"
    );
    assert_eq!(String::from_utf8_lossy(&output.stderr), "to stderr\n");
}

#[tokio::test]
async fn a_command_past_its_time_is_stopped_with_everything_it_started() {
    let s = sandbox();
    let script = s.root.join("bin/stubborn");
    // It and the process it starts ignore SIGTERM; the latter writes a file
    // a second later, from a parent that is gone by then.
    write_test_script(
        &script,
        "#!/bin/sh\ntrap '' TERM\n( trap '' TERM; /bin/sleep 1; : > \"$MARK\" ) &\n/bin/sleep 5\n",
    );
    let mark = s.root.join("written");
    let env = HostEnv::sandboxed(&s.home, &[("MARK", mark.to_str().unwrap())]);
    let outcome = SandboxRunner::new(&s.root)
        .run(&script, &[], &env, &s.root, Duration::from_millis(200))
        .await;
    assert!(matches!(outcome, Err(RunError::TimedOut)));
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(!mark.exists(), "a process it started outlived the stop");
}

#[test]
fn command_output_is_trimmed_for_a_person() {
    assert_eq!(
        trimmed(b"\n  \x1b[31m\xe2\x9c\x98 failed\x1b[0m \r\n"),
        "✘ failed"
    );
    let long = "x".repeat(5000) + "END";
    let out = trimmed(long.as_bytes());
    assert!(out.starts_with('…'));
    assert!(out.ends_with("END"));
    assert_eq!(out.chars().count(), 2001);
}

#[test]
fn hosts_by_agent() {
    use crate::models::agent::AgentType;
    assert_eq!(
        HostId::for_agent(AgentType::ClaudeCode),
        Some(HostId::Claude)
    );
    assert_eq!(HostId::for_agent(AgentType::Codex), Some(HostId::Codex));
    assert_eq!(
        HostId::for_agent(AgentType::OpenCode),
        Some(HostId::OpenCode)
    );
    assert_eq!(HostId::for_agent(AgentType::Gemini), None);
    assert_eq!(HostId::Claude.as_str(), "claude");
}
