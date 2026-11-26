use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::acp::types::PromptInputBlock;
use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::personal_agent as pa;
use crate::db::entities::personal_agent_dispatch::DispatchMode;
use crate::models::personal_agent::{
    DispatchInfo, ItemInfo, PersonalAgentDraft, PersonalAgentFile, PersonalAgentInfo,
    PersonalAgentSnapshot, PersonalAgentStats, TimelineChanges, TimelineCursor, TimelinePage,
    TimelineRow,
};

/// A call that names only the assistant it is about.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BotParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
}

pub async fn personal_agent_get(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BotParams>,
) -> Result<Json<PersonalAgentSnapshot>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_get_core(&state.db, &state.data_dir, params.bot_id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    #[serde(default)]
    pub before_id: Option<i32>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub since_id: Option<i32>,
}

pub async fn personal_agent_timeline(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TimelineParams>,
) -> Result<Json<TimelinePage>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_timeline_core(&state.db, params.bot_id, params.before_id, params.limit, params.since_id)
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRowsParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub ids: Vec<i32>,
}

pub async fn personal_agent_timeline_rows(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TimelineRowsParams>,
) -> Result<Json<Vec<TimelineRow>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_timeline_rows_core(&state.db, params.bot_id, params.ids).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineUpdatedSinceParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    #[serde(default)]
    pub since: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    pub after: Option<TimelineCursor>,
    #[serde(default)]
    pub min_id: Option<i32>,
}

pub async fn personal_agent_timeline_updated_since(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TimelineUpdatedSinceParams>,
) -> Result<Json<TimelineChanges>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_timeline_updated_since_core(&state.db, params.bot_id, params.since, params.after, params.min_id)
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemsParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    #[serde(default)]
    pub status: Option<String>,
}

pub async fn personal_agent_items(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ItemsParams>,
) -> Result<Json<Vec<ItemInfo>>, AppCommandError> {
    Ok(Json(pa::personal_agent_items_core(&state.db, params.bot_id, params.status).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchesParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    #[serde(default)]
    pub mode: Option<DispatchMode>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub ids: Option<Vec<i32>>,
}

pub async fn personal_agent_dispatches(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<DispatchesParams>,
) -> Result<Json<Vec<DispatchInfo>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_dispatches_core(&state.db, params.bot_id, params.mode, params.limit, params.ids)
            .await?,
    ))
}

pub async fn personal_agent_files(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BotParams>,
) -> Result<Json<Vec<PersonalAgentFile>>, AppCommandError> {
    Ok(Json(pa::personal_agent_files_core(&state.db, &state.data_dir, params.bot_id).await?))
}

pub async fn personal_agent_outputs(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BotParams>,
) -> Result<Json<Vec<crate::personal_agent::workdir::OutputDoc>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_outputs_core(&state.db, &state.data_dir, params.bot_id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputReadParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub path: String,
}

pub async fn personal_agent_output_read(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<OutputReadParams>,
) -> Result<Json<String>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_output_read_core(&state.db, &state.data_dir, params.bot_id, params.path)
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    #[serde(default)]
    pub days: Option<u32>,
}

pub async fn personal_agent_stats(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<StatsParams>,
) -> Result<Json<PersonalAgentStats>, AppCommandError> {
    Ok(Json(pa::personal_agent_stats_core(&state.db, params.bot_id, params.days).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub draft: PersonalAgentDraft,
}

pub async fn personal_agent_save(
    Json(params): Json<SaveParams>,
) -> Result<Json<PersonalAgentInfo>, AppCommandError> {
    Ok(Json(pa::personal_agent_save_core(params.bot_id, params.draft).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub text: String,
    #[serde(default)]
    pub blocks: Option<Vec<PromptInputBlock>>,
    #[serde(default)]
    pub reply_to: Option<i32>,
    /// The button on the quoted card the message comes from.
    #[serde(default)]
    pub card: Option<crate::personal_agent::card_acts::CardClick>,
    /// The assistant's question the message answers.
    #[serde(default)]
    pub answers_item: Option<i32>,
}

pub async fn personal_agent_send(
    Json(params): Json<SendParams>,
) -> Result<Json<TimelineRow>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_send_core(
            params.bot_id,
            params.text,
            params.blocks,
            params.reply_to,
            params.card,
            params.answers_item,
        )
        .await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardActParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub row_id: i32,
    pub element: String,
    pub action: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub op: Option<String>,
}

pub async fn personal_agent_card_act(
    Json(params): Json<CardActParams>,
) -> Result<Json<TimelineRow>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_card_act_core(
            params.bot_id,
            params.row_id,
            params.element,
            params.action,
            params.label,
            params.op,
        )
        .await?,
    ))
}

