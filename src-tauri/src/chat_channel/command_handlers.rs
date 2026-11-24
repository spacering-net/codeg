use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, QuerySelect};

use super::i18n::{self, Lang};
use super::manager::ChatChannelManager;
use super::types::{MessageLevel, RichMessage};
use crate::db::entities::conversation;

pub async fn handle_search(db: &DatabaseConnection, keyword: &str, lang: Lang) -> RichMessage {
    let matched = match conversation::Entity::find()
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(conversation::Column::Title.contains(keyword))
        .order_by_desc(conversation::Column::CreatedAt)
        .limit(10)
        .all(db)
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            return RichMessage {
                title: Some(i18n::query_failed_title(lang).to_string()),
                body: e.to_string(),
                fields: Vec::new(),
                level: MessageLevel::Error,
            };
        }
    };

    if matched.is_empty() {
        return RichMessage::info(i18n::search_no_results(lang, keyword))
            .with_title(i18n::search_results_title(lang));
    }

    let mut body = String::new();
    for conv in &matched {
        let title = conv.title.as_deref().unwrap_or(i18n::untitled(lang));
        let agent = &conv.agent_type;
        let time = conv.created_at.format("%m-%d %H:%M");
        body.push_str(&format!("#{} [{}] {} ({})\n", conv.id, agent, title, time,));
    }

    RichMessage::info(body.trim_end()).with_title(i18n::search_results_count_title(
        lang,
        keyword,
        matched.len(),
    ))
}

pub async fn handle_today(db: &DatabaseConnection, lang: Lang) -> RichMessage {
    // The local day (18 #1), as the daily report counts it.
    let day = crate::db::service::day_activity_service::local_today();
    let activity = match crate::db::service::day_activity_service::day_activity(db, day, 5).await {
        Ok(a) => a,
        Err(e) => {
            return RichMessage {
                title: Some(i18n::query_failed_title(lang).to_string()),
                body: e.to_string(),
                fields: Vec::new(),
                level: MessageLevel::Error,
            };
        }
    };

    if activity.total == 0 {
        return RichMessage::info(i18n::no_activity_today(lang))
            .with_title(i18n::today_activity_title(lang));
    }

    let mut body = i18n::total_sessions(lang, activity.total);
    body.push_str(&format!("\n\n{}", i18n::by_agent_label(lang)));
    for (agent, count) in &activity.by_agent {
        body.push_str(&format!("\n  {}", i18n::agent_count(lang, agent, *count)));
    }

    if !activity.titles.is_empty() {
        body.push_str(&format!("\n\n{}", i18n::recent_activity_label(lang)));
        for t in &activity.titles {
            body.push_str(&format!("\n  • {t}"));
        }
    }

    RichMessage::info(body).with_title(i18n::today_activity_date_title(
        lang,
        &activity.date.format("%Y-%m-%d").to_string(),
    ))
}

pub async fn handle_status(manager: &ChatChannelManager, lang: Lang) -> RichMessage {
    let statuses = manager.get_status().await;
    if statuses.is_empty() {
        return RichMessage::info(i18n::no_active_channels(lang))
            .with_title(i18n::channel_status_title(lang));
    }

    let mut body = String::new();
    for s in &statuses {
        let icon = match s.status.as_str() {
            "connected" => "●",
            "connecting" => "◎",
            "error" => "✗",
            _ => "○",
        };
        body.push_str(&format!(
            "{} {} [{}] - {}\n",
            icon, s.name, s.channel_type, s.status
        ));
    }

    RichMessage::info(body.trim_end()).with_title(i18n::channel_status_title(lang))
}

pub fn handle_help(prefix: &str, lang: Lang) -> RichMessage {
    RichMessage::info(i18n::help_body(lang, prefix)).with_title(i18n::help_title(lang))
}
