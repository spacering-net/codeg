//! The activity tab's one list (C1): what "today" has, an assistant's open
//! matters and its routines, merged into four groups — waits on the owner,
//! under way, coming up, done today — each thing once. The command reads
//! what goes in from one snapshot of the database; this puts it together.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::Serialize;

use super::routines::RoutineView;
use super::today::{TodayRow, TodayView};
use crate::db::entities::personal_agent_item::WaitsFor;
use crate::models::personal_agent::{DispatchInfo, ItemInfo};

/// "Today"'s rows that are something else happening on a piece of work, not
/// the work: they stand for no matter.
const STANDS_FOR_NOTHING: [&str; 6] = [
    "answered",
    "pr",
    "pr_merged",
    "routine",
    "routine_run",
    "routine_report",
];

/// The card the latest firing of a matter raised, as it stands (C1).
#[derive(Debug, Clone, Copy)]
pub struct ItemCard {
    pub row_id: i32,
    /// Its notice: what the panel's [Hand to ...] answers.
    pub notice_id: i32,
    /// Open, its notice open: the owner's to act on.
    pub open: bool,
    /// Handed to its assistant.
    pub handed: bool,
}

/// What the list is made of, read from one snapshot.
pub struct Inputs {
    /// The page's assistant (the primary's real id on its page).
    pub bot: i32,
    pub primary: bool,
    pub today: TodayView,
    /// Its open matters, none another's work took over.
    pub items: Vec<ItemInfo>,
    /// The assistant of each matter.
    pub item_bots: HashMap<i32, i32>,
    /// The board task of each matter's dispatch.
    pub item_tasks: HashMap<i32, i32>,
    /// The card of each matter's latest firing, still waiting on it.
    pub item_cards: HashMap<i32, ItemCard>,
    pub routines: Vec<RoutineView>,
    pub as_of: DateTime<Utc>,
}

/// One thing in the list: "today"'s row of it, the matter it stands for,
/// or a routine.
#[derive(Debug, Clone, Serialize)]
pub struct ActivityRow {
    /// The row's own key, unique in the list.
    pub key: String,
    /// The assistant it is of — what its actions go to (another's, on the
    /// primary's page); `None`, the owner's own.
    pub bot_id: Option<i32>,
    /// The thing it is, kept across groups and reads (its matter's or its
    /// work's when it has one): what its unfolding is kept by.
    pub thing: String,
    pub today: Option<TodayRow>,
    pub item: Option<ItemInfo>,
    pub routine: Option<RoutineView>,
    /// The card of a matter's latest firing that has no "today" row (one
    /// from another day): "view the reminder".
    pub card_row_id: Option<i32>,
    /// The matter's reminder card while it is open, the owner's to answer:
    /// what the panel's [Hand to ...] answers.
    pub card_notice_id: Option<i32>,
}

/// The primary's pill (C6): "today"'s count of what waits on the owner, and
/// the first of them in the list.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Pill {
    pub count: usize,
    pub first: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityView {
    pub needs: Vec<ActivityRow>,
    pub watching: Vec<ActivityRow>,
    pub next: Vec<ActivityRow>,
    pub done: Vec<ActivityRow>,
    /// What waits on the owner: the badge and the group's head (C6).
    pub waiting: usize,
    pub pill: Pill,
    /// The morning brief or the wrap-up being prepared (6.4).
    pub brief: Option<super::brief::TodayBrief>,
    /// Acceptance cards on the timeline nothing can be done on any more.
    pub stale_acceptance: Vec<i32>,
    /// The handed-out work its rows point at. Filled by the command.
    pub dispatches: Vec<DispatchInfo>,
    pub day_start: DateTime<Utc>,
    pub day_end: DateTime<Utc>,
    pub as_of: DateTime<Utc>,
}

