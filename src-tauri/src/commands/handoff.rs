//! Account-aware, cancellation-shielded handoffs. Native Claude transfers use
//! the account picker's verified copy/load path. Other agents receive a saved
//! context archive, with a durable retry if their first prompt fails.
use super::{
    acp::{account_runtime_env, build_account_session_runtime_env, verify_agent_installed},
    conversations::{emit_conversation_upsert, get_folder_conversation_core},
};
use crate::{
    acp::{
        account_transfer, agent_accounts,
        handoff::{self, HandoffPath},
        handoff_context,
        manager::ConnectionManager,
        types::{AcpEvent, ConnectionStatus, PromptInputBlock},
    },
    app_error::AppCommandError,
    db::{
        entities::conversation,
        service::{agent_account_service, conversation_service, folder_service, handoff_service},
        AppDatabase,
    },
    models::{AgentType, DbConversationSummary, MessageTurn},
    web::event_bridge::{emit_with_state, EventEmitter},
};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

fn failure(e: impl std::fmt::Display) -> AppCommandError {
    AppCommandError::task_execution_failed(e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffPlan {
    pub source_agent_type: AgentType,
    pub source_account_id: Option<String>,
    pub source_external_id: Option<String>,
    pub target_agent_type: AgentType,
    pub target_account_id: Option<String>,
    pub path: HandoffPath,
    pub native_reason: Option<&'static str>,
    pub blocked: Option<&'static str>,
    pub blocked_message: Option<String>,
    pub turn_count: usize,
    pub briefing_chars: usize,
    pub briefing_truncated: bool,
    pub verbatim_turns: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffResult {
    pub conversation_id: i32,
    pub folder_id: i32,
    pub from_agent_type: AgentType,
    pub to_agent_type: AgentType,
    pub agent_account_id: Option<String>,
    pub external_id: String,
    pub path: HandoffPath,
    pub connection_id: String,
    pub briefing_truncated: bool,
    pub response_started: bool,
    pub working_dir: String,
}

#[derive(Debug, Clone)]
pub struct HandoffRequest {
    pub conversation_id: i32,
    pub target_agent_type: AgentType,
    pub target_account_id: Option<String>,
    pub source_agent_type: AgentType,
    pub source_account_id: Option<String>,
    pub source_external_id: String,
    pub note: Option<String>,
    pub preferred_mode_id: Option<String>,
    pub preferred_config_values: BTreeMap<String, String>,
}

struct Prepared {
    summary: DbConversationSummary,
    working_dir: String,
    plan: HandoffPlan,
    source_storage: Option<(AgentType, PathBuf)>,
    target_env: BTreeMap<String, String>,
    turns: Vec<MessageTurn>,
    source_stats: Option<crate::models::SessionStats>,
}

async fn prepare(
    db: &AppDatabase,
    data_dir: &Path,
    id: i32,
    target: AgentType,
    target_account: Option<&str>,
) -> Result<Prepared, AppCommandError> {
    let summary = conversation_service::get_by_id(&db.conn, id).await?;
    let folder = folder_service::get_folder_by_id(&db.conn, summary.folder_id).await?;
    let cwd = summary
        .origin_cwd
        .clone()
        .or_else(|| folder.map(|f| f.path))
        .ok_or_else(|| AppCommandError::not_found("Conversation folder not found."))?;
    let mut plan = HandoffPlan {
        source_agent_type: summary.agent_type,
        source_account_id: summary.agent_account_id.clone(),
        source_external_id: summary.external_id.clone(),
        target_agent_type: target,
        target_account_id: target_account.map(str::to_string),
        path: handoff::plan_path(summary.agent_type, target),
        native_reason: None,
        blocked: None,
        blocked_message: None,
        turn_count: 0,
        briefing_chars: 0,
        briefing_truncated: false,
        verbatim_turns: 0,
    };
    if plan.path == HandoffPath::Summary {
        plan.path = HandoffPath::Context;
    }
    if summary.agent_type == target && summary.agent_account_id.as_deref() == target_account {
        plan.blocked = Some("same_agent");
    } else if summary.parent_id.is_some() {
        plan.blocked = Some("child_session");
    } else if summary.external_id.as_deref().unwrap_or("").is_empty() {
        plan.blocked = Some("no_session");
    } else if target == AgentType::OpenClaw {
        plan.blocked = Some("remote_context");
    }
    let target_env =
        match account_runtime_env(db, target, None, data_dir, target_account, false).await {
            Ok(env) => env,
            Err(error) => {
                plan.blocked = Some("disabled");
                plan.blocked_message = Some(error.to_string());
                BTreeMap::new()
            }
        };
    if plan.blocked.is_none() {
        if let Err(error) = verify_agent_installed(target).await {
            plan.blocked = Some("not_installed");
            plan.blocked_message = Some(error.to_string());
        }
    }
    let source_env = if let Some(account) = summary.agent_account_id.as_deref() {
        let account = agent_account_service::get(&db.conn, account).await?;
        if account.agent_type != summary.agent_type.as_wire() {
            return Err(failure("Invalid source account."));
        }
        agent_accounts::isolation_env(summary.agent_type, Path::new(&account.home_dir))
            .map_err(failure)?
    } else {
        account_runtime_env(
            db,
            summary.agent_type,
            summary.external_id.as_deref(),
            data_dir,
            None,
            false,
        )
        .await
        .map_err(failure)?
    };
    let source_storage = agent_accounts::storage_identity(summary.agent_type, &source_env);
    let detail = get_folder_conversation_core(&db.conn, id).await?.0;
    let summary = detail.summary;
    plan.source_agent_type = summary.agent_type;
    plan.source_account_id = summary.agent_account_id.clone();
    plan.source_external_id = summary.external_id.clone();
    let source_stats = detail.session_stats;
    let turns = detail.turns;
    plan.turn_count = turns
        .iter()
        .filter(|t| !handoff::is_divider_turn(t))
        .count();
    if plan.blocked.is_none() && plan.turn_count == 0 {
        plan.blocked = Some("empty_history");
    }
    if plan.blocked.is_none() && plan.path == HandoffPath::Native {
        let target_storage = agent_accounts::storage_identity(target, &target_env);
        match (&source_storage, &target_storage) {
            (Some((AgentType::ClaudeCode, source)), Some((AgentType::ClaudeCode, dest))) => {
                if let Err(error) = account_transfer::ensure_session_task_lists(
                    source,
                    dest,
                    Path::new(&cwd),
                    summary.external_id.as_deref().unwrap_or(""),
                    &[&source_env, &target_env],
                ) {
                    plan.blocked = Some("custom_task_list");
                    plan.blocked_message = Some(error.to_string());
                }
                if source == dest
                    || matches!((source.canonicalize(), dest.canonicalize()), (Ok(a), Ok(b)) if a == b)
                {
                    plan.blocked = Some("same_store");
                }
                if crate::parsers::claude::find_session_file_in(
                    &source.join("projects"),
                    summary.external_id.as_deref().unwrap_or(""),
                )
                .is_none()
                {
                    plan.blocked = Some("empty_history");
                }
            }
            _ => {
                plan.blocked = Some("empty_history");
            }
        }
    }
    Ok(Prepared {
        summary,
        working_dir: cwd,
        plan,
        source_storage,
        target_env,
        turns,
        source_stats,
    })
}

pub async fn handoff_plan_core(
    db: &AppDatabase,
    data_dir: &Path,
    id: i32,
    target: AgentType,
    account: Option<&str>,
) -> Result<HandoffPlan, AppCommandError> {
    Ok(prepare(db, data_dir, id, target, account).await?.plan)
}

pub async fn handoff_core(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    data_dir: &Path,
    owner: String,
    request: HandoffRequest,
) -> Result<HandoffResult, AppCommandError> {
    let db = AppDatabase {
        conn: db.conn.clone(),
    };
    let manager = manager.clone_ref();
    let emitter = emitter.clone();
    let data = data_dir.to_path_buf();
    tokio::spawn(async move { handoff_inner(&db, &manager, &emitter, &data, owner, request).await })
        .await
        .map_err(failure)?
}

async fn handoff_inner(
    db: &AppDatabase,
    manager: &ConnectionManager,
    emitter: &EventEmitter,
    data_dir: &Path,
    owner: String,
    request: HandoffRequest,
) -> Result<HandoffResult, AppCommandError> {
    let barrier = manager.lock_out_new_connections().await;
    let target = request.target_agent_type;
    let mut prepared = prepare(
        db,
        data_dir,
        request.conversation_id,
        target,
        request.target_account_id.as_deref(),
    )
    .await?;
    if let Some(code) = prepared.plan.blocked {
        return Err(AppCommandError::invalid_input(
            prepared
                .plan
                .blocked_message
                .clone()
                .unwrap_or_else(|| format!("Cannot switch this conversation: {code}.")),
        )
        .with_detail(code));
    }
    let source = prepared.summary.agent_type;
    let sid = prepared.summary.external_id.clone().unwrap();
    if source != request.source_agent_type
        || prepared.summary.agent_account_id != request.source_account_id
        || sid != request.source_external_id
    {
        return Err(failure(
            "The conversation changed. Reopen the switch dialog and try again.",
        ));
    }
    if conversation::Entity::find()
        .filter(conversation::Column::ParentId.eq(prepared.summary.id))
        .filter(conversation::Column::Status.eq(conversation::ConversationStatus::InProgress))
        .one(&db.conn)
        .await
        .map_err(failure)?
        .is_some()
    {
        return Err(failure(
            "Wait for the delegated work to finish before switching agents.",
        ));
    }
    let target_storage = agent_accounts::storage_identity(target, &prepared.target_env);
    let native = prepared.plan.path == HandoffPath::Native;
    let guards = if native {
        let source_root = &prepared.source_storage.as_ref().unwrap().1;
        let target_root = &target_storage.as_ref().unwrap().1;
        let mut conflict = conversation::Entity::find()
            .filter(conversation::Column::AgentType.eq(target.as_wire().into_owned()))
            .filter(conversation::Column::ExternalId.eq(sid.clone()))
            .filter(conversation::Column::Id.ne(request.conversation_id));
        conflict = match request.target_account_id.as_deref() {
            Some(id) => conflict.filter(conversation::Column::AgentAccountId.eq(id)),
            None => conflict.filter(conversation::Column::AgentAccountId.is_null()),
        };
        if conflict.one(&db.conn).await.map_err(failure)?.is_some() {
            return Err(failure(
                "The selected account already has this conversation. Open its existing chat.",
            ));
        }
        manager
            .quiesce_account_session(&barrier, source_root, target_root, &sid)
            .await
            .map_err(failure)?
    } else {
        manager
            .quiesce_handoff_source(
                &barrier,
                request.conversation_id,
                source,
                request.source_account_id.as_deref(),
                &sid,
                prepared.source_storage.as_ref(),
            )
            .await
            .map_err(failure)?
    };
    // Capture after every source writer stopped, including queued prompts.
    let stopped = get_folder_conversation_core(&db.conn, request.conversation_id)
        .await?
        .0;
    prepared.turns = stopped.turns;
    prepared.source_stats = stopped.session_stats;
    prepared.summary.model = stopped.summary.model;
    let segment =
        handoff_service::native_turns(&db.conn, source, &sid, request.source_account_id.as_deref())
            .await?;
    let links: Vec<_> = handoff_service::list_for_conversation(&db.conn, request.conversation_id)
        .await?
        .iter()
        .filter_map(handoff::HandoffLink::from_row)
        .collect();
    let segment = handoff::clean_seeded_turns(segment, &links);
    if segment.is_empty() && links.is_empty() {
        return Err(failure(
            "The saved conversation is empty. Restore its history before switching agents.",
        ));
    }
    let history_json = serde_json::to_string(&segment).map_err(failure)?;
    let note = request
        .note
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string);
    let mut archive = if native {
        None
    } else {
        let turns = prepared.turns.clone();
        let note = note.clone();
        Some(
            tokio::task::spawn_blocking(move || {
                handoff_context::write_archive(
                    &crate::paths::codeg_conversation_context_root(),
                    &turns,
                    &source.to_string(),
                    &target.to_string(),
                    note.as_deref(),
                )
            })
            .await
            .map_err(failure)?
            .map_err(failure)?,
        )
    };
    let mut transfer = None;
    let mut aside = None;
    if native {
        transfer = Some(
            account_transfer::copy_claude_session(
                &prepared.source_storage.as_ref().unwrap().1,
                &target_storage.as_ref().unwrap().1,
                &sid,
            )
            .map_err(failure)?,
        );
        if target.custom_id().is_some() {
            let path = crate::acp_transcript::transcript_path_in(
                &crate::paths::codeg_acp_transcripts_root(),
                crate::acp::registry::registry_id_for(target),
                &sid,
            );
            if let Some(path) = path.filter(|p| p.exists()) {
                let backup = path.with_extension(format!("jsonl.handoff-{}", uuid::Uuid::new_v4()));
                if let Err(e) = std::fs::rename(&path, &backup) {
                    transfer.as_ref().unwrap().rollback().map_err(failure)?;
                    return Err(failure(e));
                }
                aside = Some((path, backup));
            }
        }
    }
    let mut env = build_account_session_runtime_env(
        db,
        target,
        native.then_some(sid.as_str()),
        data_dir,
        request.target_account_id.as_deref(),
    )
    .await;
    if let (Ok(env), Some(archive)) = (&mut env, &archive) {
        env.insert(
            handoff_context::CONTEXT_ENV.into(),
            archive
                .directory
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );
    }
    if native {
        if let (Ok(env), Some(id)) = (
            &mut env,
            handoff_service::context_for_conversation(&db.conn, request.conversation_id).await?,
        ) {
            env.insert(handoff_context::CONTEXT_ENV.into(), id);
        }
    }
    let requested_config = request.preferred_config_values.clone();
    let startup = async {
        let connection = manager.spawn_agent_during_handoff(&barrier, target, prepared.working_dir.clone(), native.then_some(sid.clone()), env.map_err(failure)?, owner, emitter.clone(), request.preferred_mode_id, request.preferred_config_values).await.map_err(failure)?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        loop {
            let state = manager.get_state(&connection).await.ok_or_else(|| failure("The selected agent stopped before the conversation was ready."))?;
            let state = state.read().await;
            if state.status == ConnectionStatus::Connected && state.selectors_ready {
                if let Some(session) = &state.external_id {
                    if (!native || state.has_restored_session(&sid)) && state.agent_account_id == request.target_account_id
                        && (!native || super::account_switch::requested_model_applied(&requested_config, state.config_options.as_deref())) {
                        return Ok((connection.clone(), session.clone()));
                    }
                }
            }
            let failed = matches!(state.status, ConnectionStatus::Error | ConnectionStatus::Disconnected)
                || (state.status == ConnectionStatus::Connected && state.selectors_ready) || tokio::time::Instant::now() >= deadline;
            drop(state);
            if failed {
                manager.disconnect_and_wait_for_account_switch(&connection).await.map_err(failure)?;
                return Err(failure("The selected agent could not restore the conversation. The original account and history were kept."));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }.await;
    let (connection_id, external_id) = match startup {
        Ok(result) => result,
        Err(error) => {
            rollback(
                manager,
                transfer.as_ref(),
                target_storage.as_ref().map(|s| s.1.as_path()),
                &sid,
                aside.as_ref(),
            )
            .await?;
            return Err(error);
        }
    };
    // Historical @mentions are context, not a new routing request. The seed
    // body goes through the internal suffix path; only the user's new note
    // participates in the normal mention-routing rules.
    let native_note = if native {
        note.as_ref().map(|note| {
            format!(
                "{}\nNative switch note {}:\n{}",
                handoff::BRIEFING_MARKER,
                uuid::Uuid::new_v4(),
                note
            )
        })
    } else {
        None
    };
    let seed_prompt = if archive.is_some() {
        Some(format!(
            "{}\nContinue this conversation with the saved context.{}",
            handoff::BRIEFING_MARKER,
            note.as_ref().map(|n| format!("\n{n}")).unwrap_or_default()
        ))
    } else {
        native_note.clone()
    };
    let committed = handoff_service::commit(
        &db.conn,
        &prepared.summary,
        handoff_service::NewHandoff {
            conversation_id: request.conversation_id,
            from_agent_type: source,
            from_external_id: Some(sid.clone()),
            to_agent_type: target,
            to_external_id: external_id.clone(),
            path: prepared.plan.path.as_str(),
            carried: native,
            user_turns_before: u32::try_from(handoff::count_user_turns(&prepared.turns))
                .unwrap_or(u32::MAX),
            note: note.clone(),
            briefing: archive.as_ref().map(|a| a.prompt.clone()).or(native_note),
            truncated: false,
            from_account_id: request.source_account_id,
            to_account_id: request.target_account_id.clone(),
            history_json: Some(history_json),
            context_id: archive
                .as_ref()
                .and_then(|a| a.directory.file_name())
                .map(|s| s.to_string_lossy().into_owned()),
            context_pending: !native || note.is_some(),
            source_stats_json: prepared
                .source_stats
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(failure)?,
            source_model: prepared.summary.model.clone(),
        },
    )
    .await;
    if let Err(error) = committed {
        if manager
            .disconnect_and_wait_for_account_switch(&connection_id)
            .await
            .is_err()
        {
            tracing::warn!("[handoff] target shutdown was delayed; checking writers before rollback");
        }
        rollback(
            manager,
            transfer.as_ref(),
            target_storage.as_ref().map(|s| s.1.as_path()),
            &sid,
            aside.as_ref(),
        )
        .await?;
        return Err(error.into());
    }
    if let Some(archive) = &mut archive {
        archive.persist();
    }
    if let Some(transfer) = transfer {
        transfer.discard_staging();
    }
    if let Some((_, backup)) = aside {
        let _ = std::fs::remove_file(backup);
    }
    if let Some(state) = manager.get_state(&connection_id).await {
        emit_with_state(
            &state,
            emitter,
            AcpEvent::ConversationLinked {
                conversation_id: request.conversation_id,
                folder_id: prepared.summary.folder_id,
                parent_conversation_id: None,
                parent_tool_use_id: None,
            },
        )
        .await;
    }
    emit_conversation_upsert(emitter, &db.conn, request.conversation_id).await;
    drop(guards);
    drop(barrier);
    let response_started = if let Some(text) = seed_prompt {
        manager
            .send_prompt_linked(
                db,
                &connection_id,
                vec![PromptInputBlock::Text { text }],
                Some(prepared.summary.folder_id),
                Some(request.conversation_id),
                None,
            )
            .await
            .is_ok()
    } else {
        false
    };
    Ok(HandoffResult {
        conversation_id: request.conversation_id,
        folder_id: prepared.summary.folder_id,
        from_agent_type: source,
        to_agent_type: target,
        agent_account_id: request.target_account_id,
        external_id,
        path: prepared.plan.path,
        connection_id,
        briefing_truncated: false,
        response_started,
        working_dir: prepared.working_dir,
    })
}

async fn rollback(
    manager: &ConnectionManager,
    transfer: Option<&account_transfer::ClaudeTransfer>,
    target: Option<&Path>,
    sid: &str,
    aside: Option<&(PathBuf, PathBuf)>,
) -> Result<(), AppCommandError> {
    if let Some(transfer) = transfer {
        manager
            .wait_for_account_session_writers(target.unwrap(), sid)
            .await
            .map_err(failure)?;
        transfer.rollback().map_err(failure)?;
        transfer.discard_staging();
    }
    if let Some((original, backup)) = aside {
        if original.exists() {
            std::fs::remove_file(original).map_err(failure)?;
        }
        std::fs::rename(backup, original).map_err(failure)?;
    }
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
fn effective_data_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| crate::paths::codeg_home_dir())
}
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn acp_handoff_plan(
    conversation_id: i32,
    target_agent_type: AgentType,
    target_account_id: Option<String>,
    db: tauri::State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<HandoffPlan, AppCommandError> {
    handoff_plan_core(
        &db,
        &effective_data_dir(&app),
        conversation_id,
        target_agent_type,
        target_account_id.as_deref(),
    )
    .await
}
#[cfg(feature = "tauri-runtime")]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn acp_handoff(
    conversation_id: i32,
    target_agent_type: AgentType,
    target_account_id: Option<String>,
    source_agent_type: AgentType,
    source_account_id: Option<String>,
    source_external_id: String,
    note: Option<String>,
    preferred_mode_id: Option<String>,
    preferred_config_values: Option<BTreeMap<String, String>>,
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, ConnectionManager>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<HandoffResult, AppCommandError> {
    let data = effective_data_dir(&app);
    handoff_core(
        &db,
        &manager,
        &EventEmitter::Tauri(app),
        &data,
        window.label().into(),
        HandoffRequest {
            conversation_id,
            target_agent_type,
            target_account_id,
            source_agent_type,
            source_account_id,
            source_external_id,
            note,
            preferred_mode_id,
            preferred_config_values: preferred_config_values.unwrap_or_default(),
        },
    )
    .await
}
