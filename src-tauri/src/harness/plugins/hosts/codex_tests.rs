//! The Codex adapter against a stand-in: a fake `codex` (a shell script in
//! the test's own directory, run with nothing of the test's environment)
//! that logs its arguments and edits the test's Codex home the way codex
//! 0.166.0 does (P3 step 5's measurements, `codex.rs`), and answers
//! `app-server`'s `initialize` and `hooks/list`. No real host, no PATH, no
//! real home.
#![cfg(unix)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::codex::{CodexAdapter, MARKETPLACE};
use super::{
    codes, CliVia, Detect, HookTrustState, HostAdapter, HostCx, HostEnv, HostId, HostPlugin,
    SandboxRunner,
};
use crate::harness::plugins::ctx::{InstallName, PluginsCtx};
use crate::harness::plugins::switches::AdapterSwitches;
use crate::process::write_test_script;

/// Codex's plugin commands as 0.166.0 answers them, on `$CODEX_HOME` (else
/// `$HOME/.codex`). Run as the wrapper (`cli …`, whose `--version` is the
/// wrapper's own) or as a native `codex`. `FAKE_FAIL` (a `case` pattern over
/// the arguments) makes a command fail; `FAKE_SLEEP` makes every command
/// slow; `FAKE_VERSION` is what `-V` prints; `FAKE_KEEP_OLD` keeps the cache
/// folder of a version `plugin add` replaced (as 0.149 does).
/// `app-server`: `FAKE_HOOKS` is the hooks `hooks/list` answers;
/// `FAKE_SERVER` `error` answers an error, `exit` quits at once, `silent`
/// never answers (and starts a process of its own, whose pid goes to
/// `$FAKE_PID.child`); `FAKE_PID` gets its pid.
const FAKE_CODEX: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_LOG"
if [ "$1" = "cli" ]; then
  shift
  case " $* " in *" --version "*) echo "@agentclientprotocol/codex-acp 2.7.0"; exit 0;; esac
fi
die() { printf 'Error: %s\n' "$1" >&2; exit 1; }
if [ -n "$FAKE_FAIL" ]; then
  case "$*" in $FAKE_FAIL) printf 'boom: %s\n' "$*" >&2; exit 3;; esac
fi
[ -n "$FAKE_SLEEP" ] && /bin/sleep "$FAKE_SLEEP"
case "$1" in -V|--version) printf 'codex-cli %s\n' "${FAKE_VERSION:-0.166.0}"; exit 0;; esac
if [ -n "$CODEX_HOME" ]; then
  [ -d "$CODEX_HOME" ] || die "CODEX_HOME points to \"$CODEX_HOME\", but that path does not exist"
  C="$CODEX_HOME"
else
  C="$HOME/.codex"; /bin/mkdir -p "$C"
fi
CFG="$C/config.toml"; CACHE="$C/plugins/cache/codeg-harness"
[ -f "$CFG" ] || : > "$CFG"
if [ "$1" = "app-server" ]; then
  [ -n "$FAKE_PID" ] && echo $$ > "$FAKE_PID"
  case "$FAKE_SERVER" in
    exit) exit 0;;
    silent) /bin/sleep 30 & [ -n "$FAKE_PID" ] && echo $! > "$FAKE_PID.child"; exec /bin/sleep 30;;
  esac
  while IFS= read -r line; do
    printf '%s\n' "$line" >> "$FAKE_LOG"
    case "$line" in
      *'"method":"initialize"'*) printf '{"id":1,"result":{"userAgent":"fake/0.166.0"}}\n';;
      *'"method":"hooks/list"'*)
        printf '{"method":"remoteControl/status/changed","params":{"status":"disabled"}}\n'
        if [ "$FAKE_SERVER" = error ]; then
          printf '{"id":2,"error":{"code":-32600,"message":"no hooks here"}}\n'
        else
          printf '{"id":2,"result":{"data":[{"cwd":"x","hooks":%s,"warnings":[],"errors":[]}]}}\n' "${FAKE_HOOKS:-[]}"
        fi;;
    esac
  done
  exit 0
fi
has() { /usr/bin/grep -qxF "[$1]" "$CFG"; }
drop() {
  /usr/bin/awk -v h="[$1]" '$0 == h { s = 1; next } /^\[/ { s = 0 } !s { print }' "$CFG" > "$CFG.tmp" && /bin/mv "$CFG.tmp" "$CFG"
}
value() {
  /usr/bin/awk -v h="[$1]" -v k="$2" '$0 == h { s = 1; next } /^\[/ { s = 0 }
    s && index($0, k " = ") == 1 { v = substr($0, length(k) + 4); gsub(/^"|"$/, "", v); print v; exit }' "$CFG"
}
switch_on() {
  /usr/bin/awk -v h="[$1]" '$0 == h { print; s = 1; d = 0; next }
    /^\[/ { if (s && !d) print "enabled = true"; s = 0 }
    s && /^enabled *=/ { print "enabled = true"; d = 1; next }
    { print } END { if (s && !d) print "enabled = true" }' "$CFG" > "$CFG.tmp" && /bin/mv "$CFG.tmp" "$CFG"
}
[ "$1" = "plugin" ] || die "unknown command: $*"
M="[marketplaces.codeg-harness]"
case "$2" in
  marketplace)
    case "$3" in
      add)
        real=$(cd "$4" && /bin/pwd -P) || die "no such folder: $4"
        if has "marketplaces.codeg-harness"; then
          [ "$(value marketplaces.codeg-harness source)" = "$real" ] || die "marketplace 'codeg-harness' is already added from a different source; remove it before adding this source"
          echo "Marketplace \`codeg-harness\` is already added from $real."
        else
          printf '\n%s\nsource_type = "local"\nsource = "%s"\n' "$M" "$real" >> "$CFG"
          echo "Added marketplace \`codeg-harness\` from $real."
        fi;;
      remove)
        has "marketplaces.$4" || die "marketplace \`$4\` is not configured or installed"
        drop "marketplaces.$4"; echo "Removed marketplace \`$4\`.";;
      *) die "unknown: $*";;
    esac;;
  add)
    key="$3"; name="${key%@*}"
    has "marketplaces.codeg-harness" || die "plugin \`$name\` was not found in marketplace \`codeg-harness\`"
    root=$(value marketplaces.codeg-harness source)
    path=$(/usr/bin/awk -v want="$name" '
      /"name": "/ { s = $0; sub(/.*"name": "/, "", s); sub(/".*/, "", s); cur = s }
      /"path": "/ { s = $0; sub(/.*"path": "/, "", s); sub(/".*/, "", s); if (cur == want) { print s; exit } }' "$root/.agents/plugins/marketplace.json")
    [ -n "$path" ] || die "plugin \`$name\` was not found in marketplace \`codeg-harness\`"
    ver=local
    if [ -f "$root/$path/.codex-plugin/plugin.json" ]; then
      v=$(/usr/bin/sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$root/$path/.codex-plugin/plugin.json")
      [ -n "$v" ] && ver="$v"
    fi
    [ -z "$FAKE_KEEP_OLD" ] && /bin/rm -rf "$CACHE/$name"
    /bin/rm -rf "$CACHE/$name/$ver"; /bin/mkdir -p "$CACHE/$name/$ver"
    /bin/cp -R "$root/$path/." "$CACHE/$name/$ver/"
    if has "plugins.\"$key\""; then switch_on "plugins.\"$key\""; else printf '\n[plugins."%s"]\nenabled = true\n' "$key" >> "$CFG"; fi
    echo "Added plugin \`$name\` from marketplace \`codeg-harness\`.";;
  remove)
    key="$3"; name="${key%@*}"
    has "plugins.\"$key\"" && drop "plugins.\"$key\""
    /bin/rm -rf "$CACHE/$name"
    echo "Removed plugin \`$name\` from marketplace \`codeg-harness\`.";;
  *) die "unknown: $*";;
esac
"#;

const WRAPPER_PACKAGE: &str = "@agentclientprotocol/codex-acp";
const CODEX_PACKAGE: &str = "@openai/codex";
const NAME: &str = "superpowers";
const KEY: &str = "superpowers@codeg-harness";

