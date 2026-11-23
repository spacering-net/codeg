//! The OpenCode adapter on config files in the test's own directory: no
//! OpenCode, no command of any kind, no PATH, no real home.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::opencode::OpenCodeAdapter;
use super::{codes, Detect, HostAdapter, HostCx, HostEnv, HostId, HostPlugin};
use crate::acp::opencode_config;
use crate::harness::mcp::model::Reason;
use crate::harness::plugins::ctx::{InstallName, PluginsCtx};
use crate::harness::plugins::switches::AdapterSwitches;
use crate::harness::types::{InstallInfo, PluginInfo};

const NAME: &str = "superpowers";
/// The variable the agent's home comes from ([`HostEnv::child_home`]).
const HOME_VAR: &str = if cfg!(windows) { "USERPROFILE" } else { "HOME" };

struct Sandbox {
    _dir: tempfile::TempDir,
    /// The test's directory, its real path.
    root: PathBuf,
    ctx: PluginsCtx,
    /// Codeg's home in the test: nothing may appear under it.
    home: PathBuf,
    /// The agent's `XDG_CONFIG_HOME`.
    xdg: PathBuf,
    mcp_lock: PathBuf,
}

fn sandbox() -> Sandbox {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let ctx = PluginsCtx::at(&root.join("codeg"));
    fs::create_dir_all(&ctx.root).unwrap();
    let home = root.join("home");
    fs::create_dir_all(&home).unwrap();
    Sandbox {
        ctx,
        home,
        xdg: root.join("xdg"),
        mcp_lock: root.join("locks/mcp.lock"),
        root,
        _dir: dir,
    }
}

impl Sandbox {
    /// The agent's environment: its `XDG_CONFIG_HOME` and `extra`.
    fn env(&self, extra: &[(&str, &str)]) -> HostEnv {
        let xdg = self.xdg.to_str().unwrap();
        let mut pairs = vec![("XDG_CONFIG_HOME", xdg)];
        pairs.extend_from_slice(extra);
        HostEnv::sandboxed(&self.home, &pairs)
    }

    fn adapter(&self) -> OpenCodeAdapter {
        self.adapter_at(Some("2.3.2"))
    }

    fn adapter_at(&self, version: Option<&str>) -> OpenCodeAdapter {
        OpenCodeAdapter::sandboxed(
            Some(self.root.join("bin/opencode")),
            version,
            self.mcp_lock.clone(),
        )
    }

    /// Revision `revision` of `name` in the store, with `index.js`.
    fn stage(&self, name: &str, revision: u64) -> PathBuf {
        let dir = self.stage_bare(name, revision);
        fs::write(dir.join("index.js"), "export default {}\n").unwrap();
        dir
    }

    /// Revision `revision` of `name` in the store, with no code.
    fn stage_bare(&self, name: &str, revision: u64) -> PathBuf {
        let dir = self
            .ctx
            .revision_dir(&InstallName::parse(name).unwrap(), revision);
        fs::create_dir_all(dir.join("skills/brainstorming")).unwrap();
        fs::write(
            dir.join("skills/brainstorming/SKILL.md"),
            "---\nname: brainstorming\n---\n",
        )
        .unwrap();
        dir
    }

    fn rev(&self, name: &str, revision: u64) -> String {
        self.ctx
            .revision_dir(&InstallName::parse(name).unwrap(), revision)
            .to_str()
            .unwrap()
            .to_string()
    }

    fn config_dir(&self) -> PathBuf {
        self.xdg.join("opencode")
    }

    fn write_config(&self, file: &str, text: &str) -> PathBuf {
        let path = self.config_dir().join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        path
    }

    fn plugins_in(&self, path: &Path) -> Value {
        opencode_config::parse(&fs::read_to_string(path).unwrap()).unwrap()["plugins"].clone()
    }
}

fn website_switches() -> AdapterSwitches {
    AdapterSwitches::from_config(&json!({
        "plugins": { "adapters": {
            "opencode": { "enabled": true, "minVersion": "2.3.2", "maxVersion": null }
        } }
    }))
}

