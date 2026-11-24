//! Work-task execution engine (distinct from `commands::work_task`, the CRUD
//! surface). One engine per process, elected by an exclusive data-dir file
//! lock; built at boot in both desktop and server mode.

pub mod compact;
pub mod engine;
pub mod git;

pub use engine::{
    build_task_engine, engine, run_task_engine, CleanupBlocked, EngineWorkTaskTools, TaskEngine,
};
pub(crate) use engine::worktree_kept;
