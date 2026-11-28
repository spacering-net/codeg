//! What the activity panel does on a row itself (6.5): failed work tried
//! again or handed to its assistant, a watched pull request merged, a
//! message its receiver ended its turn on without answering asked again.
//! Each is checked against what the row read, and done once however often
//! it is pressed.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use super::dispatch::{DispatchAuth, FollowupAuth};
use super::engine::PersonalAgentEngine;
use super::refusal::{keys, Refusal};
use crate::db::entities::personal_agent_dispatch::{self as dispatch_entity, DispatchMode, DispatchState};
use crate::db::entities::personal_agent_message::MessageState;
use crate::db::entities::personal_agent_notice::{self as notice_entity, NoticeKind, NoticeState};
use crate::db::entities::personal_agent_watch::WatchState;
use crate::db::service::personal_agent_service::{self as svc, NewEvent};
use crate::models::personal_agent::PersonalAgentChange;

/// A claim on failed work for an act on it ([`PersonalAgentEngine::claim_failed`]):
/// the rule cards it took, and its own mark.
struct Claim {
    cards: Vec<notice_entity::Model>,
    token: DateTime<Utc>,
}

/// The event kind that asks a message's receiver again.
pub const NUDGE_EVENT: &str = "bot_message_nudge";

/// How long a nudge stands: a second within it is the same nudge.
const NUDGE_WINDOW_SECS: i64 = 600;

impl PersonalAgentEngine {
    /// Work `dispatch_id` of this assistant's, failed, as the row read it
    /// (`seen`, its version) — claimed for the owner's act on it
    /// ([`svc::claim_failed_work`]): one changed since, given up, or its
    /// rule card acted on, is refused. With it, the rule cards of this
    /// failure, open: the act settles them ([`Self::settle_failed_cards`]).
    async fn claim_failed(
        &self,
        dispatch_id: i32,
        seen: DateTime<Utc>,
    ) -> Result<(dispatch_entity::Model, Claim), Refusal> {
        let bot = self.bot().await;
        let d = svc::get_dispatch_of(&self.db.conn, bot, dispatch_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| Refusal::new(keys::GONE, format!("no work #{dispatch_id}")))?;
        let changed = || {
            Refusal::new(
                keys::CHANGED,
                format!("work #{dispatch_id} changed since it was shown: look at it again"),
            )
        };
        let failed = matches!(d.state, DispatchState::Failed | DispatchState::Interrupted);
        if !failed || d.updated_at != seen || super::dispatch::superseded(&self.db, &d).await {
            return Err(changed());
        }
        let task = match (d.mode, d.work_task_id) {
            (DispatchMode::Task, Some(t)) => {
                crate::db::service::work_task_service::get_model(&self.db.conn, t)
                    .await
                    .ok()
            }
            _ => None,
        };
        let failed_at = super::today::failed_at(&d, task.as_ref());
        let task_id = d.work_task_id.filter(|_| d.mode == DispatchMode::Task);
        match svc::claim_failed_work(&self.db.conn, bot, d.id, task_id, seen, failed_at)
            .await
            .map_err(|e| e.to_string())?
        {
            svc::FailedClaim::Claimed { cards, token } => Ok((d, Claim { cards, token })),
            svc::FailedClaim::Changed => Err(changed()),
            svc::FailedClaim::GivenUp => Err(Refusal::new(
                keys::CHANGED,
                format!("work #{dispatch_id} was given up since it failed: look at it again"),
            )),
            svc::FailedClaim::OnCard => Err(Refusal::new(
                keys::IN_OTHER_HANDS,
                format!("work #{dispatch_id} is being seen to from its card already"),
            )),
            svc::FailedClaim::Taken => Err(Refusal::new(
                keys::IN_OTHER_HANDS,
                format!("work #{dispatch_id} was seen to from the activity already"),
            )),
        }
    }

