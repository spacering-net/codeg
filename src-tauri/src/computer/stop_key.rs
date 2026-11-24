//! The stop shortcut as the OS holds it: registered while computer use is on
//! and a shortcut is chosen, gone otherwise, and — because another
//! application may already hold the same keys — a status the panel can show,
//! so nobody counts on a shortcut that does nothing.
//!
//! The keys come from [`StopShortcut`], which never names one that would take
//! a permission to watch (see its module note). Nothing else registers any:
//! the plugin takes whatever key it is handed — a media key, and the event tap
//! that watches one, included — so no capability gives a webview its
//! commands.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcut, Shortcut, ShortcutState};

use super::stop_shortcut::StopShortcut;

pub use super::stop_shortcut::StopKeyStatus;

#[derive(Default)]
struct Inner {
    registered: Option<(StopShortcut, Shortcut)>,
    status: StopKeyStatus,
}

/// See the module note.
#[derive(Default)]
pub struct StopKey {
    inner: Mutex<Inner>,
}

impl StopKey {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn status(&self) -> StopKeyStatus {
        self.lock().status.clone()
    }

    /// Hold `wanted` with the OS, and nothing else; `on_press` is what
    /// pressing it does. Returns the status when it changed.
    ///
    /// Blocks until the main thread has registered the keys, so it is called
    /// from a task, never from the main thread's own event handling.
    pub fn sync(
        &self,
        app: &AppHandle,
        wanted: Option<&StopShortcut>,
        on_press: impl Fn() + Send + Sync + 'static,
    ) -> Option<StopKeyStatus> {
        let plugin = app.try_state::<GlobalShortcut<Wry>>()?;
        let mut inner = self.lock();
        // Held as wanted and nothing failed: nothing to do. (A shortcut the
        // OS refused is tried again, and a refusal is cleared when the
        // shortcut is no longer wanted.)
        if inner.status.failed.is_none()
            && inner.registered.as_ref().map(|(held, _)| held) == wanted
        {
            return None;
        }
        if let Some((held, hotkey)) = inner.registered.take() {
            if let Err(e) = plugin.unregister(hotkey) {
                tracing::warn!("[computer] could not release the stop shortcut {held}: {e}");
            }
        }
        let mut status = StopKeyStatus::default();
        if let Some(wanted) = wanted {
            let registered = match wanted.hotkey() {
                Some(hotkey) => plugin
                    .on_shortcut(hotkey, move |_, _, event| {
                        if event.state() == ShortcutState::Pressed {
                            on_press();
                        }
                    })
                    .map(|()| hotkey)
                    .map_err(|e| e.to_string()),
                None => Err("not a key the stop shortcut can be on".to_string()),
            };
            match registered {
                Ok(hotkey) => {
                    inner.registered = Some((wanted.clone(), hotkey));
                    status.active = Some(wanted.to_string());
                }
                Err(detail) => {
                    tracing::warn!(
                        "[computer] the stop shortcut {wanted} is not in force: {detail}"
                    );
                    status.failed = Some(wanted.to_string());
                    status.detail = Some(detail);
                }
            }
        }
        if inner.status == status {
            return None;
        }
        inner.status = status.clone();
        Some(status)
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    fn json_strings(value: &serde_json::Value, out: &mut Vec<String>) {
        match value {
            serde_json::Value::String(s) => out.push(s.clone()),
            serde_json::Value::Array(items) => items.iter().for_each(|v| json_strings(v, out)),
            serde_json::Value::Object(map) => {
                for (key, v) in map {
                    out.push(key.clone());
                    json_strings(v, out);
                }
            }
            _ => {}
        }
    }

    fn toml_strings(value: &toml::Value, out: &mut Vec<String>) {
        match value {
            toml::Value::String(s) => out.push(s.clone()),
            toml::Value::Array(items) => items.iter().for_each(|v| toml_strings(v, out)),
            toml::Value::Table(table) => {
                for (key, v) in table {
                    out.push(key.clone());
                    toml_strings(v, out);
                }
            }
            _ => {}
        }
    }

    /// Every string in the file, keys included, as its parser decodes it: a
    /// permission spelled with an escape (`global\u002dshortcut:…`) still
    /// grants the plugin, so the raw text proves nothing.
    fn strings_in(path: &Path) -> Vec<String> {
        let text = std::fs::read_to_string(path).unwrap();
        let mut out = Vec::new();
        match path.extension().and_then(|e| e.to_str()) {
            Some("json") => json_strings(&serde_json::from_str(&text).unwrap(), &mut out),
            Some("toml") => toml_strings(&text.parse::<toml::Value>().unwrap(), &mut out),
            other => panic!(
                "{}: no reader for {other:?} — teach this test the format before Tauri reads it",
                path.display()
            ),
        }
        out
    }

    /// The files under `dir` that Tauri reads, picked as tauri-build picks
    /// them (`tauri_utils::acl::build`): `dir/**/*` — hidden files and
    /// folders included — with one of `extensions`, unless the folder holding
    /// the file is named `schemas`. Permission files are resolved first
    /// (`resolve`), so the rules apply to what a link points at, and a link
    /// that resolves to nothing is not read; capability files are taken as
    /// found.
    fn files_tauri_reads(dir: &Path, extensions: &[&str], resolve: bool, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries {
            let path = entry.unwrap().path();
            if path.is_dir() {
                files_tauri_reads(&path, extensions, resolve, out);
                continue;
            }
            let path = if resolve {
                match path.canonicalize() {
                    Ok(resolved) => resolved,
                    Err(_) => continue,
                }
            } else {
                path
            };
            if path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| extensions.contains(&e))
                && path
                    .parent()
                    .and_then(|p| p.file_name())
                    .is_none_or(|n| n != "schemas")
            {
                out.push(path);
            }
        }
    }