/// The wrapper as npm installs it under `<root>/npm`, with the codex it
/// bundles (0.166.0) and [`FAKE_CODEX`] as its program. Returns
/// `npm/bin/codex-acp`, a link into the package.
pub(crate) fn fake_codex_wrapper(root: &Path) -> PathBuf {
    // The wrapper as npm installs it, with the codex it bundles.
    let package = root.join("npm/lib/node_modules").join(WRAPPER_PACKAGE);
    fs::create_dir_all(package.join("dist")).unwrap();
    fs::write(
        package.join("package.json"),
        json!({ "name": WRAPPER_PACKAGE, "version": "2.7.0", "bin": { "codex-acp": "dist/index.js" } })
            .to_string(),
    )
    .unwrap();
    write_test_script(&package.join("dist/index.js"), FAKE_CODEX);
    let codex = package.join("node_modules").join(CODEX_PACKAGE);
    fs::create_dir_all(&codex).unwrap();
    fs::write(
        codex.join("package.json"),
        json!({ "name": CODEX_PACKAGE, "version": "0.166.0" }).to_string(),
    )
    .unwrap();
    let bin = root.join("npm/bin");
    fs::create_dir_all(&bin).unwrap();
    let wrapper = bin.join("codex-acp");
    std::os::unix::fs::symlink(
        "../lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
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
    /// The agent's `CODEX_HOME`.
    codex_home: PathBuf,
    log: PathBuf,
    /// `npm/bin/codex-acp`, a link into the wrapper's package.
    wrapper: PathBuf,
    /// `bin/codex`.
    native: PathBuf,
}

fn sandbox() -> Sandbox {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let ctx = PluginsCtx::at(&root.join("codeg"));
    fs::create_dir_all(&ctx.root).unwrap();
    let home = root.join("home");
    let codex_home = home.join("codex-home");
    fs::create_dir_all(&codex_home).unwrap();
    fs::write(
        codex_home.join("config.toml"),
        "# the user's own\nmodel = \"gpt-5.5\"\n\n[plugins.\"theirs@elsewhere\"]\nenabled = true # theirs\n\n[hooks.state.\"theirs@elsewhere:hooks/hooks.json:stop:0:0\"]\ntrusted_hash = \"sha256:theirs\"\n",
    )
    .unwrap();

    let wrapper = fake_codex_wrapper(&root);

    fs::create_dir_all(root.join("bin")).unwrap();
    let native = root.join("bin/codex");
    write_test_script(&native, FAKE_CODEX);

    Sandbox {
        ctx,
        home,
        codex_home,
        log: root.join("argv.log"),
        wrapper,
        native,
        root,
        _dir: dir,
    }
}

impl Sandbox {
    fn env(&self, extra: &[(&str, &str)]) -> HostEnv {
        let codex_home = self.codex_home.to_str().unwrap();
        let log = self.log.to_str().unwrap();
        let home = self.home.to_str().unwrap();
        let mut pairs = vec![
            ("CODEX_HOME", codex_home),
            ("FAKE_LOG", log),
            ("HOME", home),
        ];
        pairs.extend_from_slice(extra);
        HostEnv::sandboxed(&self.home, &pairs)
    }

    fn adapter(&self, wrapper: bool, native: bool) -> CodexAdapter {
        CodexAdapter::sandboxed(
            Arc::new(SandboxRunner::new(&self.root)),
            wrapper.then(|| self.wrapper.clone()),
            native.then(|| self.native.clone()),
        )
    }

    /// Revision `revision` of `name` in the store, its Codex manifest giving
    /// `manifest` (none when `None`).
    fn stage(&self, name: &str, revision: u64, manifest: Option<Value>) {
        self.stage_at(name, revision, ".codex-plugin/plugin.json", manifest);
    }

    fn stage_at(&self, name: &str, revision: u64, path: &str, manifest: Option<Value>) {
        let dir = self.revision_dir(name, revision);
        fs::create_dir_all(dir.join("skills/brainstorming")).unwrap();
        fs::write(
            dir.join("skills/brainstorming/SKILL.md"),
            format!("---\nname: brainstorming\n---\nrevision {revision}\n"),
        )
        .unwrap();
        if let Some(manifest) = manifest {
            let path = dir.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, manifest.to_string()).unwrap();
        }
    }

    fn revision_dir(&self, name: &str, revision: u64) -> PathBuf {
        self.ctx
            .revision_dir(&InstallName::parse(name).unwrap(), revision)
    }

    /// The commands run so far, one line each, and forget them.
    fn take_log(&self) -> Vec<String> {
        let text = fs::read_to_string(&self.log).unwrap_or_default();
        let _ = fs::remove_file(&self.log);
        text.lines().map(str::to_string).collect()
    }

    fn config_text(&self) -> String {
        fs::read_to_string(self.codex_home.join("config.toml")).unwrap()
    }

    fn config(&self) -> toml::Table {
        self.config_text().parse().unwrap()
    }

    fn enabled(&self, key: &str) -> Option<bool> {
        let config = self.config();
        let table = config.get("plugins")?.get(key)?;
        Some(
            table
                .get("enabled")
                .and_then(toml::Value::as_bool)
                .unwrap_or(true),
        )
    }

    fn marketplace_path(&self) -> PathBuf {
        self.ctx.root.join(".agents/plugins/marketplace.json")
    }

    fn marketplace(&self) -> Value {
        serde_json::from_slice(&fs::read(self.marketplace_path()).unwrap()).unwrap()
    }

    fn cache(&self) -> PathBuf {
        self.codex_home.join("plugins/cache").join(MARKETPLACE)
    }

    fn root_text(&self) -> String {
        self.ctx.root.to_str().unwrap().to_string()
    }

    /// Trust Codex keeps for `key`'s hooks, as a user's trusting leaves it.
    fn trust(&self, key: &str, events: &[&str]) {
        let mut text = self.config_text();
        for event in events {
            text.push_str(&format!(
                "\n[hooks.state.\"{key}:hooks/hooks.json:{event}:0:0\"]\ntrusted_hash = \"sha256:a\"\ntrusted_content_hash = \"sha256:b\"\n"
            ));
        }
        fs::write(self.codex_home.join("config.toml"), text).unwrap();
    }
}

fn manifest(name: &str, version: &str) -> Option<Value> {
    Some(json!({ "name": name, "version": version, "skills": "./skills/" }))
}