    /// The rule cards a claim took ([`Self::claim_failed`]), as the act came
    /// to: acted on and saying how (`state`, `more`), or — it failed — open
    /// again, as the card's own act leaves them, and the claim let go of.
    async fn settle_failed_cards(
        &self,
        d: &dispatch_entity::Model,
        seen: DateTime<Utc>,
        claim: &Claim,
        done: Option<(&str, Value)>,
    ) {
        let id = svc::failed_claim_id(d.id, seen);
        let _ = if done.is_some() {
            svc::finish_failed_claim(&self.db.conn, &id, claim.token).await
        } else {
            svc::release_failed_claim(&self.db.conn, &id, claim.token).await
        };
        let cards = &claim.cards;
        for n in cards {
            let to = if done.is_some() {
                NoticeState::Acted
            } else {
                NoticeState::Open
            };
            let _ = svc::move_notice(&self.db.conn, n.id, &[NoticeState::Acting], to).await;
            if let Some((state, more)) = &done {
                let _ = self.rule_card_row(n, state, more.clone()).await;
            }
        }
        if !cards.is_empty() {
            self.emit(PersonalAgentChange::Status);
        }
    }

    /// [Retry] on the activity (6.5): failed work again, as its rule card's
    /// [Retry] does — a board task's run again on the board (as the row
    /// read it too: `task_seen`); work that never got a session handed out
    /// again as it was asked; any other, a follow-up of it. Once per
    /// failure: claimed with its rule card, and the operation keyed by the
    /// version the row read.
    pub(crate) async fn retry_work(
        self: &Arc<Self>,
        dispatch_id: i32,
        seen: DateTime<Utc>,
        task_seen: Option<DateTime<Utc>>,
    ) -> Result<Value, Refusal> {
        let (d, claim) = self.claim_failed(dispatch_id, seen).await?;
        let ran = self.retry_claimed(&d, task_seen).await;
        match &ran {
            Ok(out) => {
                let mut more = out.clone();
                more["error"] = Value::Null;
                self.settle_failed_cards(&d, seen, &claim, Some(("retried", more)))
                    .await;
            }
            Err(_) => self.settle_failed_cards(&d, seen, &claim, None).await,
        }
        ran
    }

    async fn retry_claimed(
        self: &Arc<Self>,
        d: &dispatch_entity::Model,
        task_seen: Option<DateTime<Utc>>,
    ) -> Result<Value, Refusal> {
        // Its own operation each time it is claimed: one let go of (it did
        // not go through) is pressed again as a new one; the claim is what
        // makes it once per failure.
        let op_id = super::ledger::fresh_op_id();
        if d.mode == DispatchMode::Task {
            let task = d.work_task_id.ok_or("the work names no board task")?;
            let task_seen = task_seen.ok_or("the row read no version of its board task")?;
            // The board's claim makes its work no turn's, in its own
            // transaction (`ClaimSeen`).
            retry_task(
                &self.db,
                task,
                crate::db::service::work_task_service::ClaimSeen {
                    updated_at: task_seen,
                    dispatch_id: Some(d.id),
                },
                None,
                Some(op_id),
            )
            .await?;
            return Ok(json!({ "task_id": task }));
        }
        if !self.resumable(d).await {
            let made = self.dispatch_again(d, DispatchAuth::Op { op_id }).await?;
            return Ok(json!({ "dispatch_id": made, "retry_of": d.id }));
        }
        self.followup_call(
            d.id,
            super::rules::RETRY_FAILED_MESSAGE.to_string(),
            None,
            FollowupAuth::Op { op_id },
        )
        .await?;
        Ok(json!({ "dispatch_id": d.id }))
    }

    /// [Hand to {name}] on the activity (6.5): failed work's assistant told
    /// by the owner to look into it — their message quoting the work's
    /// result card, as the rule card's [Hand to] words it. Once per
    /// failure: claimed with its rule card, and the result card keeps that
    /// it was handed (`handed_at`).
    pub(crate) async fn hand_failed_work(
        &self,
        dispatch_id: i32,
        seen: DateTime<Utc>,
    ) -> Result<(), Refusal> {
        let (d, claim) = self.claim_failed(dispatch_id, seen).await?;
        let handed = self.hand_claimed(&d).await;
        match &handed {
            Ok(()) => {
                self.settle_failed_cards(&d, seen, &claim, Some(("handed", json!({ "error": null }))))
                    .await
            }
            Err(_) => self.settle_failed_cards(&d, seen, &claim, None).await,
        }
        handed
    }

