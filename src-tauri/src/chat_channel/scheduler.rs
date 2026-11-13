use std::collections::HashSet;

use chrono::{Local, NaiveDate, Timelike, Utc};
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder};
use tokio::task::JoinHandle;

use super::i18n::Lang;
use super::manager::ChatChannelManager;
use super::message_formatter::{self, DailyReportData};
use crate::db::entities::conversation;
use crate::db::service::{
    app_metadata_service, chat_channel_message_log_service, chat_channel_service,
};

const MESSAGE_LANGUAGE_KEY: &str = "chat_message_language";
/// Days to retain message logs before cleanup.
const LOG_RETENTION_DAYS: i64 = 30;

pub fn spawn_daily_report_scheduler(
    manager: ChatChannelManager,
    db_conn: DatabaseConnection,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut sent_today: HashSet<(i32, NaiveDate)> = HashSet::new();
        let mut last_cleanup_date: Option<NaiveDate> = None;

        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(60)).await;

            let now = Local::now();
            let today = now.date_naive();
            let current_time = format!("{:02}:{:02}", now.hour(), now.minute());

            // Clean up old entries from sent_today
            sent_today.retain(|(_, date)| *date == today);

            // Periodic log cleanup: once per day
            if last_cleanup_date != Some(today) {
                last_cleanup_date = Some(today);
                let cutoff = Utc::now() - chrono::Duration::days(LOG_RETENTION_DAYS);
                match chat_channel_message_log_service::cleanup_old_logs(&db_conn, cutoff).await {
                    Ok(n) if n > 0 => {
                        tracing::info!("[ChatChannel] cleaned up {n} old message logs");
                    }
                    Err(e) => {
                        tracing::error!("[ChatChannel] log cleanup failed: {e}");
                    }
                    _ => {}
                }
            }

            let channels = match chat_channel_service::list_enabled(&db_conn).await {
                Ok(c) => c,
                Err(e) => {
                    tracing::error!("[ChatChannel] scheduler: failed to list channels: {e}");
                    continue;
                }
            };

            for ch in &channels {
                if !ch.daily_report_enabled {
                    continue;
                }

                let report_time = ch.daily_report_time.as_deref().unwrap_or("18:00");

                if current_time != report_time {
                    continue;
                }

                let key = (ch.id, today);
                if sent_today.contains(&key) {
                    continue;
                }

                let lang = load_lang(&db_conn).await;

                // Generate and send report
                let report = generate_daily_report(&db_conn).await;
                let message = message_formatter::format_daily_report(&report, lang);

                let send_result = manager.send_to_channel(ch.id, &message).await;
                let (status, error_detail) = match &send_result {
                    Ok(outcome) => (outcome.status_str(), None),
                    Err(e) => ("failed", Some(e.to_string())),
                };

                let _ = chat_channel_message_log_service::create_log(
                    &db_conn,
                    ch.id,
                    "outbound",
                    "daily_report",
                    &message.to_plain_text(),
                    status,
                    error_detail,
                )
                .await;

                sent_today.insert(key);
            }
        }
    })
}

async fn load_lang(db: &DatabaseConnection) -> Lang {
    app_metadata_service::get_value(db, MESSAGE_LANGUAGE_KEY)
        .await
        .ok()
        .flatten()
        .map(|v| Lang::from_str_lossy(&v))
        .unwrap_or_default()
}

async fn generate_daily_report(db: &DatabaseConnection) -> DailyReportData {
    let now = Utc::now();
    let today_start = now.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc();

    let rows = conversation::Entity::find()
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(conversation::Column::CreatedAt.gte(today_start))
        .order_by_desc(conversation::Column::CreatedAt)
        .all(db)
        .await
        .unwrap_or_default();

    let mut by_agent: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut folder_ids: HashSet<i32> = HashSet::new();
    let mut activities: Vec<String> = Vec::new();

    for conv in &rows {
        *by_agent.entry(conv.agent_type.clone()).or_insert(0) += 1;
        folder_ids.insert(conv.folder_id);
        if let Some(title) = &conv.title {
            if activities.len() < 10 {
                activities.push(title.clone());
            }
        }
    }

    // Resolve folder names
    let mut project_names: Vec<String> = Vec::new();
    for fid in &folder_ids {
        if let Ok(Some(folder)) = crate::db::entities::folder::Entity::find_by_id(*fid)
            .one(db)
            .await
        {
            project_names.push(folder.name);
        }
    }

    let conversations_by_agent: Vec<(String, u32)> = by_agent.into_iter().collect();

    DailyReportData {
        date: now.format("%Y-%m-%d").to_string(),
        total_conversations: rows.len() as u32,
        conversations_by_agent,
        projects_involved: project_names,
        key_activities: activities,
    }
}
