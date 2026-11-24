//! The time machine's store (8.2): the documents, the full-text index kept
//! in step with them by triggers, and how far each source has been read.
//! What goes in a document, and how hits are ranked, is the engine's
//! (`personal_agent::history`).

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sea_orm::{
    ActiveValue::{NotSet, Set},
    ColumnTrait, ConnectionTrait, DatabaseConnection, DbBackend, EntityTrait, FromQueryResult,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Statement, TransactionTrait, Value,
};

use crate::db::entities::conversation::{self, ConversationKind};
use crate::db::entities::personal_agent_history_cursor as cursor;
use crate::db::entities::personal_agent_history_doc as doc;
use crate::db::error::DbError;

pub const TIMELINE: &str = "timeline";
pub const MESSAGE: &str = "message";
pub const SESSION: &str = "session";
pub const TASK: &str = "task";

/// Every source, in the order a search names them.
pub const SOURCES: [&str; 4] = [TIMELINE, SESSION, TASK, MESSAGE];

const INSERT_CHUNK: usize = 200;

/// A document to write.
#[derive(Debug, Clone, PartialEq)]
pub struct NewDoc {
    pub source: &'static str,
    pub ref_id: i32,
    pub part: String,
    pub role: &'static str,
    pub bot_id: Option<i32>,
    pub peer_bot_id: Option<i32>,
    pub folder_id: Option<i32>,
    pub agent_type: Option<String>,
    pub title: Option<String>,
    pub body: String,
    pub weight: i32,
    pub at: DateTime<Utc>,
    pub row_id: Option<i32>,
    pub conversation_id: Option<i32>,
}

impl NewDoc {
    fn into_active(self) -> doc::ActiveModel {
        doc::ActiveModel {
            id: NotSet,
            source: Set(self.source.to_string()),
            ref_id: Set(self.ref_id),
            part: Set(self.part),
            role: Set(self.role.to_string()),
            bot_id: Set(self.bot_id),
            peer_bot_id: Set(self.peer_bot_id),
            folder_id: Set(self.folder_id),
            agent_type: Set(self.agent_type),
            title: Set(self.title),
            body: Set(self.body),
            weight: Set(self.weight),
            at: Set(self.at),
            row_id: Set(self.row_id),
            conversation_id: Set(self.conversation_id),
        }
    }
}

async fn put<C: ConnectionTrait>(
    conn: &C,
    source: &str,
    ref_id: i32,
    docs: Vec<NewDoc>,
) -> Result<(), DbError> {
    doc::Entity::delete_many()
        .filter(doc::Column::Source.eq(source))
        .filter(doc::Column::RefId.eq(ref_id))
        .exec(conn)
        .await?;
    let mut docs = docs.into_iter().peekable();
    while docs.peek().is_some() {
        let chunk: Vec<doc::ActiveModel> = docs
            .by_ref()
            .take(INSERT_CHUNK)
            .map(NewDoc::into_active)
            .collect();
        doc::Entity::insert_many(chunk).exec(conn).await?;
    }
    Ok(())
}

/// What `source`'s `ref_id` reads as now: its documents, none when there is
/// nothing to find in it.
pub async fn replace(
    conn: &DatabaseConnection,
    source: &str,
    ref_id: i32,
    docs: Vec<NewDoc>,
) -> Result<(), DbError> {
    let txn = conn.begin().await?;
    put(&txn, source, ref_id, docs).await?;
    txn.commit().await?;
    Ok(())
}

/// A conversation as read when it was as of `updated_at`: its documents and
/// the stamp that says so, together.
pub async fn replace_session(
    conn: &DatabaseConnection,
    conversation_id: i32,
    updated_at: DateTime<Utc>,
    docs: Vec<NewDoc>,
) -> Result<(), DbError> {
    let txn = conn.begin().await?;
    put(&txn, SESSION, conversation_id, docs).await?;
    stamp(&txn, SESSION, conversation_id, Some(updated_at), None).await?;
    txn.commit().await?;
    Ok(())
}

async fn stamp<C: ConnectionTrait>(
    conn: &C,
    source: &str,
    ref_id: i32,
    at: Option<DateTime<Utc>>,
    mark: Option<i32>,
) -> Result<(), DbError> {
    cursor::Entity::insert(cursor::ActiveModel {
        source: Set(source.to_string()),
        ref_id: Set(ref_id),
        at: Set(at),
        mark: Set(mark),
    })
    .on_conflict(
        sea_orm::sea_query::OnConflict::columns([cursor::Column::Source, cursor::Column::RefId])
            .update_columns([cursor::Column::At, cursor::Column::Mark])
            .to_owned(),
    )
    .exec(conn)
    .await?;
    Ok(())
}

