//! Shadow-Git workspace snapshot & restore for conversation rollback.
//!
//! Each workspace gets an isolated bare-like git directory under
//! `paths::codeg_checkpoints_root()/<sha256(canonical_workspace_path)>`,
//! leaving the workspace's own `.git` directory, index, and branches
//! completely untouched.

use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha256};

const SHADOW_EXCLUDE_PATTERNS: &str = "\
.git/
node_modules/
target/
.next/
dist/
build/
.turbo/
.cache/
__pycache__/
.venv/
venv/
";

fn shadow_repo_dir_for(checkpoints_root: &Path, workspace_dir: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(workspace_dir).unwrap_or_else(|_| workspace_dir.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    checkpoints_root.join(&digest[..24])
}

fn run_shadow_git(
    shadow_dir: &Path,
    workspace_dir: &Path,
    args: &[&str],
) -> Result<String, String> {
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(shadow_dir)
        .arg("--work-tree")
        .arg(workspace_dir)
        .args(args)
        .output()
        .map_err(|e| format!("failed to spawn git: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "git {:?} failed (status {}): {}",
            args,
            output.status,
            stderr.trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn ensure_shadow_repo(shadow_dir: &Path, workspace_dir: &Path) -> Result<(), String> {
    if !shadow_dir.join("HEAD").exists() {
        std::fs::create_dir_all(shadow_dir)
            .map_err(|e| format!("failed to create shadow git dir: {e}"))?;
        let output = Command::new("git")
            .arg("init")
            .arg("--bare")
            .arg(shadow_dir)
            .output()
            .map_err(|e| format!("failed to init shadow git repo: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "git init --bare failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        // Disable core.bare so `--work-tree` operations work without warnings.
        let _ = run_shadow_git(shadow_dir, workspace_dir, &["config", "core.bare", "false"]);
    }

    let info_dir = shadow_dir.join("info");
    if !info_dir.exists() {
        std::fs::create_dir_all(&info_dir)
            .map_err(|e| format!("failed to create shadow info dir: {e}"))?;
    }
    let exclude_path = info_dir.join("exclude");
    if !exclude_path.exists() {
        std::fs::write(&exclude_path, SHADOW_EXCLUDE_PATTERNS)
            .map_err(|e| format!("failed to write shadow exclude file: {e}"))?;
    }
    Ok(())
}

/// Captures the current workspace state into the shadow git repo and returns
/// the resulting git tree SHA.
pub fn capture_workspace_snapshot(workspace_dir: &Path) -> Result<String, String> {
    capture_workspace_snapshot_with_root(&crate::paths::codeg_checkpoints_root(), workspace_dir)
}

pub fn capture_workspace_snapshot_with_root(
    checkpoints_root: &Path,
    workspace_dir: &Path,
) -> Result<String, String> {
    if !workspace_dir.is_dir() {
        return Err(format!(
            "workspace directory does not exist: {}",
            workspace_dir.display()
        ));
    }
    let shadow_dir = shadow_repo_dir_for(checkpoints_root, workspace_dir);
    ensure_shadow_repo(&shadow_dir, workspace_dir)?;

    run_shadow_git(&shadow_dir, workspace_dir, &["add", "-A"])?;
    run_shadow_git(&shadow_dir, workspace_dir, &["write-tree"])
}

/// Restores the workspace to the exact state recorded in `tree_hash`.
///
/// Updates/restores tracked files via `read-tree` + `checkout-index -a -f`,
/// and removes untracked files created after the snapshot via `clean -fd`
/// (respecting `.gitignore` and `info/exclude`, so `.git/`, `node_modules/`,
/// `target/`, `.env`, etc. are preserved).
pub fn restore_workspace_snapshot(workspace_dir: &Path, tree_hash: &str) -> Result<(), String> {
    restore_workspace_snapshot_with_root(
        &crate::paths::codeg_checkpoints_root(),
        workspace_dir,
        tree_hash,
    )
}

pub fn restore_workspace_snapshot_with_root(
    checkpoints_root: &Path,
    workspace_dir: &Path,
    tree_hash: &str,
) -> Result<(), String> {
    if !workspace_dir.is_dir() {
        return Err(format!(
            "workspace directory does not exist: {}",
            workspace_dir.display()
        ));
    }
    let shadow_dir = shadow_repo_dir_for(checkpoints_root, workspace_dir);
    ensure_shadow_repo(&shadow_dir, workspace_dir)?;

    run_shadow_git(&shadow_dir, workspace_dir, &["read-tree", tree_hash])?;
    run_shadow_git(&shadow_dir, workspace_dir, &["checkout-index", "-a", "-f"])?;
    run_shadow_git(&shadow_dir, workspace_dir, &["clean", "-fd"])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_and_restore_handles_modify_create_and_delete() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ws = tmp.path().join("workspace");
        let checkpoints = tmp.path().join("checkpoints");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&checkpoints).unwrap();

        let file_a = ws.join("a.txt");
        let file_b = ws.join("b.txt");
        std::fs::write(&file_a, "v1").unwrap();
        std::fs::write(&file_b, "keep-me").unwrap();

        let tree_v1 = capture_workspace_snapshot_with_root(&checkpoints, &ws).expect("capture v1");

        // Simulate agent edits: modify a.txt, delete b.txt, create c.txt
        std::fs::write(&file_a, "v2-bad").unwrap();
        std::fs::remove_file(&file_b).unwrap();
        let file_c = ws.join("c.txt");
        std::fs::write(&file_c, "unwanted").unwrap();

        restore_workspace_snapshot_with_root(&checkpoints, &ws, &tree_v1).expect("restore v1");

        assert_eq!(std::fs::read_to_string(&file_a).unwrap(), "v1");
        assert_eq!(std::fs::read_to_string(&file_b).unwrap(), "keep-me");
        assert!(!file_c.exists());
    }
}
