//! Assistants working with each other.
//!
//! - **Inputs** (4.11). Every input a delivery carries keeps where its chain
//!   started: an owner's message is its own start; another assistant's
//!   message carries its chain's start and its thread; a dispatch's news
//!   carries the dispatch's. An action names the input it is for (`for`);
//!   with one source in the batch it may leave it out. What is recorded is
//!   the logical input — a resent message's first copy — so the ledger and
//!   the chain hold across resends.
//! - **Messages** (4.8). `bot_message` writes the message, the receiver's
//!   event, a line on each side, the sender's "waiting for an answer"
//!   matter and the thread's count in one transaction, ledgered for a call
//!   made in a delivery. The receiver is woken; an answer wakes the sender.
//! - **Loops** (4.9). On one thread, a pair of assistants going back and
//!   forth past the owner's limit with no progress, or a new request to an
//!   assistant waiting on that thread for someone else, stops the thread and
//!   puts a card in front of the owner. Not a gate on who may write to whom.
//! - **Stops** (4.10). The owner's stop takes the turn with it, and what the
//!   turn set going that nobody has started on yet; what is under way
//!   elsewhere is listed on a card, each with a way to stop it there.
//! - **Mirrors** (4.11). The brain's own question or permission request,
//!   when it is for an input whose chain started at another assistant's
//!   conversation, shows there too; an answer in either place is the one.

use std::sync::Arc;

use serde_json::{json, Value};

use super::engine::PersonalAgentEngine;
use crate::db::entities::personal_agent::{self as agent_entity};
use crate::db::entities::personal_agent_dispatch::{
    self as dispatch_entity, DispatchMode, DispatchState,
};
use crate::db::entities::personal_agent_event as event_entity;
use crate::db::entities::personal_agent_item::ItemStatus;
use crate::db::entities::personal_agent_message::{self as message_entity, MessageState};
use crate::db::entities::personal_agent_notice::{NoticeKind, NoticeLevel, NoticeState};
use crate::db::entities::personal_agent_thread::ThreadState;
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::service::personal_agent_message_service as msvc;
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{
    ItemWrite, LedgerSlot, Ledgered, Lineage, NewNotice, NewRow,
};
use crate::models::personal_agent::{PersonalAgentChange, TimelineRow};

/// Longest message, in characters.
pub const MAX_MESSAGE_CHARS: usize = 20_000;
/// Rounds a pair may go back and forth on a thread with no progress when the
/// owner set none.
pub use crate::models::personal_agent_prefs::DEFAULT_LOOP_ROUNDS;
/// How far back a resent message is followed to its first copy.
const RESEND_CHAIN_MAX: usize = 64;

/// One input of a delivery, as an action names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Input {
    /// As the delivery numbers it: `#58` (an owner's message, or an event's
    /// card), `m12` (a message), `e7` (an event with no card).
    pub reference: String,
    /// The logical input: `owner:<first copy>`, `message:<id>`,
    /// `event:<id>`.
    pub logical: String,
    /// Where its chain started.
    pub origin_bot: Option<i32>,
    pub origin_row: Option<i32>,
    /// The thread between assistants it is on.
    pub thread: Option<i32>,
    /// Who or what it is, for the brain and the page.
    pub label: String,
}

impl Input {
    /// Whether it has a start to keep: someone started it.
    fn has_source(&self) -> bool {
        self.origin_row.is_some() || self.thread.is_some()
    }

    /// The source it comes from: inputs of one source are one matter's.
    fn source(&self) -> (Option<i32>, Option<i32>) {
        (self.origin_bot, self.thread)
    }

    /// What an action taken for it inherits.
    pub fn lineage(&self) -> Lineage {
        Lineage {
            origin_bot_id: self.origin_bot,
            origin_row_id: self.origin_row,
            thread_id: self.thread,
            for_input: Some(self.logical.clone()),
        }
    }
}

/// The inputs a delivery carries that have a source, grouped by it: one
/// group is one matter.
fn sources(inputs: &[Input]) -> Vec<Vec<&Input>> {
    let mut groups: Vec<Vec<&Input>> = Vec::new();
    for i in inputs.iter().filter(|i| i.has_source()) {
        match groups.iter_mut().find(|g| g[0].source() == i.source()) {
            Some(g) => g.push(i),
            None => groups.push(vec![i]),
        }
    }
    groups
}

/// The inputs to choose from, for an error asking which one.
fn list_inputs(inputs: &[&Input]) -> String {
    inputs
        .iter()
        .map(|i| format!("{} ({})", i.reference, i.label))
        .collect::<Vec<_>>()
        .join(", ")
}

/// What to do when an action does not say which input it is for.
pub enum Unnamed {
    /// Refuse, listing the inputs (a dispatch, a message).
    Refuse,
    /// Take none: the action is filed under no input (a question, a
    /// permission request — the agent asks once, it does not retry).
    Nothing,
}

/// Parse a message reference: `m12`, `12`.
fn message_ref(s: &str) -> Option<i32> {
    let s = s.trim();
    let s = s.strip_prefix("message:").unwrap_or(s);
    let s = s.strip_prefix('m').unwrap_or(s);
    s.parse().ok()
}

/// Normalized for the ledger key: case and spacing do not make a message
/// another.
fn normalize(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// The ledger key of a message.
pub fn message_key(to: i32, body: &str, reply_to: Option<i32>, for_input: Option<&str>) -> String {
    format!(
        "message:{to}:{}:{}:{}",
        super::engine::text_digest(&normalize(body)),
        reply_to.map(|r| r.to_string()).unwrap_or_default(),
        for_input.unwrap_or("")
    )
}

/// The first line of a text, cut for a summary.
fn first_line(text: &str, max: usize) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let mut out: String = line.chars().take(max).collect();
    if line.chars().count() > max {
        out.push('…');
    }
    out
}

/// An assistant's name as the brains read it: the primary may have none
/// (the page then calls it by its role).
pub fn display_name(b: &agent_entity::Model) -> String {
    let name = b.name.trim();
    if !name.is_empty() {
        return name.to_string();
    }
    match b.kind {
        crate::db::entities::personal_agent::BotKind::Primary => "the primary assistant".into(),
        crate::db::entities::personal_agent::BotKind::Worker => format!("assistant #{}", b.id),
    }
}

/// An assistant as a line or a card shows it.
pub fn bot_face(b: &agent_entity::Model) -> Value {
    json!({
        "id": b.id,
        "name": b.name,
        "avatar": serde_json::from_str::<Value>(&b.avatar).unwrap_or(Value::Null),
        "kind": b.kind,
    })
}

/// A `bot_message` call.
#[derive(Debug, Clone, Default)]
pub struct MessageCall {
    /// The receiver: an id, or a name from `bot_list`.
    pub to: Option<String>,
    pub text: String,
    pub reply_to: Option<String>,
    pub wants_reply: Option<bool>,
    pub for_input: Option<String>,
}

/// A `bot_message` call made concrete (`resolve_message`): what a card
/// asking the owner first keeps, and sends as it is.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ResolvedMessage {
    pub to: i32,
    /// The receiver's name when it was resolved, for the card.
    #[serde(default)]
    pub to_name: String,
    pub body: String,
    pub reply_to: Option<i32>,
    pub wants_reply: bool,
    pub thread: Option<i32>,
    #[serde(default)]
    pub lineage: svc::Lineage,
}