/// The conversation read as of `updated_at`, its documents as they were.
pub async fn stamp_session(
    conn: &DatabaseConnection,
    conversation_id: i32,
    updated_at: DateTime<Utc>,
) -> Result<(), DbError> {
    stamp(conn, SESSION, conversation_id, Some(updated_at), None).await
}

/// Whether `source`'s `ref_id` has documents.
pub async fn has_docs(
    conn: &DatabaseConnection,
    source: &str,
    ref_id: i32,
) -> Result<bool, DbError> {
    Ok(doc::Entity::find()
        .filter(doc::Column::Source.eq(source))
        .filter(doc::Column::RefId.eq(ref_id))
        .count(conn)
        .await?
        > 0)
}

/// How far `source` (timeline, messages, tasks) has been read: the last
/// change, by its time and id.
pub async fn cursor_of(
    conn: &DatabaseConnection,
    source: &str,
) -> Result<Option<(DateTime<Utc>, i32)>, DbError> {
    Ok(cursor::Entity::find_by_id((source.to_string(), 0))
        .one(conn)
        .await?
        .and_then(|c| Some((c.at?, c.mark?))))
}

pub async fn set_cursor(
    conn: &DatabaseConnection,
    source: &str,
    at: DateTime<Utc>,
    id: i32,
) -> Result<(), DbError> {
    stamp(conn, source, 0, Some(at), Some(id)).await
}

/// Forget `source`: its documents and how far it was read.
pub async fn clear_source(conn: &DatabaseConnection, source: &str) -> Result<(), DbError> {
    let txn = conn.begin().await?;
    doc::Entity::delete_many()
        .filter(doc::Column::Source.eq(source))
        .exec(&txn)
        .await?;
    cursor::Entity::delete_many()
        .filter(cursor::Column::Source.eq(source))
        .exec(&txn)
        .await?;
    txn.commit().await?;
    Ok(())
}

/// Whether anything of `source` is kept.
pub async fn has_source(conn: &DatabaseConnection, source: &str) -> Result<bool, DbError> {
    let docs = doc::Entity::find()
        .filter(doc::Column::Source.eq(source))
        .count(conn)
        .await?;
    let read = cursor::Entity::find()
        .filter(cursor::Column::Source.eq(source))
        .count(conn)
        .await?;
    Ok(docs + read > 0)
}

/// Forget everything: the index is built again from the start.
pub async fn clear_all(conn: &DatabaseConnection) -> Result<(), DbError> {
    let txn = conn.begin().await?;
    doc::Entity::delete_many().exec(&txn).await?;
    cursor::Entity::delete_many().exec(&txn).await?;
    txn.commit().await?;
    Ok(())
}

/// What is no longer there leaves the index: rows and messages gone (or
/// their assistant deleted), tasks and conversations deleted.
pub async fn prune(conn: &DatabaseConnection) -> Result<u64, DbError> {
    let mut gone = 0;
    for sql in [
        "DELETE FROM personal_agent_history_doc WHERE source = 'timeline' AND (\
            ref_id NOT IN (SELECT id FROM personal_agent_timeline) \
            OR bot_id IN (SELECT id FROM personal_agent WHERE deleted_at IS NOT NULL))",
        "DELETE FROM personal_agent_history_doc WHERE source = 'message' AND (\
            ref_id NOT IN (SELECT id FROM personal_agent_message) \
            OR bot_id IN (SELECT id FROM personal_agent WHERE deleted_at IS NOT NULL))",
        "DELETE FROM personal_agent_history_doc WHERE source = 'task' AND \
            ref_id NOT IN (SELECT id FROM work_task WHERE deleted_at IS NULL)",
        "DELETE FROM personal_agent_history_doc WHERE source = 'session' AND \
            ref_id NOT IN (SELECT id FROM conversation WHERE deleted_at IS NULL \
            AND kind != 'personal')",
        "DELETE FROM personal_agent_history_cursor WHERE source = 'session' AND \
            ref_id NOT IN (SELECT id FROM conversation WHERE deleted_at IS NULL \
            AND kind != 'personal')",
    ] {
        gone += conn.execute_unprepared(sql).await?.rows_affected();
    }
    Ok(gone)
}

