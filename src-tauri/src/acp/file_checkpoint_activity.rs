//! Coordinate checkpoint coverage across connections sharing a worktree.
//! Parallel prompts are allowed, but neither may claim exclusive file ownership.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Default)]
struct Activity {
    turns: usize,
    generation: u64,
    restoring: bool,
}

fn activities() -> &'static Mutex<HashMap<PathBuf, Activity>> {
    static MAP: OnceLock<Mutex<HashMap<PathBuf, Activity>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn root_key(root: &Path) -> PathBuf {
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    #[cfg(windows)]
    let root = PathBuf::from(root.to_string_lossy().to_lowercase());
    root
}

#[derive(Debug)]
pub struct TurnActivity {
    root: PathBuf,
    generation: u64,
}

#[derive(Clone)]
pub struct PublishGuard {
    root: PathBuf,
    generation: u64,
}

impl PublishGuard {
    pub fn publish(
        self,
        action: crate::acp::file_checkpoint::CheckpointPublish,
    ) -> Result<(), String> {
        let map = activities().lock().unwrap_or_else(|e| e.into_inner());
        if !map
            .get(&self.root)
            .is_some_and(|a| a.turns == 1 && a.generation == self.generation && !a.restoring)
        {
            return Err("Overlapping workspace turns cannot be safely checkpointed".into());
        }
        action()
    }
}

impl TurnActivity {
    pub fn publisher(&self) -> PublishGuard {
        PublishGuard {
            root: self.root.clone(),
            generation: self.generation,
        }
    }
    pub fn begin(root: &Path) -> Result<Self, String> {
        let root = root_key(root);
        let mut map = activities().lock().unwrap_or_else(|e| e.into_inner());
        if map
            .iter()
            .any(|(other, a)| a.restoring && (root.starts_with(other) || other.starts_with(&root)))
        {
            return Err("Workspace files are being restored; retry after restoration".into());
        }
        let overlaps: Vec<_> = map
            .iter()
            .filter(|(other, a)| {
                a.turns > 0 && (root.starts_with(other) || other.starts_with(&root))
            })
            .map(|(other, _)| other.clone())
            .collect();
        for other in &overlaps {
            map.get_mut(other).unwrap().generation += 1;
        }
        let entry = map.entry(root.clone()).or_default();
        entry.turns += 1;
        if !overlaps.is_empty() {
            entry.generation += 1;
        }
        // A concurrent turn is ineligible from the outset, even if it is the
        // last one to settle. The existing guard is invalidated above.
        let generation = if overlaps.is_empty() {
            entry.generation
        } else {
            u64::MAX
        };
        Ok(Self { root, generation })
    }

    pub fn is_exclusive(&self) -> bool {
        activities()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&self.root)
            .is_some_and(|a| a.turns == 1 && a.generation == self.generation && !a.restoring)
    }
}

impl Drop for TurnActivity {
    fn drop(&mut self) {
        let mut map = activities().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(a) = map.get_mut(&self.root) {
            a.turns = a.turns.saturating_sub(1);
        }
        map.retain(|_, a| a.turns > 0 || a.restoring);
    }
}

#[derive(Debug)]
pub struct RestoreActivity {
    root: PathBuf,
}

impl RestoreActivity {
    pub fn begin(root: &Path) -> Result<Self, String> {
        let root = root_key(root);
        let mut map = activities().lock().unwrap_or_else(|e| e.into_inner());
        if map.iter().any(|(other, a)| {
            (a.turns > 0 || a.restoring) && (root.starts_with(other) || other.starts_with(&root))
        }) {
            return Err("Another turn or restore is using this workspace".into());
        }
        map.entry(root.clone()).or_default().restoring = true;
        Ok(Self { root })
    }
}

impl Drop for RestoreActivity {
    fn drop(&mut self) {
        let mut map = activities().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(a) = map.get_mut(&self.root) {
            a.restoring = false;
        }
        map.retain(|_, a| a.turns > 0 || a.restoring);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlapping_turns_invalidate_both_checkpoints_but_keep_parallel_work() {
        let dir = tempfile::tempdir().unwrap();
        let first = TurnActivity::begin(dir.path()).unwrap();
        assert!(first.is_exclusive());
        let second = TurnActivity::begin(dir.path()).unwrap();
        assert!(!first.is_exclusive());
        assert!(!second.is_exclusive());
        drop(first);
        assert!(!second.is_exclusive());
        assert!(RestoreActivity::begin(dir.path()).is_err());
        drop(second);
        assert!(RestoreActivity::begin(dir.path()).is_ok());
    }
    #[test]
    fn a_restore_blocks_prompts_in_parent_and_child_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let child = dir.path().join("child");
        std::fs::create_dir(&child).unwrap();
        let restore = RestoreActivity::begin(&child).unwrap();
        assert!(TurnActivity::begin(dir.path()).is_err());
        assert!(TurnActivity::begin(&child).is_err());
        drop(restore);
        assert!(TurnActivity::begin(&child).is_ok());
    }
    #[test]
    fn publishing_rechecks_overlap_after_capture_and_before_persistence() {
        let dir = tempfile::tempdir().unwrap();
        let first = TurnActivity::begin(dir.path()).unwrap();
        let publisher = first.publisher();
        let second = TurnActivity::begin(dir.path()).unwrap();
        drop(second);
        let wrote = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let wrote_copy = wrote.clone();
        assert!(publisher
            .publish(Box::new(move || {
                wrote_copy.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            }))
            .is_err());
        assert!(!wrote.load(std::sync::atomic::Ordering::SeqCst));
    }
}
