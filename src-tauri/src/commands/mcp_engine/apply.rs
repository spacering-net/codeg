//! `mcp_apply`: do exactly the operations it is handed, or nothing.
//!
//! With the MCP write lock held (and Codex's, when Codex is among the
//! agents):
//!
//! 1. Every file the operations touch is read again and compared with the
//!    basis the caller saw. One that differs stops everything: the user
//!    confirmed a change to a file that is no longer the one on screen.
//! 2. The operations are applied in memory, each agent's in its own
//!    document, and checked: the transport, the name, the fields. One that
//!    cannot be carried out stops everything, and every one that cannot is
//!    reported.
//! 3. Only then are the files written, one after another, each copied to the
//!    backup directory first. If a write fails, the files already written
//!    are put back as they were — but only those that still hold exactly
//!    what codeg wrote. One that something else changed in between is left
//!    alone, and the result says where the copy from before is.
//!
//! A preflight runs 1 and 2 without the locks and stops there.
//!
//! [`apply_locked`] is synchronous on purpose: the documents are edited
//! through trees that are not `Send`, and the retired MCP commands reach
//! Codex's file through it from synchronous code.

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::acp::codex_catalog_commit::{LockedHome, McpCommitError, McpConfigChange};
use crate::commands::mcp::McpAppType;

use super::agents::{format_of, spec, AgentSpec, EngineCtx};
use super::dialect;
use super::fsio;
use super::json_doc::OPENCODE_LEGACY_FLAG;
use super::model::{
    codes, is_valid_new_key, McpAgentResult, McpAgentStatus, McpApplyOutcome, McpApplyRequest,
    McpApplyResult, McpConfigFormat, McpFileWrite, McpIssue, McpOp, McpOpAction, McpOpEffect,
    McpOpIssue, McpOpResult, RESERVED_KEY,
};
use super::plugin_gate;
use super::store::{decode, open_store, read_view, DuplicateKey, EntryStore};
use super::yaml_doc;

/// Codex's config.toml, reached through `codex_catalog_commit` and nowhere
/// else.
pub(crate) trait CodexGate {
    fn read(&self) -> std::io::Result<Option<Vec<u8>>>;
    fn commit(
        &self,
        expected: Option<&[u8]>,
        change: McpConfigChange<'_>,
    ) -> Result<(), McpCommitError>;
}

impl CodexGate for LockedHome {
    fn read(&self) -> std::io::Result<Option<Vec<u8>>> {
        self.read_config_bytes()
    }

    fn commit(
        &self,
        expected: Option<&[u8]>,
        change: McpConfigChange<'_>,
    ) -> Result<(), McpCommitError> {
        self.commit_mcp_servers(expected, change)
    }
}

/// How this run reaches Codex's file.
pub(crate) enum CodexAccess<'a> {
    /// Without its lock: a preflight, or a run Codex takes no part in.
    Unlocked,
    Locked(&'a dyn CodexGate),
    /// The lock could not be taken; Codex's operations cannot go ahead.
    Failed(McpOpIssue),
}

/// One file an agent's operations change.
struct FilePlan {
    path: PathBuf,
    role: &'static str,
    original: Option<Vec<u8>>,
    planned: Vec<u8>,
    /// Codex's config.toml: written through its gate.
    codex: bool,
}

/// Everything about one agent's part in a run.
struct Work {
    app: McpAppType,
    path: PathBuf,
    /// Set once something stops this agent's operations.
    blocked: Option<McpAgentStatus>,
    basis: Option<String>,
    issues: Vec<McpOpIssue>,
    warnings: Vec<McpOpIssue>,
    op_results: Vec<McpOpResult>,
    files: Vec<FilePlan>,
}

impl Work {
    fn block(&mut self, status: McpAgentStatus, issue: McpOpIssue) {
        // The first reason decides the status; later ones are still listed.
        self.blocked.get_or_insert(status);
        self.issues.push(issue);
    }