fn name(text: &str) -> InstallName {
    InstallName::parse(text).unwrap()
}

fn plugin(name: &InstallName, revision: u64) -> HostPlugin<'_> {
    HostPlugin {
        name,
        revision,
        manifest: None,
        info_name: Some(NAME),
        host_name: None,
    }
}

fn codes_of(problems: &[Reason]) -> Vec<&str> {
    problems.iter().map(|reason| reason.code.as_str()).collect()
}

/// Run `body` with a [`HostCx`] for `env` and `detect`'s binary.
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

async fn detect(adapter: &OpenCodeAdapter, env: &HostEnv) -> Detect {
    adapter.detect(env, &website_switches()).await
}

const USER_CONFIG: &str = r#"{
  // My OpenCode setup.
  "model": "anthropic/claude-sonnet-5-5", // the default model
  "plugins": [
    "oh-my-opencode", // keep this one
  ],
  /* trailing block comment */
}
"#;

#[tokio::test]
async fn install_adds_the_folder_and_keeps_the_user_s_comments() {
    let s = sandbox();
    let adapter = s.adapter();
    let env = s.env(&[]);
    let found = detect(&adapter, &env).await;
    assert_eq!(adapter.host(), HostId::OpenCode);
    assert!(found.supported, "{found:?}");
    assert_eq!(found.version.as_ref().unwrap().to_string(), "2.3.2");
    s.stage(NAME, 4);
    let config = s.write_config("opencode.jsonc", USER_CONFIG);
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        let host_name = adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(host_name, NAME);
        let text = fs::read_to_string(&config).unwrap();
        for comment in [
            "// My OpenCode setup.",
            "// the default model",
            "// keep this one",
            "/* trailing block comment */",
        ] {
            assert!(text.contains(comment), "{comment} lost:\n{text}");
        }
        assert_eq!(
            s.plugins_in(&config),
            json!(["oh-my-opencode", s.rev(NAME, 4)])
        );
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert!(verify.ok(), "{verify:?}");
        assert_eq!(verify.enabled, Some(true));
    });
    assert!(!s.config_dir().join("opencode.json").exists());
    assert_eq!(fs::read_dir(&s.home).unwrap().count(), 0);
}

#[tokio::test]
async fn installing_or_enabling_again_changes_nothing() {
    let s = sandbox();
    let adapter = s.adapter();
    let env = s.env(&[]);
    let found = detect(&adapter, &env).await;
    s.stage(NAME, 4);
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        // No config yet: OpenCode's first file is made.
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        let config = s.config_dir().join("opencode.json");
        let before = fs::read(&config).unwrap();
        assert_eq!(s.plugins_in(&config), json!([s.rev(NAME, 4)]));
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        adapter.enable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(fs::read(&config).unwrap(), before, "not even the bytes");
    });
}

#[tokio::test]
async fn an_update_swaps_the_path_in_its_place() {
    let s = sandbox();
    let adapter = s.adapter();
    let env = s.env(&[]);
    let found = detect(&adapter, &env).await;
    s.stage(NAME, 4);
    s.stage(NAME, 5);
    let n = name(NAME);
    // The paths as JSON writes them (a Windows path's `\` escaped).
    let literal = |revision| serde_json::to_string(&s.rev(NAME, revision)).unwrap();
    let original = format!(
        "{{\n  \"plugins\": [\n    \"first\", // before\n    {}, // Codeg's\n    \"last\", // after\n  ],\n}}\n",
        literal(4)
    );
    let config = s.write_config("opencode.jsonc", &original);
    with_cx!(s, env, found, |cx| {
        adapter
            .update(&cx, &plugin(&n, 4), &plugin(&n, 5))
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            original.replace(&literal(4), &literal(5)),
            "one path changed, nothing else"
        );
        assert!(adapter.verify(&cx, &plugin(&n, 5)).await.ok());
        // Done already: nothing changes.
        let before = fs::read(&config).unwrap();
        adapter
            .update(&cx, &plugin(&n, 4), &plugin(&n, 5))
            .await
            .unwrap();
        assert_eq!(fs::read(&config).unwrap(), before);

        // Switched off (no entry): an update adds none.
        adapter.disable(&cx, &plugin(&n, 5)).await.unwrap();
        s.stage(NAME, 6);
        adapter
            .update(&cx, &plugin(&n, 5), &plugin(&n, 6))
            .await
            .unwrap();
        assert_eq!(s.plugins_in(&config), json!(["first", "last"]));

        // An update to a folder that is not there changes nothing.
        adapter.enable(&cx, &plugin(&n, 6)).await.unwrap();
        let before = fs::read(&config).unwrap();
        let reason = adapter
            .update(&cx, &plugin(&n, 6), &plugin(&n, 9))
            .await
            .unwrap_err();
        assert_eq!(reason.code, codes::REVISION_MISSING);
        assert_eq!(fs::read(&config).unwrap(), before);
    });
}

