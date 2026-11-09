//! Native cards: written by codeg, not drawn by the model, so what the owner
//! clicks is exactly what runs.
//!
//! - **proposal**: something put in front of the owner instead of done — a
//!   dispatch, a follow-up — recorded in full. The card shows the whole of it
//!   (executor, mode, project, the prompt); [Do this] runs that very content,
//!   [Not now] drops it. Nothing raises one on its own: they come with the
//!   owner's "ask me first" settings (and the assistant's own suggestions).
//! - **uncertain**: a step cut off between going out and being confirmed, so
//!   codeg cannot tell whether it took effect (`ledger`). Never redone on its
//!   own: [Look] opens where it went, [Do it again] sends it again, [Let it
//!   be] closes the card.
//!
//! Acting on a card is two-phase. The card moves from open to acting in one
//! atomic step — the first answer wins, a second is told the card was
//! answered. Then what it runs goes through the ledger under the card's own
//! operation id, and the card settles as that entry does: acted, back to open
//! with the reason, or unknown. A dispatch the card runs commits with the
//! card in one transaction. A restart settles every card left acting by its
//! entry, so a card never reads acted while nothing ran. Either way the
//! assistant hears how the owner answered with its next delivery.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::dispatch::{executor_of, DispatchAuth, DispatchRequest, FollowupAuth, ValidDispatch};
use super::engine::{enum_str, PersonalAgentEngine};
use super::ledger;
use crate::db::entities::personal_agent_dispatch::DispatchMode;
use crate::db::entities::personal_agent_notice::{
    self as notice_entity, NoticeKind, NoticeLevel, NoticeState,
};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{NewNotice, NewRow};
use crate::models::personal_agent::{PersonalAgentChange, TimelineRow};

/// What a card runs when the owner says so.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ProposalAction {
    Dispatch {
        request: DispatchRequest,
    },
    Followup {
        dispatch_id: i32,
        message: String,
        #[serde(default)]
        intent: Option<String>,
    },
}

impl PersonalAgentEngine {
    /// Put a dispatch in front of the owner as a proposal card instead of
    /// making it. Returns the card's notice id.
    pub async fn propose_dispatch(
        &self,
        v: &ValidDispatch,
        batch_id: Option<i32>,
        detail: Option<String>,
    ) -> Result<i32, String> {
        let project = match v.folder_id {
            Some(id) => crate::db::service::folder_service::get_folder_by_id(&self.db.conn, id)
                .await
                .ok()
                .flatten()
                .map(|f| f.alias.clone().unwrap_or(f.name.clone())),
            None => None,
        };
        let display = json!({
            "executor": v.snapshot.name,
            "executor_id": v.snapshot.assistant_id,
            "agent_type": v.snapshot.agent_type,
            "mode": v.mode,
            "project": project,
            "title": v.title,
            "prompt": v.prompt,
            "deliverable": (v.mode == DispatchMode::Task)
                .then_some(if v.report { "report" } else { "change" }),
        });
        self.raise_proposal(
            ProposalAction::Dispatch {
                request: v.to_request(),
            },
            display,
            v.title.clone(),
            batch_id,
            detail,
        )
        .await
    }

    /// Put a follow-up in front of the owner as a proposal card instead of
    /// sending it.
    pub async fn propose_followup(
        &self,
        dispatch_id: i32,
        message: String,
        intent: Option<String>,
        batch_id: Option<i32>,
    ) -> Result<i32, String> {
        let d = svc::get_dispatch(&self.db.conn, dispatch_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("dispatch #{dispatch_id} does not exist"))?;
        let executor = executor_of(&d);
        let display = json!({
            "dispatch_id": d.id,
            "title": d.title,
            "executor": executor.name,
            "executor_id": executor.assistant_id,
            "agent_type": executor.agent_type,
            "mode": d.mode,
            "message": message,
            "intent": intent,
        });
        self.raise_proposal(
            ProposalAction::Followup {
                dispatch_id,
                message,
                intent,
            },
            display,
            d.title.clone(),
            batch_id,
            None,
        )
        .await
    }