/// How a message is recorded in the ledger.
#[derive(Debug, Clone)]
pub enum MessageAuth {
    /// A delivery's tool call: one per batch and key, across the batches it
    /// re-delivers.
    Ledgered { batch_id: i32, scope: Vec<i32> },
    /// The owner said so on card `notice_id`.
    Card { notice_id: i32 },
    /// Outside any delivery and any card.
    Direct,
}

/// What a `bot_message` call came to.
#[derive(Debug, Clone)]
pub struct MessageSent {
    pub message: message_entity::Model,
    pub to_name: String,
    /// A re-delivered turn's same call: the message it sent then.
    pub earlier: bool,
}

/// The states in which a dispatch can still be stopped.
const LIVE: &[DispatchState] = &[
    DispatchState::Queued,
    DispatchState::Running,
    DispatchState::WaitingInput,
    DispatchState::Review,
];

/// What a stop covers.
#[derive(Debug, Clone)]
enum StopScope {
    /// What the turn of this batch set going.
    Batch(i32),
    /// Everything the assistant has going.
    All,
    /// What was set going for this input.
    Input(String),
}

impl PersonalAgentEngine {
    // ── inputs ──────────────────────────────────────────────────────────────

    /// An owner's message's first copy: resending one keeps the input.
    async fn first_copy(&self, row_id: i32) -> i32 {
        let mut id = row_id;
        for _ in 0..RESEND_CHAIN_MAX {
            let from = svc::get_row(&self.db.conn, id)
                .await
                .ok()
                .flatten()
                .and_then(|r| r.data)
                .and_then(|d| serde_json::from_str::<Value>(&d).ok())
                .and_then(|d| d.get("resent_from").and_then(|v| v.as_i64()))
                .and_then(|v| i32::try_from(v).ok());
            match from {
                Some(f) if f != id => id = f,
                _ => break,
            }
        }
        id
    }

    pub(super) async fn owner_input(&self, row_id: i32) -> Input {
        let first = self.first_copy(row_id).await;
        Input {
            reference: format!("#{row_id}"),
            logical: format!("owner:{first}"),
            origin_bot: Some(self.bot().await),
            origin_row: Some(first),
            thread: None,
            label: "the owner".into(),
        }
    }

    async fn message_input(&self, m: &message_entity::Model) -> Input {
        let from = svc::get_bot_any(&self.db.conn, m.from_bot_id)
            .await
            .ok()
            .flatten()
            .map(|b| display_name(&b))
            .unwrap_or_else(|| format!("assistant #{}", m.from_bot_id));
        Input {
            reference: format!("m{}", m.id),
            logical: format!("message:{}", m.id),
            origin_bot: m.origin_bot_id.or(Some(m.from_bot_id)),
            origin_row: m.origin_row_id,
            thread: m.thread_id,
            label: format!("a message from {from}"),
        }
    }

    pub(super) async fn event_input(&self, e: &event_entity::Model) -> Option<Input> {
        if e.kind == msvc::MESSAGE_EVENT {
            let id = e
                .payload
                .as_deref()
                .and_then(|p| serde_json::from_str::<Value>(p).ok())
                .and_then(|p| p.get("message_id").and_then(|v| v.as_i64()))
                .and_then(|v| i32::try_from(v).ok())?;
            let m = msvc::get_message(&self.db.conn, id).await.ok().flatten()?;
            return Some(self.message_input(&m).await);
        }
        let card = svc::result_rows_of_events(&self.db.conn, &[e.id])
            .await
            .ok()
            .and_then(|rows| rows.into_iter().next());
        let dispatch = e
            .payload
            .as_deref()
            .and_then(|p| serde_json::from_str::<Value>(p).ok())
            .and_then(|p| p.get("dispatch_id").and_then(|v| v.as_i64()))
            .and_then(|v| i32::try_from(v).ok());
        Some(Input {
            reference: match card {
                Some(c) => format!("#{}", c.id),
                None => format!("e{}", e.id),
            },
            logical: format!("event:{}", e.id),
            origin_bot: e.origin_bot_id,
            origin_row: e.origin_row_id,
            thread: e.thread_id,
            label: match dispatch {
                Some(d) => format!("news of dispatch #{d}"),
                None => "an event".into(),
            },
        })
    }

    /// The inputs batch `batch_id` carries: the owner's messages (those it
    /// took in while running too), then the messages and events.
    pub(super) async fn batch_inputs(&self, batch_id: i32) -> Vec<Input> {
        let mut out = Vec::new();
        for o in svc::owner_rows_of_batch(&self.db.conn, batch_id)
            .await
            .unwrap_or_default()
        {
            out.push(self.owner_input(o.id).await);
        }
        for e in svc::events_of_batch(&self.db.conn, batch_id)
            .await
            .unwrap_or_default()
        {
            if let Some(i) = self.event_input(&e).await {
                out.push(i);
            }
        }
        out
    }

