//! Proposal rules (6.7): what each of codeg's rules has seen and since when,
//! the rule's own record (object `""`: muted from a card, lowered after the
//! owner kept dismissing its cards), and the reads its cards are deduped by.

use chrono::{DateTime, Utc};
use sea_orm::{
    ActiveModelTrait,
    ActiveValue::{NotSet, Set},
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};

use super::personal_agent_service::is_unique_violation;
use crate::db::entities::personal_agent_notice::{self as notice, NoticeKind, NoticeState};
use crate::db::entities::personal_agent_rule_state as state;
use crate::db::error::DbError;

/// The object of a rule's own record.
pub const RULE_ITSELF: &str = "";

pub async fn get(
    conn: &DatabaseConnection,
    rule: &str,
    object: &str,
) -> Result<Option<state::Model>, DbError> {
    Ok(state::Entity::find()
        .filter(state::Column::Rule.eq(rule))
        .filter(state::Column::Object.eq(object))
        .one(conn)
        .await?)
}

/// Every record of `rule` (its own one too).
pub async fn of_rule(conn: &DatabaseConnection, rule: &str) -> Result<Vec<state::Model>, DbError> {
    Ok(state::Entity::find()
        .filter(state::Column::Rule.eq(rule))
        .all(conn)
        .await?)
}

/// Seen now: the record as it stands — its first sight kept, `data`
/// written when given.
pub async fn seen(
    conn: &DatabaseConnection,
    rule: &str,
    object: &str,
    bot: Option<i32>,
    data: Option<String>,
    now: DateTime<Utc>,
) -> Result<state::Model, DbError> {
    if let Some(had) = get(conn, rule, object).await? {
        let mut a: state::ActiveModel = had.into();
        a.last_seen_at = Set(now);
        if bot.is_some() {
            a.bot_id = Set(bot);
        }
        if data.is_some() {
            a.data = Set(data);
        }
        a.updated_at = Set(Utc::now());
        return Ok(a.update(conn).await?);
    }
    let row = state::ActiveModel {
        id: NotSet,
        rule: Set(rule.to_string()),
        object: Set(object.to_string()),
        bot_id: Set(bot),
        first_seen_at: Set(now),
        last_seen_at: Set(now),
        data: Set(data),
        created_at: Set(Utc::now()),
        updated_at: Set(Utc::now()),
    };
    match row.insert(conn).await {
        Ok(m) => Ok(m),
        // Written meanwhile: that one stands.
        Err(e) if is_unique_violation(&e) => get(conn, rule, object)
            .await?
            .ok_or_else(|| DbError::Validation("the rule's record went missing".into())),
        Err(e) => Err(e.into()),
    }
}

/// Write a record's data (making it when missing).
pub async fn set_data(
    conn: &DatabaseConnection,
    rule: &str,
    object: &str,
    data: &serde_json::Value,
    now: DateTime<Utc>,
) -> Result<state::Model, DbError> {
    seen(conn, rule, object, None, Some(data.to_string()), now).await
}

/// Seen no more: its next sight is a first one.
pub async fn forget(conn: &DatabaseConnection, rule: &str, object: &str) -> Result<(), DbError> {
    state::Entity::delete_many()
        .filter(state::Column::Rule.eq(rule))
        .filter(state::Column::Object.eq(object))
        .exec(conn)
        .await?;
    Ok(())
}

/// Forget every record of `rule` whose object starts with `prefix`.
pub async fn forget_prefix(
    conn: &DatabaseConnection,
    rule: &str,
    prefix: &str,
) -> Result<(), DbError> {
    state::Entity::delete_many()
        .filter(state::Column::Rule.eq(rule))
        .filter(state::Column::Object.starts_with(prefix))
        .exec(conn)
        .await?;
    Ok(())
}