fn today_row(row: TodayRow) -> ActivityRow {
    let thing = match (row.item_id, row.dispatch_id) {
        (Some(i), _) => format!("item:{i}"),
        (None, Some(d)) => format!("dispatch:{d}"),
        _ => row.key.clone(),
    };
    ActivityRow {
        key: row.key.clone(),
        bot_id: row.bot_id,
        thing,
        today: Some(row),
        item: None,
        routine: None,
        card_row_id: None,
        card_notice_id: None,
    }
}

/// Whether "today"'s `row` stands for matter `item` (B4's table): the same
/// work, the work's board task, the same matter.
fn stands_for(row: &TodayRow, item: &ItemInfo, task: Option<i32>) -> bool {
    if STANDS_FOR_NOTHING.contains(&row.kind) {
        return false;
    }
    if row.item_id == Some(item.id) {
        return true;
    }
    match item.dispatch_id {
        Some(d) if row.dispatch_id == Some(d) => true,
        Some(_) => row.kind == "task" && task.is_some() && row.task_id == task,
        None => false,
    }
}

/// When a row of "coming up" happens: `None`, it has no time.
fn when(row: &ActivityRow) -> Option<DateTime<Utc>> {
    if let Some(r) = &row.routine {
        return r.enabled.then_some(r.next_run_at).flatten();
    }
    if let Some(t) = &row.today {
        return Some(t.at);
    }
    row.item.as_ref().and_then(|i| i.due_at)
}

fn updated(row: &ActivityRow) -> DateTime<Utc> {
    match (&row.item, &row.routine, &row.today) {
        (Some(i), _, _) => i.updated_at,
        (_, Some(r), _) => r.last_run_at.unwrap_or(r.created_at),
        (_, _, Some(t)) => t.at,
        _ => DateTime::<Utc>::MIN_UTC,
    }
}

