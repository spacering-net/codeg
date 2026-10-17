//! Shared skill installations remain one source. Account homes link to that
//! source; files already owned by an adopted account are never overwritten.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::models::AgentType;

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind")]
enum Managed {
    Directory { source: PathBuf },
    Markdown { digest: String },
}

type Manifest = BTreeMap<PathBuf, Managed>;
static SYNC_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Positional against `skill_storage_spec`'s ordered roots. `None` means the
/// CLI continues to read that shared OS-home root without relocating it.
fn destinations(agent: AgentType) -> &'static [Option<&'static str>] {
    match agent {
        AgentType::ClaudeCode | AgentType::Grok | AgentType::Hermes | AgentType::CodeBuddy => {
            &[Some("skills")]
        }
        AgentType::Codex => &[Some("skills"), Some("skills/.system"), None],
        AgentType::OpenCode => &[Some("config/opencode/skills"), Some(".agents/skills")],
        // Gemini 0.60's Storage.getGlobalAgentsDir and getGlobalGeminiDir both
        // use its GEMINI_CLI_HOME-aware homedir helper.
        AgentType::Gemini => &[Some(".gemini/skills"), Some(".agents/skills")],
        AgentType::Cline => &[None, None],
        AgentType::KimiCode | AgentType::Pi | AgentType::DeepSeek | AgentType::Qoder => {
            &[Some("skills"), None]
        }
        AgentType::Antigravity => &[Some("config/skills"), Some("antigravity-cli/skills")],
        AgentType::Cursor if cfg!(target_os = "macos") => &[
            Some(".cursor/skills"),
            Some(".agents/skills"),
            Some(".cursor/skills-cursor"),
        ],
        AgentType::Cursor => &[None, None, None],
        _ => &[],
    }
}

pub fn sync(agent: AgentType, home: &Path) -> Result<(), String> {
    let spec =
        crate::commands::acp::skill_storage_spec(agent).ok_or("Unknown skill storage layout")?;
    let targets = destinations(agent);
    if spec.global_dirs.len() != targets.len() {
        return Err(format!(
            "The {agent} skill layout has changed. Update the account mapping before continuing."
        ));
    }
    let pairs = spec
        .global_dirs
        .iter()
        .zip(targets)
        .filter_map(|(source, target)| target.map(|target| (source.clone(), home.join(target))))
        .collect::<Vec<_>>();
    sync_roots(home, &pairs).map_err(|e| format!("Could not share account skills: {e}"))
}

fn digest(path: &Path) -> std::io::Result<String> {
    Ok(format!("{:x}", Sha256::digest(fs::read(path)?)))
}

fn is_link(path: &Path) -> bool {
    #[cfg(windows)]
    if junction::exists(path).unwrap_or(false) {
        return true;
    }
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

fn link_target(path: &Path) -> std::io::Result<PathBuf> {
    #[cfg(windows)]
    if junction::exists(path)? {
        return junction::get_target(path);
    }
    fs::read_link(path)
}

fn same_path(a: &Path, b: &Path) -> bool {
    crate::parsers::path_eq_for_matching(&a.to_string_lossy(), &b.to_string_lossy())
        || matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

fn remove_link(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        // RemoveDirectory removes the directory link itself without following
        // its target. junction::delete only clears the reparse point and
        // leaves an empty directory, which would mask future shared skills.
        fs::remove_dir(path)
    }
    #[cfg(not(windows))]
    {
        fs::remove_file(path)
    }
}

fn create_link(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        junction::create(source, target)
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(source, target)
    }
}

fn invalid(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message)
}

fn relative(home: &Path, target: &Path) -> std::io::Result<PathBuf> {
    let path = target
        .strip_prefix(home)
        .map_err(|_| invalid("Skill destination escaped the account folder"))?;
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(invalid("Invalid account skill destination"));
    }
    Ok(path.to_path_buf())
}

fn linked_parent(home: &Path, target: &Path) -> bool {
    target
        .parent()
        .into_iter()
        .flat_map(Path::ancestors)
        .take_while(|path| *path != home)
        .any(is_link)
}

fn materialize(
    home: &Path,
    source: &Path,
    target: &Path,
    old: &Manifest,
    next: &mut Manifest,
) -> std::io::Result<()> {
    let key = relative(home, target)?;
    if linked_parent(home, target) {
        return Ok(());
    }
    if !source.try_exists()? {
        return Ok(());
    }
    let source = source.canonicalize()?;
    if target.canonicalize().is_ok_and(|path| path == source) {
        if matches!(old.get(&key), Some(Managed::Directory { .. })) {
            next.insert(key, Managed::Directory { source });
        }
        return Ok(());
    }
    // Do not follow an account-local link to mutate a directory it owns.
    if is_link(target) {
        return Ok(());
    }
    let canonical_target = home.canonicalize()?.join(&key);
    if source.starts_with(&canonical_target) || canonical_target.starts_with(&source) {
        return Err(invalid("Account and shared skill folders overlap"));
    }
    if source.is_dir() {
        if !target.try_exists()? {
            fs::create_dir_all(
                target
                    .parent()
                    .ok_or_else(|| invalid("Missing skill parent"))?,
            )?;
            create_link(&source, target)?;
            next.insert(key, Managed::Directory { source });
        } else if target.is_dir() && !target.join("SKILL.md").is_file() {
            for entry in fs::read_dir(source)? {
                let entry = entry?;
                materialize(
                    home,
                    &entry.path(),
                    &target.join(entry.file_name()),
                    old,
                    next,
                )?;
            }
        }
    } else if source.extension().is_some_and(|e| e == "md") {
        let previous_matches = match old.get(&key) {
            Some(Managed::Markdown { digest: expected }) => {
                digest(target).is_ok_and(|actual| &actual == expected)
            }
            _ => false,
        };
        if !target.try_exists()? || previous_matches {
            fs::create_dir_all(
                target
                    .parent()
                    .ok_or_else(|| invalid("Missing skill parent"))?,
            )?;
            fs::copy(&source, target)?;
            next.insert(
                key,
                Managed::Markdown {
                    digest: digest(target)?,
                },
            );
        }
    }
    Ok(())
}