fn website_switches() -> AdapterSwitches {
    AdapterSwitches::from_config(&json!({
        "plugins": { "adapters": {
            "codex": { "enabled": true, "minVersion": "0.149.1", "maxVersion": null }
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

async fn detect(sandbox: &Sandbox, adapter: &CodexAdapter, env: &HostEnv) -> Detect {
    let detect = adapter.detect(env, &website_switches()).await;
    sandbox.take_log();
    detect
}

fn codes_of(problems: &[crate::harness::mcp::model::Reason]) -> Vec<&str> {
    problems.iter().map(|reason| reason.code.as_str()).collect()
}

#[tokio::test]
async fn install_adds_the_marketplace_then_the_plugin() {
    let s = sandbox();
    let adapter = s.adapter(true, true);
    let env = s.env(&[]);
    let found = adapter.detect(&env, &website_switches()).await;
    assert_eq!(adapter.host(), HostId::Codex);
    assert!(found.supported, "{found:?}");
    assert_eq!(found.version.as_ref().unwrap().to_string(), "0.166.0");
    let cli = found.cli.clone().unwrap();
    assert_eq!(cli.via, CliVia::Wrapper);
    assert_eq!(cli.program, s.wrapper);
    assert!(
        s.take_log().is_empty(),
        "the version came from the bundled codex package"
    );

    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        assert_eq!(adapter.install(&cx, &plugin(&n, 4)).await.unwrap(), NAME);
        assert_eq!(
            s.take_log(),
            vec![
                format!("cli plugin marketplace add {}", s.root_text()),
                format!("cli plugin add {KEY}"),
            ]
        );
        assert_eq!(
            s.marketplace(),
            json!({
                "name": "codeg-harness",
                "plugins": [{ "name": "superpowers",
                              "source": { "source": "local", "path": "./superpowers/4" } }]
            })
        );
        let config = s.config();
        assert_eq!(
            config["marketplaces"][MARKETPLACE]["source"].as_str(),
            Some(s.root_text().as_str())
        );
        assert_eq!(s.enabled(KEY), Some(true));
        assert_eq!(config["model"].as_str(), Some("gpt-5.5"));
        assert!(s
            .cache()
            .join("superpowers/7.0.2/skills/brainstorming/SKILL.md")
            .is_file());
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert!(verify.ok(), "{verify:?}");
        assert_eq!(verify.enabled, Some(true));
        // Nothing of Codeg's in Codex's home but its lock.
        assert!(s.codex_home.join("codeg-codex.lock").exists());
    });
}

#[tokio::test]
async fn installing_again_runs_the_same_commands_and_changes_nothing() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        let config = s.config_text();
        let market = s.marketplace();
        s.take_log();
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(
            s.take_log(),
            vec![
                format!("cli plugin marketplace add {}", s.root_text()),
                format!("cli plugin add {KEY}"),
            ]
        );
        assert_eq!(s.config_text(), config);
        assert_eq!(s.marketplace(), market);
        assert!(adapter.verify(&cx, &plugin(&n, 4)).await.ok());
    });
}

#[tokio::test]
async fn an_update_repoints_the_entry_and_adds_the_plugin_again() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    // As codex 0.149 does it: the old version's folder stays.
    let env = s.env(&[("FAKE_KEEP_OLD", "1")]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    s.stage(NAME, 5, manifest(NAME, "7.0.2"));
    s.stage(NAME, 6, manifest(NAME, "7.1.0"));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        s.take_log();

        // The same manifest version: copied over.
        adapter
            .update(&cx, &plugin(&n, 4), &plugin(&n, 5))
            .await
            .unwrap();
        assert_eq!(s.take_log(), vec![format!("cli plugin add {KEY}")]);
        assert_eq!(
            s.marketplace()["plugins"][0]["source"]["path"],
            "./superpowers/5"
        );
        let skill = s
            .cache()
            .join("superpowers/7.0.2/skills/brainstorming/SKILL.md");
        assert!(fs::read_to_string(&skill).unwrap().contains("revision 5"));
        assert!(adapter.verify(&cx, &plugin(&n, 5)).await.ok());
        let stale = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert_eq!(
            codes_of(&stale.problems),
            vec![codes::MARKETPLACE_SOURCE_MISMATCH]
        );

        // A new version: its own folder, the old one deleted.
        adapter
            .update(&cx, &plugin(&n, 5), &plugin(&n, 6))
            .await
            .unwrap();
        assert!(s.cache().join("superpowers/7.1.0").is_dir());
        assert!(!s.cache().join("superpowers/7.0.2").exists());
        let verify = adapter.verify(&cx, &plugin(&n, 6)).await;
        assert!(verify.ok(), "{verify:?}");

        // Switched off, it stays off: `plugin add` switches it on.
        adapter.disable(&cx, &plugin(&n, 6)).await.unwrap();
        s.stage(NAME, 7, manifest(NAME, "7.1.0"));
        adapter
            .update(&cx, &plugin(&n, 6), &plugin(&n, 7))
            .await
            .unwrap();
        assert_eq!(s.enabled(KEY), Some(false));
        assert_eq!(
            adapter.verify(&cx, &plugin(&n, 7)).await.enabled,
            Some(false)
        );

        // To a revision that is not in the store: refused, nothing changed.
        s.take_log();
        let missing = adapter
            .update(&cx, &plugin(&n, 7), &plugin(&n, 9))
            .await
            .unwrap_err();
        assert_eq!(missing.code, codes::REVISION_MISSING);
        // A revision whose manifest names the plugin differently.
        s.stage(NAME, 8, manifest("superpowers-next", "8.0.0"));
        let renamed = adapter
            .update(&cx, &plugin(&n, 7), &plugin(&n, 8))
            .await
            .unwrap_err();
        assert_eq!(renamed.code, codes::NAME_CHANGED);
        assert_eq!(renamed.params["to"], "superpowers-next");
        assert!(s.take_log().is_empty());
        assert_eq!(
            s.marketplace()["plugins"][0]["source"]["path"],
            "./superpowers/7"
        );
    });
}

#[tokio::test]
async fn disable_and_enable_edit_config_toml_and_keep_the_rest_of_it() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        s.take_log();
        let before = s.config_text();
        adapter.disable(&cx, &plugin(&n, 4)).await.unwrap();
        assert!(s.take_log().is_empty(), "no command: Codex has none for it");
        let after = s.config_text();
        assert_eq!(
            after,
            before.replace(
                "[plugins.\"superpowers@codeg-harness\"]\nenabled = true",
                "[plugins.\"superpowers@codeg-harness\"]\nenabled = false"
            )
        );
        assert!(after.starts_with("# the user's own\n"));
        assert!(after.contains("enabled = true # theirs"));
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert!(verify.ok(), "{verify:?}");
        assert_eq!(verify.enabled, Some(false));
        // Again: nothing to change, nothing written.
        adapter.disable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.config_text(), after);

        adapter.enable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.config_text(), before);
        adapter.enable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.config_text(), before);

        // A table without `enabled` is on; switching it off adds the key.
        let bare = before.replace(
            "[plugins.\"superpowers@codeg-harness\"]\nenabled = true\n",
            "[plugins.\"superpowers@codeg-harness\"]\n",
        );
        fs::write(s.codex_home.join("config.toml"), &bare).unwrap();
        assert_eq!(
            adapter.verify(&cx, &plugin(&n, 4)).await.enabled,
            Some(true)
        );
        adapter.disable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.enabled(KEY), Some(false));

        // The host is gone: still a file edit.
        let none = Detect {
            cli: None,
            ..found.clone()
        };
        let cx2 = HostCx {
            cli: none.cli.as_ref(),
            ..cx
        };
        adapter.enable(&cx2, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.enabled(KEY), Some(true));

        // Not in Codex: refused, nothing written.
        let text = s.config_text();
        fs::write(
            s.codex_home.join("config.toml"),
            text.replace(
                "[plugins.\"superpowers@codeg-harness\"]\nenabled = true\n",
                "",
            ),
        )
        .unwrap();
        let unknown = adapter.disable(&cx, &plugin(&n, 4)).await.unwrap_err();
        assert_eq!(unknown.code, codes::NOT_INSTALLED);
        assert_eq!(s.enabled(KEY), None);
        // Not even Codeg's: refused before anything is read.
        s.stage("other", 1, manifest("other", "1.0.0"));
        let other = name("other");
        let refused = adapter.disable(&cx, &plugin(&other, 1)).await.unwrap_err();
        assert_eq!(refused.code, codes::MARKETPLACE_ENTRY_MISSING);
        assert!(s.take_log().is_empty());
    });
}

#[tokio::test]
async fn uninstalling_the_last_plugin_takes_everything_of_codeg_s_away() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        s.trust(KEY, &["session_start", "user_prompt_submit"]);
        s.take_log();
        adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(
            s.take_log(),
            vec![
                format!("cli plugin remove {KEY}"),
                "cli plugin marketplace remove codeg-harness".to_string(),
            ]
        );
        assert!(!s.marketplace_path().exists());
        assert!(!s.ctx.root.join(".agents").exists());
        assert!(!s.cache().exists());
        let text = s.config_text();
        assert!(!text.contains(MARKETPLACE), "{text}");
        // Everything of the user's and of other marketplaces stays.
        assert!(text.starts_with("# the user's own\nmodel = \"gpt-5.5\"\n"));
        assert!(text.contains("enabled = true # theirs"));
        assert!(text.contains("theirs@elsewhere:hooks/hooks.json:stop:0:0"));
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert_eq!(verify.enabled, None);
        assert!(codes_of(&verify.problems).contains(&codes::NOT_INSTALLED));
        assert!(codes_of(&verify.problems).contains(&codes::MARKETPLACE_NOT_ADDED));

        // Again, by the name the record kept: `plugin remove` is fine with
        // it, `marketplace remove` refuses, there is nothing left — done.
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
async fn uninstalling_one_of_two_keeps_the_marketplace_and_the_other_s_trust() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage("alpha", 1, manifest("alpha", "1.0.0"));
    s.stage("beta", 3, manifest("beta", "2.0.0"));
    let alpha = name("alpha");
    let beta = name("beta");
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&alpha, 1)).await.unwrap();
        adapter.install(&cx, &plugin(&beta, 3)).await.unwrap();
        s.trust("alpha@codeg-harness", &["session_start"]);
        s.trust("beta@codeg-harness", &["session_start"]);
        s.take_log();
        adapter.uninstall(&cx, &plugin(&alpha, 1)).await.unwrap();
        assert_eq!(s.take_log(), vec!["cli plugin remove alpha@codeg-harness"]);
        assert_eq!(
            s.marketplace()["plugins"],
            json!([{ "name": "beta", "source": { "source": "local", "path": "./beta/3" } }])
        );
        assert!(!s.cache().join("alpha").exists());
        assert!(s.cache().join("beta/2.0.0").is_dir());
        let config = s.config();
        let state = config["hooks"]["state"].as_table().unwrap();
        let mut keys: Vec<&str> = state.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "beta@codeg-harness:hooks/hooks.json:session_start:0:0",
                "theirs@elsewhere:hooks/hooks.json:stop:0:0",
            ]
        );
        assert!(adapter.verify(&cx, &plugin(&beta, 3)).await.ok());
    });
}

