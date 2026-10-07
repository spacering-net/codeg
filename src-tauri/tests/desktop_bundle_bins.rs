//! What `tauri build` puts in the desktop bundle besides codeg.
//!
//! The Tauri CLI bundles every binary target whose `required-features` are
//! all among the features it builds with — its own `--features`,
//! `tauri/custom-protocol` and the config's `build.features`, never the
//! manifest's defaults — and then adds the `default-run` one. A target that
//! requires no feature is bundled, compiled with the desktop's features: the
//! standalone server would ride along whole, and the MCP companion's desktop
//! build would replace the sidecar meant to ship in its place. So every binary
//! target but codeg must require a feature `tauri build` is never given.

use std::path::Path;

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

fn strings(value: Option<&toml::Value>) -> Vec<String> {
    value
        .and_then(toml::Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| item.as_str().expect("a feature name").to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// The features `tauri build` builds with: `tauri/custom-protocol`, and
/// whatever any Tauri configuration file names under `build.features`.
fn features_tauri_build_is_given() -> Vec<String> {
    let mut given = vec!["tauri/custom-protocol".to_string()];
    for entry in std::fs::read_dir(root()).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        if !(name.starts_with("tauri") && name.ends_with(".conf.json")) {
            continue;
        }
        let config: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root().join(&name)).unwrap()).unwrap();
        if let Some(features) = config["build"]["features"].as_array() {
            given.extend(
                features
                    .iter()
                    .map(|f| f.as_str().expect("a feature name").to_string()),
            );
        }
    }
    given
}

#[test]
fn only_codeg_is_a_binary_target_tauri_build_bundles() {
    let manifest: toml::Table = std::fs::read_to_string(root().join("Cargo.toml"))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(
        manifest["package"]["default-run"].as_str(),
        Some("codeg"),
        "the binary tauri build bundles as the app"
    );
    let defaults = strings(manifest["features"].get("default"));
    let given = features_tauri_build_is_given();
    let bins = manifest["bin"].as_array().expect("[[bin]] targets");
    let mut others = 0;
    for bin in bins {
        let name = bin["name"].as_str().unwrap();
        if name == "codeg" {
            continue;
        }
        others += 1;
        let required = strings(bin.get("required-features"));
        assert!(
            required
                .iter()
                .any(|feature| !given.contains(feature) && !defaults.contains(feature)),
            "`{name}` requires no feature tauri build lacks ({required:?}): it would be \
             compiled with the desktop's features and put in the desktop bundle"
        );
    }
    assert!(others >= 3, "codeg-server, codeg-mcp and the helper");
}

/// The release workflow gives `tauri build` no features of its own: one named
/// there would bring the binary target that requires it into the bundle.
#[test]
fn the_release_build_names_no_features() {
    let workflow =
        std::fs::read_to_string(root().join("../.github/workflows/release.yml")).unwrap();
    let mut tauri_args = 0;
    for line in workflow.lines() {
        let line = line.trim_start();
        if let Some(args) = line.strip_prefix("args:") {
            tauri_args += 1;
            assert!(!args.contains("--features"), "{line}");
        }
    }
    assert!(tauri_args >= 1, "the tauri-action steps pass their args");
}