fn sync_roots(home: &Path, roots: &[(PathBuf, PathBuf)]) -> std::io::Result<()> {
    if roots.is_empty() {
        return Ok(());
    }
    let _guard = SYNC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let manifest = home.join(".codeg-shared-skills.json");
    let old: Manifest = match fs::read(&manifest) {
        Ok(raw) => {
            serde_json::from_slice(&raw).map_err(|_| invalid("Invalid shared skill manifest"))?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(e) => return Err(e),
    };
    let mut next = BTreeMap::new();
    for (source, target) in roots {
        materialize(home, source, target, &old, &mut next)?;
    }
    for (key, entry) in old {
        if next.contains_key(&key) {
            continue;
        }
        let target = home.join(&key);
        relative(home, &target)?;
        if linked_parent(home, &target) {
            continue;
        }
        match entry {
            Managed::Directory { source }
                if is_link(&target)
                    && link_target(&target).is_ok_and(|actual| same_path(&actual, &source)) =>
            {
                remove_link(&target)?
            }
            Managed::Markdown { digest: expected }
                if !is_link(&target) && digest(&target).is_ok_and(|actual| actual == expected) =>
            {
                fs::remove_file(target)?
            }
            _ => {} // A local replacement belongs to the account, not this sync.
        }
    }
    use std::io::Write;
    let mut temporary = tempfile::NamedTempFile::new_in(home)?;
    temporary.write_all(
        &serde_json::to_vec_pretty(&next)
            .map_err(|_| invalid("Could not serialize skill manifest"))?,
    )?;
    temporary.persist(manifest).map_err(|e| e.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_account_covers_the_entire_existing_skill_layout() {
        for agent in crate::models::agent::BUILTIN_AGENT_TYPES {
            if crate::acp::agent_accounts::layout(*agent).is_none() {
                continue;
            }
            assert_eq!(
                destinations(*agent).len(),
                crate::commands::acp::skill_storage_spec(*agent)
                    .unwrap()
                    .global_dirs
                    .len(),
                "{agent}"
            );
        }
    }

    #[test]
    fn linked_skills_follow_edits_without_copying_an_account_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("account");
        let source = dir.path().join("shared");
        fs::create_dir_all(source.join("example")).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(source.join("example/SKILL.md"), "first").unwrap();
        fs::write(home.join("auth.json"), "private fixture").unwrap();
        let roots = [(source.clone(), home.join("skills"))];
        sync_roots(&home, &roots).unwrap();
        fs::write(source.join("example/SKILL.md"), "second").unwrap();
        assert_eq!(
            fs::read_to_string(home.join("skills/example/SKILL.md")).unwrap(),
            "second"
        );
        assert_eq!(
            fs::read_to_string(home.join("auth.json")).unwrap(),
            "private fixture"
        );
        sync_roots(&home, &roots).unwrap();
        assert!(source.join("example/SKILL.md").is_file());
    }

    #[test]
    fn local_overrides_survive_and_only_owned_links_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("account");
        let source = dir.path().join("shared");
        for path in [
            source.join("local"),
            source.join("added"),
            home.join("skills/local"),
        ] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(source.join("local/SKILL.md"), "shared").unwrap();
        fs::write(source.join("added/SKILL.md"), "added").unwrap();
        fs::write(home.join("skills/local/SKILL.md"), "local").unwrap();
        let roots = [(source.clone(), home.join("skills"))];
        sync_roots(&home, &roots).unwrap();
        assert_eq!(
            fs::read_to_string(home.join("skills/local/SKILL.md")).unwrap(),
            "local"
        );
        fs::remove_dir_all(source.join("added")).unwrap();
        sync_roots(&home, &roots).unwrap();
        assert!(fs::symlink_metadata(home.join("skills/added")).is_err());
        assert_eq!(
            fs::read_to_string(home.join("skills/local/SKILL.md")).unwrap(),
            "local"
        );
    }

    #[test]
    fn adopted_parent_links_are_never_written_through() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("account");
        let outside = dir.path().join("outside");
        let source = dir.path().join("shared");
        for path in [&home, &outside, &source] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(source.join("SKILL.md"), "shared").unwrap();
        create_link(&outside, &home.join("config")).unwrap();
        sync_roots(&home, &[(source, home.join("config/skills"))]).unwrap();
        assert!(!outside.join("skills").exists());
    }

    #[test]
    fn removing_an_owned_link_keeps_the_shared_directory_and_files() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("account");
        let source = dir.path().join("shared");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("SKILL.md"), "keep shared content").unwrap();
        sync_roots(&home, &[(source.clone(), home.join("skills"))]).unwrap();
        sync_roots(&home, &[(source.clone(), home.join("other-skills"))]).unwrap();
        assert!(fs::symlink_metadata(home.join("skills")).is_err());
        assert_eq!(
            fs::read_to_string(source.join("SKILL.md")).unwrap(),
            "keep shared content"
        );
        assert_eq!(
            fs::read_to_string(home.join("other-skills/SKILL.md")).unwrap(),
            "keep shared content"
        );
    }
}