    /// One input named by reference — of this assistant's, carried by the
    /// turn or not: `#58`, `m12`, `e7`, or a logical name.
    async fn named_input(&self, name: &str) -> Result<Input, String> {
        let bot = self.bot().await;
        let name = name.trim();
        let unknown = || format!("`for`: {name} is not one of your inputs");
        if let Some(rest) = name
            .strip_prefix("event:")
            .or_else(|| name.strip_prefix('e'))
        {
            if let Ok(id) = rest.parse::<i32>() {
                let e = svc::get_event_of(&self.db.conn, bot, id)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or_else(unknown)?;
                return self.event_input(&e).await.ok_or_else(unknown);
            }
        }
        if name.starts_with('m') || name.starts_with("message:") {
            let id = message_ref(name).ok_or_else(unknown)?;
            let m = msvc::get_message(&self.db.conn, id)
                .await
                .map_err(|e| e.to_string())?
                .filter(|m| m.to_bot_id == bot)
                .ok_or_else(unknown)?;
            return Ok(self.message_input(&m).await);
        }
        let digits = name
            .strip_prefix("owner:")
            .or_else(|| name.strip_prefix('#'))
            .unwrap_or(name);
        let id: i32 = digits.parse().map_err(|_| unknown())?;
        let row = svc::get_row_of(&self.db.conn, bot, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(unknown)?;
        match row.kind {
            TimelineKind::Owner => Ok(self.owner_input(row.id).await),
            TimelineKind::Result => {
                let eid = row.event_id.ok_or_else(unknown)?;
                let e = svc::get_event_of(&self.db.conn, bot, eid)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or_else(unknown)?;
                self.event_input(&e).await.ok_or_else(unknown)
            }
            TimelineKind::Exchange => {
                let id = row
                    .ref_id
                    .as_deref()
                    .and_then(message_ref)
                    .ok_or_else(unknown)?;
                let m = msvc::get_message(&self.db.conn, id)
                    .await
                    .map_err(|e| e.to_string())?
                    .filter(|m| m.to_bot_id == bot)
                    .ok_or_else(unknown)?;
                Ok(self.message_input(&m).await)
            }
            _ => Err(unknown()),
        }
    }

    /// The input an action of the turn in flight is for: the one it names,
    /// or — when it names none — the only source the turn carries. Several
    /// sources and none named: refused with the list, or (`Nothing`) none.
    pub(super) async fn input_for(
        &self,
        named: Option<&str>,
        unnamed: Unnamed,
    ) -> Result<Option<Input>, String> {
        if let Some(n) = named.map(str::trim).filter(|n| !n.is_empty()) {
            return self.named_input(n).await.map(Some);
        }
        let Some(batch) = self.current_batch().await else {
            return Ok(None);
        };
        let inputs = self.batch_inputs(batch).await;
        let groups = sources(&inputs);
        match groups.len() {
            0 => Ok(None),
            // One matter: its first input (an owner's message before what
            // came of it).
            1 => Ok(groups[0].first().map(|i| (*i).clone())),
            _ => match unnamed {
                Unnamed::Nothing => Ok(None),
                Unnamed::Refuse => {
                    let all: Vec<&Input> = groups.iter().flatten().copied().collect();
                    Err(format!(
                        "this turn carries inputs from more than one source: {}. Say which one \
                         this is for with `for` (for example \"for\": \"{}\") and call again.",
                        list_inputs(&all),
                        all[0].reference
                    ))
                }
            },
        }
    }

    /// What an action for `input` inherits; with none, the chain starts at
    /// this assistant (nobody started it).
    pub(super) async fn lineage_of(&self, input: Option<&Input>) -> Lineage {
        match input {
            Some(i) => i.lineage(),
            None => Lineage {
                origin_bot_id: Some(self.bot().await),
                ..Default::default()
            },
        }
    }

    /// The note a delivery carries when it holds inputs from more than one
    /// source: each action must say which it is for.
    pub(super) fn sources_note(inputs: &[Input]) -> Option<String> {
        let groups = sources(inputs);
        if groups.len() < 2 {
            return None;
        }
        let all: Vec<&Input> = groups.iter().flatten().copied().collect();
        Some(super::cards::sources_note(&list_inputs(&all)))
    }

    // ── messages ────────────────────────────────────────────────────────────

    /// Broadcast a change about another assistant (its own page hears it).
    pub(super) fn emit_for(&self, bot: i32, change: PersonalAgentChange) {
        crate::web::event_bridge::emit_event(
            &self.emitter,
            super::engine::PERSONAL_AGENT_CHANGED_EVENT,
            super::engine::change_payload(bot, &change),
        );
        self.touch_live(bot);
    }

    /// The engine of assistant `bot` in this process, made if need be.
    pub(super) async fn peer(&self, bot: i32) -> Option<Arc<PersonalAgentEngine>> {
        self.host_ref()?.engine_for(Some(bot)).await
    }

    /// The assistant a `to` names: an id, or a name (any case).
    async fn receiver(&self, to: &str) -> Result<agent_entity::Model, String> {
        let to = to.trim().trim_start_matches('#');
        if let Ok(id) = to.parse::<i32>() {
            return match svc::get_bot_any(&self.db.conn, id)
                .await
                .map_err(|e| e.to_string())?
            {
                Some(b) if b.deleted_at.is_some() => Err(format!(
                    "{} was deleted and takes no more messages; use bot_list",
                    display_name(&b)
                )),
                Some(b) => Ok(b),
                None => Err(format!("there is no assistant #{id}; use bot_list")),
            };
        }
        let bots = svc::list_bots(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?;
        let wanted = to.to_lowercase();
        bots.into_iter()
            .find(|b| b.name.trim().to_lowercase() == wanted)
            .ok_or_else(|| format!("no assistant is called \"{to}\"; use bot_list"))
    }

    /// The pair limit on a thread: messages between two assistants with no
    /// progress (twice the owner's rounds); 0 is none.
    async fn loop_limit(&self) -> u32 {
        self.prefs().await.loop_rounds * 2
    }

    /// Send a message to another assistant, as `bot_message` does: checked,
    /// written with all it sets going, the receiver woken. A repeat of a
    /// call the ledger holds (a re-delivered turn) sends nothing and gets
    /// the message sent then.
    pub async fn send_message(self: &Arc<Self>, call: MessageCall) -> Result<MessageSent, String> {
        let resolved = self.resolve_message(call).await?;
        let auth = match self.ledger_batch().await {
            Some((batch_id, scope)) => MessageAuth::Ledgered { batch_id, scope },
            None => MessageAuth::Direct,
        };
        self.send_resolved(resolved, auth).await
    }

    /// A `bot_message` call made concrete: who it goes to, what it
    /// answers, what it is for and the thread it goes on — what a card
    /// keeps, so the message sent is the one shown.
    pub async fn resolve_message(&self, call: MessageCall) -> Result<ResolvedMessage, String> {
        let me = self
            .agent_row()
            .await
            .ok_or("configure the assistant first")?;
        let body = call.text.trim().to_string();
        if body.is_empty() {
            return Err("`text` is required".into());
        }
        if body.chars().count() > MAX_MESSAGE_CHARS {
            return Err(format!(
                "`text` is longer than {MAX_MESSAGE_CHARS} characters"
            ));
        }
        // An answer goes back to whoever wrote what it answers, on that
        // thread, with that chain.
        let answered = match call
            .reply_to
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(r) => {
                let id = message_ref(r).ok_or("`reply_to` takes a message id such as \"m12\"")?;
                let m = msvc::get_message(&self.db.conn, id)
                    .await
                    .map_err(|e| e.to_string())?
                    .filter(|m| m.to_bot_id == me.id)
                    .ok_or_else(|| format!("m{id} is not a message you received"))?;
                Some(m)
            }
            None => None,
        };
        let to = match (
            call.to.as_deref().map(str::trim).filter(|s| !s.is_empty()),
            &answered,
        ) {
            (Some(t), _) => self.receiver(t).await?,
            (None, Some(m)) => svc::get_bot_any(&self.db.conn, m.from_bot_id)
                .await
                .map_err(|e| e.to_string())?
                .ok_or("the assistant you answer is gone")?,
            (None, None) => return Err("`to` is required; use bot_list".into()),
        };
        if to.deleted_at.is_some() {
            return Err(format!(
                "{} was deleted and takes no more messages; use bot_list",
                display_name(&to)
            ));
        }
        if to.id == me.id {
            return Err("that is you; write to another assistant".into());
        }
        if let Some(m) = &answered {
            if m.from_bot_id != to.id {
                return Err(format!(
                    "m{} came from another assistant; an answer goes to whoever wrote it",
                    m.id
                ));
            }
        }
        let wants_reply = call.wants_reply.unwrap_or(answered.is_none());
        // What it is for, and so what it inherits: an answer, what it
        // answers; a new request, the input it names (or the only one).
        let input = match &answered {
            Some(m) => Some(self.message_input(m).await),
            None => {
                self.input_for(call.for_input.as_deref(), Unnamed::Refuse)
                    .await?
            }
        };
        let lineage = self.lineage_of(input.as_ref()).await;
        let thread = match (&answered, lineage.thread_id) {
            (Some(m), _) => m.thread_id,
            (None, t) => t,
        };
        Ok(ResolvedMessage {
            to: to.id,
            to_name: display_name(&to),
            body,
            reply_to: answered.as_ref().map(|m| m.id),
            wants_reply,
            thread,
            lineage,
        })
    }

    /// The ledger key of a resolved message.
    pub(super) fn resolved_key(m: &ResolvedMessage) -> String {
        message_key(m.to, &m.body, m.reply_to, m.lineage.for_input.as_deref())
    }

    /// The message a re-delivered turn's same call sent, when there is one.
    pub(super) async fn sent_before(
        &self,
        m: &ResolvedMessage,
        scope: &[i32],
    ) -> Result<Option<MessageSent>, String> {
        let key = Self::resolved_key(m);
        let earlier = svc::ledger_entries(&self.db.conn, scope, &key)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|e| e.state == crate::db::entities::personal_agent_action::ActionState::Committed);
        match earlier {
            Some(entry) => {
                let to = svc::get_bot_any(&self.db.conn, m.to)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("the receiver is gone")?;
                self.earlier_message(&entry, &to).await.map(Some)
            }
            None => Ok(None),
        }
    }

