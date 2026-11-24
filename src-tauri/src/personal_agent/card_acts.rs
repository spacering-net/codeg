//! What the owner did on an assistant's cards (9.2).
//!
//! A card the brain drew can carry buttons that act for the owner: one
//! that says something to the assistant in their name (`pa.reply`), one
//! that closes or snoozes one of its open matters (`pa.item`). Which of
//! them the owner pressed is kept on the reply row, under
//! `data.card_acts`, so the card shows it after a reload and in every
//! window: the chosen button checked, the other options of that choice
//! greyed out.
//!
//! The page names a button by its card and element (`<card>/<element>`);
//! codeg only checks the name's size, keeps the act, and refuses a second
//! `pa.reply` on the same button — the owner's message is sent once.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use serde_json::{json, Map, Value};

use super::engine::PersonalAgentEngine;
use crate::db::entities::personal_agent_timeline::{self as timeline, TimelineKind};
use crate::db::service::personal_agent_service as svc;
use crate::models::personal_agent::TimelineRow;

/// The acts one reply keeps at most.
const MAX_ACTS: usize = 100;
/// The longest button name.
const MAX_ELEMENT_CHARS: usize = 200;
/// The longest label kept.
const MAX_LABEL_CHARS: usize = 500;

/// The acts codeg keeps.
pub const PA_REPLY: &str = "pa.reply";
pub const PA_ITEM: &str = "pa.item";

/// The button on an assistant's card the owner's message comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardClick {
    /// `<card>/<element>`, as the page names it.
    pub element: String,
    /// The button's words.
    pub label: String,
}

/// What a button the owner pressed did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardAct {
    pub element: String,
    pub action: String,
    pub label: Option<String>,
    pub op: Option<String>,
}

fn clip(text: &str, max: usize) -> String {
    text.trim().chars().take(max).collect()
}

/// The button an owner message came from, as its row keeps it.
pub fn clicked_of(row: &timeline::Model) -> Option<String> {
    let data: Value = serde_json::from_str(row.data.as_deref()?).ok()?;
    clicked_in(&data)
}

/// [`clicked_of`], from a row's data.
pub fn clicked_in(data: &Value) -> Option<String> {
    data.get("card_click")?
        .get("label")?
        .as_str()
        .map(str::to_string)
}

impl PersonalAgentEngine {
    /// The reply row `row_id` of this assistant, when its cards can be
    /// acted on: written, and no longer being written.
    async fn pressable_row(&self, row_id: i32) -> Result<timeline::Model, String> {
        let row = svc::get_row_of(&self.db.conn, self.bot().await, row_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such message")?;
        if row.kind != TimelineKind::Reply {
            return Err("only the assistant's own replies have buttons".into());
        }
        if svc::is_unwritten_reply(&row) || svc::reply_state(&row) == Some("running") {
            return Err("the reply is still being written".into());
        }
        Ok(row)
    }

    fn check_act(act: &CardAct) -> Result<(), String> {
        let element = act.element.trim();
        if element.is_empty() || element.chars().count() > MAX_ELEMENT_CHARS {
            return Err("the button's name is empty or too long".into());
        }
        if act.action != PA_REPLY && act.action != PA_ITEM {
            return Err(format!("`{}` is not kept on a card", act.action));
        }
        Ok(())
    }

    /// Reply `row`'s data with `act` kept on it; with `once`, refused for
    /// a button already pressed. A card keeps at most `MAX_ACTS`.
    fn acted_data(row: &timeline::Model, act: &CardAct, once: bool) -> Result<Value, String> {
        let mut data = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<Value>(d).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        let map = data.as_object_mut().expect("an object");
        let acts = map
            .entry("card_acts")
            .or_insert_with(|| Value::Object(Map::new()));
        if !acts.is_object() {
            *acts = Value::Object(Map::new());
        }
        let acts = acts.as_object_mut().expect("an object");
        let element = act.element.trim().to_string();
        if once && acts.contains_key(&element) {
            return Err("that button was already pressed".into());
        }
        if !acts.contains_key(&element) && acts.len() >= MAX_ACTS {
            return Err("this reply keeps no more button presses".into());
        }
        let mut kept = Map::new();
        kept.insert("action".into(), act.action.clone().into());
        if let Some(label) = act.label.as_deref().map(|l| clip(l, MAX_LABEL_CHARS)) {
            kept.insert("label".into(), label.into());
        }
        if let Some(op) = act.op.as_deref().map(|o| clip(o, 20)) {
            kept.insert("op".into(), op.into());
        }
        kept.insert("at".into(), chrono::Utc::now().to_rfc3339().into());
        acts.insert(element, Value::Object(kept));
        Ok(data)
    }

    /// The owner pressed a button on one of this assistant's cards that
    /// acted without a message (`pa.item`): keep it on the card.
    pub async fn card_act(&self, row_id: i32, act: CardAct) -> Result<TimelineRow, String> {
        Self::check_act(&act)?;
        if act.action == PA_REPLY {
            return Err("a reply button sends its message with it".into());
        }
        let _guard = self.card_lock.lock().await;
        let row = self.pressable_row(row_id).await?;
        let data = Self::acted_data(&row, &act, false)?;
        svc::update_row_data(&self.db.conn, row.id, None, Some(data))
            .await
            .map_err(|e| e.to_string())?;
        let updated = svc::get_row(&self.db.conn, row.id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the reply vanished")?;
        let updated = svc::to_row(updated);
        self.emit_rows(vec![updated.clone()]);
        Ok(updated)
    }

    /// The owner's message from a `pa.reply` button on card `row_id`:
    /// recorded with the button it came from, and the button kept on the
    /// card — once.
    pub async fn send_card_reply(
        self: &Arc<Self>,
        text: String,
        row_id: i32,
        click: CardClick,
    ) -> Result<TimelineRow, String> {
        // Run to the end even when the page that asked goes away midway
        // (a closed tab drops its request).
        let me = self.clone();
        tokio::spawn(async move { me.send_card_reply_now(text, row_id, click).await })
            .await
            .map_err(|e| e.to_string())?
    }

    async fn send_card_reply_now(
        &self,
        text: String,
        row_id: i32,
        click: CardClick,
    ) -> Result<TimelineRow, String> {
        let act = CardAct {
            element: click.element.trim().to_string(),
            action: PA_REPLY.into(),
            label: Some(clip(&click.label, MAX_LABEL_CHARS)),
            op: None,
        };
        Self::check_act(&act)?;
        let _guard = self.card_lock.lock().await;
        // A press the card cannot keep (pressed already, no room left)
        // sends nothing; one it keeps is written in the same transaction as
        // the message, so the same button never sends twice — after a
        // restart too — and never shows pressed for a message never sent.
        let row = self.pressable_row(row_id).await?;
        let data = Self::acted_data(&row, &act, true)?;
        self.queue_card_message(
            text,
            row_id,
            json!({ "row_id": row_id, "element": act.element, "label": act.label }),
            data,
        )
        .await
    }
}
