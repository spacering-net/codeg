//! PR watch (7.4) and the coding events (6.9).
//!
//! A watch is one row per item, keyed by its coordinates: the target is
//! resolved once and kept, whoever names the item next. Only its owning
//! assistant's engine reads it on its schedule, so a read's write needs no
//! guard against another reader; a rate limit pushes back every watch on
//! the same account at once.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait,
    ActiveValue::{NotSet, Set},
    ColumnTrait, Condition, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};

use crate::db::entities::personal_agent_signal as signal;
use crate::db::entities::personal_agent_watch::{self as watch, WatchState};
use crate::db::entities::personal_agent_watch_name as name;
use crate::db::error::DbError;
use crate::forge::{DeliveryTarget, ForgeProvider};

/// One item's identity: the same pull request named twice is one row.
pub fn item_key(target: &DeliveryTarget, kind: &str, number: i64) -> String {
    let repo = crate::forge::normalize_repo(&target.owner_repo)
        .unwrap_or_else(|| target.owner_repo.trim().to_ascii_lowercase());
    format!(
        "{}|{}|{}|{}|{}",
        target.provider.as_str(),
        target.server_host.trim().to_ascii_lowercase(),
        repo,
        kind,
        number
    )
}

/// A watch's repository, as it was resolved.
pub fn target_of(w: &watch::Model) -> Option<DeliveryTarget> {
    Some(DeliveryTarget {
        provider: ForgeProvider::parse(&w.provider).ok()?,
        server_host: w.server_host.clone(),
        account_id: w.account_id.clone(),
        owner_repo: w.owner_repo.clone(),
    })
}

/// A watch as it is made.
#[derive(Debug, Clone)]
pub struct NewWatch {
    pub bot_id: i32,
    pub target: DeliveryTarget,
    pub kind: String,
    pub number: i64,
    pub folder_id: Option<i32>,
    pub work_task_id: Option<i32>,
    pub dispatch_id: Option<i32>,
    pub source: String,
    pub state: WatchState,
    pub url: Option<String>,
    pub title: Option<String>,
    pub quiet_first: bool,
}

pub async fn get(conn: &DatabaseConnection, id: i32) -> Result<Option<watch::Model>, DbError> {
    Ok(watch::Entity::find_by_id(id).one(conn).await?)
}

pub async fn by_key(conn: &DatabaseConnection, key: &str) -> Result<Option<watch::Model>, DbError> {
    Ok(watch::Entity::find()
        .filter(watch::Column::ItemKey.eq(key))
        .one(conn)
        .await?)
}

/// The item `number` of `kind` names in project `folder`: the one it was
/// resolved to there the first time.
pub async fn named(
    conn: &DatabaseConnection,
    folder: i32,
    kind: &str,
    number: i64,
) -> Result<Option<watch::Model>, DbError> {
    let Some(n) = name::Entity::find()
        .filter(name::Column::FolderId.eq(folder))
        .filter(name::Column::Kind.eq(kind))
        .filter(name::Column::Number.eq(number))
        .one(conn)
        .await?
    else {
        return Ok(None);
    };
    get(conn, n.watch_id).await
}

/// Keep that `number` of `kind` names watch `watch_id` in project `folder`.
/// The first naming stands: the watch it names, as it is now.
pub async fn bind_name(
    conn: &DatabaseConnection,
    folder: i32,
    kind: &str,
    number: i64,
    watch_id: i32,
) -> Result<watch::Model, DbError> {
    let inserted = name::ActiveModel {
        id: NotSet,
        folder_id: Set(folder),
        kind: Set(kind.to_string()),
        number: Set(number),
        watch_id: Set(watch_id),
        created_at: Set(Utc::now()),
    }
    .insert(conn)
    .await;
    match inserted {
        Ok(_) => {}
        Err(e)
            if matches!(
                e.sql_err(),
                Some(sea_orm::SqlErr::UniqueConstraintViolation(_))
            ) => {}
        Err(e) => return Err(e.into()),
    }
    named(conn, folder, kind, number)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("{kind} {number} in project {folder}")))
}