    /// Send a resolved message: checked against the thread, written with
    /// all it sets going, the receiver woken.
    pub async fn send_resolved(
        self: &Arc<Self>,
        m: ResolvedMessage,
        auth: MessageAuth,
    ) -> Result<MessageSent, String> {
        let me = self
            .agent_row()
            .await
            .ok_or("configure the assistant first")?;
        let to = svc::get_bot_any(&self.db.conn, m.to)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the receiver is gone")?;
        if to.deleted_at.is_some() {
            return Err(format!(
                "{} was deleted and takes no more messages; use bot_list",
                display_name(&to)
            ));
        }
        let key = Self::resolved_key(&m);
        // A repeat costs nothing to find before anything is checked or
        // written: the message was sent, whatever the thread says now.
        if let MessageAuth::Ledgered { scope, .. } = &auth {
            if let Some(earlier) = self.sent_before(&m, scope).await? {
                return Ok(earlier);
            }
        }
        if let Some(t) = m.thread {
            self.check_thread(t, me.id, to.id, m.reply_to.is_none(), &m.body)
                .await?;
        }
        let excerpt = first_line(&m.body, 80);
        let (ledger, ledger_notice, sent_batch_id) = match &auth {
            MessageAuth::Ledgered { batch_id, .. } => (
                Some(LedgerSlot::in_batch(*batch_id, key.clone(), super::ledger::fresh_op_id())),
                None,
                Some(*batch_id),
            ),
            MessageAuth::Card { notice_id } => (
                Some(LedgerSlot::outside(super::ledger::card_op_id(*notice_id, 1))),
                Some(*notice_id),
                None,
            ),
            MessageAuth::Direct => (None, None, None),
        };
        let new = msvc::NewMessage {
            from: me.id,
            to: to.id,
            body: m.body.clone(),
            wants_reply: m.wants_reply,
            reply_to: m.reply_to,
            thread: match m.thread {
                Some(t) => msvc::ThreadPick::On(t),
                None => msvc::ThreadPick::New,
            },
            origin_bot_id: m.lineage.origin_bot_id,
            origin_row_id: m.lineage.origin_row_id,
            for_input: m.lineage.for_input.clone(),
            sent_batch_id,
            sent_segment_id: self.state.lock().await.connection_segment,
            summary: format!("{} wrote to you: {excerpt}", display_name(&me)),
            waiting_summary: format!("Waiting for {}'s answer: {excerpt}", display_name(&to)),
            sender_line: json!({ "peer": bot_face(&to) }),
            receiver_line: json!({ "peer": bot_face(&me) }),
            ledger,
            ledger_notice,
            ledger_payload: Some(json!({
                "to": to.id,
                "text": m.body,
                "reply_to": m.reply_to,
                "for": m.lineage.for_input,
            })),
        };
        let sent = match msvc::send_message(&self.db.conn, new)
            .await
            .map_err(|e| e.to_string())?
        {
            Ledgered::New(s) => s,
            Ledgered::Earlier(entry) => return self.earlier_message(&entry, &to).await,
        };
        self.emit_rows(vec![svc::to_row(sent.sender_row.clone())]);
        self.emit_for(
            to.id,
            PersonalAgentChange::Timeline {
                rows: vec![svc::to_row(sent.receiver_row.clone())],
            },
        );
        if let Some(i) = &sent.item {
            self.emit(PersonalAgentChange::Item { id: i.id });
        }
        if let Some(id) = sent.closed_item {
            self.emit_for(to.id, PersonalAgentChange::Item { id });
        }
        if let Some(a) = &sent.answered {
            self.refresh_lines(a.id, "replied").await;
        }
        self.emit(PersonalAgentChange::Status);
        self.emit_for(to.id, PersonalAgentChange::Status);
        // The receiver takes it from here.
        if let Some(peer) = self.peer(to.id).await {
            peer.nudge();
        }
        Ok(MessageSent {
            message: sent.message,
            to_name: display_name(&to),
            earlier: false,
        })
    }

    /// The message an earlier, identical call sent.
    async fn earlier_message(
        &self,
        entry: &crate::db::entities::personal_agent_action::Model,
        to: &agent_entity::Model,
    ) -> Result<MessageSent, String> {
        let id = entry
            .ref_id
            .as_deref()
            .and_then(|r| r.parse::<i32>().ok())
            .ok_or("an earlier identical message is on record, but not which one")?;
        let message = msvc::get_message(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("m{id} of an earlier identical call is gone"))?;
        Ok(MessageSent {
            message,
            to_name: display_name(to),
            earlier: true,
        })
    }

    /// May a message from `from` to `to` go on thread `t`? A stopped thread
    /// takes none. Going back and forth past the limit with no progress, or
    /// a new request to an assistant waiting on the thread for someone
    /// else's answer (a circle), stops it here and tells the owner.
    async fn check_thread(
        &self,
        t: i32,
        from: i32,
        to: i32,
        request: bool,
        body: &str,
    ) -> Result<(), String> {
        let Some(thread) = msvc::get_thread(&self.db.conn, t)
            .await
            .map_err(|e| e.to_string())?
        else {
            return Ok(());
        };
        match thread.state {
            ThreadState::Open => {}
            ThreadState::Looped => {
                return Err(format!(
                    "the exchange on thread t{t} was stopped because it went round without \
                     progress; the owner decides whether it goes on. Send nothing more on it, and \
                     say so in your reply if it matters"
                ))
            }
            ThreadState::Stopped => {
                return Err(format!(
                    "the owner stopped the work on thread t{t}; send nothing more on it"
                ))
            }
        }
        if request && self.waits_on_thread_for_another(t, to, from).await {
            self.stop_looped(t, from, to, "cycle", body).await;
            return Err(format!(
                "this would go round in a circle: the assistant you write to is waiting on this \
                 same exchange (t{t}) for another assistant's answer. codeg stopped the exchange \
                 and asked the owner. Do not send it again; tell the owner where things stand"
            ));
        }
        let limit = self.loop_limit().await;
        let count = msvc::thread_counts(&thread)
            .get(&msvc::pair_key(from, to))
            .copied()
            .unwrap_or(0);
        if limit > 0 && count >= limit {
            self.stop_looped(t, from, to, "no_progress", body).await;
            return Err(format!(
                "you and this assistant have gone back and forth {count} times on t{t} with no \
                 progress (no work dispatched or done, no word from the owner). codeg stopped \
                 the exchange and asked the owner. Do not send it again; tell the owner where \
                 things stand"
            ));
        }
        Ok(())
    }

    /// Whether `bot` waits on thread `t` for the answer of someone other
    /// than `except`.
    async fn waits_on_thread_for_another(&self, t: i32, bot: i32, except: i32) -> bool {
        msvc::messages_of_thread(&self.db.conn, t)
            .await
            .unwrap_or_default()
            .iter()
            .any(|m| {
                m.from_bot_id == bot
                    && m.to_bot_id != except
                    && m.wants_reply
                    && msvc::LIVE_MESSAGE_STATES.contains(&m.state)
            })
    }

