//! The skills an OpenCode 2 session can load, for the composer's `/` menu.
//!
//! OpenCode 2 advertises no skill over ACP, so codeg finds them on disk. The
//! Skills settings page manages OpenCode's own skill folders
//! (`commands::acp::skill_storage_spec`); the menu reads every folder OpenCode
//! loads skills from, so it offers each skill a session has. In OpenCode's load
//! order, where a later copy of an id replaces an earlier one:
//!
//! 1. `skills` in `~/.claude`, then in each `.claude` on the walk below
//!    (`core/src/config/plugin/compatibility.ts`), unless
//!    `OPENCODE_DISABLE_CLAUDE_CODE` or `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS`
//!    is set;
//! 2. the same for `~/.agents` and `.agents`;
//! 3. `skill` and then `skills` in the global config directory, then in each
//!    `.opencode` on the walk (`core/src/config/plugin/skill.ts`), so these win
//!    over the first two.
//!
//! The walk (`core/src/config/discovery.ts`) covers the session directory and
//! every directory above it, outermost first, and does not stop at a
//! repository root. OpenCode skips it when project config is off and when the
//! session runs in the global config directory itself. A folder on it that is
//! a global one (`~/.claude`, seen from a project under the home directory) is
//! read once, as the global one.
//!
//! Left out: the paths and URLs a config file's `skills` key adds, the skills a
//! plugin registers, the platform's managed config directory, and the two
//! skills built into OpenCode (`opencode`, `report`).

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use crate::acp::opencode_config;
use crate::acp::types::{
    AgentSkillItem, AgentSkillLayout, AgentSkillLocation, AgentSkillScope, AgentSkillsListResult,
};
use crate::commands::acp::build_skill_item;
use crate::parsers::AgentEnv;

/// How many levels of folders below a skill folder OpenCode looks through for
/// a `SKILL.md` (`core/src/config/plugin/skill-scan.ts`).
const MAX_DEPTH: usize = 6;

/// The folders OpenCode's scan never enters (`FSUtil.ignoredDirectories`),
/// besides every dot-entry.
const IGNORED_DIRECTORIES: [&str; 5] = ["node_modules", ".git", ".venv", "venv", "__pycache__"];

/// Where an OpenCode session reads skills from.
#[derive(Clone, Debug)]
pub(crate) struct SkillSources {
    /// The home directory `~/.claude` and `~/.agents` hang off.
    home: Option<PathBuf>,
    /// The global config directory (see [`opencode_config::config_dir_for_env`]).
    config_dir: Option<PathBuf>,
    /// Whether the `.claude` folders count.
    claude: bool,
    /// Whether the walk runs: OpenCode skips it when project config is off.
    project: bool,
    /// The outermost directory the walk reads. OpenCode walks to the
    /// filesystem root (`None`); a test bounds the walk to its fixture.
    walk_boundary: Option<PathBuf>,
}

impl SkillSources {
    /// The sources of an OpenCode launched with `env`, codeg's environment with
    /// the agent's own overrides laid over it. The home directory is codeg's,
    /// as for every resolver that reads an [`AgentEnv`].
    pub(crate) fn for_env(env: &AgentEnv) -> Self {
        let set = |key: &str| env.var(key).is_some_and(|value| truthy(&value));
        Self {
            home: dirs::home_dir(),
            config_dir: opencode_config::config_dir_for_env(env),
            // `cli/src/server-process.ts`: ".claude is only read for skills,
            // so both flags gate the same roots."
            claude: !set("OPENCODE_DISABLE_CLAUDE_CODE")
                && !set("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"),
            // `OPENCODE_CONFIG_PROJECT_DISABLE ?? OPENCODE_DISABLE_PROJECT_CONFIG`:
            // the newer name wins whenever it is set at all.
            project: !env
                .var("OPENCODE_CONFIG_PROJECT_DISABLE")
                .or_else(|| env.var("OPENCODE_DISABLE_PROJECT_CONFIG"))
                .is_some_and(|value| truthy(&value)),
            walk_boundary: None,
        }
    }

