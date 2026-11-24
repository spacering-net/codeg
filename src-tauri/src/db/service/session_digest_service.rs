use super::conversation_context_service::{lock_context, read_brief};
use crate::db::{entities::conversation_context, error::DbError};
use chrono::{DateTime, Utc};
use sea_orm::{
    sea_query::Expr, ColumnTrait, DatabaseConnection, DatabaseTransaction, EntityTrait, QueryFilter,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

pub const DIGEST_EVENT: &str = "session-digest://changed";
pub const ANSWER_PREFIX: &str = "digest-answer-";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DigestQuestion {
    pub id: String,
    pub question: String,
    pub options: Vec<String>,
    pub recommended: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DigestSuggestion {
    pub id: String,
    pub title: String,
    pub detail: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DigestInput {
    pub now: Vec<String>,
    pub news: Vec<String>,
    pub needs_you: Vec<DigestQuestion>,
    pub suggestions: Vec<DigestSuggestion>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestAnswer {
    pub token: String,
    pub option: String,
    pub expires_at: DateTime<Utc>,
    pub sent: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDigest {
    #[serde(flatten)]
    pub content: DigestInput,
    pub revision: u64,
    pub updated_at: DateTime<Utc>,
    pub answers: BTreeMap<String, DigestAnswer>,
    pub dismissed_suggestions: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerClaim {
    pub token: String,
    pub text: String,
}

fn invalid(message: &str) -> DbError {
    DbError::Validation(message.into())
}
fn line(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 300 && !value.contains(['\n', '\r'])
}
pub fn validate(input: &DigestInput) -> Result<(), DbError> {
    if input.now.len() > 8
        || input.news.len() > 5
        || input.needs_you.len() > 3
        || input.suggestions.len() > 3
    {
        return Err(invalid(
            "digest section limit exceeded (now 8, news 5, needsYou 3, suggestions 3)",
        ));
    }
    if input.now.iter().chain(&input.news).any(|s| !line(s)) {
        return Err(invalid(
            "Every digest line must contain 1 to 300 characters without line breaks",
        ));
    }
    let mut ids = HashSet::new();
    for q in &input.needs_you {
        if !line(&q.id)
            || !ids.insert(&q.id)
            || !line(&q.question)
            || q.options.is_empty()
            || q.options.len() > 4
            || q.options.iter().any(|s| !line(s))
            || q.options.iter().collect::<HashSet<_>>().len() != q.options.len()
        {
            return Err(invalid("Questions need unique IDs, a question and 1 to 4 distinct options; each line is limited to 300 characters"));
        }
        if q.recommended
            .as_ref()
            .is_some_and(|r| !q.options.contains(r))
        {
            return Err(invalid("recommended must be the exact text of an option"));
        }
    }
    let mut ids = HashSet::new();
    let mut titles = HashSet::new();
    for s in &input.suggestions {
        if !line(&s.id)
            || !ids.insert(&s.id)
            || !line(&s.title)
            || !titles.insert(&s.title)
            || s.detail.as_ref().is_some_and(|s| !line(s))
        {
            return Err(invalid(
                "Suggestions need distinct IDs and titles; each line is limited to 300 characters",
            ));
        }
    }
    Ok(())
}
fn decode(row: &conversation_context::Model) -> Result<Option<SessionDigest>, DbError> {
    row.digest
        .as_deref()
        .map(|raw| {
            serde_json::from_str(raw).map_err(|e| invalid(&format!("Invalid stored digest: {e}")))
        })
        .transpose()
}
async fn load(txn: &DatabaseTransaction, id: i32) -> Result<conversation_context::Model, DbError> {
    conversation_context::Entity::find_by_id(id)
        .one(txn)
        .await?
        .ok_or_else(|| DbError::NotFound("Session context".into()))
}
async fn save(txn: &DatabaseTransaction, id: i32, digest: &SessionDigest) -> Result<(), DbError> {
    let json = serde_json::to_string(digest).map_err(|e| invalid(&e.to_string()))?;
    let dismissed = serde_json::to_string(&digest.dismissed_suggestions)
        .map_err(|e| invalid(&e.to_string()))?;
    conversation_context::Entity::update_many()
        .col_expr(conversation_context::Column::Digest, Expr::value(json))
        .col_expr(
            conversation_context::Column::DismissedSuggestions,
            Expr::value(dismissed),
        )
        .filter(conversation_context::Column::ConversationId.eq(id))
        .exec(txn)
        .await?;
    Ok(())
}
pub async fn read(db: &DatabaseConnection, id: i32) -> Result<Option<SessionDigest>, DbError> {
    read_brief(db, id).await?;
    match conversation_context::Entity::find_by_id(id).one(db).await? {
        Some(row) => decode(&row),
        None => Ok(None),
    }
}
pub async fn update(
    db: &DatabaseConnection,
    id: i32,
    mut content: DigestInput,
) -> Result<SessionDigest, DbError> {
    validate(&content)?;
    let txn = lock_context(db, id).await?;
    let row = load(&txn, id).await?;
    let previous = decode(&row)?;
    let dismissed: Vec<String> =
        serde_json::from_str(&row.dismissed_suggestions).map_err(|e| invalid(&e.to_string()))?;
    content
        .suggestions
        .retain(|s| !dismissed.contains(&s.title));
    let answers = previous
        .as_ref()
        .map(|old| {
            old.answers
                .iter()
                .filter(|(key, _)| {
                    let before = old.content.needs_you.iter().find(|q| &q.id == *key);
                    let after = content.needs_you.iter().find(|q| &q.id == *key);
                    matches!((before, after), (Some(before), Some(after)) if before.question == after.question && before.options == after.options)
                })
                .map(|(id, a)| (id.clone(), a.clone()))
                .collect()
        })
        .unwrap_or_default();
    let digest = SessionDigest {
        content,
        revision: previous.as_ref().map_or(1, |d| d.revision + 1),
        updated_at: Utc::now(),
        answers,
        dismissed_suggestions: dismissed,
    };
    save(&txn, id, &digest).await?;
    txn.commit().await?;
    Ok(digest)
}
pub async fn dismiss(
    db: &DatabaseConnection,
    id: i32,
    revision: u64,
    title: &str,
) -> Result<SessionDigest, DbError> {
    let txn = lock_context(db, id).await?;
    let mut digest = decode(&load(&txn, id).await?)?.ok_or_else(|| invalid("No digest"))?;
    if digest.revision != revision || !digest.content.suggestions.iter().any(|s| s.title == title) {
        return Err(invalid("Suggestion is no longer current"));
    }
    if !digest.dismissed_suggestions.iter().any(|s| s == title) {
        digest.dismissed_suggestions.push(title.into());
    }
    digest.content.suggestions.retain(|s| s.title != title);
    digest.revision += 1;
    digest.updated_at = Utc::now();
    save(&txn, id, &digest).await?;
    txn.commit().await?;
    Ok(digest)
}
pub async fn reserve(
    db: &DatabaseConnection,
    id: i32,
    revision: u64,
    question_id: &str,
    option: &str,
) -> Result<AnswerClaim, DbError> {
    let txn = lock_context(db, id).await?;
    let mut digest = decode(&load(&txn, id).await?)?.ok_or_else(|| invalid("No digest"))?;
    if digest.revision != revision {
        return Err(invalid("Question is no longer current"));
    }
    let question = digest
        .content
        .needs_you
        .iter()
        .find(|q| q.id == question_id)
        .ok_or_else(|| invalid("Question is no longer current"))?;
    if !question.options.iter().any(|s| s == option) {
        return Err(invalid("Option is no longer current"));
    }
    if digest
        .answers
        .get(question_id)
        .is_some_and(|a| a.sent || a.expires_at > Utc::now())
    {
        return Err(invalid("Question is already answered or being sent"));
    }
    let text = format!("{}\n{}", question.question, option);
    let token = format!("{ANSWER_PREFIX}{}", uuid::Uuid::new_v4());
    digest.answers.insert(
        question_id.into(),
        DigestAnswer {
            token: token.clone(),
            option: option.into(),
            expires_at: Utc::now() + chrono::Duration::seconds(60),
            sent: false,
        },
    );
    digest.revision += 1;
    save(&txn, id, &digest).await?;
    txn.commit().await?;
    Ok(AnswerClaim { token, text })
}
pub async fn release(db: &DatabaseConnection, id: i32, token: &str) -> Result<(), DbError> {
    let txn = lock_context(db, id).await?;
    if let Some(mut digest) = decode(&load(&txn, id).await?)? {
        digest.answers.retain(|_, a| a.token != token || a.sent);
        digest.revision += 1;
        save(&txn, id, &digest).await?;
    }
    txn.commit().await?;
    Ok(())
}
// Kept open through the existing prompt enqueue. Updates/deletion cannot change
// the question after its final validation; a failed send rolls this mark back.
pub async fn admit_answer(
    db: &DatabaseConnection,
    id: i32,
    token: &str,
    text: &str,
) -> Result<DatabaseTransaction, DbError> {
    let txn = lock_context(db, id).await?;
    let mut digest =
        decode(&load(&txn, id).await?)?.ok_or_else(|| invalid("Question is no longer current"))?;
    let (question_id, answer) = digest
        .answers
        .iter_mut()
        .find(|(_, a)| a.token == token)
        .ok_or_else(|| invalid("Answer reservation is no longer current"))?;
    if answer.sent || answer.expires_at <= Utc::now() {
        return Err(invalid(
            "Answer reservation has expired or was already sent",
        ));
    }
    let question = digest
        .content
        .needs_you
        .iter()
        .find(|q| q.id == *question_id)
        .ok_or_else(|| invalid("Question is no longer current"))?;
    if text != format!("{}\n{}", question.question, answer.option) {
        return Err(invalid("Answer text does not match the reserved option"));
    }
    answer.sent = true;
    digest.revision += 1;
    digest.updated_at = Utc::now();
    save(&txn, id, &digest).await?;
    Ok(txn)
}
pub async fn broadcast(
    db: &DatabaseConnection,
    emitter: &crate::web::event_bridge::EventEmitter,
    id: i32,
) {
    if let Ok(digest) = read(db, id).await {
        crate::web::event_bridge::emit_event(
            emitter,
            DIGEST_EVENT,
            serde_json::json!({"conversationId":id,"digest":digest}),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder},
        models::agent::AgentType,
    };
    fn input() -> DigestInput {
        serde_json::from_value(serde_json::json!({"now":["Working"],"news":[],"needsYou":[{"id":"q","question":"Choose","options":["A","B"],"recommended":"A"}],"suggestions":[{"id":"s","title":"Try tests"}]})).unwrap()
    }
    #[test]
    fn rejects_oversized_sections_lines_and_invalid_recommendations() {
        let mut value = input();
        value.now = vec!["x".into(); 9];
        assert!(validate(&value).is_err());
        let mut value = input();
        value.needs_you[0].recommended = Some("unknown".into());
        assert!(validate(&value).is_err());
        let mut value = input();
        value.news = vec!["字".repeat(301)];
        assert!(validate(&value).is_err());
        let mut value = input();
        value.needs_you[0].options = vec!["a".into(); 5];
        assert!(validate(&value).is_err());
        assert!(validate(&input()).is_ok());
    }
    #[tokio::test]
    async fn broadcasts_the_persisted_digest_to_conversation_subscribers() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/digest-broadcast").await;
        let id = seed_conversation(&db, folder, AgentType::Codex).await;
        let saved = update(&db.conn, id, input()).await.unwrap();
        let broadcaster = std::sync::Arc::new(crate::web::event_bridge::WebEventBroadcaster::new());
        let mut receiver = broadcaster.subscribe();
        let emitter = crate::web::event_bridge::EventEmitter::test_web_only(broadcaster);
        broadcast(&db.conn, &emitter, id).await;
        let event = receiver.try_recv().unwrap();
        assert_eq!(event.channel, DIGEST_EVENT);
        assert_eq!(event.payload["conversationId"], id);
        assert_eq!(event.payload["digest"]["revision"], saved.revision);
    }

    #[tokio::test]
    async fn dismissal_filters_titles_even_when_agent_changes_id() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/digest-dismiss").await;
        let id = seed_conversation(&db, folder, AgentType::Codex).await;
        let saved = update(&db.conn, id, input()).await.unwrap();
        dismiss(&db.conn, id, saved.revision, "Try tests")
            .await
            .unwrap();
        let mut next = input();
        next.suggestions[0].id = "changed".into();
        let saved = update(&db.conn, id, next).await.unwrap();
        assert!(saved.content.suggestions.is_empty());
        assert_eq!(saved.dismissed_suggestions, vec!["Try tests"]);
    }
    #[tokio::test]
    async fn answers_reject_stale_and_duplicate_claims_and_release_failed_sends() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/digest-answer").await;
        let id = seed_conversation(&db, folder, AgentType::Codex).await;
        let saved = update(&db.conn, id, input()).await.unwrap();
        assert!(reserve(&db.conn, id, saved.revision - 1, "q", "A")
            .await
            .is_err());
        let claim = reserve(&db.conn, id, saved.revision, "q", "A")
            .await
            .unwrap();
        let current = read(&db.conn, id).await.unwrap().unwrap();
        assert!(reserve(&db.conn, id, current.revision, "q", "B")
            .await
            .is_err());
        release(&db.conn, id, &claim.token).await.unwrap();
        let current = read(&db.conn, id).await.unwrap().unwrap();
        let claim = reserve(&db.conn, id, current.revision, "q", "B")
            .await
            .unwrap();
        // Failed transport/admission rolls back the transaction, retaining a releasable claim.
        let txn = admit_answer(&db.conn, id, &claim.token, &claim.text)
            .await
            .unwrap();
        txn.rollback().await.unwrap();
        release(&db.conn, id, &claim.token).await.unwrap();
        let current = read(&db.conn, id).await.unwrap().unwrap();
        let claim = reserve(&db.conn, id, current.revision, "q", "A")
            .await
            .unwrap();
        let txn = admit_answer(&db.conn, id, &claim.token, &claim.text)
            .await
            .unwrap();
        txn.commit().await.unwrap();
        assert!(admit_answer(&db.conn, id, &claim.token, &claim.text)
            .await
            .is_err());
    }
    #[tokio::test]
    async fn republishing_a_question_keeps_the_sent_answer_even_if_recommendation_changes() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/digest-repeat").await;
        let id = seed_conversation(&db, folder, AgentType::Codex).await;
        let saved = update(&db.conn, id, input()).await.unwrap();
        let claim = reserve(&db.conn, id, saved.revision, "q", "A")
            .await
            .unwrap();
        admit_answer(&db.conn, id, &claim.token, &claim.text)
            .await
            .unwrap()
            .commit()
            .await
            .unwrap();
        let mut next = input();
        next.needs_you[0].recommended = Some("B".into());
        let saved = update(&db.conn, id, next).await.unwrap();
        assert!(saved.answers["q"].sent);
        assert!(reserve(&db.conn, id, saved.revision, "q", "B")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn changing_question_invalidates_reserved_answer_before_send() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/digest-stale").await;
        let id = seed_conversation(&db, folder, AgentType::Codex).await;
        let saved = update(&db.conn, id, input()).await.unwrap();
        let claim = reserve(&db.conn, id, saved.revision, "q", "A")
            .await
            .unwrap();
        let mut next = input();
        next.needs_you[0].question = "Different question".into();
        update(&db.conn, id, next).await.unwrap();
        assert!(admit_answer(&db.conn, id, &claim.token, &claim.text)
            .await
            .is_err());
    }
}