    async fn hand_claimed(&self, d: &dispatch_entity::Model) -> Result<(), Refusal> {
        // The card of the failure claimed, while the work is still at it:
        // not an earlier round's, nor a newer one's.
        let card = svc::latest_result_row_at(&self.db.conn, d.id, d.updated_at)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                Refusal::new(
                    keys::CHANGED,
                    format!("work #{} changed since it was shown: look at it again", d.id),
                )
            })?;
        let mut data = card
            .data
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        data["handed_at"] = json!(Utc::now());
        let text = super::rules::hand_text(
            "failed",
            &json!({ "dispatch_id": d.id, "title": d.title }),
        );
        self.queue_owner_hand_over(text, card.id, data, svc::CardGuard::Once("handed_at"))
            .await?;
        Ok(())
    }

    /// [Merge PR] on the activity (6.5): watched pull request `watch_id`
    /// merged now, at the head the row read — through the shared merge,
    /// with its rules for the merged version (a draft, a closed one, checks
    /// that did not pass are refused). Once per head: under the watches'
    /// lock, so two presses (or a press and a read of the watch) never put
    /// two cards up; one pressed again reads back the merge its card has.
    /// Merged, the watch is read at once: its ready card goes as it goes
    /// for any merge.
    pub(crate) async fn merge_watched_pr(
        self: &Arc<Self>,
        watch_id: i32,
        head: &str,
    ) -> Result<Value, Refusal> {
        let bot = self.bot().await;
        let guard = self.watch_lock.lock().await;
        let w = crate::db::service::personal_agent_watch_service::get(&self.db.conn, watch_id)
            .await
            .map_err(|e| e.to_string())?
            .filter(|w| w.bot_id == bot)
            .ok_or_else(|| Refusal::new(keys::GONE, format!("no watched pull request #{watch_id}")))?;
        // Asked for at this head already: what its card came to.
        let subject = format!("watch-merge:{}:{}", w.id, head.to_ascii_lowercase());
        if let Some(n) = svc::notice_of_subject(&self.db.conn, bot, NoticeKind::Forge, &subject)
            .await
            .map_err(|e| e.to_string())?
        {
            // As the first press read it: waiting for the owner's approval,
            // or a merge on its way — in doubt (its outcome unknown) all the
            // same, its card asking to look again.
            let phase = serde_json::from_str::<Value>(&n.payload)
                .ok()
                .and_then(|p| p["phase"].as_str().map(str::to_string));
            let outcome = match n.state {
                NoticeState::Acting => "merging",
                NoticeState::Acted => "merged",
                NoticeState::Open if phase.as_deref() == Some("approve") => "asked",
                NoticeState::Open => "merging",
                // Did not go through at this head: its card says why.
                NoticeState::Expired => {
                    return Ok(json!({
                        "outcome": "failed",
                        "notice_id": n.id,
                        "why": "the merge at this head did not go through: its card says why",
                    }));
                }
                _ => "changed",
            };
            return Ok(json!({ "outcome": outcome, "notice_id": n.id }));
        }
        let ready = w.state == WatchState::Watching && w.phase.as_deref() == Some("mergeable");
        let same = w
            .head_sha
            .as_deref()
            .is_some_and(|h| h.eq_ignore_ascii_case(head));
        if !ready || !same {
            return Ok(json!({ "outcome": "changed" }));
        }
        let out = match Box::pin(self.watch_merge_card(&w, head, false)).await {
            super::forge_acts::WatchMerge::Merging(id, None) => {
                let merged = svc::get_notice(&self.db.conn, id)
                    .await
                    .ok()
                    .flatten()
                    .is_some_and(|n| n.state == NoticeState::Acted);
                json!({ "outcome": if merged { "merged" } else { "merging" }, "notice_id": id })
            }
            super::forge_acts::WatchMerge::Merging(id, Some(why)) => {
                json!({ "outcome": "failed", "notice_id": id, "why": why })
            }
            super::forge_acts::WatchMerge::Asked(id) => json!({ "outcome": "asked", "notice_id": id }),
            super::forge_acts::WatchMerge::Refused(why) => json!({ "outcome": "refused", "why": why }),
            super::forge_acts::WatchMerge::Unread(why) => json!({ "outcome": "unread", "why": why }),
            // Its head moved since.
            super::forge_acts::WatchMerge::Not => json!({ "outcome": "changed" }),
        };
        drop(guard);
        if out["outcome"] == "merged" {
            if let Err(e) = self.poll_watch(w.id).await {
                tracing::info!("[personal_agent] reading watch #{} after its merge: {e}", w.id);
            }
        }
        Ok(out)
    }

    /// [Ask again] on the activity (6.5): the message matter `item_id`
    /// waits on, which its receiver took up and ended its turn on without
    /// answering — the receiver woken with a word that it is still waited
    /// on. Once in a while: a second press within ten minutes is the same
    /// nudge (`false`).
    pub(crate) async fn nudge_matter(&self, item_id: i32) -> Result<bool, Refusal> {
        self.nudge_matter_at(item_id, Utc::now()).await
    }

    /// [`Self::nudge_matter`] at `now`: the window it falls in.
    pub(super) async fn nudge_matter_at(
        &self,
        item_id: i32,
        now: DateTime<Utc>,
    ) -> Result<bool, Refusal> {
        let bot = self.bot().await;
        let item = svc::get_item_of(&self.db.conn, bot, item_id)
            .await
            .map_err(|e| e.to_string())?
            .filter(|i| i.kind == crate::db::entities::personal_agent_item::ItemKind::Message)
            .ok_or_else(|| Refusal::new(keys::GONE, format!("no matter #{item_id} waiting on a message")))?;
        let id = super::today::message_source(&self.db, &item)
            .await
            .sent
            .ok_or("the matter names no message it waits on")?
            .id;
        let m = crate::db::service::personal_agent_message_service::get_message(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| Refusal::new(keys::GONE, format!("no message m{id}")))?;
        let changed = || {
            Refusal::new(
                keys::CHANGED,
                format!("m{id} is answered, or not waited on: look at it again"),
            )
        };
        if m.from_bot_id != bot || m.state != MessageState::Delivered || !m.wants_reply {
            return Err(changed());
        }
        let to = m.to_bot_id;
        let me = self.agent_row().await;
        let name = me
            .as_ref()
            .map(super::messages::display_name)
            .unwrap_or_default();
        let window = now.timestamp().div_euclid(NUDGE_WINDOW_SECS);
        let nudged = svc::insert_nudge(
            &self.db.conn,
            to,
            bot,
            id,
            item_id,
            NewEvent {
                kind: NUDGE_EVENT.into(),
                source_key: format!("nudge:{id}:{window}"),
                coalesce_key: None,
                summary: format!(
                    "{name} is still waiting for your answer to its message m{id}: \"{}\". \
                     Answer it with reply_to m{id}.",
                    super::reach::glimpse(&m.body)
                ),
                payload: Some(json!({ "message_id": id })),
                wake: true,
                lineage: svc::Lineage {
                    origin_bot_id: Some(m.from_bot_id),
                    origin_row_id: None,
                    thread_id: m.thread_id,
                    for_input: Some(format!("message:{id}")),
                },
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        match nudged {
            svc::Nudged::Asked => {
                if let Some(engine) = super::engine::engine_for(Some(to)).await {
                    engine.nudge();
                }
                Ok(true)
            }
            svc::Nudged::Already => Ok(false),
            svc::Nudged::Changed => Err(changed()),
            // Only once its receiver is done with it: queued or in its
            // turn, it is still being taken up.
            svc::Nudged::Taken => Err(Refusal::new(
                keys::IN_OTHER_HANDS,
                format!("m{id} is still with its receiver: it has not ended its turn on it"),
            )),
        }
    }
}

/// The board's failed task `task` run again — only while it still stands as
/// the row read it (`seen`: its version, and whose work it is), in the
/// board's own claim; `op_id`, codeg's operation it is.
pub(crate) async fn retry_task(
    db: &crate::db::AppDatabase,
    task: i32,
    seen: crate::db::service::work_task_service::ClaimSeen,
    note: Option<String>,
    op_id: Option<String>,
) -> Result<(), Refusal> {
    use crate::db::entities::work_task::WorkTaskStatus;
    let changed = || {
        Refusal::new(
            keys::CHANGED,
            format!("task #{task} changed since it was shown: look at it again"),
        )
    };
    let t = crate::db::service::work_task_service::get_model(&db.conn, task)
        .await
        .map_err(|e| e.to_string())?;
    if t.status != WorkTaskStatus::Failed
        || t.updated_at != seen.updated_at
        || t.personal_agent_dispatch_id != seen.dispatch_id
    {
        return Err(changed());
    }
    let engine = crate::work_task::engine().ok_or("the task engine is not running")?;
    match engine.retry_seen(task, note, op_id, seen).await {
        Ok(()) => Ok(()),
        Err(e) if e == crate::work_task::engine::CHANGED_SINCE_READ => Err(changed()),
        Err(e) => Err(Refusal::from(e)),
    }
}