#[tokio::test]
async fn a_lost_marketplace_file_never_takes_another_plugin_with_it() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage("alpha", 1, manifest("alpha", "1.0.0"));
    s.stage("beta", 3, manifest("beta", "2.0.0"));
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
        // beta is still in Codex's config: the marketplace stays.
        assert_eq!(s.take_log(), vec!["cli plugin remove alpha@codeg-harness"]);
        assert!(!s.cache().join("alpha").exists());
        assert!(s.cache().join("beta/2.0.0").is_dir());
        assert_eq!(s.enabled("beta@codeg-harness"), Some(true));
        assert!(s.config()["marketplaces"].get(MARKETPLACE).is_some());
    });
}

#[tokio::test]
async fn a_failing_or_slow_command_is_a_reason_and_a_retry_finishes_it() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[("FAKE_FAIL", "plugin add*")]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        let reason = adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err();
        assert_eq!(reason.code, codes::COMMAND_FAILED);
        assert_eq!(reason.params["command"], "plugin add");
        assert_eq!(reason.params["status"], "3");
        assert_eq!(
            reason.detail.as_deref(),
            Some(format!("boom: plugin add {KEY}").as_str())
        );
        // Rolled back while the marketplace cannot be removed: the entry
        // stays, so the retry still knows the plugin.
        let failing_remove = s.env(&[("FAKE_FAIL", "plugin marketplace remove*")]);
        let cx2 = HostCx {
            env: &failing_remove,
            ..cx
        };
        let reason = adapter.uninstall(&cx2, &plugin(&n, 4)).await.unwrap_err();
        assert_eq!(reason.params["command"], "plugin marketplace remove");
        assert_eq!(s.marketplace()["plugins"][0]["name"], NAME);
        assert!(s.config()["marketplaces"].get(MARKETPLACE).is_some());
        // What it left — the marketplace — goes with an uninstall.
        let plain = s.env(&[]);
        let cx3 = HostCx { env: &plain, ..cx };
        adapter.uninstall(&cx3, &plugin(&n, 4)).await.unwrap();
        assert!(!s.marketplace_path().exists());
        assert!(!s.config_text().contains(MARKETPLACE));

        // A failing `plugin remove` while Codex still lists the plugin.
        adapter.install(&cx3, &plugin(&n, 4)).await.unwrap();
        let failing = s.env(&[("FAKE_FAIL", "plugin remove*")]);
        let cx4 = HostCx {
            env: &failing,
            ..cx
        };
        let reason = adapter.uninstall(&cx4, &plugin(&n, 4)).await.unwrap_err();
        assert_eq!(reason.params["command"], "plugin remove");
        assert_eq!(s.enabled(KEY), Some(true));
        assert!(s.cache().join("superpowers/7.0.2").is_dir());
        assert_eq!(s.marketplace()["plugins"][0]["name"], NAME);
    });

    // No host to run.
    let none = Detect {
        cli: None,
        ..found.clone()
    };
    let env = s.env(&[]);
    with_cx!(s, env, none, |cx| {
        for reason in [
            adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err(),
            adapter
                .update(&cx, &plugin(&n, 4), &plugin(&n, 4))
                .await
                .unwrap_err(),
            adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap_err(),
        ] {
            assert_eq!(reason.code, codes::HOST_NOT_FOUND);
        }
    });

    // Past its time: stopped.
    let slow = s
        .adapter(true, false)
        .with_timeouts(Duration::from_millis(300), Duration::from_secs(5));
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
async fn a_marketplace_of_codeg_s_name_from_elsewhere_or_a_broken_config_is_refused() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    let n = name(NAME);
    let original = s.config_text();
    with_cx!(s, env, found, |cx| {
        fs::write(
            s.codex_home.join("config.toml"),
            format!("{original}\n[marketplaces.codeg-harness]\nsource_type = \"local\"\nsource = \"/somewhere/else\"\n"),
        )
        .unwrap();
        let reason = adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err();
        assert_eq!(reason.code, codes::MARKETPLACE_ELSEWHERE);
        assert_eq!(reason.params["path"], "/somewhere/else");
        assert!(s.take_log().is_empty(), "refused before any command");
        assert!(!s.marketplace_path().exists(), "no entry claims the name");

        fs::write(s.codex_home.join("config.toml"), "model = ").unwrap();
        let reason = adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err();
        assert_eq!(reason.code, codes::SETTINGS_UNREADABLE);
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert!(codes_of(&verify.problems).contains(&codes::SETTINGS_UNREADABLE));
        assert!(s.take_log().is_empty());
        assert_eq!(s.config_text(), "model = ");

        // A name that is no plain name never reaches a command or a path.
        fs::write(s.codex_home.join("config.toml"), &original).unwrap();
        fs::create_dir_all(s.marketplace_path().parent().unwrap()).unwrap();
        let odd = json!({ "name": "codeg-harness",
            "plugins": [{ "name": "../../kept", "source": { "source": "local", "path": "./superpowers/4" } }] });
        fs::write(s.marketplace_path(), odd.to_string()).unwrap();
        for reason in [
            adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err(),
            adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap_err(),
            adapter.disable(&cx, &plugin(&n, 4)).await.unwrap_err(),
        ] {
            assert_eq!(reason.code, codes::MARKETPLACE_UNREADABLE);
        }
        assert!(s.take_log().is_empty(), "nothing is run on a guess");
    });
}

#[tokio::test]
async fn the_version_gate() {
    let s = sandbox();
    let switches = website_switches();

    // The bundled codex package: read, nothing run.
    let wrapper = s.adapter(true, true);
    let found = wrapper.detect(&s.env(&[]), &switches).await;
    assert!(found.supported);
    assert_eq!(found.version.unwrap().to_string(), "0.166.0");
    assert!(s.take_log().is_empty());

    // The switch off, or no switch at all (the Claude one says nothing of
    // Codex).
    for config in [
        json!({}),
        json!({ "plugins": { "adapters": { "codex": { "enabled": false, "minVersion": null, "maxVersion": null } } } }),
        json!({ "plugins": { "adapters": { "claude": { "enabled": true, "minVersion": null, "maxVersion": null } } } }),
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
        "plugins": { "adapters": { "codex": { "enabled": true, "minVersion": null, "maxVersion": "0.160.0" } } }
    }));
    let why = wrapper.detect(&s.env(&[]), &capped).await.why_not.unwrap();
    assert_eq!(why.code, codes::HOST_VERSION_UNSUPPORTED);
    assert_eq!(why.params["version"], "0.166.0");

    // Another codex named for the wrapper to run: asked through the
    // wrapper with `-V` (its `--version` is the wrapper's own).
    let found = wrapper
        .detect(
            &s.env(&[
                ("CODEX_PATH", "/elsewhere/codex"),
                ("FAKE_VERSION", "0.150.0"),
            ]),
            &switches,
        )
        .await;
    assert_eq!(s.take_log(), vec!["cli -V"]);
    assert_eq!(found.version.unwrap().to_string(), "0.150.0");
    assert!(found.supported);

    // No wrapper: the native CLI, below the minimum.
    let native = s.adapter(false, true);
    let found = native
        .detect(&s.env(&[("FAKE_VERSION", "0.140.0")]), &switches)
        .await;
    assert_eq!(s.take_log(), vec!["--version"]);
    assert_eq!(found.cli.as_ref().unwrap().via, CliVia::Native);
    assert!(found.cli.as_ref().unwrap().prefix.is_empty());
    assert!(!found.supported);
    assert_eq!(found.why_not.unwrap().code, codes::HOST_VERSION_UNSUPPORTED);

    // A version that cannot be read.
    let found = native
        .detect(&s.env(&[("FAKE_VERSION", "nightly")]), &switches)
        .await;
    assert!(found.version.is_none());
    assert_eq!(found.why_not.unwrap().code, codes::HOST_VERSION_UNKNOWN);
    let found = native
        .detect(&s.env(&[("FAKE_FAIL", "--version")]), &switches)
        .await;
    assert_eq!(found.why_not.unwrap().code, codes::HOST_VERSION_UNKNOWN);
    s.take_log();

    // A wrapper whose codex package cannot be found: asked.
    fs::remove_dir_all(
        s.root
            .join("npm/lib/node_modules")
            .join(WRAPPER_PACKAGE)
            .join("node_modules"),
    )
    .unwrap();
    let found = wrapper
        .detect(&s.env(&[("FAKE_VERSION", "0.160.0")]), &switches)
        .await;
    assert_eq!(s.take_log(), vec!["cli -V"]);
    assert_eq!(found.version.unwrap().to_string(), "0.160.0");

    // Neither.
    let found = s.adapter(false, false).detect(&s.env(&[]), &switches).await;
    assert!(found.cli.is_none());
    assert!(!found.supported);
    assert_eq!(found.why_not.unwrap().code, codes::HOST_NOT_FOUND);
}