    async fn raise_proposal(
        &self,
        action: ProposalAction,
        display: Value,
        title: String,
        batch_id: Option<i32>,
        detail: Option<String>,
    ) -> Result<i32, String> {
        let payload = serde_json::to_value(&action).map_err(|e| e.to_string())?;
        let action_name = payload
            .get("action")
            .and_then(|a| a.as_str())
            .unwrap_or("")
            .to_string();
        let mut row = NewRow::new(TimelineKind::Notice, title);
        row.segment_id = self.state.lock().await.connection_segment;
        row.batch_id = batch_id;
        row.data = Some(json!({
            "notice": "proposal",
            "state": "open",
            "action": action_name,
            "display": display,
            "detail": detail,
        }));
        let (notice, card) = svc::create_notice_with_row(
            &self.db.conn,
            NewNotice {
                kind: NoticeKind::Proposal,
                subject_key: None,
                level: NoticeLevel::Normal,
                batch_id,
                payload,
            },
            row,
        )
        .await
        .map_err(|e| e.to_string())?;
        self.emit_rows(vec![svc::to_row(card)]);
        self.emit(PersonalAgentChange::Status);
        Ok(notice.id)
    }

    /// The owner's answer on a native card: `accept` runs what it holds as
    /// the card shows it (a proposal; an uncertain step, again), `dismiss`
    /// closes it. The first answer wins. Returns the card as it stands —
    /// acting while what it runs is still on its way.
    pub async fn act_on_notice(
        self: &Arc<Self>,
        notice_id: i32,
        action: &str,
    ) -> Result<TimelineRow, String> {
        let notice = svc::get_notice(&self.db.conn, notice_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such card")?;
        // A card whose own run ended unknown can be run again, or let be.
        let from: &[NoticeState] = &[NoticeState::Open, NoticeState::Unknown];
        let accept = match action {
            "accept" => true,
            "dismiss" => false,
            _ => return Err("`action` must be accept or dismiss".into()),
        };
        let proposal: ProposalAction =
            serde_json::from_str(&notice.payload).map_err(|e| e.to_string())?;
        if !accept {
            if !svc::move_notice(&self.db.conn, notice_id, from, NoticeState::Dismissed)
                .await
                .map_err(|e| e.to_string())?
            {
                return Err("this card was answered already".into());
            }
            let row = self
                .write_card_row(&notice, "dismissed", Value::Null, None)
                .await?;
            self.tell_brain(&notice, &proposal, "declined", None).await;
            return Ok(row);
        }
        // Phase one: the card is taken, before anything runs.
        if !svc::move_notice(&self.db.conn, notice_id, from, NoticeState::Acting)
            .await
            .map_err(|e| e.to_string())?
        {
            return Err("this card was answered already".into());
        }
        self.write_card_row(&notice, "acting", Value::Null, None)
            .await?;
        // Phase two: run it under the card's own operation id.
        let ran = match &proposal {
            ProposalAction::Dispatch { request } => match self.validate_dispatch(request).await {
                Ok(valid) => match self
                    .record_dispatch(valid, DispatchAuth::Card { notice_id })
                    .await
                {
                    Ok(made) => {
                        let result = json!({ "dispatch_id": made.dispatch.id });
                        // Made earlier (the same card's run on record): the
                        // card settles here; a new one settled with it.
                        if made.earlier {
                            self.settle_card_state(
                                notice_id,
                                &[NoticeState::Acting],
                                NoticeState::Acted,
                                "acted",
                                result.clone(),
                                None,
                            )
                            .await;
                        }
                        Ok(Some(result))
                    }
                    Err(e) => Err(e),
                },
                Err(e) => Err(e),
            },
            ProposalAction::Followup {
                dispatch_id,
                message,
                intent,
            } => {
                // The card's own runs only — an uncertain card also names
                // the step it is about.
                let attempt = svc::ops_of_notice(&self.db.conn, notice_id)
                    .await
                    .map(|ops| {
                        ops.iter()
                            .filter(|o| o.op_id.as_deref().is_some_and(ledger::is_card_op))
                            .count()
                    })
                    .unwrap_or(0)
                    + 1;
                let op_id = ledger::card_op_id(notice_id, attempt);
                // The ledger settles the card as the follow-up's entry
                // settles: at once for a task, when the executor confirms
                // the send for a conversation.
                self.followup_call(
                    *dispatch_id,
                    message.clone(),
                    intent.clone(),
                    FollowupAuth::Card { notice_id, op_id },
                )
                .await
                .map(|_| Some(json!({ "dispatch_id": dispatch_id })))
            }
        };
        match ran {
            Ok(result) => {
                self.tell_brain(&notice, &proposal, "approved", result.as_ref())
                    .await;
                self.card_row(&notice).await
            }
            Err(e) => {
                // Refused before anything ran (or settled not-run by the
                // ledger already): the card is open again, saying why.
                self.settle_card_state(
                    notice_id,
                    &[NoticeState::Acting],
                    NoticeState::Open,
                    "open",
                    Value::Null,
                    Some(e.clone()),
                )
                .await;
                Err(e)
            }
        }
    }

    /// A card's timeline row as it stands now.
    async fn card_row(&self, notice: &notice_entity::Model) -> Result<TimelineRow, String> {
        let id = notice.timeline_id.ok_or("the card's row is missing")?;
        let row = svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        Ok(svc::to_row(row))
    }

    /// Write a card's state onto its timeline row and show it.
    pub(super) async fn write_card_row(
        &self,
        notice: &notice_entity::Model,
        state: &str,
        result: Value,
        error: Option<String>,
    ) -> Result<TimelineRow, String> {
        let id = notice.timeline_id.ok_or("the card's row is missing")?;
        let row = svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let mut data = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<Value>(d).ok())
            .unwrap_or_else(|| json!({}));
        if let Some(map) = data.as_object_mut() {
            map.insert("state".into(), state.into());
            // What it made stays on the card once it is acted.
            if !result.is_null() || state != "acted" {
                map.insert("result".into(), result);
            }
            map.insert(
                "error".into(),
                error.map(Value::from).unwrap_or(Value::Null),
            );
        }
        svc::update_row_data(&self.db.conn, id, None, Some(data))
            .await
            .map_err(|e| e.to_string())?;
        let updated = svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let row = svc::to_row(updated);
        self.emit_rows(vec![row.clone()]);
        self.emit(PersonalAgentChange::Status);
        Ok(row)
    }