    /// What a session run from `directory` can load (without one, what the
    /// global folders hold): the folders read, in load order, and one skill per
    /// id, the copy OpenCode keeps.
    pub(crate) fn listing(&self, directory: Option<&Path>) -> AgentSkillsListResult {
        let roots = self.roots(directory);
        let mut by_id: HashMap<String, AgentSkillItem> = HashMap::new();
        for (scope, root) in &roots {
            for file in scan(root) {
                if let Some(skill) = skill_in(root, &file, *scope) {
                    by_id.insert(skill.id.clone(), skill);
                }
            }
        }
        let mut skills: Vec<AgentSkillItem> = by_id.into_values().collect();
        // Global first, then by name, as the settings page lists skills.
        skills.sort_by(|a, b| {
            (a.scope == AgentSkillScope::Project, &a.name)
                .cmp(&(b.scope == AgentSkillScope::Project, &b.name))
        });
        AgentSkillsListResult {
            supported: true,
            message: None,
            locations: roots
                .into_iter()
                .map(|(scope, path)| AgentSkillLocation {
                    scope,
                    exists: path.is_dir(),
                    path: path.to_string_lossy().into_owned(),
                })
                .collect(),
            skills,
        }
    }

    /// Every folder OpenCode reads skills from for a session run from
    /// `directory`, in the order it loads them.
    fn roots(&self, directory: Option<&Path>) -> Vec<(AgentSkillScope, PathBuf)> {
        let claude_home = self.home.as_ref().map(|home| home.join(".claude"));
        let agents_home = self.home.as_ref().map(|home| home.join(".agents"));
        let globals: Vec<PathBuf> = [&self.config_dir, &claude_home, &agents_home]
            .into_iter()
            .flatten()
            .map(|dir| resolved(dir))
            .collect();
        let walk = self.walk(directory);
        // `name` in each directory of the walk, outermost first, leaving out
        // one that is a global folder.
        let walked = |name: &str| -> Vec<PathBuf> {
            walk.iter()
                .rev()
                .map(|dir| dir.join(name))
                .filter(|dir| !globals.contains(&resolved(dir)))
                .collect()
        };

        let mut roots = Vec::new();
        for (read, home, name) in [
            (self.claude, &claude_home, ".claude"),
            (true, &agents_home, ".agents"),
        ] {
            if !read {
                continue;
            }
            roots.extend(
                home.iter()
                    .map(|dir| (AgentSkillScope::Global, dir.join("skills"))),
            );
            roots.extend(
                walked(name)
                    .into_iter()
                    .map(|dir| (AgentSkillScope::Project, dir.join("skills"))),
            );
        }
        let config_dirs = self
            .config_dir
            .iter()
            .map(|dir| (AgentSkillScope::Global, dir.clone()))
            .chain(
                walked(".opencode")
                    .into_iter()
                    .map(|dir| (AgentSkillScope::Project, dir)),
            );
        for (scope, dir) in config_dirs {
            roots.push((scope, dir.join("skill")));
            roots.push((scope, dir.join("skills")));
        }
        roots
    }

    /// The session directory and every directory above it, nearest first.
    /// None when project config is off or the session runs in the global config
    /// directory, and none for a relative path, whose ancestors would be codeg's
    /// own working directory's.
    fn walk(&self, directory: Option<&Path>) -> Vec<PathBuf> {
        let Some(directory) = directory.filter(|dir| self.project && dir.is_absolute()) else {
            return Vec::new();
        };
        if self
            .config_dir
            .as_deref()
            .is_some_and(|config| resolved(config) == resolved(directory))
        {
            return Vec::new();
        }
        directory
            .ancestors()
            .filter(|dir| {
                self.walk_boundary
                    .as_deref()
                    .is_none_or(|boundary| dir.starts_with(boundary))
            })
            .map(Path::to_path_buf)
            .collect()
    }
}