#[tokio::test]
async fn disable_and_uninstall_take_out_only_codeg_s_entry() {
    let s = sandbox();
    let adapter = s.adapter();
    let env = s.env(&[]);
    let found = detect(&adapter, &env).await;
    s.stage(NAME, 4);
    let n = name(NAME);
    let root = s.ctx.root.to_str().unwrap();
    // Everything here but the plugin's own revision folders is someone
    // else's: another plugin of the store, the plugin's own folder without
    // a revision, a file inside a revision, a copy elsewhere, a package.
    let foreign = vec![
        json!("superpowers"),
        json!(format!("{root}/other/4")),
        json!(format!("{root}/{NAME}")),
        json!(format!("{root}/{NAME}/4/sub")),
        json!(format!("{root}/{NAME}/latest")),
        json!(format!("{}/elsewhere/{NAME}/4", s.root.display())),
        json!(format!("./{NAME}/4")),
        json!(format!("-{NAME}")),
    ];
    let mut listed = foreign.clone();
    listed.insert(2, json!(s.rev(NAME, 4)));
    // An earlier revision's entry, with options: the plugin's too.
    listed.push(json!({ "package": s.rev(NAME, 3), "options": { "x": 1 } }));
    let config = s.write_config(
        "opencode.json",
        &serde_json::to_string_pretty(&json!({ "plugins": listed })).unwrap(),
    );
    with_cx!(s, env, found, |cx| {
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert_eq!(codes_of(&verify.problems), vec![codes::ENTRY_MISMATCH]);

        adapter.disable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.plugins_in(&config), json!(foreign));
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert_eq!(verify.enabled, None);
        assert_eq!(codes_of(&verify.problems), vec![codes::NOT_INSTALLED]);

        // Taken out already: nothing to do, nothing written.
        let before = fs::read(&config).unwrap();
        adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap();
        adapter.disable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(fs::read(&config).unwrap(), before);

        // Back on: at the end of the list.
        adapter.enable(&cx, &plugin(&n, 4)).await.unwrap();
        let mut back = foreign.clone();
        back.push(json!(s.rev(NAME, 4)));
        assert_eq!(s.plugins_in(&config), json!(back));
        adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.plugins_in(&config), json!(foreign));
    });
}

#[tokio::test]
async fn install_moves_a_stray_revision_and_drops_repeats() {
    let s = sandbox();
    let adapter = s.adapter();
    let env = s.env(&[]);
    let found = detect(&adapter, &env).await;
    s.stage(NAME, 4);
    let n = name(NAME);
    let config = s.write_config(
        "opencode.json",
        &json!({ "plugins": ["a", s.rev(NAME, 2), "b", s.rev(NAME, 3), s.rev(NAME, 4)] })
            .to_string(),
    );
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.plugins_in(&config), json!(["a", "b", s.rev(NAME, 4)]));
        s.write_config(
            "opencode.json",
            &json!({ "plugins": ["a", s.rev(NAME, 2), "b", s.rev(NAME, 3)] }).to_string(),
        );
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.plugins_in(&config), json!(["a", "b", s.rev(NAME, 4)]));
        assert!(adapter.verify(&cx, &plugin(&n, 4)).await.ok());

        // The same revision twice, the later one with options: that one
        // stays.
        let with_options = json!({ "package": s.rev(NAME, 4), "options": { "x": 1 } });
        s.write_config(
            "opencode.json",
            &json!({ "plugins": [s.rev(NAME, 4), "a", with_options] }).to_string(),
        );
        assert_eq!(
            codes_of(&adapter.verify(&cx, &plugin(&n, 4)).await.problems),
            vec![codes::ENTRY_MISMATCH]
        );
        adapter.enable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.plugins_in(&config), json!(["a", with_options]));
        assert!(adapter.verify(&cx, &plugin(&n, 4)).await.ok());
    });
}