pub async fn personal_agent_cancel(
    Json(params): Json<BotParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_cancel_core(params.bot_id).await?;
    Ok(Json(()))
}

pub async fn personal_agent_bots(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<crate::models::personal_agent_roster::RosterEntry>>, AppCommandError> {
    Ok(Json(pa::personal_agent_bots_core(&state.db, &state.data_dir).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterActParams {
    pub bot_id: i32,
    pub act: crate::models::personal_agent_roster::RosterAct,
}

pub async fn personal_agent_roster_act(
    Json(params): Json<RosterActParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_roster_act_core(params.bot_id, params.act).await?;
    Ok(Json(()))
}

pub async fn personal_agent_turn_steps(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BotParams>,
) -> Result<Json<Vec<crate::models::personal_agent_roster::StepLine>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_turn_steps_core(&state.db, params.bot_id).await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemActParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub item_id: i32,
    pub act: String,
    /// `snooze`: until when.
    #[serde(default)]
    pub until: Option<String>,
    /// `panel` (the default) or `card`.
    #[serde(default)]
    pub from: Option<String>,
}

pub async fn personal_agent_item_act(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ItemActParams>,
) -> Result<Json<crate::models::personal_agent::ItemActResult>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_item_act_core(
            &state.db,
            params.bot_id,
            params.item_id,
            params.act,
            params.until,
            params.from,
        )
        .await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemUndoParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub item_id: i32,
    pub undo: i32,
}

pub async fn personal_agent_item_undo(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ItemUndoParams>,
) -> Result<Json<crate::models::personal_agent::ItemInfo>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_item_undo_core(&state.db, params.bot_id, params.item_id, params.undo)
            .await?,
    ))
}

pub async fn personal_agent_presence(
    Extension(state): Extension<Arc<AppState>>,
    Json(beat): Json<crate::personal_agent::presence::Beat>,
) -> Result<Json<crate::personal_agent::presence::Presence>, AppCommandError> {
    Ok(Json(pa::personal_agent_presence_core(&state.db, beat).await))
}

pub async fn personal_agent_profile(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<crate::personal_agent::presence::ProfileView>, AppCommandError> {
    Ok(Json(pa::personal_agent_profile_core(&state.db).await))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySearchParams {
    pub query: String,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub project_id: Option<i32>,
    #[serde(default)]
    pub limit: Option<u32>,
}

pub async fn personal_agent_history_search(
    Extension(state): Extension<Arc<AppState>>,
    Json(p): Json<HistorySearchParams>,
) -> Result<Json<crate::personal_agent::history::Results>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_history_search_core(
            &state.db,
            p.query,
            p.scope,
            p.since,
            p.project_id,
            p.limit,
        )
        .await?,
    ))
}

#[derive(Debug, Deserialize)]
pub struct ProfileUpdateParams {
    pub op: pa::ProfileOp,
}

pub async fn personal_agent_profile_update(
    Extension(state): Extension<Arc<AppState>>,
    Json(p): Json<ProfileUpdateParams>,
) -> Result<Json<crate::personal_agent::presence::ProfileView>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_profile_update_core(&state.db, p.op).await?,
    ))
}