#[tokio::test]
async fn the_entry_is_named_by_the_plugin_s_codex_manifest() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    let n = name(NAME);
    // The install info's manifest path for `codex`.
    s.stage_at(
        NAME,
        4,
        "codex/manifest.json",
        manifest("sp-codex", "7.0.2"),
    );
    with_cx!(s, env, found, |cx| {
        let at_path = HostPlugin {
            manifest: Some("codex/manifest.json"),
            ..plugin(&n, 4)
        };
        assert_eq!(adapter.install(&cx, &at_path).await.unwrap(), "sp-codex");
        assert_eq!(s.take_log()[1], "cli plugin add sp-codex@codeg-harness");
        assert_eq!(s.marketplace()["plugins"][0]["name"], "sp-codex");
        // The entry's name is what later operations use, manifest or not.
        adapter.disable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.enabled("sp-codex@codeg-harness"), Some(false));

        // Another plugin whose manifest takes the same name: refused.
        s.stage("other", 1, manifest("sp-codex", "1.0.0"));
        let other = name("other");
        let taken = adapter.install(&cx, &plugin(&other, 1)).await.unwrap_err();
        assert_eq!(taken.code, codes::NAME_TAKEN);
        assert_eq!(taken.params["plugin"], NAME);
        // Undoing it touches nothing of the plugin that has the name, not
        // even by a name the record claims that another entry holds.
        s.take_log();
        adapter.uninstall(&cx, &plugin(&other, 1)).await.unwrap();
        let claimed = plugin(&other, 1).with_host_name(Some("sp-codex"));
        adapter.uninstall(&cx, &claimed).await.unwrap();
        assert!(s.take_log().is_empty());
        assert_eq!(s.enabled("sp-codex@codeg-harness"), Some(false));

        // No manifest: `PluginInfo.name`, else the install name.
        s.stage("bare", 2, None);
        let bare = name("bare");
        let named = HostPlugin {
            info_name: Some("bare-info"),
            ..plugin(&bare, 2)
        };
        assert_eq!(adapter.install(&cx, &named).await.unwrap(), "bare-info");
        // Codex keeps a plugin without a version under `local`.
        assert!(s.cache().join("bare-info/local").is_dir());
        assert!(adapter.verify(&cx, &named).await.ok());
        s.stage("plain", 1, None);
        let plain = name("plain");
        let unnamed = HostPlugin {
            info_name: None,
            ..plugin(&plain, 1)
        };
        assert_eq!(adapter.install(&cx, &unnamed).await.unwrap(), "plain");
    });
}

#[tokio::test]
async fn codex_home_is_the_agent_s() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let log = s.log.to_str().unwrap().to_string();
    // No CODEX_HOME: `.codex` in the home the host sees — the agent's own
    // HOME here, not Codeg's.
    let agent_home = s.root.join("agent-home");
    let home = agent_home.to_str().unwrap().to_string();
    let env = HostEnv::sandboxed(
        &s.home,
        &[("FAKE_LOG", log.as_str()), ("HOME", home.as_str())],
    );
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        let config = agent_home.join(".codex/config.toml");
        assert!(fs::read_to_string(&config).unwrap().contains(KEY));
        assert!(!s.home.join(".codex").exists());
        adapter.disable(&cx, &plugin(&n, 4)).await.unwrap();
        assert!(fs::read_to_string(&config)
            .unwrap()
            .contains("enabled = false"));
        assert!(adapter.verify(&cx, &plugin(&n, 4)).await.ok());
        adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap();
        assert!(!agent_home
            .join(".codex/plugins/cache")
            .join(MARKETPLACE)
            .exists());
        assert!(!fs::read_to_string(&config).unwrap().contains(KEY));
    });

    // A relative CODEX_HOME: each session takes it from its own project,
    // so there is no one home to install into.
    let env = s.env(&[("CODEX_HOME", "relative-home")]);
    let relative = adapter.detect(&env, &website_switches()).await;
    s.take_log();
    assert!(!relative.supported);
    let why = relative.why_not.clone().unwrap();
    assert_eq!(why.code, codes::HOST_HOME_RELATIVE);
    assert_eq!(why.params["path"], "relative-home");
    with_cx!(s, env, found, |cx| {
        for reason in [
            adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err(),
            adapter.disable(&cx, &plugin(&n, 4)).await.unwrap_err(),
        ] {
            assert_eq!(reason.code, codes::HOST_HOME_RELATIVE);
        }
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert!(codes_of(&verify.problems).contains(&codes::HOST_HOME_RELATIVE));
        let trust = adapter.hook_trust(&cx, &plugin(&n, 4)).await;
        assert_eq!(trust.problem.unwrap().code, codes::HOST_HOME_RELATIVE);
        assert!(s.take_log().is_empty());
        assert!(!s.ctx.root.join("relative-home").exists());
    });
}

#[tokio::test]
async fn a_marketplace_folder_that_is_a_link_is_never_used() {
    for linked in [".agents", ".agents/plugins"] {
        let s = sandbox();
        let adapter = s.adapter(true, false);
        let env = s.env(&[]);
        let found = detect(&s, &adapter, &env).await;
        s.stage(NAME, 4, manifest(NAME, "7.0.2"));
        let n = name(NAME);
        with_cx!(s, env, found, |cx| {
            adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
            // The folder moved out of the store and linked back in.
            let outside = s.root.join("outside");
            fs::rename(s.ctx.root.join(linked), &outside).unwrap();
            std::os::unix::fs::symlink(&outside, s.ctx.root.join(linked)).unwrap();
            s.take_log();
            for reason in [
                adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap_err(),
                adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err(),
                adapter.disable(&cx, &plugin(&n, 4)).await.unwrap_err(),
                adapter
                    .update(&cx, &plugin(&n, 4), &plugin(&n, 4))
                    .await
                    .unwrap_err(),
            ] {
                assert_eq!(reason.code, codes::MARKETPLACE_UNREADABLE, "{linked}");
            }
            assert!(s.take_log().is_empty());
            assert!(fs::read_dir(&outside).unwrap().next().is_some());
            assert_eq!(s.enabled(KEY), Some(true));
        });
    }
}

/// A hook of `key` as `hooks/list` lists it.
fn listed(key: &str, event: &str, status: &str) -> Value {
    json!({
        "key": format!("{key}:hooks/hooks.json:{event}:0:0"),
        "eventName": event, "handlerType": "command", "source": "plugin",
        "pluginId": key, "enabled": true, "trustStatus": status,
        "currentHash": "sha256:x/sha256:y",
    })
}

fn hooks_file() -> Value {
    json!({ "hooks": {
        "SessionStart": [{ "hooks": [{ "type": "command", "command": "./start.sh" }] }],
        "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "./prompt.sh" }] }],
        "PreToolUse": [
            { "matcher": "Bash", "hooks": [{ "type": "command", "command": "./a.sh" }, { "type": "command", "command": "./b.sh" }] }
        ],
    } })
}