#[tokio::test]
async fn both_files_are_read_and_the_plugin_has_one_entry_in_all() {
    let s = sandbox();
    let adapter = s.adapter();
    let env = s.env(&[]);
    let found = detect(&adapter, &env).await;
    s.stage(NAME, 4);
    let n = name(NAME);
    // OpenCode loads the plugins of both files: an entry in either is on.
    let json_file = s.write_config(
        "opencode.json",
        &json!({ "plugins": ["a", s.rev(NAME, 4)] }).to_string(),
    );
    let jsonc = s.write_config("opencode.jsonc", "{ \"plugins\": [\"b\"] }\n");
    with_cx!(s, env, found, |cx| {
        assert!(adapter.verify(&cx, &plugin(&n, 4)).await.ok());
        let before = (fs::read(&json_file).unwrap(), fs::read(&jsonc).unwrap());
        adapter.enable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(
            (fs::read(&json_file).unwrap(), fs::read(&jsonc).unwrap()),
            before
        );

        // One entry in each file: the later file's is kept.
        s.write_config(
            "opencode.json",
            &json!({ "plugins": ["a", s.rev(NAME, 3)] }).to_string(),
        );
        s.write_config(
            "opencode.jsonc",
            &json!({ "plugins": ["b", s.rev(NAME, 4)] }).to_string(),
        );
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert_eq!(codes_of(&verify.problems), vec![codes::ENTRY_MISMATCH]);
        assert_eq!(
            verify.problems[0].params["found"],
            format!("{}\n{}", s.rev(NAME, 3), s.rev(NAME, 4))
        );
        adapter.enable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.plugins_in(&json_file), json!(["a"]));
        assert_eq!(s.plugins_in(&jsonc), json!(["b", s.rev(NAME, 4)]));
        assert!(adapter.verify(&cx, &plugin(&n, 4)).await.ok());

        s.write_config(
            "opencode.json",
            &json!({ "plugins": ["a", s.rev(NAME, 3)] }).to_string(),
        );
        adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.plugins_in(&json_file), json!(["a"]));
        assert_eq!(s.plugins_in(&jsonc), json!(["b"]));
    });
}

