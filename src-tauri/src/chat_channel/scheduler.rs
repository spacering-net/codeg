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

            let owns_board = crate::work_task::engine().is_some();
            for ch in reports_due(&channels, &current_time, today, &sent_today, owns_board) {
                let key = (ch.id, today);
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

/// The channels whose daily report is due at `now` (`HH:MM`): reports on,
/// at their time, not yet sent `today`. Only the process holding this data
/// directory's board lock sends them, so two processes sharing it send each
/// report once (18 #7).
fn reports_due<'a>(
    channels: &'a [crate::db::entities::chat_channel::Model],
    now: &str,
    today: NaiveDate,
    sent_today: &HashSet<(i32, NaiveDate)>,
    owns_board: bool,
) -> Vec<&'a crate::db::entities::chat_channel::Model> {
    if !owns_board {
        return Vec::new();
    }
    channels
        .iter()
        .filter(|ch| ch.daily_report_enabled)
        .filter(|ch| ch.daily_report_time.as_deref().unwrap_or("18:00") == now)
        .filter(|ch| !sent_today.contains(&(ch.id, today)))
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn channel(id: i32, on: bool, time: Option<&str>) -> crate::db::entities::chat_channel::Model {
        crate::db::entities::chat_channel::Model {
            id,
            name: format!("ch{id}"),
            channel_type: "telegram".into(),
            enabled: true,
            config_json: "{}".into(),
            event_filter_json: None,
            daily_report_enabled: on,
            daily_report_time: time.map(str::to_string),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    /// Two processes on one data directory: only the one holding the board
    /// lock sends the daily report (18 #7); it sends each channel's once, at
    /// its time.
    #[test]
    fn only_the_board_lock_holder_sends_the_daily_report_once() {
        let today = NaiveDate::from_ymd_opt(2026, 11, 11).unwrap();
        let channels = [
            channel(1, true, Some("09:30")),
            channel(2, true, None),
            channel(3, false, Some("09:30")),
        ];
        let none = HashSet::new();
        let ids = |due: Vec<&crate::db::entities::chat_channel::Model>| {
            due.into_iter().map(|c| c.id).collect::<Vec<_>>()
        };
        assert_eq!(
            ids(reports_due(&channels, "09:30", today, &none, true)),
            vec![1]
        );
        assert_eq!(
            ids(reports_due(&channels, "18:00", today, &none, true)),
            vec![2]
        );
        assert!(
            reports_due(&channels, "09:30", today, &none, false).is_empty(),
            "the other process sends nothing"
        );
        let sent = HashSet::from([(1, today)]);
        assert!(reports_due(&channels, "09:30", today, &sent, true).is_empty());
    }
}