    /// Stop thread `t` as looped and put the card in front of the owner: in
    /// the conversation its chain started in, or the primary's.
    async fn stop_looped(&self, t: i32, from: i32, to: i32, why: &str, body: &str) {
        if !msvc::move_thread(&self.db.conn, t, &[ThreadState::Open], ThreadState::Looped)
            .await
            .unwrap_or(false)
        {
            return;
        }
        let thread = msvc::get_thread(&self.db.conn, t).await.ok().flatten();
        let count = thread
            .as_ref()
            .and_then(|th| {
                msvc::thread_counts(th)
                    .get(&msvc::pair_key(from, to))
                    .copied()
            })
            .unwrap_or(0);
        let target = match thread.as_ref().and_then(|th| th.origin_bot_id) {
            Some(b)
                if svc::get_bot(&self.db.conn, b)
                    .await
                    .ok()
                    .flatten()
                    .is_some() =>
            {
                b
            }
            _ => match svc::primary_bot(&self.db.conn).await.ok().flatten() {
                Some(p) => p.id,
                None => return,
            },
        };
        let face = |id: i32| {
            let conn = self.db.conn.clone();
            async move {
                svc::get_bot_any(&conn, id)
                    .await
                    .ok()
                    .flatten()
                    .map(|b| bot_face(&b))
                    .unwrap_or(Value::Null)
            }
        };
        let bots = vec![face(from).await, face(to).await];
        let name = |v: &Value| {
            v.get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string()
        };
        let title = if why == "cycle" {
            format!(
                "{} → {}: the exchange went round in a circle and was stopped",
                name(&bots[0]),
                name(&bots[1])
            )
        } else {
            format!(
                "{} and {} went back and forth {count} times with no progress; stopped",
                name(&bots[0]),
                name(&bots[1])
            )
        };
        let mut row = NewRow::new(TimelineKind::Notice, title);
        row.data = Some(json!({
            "notice": "loop",
            "state": "open",
            "thread_id": t,
            "why": why,
            "count": count,
            "bots": bots,
            "refused": first_line(body, 200),
        }));
        let made = svc::create_notice_with_row(
            &self.db.conn,
            target,
            NewNotice {
                kind: NoticeKind::Loop,
                subject_key: Some(format!("thread:{t}")),
                level: NoticeLevel::Normal,
                batch_id: None,
                payload: json!({ "thread_id": t, "from": from, "to": to, "why": why }),
            },
            row,
        )
        .await;
        if let Ok((_, card)) = made {
            self.emit_for(
                target,
                PersonalAgentChange::Timeline {
                    rows: vec![svc::to_row(card)],
                },
            );
            self.emit_for(target, PersonalAgentChange::Status);
        }
    }

    /// Something moved on thread `t` (work handed out or done, the owner
    /// spoke): its counts start over.
    pub(super) async fn thread_progress(&self, t: i32) {
        let _ = msvc::thread_progress(&self.db.conn, t).await;
    }

    /// The owner spoke to this assistant: progress on every thread it is
    /// on.
    pub(super) async fn owner_spoke(&self) {
        for t in msvc::open_threads_of(&self.db.conn, self.bot().await)
            .await
            .unwrap_or_default()
        {
            self.thread_progress(t).await;
        }
    }

    /// Rewrite the state both lines of message `id` show, and show them.
    pub(super) async fn refresh_lines(&self, id: i32, state: &str) {
        for line in msvc::lines_of_message(&self.db.conn, id)
            .await
            .unwrap_or_default()
        {
            let mut data = line
                .data
                .as_deref()
                .and_then(|d| serde_json::from_str::<Value>(d).ok())
                .unwrap_or_else(|| json!({}));
            if let Some(map) = data.as_object_mut() {
                map.insert("state".into(), state.into());
            }
            let _ = svc::update_row_data(&self.db.conn, line.id, None, Some(data)).await;
            if let (Ok(Some(row)), Some(bot)) =
                (svc::get_row(&self.db.conn, line.id).await, line.bot_id)
            {
                self.emit_for(
                    bot,
                    PersonalAgentChange::Timeline {
                        rows: vec![svc::to_row(row)],
                    },
                );
            }
        }
    }

    /// The messages among `events` (a delivery's), in order.
    pub(super) async fn messages_of(
        &self,
        events: &[event_entity::Model],
    ) -> Vec<message_entity::Model> {
        let ids: Vec<i32> = events
            .iter()
            .filter(|e| e.kind == msvc::MESSAGE_EVENT)
            .filter_map(|e| {
                e.payload
                    .as_deref()
                    .and_then(|p| serde_json::from_str::<Value>(p).ok())
                    .and_then(|p| p.get("message_id").and_then(|v| v.as_i64()))
                    .and_then(|v| i32::try_from(v).ok())
            })
            .collect();
        msvc::messages_by_ids(&self.db.conn, &ids)
            .await
            .unwrap_or_default()
    }

    /// How messages read in a delivery.
    pub(super) async fn message_lines(
        &self,
        messages: &[message_entity::Model],
    ) -> Vec<super::cards::MessageLine> {
        let mut out = Vec::with_capacity(messages.len());
        for m in messages {
            let from = svc::get_bot_any(&self.db.conn, m.from_bot_id)
                .await
                .ok()
                .flatten();
            out.push(super::cards::MessageLine {
                id: m.id,
                from: from
                    .as_ref()
                    .map(display_name)
                    .unwrap_or_else(|| format!("assistant #{}", m.from_bot_id)),
                from_primary: from.as_ref().is_some_and(|b| {
                    b.kind == crate::db::entities::personal_agent::BotKind::Primary
                }),
                thread: m.thread_id,
                reply_to: m.reply_to,
                wants_reply: m.wants_reply,
                text: m.body.clone(),
            });
        }
        out
    }

    /// A delivery took these messages: they are delivered, and both lines
    /// say so.
    pub(super) async fn messages_taken(&self, messages: &[message_entity::Model], batch_id: i32) {
        let ids: Vec<i32> = messages.iter().map(|m| m.id).collect();
        let moved = msvc::mark_messages_delivered(&self.db.conn, &ids, batch_id)
            .await
            .unwrap_or_default();
        for id in moved {
            self.refresh_lines(id, "delivered").await;
        }
    }

    /// A delivery that carried these messages ended well: one that wants no
    /// answer is closed.
    pub(super) async fn messages_handled(&self, batch_id: i32) {
        let events = svc::events_of_batch(&self.db.conn, batch_id)
            .await
            .unwrap_or_default();
        let ids: Vec<i32> = self
            .messages_of(&events)
            .await
            .into_iter()
            .filter(|m| !m.wants_reply)
            .map(|m| m.id)
            .collect();
        for id in msvc::move_messages(
            &self.db.conn,
            &ids,
            &[MessageState::Delivered],
            MessageState::Closed,
        )
        .await
        .unwrap_or_default()
        {
            self.refresh_lines(id, "closed").await;
        }
    }

    /// `bot_list`: every assistant not deleted (hidden ones too, which take
    /// messages all the same).
    pub async fn roster_text(&self) -> (String, Value) {
        let me = self.bot().await;
        let bots = svc::list_bots(&self.db.conn).await.unwrap_or_default();
        let mut lines = Vec::new();
        let mut rows = Vec::new();
        for b in bots {
            let role = self.role_line(&b);
            let (busy, open) = match self.peer(b.id).await {
                Some(e) => (e.busy().await, e.open_work().await),
                None => (false, 0),
            };
            let status = if busy { "working" } else { "idle" };
            let you = if b.id == me { " (you)" } else { "" };
            let what = if role.is_empty() {
                String::new()
            } else {
                format!(" — {role}")
            };
            lines.push(format!(
                "#{} {}{you}{what} · {status} · {open} open matter(s)",
                b.id,
                display_name(&b)
            ));
            rows.push(json!({
                "id": b.id,
                "name": b.name,
                "kind": b.kind,
                "role": role,
                "status": status,
                "open": open,
                "you": b.id == me,
            }));
        }
        (lines.join("\n"), json!({ "assistants": rows }))
    }