#[tokio::test]
async fn hook_trust_is_read_from_the_app_server_and_never_written() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    let dir = s.revision_dir(NAME, 4);
    fs::create_dir_all(dir.join("hooks")).unwrap();
    fs::write(dir.join("hooks/hooks.json"), hooks_file().to_string()).unwrap();
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        let mut package = CodexAdapter::package_hooks(&cx, &plugin(&n, 4));
        package.sort();
        assert_eq!(
            package,
            vec![
                (
                    format!("{KEY}:hooks/hooks.json:pre_tool_use:0:0"),
                    "pre_tool_use".to_string()
                ),
                (
                    format!("{KEY}:hooks/hooks.json:pre_tool_use:0:1"),
                    "pre_tool_use".to_string()
                ),
                (
                    format!("{KEY}:hooks/hooks.json:session_start:0:0"),
                    "session_start".to_string()
                ),
                (
                    format!("{KEY}:hooks/hooks.json:user_prompt_submit:0:0"),
                    "user_prompt_submit".to_string()
                ),
            ]
        );
        let hooks = json!([
            listed(KEY, "session_start", "trusted"),
            listed(KEY, "user_prompt_submit", "untrusted"),
            listed("theirs@elsewhere", "stop", "trusted"),
            json!({ "key": format!("{KEY}:hooks/hooks.json:pre_tool_use:0:0"), "pluginId": KEY,
                    "trustStatus": "modified" }),
            json!({ "key": format!("{KEY}:hooks/hooks.json:pre_tool_use:0:1"), "pluginId": KEY,
                    "trustStatus": "somethingNew" }),
        ])
        .to_string();
        let config = s.config_text();
        s.take_log();
        let asked = s.env(&[("FAKE_HOOKS", hooks.as_str())]);
        let cx2 = HostCx { env: &asked, ..cx };
        let trust = adapter.hook_trust(&cx2, &plugin(&n, 4)).await;
        assert_eq!(trust.problem, None);
        let states: Vec<(&str, &str, HookTrustState)> = trust
            .hooks
            .iter()
            .map(|hook| {
                (
                    hook.key.rsplit(':').nth(2).unwrap(),
                    hook.event.as_str(),
                    hook.state,
                )
            })
            .collect();
        assert_eq!(
            states,
            vec![
                ("session_start", "session_start", HookTrustState::Trusted),
                (
                    "user_prompt_submit",
                    "user_prompt_submit",
                    HookTrustState::Untrusted
                ),
                ("pre_tool_use", "pre_tool_use", HookTrustState::Modified),
                ("pre_tool_use", "pre_tool_use", HookTrustState::Unknown),
            ]
        );
        assert!(!trust.all_trusted());
        // Through the trait, the same.
        let via_trait = HostAdapter::hook_trust(&adapter, &cx2, &plugin(&n, 4)).await;
        assert_eq!(via_trait, Some(trust));
        // The codex the sessions run, asked about the store's folder; the
        // config untouched.
        let log = s.take_log();
        assert_eq!(log[0], "cli app-server");
        assert!(log[1].contains("\"method\":\"initialize\""));
        assert!(log[3].contains("\"method\":\"hooks/list\""));
        assert!(log[3].contains(&s.root_text()));
        assert_eq!(s.config_text(), config);

        // Codex lists none of them (the plugin is off): what the package
        // has, Unknown.
        let trust = adapter.hook_trust(&cx, &plugin(&n, 4)).await;
        assert_eq!(trust.problem, None);
        assert_eq!(trust.hooks.len(), 4);
        assert!(trust
            .hooks
            .iter()
            .all(|hook| hook.state == HookTrustState::Unknown));
    });
}

#[tokio::test]
async fn hook_trust_that_cannot_be_read_is_unknown() {
    let s = sandbox();
    let adapter = s
        .adapter(true, false)
        .with_timeouts(Duration::from_secs(20), Duration::from_millis(500));
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    let dir = s.revision_dir(NAME, 4);
    fs::create_dir_all(dir.join("hooks")).unwrap();
    fs::write(dir.join("hooks/hooks.json"), hooks_file().to_string()).unwrap();
    let n = name(NAME);
    let pid_file = s.root.join("server.pid");
    let pid_text = pid_file.to_str().unwrap().to_string();
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        for (server, code) in [
            ("error", codes::HOOKS_UNREADABLE),
            ("exit", codes::HOOKS_UNREADABLE),
            ("silent", codes::COMMAND_TIMED_OUT),
        ] {
            let env = s.env(&[("FAKE_SERVER", server), ("FAKE_PID", pid_text.as_str())]);
            let cx2 = HostCx { env: &env, ..cx };
            let started = std::time::Instant::now();
            let trust = adapter.hook_trust(&cx2, &plugin(&n, 4)).await;
            assert!(started.elapsed() < Duration::from_secs(5), "{server}");
            assert_eq!(trust.problem.as_ref().unwrap().code, code, "{server}");
            assert_eq!(trust.hooks.len(), 4);
            assert!(trust
                .hooks
                .iter()
                .all(|hook| hook.state == HookTrustState::Unknown));
            // The server is gone, whatever it did, with what it started.
            let pid: i32 = fs::read_to_string(&pid_file)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            assert!(
                gone(pid).await,
                "{server}: the app-server outlived the read"
            );
            fs::remove_file(&pid_file).unwrap();
            let child = s.root.join("server.pid.child");
            if let Ok(text) = fs::read_to_string(&child) {
                assert!(gone(text.trim().parse().unwrap()).await, "{server}");
                fs::remove_file(&child).unwrap();
            }
        }
        let error = adapter
            .hook_trust(
                &HostCx {
                    env: &s.env(&[("FAKE_SERVER", "error")]),
                    ..cx
                },
                &plugin(&n, 4),
            )
            .await;
        assert_eq!(
            error.problem.unwrap().detail.as_deref(),
            Some("no hooks here")
        );

        // No host to ask.
        let none = Detect {
            cli: None,
            ..found.clone()
        };
        let cx3 = HostCx {
            cli: none.cli.as_ref(),
            ..cx
        };
        let trust = adapter.hook_trust(&cx3, &plugin(&n, 4)).await;
        assert_eq!(trust.problem.unwrap().code, codes::HOST_NOT_FOUND);
        assert_eq!(trust.hooks.len(), 4);
    });
}

#[tokio::test]
async fn the_hooks_a_package_gives_codex() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    with_cx!(s, env, found, |cx| {
        let keys = |name: &str, manifest: Value, files: &[(&str, Value)]| {
            s.stage(name, 1, Some(manifest));
            let dir = s.revision_dir(name, 1);
            for (path, value) in files {
                let path = dir.join(path);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, value.to_string()).unwrap();
            }
            let install = InstallName::parse(name).unwrap();
            CodexAdapter::package_hooks(&cx, &plugin(&install, 1))
                .into_iter()
                .map(|(key, _)| key)
                .collect::<Vec<_>>()
        };
        let one =
            json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "x" }] }] } });
        // No `hooks`: `hooks/hooks.json` when it is there.
        assert_eq!(
            keys(
                "dflt",
                json!({ "name": "dflt" }),
                &[("hooks/hooks.json", one.clone())]
            ),
            vec!["dflt@codeg-harness:hooks/hooks.json:stop:0:0"]
        );
        assert!(keys("nohooks", json!({ "name": "nohooks" }), &[]).is_empty());
        // A path, or several.
        assert_eq!(
            keys(
                "alt",
                json!({ "name": "alt", "hooks": "./cfg/my-hooks.json" }),
                &[("cfg/my-hooks.json", one.clone())]
            ),
            vec!["alt@codeg-harness:cfg/my-hooks.json:stop:0:0"]
        );
        assert_eq!(
            keys(
                "arr",
                json!({ "name": "arr", "hooks": ["./a.json", "./b.json"] }),
                &[("a.json", one.clone()), ("b.json", one.clone())]
            ),
            vec![
                "arr@codeg-harness:a.json:stop:0:0",
                "arr@codeg-harness:b.json:stop:0:0"
            ]
        );
        // Inline; superpowers' `{}` is none (its Claude hooks file is not
        // Codex's).
        assert_eq!(
            keys("inl", json!({ "name": "inl", "hooks": one.clone() }), &[]),
            vec!["inl@codeg-harness:plugin.json#hooks[0]:stop:0:0"]
        );
        assert!(keys(
            "sp",
            json!({ "name": "sp", "hooks": {} }),
            &[("hooks/hooks.json", one.clone())]
        )
        .is_empty());
        // Several inline: one label each.
        assert_eq!(
            keys(
                "il",
                json!({ "name": "il", "hooks": [one.clone(), one.clone()] }),
                &[]
            ),
            vec![
                "il@codeg-harness:plugin.json#hooks[0]:stop:0:0",
                "il@codeg-harness:plugin.json#hooks[1]:stop:0:0"
            ]
        );
        // A path Codex does not take (no `./`): the usual file.
        assert_eq!(
            keys(
                "np",
                json!({ "name": "np", "hooks": "hooks/x.json" }),
                &[
                    ("hooks/x.json", one.clone()),
                    ("hooks/hooks.json", one.clone())
                ]
            ),
            vec!["np@codeg-harness:hooks/hooks.json:stop:0:0"]
        );
        // A list of a path and an object is, to serde, one inline file
        // given as a sequence (`description`, `hooks`) with no hooks: codex
        // 0.166 lists none for it (measured), and nor does this.
        assert!(keys(
            "mx",
            json!({ "name": "mx", "hooks": ["./x.json", one.clone()] }),
            &[("x.json", one.clone()), ("hooks/hooks.json", one.clone())]
        )
        .is_empty());
        // A path out of the package is never read.
        fs::write(s.root.join("outside.json"), one.to_string()).unwrap();
        assert!(keys(
            "out",
            json!({ "name": "out", "hooks": "../../../../outside.json" }),
            &[]
        )
        .is_empty());
    });
}