pub fn merge(inp: Inputs) -> ActivityView {
    let Inputs {
        bot,
        primary,
        today,
        items,
        item_bots,
        item_tasks,
        item_cards,
        routines,
        as_of,
    } = inp;
    // A work assistant's page has its own rows of "today"; the primary's,
    // every assistant's and the owner's own.
    let mine = |r: &TodayRow| primary || r.bot_id == Some(bot);
    // Its own routines are rows of their own, which do more.
    let own_routine = |r: &TodayRow| {
        r.kind == "routine"
            && r.routine_id
                .is_some_and(|id| routines.iter().any(|x| x.id == id))
    };
    let take = |rows: Vec<TodayRow>| -> Vec<ActivityRow> {
        rows.into_iter()
            .filter(|r| mine(r) && !own_routine(r))
            .map(today_row)
            .collect()
    };
    let mut needs = take(today.needs);
    let mut watching = take(today.watching);
    let mut next = take(today.schedule);
    let mut done = take(today.done);
    let pill = Pill {
        count: needs.len(),
        first: needs.first().map(|r| r.key.clone()),
    };

    // Each matter: in the row that stands for it (its assistant's), or a
    // row of its own in its group.
    let mut own_needs = Vec::new();
    let mut own_watching = Vec::new();
    for item in items {
        let task = item.dispatch_id.and_then(|d| item_tasks.get(&d).copied());
        let of = item_bots.get(&item.id).copied().unwrap_or(bot);
        let stands = |r: &ActivityRow| {
            r.item.is_none()
                && r.today
                    .as_ref()
                    .is_some_and(|t| t.bot_id == Some(of) && stands_for(t, &item, task))
        };
        let standing = needs
            .iter_mut()
            .chain(watching.iter_mut())
            .chain(next.iter_mut())
            .find(|r| stands(r));
        let open_card = item_cards
            .get(&item.id)
            .filter(|c| c.open)
            .map(|c| c.notice_id);
        if let Some(row) = standing {
            row.thing = format!("item:{}", item.id);
            row.card_notice_id = open_card;
            row.item = Some(item);
            continue;
        }
        // Work done today whose matter still waits — a pull request on its
        // merge — is under way, not done: its row goes with the matter.
        let finished = done.iter().position(&stands).map(|at| done.remove(at));
        let card = item_cards.get(&item.id).copied();
        // A reminder that fired stands as its card does: open, the owner's;
        // handed, its assistant's. Any other, as it waits — and a card
        // that is neither (closed) is no reminder to view.
        let card = card.filter(|c| {
            (c.open || c.handed)
                && matches!(item.waits_for, Some(WaitsFor::Owner | WaitsFor::Agent))
        });
        let group = match (card, item.waits_for) {
            (Some(c), _) if c.open => 0,
            (Some(_), _) => 1,
            (_, Some(WaitsFor::Owner)) => 0,
            (_, Some(WaitsFor::External | WaitsFor::Agent)) => 1,
            _ => 2,
        };
        let mut row = match finished {
            Some(r) => r,
            None => ActivityRow {
                key: format!("item:{}", item.id),
                bot_id: Some(of),
                thing: String::new(),
                today: None,
                item: None,
                routine: None,
                card_row_id: None,
                card_notice_id: None,
            },
        };
        row.thing = format!("item:{}", item.id);
        row.bot_id = Some(of);
        row.card_row_id = card.map(|c| c.row_id);
        row.card_notice_id = open_card;
        row.item = Some(item);
        match group {
            0 => own_needs.push(row),
            1 => own_watching.push(row),
            _ => next.push(row),
        }
    }
    // After "today"'s, the latest changed first.
    own_needs.sort_by_key(|r| std::cmp::Reverse(updated(r)));
    own_watching.sort_by_key(|r| std::cmp::Reverse(updated(r)));
    needs.extend(own_needs);
    watching.extend(own_watching);

    // Its routines, coming up with the rest.
    next.extend(routines.into_iter().map(|r| ActivityRow {
        key: format!("routine:{}", r.id),
        bot_id: Some(r.bot_id),
        thing: format!("routine:{}", r.id),
        today: None,
        item: None,
        routine: Some(r),
        card_row_id: None,
        card_notice_id: None,
    }));
    // By when it happens; what has no time after, the latest changed
    // first; a paused routine last.
    next.sort_by_key(|r| {
        let paused = r.routine.as_ref().is_some_and(|x| !x.enabled);
        match when(r) {
            Some(t) if !paused => (0u8, t, std::cmp::Reverse(DateTime::<Utc>::MIN_UTC)),
            _ => (
                1 + u8::from(paused),
                DateTime::<Utc>::MIN_UTC,
                std::cmp::Reverse(updated(r)),
            ),
        }
    });

    ActivityView {
        waiting: needs.len(),
        needs,
        watching,
        next,
        done,
        pill,
        brief: today.brief,
        stale_acceptance: today.stale_acceptance,
        dispatches: Vec::new(),
        day_start: today.day_start,
        day_end: today.day_end,
        as_of,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::entities::personal_agent_dispatch::DispatchState;
    use crate::db::entities::personal_agent_item::{ItemKind, ItemStatus};

    fn item(id: i32, waits_for: Option<WaitsFor>, dispatch: Option<i32>) -> ItemInfo {
        let at = Utc::now();
        ItemInfo {
            id,
            kind: ItemKind::Reminder,
            dispatch_id: dispatch,
            status: ItemStatus::Waiting,
            waits_for,
            summary: format!("#{id}"),
            on_done: None,
            origin_timeline_id: None,
            created_at: at,
            updated_at: at,
            dispatch_state: dispatch.map(|_| DispatchState::Completed),
            due_at: None,
            repeat: None,
            at_due: None,
            act_spec: None,
            fired_at: None,
            mention: None,
            closed_at: None,
            closed_by: None,
            closed_how: None,
            answer_row_id: None,
            answer_state: None,
            peer: None,
            written: None,
            direction: None,
        }
    }

    fn inputs(bot: i32, primary: bool, today: TodayView, items: Vec<(ItemInfo, i32)>) -> Inputs {
        Inputs {
            bot,
            primary,
            today,
            item_bots: items.iter().map(|(i, b)| (i.id, *b)).collect(),
            items: items.into_iter().map(|(i, _)| i).collect(),
            item_tasks: HashMap::new(),
            item_cards: HashMap::new(),
            routines: Vec::new(),
            as_of: Utc::now(),
        }
    }

    fn all(v: &ActivityView) -> Vec<&ActivityRow> {
        v.needs
            .iter()
            .chain(&v.watching)
            .chain(&v.next)
            .chain(&v.done)
            .collect()
    }

    /// A pull request delivered today waits on its merge: one row, under
    /// way, with the work's row of it — not also done.
    #[test]
    fn work_done_whose_matter_still_waits_is_under_way_once() {
        let mut today = TodayView::default();
        let mut finished = TodayRow::new("finished:7".into(), "finished", "Fix".into(), Utc::now());
        finished.bot_id = Some(2);
        finished.dispatch_id = Some(7);
        today.done.push(finished);
        let v = merge(inputs(
            2,
            false,
            today,
            vec![(item(1, Some(WaitsFor::External), Some(7)), 2)],
        ));
        assert!(v.done.is_empty(), "{:#?}", v.done);
        assert_eq!(v.watching.len(), 1);
        let row = &v.watching[0];
        assert_eq!(
            (row.key.as_str(), row.thing.as_str()),
            ("finished:7", "item:1")
        );
        assert!(row.item.is_some() && row.today.is_some());
        assert_eq!(all(&v).len(), 1);
    }

    /// The primary's page has every assistant's matters, each folded into
    /// its own assistant's row of "today".
    #[test]
    fn the_primary_page_folds_each_matter_into_its_own_assistants_row() {
        let mut today = TodayView::default();
        let mut row = TodayRow::new("dispatch:9".into(), "dispatch", "Run".into(), Utc::now());
        row.bot_id = Some(5);
        row.dispatch_id = Some(9);
        today.watching.push(row);
        let v = merge(inputs(
            1,
            true,
            today,
            vec![
                (item(3, Some(WaitsFor::External), Some(9)), 5),
                (item(4, Some(WaitsFor::Owner), None), 5),
            ],
        ));
        assert_eq!(v.watching.len(), 1);
        assert_eq!(v.watching[0].thing, "item:3");
        assert_eq!(
            v.needs.len(),
            1,
            "another assistant's matter waiting on the owner"
        );
        assert_eq!(
            v.needs[0].bot_id,
            Some(5),
            "its actions go to its assistant"
        );
        assert_eq!(v.waiting, 1);
    }

    /// A card neither open nor handed (closed) is no reminder to view; the
    /// matter stands as it waits.
    #[test]
    fn a_closed_card_is_not_linked() {
        let mut inp = inputs(
            2,
            false,
            TodayView::default(),
            vec![(item(1, Some(WaitsFor::Owner), None), 2)],
        );
        inp.item_cards.insert(
            1,
            ItemCard {
                row_id: 40,
                notice_id: 41,
                open: false,
                handed: false,
            },
        );
        let v = merge(inp);
        assert_eq!(v.needs.len(), 1);
        assert_eq!(v.needs[0].card_row_id, None);

        let mut inp = inputs(
            2,
            false,
            TodayView::default(),
            vec![(item(1, Some(WaitsFor::Owner), None), 2)],
        );
        inp.item_cards.insert(
            1,
            ItemCard {
                row_id: 40,
                notice_id: 41,
                open: false,
                handed: true,
            },
        );
        let v = merge(inp);
        assert_eq!(
            (v.watching.len(), v.watching[0].card_row_id),
            (1, Some(40)),
            "handed: under way"
        );
        assert_eq!(v.waiting, 0);
    }
}