    fn result(&self, status: McpAgentStatus, backup_paths: Vec<String>) -> McpAgentResult {
        McpAgentResult {
            agent: self.app,
            path: self.path.display().to_string(),
            status,
            basis: self.basis.clone(),
            issues: self.issues.clone(),
            warnings: self.warnings.clone(),
            ops: self.op_results.clone(),
            writes: self
                .files
                .iter()
                .map(|file| McpFileWrite {
                    path: file.path.display().to_string(),
                    role: file.role.to_string(),
                    creates: file.original.is_none(),
                })
                .collect(),
            backup_paths,
        }
    }
}

fn io_issue(code: &str, error: &std::io::Error) -> McpOpIssue {
    McpOpIssue::new(code).detail(error.to_string())
}

fn read_issue(error: &std::io::Error) -> McpOpIssue {
    let code = if error.kind() == std::io::ErrorKind::PermissionDenied {
        codes::IO_PERMISSION_DENIED
    } else {
        codes::IO_ERROR
    };
    io_issue(code, error)
}

/// Apply one agent's operations to its open document. Returns the changes
/// its plugin gate needs: `(server name, present)`.
fn run_ops(
    spec: &AgentSpec,
    store: &mut dyn EntryStore,
    ops: &[(usize, &McpOp)],
    work: &mut Work,
) -> Vec<(String, bool)> {
    let app = spec.app;
    let mut gate = Vec::new();
    for (index, op) in ops {
        let index = *index;
        let key = op.key.as_str();
        let issue = |code: &str| McpOpIssue::new(code).op(index, key);
        let edit_failed = |detail: String| issue(codes::EDIT_FAILED).detail(detail);
        let done = |effect: McpOpEffect, results: &mut Vec<McpOpResult>| {
            results.push(McpOpResult {
                index,
                key: key.to_string(),
                effect,
            });
        };
        if key == RESERVED_KEY {
            work.issues.push(issue(codes::KEY_RESERVED));
            continue;
        }
        // An entry that is there twice — its name, or a key inside it — is
        // one no operation is carried out on: the edit would reach the first
        // occurrence and the agent reads the last, so it would be reported
        // done and change nothing the agent sees.
        match store.get(key).and_then(|found| found.duplicate) {
            None => {}
            Some(DuplicateKey::Entry) => {
                work.issues.push(issue(codes::DUPLICATE_KEY));
                continue;
            }
            Some(DuplicateKey::Field(path)) => {
                work.issues.push(issue(codes::DUPLICATE_KEY).field(&path));
                continue;
            }
        }
        match &op.action {
            McpOpAction::Set { definition } => {
                let definition = dialect::tidy_definition(definition);
                let mut refused = false;
                for (code, field) in dialect::definition_problems(&definition) {
                    work.issues.push(issue(code).field(field));
                    refused = true;
                }
                if !spec.supports(definition.transport()) {
                    work.issues.push(
                        issue(codes::TRANSPORT_UNSUPPORTED).detail(definition.transport().as_str()),
                    );
                    refused = true;
                }
                if refused {
                    continue;
                }
                let fresh = dialect::fresh_fields(app, &definition);
                let Some(found) = store.get(key) else {
                    if !is_valid_new_key(key) {
                        work.issues.push(issue(codes::KEY_INVALID));
                        continue;
                    }
                    if store.is_structural_key(key) {
                        work.issues.push(issue(codes::KEY_STRUCTURAL));
                        continue;
                    }
                    match store.create(key, &fresh) {
                        Ok(()) => {
                            done(McpOpEffect::Created, &mut work.op_results);
                            gate.push((key.to_string(), true));
                        }
                        Err(detail) => work.issues.push(edit_failed(detail)),
                    }
                    continue;
                };
                // An entry in the older location moves to the current one
                // first; one that cannot be moved as it is gives way to the
                // new definition.
                let mut moved = false;
                let existing = if found.legacy {
                    moved = true;
                    match store.promote(key) {
                        Ok(()) => store.get(key),
                        Err(_) => None,
                    }
                } else {
                    Some(found)
                };
                let outcome = match existing {
                    None => store
                        .remove(key)
                        .and_then(|_| store.create(key, &fresh))
                        .map(|()| true),
                    Some(existing) => match existing.value.as_object() {
                        Some(object) => {
                            let current =
                                dialect::read_entry(app, &existing.value, spec.disable.entry)
                                    .definition;
                            let patch =
                                dialect::patch_for(app, object, current.as_ref(), &definition);
                            if !patch.dropped.is_empty() {
                                work.warnings.push(
                                    issue(codes::FIELDS_DROPPED).detail(patch.dropped.join(", ")),
                                );
                            }
                            let changes = !patch.ops.is_empty();
                            store.patch(key, &patch.ops).map(|()| changes)
                        }
                        None => store.replace(key, &fresh).map(|()| true),
                    },
                };
                match outcome {
                    Ok(changed) => {
                        let effect = if changed || moved {
                            McpOpEffect::Updated
                        } else {
                            McpOpEffect::Unchanged
                        };
                        done(effect, &mut work.op_results);
                        gate.push((key.to_string(), true));
                    }
                    Err(detail) => work.issues.push(edit_failed(detail)),
                }
            }
            McpOpAction::Remove => match store.remove(key) {
                Ok(removed) => {
                    if removed {
                        // A name in the agent's "off" list goes with the
                        // server it named.
                        if let Some(list) = spec.disable.root_list {
                            let _ = store.set_root_list(list, key, false);
                        }
                        done(McpOpEffect::Removed, &mut work.op_results);
                    } else {
                        work.warnings.push(issue(codes::ENTRY_NOT_FOUND));
                        done(McpOpEffect::Unchanged, &mut work.op_results);
                    }
                    gate.push((key.to_string(), false));
                }
                Err(detail) => work.issues.push(edit_failed(detail)),
            },
            McpOpAction::SetEnabled { enabled } => {
                let enabled = *enabled;
                if !spec.disable.is_supported() {
                    work.issues.push(issue(codes::DISABLE_UNSUPPORTED));
                    continue;
                }
                let Some(found) = store.get(key) else {
                    work.issues.push(issue(codes::ENTRY_NOT_FOUND));
                    continue;
                };
                let mut changed = false;
                let existing = if found.legacy {
                    changed = true;
                    match store.promote(key) {
                        Ok(()) => store.get(key),
                        Err(detail) => {
                            work.issues.push(edit_failed(detail));
                            continue;
                        }
                    }
                } else {
                    Some(found)
                };
                let Some(existing) = existing else {
                    work.issues.push(issue(codes::ENTRY_NOT_FOUND));
                    continue;
                };
                let mut failed = None;
                if let Some(flag) = spec.disable.entry {
                    match existing.value.as_object() {
                        Some(object) => {
                            let ops = dialect::enable_ops(flag, object, enabled);
                            if !ops.is_empty() {
                                match store.patch(key, &ops) {
                                    Ok(()) => changed = true,
                                    Err(detail) => failed = Some(edit_failed(detail)),
                                }
                            }
                        }
                        None => failed = Some(issue(codes::ENTRY_NOT_EDITABLE)),
                    }
                }
                if let (None, Some(list)) = (&failed, spec.disable.root_list) {
                    // Where the list is the agent's only switch, it follows
                    // the state. Where the entry has a flag too, the flag is
                    // the switch and the list is only cleared, so that
                    // turning a server on really turns it on.
                    let listed = if spec.disable.entry.is_some() {
                        (!enabled) && store.root_list_contains(list, key)
                    } else {
                        !enabled
                    };
                    match store.set_root_list(list, key, listed) {
                        Ok(list_changed) => changed |= list_changed,
                        Err(detail) => failed = Some(edit_failed(detail)),
                    }
                }
                match failed {
                    Some(problem) => work.issues.push(problem),
                    None => {
                        let effect = match (changed, enabled) {
                            (false, _) => McpOpEffect::Unchanged,
                            (true, true) => McpOpEffect::Enabled,
                            (true, false) => McpOpEffect::Disabled,
                        };
                        done(effect, &mut work.op_results);
                    }
                }
            }
            McpOpAction::Rename { new_key } => {
                let new_key = new_key.as_str();
                if new_key == RESERVED_KEY {
                    work.issues
                        .push(issue(codes::KEY_RESERVED).field("new_key"));
                    continue;
                }
                if !is_valid_new_key(new_key) {
                    work.issues.push(issue(codes::KEY_INVALID).field("new_key"));
                    continue;
                }
                if store.is_structural_key(new_key) {
                    work.issues
                        .push(issue(codes::KEY_STRUCTURAL).field("new_key"));
                    continue;
                }
                let Some(found) = store.get(key) else {
                    work.issues.push(issue(codes::ENTRY_NOT_FOUND));
                    continue;
                };
                if new_key == key {
                    done(McpOpEffect::Unchanged, &mut work.op_results);
                    continue;
                }
                if store.get(new_key).is_some() {
                    work.issues
                        .push(issue(codes::KEY_EXISTS).field("new_key").detail(new_key));
                    continue;
                }
                let renamed = (if found.legacy {
                    store.promote(key)
                } else {
                    Ok(())
                })
                .and_then(|()| store.rename(key, new_key))
                // A copy in the older location under the old name (OpenCode
                // 1.x's `mcp.<key>`, Codex's `[mcp.servers.<key>]`) was
                // shadowed by the entry just renamed, and would now be read
                // as a server of the old name: it goes with the entry, as it
                // does when the entry is removed.
                .and_then(|()| store.remove(key).map(|_| ()))
                .and_then(|()| match spec.disable.root_list {
                    Some(list) if store.root_list_contains(list, key) => store
                        .set_root_list(list, key, false)
                        .and_then(|_| store.set_root_list(list, new_key, true))
                        .map(|_| ()),
                    _ => Ok(()),
                });
                match renamed {
                    Ok(()) => {
                        done(McpOpEffect::Renamed, &mut work.op_results);
                        gate.push((key.to_string(), false));
                        gate.push((new_key.to_string(), true));
                    }
                    Err(detail) => work.issues.push(edit_failed(detail)),
                }
            }
        }
    }
    gate
}