/// Insert `new`, or — its item on record already — return that row as it
/// is. `true` when it was made now.
pub async fn insert_or_get(
    conn: &DatabaseConnection,
    new: NewWatch,
) -> Result<(watch::Model, bool), DbError> {
    let key = item_key(&new.target, &new.kind, new.number);
    if let Some(w) = by_key(conn, &key).await? {
        return Ok((w, false));
    }
    let now = Utc::now();
    let inserted = watch::ActiveModel {
        id: NotSet,
        bot_id: Set(new.bot_id),
        item_key: Set(key.clone()),
        provider: Set(new.target.provider.as_str().to_string()),
        server_host: Set(new.target.server_host),
        account_id: Set(new.target.account_id),
        owner_repo: Set(new.target.owner_repo),
        kind: Set(new.kind),
        number: Set(new.number),
        folder_id: Set(new.folder_id),
        work_task_id: Set(new.work_task_id),
        dispatch_id: Set(new.dispatch_id),
        source: Set(new.source),
        state: Set(new.state),
        ended_reason: Set(None),
        url: Set(new.url),
        title: Set(new.title),
        pr_state: Set(None),
        draft: Set(false),
        head_sha: Set(None),
        mergeable: Set(None),
        merge_state: Set(None),
        checks: Set(None),
        detail: Set(None),
        phase: Set(None),
        notified: Set(None),
        quiet_first: Set(new.quiet_first),
        last_read_at: Set(None),
        last_change_at: Set(Some(now)),
        next_poll_at: Set(Some(now)),
        not_found: Set(0),
        failures: Set(0),
        backoff: Set(false),
        last_error: Set(None),
        auto: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
    }
    .insert(conn)
    .await;
    match inserted {
        Ok(w) => Ok((w, true)),
        // Two namings racing: the unique key decides, the loser reads it.
        Err(e)
            if matches!(
                e.sql_err(),
                Some(sea_orm::SqlErr::UniqueConstraintViolation(_))
            ) =>
        {
            let w = by_key(conn, &key)
                .await?
                .ok_or_else(|| DbError::NotFound(key.clone()))?;
            Ok((w, false))
        }
        Err(e) => Err(e.into()),
    }
}

/// What a write to a watch changes; `None` leaves a column as it is.
#[derive(Debug, Clone, Default)]
pub struct WatchWrite {
    pub bot_id: Option<i32>,
    pub work_task_id: Option<Option<i32>>,
    pub dispatch_id: Option<Option<i32>>,
    pub folder_id: Option<Option<i32>>,
    pub source: Option<String>,
    pub state: Option<WatchState>,
    pub ended_reason: Option<Option<String>>,
    pub url: Option<Option<String>>,
    pub title: Option<Option<String>>,
    pub pr_state: Option<Option<String>>,
    pub draft: Option<bool>,
    pub head_sha: Option<Option<String>>,
    pub mergeable: Option<Option<bool>>,
    pub merge_state: Option<Option<String>>,
    pub checks: Option<Option<String>>,
    pub detail: Option<Option<String>>,
    pub phase: Option<Option<String>>,
    pub notified: Option<Option<String>>,
    pub quiet_first: Option<bool>,
    pub last_read_at: Option<Option<DateTime<Utc>>>,
    pub last_change_at: Option<Option<DateTime<Utc>>>,
    pub next_poll_at: Option<Option<DateTime<Utc>>>,
    pub not_found: Option<i32>,
    pub failures: Option<i32>,
    pub backoff: Option<bool>,
    pub last_error: Option<Option<String>>,
    /// What codeg did on it by itself (7.4, phase 3), as JSON.
    pub auto: Option<Option<String>>,
    /// Only while `auto` still reads this: what was read before the write
    /// was worked out.
    pub expect_auto: Option<Option<String>>,
}