#[tokio::test]
async fn the_version_gate() {
    let s = sandbox();
    let env = s.env(&[]);
    let gate = |adapter: OpenCodeAdapter, switches: AdapterSwitches| {
        let env = env.clone();
        async move { adapter.detect(&env, &switches).await }
    };

    // Not installed.
    let none = OpenCodeAdapter::sandboxed(None, None, s.mcp_lock.clone());
    let found = gate(none, website_switches()).await;
    assert!(!found.supported && found.cli.is_none());
    assert_eq!(found.why_not.unwrap().code, codes::HOST_NOT_FOUND);

    // Installed, its version unknown (an `opencode` of the user's that
    // Codeg has not read yet): never run to ask.
    let found = gate(s.adapter_at(None), website_switches()).await;
    assert!(!found.supported && found.cli.is_some() && found.version.is_none());
    assert_eq!(found.why_not.unwrap().code, codes::HOST_VERSION_UNKNOWN);

    // Below the built-in minimum, whatever the server says.
    let permissive = AdapterSwitches::from_config(&json!({
        "plugins": { "adapters": { "opencode": { "enabled": true, "minVersion": "1.0.0", "maxVersion": null } } }
    }));
    for old in ["2.3.1", "1.19.3", "0.0.0-dev-202611190000"] {
        let found = gate(s.adapter_at(Some(old)), permissive.clone()).await;
        assert!(!found.supported, "{old}");
        let why = found.why_not.unwrap();
        assert_eq!(why.code, codes::HOST_VERSION_UNSUPPORTED);
        assert_eq!(why.params["version"], old);
    }

    // The switch off, or no switch at all.
    let off = AdapterSwitches::from_config(&json!({
        "plugins": { "adapters": { "opencode": { "enabled": false, "minVersion": "2.3.2", "maxVersion": null } } }
    }));
    for switches in [off, AdapterSwitches::default()] {
        let found = gate(s.adapter(), switches).await;
        assert!(!found.supported);
        assert_eq!(found.why_not.unwrap().code, codes::ADAPTER_OFF);
    }

    // The minimum and above; a release label's `v` is no matter.
    for good in ["2.3.2", "v2.4.0", "opencode v3.0.1"] {
        let found = gate(s.adapter_at(Some(good)), website_switches()).await;
        assert!(found.supported, "{good}: {found:?}");
        assert!(found.why_not.is_none());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_folder_without_code_for_opencode_is_refused() {
    let s = sandbox();
    let adapter = s.adapter();
    let env = s.env(&[]);
    let found = detect(&adapter, &env).await;
    let config = s.write_config("opencode.jsonc", USER_CONFIG);
    let n = name(NAME);
    let dir = s.stage_bare(NAME, 4);
    let outside = s.root.join("outside.js");
    fs::write(&outside, "export default {}\n").unwrap();
    with_cx!(s, env, found, |cx| {
        let refused = |main: Option<&str>| {
            match main {
                Some(main) => fs::write(
                    dir.join("package.json"),
                    json!({ "main": main }).to_string(),
                ),
                None => fs::remove_file(dir.join("package.json")).or(Ok(())),
            }
            .unwrap();
        };
        // Nothing, a `main` that is not there, one outside the folder,
        // one through a link out of it.
        std::os::unix::fs::symlink(&outside, dir.join("linked.js")).unwrap();
        for main in [
            None,
            Some("dist/index.js"),
            Some("../outside.js"),
            Some("linked.js"),
        ] {
            refused(main);
            for reason in [
                adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err(),
                adapter.enable(&cx, &plugin(&n, 4)).await.unwrap_err(),
            ] {
                assert_eq!(reason.code, codes::ENTRY_MISSING, "{main:?}");
                assert_eq!(reason.params["revision"], "4");
            }
            assert_eq!(
                fs::read_to_string(&config).unwrap(),
                USER_CONFIG,
                "{main:?}"
            );
            let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
            assert!(codes_of(&verify.problems).contains(&codes::ENTRY_MISSING));
        }

        // `package.json`'s `main`, inside the folder.
        fs::create_dir_all(dir.join(".opencode/plugins")).unwrap();
        fs::write(dir.join(".opencode/plugins/superpowers.js"), "export {}\n").unwrap();
        refused(Some("./.opencode/plugins/superpowers.js"));
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        assert!(adapter.verify(&cx, &plugin(&n, 4)).await.ok());
        adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap();

        // `index.js` does without a `package.json`.
        refused(None);
        fs::write(dir.join("index.js"), "export {}\n").unwrap();
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();

        // A revision that is not in the store at all.
        let reason = adapter.install(&cx, &plugin(&n, 7)).await.unwrap_err();
        assert_eq!(reason.code, codes::REVISION_MISSING);
    });
}

#[test]
fn installable_needs_the_host_listed_and_code_in_the_folder() {
    let s = sandbox();
    let info: InstallInfo = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/harness/superpowers-install-info.json"
    ))
    .unwrap();
    let listed: PluginInfo = info.plugin.unwrap();
    let mut unlisted = listed.clone();
    unlisted.hosts.retain(|host| host.host != "opencode");

    let with_code = s.stage(NAME, 4);
    let without = s.stage_bare("bare", 1);
    assert!(OpenCodeAdapter::installable(&listed, &with_code).is_ok());
    assert_eq!(
        OpenCodeAdapter::installable(&unlisted, &with_code)
            .unwrap_err()
            .code,
        codes::HOST_NOT_LISTED
    );
    assert_eq!(
        OpenCodeAdapter::installable(&listed, &without)
            .unwrap_err()
            .code,
        codes::ENTRY_MISSING
    );
}