/// Read one agent's file, check it against the basis, and apply the agent's
/// operations to it in memory.
fn prepare(
    ctx: &EngineCtx,
    app: McpAppType,
    ops: &[(usize, &McpOp)],
    request: &McpApplyRequest,
    codex: &CodexAccess<'_>,
) -> Work {
    let spec = spec(app);
    let paths = ctx.paths_of(app).cloned();
    let path = paths
        .as_ref()
        .map(|paths| paths.servers.clone())
        .unwrap_or_default();
    let mut work = Work {
        app,
        path: path.clone(),
        blocked: None,
        basis: None,
        issues: Vec::new(),
        warnings: Vec::new(),
        op_results: Vec::new(),
        files: Vec::new(),
    };
    let Some(paths) = paths else {
        work.block(
            McpAgentStatus::ReadOnly,
            McpOpIssue::new(codes::AGENT_READ_ONLY),
        );
        return work;
    };

    // The file as it is now. Codex's is read under its lock when this run
    // holds it.
    let is_codex = app == McpAppType::Codex;
    let read = match (is_codex, codex) {
        (true, CodexAccess::Locked(gate)) => gate.read(),
        (true, CodexAccess::Failed(problem)) => {
            work.basis = fsio::read_bytes(&path)
                .ok()
                .map(|bytes| fsio::basis_of(bytes.as_deref()));
            work.block(McpAgentStatus::NotWritten, problem.clone());
            return work;
        }
        _ => fsio::read_bytes(&path),
    };
    let original = match read {
        Ok(bytes) => bytes,
        Err(error) => {
            work.block(McpAgentStatus::Unreadable, read_issue(&error));
            return work;
        }
    };
    let basis = fsio::basis_of(original.as_deref());
    work.basis = Some(basis.clone());

    if spec.scan_only {
        work.block(
            McpAgentStatus::ReadOnly,
            McpOpIssue::new(codes::AGENT_READ_ONLY),
        );
        return work;
    }
    match request.basis.get(&app) {
        Some(seen) if *seen != basis => {
            work.block(
                McpAgentStatus::ChangedElsewhere,
                McpOpIssue::new(codes::BASIS_MISMATCH),
            );
            return work;
        }
        Some(_) => {}
        None if request.preflight => {}
        None => {
            work.block(
                McpAgentStatus::Invalid,
                McpOpIssue::new(codes::BASIS_REQUIRED),
            );
            return work;
        }
    }
    if original.is_some() && fsio::is_write_protected(&path) {
        work.block(
            McpAgentStatus::ReadOnly,
            McpOpIssue::new(codes::FILE_READ_ONLY),
        );
        return work;
    }

    let format = format_of(app, &path);
    let text = match decode(original.as_deref()) {
        Ok(text) => text,
        Err(problem) => {
            work.block(McpAgentStatus::Unreadable, McpOpIssue::from_issue(&problem));
            return work;
        }
    };
    match read_view(app, format, text) {
        Ok(view) => {
            if let Some(container) = view.container_invalid {
                work.block(
                    McpAgentStatus::ReadOnly,
                    McpOpIssue::new(codes::CONTAINER_INVALID).detail(container),
                );
                return work;
            }
        }
        Err(problem) => {
            work.block(McpAgentStatus::Unreadable, McpOpIssue::from_issue(&problem));
            return work;
        }
    }
    let mut store = match open_store(app, format, text) {
        Ok(store) => store,
        Err(problem) => {
            work.block(McpAgentStatus::Unreadable, McpOpIssue::from_issue(&problem));
            return work;
        }
    };
    // The container itself there twice: the agent reads the last one, an
    // edit would reach the first. Nothing in this document is edited.
    if let Some(container) = store.duplicate_container() {
        work.block(
            McpAgentStatus::ReadOnly,
            McpOpIssue::new(codes::DUPLICATE_KEY).detail(container),
        );
        return work;
    }
    let gate_changes = run_ops(&spec, store.as_mut(), ops, &mut work);
    let updated = store.finish();
    if !work.issues.is_empty() {
        work.blocked.get_or_insert(McpAgentStatus::Invalid);
        return work;
    }
    if updated != text {
        if format == McpConfigFormat::Yaml && yaml_doc::has_comments(text) {
            work.warnings
                .push(McpOpIssue::new(codes::YAML_COMMENTS_LOST));
        }
        work.files.push(FilePlan {
            path: path.clone(),
            role: "servers",
            original: original.clone(),
            planned: updated.into_bytes(),
            codex: is_codex,
        });
    }

    // The settings file whose `enabledPlugins` follows the servers.
    if let Some(gate_path) = paths.plugin_gate.filter(|_| !gate_changes.is_empty()) {
        let about = gate_path.display().to_string();
        let planned = fsio::read_bytes(&gate_path)
            .map_err(|e| {
                let issue = read_issue(&e);
                McpIssue {
                    code: issue.code,
                    field: None,
                    detail: issue.detail,
                }
            })
            .and_then(|bytes| {
                let text = decode(bytes.as_deref())?.to_string();
                let planned = plugin_gate::apply(&text, &gate_changes)?;
                Ok((bytes, planned))
            });
        match planned {
            Ok((gate_original, Some(planned))) => work.files.push(FilePlan {
                path: gate_path.clone(),
                role: "plugin_gate",
                original: gate_original,
                planned: planned.into_bytes(),
                codex: false,
            }),
            Ok((_, None)) => {}
            // A key of it that is there twice: the same refusal as in the
            // servers' own file, about this one.
            Err(problem) if problem.code == codes::DUPLICATE_KEY => {
                let mut issue = McpOpIssue::new(codes::DUPLICATE_KEY).field(&about);
                issue.detail = problem.detail;
                work.block(McpAgentStatus::ReadOnly, issue);
            }
            Err(problem) => {
                let detail = match problem.detail {
                    Some(detail) => format!("{}: {detail}", problem.code),
                    None => problem.code,
                };
                work.block(
                    McpAgentStatus::Unreadable,
                    McpOpIssue::new(codes::RELATED_FILE_UNREADABLE)
                        .field(&about)
                        .detail(detail),
                );
            }
        }
    }
    work
}

