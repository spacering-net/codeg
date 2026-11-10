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
use super::messages::{MessageAuth, ResolvedMessage};
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
        /// The input it is for, and what it inherits from it: a dispatch
        /// the owner confirms is filed where the call would have filed it.
        #[serde(default)]
        lineage: svc::Lineage,
    },
    Followup {
        dispatch_id: i32,
        message: String,
        #[serde(default)]
        intent: Option<String>,
    },
    /// A message to another assistant, resolved when it was asked for.
    Message { message: ResolvedMessage },
}

/// What a call that the owner's settings send to them first came to.
#[derive(Debug, Clone)]
pub struct Confirming {
    pub notice_id: i32,
    /// A re-delivered turn's same call: the card it raised then.
    pub earlier: bool,
}

impl Confirming {
    /// The tool's answer.
    pub fn outcome(&self, what: &str) -> super::tools::ToolOutcome {
        let text = if self.earlier {
            format!(
                "Already with the owner: the turn this delivery repeats put this same {what} on                  card #{} for them to confirm; nothing new was raised.",
                self.notice_id
            )
        } else {
            format!(
                "Waiting for the owner: they asked to confirm such actions first, so the {what}                  is on card #{} exactly as you wrote it, and runs once they confirm. You will                  hear how they answered; do not send it again meanwhile.",
                self.notice_id
            )
        };
        super::tools::ToolOutcome::ok(
            text,
            json!({ "notice_id": self.notice_id, "state": "awaiting_owner", "earlier": self.earlier }),
        )
    }
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
        self.dispatch_card(v, batch_id, detail, None, "proposal").await
    }

    /// Record a checked dispatch — or, when the owner asked to confirm
    /// dispatches like it first (13.5), put it on a card holding exactly
    /// it. A re-delivered turn's same call gets what the first one got: the
    /// dispatch it made, or the card it raised.
    pub async fn dispatch_or_confirm(
        self: &Arc<Self>,
        v: ValidDispatch,
        auth: DispatchAuth,
    ) -> Result<Result<super::dispatch::DispatchMade, Confirming>, String> {
        let key = ledger::dispatch_key(v.snapshot.assistant_id, v.mode, v.folder_id, &v.title);
        let subject = format!("confirm:{key}");
        // What the turn this delivery repeats did stands, whatever the
        // owner's setting says now: the card it raised (and what that card
        // ran), or the dispatch it made.
        if let DispatchAuth::Ledgered { scope, .. } = &auth {
            if let Some(card) = self.card_for_subject(&subject, scope).await {
                return Ok(Err(Confirming {
                    notice_id: card,
                    earlier: true,
                }));
            }
            if svc::ledger_entries(&self.db.conn, scope, &key)
                .await
                .map_err(|e| e.to_string())?
                .iter()
                .any(|e| e.state == crate::db::entities::personal_agent_action::ActionState::Committed)
            {
                // Recording it again answers with it, and makes nothing.
                return self.record_dispatch(v, auth.clone()).await.map(Ok);
            }
        }
        if !self.prefs().await.confirms(v.mode) {
            return self.record_dispatch(v, auth).await.map(Ok);
        }
        let batch = match &auth {
            DispatchAuth::Ledgered { batch_id, .. } => Some(*batch_id),
            _ => self.current_batch().await,
        };
        let notice_id = self
            .dispatch_card(&v, batch, None, Some(subject), "confirm")
            .await?;
        Ok(Err(Confirming {
            notice_id,
            earlier: false,
        }))
    }

    /// A proposal card one of the batches in `scope` raised under `subject`.
    async fn card_for_subject(&self, subject: &str, scope: &[i32]) -> Option<i32> {
        svc::notice_by_subject(
            &self.db.conn,
            self.bot().await,
            NoticeKind::Proposal,
            subject,
            scope,
        )
        .await
        .ok()
        .flatten()
        .map(|n| n.id)
    }

    /// Send a follow-up — or, when the owner asked to see follow-ups and
    /// retries first, put it on a card. A re-delivered turn's same call gets
    /// what the first one got, whatever the setting says now.
    pub async fn followup_or_confirm(
        self: &Arc<Self>,
        dispatch_id: i32,
        message: String,
        intent: Option<String>,
        auth: FollowupAuth,
    ) -> Result<Result<String, Confirming>, String> {
        use crate::models::personal_agent_prefs::AskFirst;
        let key = ledger::followup_key(dispatch_id, intent.as_deref());
        let subject = format!("confirm:{key}");
        if let FollowupAuth::Ledgered { scope, .. } = &auth {
            if let Some(card) = self.card_for_subject(&subject, scope).await {
                return Ok(Err(Confirming {
                    notice_id: card,
                    earlier: true,
                }));
            }
            // The first one went out directly: the ledger answers for it.
            if !svc::ledger_entries(&self.db.conn, scope, &key)
                .await
                .map_err(|e| e.to_string())?
                .is_empty()
            {
                return self
                    .followup_call(dispatch_id, message, intent, auth.clone())
                    .await
                    .map(Ok);
            }
        }
        if self.prefs().await.followups != AskFirst::Ask {
            return self
                .followup_call(dispatch_id, message, intent, auth)
                .await
                .map(Ok);
        }
        let batch = match &auth {
            FollowupAuth::Ledgered { batch_id, .. } => Some(*batch_id),
            _ => self.current_batch().await,
        };
        let d = svc::get_dispatch_of(&self.db.conn, self.bot().await, dispatch_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("dispatch #{dispatch_id} does not exist"))?;
        if message.trim().is_empty() {
            return Err("`message` is required".into());
        }
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
        let notice_id = self
            .raise_proposal(
                ProposalAction::Followup {
                    dispatch_id,
                    message,
                    intent,
                },
                display,
                d.title.clone(),
                batch,
                None,
                Some(subject),
                "confirm",
            )
            .await?;
        Ok(Err(Confirming {
            notice_id,
            earlier: false,
        }))
    }

    /// Send a message to another assistant — or, when the owner asked to
    /// see such messages first, put it on a card, resolved as it is. A
    /// re-delivered turn's same call gets what the first one got, whatever
    /// the setting says now.
    pub async fn message_or_confirm(
        self: &Arc<Self>,
        call: super::messages::MessageCall,
    ) -> Result<Result<super::messages::MessageSent, Confirming>, String> {
        use crate::models::personal_agent_prefs::AskFirst;
        let resolved = self.resolve_message(call).await?;
        let ledger = self.ledger_batch().await;
        let subject = format!("confirm:{}", Self::resolved_key(&resolved));
        if let Some((_, scope)) = &ledger {
            if let Some(card) = self.card_for_subject(&subject, scope).await {
                return Ok(Err(Confirming {
                    notice_id: card,
                    earlier: true,
                }));
            }
            if let Some(sent) = self.sent_before(&resolved, scope).await? {
                return Ok(Ok(sent));
            }
        }
        if self.prefs().await.messages != AskFirst::Ask {
            let auth = match ledger {
                Some((batch_id, scope)) => MessageAuth::Ledgered { batch_id, scope },
                None => MessageAuth::Direct,
            };
            return self.send_resolved(resolved, auth).await.map(Ok);
        }
        let display = json!({
            "to": resolved.to,
            "to_name": resolved.to_name,
            "message": resolved.body,
            "reply_to": resolved.reply_to,
            "wants_reply": resolved.wants_reply,
        });
        let title = format!("To {}", resolved.to_name);
        let notice_id = self
            .raise_proposal(
                ProposalAction::Message { message: resolved },
                display,
                title,
                ledger.map(|(b, _)| b),
                None,
                Some(subject),
                "confirm",
            )
            .await?;
        Ok(Err(Confirming {
            notice_id,
            earlier: false,
        }))
    }

    /// A card holding a checked dispatch.
    async fn dispatch_card(
        &self,
        v: &ValidDispatch,
        batch_id: Option<i32>,
        detail: Option<String>,
        subject: Option<String>,
        why: &str,
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
                lineage: v.lineage.clone(),
            },
            display,
            v.title.clone(),
            batch_id,
            detail,
            subject,
            why,
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
        let d = svc::get_dispatch_of(&self.db.conn, self.bot().await, dispatch_id)
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
            None,
            "proposal",
        )
        .await
    }

    /// `why`: `proposal` (the assistant's suggestion) or `confirm` (the
    /// owner asked to confirm such actions first).
    #[allow(clippy::too_many_arguments)]
    async fn raise_proposal(
        &self,
        action: ProposalAction,
        display: Value,
        title: String,
        batch_id: Option<i32>,
        detail: Option<String>,
        subject: Option<String>,
        why: &str,
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
            "why": why,
            "display": display,
            "detail": detail,
        }));
        let (notice, card) = svc::create_notice_with_row(
            &self.db.conn,
            self.bot().await,
            NewNotice {
                kind: NoticeKind::Proposal,
                subject_key: subject,
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
        // Only its own cards: one of another assistant's is not here.
        let notice = svc::get_notice_of(&self.db.conn, self.bot().await, notice_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such card")?;
        // The cards about assistants working with each other answer
        // their own way (4.9, 4.10).
        match notice.kind {
            NoticeKind::Loop => return self.act_on_loop(&notice, action).await,
            NoticeKind::Stopped => return self.act_on_stopped(&notice, action).await,
            // A settings change answers its own way (13.3).
            NoticeKind::Changed => return self.act_on_changed(&notice, action).await,
            NoticeKind::Choice => {
                return Err("a choice card is answered with its choices".into());
            }
            NoticeKind::Proposal | NoticeKind::Uncertain => {}
        }
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
            ProposalAction::Dispatch { request, lineage } => match self
                .validate_dispatch(request)
                .await
                .map(|mut v| {
                    v.lineage = lineage.clone();
                    v
                }) {
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
            ProposalAction::Message { message } => {
                match self
                    .send_resolved(message.clone(), MessageAuth::Card { notice_id })
                    .await
                {
                    Ok(sent) => {
                        let result = json!({ "message_id": sent.message.id });
                        self.settle_card_state(
                            notice_id,
                            &[NoticeState::Acting],
                            NoticeState::Acted,
                            "acted",
                            result.clone(),
                            None,
                        )
                        .await;
                        Ok(Some(result))
                    }
                    Err(e) => Err(e),
                }
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
            ProposalAction::Message { message } => format!("message to {}", message.to_name),
            ProposalAction::Dispatch { request, .. } => {
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
        // Held for the owner's confirmation by their settings, rather than
        // suggested.
        let confirm = notice
            .subject_key
            .as_deref()
            .is_some_and(|k| k.starts_with("confirm:"));
        let summary = match (notice.kind, verdict) {
            (NoticeKind::Uncertain, "approved") => format!(
                "The owner had your {what} sent again (codeg could not tell whether the first \
                 one reached it)."
            ),
            (NoticeKind::Uncertain, _) => format!(
                "The owner let your {what} be: codeg could not tell whether it reached it, and \
                 it was not sent again."
            ),
            (_, "approved") if confirm => match (proposal, result) {
                (ProposalAction::Dispatch { .. }, Some(r)) if r.get("dispatch_id").is_some() => format!(
                    "The owner confirmed your {what}; it now runs as dispatch #{}.",
                    r["dispatch_id"]
                ),
                (ProposalAction::Message { .. }, Some(r)) if r.get("message_id").is_some() => {
                    format!("The owner confirmed your {what}; it was sent as m{}.", r["message_id"])
                }
                _ => format!("The owner confirmed your {what}; it went out."),
            },
            (_, "approved") => {
                match result.and_then(|r| r.get("dispatch_id")) {
                    Some(id) if matches!(proposal, ProposalAction::Dispatch { .. }) => {
                        format!("The owner approved your proposed {what}; it now runs as dispatch #{id}.")
                    }
                    _ => format!("The owner approved your proposed {what}."),
                }
            }
            _ if confirm => format!(
                "The owner declined your {what} (held for their confirmation); it did not go out."
            ),
            _ => format!("The owner declined your proposed {what}; it did not run."),
        };
        let _ = svc::insert_event(
            &self.db.conn,
            self.bot().await,
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
