use std::collections::HashSet;

use chrono::{Local, NaiveDate, Timelike, Utc};
use sea_orm::DatabaseConnection;
use tokio::task::JoinHandle;

use super::i18n::Lang;
use super::manager::ChatChannelManager;
use super::message_formatter::{self, DailyReportData};
use crate::db::service::{
    app_metadata_service, chat_channel_message_log_service, chat_channel_service,
    day_activity_service,
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
                    Ok(_) => ("sent", None),
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
    // The local day the report is sent on (18 #1): it fires on the local
    // clock, so it counts the local day too.
    let day = day_activity_service::local_today();
    let activity = day_activity_service::day_activity(db, day, 10).await;
    let activity = activity.unwrap_or_else(|_| day_activity_service::DayActivity {
        date: day,
        start: Utc::now(),
        end: Utc::now(),
        total: 0,
        by_agent: Vec::new(),
        by_project: Vec::new(),
        outside_projects: 0,
        titles: Vec::new(),
    });
    DailyReportData {
        date: activity.date.format("%Y-%m-%d").to_string(),
        total_conversations: activity.total,
        conversations_by_agent: activity.by_agent,
        projects_involved: activity.by_project.into_iter().map(|(name, _)| name).collect(),
        key_activities: activity.titles,
    }
}