/// The conversations searched (not deleted; the assistants' own sessions
/// are their timelines), newest first, with when each last changed.
async fn sessions(conn: &DatabaseConnection) -> Result<Vec<(i32, DateTime<Utc>)>, DbError> {
    Ok(conversation::Entity::find()
        .select_only()
        .column(conversation::Column::Id)
        .column(conversation::Column::UpdatedAt)
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(conversation::Column::Kind.ne(ConversationKind::Personal))
        .order_by_desc(conversation::Column::UpdatedAt)
        .order_by_desc(conversation::Column::Id)
        .into_tuple()
        .all(conn)
        .await?)
}

async fn session_stamps(conn: &DatabaseConnection) -> Result<HashMap<i32, DateTime<Utc>>, DbError> {
    Ok(cursor::Entity::find()
        .filter(cursor::Column::Source.eq(SESSION))
        .all(conn)
        .await?
        .into_iter()
        .filter_map(|c| Some((c.ref_id, c.at?)))
        .collect())
}

/// The conversations changed since they were last read (or never read),
/// newest first, with when each last changed.
pub async fn stale_sessions(
    conn: &DatabaseConnection,
) -> Result<Vec<(i32, DateTime<Utc>)>, DbError> {
    let stamps = session_stamps(conn).await?;
    Ok(sessions(conn)
        .await?
        .into_iter()
        .filter(|(id, at)| stamps.get(id) != Some(at))
        .collect())
}

/// How many of the conversations searched are read as they are now, and
/// how many there are.
pub async fn session_counts(conn: &DatabaseConnection) -> Result<(u32, u32), DbError> {
    let stamps = session_stamps(conn).await?;
    let all = sessions(conn).await?;
    let done = all
        .iter()
        .filter(|(id, at)| stamps.get(id) == Some(at))
        .count();
    Ok((done as u32, all.len() as u32))
}

pub async fn doc_count(conn: &DatabaseConnection) -> Result<u64, DbError> {
    Ok(doc::Entity::find().count(conn).await?)
}

/// What a search is limited to.
#[derive(Debug, Clone, Default)]
pub struct Filter {
    /// The sources searched; all when empty.
    pub sources: Vec<&'static str>,
    pub since: Option<DateTime<Utc>>,
    /// Only documents of these folders.
    pub folders: Option<Vec<i32>>,
}

/// A document a search found.
#[derive(Debug, Clone, FromQueryResult)]
pub struct Found {
    pub id: i32,
    pub source: String,
    pub ref_id: i32,
    pub part: String,
    pub role: String,
    pub bot_id: Option<i32>,
    pub peer_bot_id: Option<i32>,
    pub folder_id: Option<i32>,
    pub agent_type: Option<String>,
    pub title: Option<String>,
    pub body: String,
    pub weight: i32,
    pub at: DateTime<Utc>,
    pub row_id: Option<i32>,
    pub conversation_id: Option<i32>,
    /// The index's excerpt, the match between `\u{2}` and `\u{3}`; none
    /// from a scan.
    pub excerpt: Option<String>,
    /// The index's rank (lower is better); 0 from a scan.
    pub rank: f64,
}

/// `%`, `_` and the escape itself, escaped for `LIKE … ESCAPE '\'`.
fn like(term: &str) -> String {
    let mut out = String::with_capacity(term.len() + 2);
    out.push('%');
    for c in term.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// The `AND …` the filter and the short terms add, and their values.
fn conditions(filter: &Filter, contains: &[String], values: &mut Vec<Value>) -> String {
    let mut sql = String::new();
    if !filter.sources.is_empty() {
        sql.push_str(" AND d.source IN (");
        for (i, s) in filter.sources.iter().enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push('?');
            values.push((*s).into());
        }
        sql.push(')');
    }
    if let Some(since) = filter.since {
        sql.push_str(" AND d.at >= ?");
        values.push(since.into());
    }
    if let Some(folders) = &filter.folders {
        if folders.is_empty() {
            sql.push_str(" AND 0");
        } else {
            sql.push_str(" AND d.folder_id IN (");
            for (i, f) in folders.iter().enumerate() {
                if i > 0 {
                    sql.push_str(", ");
                }
                sql.push('?');
                values.push((*f).into());
            }
            sql.push(')');
        }
    }
    for term in contains {
        sql.push_str(" AND d.body LIKE ? ESCAPE '\\'");
        values.push(like(term).into());
    }
    sql
}