    /// Let the assistant know how the owner answered a card, with its next
    /// delivery (it does not start a turn of its own).
    async fn tell_brain(
        &self,
        notice: &notice_entity::Model,
        proposal: &ProposalAction,
        verdict: &str,
        result: Option<&Value>,
    ) {
        let what = match proposal {
            ProposalAction::Dispatch { request } => {
                format!(
                    "dispatch \"{}\" ({})",
                    request.title,
                    enum_str(&request.mode)
                )
            }
            ProposalAction::Followup { dispatch_id, .. } => {
                format!("follow-up of dispatch #{dispatch_id}")
            }
        };
        let summary = match (notice.kind, verdict) {
            (NoticeKind::Uncertain, "approved") => format!(
                "The owner had your {what} sent again (codeg could not tell whether the first \
                 one reached it)."
            ),
            (NoticeKind::Uncertain, _) => format!(
                "The owner let your {what} be: codeg could not tell whether it reached it, and \
                 it was not sent again."
            ),
            (_, "approved") => {
                match result.and_then(|r| r.get("dispatch_id")) {
                    Some(id) if matches!(proposal, ProposalAction::Dispatch { .. }) => {
                        format!("The owner approved your proposed {what}; it now runs as dispatch #{id}.")
                    }
                    _ => format!("The owner approved your proposed {what}."),
                }
            }
            _ => format!("The owner declined your proposed {what}; it did not run."),
        };
        let _ = svc::insert_event(
            &self.db.conn,
            "proposal",
            &format!(
                "notice:{}:{verdict}:{}",
                notice.id,
                chrono::Utc::now().timestamp_millis()
            ),
            None,
            summary,
            Some(json!({ "notice_id": notice.id, "verdict": verdict })),
            false,
        )
        .await;
    }
}