/// A file this run wrote, and what it needs to be put back.
struct Written {
    work: usize,
    path: PathBuf,
    original: Option<Vec<u8>>,
    written: Vec<u8>,
    codex: bool,
    backup: Option<PathBuf>,
}

fn commit_issue(error: McpCommitError) -> McpOpIssue {
    match error {
        McpCommitError::Changed => McpOpIssue::new(codes::BASIS_MISMATCH),
        McpCommitError::OutsideMcpServers => McpOpIssue::new(codes::OUTSIDE_MCP_SERVERS),
        McpCommitError::Invalid(detail) => McpOpIssue::new(codes::EDIT_FAILED).detail(detail),
        McpCommitError::Io(detail) => McpOpIssue::new(codes::WRITE_FAILED).detail(detail),
    }
}

/// Copy the file as it was, then replace it. Returns where the copy is.
fn write_file(
    ctx: &EngineCtx,
    app: McpAppType,
    file: &FilePlan,
    codex: &CodexAccess<'_>,
) -> Result<Option<PathBuf>, McpOpIssue> {
    let gate = match (file.codex, codex) {
        (true, CodexAccess::Locked(gate)) => Some(*gate),
        (true, _) => {
            // Never written without its lock.
            return Err(McpOpIssue::new(codes::CODEX_LOCK_BUSY));
        }
        (false, _) => None,
    };
    // Once more, right before the write: the agents take no lock, and one
    // may have saved its config while the others were being prepared.
    let current = match gate {
        Some(gate) => gate.read(),
        None => fsio::read_bytes(&file.path),
    }
    .map_err(|e| io_issue(codes::WRITE_FAILED, &e))?;
    if current != file.original {
        return Err(McpOpIssue::new(codes::BASIS_MISMATCH));
    }
    let backup = match &file.original {
        Some(original) => Some(
            fsio::backup(&ctx.backup_dir(app), &file.path, original)
                .map_err(|e| io_issue(codes::BACKUP_FAILED, &e))?,
        ),
        None => None,
    };
    #[cfg(test)]
    hooks::injected_failure(&file.path).map_err(|e| io_issue(codes::WRITE_FAILED, &e))?;
    match gate {
        Some(gate) => gate
            .commit(
                file.original.as_deref(),
                McpConfigChange::Write(&file.planned),
            )
            .map_err(commit_issue)?,
        None => fsio::write_atomic(&file.path, &file.planned)
            .map_err(|e| io_issue(codes::WRITE_FAILED, &e))?,
    }
    #[cfg(test)]
    hooks::written(&file.path);
    Ok(backup)
}