#[tokio::test]
async fn the_config_is_the_agent_s() {
    let s = sandbox();
    let adapter = s.adapter();
    s.stage(NAME, 4);
    let n = name(NAME);

    // No XDG_CONFIG_HOME: `.config/opencode` in the agent's own HOME, not
    // Codeg's.
    let agent_home = s.root.join("agent-home");
    let env = HostEnv::sandboxed(&s.home, &[(HOME_VAR, agent_home.to_str().unwrap())]);
    let found = detect(&adapter, &env).await;
    assert!(found.supported, "{found:?}");
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        let config = agent_home.join(".config/opencode/opencode.json");
        assert_eq!(s.plugins_in(&config), json!([s.rev(NAME, 4)]));
        assert!(adapter.verify(&cx, &plugin(&n, 4)).await.ok());
        adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.plugins_in(&config), json!([]));
    });

    // The agent's XDG_CONFIG_HOME.
    let env = s.env(&[(HOME_VAR, agent_home.to_str().unwrap())]);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        let config = s.config_dir().join("opencode.json");
        assert_eq!(s.plugins_in(&config), json!([s.rev(NAME, 4)]));
    });

    // OPENCODE_CONFIG_DIR over both.
    let own = s.root.join("own-config");
    let env = s.env(&[("OPENCODE_CONFIG_DIR", own.to_str().unwrap())]);
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(
            s.plugins_in(&own.join("opencode.json")),
            json!([s.rev(NAME, 4)])
        );
    });
    assert_eq!(fs::read_dir(&s.home).unwrap().count(), 0);
}

#[tokio::test]
async fn a_relative_config_folder_is_refused() {
    let s = sandbox();
    let adapter = s.adapter();
    s.stage(NAME, 4);
    let n = name(NAME);
    let found = detect(&adapter, &s.env(&[])).await;
    for (variable, env) in [
        (
            "XDG_CONFIG_HOME",
            HostEnv::sandboxed(&s.home, &[("XDG_CONFIG_HOME", "relative-xdg")]),
        ),
        (
            "OPENCODE_CONFIG_DIR",
            s.env(&[("OPENCODE_CONFIG_DIR", "relative-xdg")]),
        ),
    ] {
        let relative = detect(&adapter, &env).await;
        assert!(!relative.supported);
        let why = relative.why_not.clone().unwrap();
        assert_eq!(why.code, codes::HOST_HOME_RELATIVE);
        assert_eq!(why.params["variable"], variable);
        assert_eq!(why.params["path"], "relative-xdg");
        with_cx!(s, env, found, |cx| {
            for reason in [
                adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err(),
                adapter.enable(&cx, &plugin(&n, 4)).await.unwrap_err(),
                adapter
                    .update(&cx, &plugin(&n, 4), &plugin(&n, 4))
                    .await
                    .unwrap_err(),
                adapter.disable(&cx, &plugin(&n, 4)).await.unwrap_err(),
                adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap_err(),
            ] {
                assert_eq!(reason.code, codes::HOST_HOME_RELATIVE);
            }
            let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
            assert!(codes_of(&verify.problems).contains(&codes::HOST_HOME_RELATIVE));
        });
    }
    assert!(!s.ctx.root.join("relative-xdg").exists());
    assert!(!s.xdg.exists());
}