/// Rule `pr_review`'s projects `projects` are no longer watched: their open
/// cards expire (the card and its row together), and their records are
/// marked left (`out: true`) with `resets` one more — a record marked so
/// already is left as it is, so one leaving counts once. All in one
/// transaction holding the write lock from its first statement (a write
/// to the row of assistant `claim`). The cards it expired.
pub async fn pr_review_out(
    conn: &DatabaseConnection,
    claim: i32,
    projects: &[i32],
) -> Result<Vec<notice::Model>, DbError> {
    use crate::db::entities::personal_agent_timeline as timeline;
    use sea_orm::sea_query::Expr;
    use sea_orm::TransactionTrait;
    let txn = conn.begin().await?;
    super::personal_agent_service::claim_row(&txn, claim).await?;
    let now = Utc::now();
    let mut expired = Vec::new();
    for p in projects {
        let open = notice::Entity::find()
            .filter(notice::Column::Kind.eq(NoticeKind::Rule))
            .filter(notice::Column::State.eq(NoticeState::Open))
            .filter(notice::Column::SubjectKey.starts_with(format!("rule:pr_review:pr:{p}:")))
            .all(&txn)
            .await?;
        for n in open {
            let moved = notice::Entity::update_many()
                .col_expr(notice::Column::State, Expr::value(NoticeState::Expired))
                .col_expr(notice::Column::ActedAt, Expr::value(Some(now)))
                .col_expr(notice::Column::UpdatedAt, Expr::value(now))
                .filter(notice::Column::Id.eq(n.id))
                .filter(notice::Column::State.eq(NoticeState::Open))
                .exec(&txn)
                .await?;
            if moved.rows_affected != 1 {
                continue;
            }
            if let Some(row_id) = n.timeline_id {
                if let Some(row) = timeline::Entity::find_by_id(row_id).one(&txn).await? {
                    let mut data = row
                        .data
                        .as_deref()
                        .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
                        .filter(|d| d.is_object())
                        .unwrap_or_else(|| serde_json::json!({}));
                    data["state"] = "expired".into();
                    timeline::Entity::update_many()
                        .col_expr(timeline::Column::Data, Expr::value(Some(data.to_string())))
                        .col_expr(timeline::Column::UpdatedAt, Expr::value(now))
                        .filter(timeline::Column::Id.eq(row_id))
                        .exec(&txn)
                        .await?;
                }
            }
            expired.push(n);
        }
        let records = state::Entity::find()
            .filter(state::Column::Rule.eq("pr_review"))
            .filter(state::Column::Object.starts_with(format!("pr:{p}:")))
            .all(&txn)
            .await?;
        for rec in records {
            let mut data = rec
                .data
                .as_deref()
                .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
                .filter(|d| d.is_object())
                .unwrap_or_else(|| serde_json::json!({}));
            if data["out"].as_bool() == Some(true) {
                continue;
            }
            data["resets"] = (data["resets"].as_u64().unwrap_or(0) + 1).into();
            data["out"] = true.into();
            let mut a: state::ActiveModel = rec.into();
            a.data = Set(Some(data.to_string()));
            a.updated_at = Set(now);
            a.update(&txn).await?;
        }
    }
    txn.commit().await?;
    Ok(expired)
}

/// The cards raised about one topic (`rule:<rule>:<object>`), the newest
/// first.
pub async fn notices_of_subject(
    conn: &DatabaseConnection,
    subject: &str,
) -> Result<Vec<notice::Model>, DbError> {
    Ok(notice::Entity::find()
        .filter(notice::Column::SubjectKey.eq(subject))
        .order_by_desc(notice::Column::Id)
        .limit(50)
        .all(conn)
        .await?)
}

/// The cards of kind `kind` still open, everyone's.
pub async fn open_of_kind(
    conn: &DatabaseConnection,
    kind: NoticeKind,
) -> Result<Vec<notice::Model>, DbError> {
    Ok(notice::Entity::find()
        .filter(notice::Column::Kind.eq(kind))
        .filter(notice::Column::State.eq(NoticeState::Open))
        .all(conn)
        .await?)
}

/// The cards whose topic starts with `prefix` that the owner answered —
/// acted on, dismissed, muted — after `after`, the latest answer first.
pub async fn answered_with_prefix(
    conn: &DatabaseConnection,
    prefix: &str,
    after: Option<DateTime<Utc>>,
    limit: u64,
) -> Result<Vec<notice::Model>, DbError> {
    let mut q = notice::Entity::find()
        .filter(notice::Column::SubjectKey.starts_with(prefix))
        .filter(notice::Column::State.is_in([
            NoticeState::Acting,
            NoticeState::Acted,
            NoticeState::Unknown,
            NoticeState::Dismissed,
            NoticeState::Muted,
        ]))
        .filter(notice::Column::ActedAt.is_not_null());
    if let Some(t) = after {
        q = q.filter(notice::Column::ActedAt.gt(t));
    }
    Ok(q.order_by_desc(notice::Column::ActedAt)
        .order_by_desc(notice::Column::Id)
        .limit(limit)
        .all(conn)
        .await?)
}

/// How the cards whose topic starts with `prefix`, raised since `since`,
/// stand: raised, acted on, dismissed (muted counts as dismissed).
pub async fn counts_since(
    conn: &DatabaseConnection,
    prefix: &str,
    since: DateTime<Utc>,
) -> Result<(u32, u32, u32), DbError> {
    let rows = notice::Entity::find()
        .filter(notice::Column::SubjectKey.starts_with(prefix))
        .filter(notice::Column::CreatedAt.gte(since))
        .all(conn)
        .await?;
    let mut acted = 0;
    let mut dismissed = 0;
    for n in &rows {
        match n.state {
            NoticeState::Acting | NoticeState::Acted | NoticeState::Unknown => acted += 1,
            NoticeState::Dismissed | NoticeState::Muted => dismissed += 1,
            _ => {}
        }
    }
    Ok((rows.len() as u32, acted, dismissed))
}