enum Undone {
    Restored,
    /// Something else changed the file after codeg wrote it.
    Skipped,
    Failed(String),
}

/// Put a written file back as it was — if it still is what codeg wrote.
fn restore_file(written: &Written, codex: &CodexAccess<'_>) -> Undone {
    let gate = match (written.codex, codex) {
        (true, CodexAccess::Locked(gate)) => Some(*gate),
        (true, _) => return Undone::Failed("Codex's lock is not held".to_string()),
        (false, _) => None,
    };
    let current = match gate {
        Some(gate) => gate.read(),
        None => fsio::read_bytes(&written.path),
    };
    match current {
        Ok(Some(bytes)) if bytes == written.written => {}
        Ok(_) => return Undone::Skipped,
        Err(e) => return Undone::Failed(e.to_string()),
    }
    let outcome = match (gate, &written.original) {
        (Some(gate), Some(original)) => gate
            .commit(Some(&written.written), McpConfigChange::Write(original))
            .map_err(|e| e.to_string()),
        (Some(gate), None) => gate
            .commit(Some(&written.written), McpConfigChange::Remove)
            .map_err(|e| e.to_string()),
        (None, Some(original)) => {
            fsio::write_atomic(&written.path, original).map_err(|e| e.to_string())
        }
        (None, None) => fsio::remove_file(&written.path).map_err(|e| e.to_string()),
    };
    match outcome {
        Ok(()) => Undone::Restored,
        Err(detail) => Undone::Failed(detail),
    }
}

