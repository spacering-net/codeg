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

use super::agents::{custom_spec, format_of, spec, AgentSpec, EngineCtx};
use super::dialect;
use super::fsio;
use super::json_doc::OPENCODE_LEGACY_FLAG;
use super::model::{
    codes, is_valid_new_key, McpAgentId, McpAgentResult, McpAgentStatus, McpApplyOutcome,
    McpApplyRequest, McpApplyResult, McpConfigFormat, McpDisableMode, McpFileWrite, McpIssue,
    McpOp, McpOpAction, McpOpEffect, McpOpIssue, McpOpResult, RESERVED_KEY,
};
use super::paused::{self, PausedEntries, PausedEntry, PausedFile};
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
    agent: McpAgentId,
    path: PathBuf,
    /// Set once something stops this agent's operations.
    blocked: Option<McpAgentStatus>,
    basis: Option<String>,
    planned_basis: Option<String>,
    /// Native bytes a paused-file-only transaction must still see on disk.
    paused_native_basis: Option<String>,
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
            agent: self.agent.clone(),
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
    paused: &mut PausedEntries,
) -> Vec<(String, bool)> {
    let app = spec.app;
    let soft_disable = spec.disable_mode() == McpDisableMode::CodegPause;
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
        let resume;
        let action = match op.action {
            McpOpAction::SetEnabled { enabled: true } if soft_disable => {
                if store.get(key).is_some() {
                    done(McpOpEffect::Unchanged, &mut work.op_results);
                    continue;
                }
                let Some(entry) = paused.get(key) else {
                    work.issues.push(issue(codes::ENTRY_NOT_FOUND));
                    continue;
                };
                resume = McpOpAction::Set {
                    definition: entry.definition.clone(),
                };
                &resume
            }
            _ => &op.action,
        };
        let resuming =
            matches!(op.action, McpOpAction::SetEnabled { enabled: true }) && soft_disable;
        match action {
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
                let mut fresh = dialect::fresh_fields(app, &definition);
                if resuming {
                    if let Some(entry) = paused.get(key) {
                        fresh.extend(
                            entry
                                .extra
                                .iter()
                                .map(|(key, value)| (key.clone(), value.clone())),
                        );
                    }
                }
                let Some(found) = store.get(key) else {
                    if !resuming && !is_valid_new_key(key) {
                        work.issues.push(issue(codes::KEY_INVALID));
                        continue;
                    }
                    if store.is_structural_key(key) {
                        work.issues.push(issue(codes::KEY_STRUCTURAL));
                        continue;
                    }
                    match store.create(key, &fresh) {
                        Ok(()) => {
                            let had_pause = paused.remove(key).is_some();
                            let effect = if resuming {
                                McpOpEffect::Enabled
                            } else if had_pause {
                                McpOpEffect::Updated
                            } else {
                                McpOpEffect::Created
                            };
                            done(effect, &mut work.op_results);
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
                        let was_paused = paused.remove(key).is_some();
                        let effect = if changed || moved || was_paused {
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
                    let removed_pause = paused.remove(key).is_some();
                    if removed || removed_pause {
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
            McpOpAction::SetEnabled { .. } if soft_disable => {
                let Some(found) = store.get(key) else {
                    if paused.contains_key(key) {
                        done(McpOpEffect::Unchanged, &mut work.op_results);
                    } else {
                        work.issues.push(issue(codes::ENTRY_NOT_FOUND));
                    }
                    continue;
                };
                let read = dialect::read_entry(app, &found.value, spec.disable.entry);
                let Some(definition) = read.definition.filter(|_| read.problems.is_empty()) else {
                    work.issues.push(issue(codes::ENTRY_NOT_EDITABLE));
                    continue;
                };
                match store.remove(key) {
                    Ok(true) => {
                        paused.insert(
                            key.to_owned(),
                            PausedEntry {
                                definition,
                                paused_at: chrono::Utc::now(),
                                extra: read.extra,
                            },
                        );
                        done(McpOpEffect::Disabled, &mut work.op_results);
                        gate.push((key.to_string(), false));
                    }
                    Ok(false) => work.issues.push(issue(codes::ENTRY_NOT_FOUND)),
                    Err(detail) => work.issues.push(edit_failed(detail)),
                }
            }
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
                let found = store.get(key);
                if found.is_none() && !paused.contains_key(key) {
                    work.issues.push(issue(codes::ENTRY_NOT_FOUND));
                    continue;
                }
                if new_key == key {
                    done(McpOpEffect::Unchanged, &mut work.op_results);
                    continue;
                }
                if store.get(new_key).is_some() || paused.contains_key(new_key) {
                    work.issues
                        .push(issue(codes::KEY_EXISTS).field("new_key").detail(new_key));
                    continue;
                }
                let Some(found) = found else {
                    let entry = paused.remove(key).expect("paused source was found");
                    paused.insert(new_key.to_owned(), entry);
                    done(McpOpEffect::Renamed, &mut work.op_results);
                    continue;
                };
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
                        paused.remove(key);
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
    agent: &McpAgentId,
    ops: &[(usize, &McpOp)],
    request: &McpApplyRequest,
    codex: &CodexAccess<'_>,
    paused_file: &mut std::io::Result<PausedFile>,
) -> Work {
    let paths = ctx.paths_for(agent);
    let path = paths
        .as_ref()
        .map(|paths| paths.servers.clone())
        .unwrap_or_default();
    let mut work = Work {
        agent: agent.clone(),
        path: path.clone(),
        blocked: None,
        basis: None,
        planned_basis: None,
        paused_native_basis: None,
        issues: Vec::new(),
        warnings: Vec::new(),
        op_results: Vec::new(),
        files: Vec::new(),
    };
    let Some(paths) = paths else {
        work.block(
            McpAgentStatus::ReadOnly,
            McpOpIssue::new(match agent {
                McpAgentId::Builtin(_) => codes::AGENT_READ_ONLY,
                McpAgentId::Custom(_) => codes::AGENT_NOT_WRITABLE,
            }),
        );
        return work;
    };
    let spec = match agent {
        McpAgentId::Builtin(app) => spec(*app),
        McpAgentId::Custom(id) if ctx.custom_agents[id].supports_mcp => custom_spec(true),
        McpAgentId::Custom(_) => {
            work.block(
                McpAgentStatus::ReadOnly,
                McpOpIssue::new(codes::MCP_DISABLED_IN_AGENT_SETTINGS),
            );
            return work;
        }
    };
    let app = spec.app;

    // The file as it is now. Codex's is read under its lock when this run
    // holds it.
    let is_codex = agent.builtin() == Some(McpAppType::Codex);
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
    let paused_file = if spec.disable_mode() == McpDisableMode::CodegPause {
        match paused_file {
            Ok(file) => Some(file),
            Err(error) => {
                work.block(
                    McpAgentStatus::Unreadable,
                    McpOpIssue::from_issue(&paused::read_issue(&ctx.paused_path, error)),
                );
                return work;
            }
        }
    } else {
        None
    };
    let original_entries = paused_file.as_ref().and_then(|file| file.entries(app));
    let basis = paused::basis(&fsio::basis_of(original.as_deref()), original_entries);
    work.basis = Some(basis.clone());

    if spec.scan_only {
        work.block(
            McpAgentStatus::ReadOnly,
            McpOpIssue::new(codes::AGENT_READ_ONLY),
        );
        return work;
    }
    match request.basis.get(agent) {
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
    let mut paused_entries = original_entries.cloned().unwrap_or_default();
    let gate_changes = run_ops(&spec, store.as_mut(), ops, &mut work, &mut paused_entries);
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
    let native_planned = work
        .files
        .iter()
        .find(|file| file.role == "servers")
        .map(|file| file.planned.as_slice())
        .or(original.as_deref());
    let native_basis = fsio::basis_of(native_planned);
    work.planned_basis = Some(paused::basis(&native_basis, Some(&paused_entries)));
    if let Some(file) = paused_file.filter(|_| work.blocked.is_none()) {
        let changed = match file.entries(app) {
            Some(entries) => *entries != paused_entries,
            None => !paused_entries.is_empty(),
        };
        if changed {
            if fsio::is_write_protected(&ctx.paused_path) {
                work.block(
                    McpAgentStatus::ReadOnly,
                    McpOpIssue::new(codes::FILE_READ_ONLY)
                        .field(&ctx.paused_path.display().to_string()),
                );
                return work;
            }
            work.paused_native_basis = Some(native_basis);
            match file.stage(app, paused_entries) {
                Ok(planned) => work.files.push(FilePlan {
                    path: ctx.paused_path.clone(),
                    role: "paused",
                    original: file.bytes.replace(planned.clone()),
                    planned,
                    codex: false,
                }),
                Err(error) => work.block(
                    McpAgentStatus::Invalid,
                    io_issue(codes::EDIT_FAILED, &error),
                ),
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
    work: &Work,
    file: &FilePlan,
    codex: &CodexAccess<'_>,
) -> Result<Option<PathBuf>, McpOpIssue> {
    if let Some(basis) = work
        .paused_native_basis
        .as_ref()
        .filter(|_| file.role == "paused")
    {
        let native =
            fsio::read_bytes(&work.path).map_err(|error| io_issue(codes::WRITE_FAILED, &error))?;
        if fsio::basis_of(native.as_deref()) != *basis {
            return Err(McpOpIssue::new(codes::BASIS_MISMATCH));
        }
    }
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
            fsio::backup(&ctx.backup_dir(&work.agent), &file.path, original)
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
fn group_ops(ops: &[McpOp]) -> Vec<(&McpAgentId, Vec<(usize, &McpOp)>)> {
    let mut groups: Vec<(_, Vec<_>)> = Vec::new();
    for (index, op) in ops.iter().enumerate() {
        match groups.iter_mut().find(|(app, _)| *app == &op.agent) {
            Some((_, group)) => group.push((index, op)),
            None => groups.push((&op.agent, vec![(index, op)])),
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
            agent: app.clone(),
            path: ctx
                .paths_for(app)
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
    let mut paused_file = PausedFile::read(&ctx.paused_path);
    let mut works: Vec<Work> = group_ops(&request.ops)
        .iter()
        .map(|(app, ops)| prepare(ctx, app, ops, request, codex, &mut paused_file))
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
            match write_file(ctx, work, file, codex) {
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
                    work.basis = work.planned_basis.take();
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
    let paused_file = PausedFile::read(&ctx.paused_path);
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
            let paused = match work.agent.builtin() {
                Some(app) if spec(app).disable_mode() == McpDisableMode::CodegPause => {
                    paused_file.as_ref().map(|file| file.entries(app))
                }
                _ => Ok(None),
            };
            work.basis = paused
                .ok()
                .zip(fsio::read_bytes(&work.path).ok())
                .map(|(entries, bytes)| paused::basis(&fsio::basis_of(bytes.as_deref()), entries));
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
pub(crate) fn changed_agents(result: &McpApplyResult) -> Vec<McpAgentId> {
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
        .map(|agent| agent.agent.clone())
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