    /// An assistant's role in one line: its persona's first line.
    fn role_line(&self, b: &agent_entity::Model) -> String {
        let soul = super::workdir::read_text(&self.workdir_of(b), super::workdir::SOUL_FILE);
        soul.lines()
            .map(|l| l.trim().trim_start_matches('#').trim())
            .find(|l| !l.is_empty())
            .map(|l| first_line(l, 120))
            .unwrap_or_default()
    }

    /// Open matters on this assistant's list.
    async fn open_work(&self) -> usize {
        svc::list_items(
            &self.db.conn,
            self.bot().await,
            &[ItemStatus::Open, ItemStatus::Waiting],
            200,
        )
        .await
        .map(|v| v.len())
        .unwrap_or(0)
    }

    // ── loop cards ──────────────────────────────────────────────────────────

    /// The owner's answer on a loop card: `accept` lets the exchange go on
    /// (its counts start over), `dismiss` leaves it stopped — theirs now.
    pub(super) async fn act_on_loop(
        &self,
        notice: &crate::db::entities::personal_agent_notice::Model,
        action: &str,
    ) -> Result<TimelineRow, String> {
        let payload: Value = serde_json::from_str(&notice.payload).unwrap_or_default();
        let t = payload
            .get("thread_id")
            .and_then(|v| v.as_i64())
            .and_then(|v| i32::try_from(v).ok());
        let from = payload
            .get("from")
            .and_then(|v| v.as_i64())
            .and_then(|v| i32::try_from(v).ok());
        let (to_state, card_state) = match action {
            "accept" => (NoticeState::Acted, "acted"),
            "dismiss" => (NoticeState::Dismissed, "dismissed"),
            _ => return Err("`action` must be accept or dismiss".into()),
        };
        if !svc::move_notice(&self.db.conn, notice.id, &[NoticeState::Open], to_state)
            .await
            .map_err(|e| e.to_string())?
        {
            return Err("this card was answered already".into());
        }
        if let (Some(t), "accept") = (t, action) {
            let _ = msvc::move_thread(&self.db.conn, t, &[ThreadState::Looped], ThreadState::Open)
                .await;
            self.thread_progress(t).await;
        }
        // The assistant whose message was refused hears it with its next
        // turn — and is woken when it may go on.
        if let (Some(t), Some(from)) = (t, from) {
            let summary = if action == "accept" {
                format!(
                    "The owner let the exchange on t{t} go on: you may send the message codeg \
                     stopped again, if it is still needed."
                )
            } else {
                format!(
                    "The owner is taking over the exchange on t{t}, which codeg stopped: send \
                     nothing more on it."
                )
            };
            let _ = svc::insert_event(
                &self.db.conn,
                from,
                "loop",
                &format!("notice:{}:{action}", notice.id),
                None,
                summary,
                Some(json!({ "notice_id": notice.id, "thread_id": t })),
                action == "accept",
            )
            .await;
            if action == "accept" {
                if let Some(peer) = self.peer(from).await {
                    peer.nudge();
                }
            }
        }
        self.write_card_row(notice, card_state, Value::Null, None)
            .await
    }

    // ── stops ───────────────────────────────────────────────────────────────

    /// The owner's [Stop] in the conversation: the turn, and what it set
    /// going that nobody started on yet (4.10).
    pub async fn stop(self: &Arc<Self>) -> Result<(), String> {
        let batch = self.current_batch().await;
        // A turn whose connection is gone already is stopped as it is; what
        // it set going is stopped all the same.
        if let Err(e) = self.cancel_turn().await {
            tracing::info!("[personal_agent] stopping the turn: {e}");
        }
        if let Some(b) = batch {
            self.stop_scope(StopScope::Batch(b), true).await;
        }
        Ok(())
    }

    /// The roster's "stop everything": all this assistant has going.
    pub async fn stop_all(self: &Arc<Self>) -> Result<(), String> {
        let turn = self.current_batch().await.is_some();
        if let Err(e) = self.cancel_turn().await {
            tracing::info!("[personal_agent] stopping the turn: {e}");
        }
        self.stop_scope(StopScope::All, turn).await;
        Ok(())
    }

    /// Stop, here, what was set going for input `logical` — the [Also stop
    /// this one] of another assistant's stop card: the turn too, when the
    /// turn in flight carries it.
    pub(super) async fn stop_input(self: &Arc<Self>, logical: &str) -> Result<(), String> {
        if let Some(b) = self.current_batch().await {
            if self
                .batch_inputs(b)
                .await
                .iter()
                .any(|i| i.logical == logical)
            {
                return self.stop().await;
            }
        }
        self.stop_scope(StopScope::Input(logical.to_string()), false)
            .await;
        Ok(())
    }