/// `path` with its symlinks resolved, the way OpenCode compares folders
/// (`fs.resolve`), or as given when it does not exist.
fn resolved(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The skill files under `root`, found the way OpenCode's scan finds them
/// (`core/src/config/plugin/skill-scan.ts`): breadth first through at most
/// [`MAX_DEPTH`] levels of folders, following symlinks and skipping every
/// dot-entry and [`IGNORED_DIRECTORIES`]. A folder holding a `SKILL.md` is a
/// skill and is not searched further; at the top of `root` every other `.md`
/// file is one too. Sorted as OpenCode sorts them, as text, so of two copies of
/// an id in one folder the later is the one it keeps.
fn scan(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0)]);
    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let (mut skill_file, mut markdown, mut folders) = (None, Vec::new(), Vec::new());
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || IGNORED_DIRECTORIES.contains(&name.as_str()) {
                continue;
            }
            let path = entry.path();
            // Follows a symlink, as OpenCode's `stat` of one does.
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                folders.push(path);
            } else if meta.is_file() && name == "SKILL.md" {
                skill_file = Some(path);
            } else if meta.is_file() && name.ends_with(".md") {
                markdown.push(path);
            }
        }
        if let Some(file) = skill_file {
            files.push(file);
            continue;
        }
        if depth == 0 {
            files.append(&mut markdown);
        }
        if depth < MAX_DEPTH {
            queue.extend(folders.into_iter().map(|folder| (folder, depth + 1)));
        }
    }
    files.sort_by(|a, b| a.as_os_str().cmp(b.as_os_str()));
    files
}

/// The skill `file` holds, named the way OpenCode names it
/// (`core/src/config/plugin/skill-file.ts`): after its folder for a
/// `SKILL.md`, after its stem for a `.md` at the top of `root`. An empty file
/// holds none.
fn skill_in(root: &Path, file: &Path, scope: AgentSkillScope) -> Option<AgentSkillItem> {
    if !fs::metadata(file).is_ok_and(|meta| meta.len() > 0) {
        return None;
    }
    let folder = file.parent()?;
    let name = file.file_name()?.to_string_lossy();
    if folder == root && name != "SKILL.md" {
        let id = name.strip_suffix(".md")?.to_string();
        return Some(build_skill_item(
            id,
            scope,
            AgentSkillLayout::MarkdownFile,
            file.to_path_buf(),
        ));
    }
    let id = folder.file_name()?.to_string_lossy().into_owned();
    Some(build_skill_item(
        id,
        scope,
        AgentSkillLayout::SkillDirectory,
        folder.to_path_buf(),
    ))
}