#[tokio::test]
async fn verify_reports_what_does_not_match() {
    let s = sandbox();
    let adapter = s.adapter();
    let env = s.env(&[]);
    let found = detect(&adapter, &env).await;
    s.stage(NAME, 4);
    let n = name(NAME);
    with_cx!(s, env, found, |cx| {
        // Nothing yet: not installed.
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert_eq!(codes_of(&verify.problems), vec![codes::NOT_INSTALLED]);

        // Another revision in the config than the record's.
        let config = s.write_config(
            "opencode.json",
            &json!({ "plugins": [s.rev(NAME, 3)] }).to_string(),
        );
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert_eq!(verify.enabled, Some(true));
        assert_eq!(codes_of(&verify.problems), vec![codes::ENTRY_MISMATCH]);
        assert_eq!(verify.problems[0].params["expected"], s.rev(NAME, 4));
        assert_eq!(verify.problems[0].params["found"], s.rev(NAME, 3));

        // The record's revision, but its folder gone.
        fs::write(&config, json!({ "plugins": [s.rev(NAME, 4)] }).to_string()).unwrap();
        assert!(adapter.verify(&cx, &plugin(&n, 4)).await.ok());
        fs::remove_file(s.ctx.revision_dir(&n, 4).join("index.js")).unwrap();
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert_eq!(codes_of(&verify.problems), vec![codes::ENTRY_MISSING]);
        fs::remove_dir_all(s.ctx.revision_dir(&n, 4)).unwrap();
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert_eq!(codes_of(&verify.problems), vec![codes::REVISION_MISSING]);

        // A config that cannot be read; nothing is written to it.
        s.stage(NAME, 4);
        fs::write(&config, "{ \"plugins\": [").unwrap();
        let verify = adapter.verify(&cx, &plugin(&n, 4)).await;
        assert_eq!(codes_of(&verify.problems), vec![codes::SETTINGS_UNREADABLE]);
        for reason in [
            adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err(),
            adapter.uninstall(&cx, &plugin(&n, 4)).await.unwrap_err(),
        ] {
            assert_eq!(reason.code, codes::SETTINGS_UNREADABLE);
        }
        assert_eq!(fs::read_to_string(&config).unwrap(), "{ \"plugins\": [");
    });
}

#[tokio::test]
async fn edits_wait_for_the_mcp_lock() {
    let s = sandbox();
    let adapter = s.adapter();
    let env = s.env(&[]);
    let found = detect(&adapter, &env).await;
    s.stage(NAME, 4);
    let n = name(NAME);
    let config = s.write_config("opencode.jsonc", USER_CONFIG);
    let held = crate::commands::mcp_engine::lock::acquire_at(
        &s.mcp_lock,
        std::time::Duration::from_secs(1),
    )
    .await
    .unwrap();
    with_cx!(s, env, found, |cx| {
        let reason = adapter.install(&cx, &plugin(&n, 4)).await.unwrap_err();
        assert!(reason.code.starts_with("lock_"), "{reason:?}");
        assert_eq!(fs::read_to_string(&config).unwrap(), USER_CONFIG);
        drop(held);
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
    });
}

/// A linked config (a dotfiles checkout) is written through its link, as
/// every config writer of Codeg's does it.
#[cfg(unix)]
#[tokio::test]
async fn a_linked_config_is_written_through_its_link() {
    let s = sandbox();
    let adapter = s.adapter();
    let env = s.env(&[]);
    let found = detect(&adapter, &env).await;
    s.stage(NAME, 4);
    let n = name(NAME);
    let dotfiles = s.root.join("dotfiles");
    fs::create_dir_all(&dotfiles).unwrap();
    let real = dotfiles.join("opencode.jsonc");
    fs::write(&real, USER_CONFIG).unwrap();
    fs::create_dir_all(s.config_dir()).unwrap();
    let link = s.config_dir().join("opencode.jsonc");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    with_cx!(s, env, found, |cx| {
        adapter.install(&cx, &plugin(&n, 4)).await.unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            s.plugins_in(&real),
            json!(["oh-my-opencode", s.rev(NAME, 4)])
        );
        assert!(adapter.verify(&cx, &plugin(&n, 4)).await.ok());
    });
}