/// Write `w` to watch `id`; when `from` is given, only while the watch is
/// in one of those states. The row as written, `None` when it was not.
pub async fn update(
    conn: &DatabaseConnection,
    id: i32,
    from: Option<&[WatchState]>,
    w: WatchWrite,
) -> Result<Option<watch::Model>, DbError> {
    let mut q = watch::Entity::update_many()
        .col_expr(watch::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(watch::Column::Id.eq(id));
    if let Some(from) = from {
        q = q.filter(watch::Column::State.is_in(from.iter().copied()));
    }
    macro_rules! set {
        ($field:ident, $col:ident) => {
            if let Some(v) = w.$field {
                q = q.col_expr(watch::Column::$col, Expr::value(v));
            }
        };
    }
    set!(bot_id, BotId);
    set!(work_task_id, WorkTaskId);
    set!(dispatch_id, DispatchId);
    set!(folder_id, FolderId);
    set!(source, Source);
    if let Some(s) = w.state {
        q = q.col_expr(watch::Column::State, Expr::value(s));
    }
    set!(ended_reason, EndedReason);
    set!(url, Url);
    set!(title, Title);
    set!(pr_state, PrState);
    set!(draft, Draft);
    set!(head_sha, HeadSha);
    set!(mergeable, Mergeable);
    set!(merge_state, MergeState);
    set!(checks, Checks);
    set!(detail, Detail);
    set!(phase, Phase);
    set!(notified, Notified);
    set!(quiet_first, QuietFirst);
    set!(last_read_at, LastReadAt);
    set!(last_change_at, LastChangeAt);
    set!(next_poll_at, NextPollAt);
    set!(not_found, NotFound);
    set!(failures, Failures);
    set!(backoff, Backoff);
    set!(last_error, LastError);
    set!(auto, Auto);
    if let Some(expect) = w.expect_auto {
        q = match expect {
            Some(v) => q.filter(watch::Column::Auto.eq(v)),
            None => q.filter(watch::Column::Auto.is_null()),
        };
    }
    let res = q.exec(conn).await?;
    if res.rows_affected == 0 {
        return Ok(None);
    }
    get(conn, id).await
}

/// `bot`'s watches due to be read at `now`, the longest overdue first.
pub async fn due(
    conn: &DatabaseConnection,
    bot: i32,
    now: DateTime<Utc>,
    limit: u64,
) -> Result<Vec<watch::Model>, DbError> {
    Ok(watch::Entity::find()
        .filter(watch::Column::BotId.eq(bot))
        .filter(watch::Column::State.eq(WatchState::Watching))
        .filter(
            Condition::any()
                .add(watch::Column::NextPollAt.is_null())
                .add(watch::Column::NextPollAt.lte(now)),
        )
        .order_by_asc(watch::Column::NextPollAt)
        .limit(limit)
        .all(conn)
        .await?)
}

/// A rate limit on one account: every watch read through it waits until
/// `until` (none is read sooner than it already would be). The watches held
/// back, as they were.
pub async fn hold_account(
    conn: &DatabaseConnection,
    target: &DeliveryTarget,
    until: DateTime<Utc>,
) -> Result<Vec<watch::Model>, DbError> {
    let on_account = || {
        Condition::all()
            .add(watch::Column::State.eq(WatchState::Watching))
            .add(watch::Column::Provider.eq(target.provider.as_str()))
            .add(watch::Column::ServerHost.eq(target.server_host.as_str()))
            .add(watch::Column::AccountId.eq(target.account_id.as_str()))
            .add(
                Condition::any()
                    .add(watch::Column::NextPollAt.is_null())
                    .add(watch::Column::NextPollAt.lt(until)),
            )
    };
    let held = watch::Entity::find().filter(on_account()).all(conn).await?;
    watch::Entity::update_many()
        .col_expr(watch::Column::NextPollAt, Expr::value(Some(until)))
        .col_expr(watch::Column::Backoff, Expr::value(true))
        .col_expr(watch::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(on_account())
        .exec(conn)
        .await?;
    Ok(held)
}

/// The watches of these board tasks, by task id: the latest of each.
pub async fn of_tasks(
    conn: &DatabaseConnection,
    task_ids: &[i32],
) -> Result<HashMap<i32, watch::Model>, DbError> {
    if task_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = watch::Entity::find()
        .filter(watch::Column::WorkTaskId.is_in(task_ids.iter().copied()))
        .filter(watch::Column::Kind.eq("pr"))
        .order_by_asc(watch::Column::UpdatedAt)
        .all(conn)
        .await?;
    let mut out = HashMap::new();
    for w in rows {
        if let Some(t) = w.work_task_id {
            out.insert(t, w);
        }
    }
    Ok(out)
}

/// Every watch being read — `bot`'s when given.
pub async fn watching(
    conn: &DatabaseConnection,
    bot: Option<i32>,
) -> Result<Vec<watch::Model>, DbError> {
    let mut q = watch::Entity::find().filter(watch::Column::State.eq(WatchState::Watching));
    if let Some(b) = bot {
        q = q.filter(watch::Column::BotId.eq(b));
    }
    Ok(q.order_by_desc(watch::Column::UpdatedAt).all(conn).await?)
}

/// Watches that ended since `since` (merged, closed…).
pub async fn ended_since(
    conn: &DatabaseConnection,
    since: DateTime<Utc>,
) -> Result<Vec<watch::Model>, DbError> {
    Ok(watch::Entity::find()
        .filter(watch::Column::State.eq(WatchState::Ended))
        .filter(watch::Column::UpdatedAt.gte(since))
        .order_by_desc(watch::Column::UpdatedAt)
        .all(conn)
        .await?)
}

/// Hand `from`'s watches to `to` (a work assistant deleted, its work moved):
/// what was told was told to `from`, so `to` is told where each stands on
/// its first read, soon.
pub async fn move_bot(conn: &DatabaseConnection, from: i32, to: i32) -> Result<u64, DbError> {
    let now = Utc::now();
    let res = watch::Entity::update_many()
        .col_expr(watch::Column::BotId, Expr::value(to))
        .col_expr(watch::Column::Notified, Expr::value(None::<String>))
        .col_expr(watch::Column::QuietFirst, Expr::value(false))
        .col_expr(watch::Column::NextPollAt, Expr::value(Some(now)))
        .col_expr(watch::Column::UpdatedAt, Expr::value(now))
        .filter(watch::Column::BotId.eq(from))
        .exec(conn)
        .await?;
    Ok(res.rows_affected)
}

/// End every watch of `bot`'s still read.
pub async fn end_of_bot(conn: &DatabaseConnection, bot: i32, reason: &str) -> Result<u64, DbError> {
    let res = watch::Entity::update_many()
        .col_expr(watch::Column::State, Expr::value(WatchState::Ended))
        .col_expr(
            watch::Column::EndedReason,
            Expr::value(Some(reason.to_string())),
        )
        .col_expr(watch::Column::UpdatedAt, Expr::value(Utc::now()))
        .filter(watch::Column::BotId.eq(bot))
        .filter(watch::Column::State.eq(WatchState::Watching))
        .exec(conn)
        .await?;
    Ok(res.rows_affected)
}

// ── coding events ───────────────────────────────────────────────────────────

/// A coding event as it is recorded.
#[derive(Debug, Clone)]
pub struct NewSignal {
    pub kind: &'static str,
    pub key: String,
    pub bot_id: Option<i32>,
    pub folder_id: Option<i32>,
    pub facts: serde_json::Value,
}

/// Record `s`; `false` when the same thing was recorded already.
pub async fn record_signal(conn: &impl sea_orm::ConnectionTrait, s: NewSignal) -> Result<bool, DbError> {
    let inserted = signal::ActiveModel {
        id: NotSet,
        kind: Set(s.kind.to_string()),
        key: Set(s.key),
        bot_id: Set(s.bot_id),
        folder_id: Set(s.folder_id),
        facts: Set(s.facts.to_string()),
        created_at: Set(Utc::now()),
    }
    .insert(conn)
    .await;
    match inserted {
        Ok(_) => Ok(true),
        Err(e)
            if matches!(
                e.sql_err(),
                Some(sea_orm::SqlErr::UniqueConstraintViolation(_))
            ) =>
        {
            Ok(false)
        }
        Err(e) => Err(e.into()),
    }
}

/// The events after `after` (an id), oldest first.
pub async fn signals_after(
    conn: &DatabaseConnection,
    after: i32,
    limit: u64,
) -> Result<Vec<signal::Model>, DbError> {
    Ok(signal::Entity::find()
        .filter(signal::Column::Id.gt(after))
        .order_by_asc(signal::Column::Id)
        .limit(limit)
        .all(conn)
        .await?)
}

/// Forget events older than `before`.
pub async fn prune_signals(
    conn: &DatabaseConnection,
    before: DateTime<Utc>,
) -> Result<u64, DbError> {
    let res = signal::Entity::delete_many()
        .filter(signal::Column::CreatedAt.lt(before))
        .exec(conn)
        .await?;
    Ok(res.rows_affected)
}