#[tokio::test]
async fn a_marketplace_of_codeg_s_name_from_elsewhere_is_never_touched() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    s.stage(NAME, 5, manifest(NAME, "7.0.2"));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        // Since then, Codex has `codeg-harness` from another folder, with a
        // plugin of the same name in it.
        let foreign = s.config_text().replace(&s.root_text(), "/somewhere/else");
        fs::write(s.codex_home.join("config.toml"), &foreign).unwrap();
        s.take_log();
        for reason in [
            adapter
                .update(&cx, &plugin(&n, 4), &plugin(&n, 5))
                .await
                .unwrap_err(),
            adapter.disable(&cx, &plugin(&n, 4)).await.unwrap_err(),
        ] {
            assert_eq!(reason.code, codes::MARKETPLACE_ELSEWHERE);
        }
        assert_eq!(
            s.marketplace()["plugins"][0]["source"]["path"],
            "./superpowers/4"
        );
        // Taking it out takes only Codeg's entry: nothing of Codex's.
        adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap();
        assert!(s.take_log().is_empty());
        assert_eq!(s.config_text(), foreign);
        assert!(s.cache().join("superpowers/7.0.2").is_dir());
        assert!(!s.marketplace_path().exists());
    });
}

#[tokio::test]
async fn versions_that_differ_in_case_alone_keep_their_one_folder() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[("FAKE_KEEP_OLD", "1")]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, manifest(NAME, "1.0.0-BETA"));
    s.stage(NAME, 5, manifest(NAME, "1.0.0-beta"));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        adapter
            .update(&cx, &plugin(&n, 4), &plugin(&n, 5))
            .await
            .unwrap();
        assert!(s.cache().join("superpowers/1.0.0-beta").is_dir());
        let verify = adapter.verify(&cx, &plugin(&n, 5)).await;
        assert!(verify.ok(), "{verify:?}");
    });
}

#[tokio::test]
async fn a_linked_cache_folder_is_never_removed_through() {
    for linked in [
        "plugins/cache/codeg-harness",
        "plugins/cache/codeg-harness/superpowers",
    ] {
        let s = sandbox();
        let adapter = s.adapter(true, false);
        let env = s.env(&[("FAKE_KEEP_OLD", "1")]);
        let found = detect(&s, &adapter, &env).await;
        s.stage(NAME, 4, manifest(NAME, "7.0.2"));
        s.stage(NAME, 5, manifest(NAME, "7.1.0"));
        let n = name(NAME);
        with_cx!(s, env, found, |cx| {
            adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
            // Another marketplace's copies, linked in.
            let other = s.root.join("other-cache");
            fs::rename(s.codex_home.join(linked), &other).unwrap();
            std::os::unix::fs::symlink(&other, s.codex_home.join(linked)).unwrap();
            s.take_log();
            if linked.ends_with(MARKETPLACE) {
                let reason = adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap_err();
                assert_eq!(reason.code, codes::HOST_FILES);
                assert!(s.take_log().is_empty(), "refused before any command");
                let reason = adapter
                    .update(&cx, &plugin(&n, 4), &plugin(&n, 5))
                    .await
                    .unwrap_err();
                assert_eq!(reason.code, codes::HOST_FILES);
                assert!(s.take_log().is_empty());
            } else {
                // The plugin's own folder a link: an update is refused
                // before its command; an uninstall takes the link alone.
                let reason = adapter
                    .update(&cx, &plugin(&n, 4), &plugin(&n, 5))
                    .await
                    .unwrap_err();
                assert_eq!(reason.code, codes::HOST_FILES);
                assert!(s.take_log().is_empty());
                assert!(other.join("7.0.2").is_dir());
                adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap();
                assert!(fs::symlink_metadata(s.codex_home.join(linked)).is_err());
            }
            assert!(fs::read_dir(&other).unwrap().next().is_some(), "{linked}");
        });
    }
}

#[tokio::test]
async fn an_update_cut_short_still_leaves_a_plugin_that_was_off_off() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    s.stage(NAME, 5, manifest(NAME, "7.0.2"));
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        adapter.disable(&cx, &plugin(&n, 4)).await.unwrap();
        let failing = s.env(&[("FAKE_FAIL", "plugin add*")]);
        let cx2 = HostCx {
            env: &failing,
            ..cx
        };
        adapter
            .update(&cx2, &plugin(&n, 4), &plugin(&n, 5))
            .await
            .unwrap_err();
        // As if `plugin add` had switched it on before the update stopped.
        let on = s.config_text().replace(
            "[plugins.\"superpowers@codeg-harness\"]\nenabled = false",
            "[plugins.\"superpowers@codeg-harness\"]\nenabled = true",
        );
        fs::write(s.codex_home.join("config.toml"), on).unwrap();
        assert_eq!(s.enabled(KEY), Some(true));
        // The retry knows it was off.
        adapter
            .update(&cx, &plugin(&n, 4), &plugin(&n, 5))
            .await
            .unwrap();
        assert_eq!(s.enabled(KEY), Some(false));
        assert!(!s.ctx.root.join(".codex-off").exists());
        // Switched on by the user since: on it stays.
        adapter.enable(&cx, &plugin(&n, 5)).await.unwrap();
        adapter
            .update(&cx, &plugin(&n, 5), &plugin(&n, 4))
            .await
            .unwrap();
        assert_eq!(s.enabled(KEY), Some(true));
    });
}

#[tokio::test]
async fn a_hook_trust_read_given_up_on_stops_the_app_server() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    let n = name(NAME);
    let pid_file = s.root.join("server.pid");
    let pid_text = pid_file.to_str().unwrap().to_string();
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        let env = s.env(&[("FAKE_SERVER", "silent"), ("FAKE_PID", pid_text.as_str())]);
        let cx2 = HostCx { env: &env, ..cx };
        // The caller stops waiting long before the read's own time is up.
        let given_up = tokio::time::timeout(
            Duration::from_millis(700),
            adapter.hook_trust(&cx2, &plugin(&n, 4)),
        )
        .await;
        assert!(given_up.is_err());
        for file in [pid_file.clone(), s.root.join("server.pid.child")] {
            let pid: i32 = fs::read_to_string(&file).unwrap().trim().parse().unwrap();
            assert!(gone(pid).await, "{} outlived the read", file.display());
        }
    });
}

