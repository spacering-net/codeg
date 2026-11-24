//! What the owner did in codeg on a day of their own calendar: the
//! conversations opened, by agent and by project. One reading for the IM
//! daily report, the IM `/today` command and the assistants'
//! `activity_summary` (plan 6.4, 18 #1).
//!
//! The day is the local one of the machine codeg runs on, midnight to
//! midnight: a window from UTC midnight left out the first hours of a day
//! east of Greenwich (0–8 o'clock in UTC+8) and counted the evening before.
//! The assistants' own sessions are not the owner's activity and are left
//! out; a worktree's conversations count for the project it belongs to.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone, Utc};
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder};

use crate::db::entities::conversation::{self, ConversationKind};
use crate::db::entities::folder::{self, FolderKind};
use crate::db::error::DbError;

/// One local day of the owner's activity.
#[derive(Debug, Clone, PartialEq)]
pub struct DayActivity {
    pub date: NaiveDate,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    /// Conversations opened that day.
    pub total: u32,
    /// By agent type, most first (then by name).
    pub by_agent: Vec<(String, u32)>,
    /// By project (its alias or name), most first; conversations outside any
    /// project (chats) are not in it.
    pub by_project: Vec<(String, u32)>,
    /// Conversations outside any project.
    pub outside_projects: u32,
    /// The titles of the latest, newest first.
    pub titles: Vec<String>,
}

/// Today, on the local calendar.
pub fn local_today() -> NaiveDate {
    Local::now().date_naive()
}

/// A local day as the UTC instants it starts and ends at. A midnight that a
/// clock change skips starts the day at the first instant there is.
pub fn local_day_bounds(day: NaiveDate) -> (DateTime<Utc>, DateTime<Utc>) {
    let start_of = |d: NaiveDate| -> DateTime<Utc> {
        let midnight = d.and_hms_opt(0, 0, 0).expect("midnight exists");
        match Local.from_local_datetime(&midnight) {
            chrono::LocalResult::Single(t) => t.with_timezone(&Utc),
            chrono::LocalResult::Ambiguous(t, _) => t.with_timezone(&Utc),
            chrono::LocalResult::None => Local
                .from_local_datetime(&(midnight + Duration::hours(1)))
                .earliest()
                .map(|t| t.with_timezone(&Utc))
                .unwrap_or_else(|| midnight.and_utc()),
        }
    };
    (start_of(day), start_of(day + Duration::days(1)))
}

/// The owner's activity on local day `day`, with up to `max_titles` titles.
pub async fn day_activity(
    db: &DatabaseConnection,
    day: NaiveDate,
    max_titles: usize,
) -> Result<DayActivity, DbError> {
    let (start, end) = local_day_bounds(day);
    let rows = conversation::Entity::find()
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(conversation::Column::Kind.ne(ConversationKind::Personal))
        .filter(conversation::Column::CreatedAt.gte(start))
        .filter(conversation::Column::CreatedAt.lt(end))
        .order_by_desc(conversation::Column::CreatedAt)
        .all(db)
        .await?;

    let folder_ids: HashSet<i32> = rows.iter().map(|c| c.folder_id).collect();
    let mut folders: HashMap<i32, folder::Model> = HashMap::new();
    if !folder_ids.is_empty() {
        for f in folder::Entity::find()
            .filter(folder::Column::Id.is_in(folder_ids.iter().copied().collect::<Vec<_>>()))
            .all(db)
            .await?
        {
            folders.insert(f.id, f);
        }
        // A worktree counts for its project.
        let parents: Vec<i32> = folders
            .values()
            .filter_map(|f| f.parent_id)
            .filter(|p| !folders.contains_key(p))
            .collect();
        if !parents.is_empty() {
            for f in folder::Entity::find()
                .filter(folder::Column::Id.is_in(parents))
                .all(db)
                .await?
            {
                folders.insert(f.id, f);
            }
        }
    }
    let project_of = |folder_id: i32| -> Option<String> {
        let f = folders.get(&folder_id)?;
        let f = match f.parent_id {
            Some(p) => folders.get(&p).unwrap_or(f),
            None => f,
        };
        (f.kind == FolderKind::Regular).then(|| f.alias.clone().unwrap_or_else(|| f.name.clone()))
    };

    let mut by_agent: HashMap<String, u32> = HashMap::new();
    let mut by_project: HashMap<String, u32> = HashMap::new();
    let mut outside_projects = 0;
    let mut titles = Vec::new();
    for c in &rows {
        *by_agent.entry(c.agent_type.clone()).or_insert(0) += 1;
        match project_of(c.folder_id) {
            Some(p) => *by_project.entry(p).or_insert(0) += 1,
            None => outside_projects += 1,
        }
        if let Some(t) = c.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            if titles.len() < max_titles {
                titles.push(t.to_string());
            }
        }
    }
    let ranked = |m: HashMap<String, u32>| {
        let mut v: Vec<(String, u32)> = m.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        v
    };
    Ok(DayActivity {
        date: day,
        start,
        end,
        total: rows.len() as u32,
        by_agent: ranked(by_agent),
        by_project: ranked(by_project),
        outside_projects,
        titles,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_local_day_is_a_day_long_and_starts_at_local_midnight() {
        let day = NaiveDate::from_ymd_opt(2026, 3, 4).unwrap();
        let (start, end) = local_day_bounds(day);
        assert_eq!(start.with_timezone(&Local).date_naive(), day);
        assert_eq!(
            start.with_timezone(&Local).format("%H:%M").to_string(),
            "00:00"
        );
        assert_eq!(end - start, Duration::days(1));
    }
}