/// The agents the operations name, in the order they first appear, each with
/// its operations and their positions.
fn group_ops(ops: &[McpOp]) -> Vec<(McpAppType, Vec<(usize, &McpOp)>)> {
    let mut groups: Vec<(McpAppType, Vec<(usize, &McpOp)>)> = Vec::new();
    for (index, op) in ops.iter().enumerate() {
        match groups.iter_mut().find(|(app, _)| *app == op.agent) {
            Some((_, group)) => group.push((index, op)),
            None => groups.push((op.agent, vec![(index, op)])),
        }
    }
    groups
}

/// A run that could not start: another codeg held the MCP write lock.
pub(crate) fn busy_result(
    ctx: &EngineCtx,
    request: &McpApplyRequest,
    problem: McpOpIssue,
) -> McpApplyResult {
    let agents = group_ops(&request.ops)
        .into_iter()
        .map(|(app, _)| McpAgentResult {
            agent: app,
            path: ctx
                .paths_of(app)
                .map(|paths| paths.servers.display().to_string())
                .unwrap_or_default(),
            status: McpAgentStatus::NotWritten,
            basis: None,
            issues: vec![problem.clone()],
            warnings: Vec::new(),
            ops: Vec::new(),
            writes: Vec::new(),
            backup_paths: Vec::new(),
        })
        .collect();
    McpApplyResult {
        outcome: McpApplyOutcome::Busy,
        ok: false,
        agents,
    }
}