/// Whether `pid` is gone within a few seconds (a killed process lingers
/// until it is reaped).
async fn gone(pid: i32) -> bool {
    for _ in 0..40 {
        // SAFETY: signal 0 only asks whether the process is there.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

#[tokio::test]
async fn a_marketplace_of_codeg_s_name_in_another_case_is_not_codeg_s() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    let n = name(NAME);
    let foreign = format!(
        "{}\n[marketplaces.Codeg-Harness]\nsource_type = \"local\"\nsource = \"{}\"\n",
        s.config_text(),
        s.root_text()
    );
    fs::write(s.codex_home.join("config.toml"), &foreign).unwrap();
    with_cx!(s, env, found, |cx| {
        let reason = adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err();
        assert_eq!(reason.code, codes::MARKETPLACE_ELSEWHERE);
        let recorded = plugin(&n, 4).with_host_name(Some(NAME));
        adapter.uninstall(&cx, &recorded).await.unwrap();
        assert!(s.take_log().is_empty());
        assert_eq!(s.config_text(), foreign);
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert!(codes_of(&verify.problems).contains(&codes::MARKETPLACE_ELSEWHERE));
    });
}

#[tokio::test]
async fn an_install_over_a_linked_plugin_cache_folder_is_refused() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    let n = name(NAME);
    let other = s.root.join("other-cache");
    fs::create_dir_all(other.join("6.0.0")).unwrap();
    fs::create_dir_all(s.cache()).unwrap();
    std::os::unix::fs::symlink(&other, s.cache().join(NAME)).unwrap();
    with_cx!(s, env, found, |cx| {
        let reason = adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err();
        assert_eq!(reason.code, codes::HOST_FILES);
        assert!(s.take_log().is_empty(), "refused before any command");
        assert!(other.join("6.0.0").is_dir());
        assert!(!s.marketplace_path().exists());
    });
}

#[tokio::test]
async fn an_update_cut_short_in_one_codex_home_leaves_another_alone() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let first = s.env(&[]);
    let found = detect(&s, &adapter, &first).await;
    s.stage(NAME, 4, manifest(NAME, "7.0.2"));
    s.stage(NAME, 5, manifest(NAME, "7.0.2"));
    let n = name(NAME);
    let second_home = s.root.join("second-home");
    fs::create_dir_all(&second_home).unwrap();
    let second = s.env(&[("CODEX_HOME", second_home.to_str().unwrap())]);
    with_cx!(s, first, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        let cx2 = HostCx { env: &second, ..cx };
        adapter.install(&cx2, &plugin(&n, 4)).await.unwrap();
        // Off in the first home; an update there stops after its command.
        adapter.disable(&cx, &plugin(&n, 4)).await.unwrap();
        let failing = s.env(&[("FAKE_FAIL", "plugin add*")]);
        let cx3 = HostCx {
            env: &failing,
            ..cx
        };
        adapter
            .update(&cx3, &plugin(&n, 4), &plugin(&n, 5))
            .await
            .unwrap_err();
        // The second home's copy is on, and an update there keeps it on.
        adapter
            .update(&cx2, &plugin(&n, 4), &plugin(&n, 5))
            .await
            .unwrap();
        let text = fs::read_to_string(second_home.join("config.toml")).unwrap();
        assert!(text.contains("enabled = true"), "{text}");
        assert!(!text.contains("enabled = false"), "{text}");
        // The first home's marker is still there for its own retry.
        adapter
            .update(&cx, &plugin(&n, 5), &plugin(&n, 5))
            .await
            .unwrap();
        assert_eq!(s.enabled(KEY), Some(false));
    });
}

#[tokio::test]
async fn hooks_codex_would_not_read_are_not_the_package_s() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    with_cx!(s, env, found, |cx| {
        let one = json!({ "hooks": {
            "Stop": [{ "hooks": [{ "type": "command", "command": "x" }] }],
            "NotAnEvent": [{ "hooks": [{ "type": "command", "command": "y" }] }],
        } });
        let stage = |name: &str, manifest: Value| {
            s.stage(name, 1, Some(manifest));
            let dir = s.revision_dir(name, 1);
            fs::create_dir_all(dir.join("hooks")).unwrap();
            fs::write(dir.join("hooks/hooks.json"), one.to_string()).unwrap();
            let install = InstallName::parse(name).unwrap();
            CodexAdapter::package_hooks(&cx, &plugin(&install, 1))
                .into_iter()
                .map(|(key, _)| key)
                .collect::<Vec<_>>()
        };
        // Objects that are no hooks file Codex takes: the usual file, and
        // only the events Codex knows.
        assert_eq!(
            stage(
                "bad",
                json!({ "name": "bad", "hooks": [{ "path": "./custom.json" }] })
            ),
            vec!["bad@codeg-harness:hooks/hooks.json:stop:0:0"]
        );
        assert_eq!(
            stage(
                "bad1",
                json!({ "name": "bad1", "hooks": { "path": "./custom.json" } })
            ),
            vec!["bad1@codeg-harness:hooks/hooks.json:stop:0:0"]
        );
        assert_eq!(
            stage(
                "good",
                json!({ "name": "good", "hooks": [{ "description": "d", "hooks": {} }] })
            ),
            Vec::<String>::new()
        );
    });
}

#[tokio::test]
async fn an_inline_hooks_file_codex_refuses_falls_back_like_codex() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    with_cx!(s, env, found, |cx| {
        let one =
            json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "x" }] }] } });
        let keys = |name: &str, hooks: Value, file: Value| {
            s.stage(name, 1, Some(json!({ "name": name, "hooks": hooks })));
            let dir = s.revision_dir(name, 1);
            fs::create_dir_all(dir.join("hooks")).unwrap();
            fs::write(dir.join("hooks/hooks.json"), file.to_string()).unwrap();
            let install = InstallName::parse(name).unwrap();
            CodexAdapter::package_hooks(&cx, &plugin(&install, 1))
                .into_iter()
                .map(|(key, _)| key)
                .collect::<Vec<_>>()
        };
        for (name, bad) in [
            ("null-event", json!([{ "hooks": { "Stop": null } }])),
            (
                "no-command",
                json!([{ "hooks": { "Stop": [{ "hooks": [{ "type": "command" }] }] } }]),
            ),
            (
                "odd-type",
                json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "shell", "command": "x" }] }] } }),
            ),
            (
                "null-input",
                json!([{ "hooks": { "Stop": [{ "hooks": [{ "type": "mcp_tool", "server": "s", "tool": "t", "input": { "a": null } }] }] } }]),
            ),
        ] {
            assert_eq!(
                keys(name, bad, one.clone()),
                vec![format!("{name}@codeg-harness:hooks/hooks.json:stop:0:0")],
                "{name}"
            );
        }
        // A hooks file Codex cannot read gives none.
        assert!(keys(
            "broken-file",
            Value::Null,
            json!({ "hooks": { "Stop": "x" } })
        )
        .is_empty());
        // Handlers of every kind Codex knows count.
        let kinds = json!({ "hooks": { "Stop": [{ "matcher": null, "hooks": [
            { "type": "command", "command": "x", "async": true, "timeout": 5 },
            { "type": "mcp_tool", "server": "s", "tool": "t", "input": { "a": 1 } },
            { "type": "prompt", "prompt": "p" },
            { "type": "agent" }
        ] }] } });
        assert_eq!(keys("kinds", json!([kinds]), json!({})).len(), 4);
    });
}

#[tokio::test]
async fn a_key_given_twice_is_read_as_codex_reads_it() {
    let s = sandbox();
    let adapter = s.adapter(true, false);
    let env = s.env(&[]);
    let found = detect(&s, &adapter, &env).await;
    with_cx!(s, env, found, |cx| {
        let one =
            json!({ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "x" }] }] } });
        s.stage("dup", 1, None);
        let dir = s.revision_dir("dup", 1);
        fs::create_dir_all(dir.join(".codex-plugin")).unwrap();
        fs::write(
            dir.join(".codex-plugin/plugin.json"),
            r#"{ "name": "dup", "hooks": [{ "description": "a", "description": "b" }] }"#,
        )
        .unwrap();
        fs::create_dir_all(dir.join("hooks")).unwrap();
        fs::write(dir.join("hooks/hooks.json"), one.to_string()).unwrap();
        let install = InstallName::parse("dup").unwrap();
        let keys: Vec<String> = CodexAdapter::package_hooks(&cx, &plugin(&install, 1))
            .into_iter()
            .map(|(key, _)| key)
            .collect();
        // Codex refuses the inline file and reads the usual one.
        assert_eq!(keys, vec!["dup@codeg-harness:hooks/hooks.json:stop:0:0"]);
        // A hooks file with a key twice is one Codex cannot read.
        fs::write(
            dir.join("hooks/hooks.json"),
            r#"{ "hooks": {}, "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "x" }] }] } }"#,
        )
        .unwrap();
        assert!(CodexAdapter::package_hooks(&cx, &plugin(&install, 1)).is_empty());
    });
}