    /// See the module note: a webview holding the plugin's commands could
    /// register a media key, and codeg would open an event tap for it. The
    /// release gate lets codeg import `CGEventTapCreate` on the strength of
    /// this test and `StopShortcut`'s closed list. A webview gets a plugin
    /// command only from a capability — in `capabilities/`, or inline in
    /// tauri.conf.json — naming the plugin's permission or a set of the app's
    /// own, defined under `permissions/`, that does.
    #[test]
    fn no_webview_is_given_the_shortcut_plugin() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut capabilities = Vec::new();
        // `json5` only under tauri's `config-json5` feature; there is no
        // reader for it here, so one such file fails the test rather than
        // going unread.
        files_tauri_reads(
            &root.join("capabilities"),
            &["json", "json5", "toml"],
            false,
            &mut capabilities,
        );
        assert!(!capabilities.is_empty(), "no capability files found");
        let mut files = capabilities;
        files_tauri_reads(
            &root.join("permissions"),
            &["json", "toml"],
            true,
            &mut files,
        );
        for path in &files {
            assert!(
                !strings_in(path)
                    .iter()
                    .any(|s| s.contains("global-shortcut")),
                "{} gives a webview the global-shortcut plugin",
                path.display()
            );
        }

        let conf: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("tauri.conf.json")).unwrap())
                .unwrap();
        let mut inline = Vec::new();
        if let Some(capabilities) = conf.pointer("/app/security/capabilities") {
            json_strings(capabilities, &mut inline);
        }
        assert!(
            !inline.iter().any(|s| s.contains("global-shortcut")),
            "tauri.conf.json gives a webview the global-shortcut plugin"
        );
    }

    /// The reader decodes what Tauri decodes: an escaped permission is still
    /// the plugin's, in either format.
    #[test]
    fn an_escaped_permission_is_still_found() {
        let dir = tempfile::tempdir().unwrap();
        for (name, text) in [
            (
                "escaped.json",
                r#"{"permissions": ["global\u002dshortcut:allow-register"]}"#,
            ),
            (
                "escaped.toml",
                r#"permissions = ["global\u002dshortcut:allow-register"]"#,
            ),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, text).unwrap();
            assert!(
                strings_in(&path)
                    .iter()
                    .any(|s| s == "global-shortcut:allow-register"),
                "{name} was not decoded"
            );
        }
    }

    /// The walk picks what tauri-build picks: hidden files and folders count;
    /// other extensions, and a file whose own folder is `schemas`, do not.
    #[test]
    fn the_files_read_are_the_ones_tauri_reads() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for name in [
            "a.json",
            ".hidden.json",
            ".folder/b.toml",
            "nested/deep/c.json5",
            "README.md",
            ".DS_Store",
            "schemas/desktop-schema.json",
            "schemas/inner/d.json",
        ] {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "{}").unwrap();
        }
        let mut found = Vec::new();
        files_tauri_reads(root, &["json", "json5", "toml"], false, &mut found);
        let mut found: Vec<String> = found
            .iter()
            .map(|p| {
                p.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        found.sort();
        assert_eq!(
            found,
            [
                ".folder/b.toml",
                ".hidden.json",
                "a.json",
                "nested/deep/c.json5",
                "schemas/inner/d.json",
            ]
        );
    }

    /// A permission file is judged by what it points at, as
    /// `define_permissions` judges it: a link under `schemas` to a file
    /// elsewhere is read there, and a link to nothing is not read at all.
    #[cfg(unix)]
    #[test]
    fn a_permission_link_is_read_where_it_points() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("outside.toml"), "").unwrap();
        let permissions = root.join("permissions");
        std::fs::create_dir_all(permissions.join("schemas")).unwrap();
        std::os::unix::fs::symlink("../../outside.toml", permissions.join("schemas/link.toml"))
            .unwrap();
        std::os::unix::fs::symlink("missing.toml", permissions.join("dangling.toml")).unwrap();
        let mut found = Vec::new();
        files_tauri_reads(&permissions, &["json", "toml"], true, &mut found);
        assert_eq!(found, [root.join("outside.toml").canonicalize().unwrap()]);
    }
}