#[tokio::test]
async fn an_entry_is_edited_in_the_file_it_is_in() {
    let s = sandbox();
    let adapter = s.adapter();
    let env = s.env(&[]);
    let found = detect(&adapter, &env).await;
    s.stage(NAME, 4);
    s.stage(NAME, 5);
    let n = name(NAME);
    let json_file = s.write_config(
        "opencode.json",
        &serde_json::to_string_pretty(&json!({
            "plugins": ["a", { "package": s.rev(NAME, 4), "options": { "x": 1 } }, "b"]
        }))
        .unwrap(),
    );
    for jsonc_text in [
        "{\n  // mine\n  \"model\": \"a/b\",\n}\n",
        "{\n  // mine\n  \"plugins\": [\"c\"],\n}\n",
    ] {
        let jsonc = s.write_config("opencode.jsonc", jsonc_text);
        with_cx!(s, env, found, |cx| {
            adapter
                .update(&cx, &plugin(&n, 4), &plugin(&n, 5))
                .await
                .unwrap();
            assert_eq!(
                s.plugins_in(&json_file),
                json!(["a", { "package": s.rev(NAME, 5), "options": { "x": 1 } }, "b"])
            );
            assert_eq!(fs::read_to_string(&jsonc).unwrap(), jsonc_text);
            assert!(adapter.verify(&cx, &plugin(&n, 5)).await.ok());
            // Back to 4 for the next round.
            adapter
                .update(&cx, &plugin(&n, 5), &plugin(&n, 4))
                .await
                .unwrap();
        });
    }
    // Off, then on again: a new entry goes where OpenCode's own writers add
    // one, the `.jsonc`.
    let jsonc = s.config_dir().join("opencode.jsonc");
    with_cx!(s, env, found, |cx| {
        adapter.disable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.plugins_in(&json_file), json!(["a", "b"]));
        adapter.enable(&cx, &plugin(&n, 4)).await.unwrap();
        assert_eq!(s.plugins_in(&json_file), json!(["a", "b"]));
        assert_eq!(s.plugins_in(&jsonc), json!(["c", s.rev(NAME, 4)]));
        assert!(adapter.verify(&cx, &plugin(&n, 4)).await.ok());
    });
}

#[cfg(unix)]
#[tokio::test]
async fn two_names_for_one_file_are_one_file() {
    let s = sandbox();
    let adapter = s.adapter();
    let env = s.env(&[]);
    let found = detect(&adapter, &env).await;
    s.stage(NAME, 4);
    s.stage(NAME, 5);
    let n = name(NAME);
    let real = s.root.join("dotfiles/opencode.jsonc");
    fs::create_dir_all(real.parent().unwrap()).unwrap();
    fs::write(
        &real,
        json!({ "plugins": ["a", s.rev(NAME, 4)] }).to_string(),
    )
    .unwrap();
    fs::create_dir_all(s.config_dir()).unwrap();
    // One link by its absolute path, one by a relative path through `..`.
    std::os::unix::fs::symlink(&real, s.config_dir().join("opencode.json")).unwrap();
    std::os::unix::fs::symlink(
        "../../dotfiles/opencode.jsonc",
        s.config_dir().join("opencode.jsonc"),
    )
    .unwrap();
    with_cx!(s, env, found, |cx| {
        assert!(adapter.verify(&cx, &plugin(&n, 4)).await.ok());
        adapter
            .update(&cx, &plugin(&n, 4), &plugin(&n, 5))
            .await
            .unwrap();
        assert_eq!(s.plugins_in(&real), json!(["a", s.rev(NAME, 5)]));
        assert!(adapter.verify(&cx, &plugin(&n, 5)).await.ok());
        adapter.enable(&cx, &plugin(&n, 5)).await.unwrap();
        adapter.enable(&cx, &plugin(&n, 5)).await.unwrap();
        assert_eq!(s.plugins_in(&real), json!(["a", s.rev(NAME, 5)]));
        adapter.uninstall(&cx, &plugin(&n, 5)).await.unwrap();
        assert_eq!(s.plugins_in(&real), json!(["a"]));
    });
}