/// Run `request` with the locks it needs already held (none, for a
/// preflight). See the module docs.
pub(crate) fn apply_locked(
    ctx: &EngineCtx,
    request: &McpApplyRequest,
    codex: &CodexAccess<'_>,
) -> McpApplyResult {
    let mut works: Vec<Work> = group_ops(&request.ops)
        .iter()
        .map(|(app, ops)| prepare(ctx, *app, ops, request, codex))
        .collect();

    let blocked = works.iter().any(|work| work.blocked.is_some());
    if request.preflight || blocked {
        let outcome = if works
            .iter()
            .any(|work| work.blocked == Some(McpAgentStatus::ChangedElsewhere))
        {
            McpApplyOutcome::ChangedElsewhere
        } else if !blocked {
            McpApplyOutcome::Preflight
        } else if works.iter().any(|work| {
            work.issues.iter().any(|issue| {
                matches!(
                    issue.code.as_str(),
                    codes::CODEX_LOCK_BUSY | codes::CODEX_LOCK_HELD
                )
            })
        }) {
            McpApplyOutcome::Busy
        } else if request.preflight {
            McpApplyOutcome::Preflight
        } else {
            McpApplyOutcome::Invalid
        };
        let agents = works
            .iter()
            .map(|work| {
                let status = match work.blocked {
                    Some(status) => status,
                    None if !request.preflight => McpAgentStatus::NotWritten,
                    None if work.files.is_empty() => McpAgentStatus::Unchanged,
                    None => McpAgentStatus::Ready,
                };
                work.result(status, Vec::new())
            })
            .collect();
        return McpApplyResult {
            outcome,
            ok: !blocked,
            agents,
        };
    }

    // Everything checks out: write, file by file.
    let mut written: Vec<Written> = Vec::new();
    let mut failure: Option<(usize, McpOpIssue)> = None;
    'agents: for (index, work) in works.iter().enumerate() {
        for file in &work.files {
            match write_file(ctx, work.app, file, codex) {
                Ok(backup) => written.push(Written {
                    work: index,
                    path: file.path.clone(),
                    original: file.original.clone(),
                    written: file.planned.clone(),
                    codex: file.codex,
                    backup,
                }),
                Err(problem) => {
                    failure = Some((index, problem));
                    break 'agents;
                }
            }
        }
    }

    let backups_of = |index: usize| -> Vec<String> {
        written
            .iter()
            .filter(|file| file.work == index)
            .filter_map(|file| file.backup.as_ref())
            .map(|path| path.display().to_string())
            .collect()
    };

    let Some((failed_at, problem)) = failure else {
        let agents = works
            .iter_mut()
            .enumerate()
            .map(|(index, work)| {
                let status = if work.files.is_empty() {
                    McpAgentStatus::Unchanged
                } else {
                    // The basis of what is on disk now.
                    if let Some(servers) = work.files.iter().find(|file| file.role == "servers") {
                        work.basis = Some(fsio::basis_of(Some(&servers.planned)));
                    }
                    McpAgentStatus::Written
                };
                work.result(status, backups_of(index))
            })
            .collect();
        return McpApplyResult {
            outcome: McpApplyOutcome::Applied,
            ok: true,
            agents,
        };
    };

    // A write failed: put back what was written, newest first.
    let mut undone: BTreeMap<usize, Vec<(PathBuf, Undone)>> = BTreeMap::new();
    for file in written.iter().rev() {
        undone
            .entry(file.work)
            .or_default()
            .push((file.path.clone(), restore_file(file, codex)));
    }
    let agents = works
        .iter_mut()
        .enumerate()
        .map(|(index, work)| {
            let mut status = if index == failed_at {
                work.issues.push(problem.clone());
                McpAgentStatus::WriteFailed
            } else if index < failed_at && !work.files.is_empty() {
                McpAgentStatus::Restored
            } else if index < failed_at {
                McpAgentStatus::Unchanged
            } else {
                McpAgentStatus::NotWritten
            };
            for (path, outcome) in undone.remove(&index).unwrap_or_default() {
                let about = path.display().to_string();
                match outcome {
                    Undone::Restored => {}
                    Undone::Skipped => {
                        work.issues
                            .push(McpOpIssue::new(codes::CHANGED_AFTER_WRITE).field(&about));
                        if status != McpAgentStatus::RestoreFailed {
                            status = McpAgentStatus::RestoreSkipped;
                        }
                    }
                    Undone::Failed(detail) => {
                        work.issues.push(
                            McpOpIssue::new(codes::RESTORE_FAILED)
                                .field(&about)
                                .detail(detail),
                        );
                        status = McpAgentStatus::RestoreFailed;
                    }
                }
            }
            // Whatever is on disk now is what the next attempt starts from.
            if let Ok(bytes) = fsio::read_bytes(&work.path) {
                work.basis = Some(fsio::basis_of(bytes.as_deref()));
            }
            work.result(status, backups_of(index))
        })
        .collect();
    McpApplyResult {
        outcome: McpApplyOutcome::WriteFailed,
        ok: false,
        agents,
    }
}