const COLUMNS: &str = "d.id, d.source, d.ref_id, d.part, d.role, d.bot_id, d.peer_bot_id, \
    d.folder_id, d.agent_type, d.title, d.weight, d.at, d.row_id, d.conversation_id";

/// Through the index: documents matching every one of `terms` (each three
/// characters or more), and containing each of `contains`, best first.
pub async fn search_index(
    conn: &DatabaseConnection,
    terms: &[String],
    contains: &[String],
    filter: &Filter,
    limit: u64,
) -> Result<Vec<Found>, DbError> {
    let expr = terms
        .iter()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ");
    let mut values: Vec<Value> = vec![expr.into()];
    let more = conditions(filter, contains, &mut values);
    values.push((limit as i64).into());
    let sql = format!(
        "SELECT {COLUMNS}, '' AS body, \
         snippet(personal_agent_history_fts, 0, char(2), char(3), '…', 40) AS excerpt, \
         bm25(personal_agent_history_fts) AS rank \
         FROM personal_agent_history_fts \
         JOIN personal_agent_history_doc d ON d.id = personal_agent_history_fts.rowid \
         WHERE personal_agent_history_fts MATCH ?{more} \
         ORDER BY rank * (CASE WHEN d.weight >= 3 THEN 1.5 WHEN d.weight = 2 THEN 1.0 \
         ELSE 0.5 END) LIMIT ?"
    );
    Ok(Found::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        sql,
        values,
    ))
    .all(conn)
    .await?)
}