pub async fn personal_agent_grades(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<pa::GradesView>, AppCommandError> {
    Ok(Json(pa::personal_agent_grades_core(&state.db).await))
}

pub async fn personal_agent_history_status(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<crate::personal_agent::history::HistoryStatus>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_history_status_core(&state.db).await,
    ))
}

pub async fn personal_agent_history_rebuild(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<crate::personal_agent::history::HistoryStatus>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_history_rebuild_core(&state.db).await?,
    ))
}

pub async fn personal_agent_today(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<crate::personal_agent::today::TodayView>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_today_core(&state.db, &state.connection_manager).await?,
    ))
}

pub async fn personal_agent_activity(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BotParams>,
) -> Result<Json<crate::personal_agent::activity_view::ActivityView>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_activity_core(&state.db, &state.connection_manager, params.bot_id)
            .await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPrefsSyncParams {
    pub enabled: bool,
    pub hide_body: bool,
}

pub async fn notification_prefs_sync(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<NotificationPrefsSyncParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::notification_prefs_sync_core(&state.db, params.enabled, params.hide_body).await?;
    Ok(Json(()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarPngParams {
    pub bot_id: i32,
    #[serde(default)]
    pub png: Option<String>,
    #[serde(default)]
    pub tray: Option<String>,
}

pub async fn personal_agent_avatar_png(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<AvatarPngParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_avatar_png_core(&state.db, params.bot_id, params.png, params.tray).await?;
    Ok(Json(()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchStopParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub dispatch_id: i32,
}

pub async fn personal_agent_dispatch_stop(
    Json(params): Json<DispatchStopParams>,
) -> Result<Json<bool>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_dispatch_stop_core(params.bot_id, params.dispatch_id).await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskAnswerParams {
    pub ask_id: i32,
    #[serde(default)]
    pub answer: Option<crate::acp::question::QuestionAnswer>,
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub feedback: Option<String>,
}

pub async fn personal_agent_ask_answer(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<AskAnswerParams>,
) -> Result<Json<pa::AskAnswerOutcome>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_ask_answer_core(
            &state.db,
            params.ask_id,
            params.answer,
            params.decision,
            params.feedback,
        )
        .await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTargetParams {
    pub conversation_id: i32,
}

pub async fn personal_agent_conversation_target(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ConversationTargetParams>,
) -> Result<Json<crate::models::personal_agent::ConversationTarget>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_conversation_target_core(&state.db, params.conversation_id).await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatchParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub changes: Vec<crate::personal_agent::prefs::SettingChange>,
}

pub async fn personal_agent_settings_patch(
    Json(params): Json<SettingsPatchParams>,
) -> Result<Json<Vec<crate::personal_agent::prefs::Applied>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_settings_patch_core(params.bot_id, params.changes).await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotCreateParams {
    pub draft: crate::models::personal_agent_bots::BotCreateDraft,
}

pub async fn personal_agent_bot_create(
    Json(params): Json<BotCreateParams>,
) -> Result<Json<pa::BotMade>, AppCommandError> {
    Ok(Json(pa::personal_agent_bot_create_core(params.draft).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotCopyParams {
    pub bot_id: i32,
    pub name: String,
    #[serde(default)]
    pub locale: Option<String>,
}

pub async fn personal_agent_bot_copy(
    Json(params): Json<BotCopyParams>,
) -> Result<Json<pa::BotMade>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_bot_copy_core(params.bot_id, params.name, params.locale).await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotIdParams {
    pub bot_id: i32,
}

pub async fn personal_agent_bot_impact(
    Json(params): Json<BotIdParams>,
) -> Result<Json<crate::models::personal_agent_bots::BotImpact>, AppCommandError> {
    Ok(Json(pa::personal_agent_bot_impact_core(params.bot_id).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotDeleteParams {
    pub bot_id: i32,
    #[serde(default)]
    pub options: crate::models::personal_agent_bots::BotDeleteOptions,
}

pub async fn personal_agent_bot_delete(
    Json(params): Json<BotDeleteParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_bot_delete_core(params.bot_id, params.options).await?;
    Ok(Json(()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceAnswerParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub notice_id: i32,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub project_id: Option<i32>,
    #[serde(default)]
    pub answers: Option<Vec<crate::personal_agent::meet::ChoicePick>>,
}

pub async fn personal_agent_choice_answer(
    Json(params): Json<ChoiceAnswerParams>,
) -> Result<Json<TimelineRow>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_choice_answer_core(
            params.bot_id,
            params.notice_id,
            params.key,
            params.text,
            params.project_id,
            params.answers,
        )
        .await?,
    ))
}

pub async fn personal_agent_meet_projects(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<crate::personal_agent::projects::ProjectView>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_meet_projects_core(&state.db).await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StarterParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub notice_id: i32,
}

pub async fn personal_agent_starter(
    Json(params): Json<StarterParams>,
) -> Result<Json<TimelineRow>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_starter_core(params.bot_id, params.notice_id).await?,
    ))
}

pub async fn personal_agent_stop_all(
    Json(params): Json<BotParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_stop_all_core(params.bot_id).await?;
    Ok(Json(()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub thread_id: i32,
}

pub async fn personal_agent_thread(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ThreadParams>,
) -> Result<Json<crate::models::personal_agent::ThreadView>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_thread_core(&state.db, params.bot_id, params.thread_id).await?,
    ))
}

pub async fn personal_agent_compact(
    Json(params): Json<BotParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_compact_core(params.bot_id).await?;
    Ok(Json(()))
}

pub async fn personal_agent_new_session(
    Json(params): Json<BotParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_new_session_core(params.bot_id).await?;
    Ok(Json(()))
}

pub async fn personal_agent_resume_auto_compact(
    Json(params): Json<BotParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_resume_auto_compact_core(params.bot_id).await?;
    Ok(Json(()))
}

pub async fn personal_agent_keepalive(
    Json(params): Json<BotParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_keepalive_core(params.bot_id).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResendParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub row_id: i32,
}

pub async fn personal_agent_resend(
    Json(params): Json<ResendParams>,
) -> Result<Json<TimelineRow>, AppCommandError> {
    Ok(Json(pa::personal_agent_resend_core(params.bot_id, params.row_id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkSeenParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub up_to: i32,
}

pub async fn personal_agent_mark_seen(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<MarkSeenParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_mark_seen_core(&state.db, params.bot_id, params.up_to).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutinesParams {
    /// The assistant whose; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
}

pub async fn personal_agent_routines(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<RoutinesParams>,
) -> Result<Json<Vec<crate::personal_agent::routines::RoutineView>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_routines_core(&state.db, params.bot_id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRunsParams {
    pub routine_id: i32,
    #[serde(default)]
    pub limit: Option<u64>,
}

pub async fn personal_agent_routine_runs(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<RoutineRunsParams>,
) -> Result<Json<Vec<crate::personal_agent::routines::RunView>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_routine_runs_core(&state.db, params.routine_id, params.limit).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineSaveParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    #[serde(default)]
    pub routine_id: Option<i32>,
    pub draft: crate::personal_agent::routines::Draft,
    #[serde(default)]
    pub notice_id: Option<i32>,
}

pub async fn personal_agent_routine_save(
    Json(params): Json<RoutineSaveParams>,
) -> Result<Json<crate::personal_agent::routines::RoutineView>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_routine_save_core(
            params.bot_id,
            params.routine_id,
            params.draft,
            params.notice_id,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineActParams {
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub routine_id: i32,
    pub action: String,
}

pub async fn personal_agent_routine_act(
    Json(params): Json<RoutineActParams>,
) -> Result<Json<crate::personal_agent::routines::RoutineView>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_routine_act_core(params.bot_id, params.routine_id, params.action)
            .await?,
    ))
}

pub async fn personal_agent_rules(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<crate::personal_agent::rules::RuleView>>, AppCommandError> {
    Ok(Json(pa::personal_agent_rules_core(&state.db).await?))
}

#[derive(Deserialize)]
pub struct RuleResetParams {
    pub rule: String,
}

pub async fn personal_agent_rule_reset(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<RuleResetParams>,
) -> Result<Json<Vec<crate::personal_agent::rules::RuleView>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_rule_reset_core(&state.db, params.rule).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeActParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub notice_id: i32,
    pub action: String,
    /// The owner's words, for an answer that carries them (a reminder
    /// handed to the assistant).
    #[serde(default)]
    pub text: Option<String>,
}

pub async fn personal_agent_notice_act(
    Json(params): Json<NoticeActParams>,
) -> Result<Json<TimelineRow>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_notice_act_core(
            params.bot_id,
            params.notice_id,
            params.action,
            params.text,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerQuestionParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub question_id: String,
    pub answer: crate::acp::question::QuestionAnswer,
}

pub async fn personal_agent_answer_question(
    Json(params): Json<AnswerQuestionParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_answer_question_core(params.bot_id, params.question_id, params.answer).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerPlanParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub approval_id: String,
    pub answer: crate::acp::plan_approval::PlanApprovalAnswer,
}

pub async fn personal_agent_answer_plan(
    Json(params): Json<AnswerPlanParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_answer_plan_core(params.bot_id, params.approval_id, params.answer).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespondPermissionParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub request_id: String,
    pub option_id: String,
}

pub async fn personal_agent_respond_permission(
    Json(params): Json<RespondPermissionParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_respond_permission_core(params.bot_id, params.request_id, params.option_id).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSaveParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub name: String,
    pub content: String,
}

pub async fn personal_agent_file_save(
    Json(params): Json<FileSaveParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_file_save_core(params.bot_id, params.name, params.content).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDeleteParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub name: String,
}

pub async fn personal_agent_file_delete(
    Json(params): Json<FileDeleteParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_file_delete_core(params.bot_id, params.name).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSwitchParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    pub name: String,
    pub on: bool,
}

pub async fn personal_agent_skill_switch(
    Json(params): Json<SkillSwitchParams>,
) -> Result<Json<()>, AppCommandError> {
    pa::personal_agent_skill_switch_core(params.bot_id, params.name, params.on).await?;
    Ok(Json(()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckMessageParams {
    pub conversation_id: i32,
    pub message: String,
    #[serde(default)]
    pub asked: Option<String>,
    #[serde(default)]
    pub quote: Option<String>,
    #[serde(default)]
    pub again: Option<bool>,
}

pub async fn personal_agent_check_message(
    Json(params): Json<CheckMessageParams>,
) -> Result<Json<crate::models::personal_agent::MessageCheckView>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_check_message_core(crate::models::personal_agent::MessageCheckRequest {
            conversation_id: params.conversation_id,
            message: params.message,
            asked: params.asked,
            quote: params.quote,
            again: params.again.unwrap_or(false),
        })
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksParams {
    pub conversation_id: i32,
}

pub async fn personal_agent_checks(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ChecksParams>,
) -> Result<Json<Vec<crate::models::personal_agent::MessageCheckView>>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_checks_core(&state.db, params.conversation_id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetWorkdirParams {
    /// The assistant it is about; left out, the primary.
    #[serde(default)]
    pub bot_id: Option<i32>,
    #[serde(default)]
    pub path: Option<String>,
    /// The UI's locale, for the template files of a directory made anew.
    #[serde(default)]
    pub locale: Option<String>,
}

pub async fn personal_agent_set_workdir(
    Json(params): Json<SetWorkdirParams>,
) -> Result<Json<PersonalAgentInfo>, AppCommandError> {
    Ok(Json(
        pa::personal_agent_set_workdir_core(params.bot_id, params.path, params.locale).await?,
    ))
}