/// The agents whose files a run left changed.
pub(crate) fn changed_agents(result: &McpApplyResult) -> Vec<McpAppType> {
    result
        .agents
        .iter()
        .filter(|agent| {
            matches!(
                agent.status,
                McpAgentStatus::Written
                    | McpAgentStatus::RestoreSkipped
                    | McpAgentStatus::RestoreFailed
            )
        })
        .map(|agent| agent.agent)
        .collect()
}

/// The flag an entry of `app` carries: an entry in OpenCode's older
/// location has 1.x's.
pub(crate) fn entry_flag(spec: &AgentSpec, legacy: bool) -> Option<super::agents::EntryFlag> {
    if legacy && spec.app == McpAppType::OpenCode {
        Some(OPENCODE_LEGACY_FLAG)
    } else {
        spec.disable.entry
    }
}

#[cfg(test)]
pub(crate) mod hooks {
    //! Failures a test asks for, on the thread that runs the apply.
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};

    type AfterWrite = Box<dyn Fn(&Path)>;

    thread_local! {
        static FAIL_WRITE_OF: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
        static AFTER_WRITE: RefCell<Option<AfterWrite>> = const { RefCell::new(None) };
    }

    /// Make the write of this file fail.
    pub(crate) fn fail_write_of(path: Option<PathBuf>) {
        FAIL_WRITE_OF.with(|slot| *slot.borrow_mut() = path);
    }

    /// Run this after each file is written, with its path.
    pub(crate) fn after_write(run: Option<AfterWrite>) {
        AFTER_WRITE.with(|slot| *slot.borrow_mut() = run);
    }

    pub(super) fn injected_failure(path: &Path) -> std::io::Result<()> {
        let fails = FAIL_WRITE_OF.with(|slot| slot.borrow().as_deref() == Some(path));
        if fails {
            Err(std::io::Error::other("injected write failure"))
        } else {
            Ok(())
        }
    }

    pub(super) fn written(path: &Path) {
        AFTER_WRITE.with(|slot| {
            if let Some(run) = slot.borrow().as_ref() {
                run(path);
            }
        });
    }
}