/// Without the index (terms too short for it): documents since `since`
/// containing each of `contains`, newest first, with their text.
pub async fn search_scan(
    conn: &DatabaseConnection,
    contains: &[String],
    filter: &Filter,
    limit: u64,
) -> Result<Vec<Found>, DbError> {
    let mut values: Vec<Value> = Vec::new();
    let more = conditions(filter, contains, &mut values);
    values.push((limit as i64).into());
    let sql = format!(
        "SELECT {COLUMNS}, d.body, NULL AS excerpt, 0.0 AS rank \
         FROM personal_agent_history_doc d WHERE 1{more} \
         ORDER BY d.at DESC, d.id DESC LIMIT ?"
    );
    Ok(Found::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Sqlite,
        sql,
        values,
    ))
    .all(conn)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    fn new_doc(
        source: &'static str,
        ref_id: i32,
        part: &str,
        body: &str,
        at: DateTime<Utc>,
    ) -> NewDoc {
        NewDoc {
            source,
            ref_id,
            part: part.into(),
            role: "owner",
            bot_id: Some(1),
            peer_bot_id: None,
            folder_id: Some(7),
            agent_type: None,
            title: None,
            body: body.into(),
            weight: 2,
            at,
            row_id: None,
            conversation_id: None,
        }
    }

    #[tokio::test]
    async fn the_index_finds_any_three_characters_and_keeps_in_step_with_the_documents() {
        let db = fresh_in_memory_db().await;
        let conn = &db.conn;
        let now = Utc::now();
        replace(
            conn,
            TIMELINE,
            1,
            vec![new_doc(
                TIMELINE,
                1,
                "",
                "为什么把打包脚本改成 PowerShell 了",
                now,
            )],
        )
        .await
        .unwrap();
        replace(
            conn,
            TASK,
            2,
            vec![new_doc(TASK, 2, "", "Bump the Windows installer", now)],
        )
        .await
        .unwrap();
        let all = Filter::default();
        let found = search_index(conn, &["打包脚本".into()], &[], &all, 10)
            .await
            .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].ref_id, 1);
        let excerpt = found[0].excerpt.as_deref().unwrap();
        assert!(excerpt.contains("\u{2}打包脚本\u{3}"), "{excerpt}");
        // Case does not matter; every term must be there.
        assert_eq!(
            search_index(conn, &["windows".into()], &[], &all, 10)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(
            search_index(conn, &["windows".into()], &["打包".into()], &all, 10)
                .await
                .unwrap()
                .is_empty()
        );
        // A short term is looked for in the text.
        let found = search_index(conn, &["installer".into()], &["Bu".into()], &all, 10)
            .await
            .unwrap();
        assert_eq!(found.len(), 1);
        // Quotes in a term are the term's.
        assert!(search_index(conn, &["a\"b OR c".into()], &[], &all, 10)
            .await
            .unwrap()
            .is_empty());
        // Replaced, the old text is no longer found; removed, nothing is.
        replace(
            conn,
            TASK,
            2,
            vec![new_doc(TASK, 2, "", "Bump the macOS installer", now)],
        )
        .await
        .unwrap();
        assert!(search_index(conn, &["windows".into()], &[], &all, 10)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            search_index(conn, &["macos".into()], &[], &all, 10)
                .await
                .unwrap()
                .len(),
            1
        );
        replace(conn, TASK, 2, Vec::new()).await.unwrap();
        assert!(search_index(conn, &["macos".into()], &[], &all, 10)
            .await
            .unwrap()
            .is_empty());
        // The filter: sources, time, folders.
        let only_tasks = Filter {
            sources: vec![TASK],
            ..Default::default()
        };
        assert!(
            search_index(conn, &["打包脚本".into()], &[], &only_tasks, 10)
                .await
                .unwrap()
                .is_empty()
        );
        let later = Filter {
            since: Some(now + chrono::Duration::seconds(1)),
            ..Default::default()
        };
        assert!(search_index(conn, &["打包脚本".into()], &[], &later, 10)
            .await
            .unwrap()
            .is_empty());
        let elsewhere = Filter {
            folders: Some(vec![8]),
            ..Default::default()
        };
        assert!(
            search_index(conn, &["打包脚本".into()], &[], &elsewhere, 10)
                .await
                .unwrap()
                .is_empty()
        );
        let here = Filter {
            folders: Some(vec![7]),
            ..Default::default()
        };
        assert_eq!(
            search_index(conn, &["打包脚本".into()], &[], &here, 10)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn a_scan_finds_one_or_two_characters_newest_first_and_escapes_like() {
        let db = fresh_in_memory_db().await;
        let conn = &db.conn;
        let now = Utc::now();
        replace(
            conn,
            TIMELINE,
            1,
            vec![new_doc(
                TIMELINE,
                1,
                "",
                "改了 UI 的颜色",
                now - chrono::Duration::days(1),
            )],
        )
        .await
        .unwrap();
        replace(
            conn,
            TIMELINE,
            2,
            vec![new_doc(TIMELINE, 2, "", "颜色 100% 对了", now)],
        )
        .await
        .unwrap();
        let all = Filter::default();
        let found = search_scan(conn, &["颜色".into()], &all, 10).await.unwrap();
        assert_eq!(
            found.iter().map(|f| f.ref_id).collect::<Vec<_>>(),
            vec![2, 1]
        );
        assert_eq!(found[0].body, "颜色 100% 对了");
        assert_eq!(
            search_scan(conn, &["ui".into()], &all, 10)
                .await
                .unwrap()
                .len(),
            1
        );
        let found = search_scan(conn, &["0%".into()], &all, 10).await.unwrap();
        assert_eq!(found.len(), 1, "% is the text's, not a wildcard");
        assert!(search_scan(conn, &["_".into()], &all, 10)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn a_conversation_is_read_again_only_once_it_changed() {
        let db = fresh_in_memory_db().await;
        let conn = &db.conn;
        let folder = crate::db::service::folder_service::add_folder(conn, "/tmp/p")
            .await
            .unwrap();
        let c = crate::db::service::conversation_service::create(
            conn,
            folder.id,
            crate::models::AgentType::ClaudeCode,
            Some("t".into()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(stale_sessions(conn).await.unwrap().len(), 1);
        assert_eq!(session_counts(conn).await.unwrap(), (0, 1));
        let at = stale_sessions(conn).await.unwrap()[0].1;
        replace_session(
            conn,
            c.id,
            at,
            vec![new_doc(SESSION, c.id, "turn-0", "hello world", at)],
        )
        .await
        .unwrap();
        assert!(stale_sessions(conn).await.unwrap().is_empty());
        assert_eq!(session_counts(conn).await.unwrap(), (1, 1));
        // Deleted, it leaves the index.
        conversation::Entity::update_many()
            .col_expr(
                conversation::Column::DeletedAt,
                sea_orm::sea_query::Expr::value(Utc::now()),
            )
            .exec(conn)
            .await
            .unwrap();
        assert!(prune(conn).await.unwrap() >= 2);
        assert_eq!(doc_count(conn).await.unwrap(), 0);
        assert_eq!(session_counts(conn).await.unwrap(), (0, 0));
    }
}