/// OpenCode's reading of a flag (`cli/src/server-process.ts`): `1`, or `true`
/// in any case.
fn truthy(value: &str) -> bool {
    value == "1" || value.eq_ignore_ascii_case("true")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::types::AgentSkillScope::{Global, Project};

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// A `<id>/SKILL.md` bundle in `dir`, described as `description`.
    fn skill(dir: &Path, id: &str, description: &str) {
        write(
            &dir.join(id).join("SKILL.md"),
            &format!("---\ndescription: {description}\n---\nbody\n"),
        );
    }

    /// OpenCode with `home` (and the global config directory in it), every
    /// folder counting, and a walk that stops at `boundary` rather than read
    /// whatever lies above the fixture.
    fn sources(home: &Path, boundary: &Path) -> SkillSources {
        SkillSources {
            home: Some(home.to_path_buf()),
            config_dir: Some(home.join(".config/opencode")),
            claude: true,
            project: true,
            walk_boundary: Some(boundary.to_path_buf()),
        }
    }

    fn ids(listing: &AgentSkillsListResult) -> Vec<(&str, AgentSkillScope)> {
        let mut ids: Vec<_> = listing
            .skills
            .iter()
            .map(|skill| (skill.id.as_str(), skill.scope))
            .collect();
        ids.sort_by_key(|(id, _)| *id);
        ids
    }

    #[test]
    fn lists_every_folder_opencode_reads_up_to_the_filesystem_root() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let repo = tmp.path().join("repo");
        let workspace = repo.join("app");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        skill(&home.join(".claude/skills"), "claude-global", "Claude's");
        skill(&home.join(".agents/skills"), "agents-global", "shared");
        skill(&home.join(".config/opencode/skills"), "oc-global", "own");
        write(&home.join(".config/opencode/skill/oc-flat.md"), "flat");
        skill(&workspace.join(".claude/skills"), "claude-project", "here");
        skill(&workspace.join(".agents/skills"), "agents-project", "here");
        skill(&workspace.join(".opencode/skill"), "oc-project", "here");
        // Above the repository root: the walk goes on to the filesystem root.
        skill(&tmp.path().join(".claude/skills"), "claude-above", "above");
        skill(&tmp.path().join(".opencode/skills"), "oc-above", "above");

        let listing = sources(&home, tmp.path()).listing(Some(&workspace));
        assert_eq!(
            ids(&listing),
            vec![
                ("agents-global", Global),
                ("agents-project", Project),
                ("claude-above", Project),
                ("claude-global", Global),
                ("claude-project", Project),
                ("oc-above", Project),
                ("oc-flat", Global),
                ("oc-global", Global),
                ("oc-project", Project),
            ]
        );
        let flat = listing.skills.iter().find(|s| s.id == "oc-flat").unwrap();
        assert_eq!(flat.layout, AgentSkillLayout::MarkdownFile);
        let global = listing.skills.iter().find(|s| s.id == "oc-global").unwrap();
        assert_eq!(global.description.as_deref(), Some("own"));
        assert_eq!(
            Path::new(&global.path),
            home.join(".config/opencode/skills/oc-global")
        );
    }

    #[test]
    fn keeps_the_copy_of_an_id_opencode_loads_last() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let workspace = tmp.path().join("ws");
        let config = home.join(".config/opencode");
        fs::create_dir_all(&workspace).unwrap();
        // `.agents` after `.claude`, the walk after the home folder.
        skill(&home.join(".claude/skills"), "a", "home claude");
        skill(&workspace.join(".claude/skills"), "a", "project claude");
        skill(&home.join(".agents/skills"), "a", "home agents");
        // The config directories after every `.claude` and `.agents`.
        skill(&workspace.join(".agents/skills"), "b", "project agents");
        skill(&config.join("skill"), "b", "global config");
        // `skills` after `skill`.
        skill(&config.join("skill"), "c", "skill");
        skill(&config.join("skills"), "c", "skills");
        // The walk's `.opencode` after the global directory, nearest last.
        skill(&config.join("skills"), "d", "global");
        skill(&tmp.path().join(".opencode/skills"), "d", "outer");
        skill(&workspace.join(".opencode/skill"), "d", "nearest");

        let listing = sources(&home, tmp.path()).listing(Some(&workspace));
        let kept = |id: &str| {
            let skill = listing.skills.iter().find(|s| s.id == id).unwrap();
            (skill.description.as_deref().unwrap(), skill.scope)
        };
        assert_eq!(listing.skills.len(), 4, "one row per id");
        assert_eq!(kept("a"), ("home agents", Global));
        assert_eq!(kept("b"), ("global config", Global));
        assert_eq!(kept("c"), ("skills", Global));
        assert_eq!(kept("d"), ("nearest", Project));
    }

    #[test]
    fn opencodes_switches_drop_the_folders_they_name() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let workspace = tmp.path().join("ws");
        fs::create_dir_all(&workspace).unwrap();
        skill(&home.join(".claude/skills"), "claude-global", "");
        skill(&home.join(".agents/skills"), "agents-global", "");
        skill(&workspace.join(".claude/skills"), "claude-project", "");
        skill(&workspace.join(".opencode/skills"), "oc-project", "");

        let mut no_claude = sources(&home, tmp.path());
        no_claude.claude = false;
        assert_eq!(
            ids(&no_claude.listing(Some(&workspace))),
            vec![("agents-global", Global), ("oc-project", Project)]
        );

        let mut no_project = sources(&home, tmp.path());
        no_project.project = false;
        let global_only = vec![("agents-global", Global), ("claude-global", Global)];
        assert_eq!(ids(&no_project.listing(Some(&workspace))), global_only);
        assert_eq!(
            ids(&sources(&home, tmp.path()).listing(None)),
            global_only,
            "no session directory, no walk"
        );
    }

    #[test]
    fn a_global_folder_on_the_walk_is_read_once_as_global() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let workspace = home.join("work/app");
        fs::create_dir_all(&workspace).unwrap();
        skill(&home.join(".claude/skills"), "claude-home", "");
        // `~/.opencode` is no global folder: the walk reads it as a project's.
        skill(&home.join(".opencode/skills"), "oc-home", "");

        let listing = sources(&home, tmp.path()).listing(Some(&workspace));
        assert_eq!(
            ids(&listing),
            vec![("claude-home", Global), ("oc-home", Project)]
        );
        let claude = home.join(".claude/skills");
        let reads = listing
            .locations
            .iter()
            .filter(|location| Path::new(&location.path) == claude)
            .count();
        assert_eq!(reads, 1);
    }

    #[test]
    fn a_session_in_the_global_config_directory_walks_nowhere() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let config = home.join(".config/opencode");
        skill(&config.join("skills"), "oc-global", "");
        skill(&config.join(".agents/skills"), "beside-the-config", "");

        let listing = sources(&home, tmp.path()).listing(Some(&config));
        assert_eq!(ids(&listing), vec![("oc-global", Global)]);
    }

    #[test]
    fn finds_skills_the_way_opencodes_scan_does() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        skill(&root, "top", "");
        skill(&root.join("pack/group"), "nested", "");
        skill(&root.join("a/b/c/d/e"), "deepest", "");
        skill(&root.join("a/b/c/d/e/f"), "too-deep", "");
        // A skill's own folder is not searched for more.
        skill(&root.join("top"), "inside-a-skill", "");
        skill(&root.join(".hidden"), "dotted", "");
        skill(&root.join("node_modules"), "module", "");
        write(&root.join("flat.md"), "flat");
        write(&root.join("LOUD.MD"), "not `.md`");
        write(&root.join("pack/loose.md"), "only the top's count");
        write(&root.join("empty/SKILL.md"), "");

        let mut found: Vec<_> = scan(&root)
            .iter()
            .filter_map(|file| skill_in(&root, file, Global))
            .map(|skill| skill.id)
            .collect();
        found.sort();
        assert_eq!(found, vec!["deepest", "flat", "nested", "top"]);
    }

    #[cfg(unix)]
    #[test]
    fn follows_a_symlinked_skill_folder() {
        let tmp = tempfile::tempdir().unwrap();
        skill(&tmp.path().join("store"), "linked", "from the store");
        let root = tmp.path().join("skills");
        fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("store/linked"), root.join("linked")).unwrap();

        let found: Vec<_> = scan(&root)
            .iter()
            .filter_map(|file| skill_in(&root, file, Global))
            .collect();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "linked");
        assert_eq!(found[0].description.as_deref(), Some("from the store"));
    }

    #[test]
    fn reads_opencodes_switches_from_the_launch_environment() {
        let sources = SkillSources::for_env(&AgentEnv::with_overrides(&[
            ("OPENCODE_CONFIG_DIR", "/srv/opencode"),
            ("OPENCODE_DISABLE_CLAUDE_CODE", ""),
            ("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "TRUE"),
            ("OPENCODE_CONFIG_PROJECT_DISABLE", "0"),
            ("OPENCODE_DISABLE_PROJECT_CONFIG", "1"),
        ]));
        assert_eq!(sources.config_dir, Some(PathBuf::from("/srv/opencode")));
        assert!(!sources.claude);
        assert!(sources.project, "the newer name wins whenever it is set");

        let sources = SkillSources::for_env(&AgentEnv::with_overrides(&[
            ("OPENCODE_DISABLE_CLAUDE_CODE", "yes"),
            ("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", ""),
            ("OPENCODE_CONFIG_PROJECT_DISABLE", ""),
            ("OPENCODE_DISABLE_PROJECT_CONFIG", "true"),
        ]));
        assert!(sources.claude, "only `1` and `true` turn a switch on");
        assert!(!sources.project);
    }
}