    /// Stop what `scope` covers; when anything besides the turn was
    /// stopped, or could not be, the card says what.
    async fn stop_scope(self: &Arc<Self>, scope: StopScope, turn: bool) {
        let bot = self.bot().await;
        let dispatches: Vec<dispatch_entity::Model> = match &scope {
            // Made by the turn, or continued by it.
            StopScope::Batch(b) => svc::dispatches_run_by_batch(&self.db.conn, *b)
                .await
                .unwrap_or_default(),
            StopScope::All => svc::list_dispatches(&self.db.conn, bot, LIVE, None, 500)
                .await
                .unwrap_or_default(),
            StopScope::Input(l) => svc::list_dispatches(&self.db.conn, bot, LIVE, None, 500)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|d| d.for_input.as_deref() == Some(l.as_str()))
                .collect(),
        };
        let mut stopped_work = Vec::new();
        for d in dispatches.into_iter().filter(|d| d.bot_id == Some(bot)) {
            if self.stop_dispatch(&d).await {
                stopped_work.push(json!({ "id": d.id, "title": d.title }));
            }
        }
        let messages: Vec<message_entity::Model> = match &scope {
            StopScope::Batch(b) => msvc::messages_sent_in(&self.db.conn, bot, *b)
                .await
                .unwrap_or_default(),
            StopScope::All => msvc::live_messages_from(&self.db.conn, bot)
                .await
                .unwrap_or_default(),
            StopScope::Input(l) => msvc::messages_for_input(&self.db.conn, bot, l)
                .await
                .unwrap_or_default(),
        };
        let mut stopped_messages = Vec::new();
        let mut handled = Vec::new();
        for m in messages
            .into_iter()
            .filter(|m| msvc::LIVE_MESSAGE_STATES.contains(&m.state))
        {
            let to = svc::get_bot_any(&self.db.conn, m.to_bot_id)
                .await
                .ok()
                .flatten();
            let face = to.as_ref().map(bot_face).unwrap_or(Value::Null);
            if m.state == MessageState::Queued
                && msvc::withdraw_message(&self.db.conn, &m, MessageState::Stopped)
                    .await
                    .unwrap_or(false)
            {
                self.refresh_lines(m.id, "stopped").await;
                self.drop_waiting(&m).await;
                stopped_messages
                    .push(json!({ "id": m.id, "to": face, "excerpt": first_line(&m.body, 120) }));
                self.emit_for(m.to_bot_id, PersonalAgentChange::Status);
            } else {
                handled
                    .push(json!({ "id": m.id, "to": face, "excerpt": first_line(&m.body, 120) }));
            }
        }
        if stopped_work.is_empty() && stopped_messages.is_empty() && handled.is_empty() {
            return;
        }
        let mut row = NewRow::new(TimelineKind::Notice, "Stopped");
        row.segment_id = self.state.lock().await.connection_segment;
        row.batch_id = match &scope {
            StopScope::Batch(b) => Some(*b),
            _ => None,
        };
        row.data = Some(json!({
            "notice": "stopped",
            "state": "open",
            "scope": match scope { StopScope::All => "all", _ => "this" },
            "turn": turn,
            "dispatches": stopped_work,
            "messages": stopped_messages,
            "handled": handled,
            "also_stopped": [],
        }));
        if let Ok((_, card)) = svc::create_notice_with_row(
            &self.db.conn,
            bot,
            NewNotice {
                kind: NoticeKind::Stopped,
                subject_key: None,
                level: NoticeLevel::Low,
                batch_id: row.batch_id,
                payload: json!({ "handled": handled.iter().filter_map(|h| h.get("id").cloned()).collect::<Vec<_>>() }),
            },
            row,
        )
        .await
        {
            self.emit_rows(vec![svc::to_row(card)]);
        }
        self.emit(PersonalAgentChange::Status);
    }

    /// A stopped message's sender no longer waits for its answer.
    async fn drop_waiting(&self, m: &message_entity::Model) {
        let Some(line) = msvc::lines_of_message(&self.db.conn, m.id)
            .await
            .unwrap_or_default()
            .into_iter()
            .find(|l| l.bot_id == Some(m.from_bot_id))
        else {
            return;
        };
        if let Ok(Some(item)) =
            msvc::waiting_item_of_line(&self.db.conn, m.from_bot_id, line.id).await
        {
            let _ = svc::update_item(
                &self.db.conn,
                item.id,
                ItemWrite {
                    status: Some(ItemStatus::Dropped),
                    waits_for: Some(None),
                    ..Default::default()
                },
            )
            .await;
            self.emit_for(m.from_bot_id, PersonalAgentChange::Item { id: item.id });
        }
    }

    /// Stop one dispatch where it is: a task through the board, a
    /// conversation by stopping its turn. False when it is past stopping
    /// (done, merging). What it reports afterwards updates its card and
    /// wakes nobody.
    pub(super) async fn stop_dispatch(&self, d: &dispatch_entity::Model) -> bool {
        if !LIVE.contains(&d.state) {
            return false;
        }
        // A task already on the board stops there first: one past stopping
        // (done, merging) is left as it is.
        if d.mode == DispatchMode::Task {
            if let Some(task_id) = d.work_task_id {
                let Some(board) = crate::work_task::engine() else {
                    return false;
                };
                if board.cancel(task_id, None).await.is_err() {
                    return false;
                }
            }
        }
        let updated = svc::update_dispatch(
            &self.db.conn,
            d.id,
            Some(LIVE),
            svc::DispatchWrite {
                state: Some(DispatchState::Canceled),
                error: Some(Some(super::dispatch::STOPPED_NOTE.into())),
                ..Default::default()
            },
        )
        .await
        .ok()
        .flatten();
        let Some(updated) = updated else {
            return false;
        };
        // What it runs on, as it is now — not as it was read: a launch
        // still under way attaches it after this and, finding the dispatch
        // stopped, does not start (`start_*_dispatch`).
        match d.mode {
            DispatchMode::Task => {
                if let (None, Some(task_id)) = (d.work_task_id, updated.work_task_id) {
                    if let Some(board) = crate::work_task::engine() {
                        let _ = board.cancel(task_id, None).await;
                    }
                }
            }
            _ => {
                if let Some(conn) = updated.connection_id.as_deref() {
                    let _ = self.manager.cancel(&self.db.conn, conn).await;
                }
            }
        }
        self.record_progress(
            &updated,
            None,
            Some(super::dispatch::STOPPED_NOTE.into()),
            "stopped",
        )
        .await;
        true
    }

    /// The owner's answer on a stop card: `stop:<message id>` stops that
    /// message's work where it is now (its receiver's [Stop] on it),
    /// `dismiss` closes the card.
    pub(super) async fn act_on_stopped(
        self: &Arc<Self>,
        notice: &crate::db::entities::personal_agent_notice::Model,
        action: &str,
    ) -> Result<TimelineRow, String> {
        if action == "dismiss" {
            if !svc::move_notice(
                &self.db.conn,
                notice.id,
                &[NoticeState::Open],
                NoticeState::Dismissed,
            )
            .await
            .map_err(|e| e.to_string())?
            {
                return Err("this card was answered already".into());
            }
            return self
                .write_card_row(notice, "dismissed", Value::Null, None)
                .await;
        }
        let id = action
            .strip_prefix("stop:")
            .and_then(message_ref)
            .ok_or("`action` must be stop:<message id> or dismiss")?;
        let payload: Value = serde_json::from_str(&notice.payload).unwrap_or_default();
        let listed = payload
            .get("handled")
            .and_then(|v| v.as_array())
            .is_some_and(|ids| ids.iter().any(|v| v.as_i64() == Some(id as i64)));
        if !listed {
            return Err("that message is not on this card".into());
        }
        let m = msvc::get_message(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the message is gone")?;
        let peer = self
            .peer(m.to_bot_id)
            .await
            .ok_or("its assistant is not running here")?;
        peer.stop_input(&format!("message:{id}")).await?;
        // The card keeps what the owner stopped from it.
        let row_id = notice.timeline_id.ok_or("the card's row is missing")?;
        let row = svc::get_row(&self.db.conn, row_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let mut data = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<Value>(d).ok())
            .unwrap_or_else(|| json!({}));
        if let Some(list) = data.get_mut("also_stopped").and_then(|v| v.as_array_mut()) {
            if !list.iter().any(|v| v.as_i64() == Some(id as i64)) {
                list.push(id.into());
            }
        }
        svc::update_row_data(&self.db.conn, row_id, None, Some(data))
            .await
            .map_err(|e| e.to_string())?;
        let row = svc::get_row(&self.db.conn, row_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let row = svc::to_row(row);
        self.emit_rows(vec![row.clone()]);
        Ok(row)
    }

    /// Stop one dispatch as a stop does, from the row as it was read.
    #[cfg(test)]
    pub(crate) async fn stop_dispatch_for_test(&self, d: &dispatch_entity::Model) -> bool {
        self.stop_dispatch(d).await
    }

    // ── mirrors ─────────────────────────────────────────────────────────────

    /// Where the brain's own question or permission request belongs (4.11):
    /// the input it is for (named, for a question; the only source the turn
    /// carries otherwise). `Err` with the turn's inputs when it carries
    /// several and none was named — the card lists them, nothing is
    /// guessed.
    pub(super) async fn request_input(
        &self,
        named: Option<&str>,
    ) -> Result<Option<Input>, Vec<Input>> {
        match self.input_for(named, Unnamed::Nothing).await {
            Ok(Some(i)) => return Ok(Some(i)),
            Ok(None) => {}
            // A name that is no input of this assistant's: as if none.
            Err(_) => {}
        }
        let Some(batch) = self.current_batch().await else {
            return Ok(None);
        };
        let inputs = self.batch_inputs(batch).await;
        if sources(&inputs).len() > 1 {
            Err(inputs.into_iter().filter(|i| i.has_source()).collect())
        } else {
            Ok(None)
        }
    }

    /// Show a request row of this assistant's in the conversation its input
    /// started in, too, when that is another assistant's — or, with several
    /// inputs and none named, list them on the row.
    pub(super) async fn mirror_request(
        &self,
        own: &TimelineRow,
        attributed: Result<Option<Input>, Vec<Input>>,
    ) {
        let bot = self.bot().await;
        let mut data = own.data.clone().unwrap_or_else(|| json!({}));
        match attributed {
            Ok(Some(input)) => {
                let Some(origin) = input.origin_bot.filter(|b| *b != bot) else {
                    return;
                };
                if svc::get_bot(&self.db.conn, origin)
                    .await
                    .ok()
                    .flatten()
                    .is_none()
                {
                    return;
                }
                let me = self.agent_row().await;
                let mut mirror = NewRow::new(own.kind, own.body.clone());
                mirror.ref_id = own.ref_id.clone();
                let mut mdata = data.clone();
                if let Some(map) = mdata.as_object_mut() {
                    map.insert(
                        "mirror_of".into(),
                        json!({ "bot_id": bot, "row_id": own.id }),
                    );
                    map.insert(
                        "from_bot".into(),
                        me.as_ref().map(bot_face).unwrap_or(Value::Null),
                    );
                    // The asker's agent: how its permission options read.
                    map.insert(
                        "agent_type".into(),
                        me.as_ref()
                            .map(|r| Value::from(r.agent_type.clone()))
                            .unwrap_or(Value::Null),
                    );
                    map.insert("for_row".into(), input.origin_row.into());
                }
                mirror.data = Some(mdata);
                let Ok(made) = svc::insert_row(&self.db.conn, origin, mirror).await else {
                    return;
                };
                self.emit_for(
                    origin,
                    PersonalAgentChange::Timeline {
                        rows: vec![svc::to_row(made.clone())],
                    },
                );
                self.emit_for(origin, PersonalAgentChange::Status);
                if let Some(map) = data.as_object_mut() {
                    map.insert(
                        "mirrors".into(),
                        json!([{ "bot_id": origin, "row_id": made.id }]),
                    );
                    map.insert("for".into(), input.reference.into());
                }
            }
            Ok(None) => return,
            Err(inputs) => {
                let mut listed = Vec::new();
                for i in inputs {
                    let bot_face = match i.origin_bot {
                        Some(b) => svc::get_bot_any(&self.db.conn, b)
                            .await
                            .ok()
                            .flatten()
                            .map(|b| bot_face(&b))
                            .unwrap_or(Value::Null),
                        None => Value::Null,
                    };
                    listed.push(json!({
                        "ref": i.reference,
                        "label": i.label,
                        "origin_bot": bot_face,
                        "origin_row": i.origin_row,
                    }));
                }
                if let Some(map) = data.as_object_mut() {
                    map.insert("inputs".into(), Value::Array(listed));
                }
            }
        }
        let _ = svc::update_row_data(&self.db.conn, own.id, None, Some(data)).await;
        if let Ok(Some(row)) = svc::get_row(&self.db.conn, own.id).await {
            self.emit_rows(vec![svc::to_row(row)]);
        }
    }

    /// A request row's mirrors read as it does now (answered, withdrawn).
    pub(super) async fn sync_mirrors(
        &self,
        own: &crate::db::entities::personal_agent_timeline::Model,
    ) {
        let data = own
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<Value>(d).ok())
            .unwrap_or_default();
        let Some(mirrors) = data.get("mirrors").and_then(|v| v.as_array()) else {
            return;
        };
        for m in mirrors {
            let (Some(bot), Some(row_id)) = (
                m.get("bot_id")
                    .and_then(|v| v.as_i64())
                    .and_then(|v| i32::try_from(v).ok()),
                m.get("row_id")
                    .and_then(|v| v.as_i64())
                    .and_then(|v| i32::try_from(v).ok()),
            ) else {
                continue;
            };
            let Ok(Some(row)) = svc::get_row_of(&self.db.conn, bot, row_id).await else {
                continue;
            };
            let mut mdata = row
                .data
                .as_deref()
                .and_then(|d| serde_json::from_str::<Value>(d).ok())
                .unwrap_or_else(|| json!({}));
            if let (Some(map), Some(src)) = (mdata.as_object_mut(), data.as_object()) {
                for k in ["state", "answer", "option_id", "origin"] {
                    if let Some(v) = src.get(k) {
                        map.insert(k.into(), v.clone());
                    }
                }
            }
            let _ = svc::update_row_data(&self.db.conn, row_id, None, Some(mdata)).await;
            if let Ok(Some(updated)) = svc::get_row(&self.db.conn, row_id).await {
                self.emit_for(
                    bot,
                    PersonalAgentChange::Timeline {
                        rows: vec![svc::to_row(updated)],
                    },
                );
                self.emit_for(bot, PersonalAgentChange::Status);
            }
        }
    }

    /// The assistant whose request a mirrored row of this one's stands
    /// for: answering here answers there.
    pub(super) async fn mirror_source(
        &self,
        kind: TimelineKind,
        ref_id: &str,
    ) -> Option<Arc<PersonalAgentEngine>> {
        let row = svc::row_by_ref(&self.db.conn, self.bot().await, kind, ref_id)
            .await
            .ok()
            .flatten()?;
        let data = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<Value>(d).ok())?;
        let bot = data
            .pointer("/mirror_of/bot_id")
            .and_then(|v| v.as_i64())
            .and_then(|v| i32::try_from(v).ok())?;
        self.peer(bot).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(r: &str, bot: Option<i32>, row: Option<i32>, thread: Option<i32>) -> Input {
        Input {
            reference: r.into(),
            logical: r.into(),
            origin_bot: bot,
            origin_row: row,
            thread,
            label: "x".into(),
        }
    }

    #[test]
    fn inputs_of_one_source_are_one_matter() {
        // Two messages the owner sent in a row, and news of work done for
        // the first: one matter.
        let one = vec![
            input("#58", Some(1), Some(58), None),
            input("#59", Some(1), Some(59), None),
            input("#61", Some(1), Some(58), None),
            input("e3", None, None, None),
        ];
        assert_eq!(sources(&one).len(), 1);
        // Two assistants' requests: two.
        let two = vec![
            input("m12", Some(2), None, Some(12)),
            input("m14", Some(3), None, Some(14)),
        ];
        assert_eq!(sources(&two).len(), 2);
    }

    #[test]
    fn a_message_key_ignores_spacing_and_case_but_not_what_it_is_for() {
        let a = message_key(2, "Fix  the\nbug", None, Some("owner:58"));
        assert_eq!(a, message_key(2, "fix the bug", None, Some("owner:58")));
        assert_ne!(a, message_key(2, "fix the bug", None, Some("owner:60")));
        assert_ne!(a, message_key(3, "fix the bug", None, Some("owner:58")));
        assert_ne!(a, message_key(2, "fix the bug", Some(4), Some("owner:58")));
    }

    #[test]
    fn message_references_read_either_way() {
        assert_eq!(message_ref("m12"), Some(12));
        assert_eq!(message_ref("12"), Some(12));
        assert_eq!(message_ref("message:12"), Some(12));
        assert_eq!(message_ref("x"), None);
    }
}
