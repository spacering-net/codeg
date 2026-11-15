//! What an assistant does on a forge (7.4): `forge_comment`, `issue_close`,
//! `pr_merge`.
//!
//! - **One target, named once.** An action's item — platform, host,
//!   repository, account, number — is resolved when it is first named: the
//!   coordinates a board task recorded when it delivered (or the issue it
//!   came from), else a project's `origin` and account as they are then. The
//!   ledger entry, the card and every later step (an approval, doing it
//!   again, looking whether it took) use that record; nothing re-derives a
//!   folder's remote.
//! - **Done at once by default**, each with a card on the timeline: what was
//!   done, where, the full text, the link. With the owner's "ask me first"
//!   for it (or `suggest`), an approval card comes first. It never expires;
//!   approving it checks its premises again (the head it would merge, its
//!   checks) and, changed, does nothing and says so.
//! - **Through the ledger.** Written `prepared` under its operation id before
//!   anything goes out, marked attempted right before the request. The
//!   forge's answer commits it; a clear refusal is `not_executed`; a timeout,
//!   a dropped connection or a server error is `unknown` — never redone on
//!   its own. A comment carries its operation id in an invisible marker, so
//!   whether it was posted can be read back; a close and a merge read the
//!   item's state. That look runs at start-up for what was cut off, once
//!   shortly after an unknown answer, and first whenever the owner has it
//!   done again: found, it is not done twice.
//! - **A merge merges the version it should** (7.5 "the merged version"):
//!   while acceptance is on, the head of a pull request an assistant's code
//!   task delivered must be the one its acceptance passed and codeg pushed;
//!   otherwise the head whose checks were read green. The head goes to the
//!   forge with the merge, which refuses once it moved — on GitHub, GitLab
//!   and Gitea. CNB takes no head and shows no checks: a merge there is
//!   always the owner's approval, and recorded as not guaranteed.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::engine::{text_digest, PersonalAgentEngine};
use super::ledger::{self, OpOutcome};
use super::tools::ToolOutcome;
use crate::db::entities::personal_agent_action::{self as action_entity, ActionState};
use crate::db::entities::personal_agent_notice::{
    self as notice_entity, NoticeKind, NoticeLevel, NoticeState,
};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::entities::personal_agent_verification::VerificationState;
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{LedgerSlot, Ledgered, NewNotice, NewOp, NewRow};
use crate::db::service::personal_agent_verification_service as vsvc;
use crate::forge::{
    DeliveryTarget, ForgeCheckState, ForgeError, ForgeItemKind, ForgeMergeMethod, ForgeProvider,
};
use crate::models::personal_agent::{PersonalAgentChange, TimelineRow};
use crate::models::personal_agent_prefs::{AskFirst, Prefs};

/// The longest one forge request of an action may take.
const FORGE_ACT_SECS: u64 = 30;
/// How long after an unknown answer codeg looks on the forge.
const RECHECK_AFTER_SECS: u64 = 30;
/// The longest comment an assistant posts. The forge's thread is read back
/// cut at 16 000 characters, and the marker at the end must be in it.
pub const MAX_FORGE_COMMENT_CHARS: usize = 15_000;
/// Pages of a thread read looking for a comment's marker.
const MARKER_PAGES: u32 = 30;
const MARKER_PAGE_SIZE: u32 = 100;

/// What an assistant does on a forge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForgeAction {
    Comment,
    Close,
    Merge,
}

impl ForgeAction {
    pub fn tool(self) -> &'static str {
        match self {
            ForgeAction::Comment => "forge_comment",
            ForgeAction::Close => "issue_close",
            ForgeAction::Merge => "pr_merge",
        }
    }

    fn verb(self) -> &'static str {
        match self {
            ForgeAction::Comment => "comment",
            ForgeAction::Close => "close",
            ForgeAction::Merge => "merge",
        }
    }

    /// Whether the owner asked to approve it first.
    fn asks_first(self, prefs: &Prefs) -> bool {
        let item = match self {
            ForgeAction::Comment => prefs.forge_comment,
            ForgeAction::Close => prefs.issue_close,
            ForgeAction::Merge => prefs.pr_merge,
        };
        item == AskFirst::Ask
    }
}

/// Where an action goes, resolved once and then used as recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgeTarget {
    #[serde(flatten)]
    pub repo: DeliveryTarget,
    /// `issue` or `pr`.
    pub kind: String,
    pub number: i64,
    /// The board task whose item it is, when it is one's.
    #[serde(default)]
    pub task_id: Option<i32>,
    /// Shown on the card: the item's page and the account acting.
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub account_name: Option<String>,
}

impl ForgeTarget {
    fn item_kind(&self) -> ForgeItemKind {
        if self.kind == "issue" {
            ForgeItemKind::Issue
        } else {
            ForgeItemKind::Change
        }
    }

    /// `owner/repo#12` — `!12` for a GitLab merge request.
    pub fn label(&self) -> String {
        let sigil = if self.repo.provider == ForgeProvider::GitLab && self.kind == "pr" {
            "!"
        } else {
            "#"
        };
        format!("{}{sigil}{}", self.repo.owner_repo, self.number)
    }

    fn display(&self) -> Value {
        json!({
            "provider": self.repo.provider.display_name(),
            "host": self.repo.server_host,
            "repo": self.repo.owner_repo,
            "kind": self.kind,
            "number": self.number,
            "url": self.url,
            "account": self.account_name,
            "task_id": self.task_id,
        })
    }
}

/// One action as its card and its ledger entry keep it: run as it stands.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForgeCall {
    pub action: ForgeAction,
    pub target: ForgeTarget,
    /// A comment's text, as the assistant wrote it.
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub method: Option<ForgeMergeMethod>,
    /// A merge: the head commit it merges, what vouches for that version
    /// (`accepted` or `green`), the acceptance round, the checks as read
    /// (`green`, `none`, `unknown`), and whether the forge holds the head.
    /// A comment on a pull request put to the owner first: the head it was
    /// at when its card went up.
    #[serde(default)]
    pub head: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub round_id: Option<i32>,
    #[serde(default)]
    pub checks: Option<String>,
    #[serde(default)]
    pub guaranteed: bool,
    #[serde(default)]
    pub reason: Option<String>,
    /// `direct`; `confirm` (the owner asked to approve it first);
    /// `suggest` (the assistant only thinks it fits); `cnb` (a merge there).
    #[serde(default)]
    pub why: String,
    /// codeg's own, on a pull request it watches (7.4, phase 3): no
    /// assistant called for it.
    #[serde(default)]
    pub auto: bool,
}

impl ForgeCall {
    /// "a comment on owner/repo#12" — for the assistant and the card.
    fn what(&self) -> String {
        match self.action {
            ForgeAction::Comment => format!("a comment on {}", self.target.label()),
            ForgeAction::Close => format!("closing {}", self.target.label()),
            ForgeAction::Merge => format!(
                "merging {}{}",
                self.target.label(),
                self.head
                    .as_deref()
                    .map(|h| format!(" at {}", short(h)))
                    .unwrap_or_default()
            ),
        }
    }
}

/// The ledger key of a call: the action, how it names its item, and a
/// comment's text — not what the item resolves to now. So a turn delivered
/// again finds its first run even when the project's `origin` or default
/// account changed in between; the target that run resolved is on its
/// entry. A merge's head is not in it: one merged pull request is never
/// merged again.
fn call_key(action: ForgeAction, args: &Value) -> String {
    let named = ["dispatch_id", "task_id", "project_id", "number"]
        .iter()
        .map(|k| int_arg(args, k).map(|n| n.to_string()).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("|");
    let kind = args
        .get("kind")
        .and_then(|k| k.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let extra = match action {
        ForgeAction::Comment => text_digest(&normalize_body(
            args.get("body").and_then(|b| b.as_str()).unwrap_or(""),
        )),
        _ => String::new(),
    };
    format!("forge|{}|{named}|{kind}|{extra}", action.verb())
}

fn normalize_body(body: &str) -> String {
    body.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn short(sha: &str) -> &str {
    sha.get(..10).unwrap_or(sha)
}

/// The marker a comment carries, so it can be found again.
fn marker(op_id: &str) -> String {
    format!("<!-- codeg-op:{op_id} -->")
}

/// `owner/repo#12` — `!12` for a GitLab merge request.
pub fn label_of(repo: &DeliveryTarget, kind: &str, number: i64) -> String {
    let sigil = if repo.provider == ForgeProvider::GitLab && kind == "pr" {
        "!"
    } else {
        "#"
    };
    format!("{}{sigil}{number}", repo.owner_repo)
}

/// What a watch's merge (7.4, phase 3) came to.
#[derive(Debug, Clone)]
pub(super) enum WatchMerge {
    /// Merged (or being, or in doubt), on its card; with why when the forge
    /// refused it.
    Merging(i32, Option<String>),
    /// On an approval card for the owner.
    Asked(i32),
    /// The merged-version rules said no, and why: the owner is told it is
    /// ready to merge, and why codeg did not.
    Refused(String),
    /// The forge could not be read to plan it.
    Unread(String),
    /// Its head moved since the read, or its card is up already: the next
    /// read decides.
    Not,
}

/// What running an action came to.
#[derive(Debug, Clone)]
enum Exec {
    Done(Value),
    /// The forge refused it, or it never went out.
    Refused(String),
    Unknown(String),
    /// Settled by someone else meanwhile.
    Settled,
}

/// Why a merge is not made.
#[derive(Debug, Clone)]
enum MergeNo {
    /// The pull request could not be read: nothing to show for it.
    Read(String),
    /// A rule of the merged version (or its state) says no.
    Rule { code: &'static str, why: String },
}

/// A merge as planned: the head it merges and what vouches for it.
#[derive(Debug, Clone)]
struct MergePlan {
    head: String,
    version: &'static str,
    round_id: Option<i32>,
    checks: &'static str,
    guaranteed: bool,
    method: ForgeMergeMethod,
}

fn text_arg(args: &Value, key: &str, cap: usize) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(cap).collect())
}

fn int_arg(args: &Value, key: &str) -> Option<i64> {
    args.get(key).and_then(|v| {
        v.as_i64().or_else(|| {
            v.as_str()?
                .trim()
                .trim_start_matches(['#', '!'])
                .parse()
                .ok()
        })
    })
}

/// How the forge's error reads: a refusal, or a request whose fate is not
/// known.
fn exec_of_error(e: &ForgeError) -> Exec {
    match e {
        ForgeError::Network(_) => Exec::Unknown(e.to_string()),
        ForgeError::Api { status, .. } if *status >= 500 => Exec::Unknown(e.to_string()),
        _ => Exec::Refused(e.to_string()),
    }
}

impl PersonalAgentEngine {
    // ── the tools ───────────────────────────────────────────────────────────

    /// `forge_comment`, `issue_close`, `pr_merge`.
    pub(super) async fn forge_act_call(
        self: &Arc<Self>,
        action: ForgeAction,
        args: &Value,
    ) -> ToolOutcome {
        let suggest = args
            .get("suggest")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let reason = text_arg(args, "reason", 1_000);
        if suggest && reason.is_none() {
            return ToolOutcome::refused("a suggestion needs `reason`: why you think it fits");
        }
        // The owner does not take suggestions now (6.7).
        if suggest {
            if let Some(no) = self.suggestions_closed().await {
                return no;
            }
        }
        let key = call_key(action, args);
        let subject = format!("forge:{key}");
        let ledger = self.ledger_batch().await;
        // The turn this delivery repeats did it, or put it on a card.
        if let Some((_, scope)) = &ledger {
            if let Ok(Some(card)) = svc::notice_by_subject(
                &self.db.conn,
                self.bot().await,
                NoticeKind::Forge,
                &subject,
                scope,
            )
            .await
            {
                let open = card.state == NoticeState::Open;
                return ToolOutcome::ok(
                    format!(
                        "Already on card #{}: the turn this delivery repeats made this same call{}.",
                        card.id,
                        if open { " and it waits for the owner" } else { "" }
                    ),
                    json!({ "notice_id": card.id, "earlier": true }),
                );
            }
            match svc::ledger_entries(&self.db.conn, scope, &key).await {
                Ok(entries) => {
                    if let Some(e) = entries.last() {
                        // What it was, as its first run recorded it.
                        let what = ledger::parse::<ForgeCall>(e.payload.as_deref())
                            .map(|c| c.what())
                            .unwrap_or_else(|| format!("this {}", action.tool()));
                        match e.state {
                            ActionState::Committed => {
                                return ToolOutcome::ok(
                                    format!(
                                        "Already done: the turn this delivery repeats did {}.",
                                        what
                                    ),
                                    json!({ "earlier": true, "result": e.ref_id }),
                                )
                            }
                            ActionState::Prepared => {
                                return ToolOutcome::ok(
                                    format!(
                                    "Already under way: the turn this delivery repeats started {}.",
                                    what
                                ),
                                    json!({ "earlier": true }),
                                )
                            }
                            ActionState::Unknown => {
                                return ToolOutcome::ok(
                                    format!(
                                        "codeg cannot tell whether {} from the turn this delivery \
                                         repeats went through; the owner has a card for it. Do not \
                                         do it again meanwhile.",
                                        what
                                    ),
                                    json!({ "earlier": true, "state": "unknown" }),
                                )
                            }
                            ActionState::NotExecuted | ActionState::Failed => {}
                        }
                    }
                }
                Err(e) => return ToolOutcome::refused(e.to_string()),
            }
        }
        let mut target = match self.forge_target(action, args).await {
            Ok(t) => t,
            Err(e) => return ToolOutcome::refused(e),
        };
        // Who it goes out as, for the card: the account recorded (a local
        // read, no request).
        if target.account_name.is_none() {
            if let Ok(auth) = crate::commands::forge::auth_at(&self.db, &target.repo).await {
                target.account_name = Some(auth.username.clone());
                if target.url.is_none() {
                    target.url = Some(target.repo.provider.item_url(
                        &crate::forge::web_origin(&auth),
                        &target.repo.owner_repo,
                        target.item_kind(),
                        target.number,
                    ));
                }
            }
        }
        let mut call = ForgeCall {
            action,
            target,
            body: None,
            method: None,
            head: None,
            version: None,
            round_id: None,
            checks: None,
            guaranteed: false,
            reason,
            why: String::new(),
            auto: false,
        };
        match action {
            ForgeAction::Comment => {
                let Some(body) = args
                    .get("body")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                else {
                    return ToolOutcome::refused("`body` is required: the comment, in Markdown");
                };
                if body.chars().count() > MAX_FORGE_COMMENT_CHARS {
                    return ToolOutcome::refused(format!(
                        "the comment is longer than {MAX_FORGE_COMMENT_CHARS} characters"
                    ));
                }
                call.body = Some(body.to_string());
            }
            ForgeAction::Close => {
                if call.target.kind != "issue" {
                    return ToolOutcome::refused(format!(
                        "{} is a pull request: issue_close closes issues",
                        call.target.label()
                    ));
                }
            }
            ForgeAction::Merge => {
                if call.target.kind != "pr" {
                    return ToolOutcome::refused(format!(
                        "{} is an issue: pr_merge merges pull requests",
                        call.target.label()
                    ));
                }
                if let Some(m) = args.get("method").and_then(|v| v.as_str()) {
                    match serde_json::from_value::<ForgeMergeMethod>(json!(m.trim().to_lowercase()))
                    {
                        Ok(m) => call.method = Some(m),
                        Err(_) => {
                            return ToolOutcome::refused("`method` is merge, squash or rebase");
                        }
                    }
                }
            }
        }
        let batch = ledger.as_ref().map(|(b, _)| *b);
        if action == ForgeAction::Merge {
            match self.plan_merge(&call.target, call.method).await {
                Ok(plan) => call.adopt(&plan),
                Err(MergeNo::Read(e)) => return ToolOutcome::refused(e),
                Err(MergeNo::Rule { code, why }) => {
                    let card = self
                        .raise_forge_card(
                            &call,
                            "refused",
                            batch,
                            None,
                            json!({ "code": code, "error": why }),
                        )
                        .await
                        .ok();
                    return ToolOutcome::refused(format!(
                        "Not merged: {why}.{}",
                        card.map(|c| format!(" Card #{c} says so."))
                            .unwrap_or_default()
                    ));
                }
            }
        }
        let prefs = self.prefs().await;
        let cnb_merge =
            action == ForgeAction::Merge && call.target.repo.provider == ForgeProvider::Cnb;
        call.why = if suggest {
            "suggest"
        } else if cnb_merge {
            "cnb"
        } else if action.asks_first(&prefs) {
            "confirm"
        } else {
            "direct"
        }
        .into();
        if call.why != "direct" {
            // A comment on a pull request is about the head it is at now:
            // one approved after it moved on is not posted. Unread, it is
            // posted as approved.
            if action == ForgeAction::Comment {
                call.head = Box::pin(self.pr_head_now(&call.target))
                    .await
                    .ok()
                    .flatten();
            }
            return match self
                .raise_forge_card(&call, "open", batch, Some(subject), Value::Null)
                .await
            {
                Ok(id) => ToolOutcome::ok(
                    match call.why.as_str() {
                        "suggest" => format!(
                            "Suggested on card #{id}: {}. It is done only if the owner approves; you \
                             will hear how they answered.",
                            call.what()
                        ),
                        "cnb" => format!(
                            "On card #{id} for the owner to approve: {}. CNB shows no checks and \
                             takes no head with a merge, so a merge there is always theirs to approve. \
                             You will hear how they answered.",
                            call.what()
                        ),
                        _ => format!(
                            "Waiting for the owner: they asked to approve such actions first, so {} \
                             is on card #{id} exactly as you wrote it, and runs once they approve. You \
                             will hear how they answered; do not do it again meanwhile.",
                            call.what()
                        ),
                    },
                    json!({ "notice_id": id, "state": "awaiting_owner" }),
                ),
                Err(e) => ToolOutcome::refused(e),
            };
        }
        // Done now, with a card that follows it.
        let notice_id = match self
            .raise_forge_card(&call, "acting", batch, None, Value::Null)
            .await
        {
            Ok(id) => id,
            Err(e) => return ToolOutcome::refused(e),
        };
        let slot = match batch {
            Some(b) => LedgerSlot::in_batch(b, key, ledger::fresh_op_id()),
            None => LedgerSlot::outside(ledger::fresh_op_id()),
        };
        let (state, text) = self.run_forge(&call, slot, notice_id).await;
        let data = json!({ "notice_id": notice_id, "state": state });
        match state {
            "done" => ToolOutcome::ok(text, data),
            "unknown" => ToolOutcome::ok(text, data),
            _ => ToolOutcome::refused(text),
        }
    }

    /// The item an action names: a board task's (`dispatch_id`, `task_id`),
    /// or a project's (`project_id` and `number`, with `kind` for a
    /// comment).
    async fn forge_target(&self, action: ForgeAction, args: &Value) -> Result<ForgeTarget, String> {
        let want_kind = match action {
            ForgeAction::Close => Some("issue"),
            ForgeAction::Merge => Some("pr"),
            ForgeAction::Comment => None,
        };
        let task = if let Some(id) = int_arg(args, "dispatch_id") {
            let id = i32::try_from(id).map_err(|_| "no such dispatch".to_string())?;
            let d = svc::get_dispatch(&self.db.conn, id)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("no dispatch #{id}"))?;
            let t = d
                .work_task_id
                .ok_or_else(|| format!("dispatch #{id} is not a board task: name the item with `project_id` and `number`"))?;
            Some(t)
        } else if let Some(id) = int_arg(args, "task_id") {
            Some(i32::try_from(id).map_err(|_| "no such board task".to_string())?)
        } else {
            None
        };
        if let Some(task_id) = task {
            let t = crate::db::service::work_task_service::get_model(&self.db.conn, task_id)
                .await
                .map_err(|_| format!("no board task #{task_id}"))?;
            return self.task_target(
                &t,
                want_kind.or_else(|| {
                    args.get("kind").and_then(|k| k.as_str()).map(|k| {
                        if k == "issue" {
                            "issue"
                        } else {
                            "pr"
                        }
                    })
                }),
            );
        }
        let (Some(project), Some(number)) = (int_arg(args, "project_id"), int_arg(args, "number"))
        else {
            return Err(
                "name the item: `dispatch_id` or `task_id` of the work it belongs to, or `project_id` and `number`"
                    .into(),
            );
        };
        let project = i32::try_from(project).map_err(|_| "no such project".to_string())?;
        if number <= 0 {
            return Err(format!("bad number: {number}"));
        }
        let kind = match want_kind {
            Some(k) => k,
            None => match args.get("kind").and_then(|k| k.as_str()).map(str::trim) {
                Some("issue") => "issue",
                Some("pr") => "pr",
                _ => return Err("`kind` is required with `project_id`: issue or pr".into()),
            },
        };
        // Resolved once, the first time it is named in this project (the
        // project's `origin` and account then), and the same item after.
        let w = self.named_item(project, kind, number).await?;
        let repo = crate::db::service::personal_agent_watch_service::target_of(&w)
            .ok_or("the item names no forge codeg knows")?;
        let task_id = match (kind, w.work_task_id) {
            ("pr", Some(t)) => Some(t),
            ("pr", None) => self.task_of_pr(&repo, number).await.map(|t| t.id),
            _ => None,
        };
        let account_name = crate::commands::forge::auth_at(&self.db, &repo)
            .await
            .ok()
            .map(|a| a.username);
        Ok(ForgeTarget {
            repo,
            kind: kind.into(),
            number,
            task_id,
            url: w.url.clone(),
            account_name,
        })
    }

    /// A board task's item: the pull request its latest delivery reached
    /// (or the one it works on), or the issue it came from.
    fn task_target(
        &self,
        t: &crate::db::entities::work_task::Model,
        kind: Option<&str>,
    ) -> Result<ForgeTarget, String> {
        let meta = t
            .source_meta
            .as_deref()
            .and_then(|raw| serde_json::from_str::<crate::forge::ForgeSourceMeta>(raw).ok());
        if kind == Some("issue") {
            let meta = meta
                .filter(|_| t.source_kind.as_deref() == Some(crate::forge::SOURCE_KIND_ISSUE))
                .ok_or_else(|| format!("board task #{} did not come from an issue", t.id))?;
            return Ok(ForgeTarget {
                repo: DeliveryTarget {
                    provider: meta.provider,
                    server_host: meta.server_host,
                    account_id: meta.account_id,
                    owner_repo: meta.owner_repo,
                },
                kind: "issue".into(),
                number: meta.number,
                task_id: Some(t.id),
                url: Some(meta.url).filter(|u| !u.is_empty()),
                account_name: None,
            });
        }
        let (repo, number) = super::ladder::pr_target(t)
            .ok_or_else(|| format!("board task #{} has no pull request on record", t.id))?;
        let (url, _) = super::ladder::pr_of(t);
        Ok(ForgeTarget {
            repo,
            kind: "pr".into(),
            number,
            task_id: Some(t.id),
            url,
            account_name: None,
        })
    }

    /// The board task whose delivery reached this pull request.
    async fn task_of_pr(
        &self,
        repo: &DeliveryTarget,
        number: i64,
    ) -> Option<crate::db::entities::work_task::Model> {
        use crate::db::entities::work_task;
        use sea_orm::{ColumnTrait, Condition, EntityTrait, QueryFilter, QueryOrder};
        // Delivered with no provenance (its `delivery`), or a forge task's
        // (its source), the latest first: a task on a pull request that
        // pushed to it is the pull request's now (7.4).
        let rows = work_task::Entity::find()
            .filter(
                Condition::any()
                    .add(work_task::Column::Delivery.is_not_null())
                    .add(work_task::Column::SourceMeta.is_not_null()),
            )
            .filter(work_task::Column::DeletedAt.is_null())
            .order_by_desc(work_task::Column::Id)
            .all(&self.db.conn)
            .await
            .ok()?;
        rows.into_iter().find(|t| {
            // Pushed there: a task on the pull request that has not pushed
            // yet is not what the pull request carries.
            let pushed = t.delivery.is_some()
                || t.source_meta
                    .as_deref()
                    .and_then(|m| serde_json::from_str::<crate::forge::ForgeSourceMeta>(m).ok())
                    .is_some_and(|m| m.result_pr_number.is_some());
            pushed
                && super::ladder::pr_target(t).is_some_and(|(r, n)| {
                n == number
                    && r.provider == repo.provider
                    && r.server_host.eq_ignore_ascii_case(&repo.server_host)
                    && crate::forge::same_repo(&r.owner_repo, &repo.owner_repo)
            })
        })
    }

    /// The head pull request `target` is at now; `None` for an issue, or
    /// when the forge does not say.
    async fn pr_head_now(&self, target: &ForgeTarget) -> Result<Option<String>, String> {
        if target.kind != "pr" {
            return Ok(None);
        }
        let read = tokio::time::timeout(
            std::time::Duration::from_secs(FORGE_ACT_SECS),
            crate::commands::forge::change_detail_at(&self.db, &target.repo, target.number),
        )
        .await;
        match read {
            Err(_) => Err(format!(
                "the forge did not answer within {FORGE_ACT_SECS} s"
            )),
            Ok(Err(e)) => Err(format!("could not read {}: {e}", target.label())),
            Ok(Ok(d)) => Ok(d
                .head_sha
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty())),
        }
    }

    // ── a merge ─────────────────────────────────────────────────────────────

    /// The head a merge of `target` is to merge, or why it is not merged.
    async fn plan_merge(
        &self,
        target: &ForgeTarget,
        method: Option<ForgeMergeMethod>,
    ) -> Result<MergePlan, MergeNo> {
        let read = tokio::time::timeout(
            std::time::Duration::from_secs(FORGE_ACT_SECS),
            crate::commands::forge::change_detail_at(&self.db, &target.repo, target.number),
        )
        .await;
        let detail = match read {
            Err(_) => {
                return Err(MergeNo::Read(format!(
                    "the forge did not answer within {FORGE_ACT_SECS} s"
                )))
            }
            Ok(Err(e)) => {
                return Err(MergeNo::Read(format!(
                    "could not read {}: {e}",
                    target.label()
                )))
            }
            Ok(Ok(d)) => d,
        };
        match detail.state.as_str() {
            "merged" => {
                return Err(MergeNo::Rule {
                    code: "merged",
                    why: format!("{} is merged already", target.label()),
                })
            }
            "closed" => {
                return Err(MergeNo::Rule {
                    code: "closed",
                    why: format!("{} is closed", target.label()),
                })
            }
            _ => {}
        }
        if detail.draft {
            return Err(MergeNo::Rule {
                code: "draft",
                why: format!("{} is a draft", target.label()),
            });
        }
        let head = detail
            .head_sha
            .clone()
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty())
            .ok_or_else(|| {
                MergeNo::Read("the forge did not say the pull request's head commit".into())
            })?;
        // The version: the one its acceptance passed and codeg delivered.
        let mut version = "green";
        let mut round_id = None;
        let task = match target.task_id {
            Some(id) => crate::db::service::work_task_service::get_model(&self.db.conn, id)
                .await
                .ok(),
            None => self.task_of_pr(&target.repo, target.number).await,
        };
        if let Some(task) = task {
            let d = match task.personal_agent_dispatch_id {
                Some(id) => svc::get_dispatch(&self.db.conn, id).await.ok().flatten(),
                None => None,
            };
            let prefs = self.prefs().await;
            if let Some(d) = d.filter(|d| super::acceptance::wants_acceptance(d, &task, &prefs)) {
                let rounds = vsvc::rounds_of(&self.db.conn, d.id)
                    .await
                    .unwrap_or_default();
                match rounds.iter().rev().find(|r| r.state.counts()) {
                    Some(r) if r.state == VerificationState::Accepted => match r
                        .delivered_head
                        .as_deref()
                    {
                        Some(h) if h.eq_ignore_ascii_case(&head) => {
                            version = "accepted";
                            round_id = Some(r.id);
                        }
                        Some(h) => {
                            return Err(MergeNo::Rule {
                                code: "after_acceptance",
                                why: format!(
                                "the pull request has commits after its acceptance (accepted and \
                                     delivered {}, its head is {})",
                                short(h),
                                short(&head)
                            ),
                            })
                        }
                        None => return Err(MergeNo::Rule {
                            code: "not_delivered",
                            why:
                                "the version its acceptance passed was not delivered to this pull \
                                      request by codeg"
                                    .into(),
                        }),
                    },
                    _ => {
                        return Err(MergeNo::Rule {
                            code: "not_accepted",
                            why: "its acceptance has not passed".into(),
                        })
                    }
                }
            }
        }
        let cnb = target.repo.provider == ForgeProvider::Cnb;
        let checks = if cnb {
            "unknown"
        } else {
            let c = &detail.checks;
            if !c.available {
                return Err(MergeNo::Rule {
                    code: "checks_unreadable",
                    why: "codeg cannot read its checks".into(),
                });
            }
            if c.partial {
                return Err(MergeNo::Rule {
                    code: "checks_partial",
                    why: "some of its checks could not be read".into(),
                });
            }
            let names = |f: &dyn Fn(&crate::forge::ForgeCheck) -> bool| {
                c.checks
                    .iter()
                    .filter(|x| f(x))
                    .map(|x| x.name.clone())
                    .collect::<Vec<_>>()
            };
            let running = names(&|x| x.state.is_pending());
            if !running.is_empty() {
                return Err(MergeNo::Rule {
                    code: "checks_running",
                    why: format!("its checks are still running: {}", running.join(", ")),
                });
            }
            let failing = names(&|x| x.state == ForgeCheckState::Failure && !x.allow_failure);
            if !failing.is_empty() {
                return Err(MergeNo::Rule {
                    code: "checks_failing",
                    why: format!("checks failing at {}: {}", short(&head), failing.join(", ")),
                });
            }
            if c.checks.is_empty() {
                "none"
            } else {
                "green"
            }
        };
        let method = match method {
            Some(m) => m,
            None => tokio::time::timeout(
                std::time::Duration::from_secs(FORGE_ACT_SECS),
                crate::commands::forge::merge_options_at(&self.db, &target.repo),
            )
            .await
            .ok()
            .and_then(Result::ok)
            .map(|o| o.default_method)
            .unwrap_or(ForgeMergeMethod::Merge),
        };
        Ok(MergePlan {
            head,
            version,
            round_id,
            checks,
            guaranteed: !cnb,
            method,
        })
    }

    /// A watch's merge of `w` at `head` (7.4, phase 3): done now through
    /// the shared entry and the merged-version rules, or — `ask`, or CNB —
    /// put to the owner on an approval card. Once per head: its card is
    /// keyed by it, and so is the operation.
    pub(super) async fn watch_merge_card(
        self: &Arc<Self>,
        w: &crate::db::entities::personal_agent_watch::Model,
        head: &str,
        ask: bool,
    ) -> WatchMerge {
        let Some(repo) = crate::db::service::personal_agent_watch_service::target_of(w) else {
            return WatchMerge::Unread("the watch names no forge codeg knows".into());
        };
        let subject = format!("watch-merge:{}:{}", w.id, head.to_ascii_lowercase());
        if svc::notice_of_subject(&self.db.conn, self.bot().await, NoticeKind::Forge, &subject)
            .await
            .ok()
            .flatten()
            .is_some()
        {
            return WatchMerge::Not;
        }
        let account_name = crate::commands::forge::auth_at(&self.db, &repo)
            .await
            .ok()
            .map(|a| a.username);
        let mut call = ForgeCall {
            action: ForgeAction::Merge,
            target: ForgeTarget {
                repo,
                kind: "pr".into(),
                number: w.number,
                task_id: None,
                url: w.url.clone(),
                account_name,
            },
            body: None,
            method: None,
            head: None,
            version: None,
            round_id: None,
            checks: None,
            guaranteed: false,
            reason: None,
            why: String::new(),
            auto: true,
        };
        match Box::pin(self.plan_merge(&call.target, None)).await {
            Ok(plan) if plan.head.eq_ignore_ascii_case(head) => call.adopt(&plan),
            // Moved since the read: the next one tells.
            Ok(_) => return WatchMerge::Not,
            Err(MergeNo::Read(e)) => return WatchMerge::Unread(e),
            Err(MergeNo::Rule { why, .. }) => return WatchMerge::Refused(why),
        }
        let cnb = call.target.repo.provider == ForgeProvider::Cnb;
        call.why = if cnb {
            "cnb"
        } else if ask {
            "confirm"
        } else {
            "direct"
        }
        .into();
        if call.why != "direct" {
            let id = match self
                .raise_forge_card(&call, "open", None, Some(subject), Value::Null)
                .await
            {
                Ok(id) => id,
                Err(e) => return WatchMerge::Unread(e),
            };
            // The owner hears it can be merged — on CNB, that there is no
            // conflict and its checks are unknown.
            if let Some(host) = self.host_ref() {
                let bot = self.bot().await;
                let row_id = svc::get_notice(&self.db.conn, id)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|n| n.timeline_id);
                let text = match &w.title {
                    Some(t) if !t.trim().is_empty() => {
                        format!("{} {}", call.target.label(), super::reach::glimpse(t))
                    }
                    _ => call.target.label(),
                };
                host.tell(super::reach::News {
                    key: format!("forge:{id}"),
                    bot_id: bot,
                    kind: "pr_ready",
                    what: if cnb {
                        super::reach::What::PrNoConflict { text }
                    } else {
                        super::reach::What::PrReady { text }
                    },
                    link: Some(super::reach::NotifyLink::Bot {
                        bot_id: bot,
                        row_id,
                    }),
                    need: None,
                })
                .await;
            }
            return WatchMerge::Asked(id);
        }
        let id = match self
            .raise_forge_card(&call, "acting", None, Some(subject.clone()), Value::Null)
            .await
        {
            Ok(id) => id,
            Err(e) => return WatchMerge::Unread(e),
        };
        let op_id = format!("pa-watch-merge-{}-{}", w.id, head.to_ascii_lowercase());
        let (state, text) = Box::pin(self.run_forge(&call, LedgerSlot::outside(op_id), id)).await;
        self.tell_forge(id, state, &text).await;
        WatchMerge::Merging(id, (state == "failed").then_some(text))
    }

    /// The approval cards of `w`'s merges that no longer stand: for another
    /// head than the one there now, or the pull request no longer open.
    pub(super) async fn retire_merge_asks(
        self: &Arc<Self>,
        w: &crate::db::entities::personal_agent_watch::Model,
        detail: &crate::forge::ForgeChangeDetail,
    ) {
        use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
        let prefix = format!("watch-merge:{}:", w.id);
        let open = notice_entity::Entity::find()
            .filter(notice_entity::Column::BotId.eq(w.bot_id))
            .filter(notice_entity::Column::Kind.eq(NoticeKind::Forge))
            .filter(notice_entity::Column::State.eq(NoticeState::Open))
            .filter(notice_entity::Column::SubjectKey.starts_with(prefix.as_str()))
            .all(&self.db.conn)
            .await
            .unwrap_or_default();
        let head = detail
            .head_sha
            .as_deref()
            .unwrap_or("")
            .to_ascii_lowercase();
        for n in open {
            // Only one never run: a merge sent whose answer was lost is in
            // doubt, and its look on the forge settles it.
            let phase = serde_json::from_str::<Value>(&n.payload)
                .ok()
                .and_then(|p| p["phase"].as_str().map(str::to_string));
            if phase.as_deref() != Some("approve") {
                continue;
            }
            let card_head = n
                .subject_key
                .as_deref()
                .and_then(|k| k.strip_prefix(prefix.as_str()))
                .unwrap_or("");
            let why = match detail.state.as_str() {
                "merged" => "the pull request was merged meanwhile",
                "closed" => "the pull request was closed meanwhile",
                _ if card_head != head => "the pull request has a new head since",
                _ => continue,
            };
            if self
                .forge_card_to(
                    n.id,
                    &[NoticeState::Open],
                    NoticeState::Expired,
                    "not_run",
                    json!({ "error": why }),
                )
                .await
            {
                self.tell_forge(n.id, "not_run", &format!("its merge was not done: {why}."))
                    .await;
            }
        }
    }

    // ── running one ─────────────────────────────────────────────────────────

    /// Run `call` under `slot`, its card `notice_id` following it: the
    /// card's state as it ends, and what to tell the assistant.
    async fn run_forge(
        self: &Arc<Self>,
        call: &ForgeCall,
        slot: LedgerSlot,
        notice_id: i32,
    ) -> (&'static str, String) {
        let op_id = slot.op_id.clone();
        let payload = serde_json::to_value(call).unwrap_or(Value::Null);
        let target = serde_json::to_value(&call.target).unwrap_or(Value::Null);
        // A not-done entry of this batch is run again under the new id.
        let earlier_here = if slot.batch_id != 0 {
            svc::ledger_entries(&self.db.conn, &[slot.batch_id], &slot.key)
                .await
                .ok()
                .and_then(|e| e.into_iter().next_back())
        } else {
            None
        };
        let begun = match earlier_here.and_then(|e| e.op_id) {
            Some(old) => {
                match svc::op_rearm(&self.db.conn, &old, &op_id, payload.clone(), target.clone())
                    .await
                {
                    Ok(true) => {
                        let _ = svc::op_set_notice(&self.db.conn, &op_id, notice_id).await;
                        Ok(())
                    }
                    Ok(false) => Err("the same call is on record already".to_string()),
                    Err(e) => Err(e.to_string()),
                }
            }
            None => match svc::begin_op(
                &self.db.conn,
                NewOp {
                    bot_id: self.bot().await,
                    slot: slot.clone(),
                    kind: "forge",
                    payload: payload.clone(),
                    target: Some(target),
                    notice_id: Some(notice_id),
                },
            )
            .await
            {
                Ok(Ledgered::New(_)) => Ok(()),
                Ok(Ledgered::Earlier(_)) => Err("the same call is on record already".to_string()),
                Err(e) => Err(e.to_string()),
            },
        };
        if let Err(e) = begun {
            self.forge_card_to(
                notice_id,
                &[NoticeState::Acting],
                NoticeState::Expired,
                "failed",
                json!({ "error": e }),
            )
            .await;
            return ("failed", format!("Not done: {e}."));
        }
        self.set_live(&op_id, true).await;
        let exec = self.execute_forge(call, &op_id).await;
        let outcome = match &exec {
            Exec::Done(result) => {
                let ref_id = result
                    .get("merge_commit")
                    .or_else(|| result.get("url"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let _ = svc::op_settle(
                    &self.db.conn,
                    &op_id,
                    &[ActionState::Prepared],
                    ActionState::Committed,
                    ref_id,
                    None,
                    Some(result.clone()),
                )
                .await;
                OpOutcome::Committed
            }
            Exec::Refused(why) => {
                let _ = svc::op_settle(
                    &self.db.conn,
                    &op_id,
                    &[ActionState::Prepared],
                    ActionState::NotExecuted,
                    None,
                    Some(why.clone()),
                    None,
                )
                .await;
                OpOutcome::NotExecuted(why.clone())
            }
            Exec::Unknown(why) => {
                let _ = svc::op_settle(
                    &self.db.conn,
                    &op_id,
                    &[ActionState::Prepared],
                    ActionState::Unknown,
                    None,
                    Some(why.clone()),
                    None,
                )
                .await;
                OpOutcome::Unknown(why.clone())
            }
            Exec::Settled => OpOutcome::Pending,
        };
        self.set_live(&op_id, false).await;
        let result = match &exec {
            Exec::Done(r) => r.clone(),
            _ => Value::Null,
        };
        self.forge_settled(call, notice_id, &outcome, result, false)
            .await;
        if matches!(outcome, OpOutcome::Unknown(_)) {
            let me = self.clone();
            let op = op_id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(RECHECK_AFTER_SECS)).await;
                me.recheck_forge_op(&op).await;
            });
        }
        match outcome {
            OpOutcome::Committed => (
                "done",
                format!("Done: {}.{}", call.what(), done_note(call, &exec)),
            ),
            OpOutcome::NotExecuted(why) => (
                "failed",
                format!("Not done: {}: the forge said: {why}.", call.what()),
            ),
            OpOutcome::Unknown(why) => (
                "unknown",
                format!(
                    "codeg cannot tell yet whether {} went through ({why}). It looks on the forge \
                     shortly and tells you; the owner has a card meanwhile. Do not do it again.",
                    call.what()
                ),
            ),
            OpOutcome::Pending => ("acting", format!("{} is being settled.", call.what())),
        }
    }

    /// Send `call` to the forge as operation `op_id`.
    async fn execute_forge(&self, call: &ForgeCall, op_id: &str) -> Exec {
        let auth = match tokio::time::timeout(
            std::time::Duration::from_secs(FORGE_ACT_SECS),
            crate::commands::forge::auth_at(&self.db, &call.target.repo),
        )
        .await
        {
            Ok(Ok(a)) => a,
            Ok(Err(e)) => {
                let _ =
                    svc::op_unattempted_to_not_executed(&self.db.conn, op_id, &e.to_string()).await;
                return Exec::Refused(e.to_string());
            }
            Err(_) => return Exec::Refused("the account could not be read in time".into()),
        };
        // From here on it may reach the forge.
        if !svc::op_attempted(&self.db.conn, op_id)
            .await
            .unwrap_or(false)
        {
            return Exec::Settled;
        }
        let repo = &call.target.repo;
        let number = call.target.number;
        let kind = call.target.item_kind();
        let sent = tokio::time::timeout(std::time::Duration::from_secs(FORGE_ACT_SECS), async {
            match call.action {
                ForgeAction::Comment => {
                    let body = format!(
                        "{}\n\n{}",
                        call.body.as_deref().unwrap_or(""),
                        marker(op_id)
                    );
                    crate::commands::forge::comment_at(&auth, repo, kind, number, &body)
                        .await
                        .map(|c| json!({ "url": c.html_url, "comment_id": c.id }))
                }
                ForgeAction::Close => crate::commands::forge::set_state_at(
                    &auth,
                    repo,
                    kind,
                    number,
                    crate::forge::ForgeStateAction::Close,
                )
                .await
                .map(|row| json!({ "url": row.html_url })),
                ForgeAction::Merge => crate::commands::forge::merge_at(
                    &auth,
                    repo,
                    number,
                    call.method.unwrap_or(ForgeMergeMethod::Merge),
                    call.head.as_deref(),
                )
                .await
                .map(|_| json!({})),
            }
        })
        .await;
        match sent {
            Err(_) => Exec::Unknown(format!(
                "the forge did not answer within {FORGE_ACT_SECS} s"
            )),
            Ok(Err(e)) => exec_of_error(&e),
            Ok(Ok(mut result)) => {
                if call.action == ForgeAction::Merge {
                    // What it landed as, when the forge says.
                    let facts = tokio::time::timeout(
                        std::time::Duration::from_secs(FORGE_ACT_SECS),
                        crate::commands::forge::item_facts_at(&self.db, repo, kind, number),
                    )
                    .await;
                    if let Ok(Ok(f)) = facts {
                        result["merge_commit"] = json!(f.merge_commit);
                    }
                    result["url"] = json!(call.target.url);
                }
                Exec::Done(result)
            }
        }
    }

    /// Whether `call`, run as `op_id`, took effect on the forge:
    /// `Ok(Some(result))` it did, `Ok(None)` it did not, `Err` cannot tell.
    async fn forge_took(&self, call: &ForgeCall, op_id: &str) -> Result<Option<Value>, String> {
        let repo = &call.target.repo;
        let number = call.target.number;
        let kind = call.target.item_kind();
        let wait = std::time::Duration::from_secs(FORGE_ACT_SECS);
        match call.action {
            ForgeAction::Comment => {
                let marker = marker(op_id);
                for page in 1..=MARKER_PAGES {
                    let list = tokio::time::timeout(
                        wait,
                        crate::commands::forge::comments_at(
                            &self.db,
                            repo,
                            kind,
                            number,
                            page,
                            MARKER_PAGE_SIZE,
                        ),
                    )
                    .await
                    .map_err(|_| "the forge did not answer".to_string())?
                    .map_err(|e| e.to_string())?;
                    if let Some(c) = list.comments.iter().find(|c| c.body.contains(&marker)) {
                        return Ok(Some(json!({ "url": c.html_url, "comment_id": c.id })));
                    }
                    if !list.has_next {
                        return Ok(None);
                    }
                }
                Err("the thread is too long to look through".into())
            }
            ForgeAction::Close | ForgeAction::Merge => {
                let facts = tokio::time::timeout(
                    wait,
                    crate::commands::forge::item_facts_at(&self.db, repo, kind, number),
                )
                .await
                .map_err(|_| "the forge did not answer".to_string())?
                .map_err(|e| e.to_string())?;
                let took = match call.action {
                    ForgeAction::Close => facts.state != "open",
                    _ => facts.state == "merged",
                };
                if !took {
                    return Ok(None);
                }
                // Merged — but this merge only if at the head it was to
                // merge: one merged at another head (after a push, by
                // someone else) is not this one, and vouches for nothing.
                if call.action == ForgeAction::Merge {
                    if let Some(want) = call.head.as_deref() {
                        let detail = tokio::time::timeout(
                            wait,
                            crate::commands::forge::change_detail_at(&self.db, repo, number),
                        )
                        .await
                        .map_err(|_| "the forge did not answer".to_string())?
                        .map_err(|e| e.to_string())?;
                        match detail.head_sha.as_deref() {
                            Some(h) if h.eq_ignore_ascii_case(want) => {}
                            Some(h) => {
                                tracing::info!(
                                    "[personal-agent] {} was merged at {h}, not at {want}",
                                    call.target.label()
                                );
                                return Ok(None);
                            }
                            None => return Err("the forge did not say the merged head".into()),
                        }
                    }
                }
                Ok(Some(json!({
                    "url": call.target.url, "merge_commit": facts.merge_commit, "state": facts.state,
                })))
            }
        }
    }

    /// Settle a forge entry left prepared or unknown by what the forge
    /// shows: there, done; not there, not done; no answer, unknown.
    pub(super) async fn resolve_forge_op(&self, op: &action_entity::Model) -> OpOutcome {
        let Some(op_id) = op.op_id.clone() else {
            return OpOutcome::Unknown("recorded without an operation id".into());
        };
        if self.is_live(&op_id).await {
            return OpOutcome::Pending;
        }
        if op.state == ActionState::Prepared && op.attempted_at.is_none() {
            let why = "codeg stopped before it went out".to_string();
            if svc::op_unattempted_to_not_executed(&self.db.conn, &op_id, &why)
                .await
                .unwrap_or(false)
            {
                return OpOutcome::NotExecuted(why);
            }
        }
        let Some(call) = ledger::parse::<ForgeCall>(op.payload.as_deref()) else {
            return OpOutcome::Unknown("its record cannot be read".into());
        };
        let from = [ActionState::Prepared, ActionState::Unknown];
        let settled = match self.forge_took(&call, &op_id).await {
            Ok(Some(result)) => {
                let ref_id = result
                    .get("merge_commit")
                    .or_else(|| result.get("url"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                svc::op_settle(
                    &self.db.conn,
                    &op_id,
                    &from,
                    ActionState::Committed,
                    ref_id,
                    None,
                    Some(result),
                )
                .await
            }
            Ok(None) => {
                let why = "the forge shows it did not happen".to_string();
                svc::op_settle(
                    &self.db.conn,
                    &op_id,
                    &from,
                    ActionState::NotExecuted,
                    None,
                    Some(why),
                    None,
                )
                .await
            }
            Err(e) => {
                let why = format!("codeg could not look on the forge: {e}");
                svc::op_settle(
                    &self.db.conn,
                    &op_id,
                    &[ActionState::Prepared],
                    ActionState::Unknown,
                    None,
                    Some(why.clone()),
                    None,
                )
                .await
                .map(|_| true)
            }
        };
        if let Err(e) = settled {
            return OpOutcome::Unknown(format!("its record could not be written: {e}"));
        }
        // Whatever it is now — settled here, or by a look that got there
        // first: the entry says.
        self.forge_outcome_now(&op_id).await
    }

    /// An entry's outcome as it stands.
    async fn forge_outcome_now(&self, op_id: &str) -> OpOutcome {
        match svc::get_op(&self.db.conn, op_id).await {
            Ok(Some(op)) => match op.state {
                ActionState::Committed => OpOutcome::Committed,
                ActionState::NotExecuted | ActionState::Failed => {
                    OpOutcome::NotExecuted(op.detail.unwrap_or_default())
                }
                ActionState::Unknown => OpOutcome::Unknown(op.detail.unwrap_or_default()),
                ActionState::Prepared => OpOutcome::Pending,
            },
            _ => OpOutcome::Unknown("its record cannot be read".into()),
        }
    }

    /// Shortly after an unknown answer: look on the forge once. Found, it
    /// went through, and it and its card say so; not found, it stays
    /// unknown — the request may yet land, and the owner's [Do it again]
    /// looks again before it does anything.
    pub(super) async fn recheck_forge_op(&self, op_id: &str) {
        let Ok(Some(op)) = svc::get_op(&self.db.conn, op_id).await else {
            return;
        };
        if op.state != ActionState::Unknown || self.is_live(op_id).await {
            return;
        }
        let Some(call) = ledger::parse::<ForgeCall>(op.payload.as_deref()) else {
            return;
        };
        let Ok(Some(result)) = self.forge_took(&call, op_id).await else {
            return;
        };
        let ref_id = result
            .get("merge_commit")
            .or_else(|| result.get("url"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        if svc::op_settle(
            &self.db.conn,
            op_id,
            &[ActionState::Unknown],
            ActionState::Committed,
            ref_id,
            None,
            Some(result),
        )
        .await
        .unwrap_or(false)
        {
            self.after_forge_op(&op, &OpOutcome::Committed).await;
        }
    }

    /// What follows a forge entry's outcome settled outside its run (at
    /// start-up, by a later look): its card, and the assistant told.
    pub(super) async fn after_forge_op(&self, op: &action_entity::Model, outcome: &OpOutcome) {
        let Some(notice_id) = op.notice_id else {
            return;
        };
        let Some(call) = ledger::parse::<ForgeCall>(op.payload.as_deref()) else {
            return;
        };
        let result = match svc::get_op(&self.db.conn, op.op_id.as_deref().unwrap_or("")).await {
            Ok(Some(now)) => now
                .observed
                .as_deref()
                .and_then(|o| serde_json::from_str::<Value>(o).ok())
                .unwrap_or(Value::Null),
            _ => Value::Null,
        };
        self.forge_settled(&call, notice_id, outcome, result, true)
            .await;
    }

    /// The card of a forge action once its entry settled — and, `tell`, the
    /// assistant hears it (it was not answered at once).
    async fn forge_settled(
        &self,
        call: &ForgeCall,
        notice_id: i32,
        outcome: &OpOutcome,
        result: Value,
        tell: bool,
    ) {
        let from = &[NoticeState::Acting, NoticeState::Open];
        let (state, text) = match outcome {
            OpOutcome::Committed => {
                let moved = self
                    .forge_card_to(
                        notice_id,
                        from,
                        NoticeState::Acted,
                        "done",
                        json!({ "result": result, "error": null }),
                    )
                    .await;
                if !moved {
                    return;
                }
                self.forge_landed(call, &result).await;
                self.tell_forge_news(call, notice_id).await;
                (
                    "done",
                    format!(
                        "{} went through{}.",
                        capitalize(&call.what()),
                        link_note(&result)
                    ),
                )
            }
            OpOutcome::NotExecuted(why) => {
                if !self
                    .forge_card_to(
                        notice_id,
                        from,
                        NoticeState::Expired,
                        "failed",
                        json!({ "error": why }),
                    )
                    .await
                {
                    return;
                }
                (
                    "failed",
                    format!(
                        "{} did not happen: {why}. Do it again if it still matters.",
                        capitalize(&call.what())
                    ),
                )
            }
            OpOutcome::Unknown(why) => {
                let _ = self.set_forge_phase(notice_id, "unknown").await;
                if !self
                    .forge_card_to(
                        notice_id,
                        from,
                        NoticeState::Open,
                        "unknown",
                        json!({ "error": why }),
                    )
                    .await
                {
                    return;
                }
                (
                    "unknown",
                    format!(
                        "codeg cannot tell whether {} went through: {why}. The owner has a card to \
                         look, do it again or let it be; do not do it again yourself.",
                        call.what()
                    ),
                )
            }
            OpOutcome::Pending => return,
        };
        if tell {
            self.tell_forge(notice_id, state, &text).await;
        }
    }

    /// A merge landed: the round whose version it is records it. On CNB,
    /// which merges whatever the head is, the head it merged is compared
    /// with the one approved: another is the owner's to hear, urgently.
    async fn forge_landed(&self, call: &ForgeCall, result: &Value) {
        if call.action != ForgeAction::Merge {
            return;
        }
        if !call.guaranteed {
            if let (Some(want), Ok(Ok(d))) = (
                call.head.as_deref(),
                tokio::time::timeout(
                    std::time::Duration::from_secs(FORGE_ACT_SECS),
                    crate::commands::forge::change_detail_at(
                        &self.db,
                        &call.target.repo,
                        call.target.number,
                    ),
                )
                .await,
            ) {
                if let Some(got) = d.head_sha.as_deref() {
                    if !got.eq_ignore_ascii_case(want) {
                        self.not_the_approved_head(call, want, got).await;
                    }
                }
            }
        }
        let Some(round) = call.round_id else {
            return;
        };
        let commit = result
            .get("merge_commit")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let _ = vsvc::write_round(
            &self.db.conn,
            round,
            vsvc::RoundWrite {
                merge_commit: commit.map(Some),
                version_guaranteed: Some(Some(call.guaranteed)),
                ..Default::default()
            },
        )
        .await;
    }

    /// CNB merged a head other than the one approved: urgent news, and the
    /// card says so.
    async fn not_the_approved_head(&self, call: &ForgeCall, want: &str, got: &str) {
        let label = call.target.label();
        if let Some(host) = self.host_ref() {
            let bot = self.bot().await;
            host.tell(super::reach::News {
                key: format!("cnb-head:{label}:{got}"),
                bot_id: bot,
                kind: "used_up",
                what: super::reach::What::Plain {
                    text: format!(
                        "{label}: merged at {}, not at the approved {} (CNB merges whatever the \
                         head is)",
                        short(got),
                        short(want)
                    ),
                },
                link: None,
                need: None,
            })
            .await;
        }
        let _ = svc::insert_event(
            &self.db.conn,
            self.bot().await,
            "forge",
            &format!("cnb-head:{label}:{got}"),
            None,
            format!(
                "{label} was merged on CNB at head {}, not at the head {} that was approved: \
                 CNB's merge takes no head, and a commit landed in between. Tell the owner what \
                 went in.",
                short(got),
                short(want)
            ),
            Some(json!({ "approved_head": want, "merged_head": got })),
            true,
        )
        .await;
        self.nudge();
    }

    /// Done on the forge: low news, by default (1.13).
    async fn tell_forge_news(&self, call: &ForgeCall, notice_id: i32) {
        let Some(host) = self.host_ref() else {
            return;
        };
        let bot = self.bot().await;
        let row_id = svc::get_notice(&self.db.conn, notice_id)
            .await
            .ok()
            .flatten()
            .and_then(|n| n.timeline_id);
        let text = call.target.label();
        let what = match call.action {
            ForgeAction::Comment => super::reach::What::Commented { text },
            ForgeAction::Close => super::reach::What::IssueClosed { text },
            ForgeAction::Merge => super::reach::What::Merged { text },
        };
        host.tell(super::reach::News {
            key: format!("forge:{notice_id}"),
            bot_id: bot,
            // A watched pull request codeg merged by itself: told as one
            // that can be merged would be (7.4).
            kind: if call.auto { "pr_ready" } else { "forge" },
            what,
            link: Some(super::reach::NotifyLink::Bot {
                bot_id: bot,
                row_id,
            }),
            need: None,
        })
        .await;
    }

    // ── the card ────────────────────────────────────────────────────────────

    /// A card for `call`: `open` (to approve), `acting` (being done now) or
    /// `refused` (a merge its rules turn down).
    async fn raise_forge_card(
        &self,
        call: &ForgeCall,
        state: &str,
        batch_id: Option<i32>,
        subject: Option<String>,
        extra: Value,
    ) -> Result<i32, String> {
        let mut data = json!({
            "notice": "forge",
            "action": call.action,
            "state": state,
            "why": call.why,
            "target": call.target.display(),
            "body": call.body,
            "method": call.method,
            "head": call.head,
            "checks": call.checks,
            "version": call.version,
            "guaranteed": call.guaranteed,
            "reason": call.reason,
        });
        if let (Some(map), Value::Object(extra)) = (data.as_object_mut(), extra) {
            map.extend(extra);
        }
        let mut row = NewRow::new(TimelineKind::Notice, card_title(call));
        row.segment_id = self.state.lock().await.connection_segment;
        row.batch_id = batch_id;
        row.data = Some(data);
        let phase = match state {
            "open" => "approve",
            "refused" => "refused",
            _ => "running",
        };
        let (notice, card) = svc::create_notice_with_row(
            &self.db.conn,
            self.bot().await,
            NewNotice {
                kind: NoticeKind::Forge,
                subject_key: subject,
                level: if call.why == "suggest" {
                    NoticeLevel::Low
                } else {
                    NoticeLevel::Normal
                },
                batch_id,
                payload: json!({ "call": call, "phase": phase }),
            },
            row,
        )
        .await
        .map_err(|e| e.to_string())?;
        let to = match state {
            "acting" => Some(NoticeState::Acting),
            "refused" => Some(NoticeState::Expired),
            _ => None,
        };
        if let Some(to) = to {
            let _ = svc::move_notice(&self.db.conn, notice.id, &[NoticeState::Open], to).await;
        }
        self.emit_rows(vec![svc::to_row(card)]);
        self.emit(PersonalAgentChange::Status);
        Ok(notice.id)
    }

    /// Move a forge card `from` → `to` and write its row's state; false when
    /// it was not in `from`.
    async fn forge_card_to(
        &self,
        notice_id: i32,
        from: &[NoticeState],
        to: NoticeState,
        state: &str,
        extra: Value,
    ) -> bool {
        let moved = svc::move_notice(&self.db.conn, notice_id, from, to)
            .await
            .unwrap_or(false);
        if !moved {
            return false;
        }
        let _ = self.forge_row(notice_id, state, extra).await;
        true
    }

    async fn set_forge_phase(&self, notice_id: i32, phase: &str) -> Result<(), String> {
        let n = svc::get_notice(&self.db.conn, notice_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such card")?;
        let mut payload: Value = serde_json::from_str(&n.payload).unwrap_or_else(|_| json!({}));
        payload["phase"] = json!(phase);
        svc::set_notice_payload(&self.db.conn, notice_id, &payload)
            .await
            .map_err(|e| e.to_string())
    }

    /// Write a forge card's state, and what goes with it, onto its row.
    async fn forge_row(
        &self,
        notice_id: i32,
        state: &str,
        extra: Value,
    ) -> Result<TimelineRow, String> {
        let notice = svc::get_notice(&self.db.conn, notice_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such card")?;
        let id = notice.timeline_id.ok_or("the card's row is missing")?;
        let row = svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let mut data = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<Value>(d).ok())
            .unwrap_or_else(|| json!({}));
        if let Some(map) = data.as_object_mut() {
            map.insert("state".into(), state.into());
            if let Value::Object(extra) = extra {
                map.extend(extra);
            }
        }
        svc::update_row_data(&self.db.conn, id, None, Some(data))
            .await
            .map_err(|e| e.to_string())?;
        let updated = svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let row = svc::to_row(updated);
        self.emit_rows(vec![row.clone()]);
        self.emit(PersonalAgentChange::Status);
        Ok(row)
    }

    /// The assistant hears how its forge action came out, with its next
    /// delivery.
    async fn tell_forge(&self, notice_id: i32, verdict: &str, summary: &str) {
        let _ = svc::insert_event(
            &self.db.conn,
            self.bot().await,
            "forge",
            &format!(
                "forge:{notice_id}:{verdict}:{}",
                chrono::Utc::now().timestamp_millis()
            ),
            None,
            format!("Card #{notice_id}: {summary}"),
            Some(json!({ "notice_id": notice_id, "verdict": verdict })),
            false,
        )
        .await;
    }

    /// The owner's answer on a forge card: `accept` runs one waiting for
    /// approval (its premises looked at again first); `retry` does one
    /// whose outcome is unknown again — after looking on the forge, so one
    /// that went through is not done twice; `dismiss` lets it be.
    pub(super) async fn act_on_forge(
        self: &Arc<Self>,
        notice: &notice_entity::Model,
        action: &str,
    ) -> Result<TimelineRow, String> {
        let payload: Value = serde_json::from_str(&notice.payload).unwrap_or(Value::Null);
        let phase = payload["phase"].as_str().unwrap_or("").to_string();
        let mut call: ForgeCall =
            serde_json::from_value(payload["call"].clone()).map_err(|e| e.to_string())?;
        match action {
            "dismiss" => {
                if !self
                    .forge_card_to(
                        notice.id,
                        &[NoticeState::Open],
                        NoticeState::Dismissed,
                        "dismissed",
                        json!({}),
                    )
                    .await
                {
                    return Err("this card was answered already".into());
                }
                let text = if phase == "unknown" {
                    format!(
                        "the owner let {} be: nothing more is done about it.",
                        call.what()
                    )
                } else {
                    format!("the owner declined {}. Nothing was done.", call.what())
                };
                self.tell_forge(notice.id, "declined", &text).await;
                self.forge_row(notice.id, "dismissed", json!({})).await
            }
            "accept" | "retry" => {
                let want = if action == "accept" {
                    "approve"
                } else {
                    "unknown"
                };
                if phase != want {
                    return Err(if action == "accept" {
                        "this card has nothing waiting for approval".into()
                    } else {
                        "nothing on this card is in doubt".into()
                    });
                }
                if !svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Open],
                    NoticeState::Acting,
                )
                .await
                .map_err(|e| e.to_string())?
                {
                    return Err("this card was answered already".into());
                }
                let _ = self.set_forge_phase(notice.id, "running").await;
                let _ = self
                    .forge_row(notice.id, "acting", json!({ "error": null }))
                    .await;
                let ops: Vec<action_entity::Model> = svc::ops_of_notice(&self.db.conn, notice.id)
                    .await
                    .unwrap_or_default();
                // In doubt: look first. Went through, it is done, not again.
                if action == "retry" {
                    if let Some(last) = ops.last() {
                        match self.resolve_forge_op(last).await {
                            OpOutcome::Committed => {
                                let fresh =
                                    svc::get_op(&self.db.conn, last.op_id.as_deref().unwrap_or(""))
                                        .await
                                        .ok()
                                        .flatten()
                                        .unwrap_or_else(|| last.clone());
                                self.after_forge_op(&fresh, &OpOutcome::Committed).await;
                                return self.forge_row_now(notice.id).await;
                            }
                            OpOutcome::Unknown(why) => {
                                let _ = self.set_forge_phase(notice.id, "unknown").await;
                                self.forge_card_to(
                                    notice.id,
                                    &[NoticeState::Acting],
                                    NoticeState::Open,
                                    "unknown",
                                    json!({ "error": why.clone() }),
                                )
                                .await;
                                return Err(why);
                            }
                            // Being done right now: not twice.
                            OpOutcome::Pending => {
                                let _ = self.set_forge_phase(notice.id, "unknown").await;
                                self.forge_card_to(
                                    notice.id,
                                    &[NoticeState::Acting],
                                    NoticeState::Open,
                                    "unknown",
                                    json!({}),
                                )
                                .await;
                                return Err("it is being done right now".into());
                            }
                            OpOutcome::NotExecuted(_) => {}
                        }
                    }
                }
                // Its premises, again: a merge's head and checks.
                if call.action == ForgeAction::Merge {
                    match self.plan_merge(&call.target, call.method).await {
                        Ok(plan) if Some(plan.head.as_str()) == call.head.as_deref() => {
                            call.adopt(&plan);
                        }
                        Ok(plan) => {
                            let why = format!(
                                "its head moved from {} to {}",
                                short(call.head.as_deref().unwrap_or("")),
                                short(&plan.head)
                            );
                            return self.not_run(notice, &call, &why).await;
                        }
                        Err(MergeNo::Rule { why, .. }) => {
                            return self.not_run(notice, &call, &why).await
                        }
                        Err(MergeNo::Read(e)) => {
                            let back = if action == "accept" {
                                "approve"
                            } else {
                                "unknown"
                            };
                            let _ = self.set_forge_phase(notice.id, back).await;
                            self.forge_card_to(
                                notice.id,
                                &[NoticeState::Acting],
                                NoticeState::Open,
                                if action == "accept" {
                                    "open"
                                } else {
                                    "unknown"
                                },
                                json!({ "error": e.clone() }),
                            )
                            .await;
                            return Err(e);
                        }
                    }
                }
                // A comment on a pull request was written about the head it
                // was at when its card went up: approved after the pull
                // request moved on, it is not posted (2.2).
                if call.action == ForgeAction::Comment && action == "accept" {
                    if let Some(was) = call.head.clone() {
                        match Box::pin(self.pr_head_now(&call.target)).await {
                            Ok(Some(now)) if !now.eq_ignore_ascii_case(&was) => {
                                let why = format!(
                                    "the pull request has a new head since: {} → {}",
                                    short(&was),
                                    short(&now)
                                );
                                return self.not_run(notice, &call, &why).await;
                            }
                            Ok(_) => {}
                            Err(e) => {
                                let _ = self.set_forge_phase(notice.id, "approve").await;
                                self.forge_card_to(
                                    notice.id,
                                    &[NoticeState::Acting],
                                    NoticeState::Open,
                                    "open",
                                    json!({ "error": e.clone() }),
                                )
                                .await;
                                return Err(e);
                            }
                        }
                    }
                }
                if call.action == ForgeAction::Close {
                    if let Ok(Ok(f)) = tokio::time::timeout(
                        std::time::Duration::from_secs(FORGE_ACT_SECS),
                        crate::commands::forge::item_facts_at(
                            &self.db,
                            &call.target.repo,
                            ForgeItemKind::Issue,
                            call.target.number,
                        ),
                    )
                    .await
                    {
                        if f.state != "open" {
                            return self
                                .not_run(
                                    notice,
                                    &call,
                                    &format!("{} is closed already", call.target.label()),
                                )
                                .await;
                        }
                    }
                }
                let attempt = ops
                    .iter()
                    .filter(|o| o.op_id.as_deref().is_some_and(ledger::is_card_op))
                    .count()
                    + 1;
                let op_id = ledger::card_op_id(notice.id, attempt);
                let (state, text) = self
                    .run_forge(&call, LedgerSlot::outside(op_id), notice.id)
                    .await;
                let verdict = if action == "accept" {
                    "approved"
                } else {
                    "again"
                };
                let told = match state {
                    "done" => format!(
                        "the owner {} {}: done.",
                        if action == "accept" {
                            "approved"
                        } else {
                            "had codeg do again"
                        },
                        call.what()
                    ),
                    _ => format!(
                        "the owner {}: {text}",
                        if action == "accept" {
                            "approved it"
                        } else {
                            "had it done again"
                        }
                    ),
                };
                self.tell_forge(notice.id, verdict, &told).await;
                let row = self.forge_row_now(notice.id).await?;
                if state == "failed" {
                    return Err(text);
                }
                Ok(row)
            }
            _ => Err("`action` must be accept, retry or dismiss".into()),
        }
    }

    /// Approved, but its premises changed: nothing is done.
    async fn not_run(
        &self,
        notice: &notice_entity::Model,
        call: &ForgeCall,
        why: &str,
    ) -> Result<TimelineRow, String> {
        self.forge_card_to(
            notice.id,
            &[NoticeState::Acting],
            NoticeState::Expired,
            "not_run",
            json!({ "error": why }),
        )
        .await;
        self.tell_forge(
            notice.id,
            "not_run",
            &format!(
                "the owner approved {}, but it was not done: {why}.",
                call.what()
            ),
        )
        .await;
        self.forge_row_now(notice.id).await
    }

    async fn forge_row_now(&self, notice_id: i32) -> Result<TimelineRow, String> {
        let notice = svc::get_notice(&self.db.conn, notice_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such card")?;
        let id = notice.timeline_id.ok_or("the card's row is missing")?;
        svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .map(svc::to_row)
            .ok_or_else(|| "the card's row is missing".to_string())
    }

    /// After a restart: a forge card left acting settles by its entry.
    pub(super) async fn settle_forge_card_at_boot(&self, card: &notice_entity::Model) {
        let ops = svc::ops_of_notice(&self.db.conn, card.id)
            .await
            .unwrap_or_default();
        match ops.last() {
            None => {
                self.forge_card_to(
                    card.id,
                    &[NoticeState::Acting],
                    NoticeState::Expired,
                    "failed",
                    json!({ "error": "codeg stopped before it ran; nothing was done" }),
                )
                .await;
            }
            Some(op) => {
                let outcome = match op.state {
                    ActionState::Committed => OpOutcome::Committed,
                    ActionState::NotExecuted | ActionState::Failed => {
                        OpOutcome::NotExecuted(op.detail.clone().unwrap_or_default())
                    }
                    ActionState::Unknown => {
                        OpOutcome::Unknown(op.detail.clone().unwrap_or_default())
                    }
                    ActionState::Prepared => self.resolve_forge_op(op).await,
                };
                self.after_forge_op(op, &outcome).await;
            }
        }
    }
}

impl ForgeCall {
    fn adopt(&mut self, plan: &MergePlan) {
        self.head = Some(plan.head.clone());
        self.version = Some(plan.version.into());
        self.round_id = plan.round_id;
        self.checks = Some(plan.checks.into());
        self.guaranteed = plan.guaranteed;
        self.method = Some(plan.method);
    }
}

/// A card's title: what it does, where.
fn card_title(call: &ForgeCall) -> String {
    match call.action {
        ForgeAction::Comment => format!("Comment on {}", call.target.label()),
        ForgeAction::Close => format!("Close {}", call.target.label()),
        ForgeAction::Merge => format!("Merge {}", call.target.label()),
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn link_note(result: &Value) -> String {
    match result.get("url").and_then(|u| u.as_str()) {
        Some(u) if !u.is_empty() => format!(" ({u})"),
        _ => String::new(),
    }
}

/// What a done action's answer adds: its link, a merge's commit and
/// whether its version is guaranteed.
fn done_note(call: &ForgeCall, exec: &Exec) -> String {
    let Exec::Done(result) = exec else {
        return String::new();
    };
    let mut out = link_note(result);
    if call.action == ForgeAction::Merge {
        if let Some(c) = result.get("merge_commit").and_then(|v| v.as_str()) {
            out.push_str(&format!(" Merge commit {}.", short(c)));
        }
        if call.version.as_deref() == Some("accepted") {
            out.push_str(" It is the version its acceptance passed.");
        }
        if !call.guaranteed {
            out.push_str(
                " The version merged is not guaranteed: the forge takes no head with a merge.",
            );
        }
    }
    out
}

#[cfg(test)]
mod unit {
    use super::*;

    fn target(provider: ForgeProvider, kind: &str) -> ForgeTarget {
        ForgeTarget {
            repo: DeliveryTarget {
                provider,
                server_host: "GitHub.com".into(),
                account_id: "acc".into(),
                owner_repo: "Acme/App".into(),
            },
            kind: kind.into(),
            number: 12,
            task_id: None,
            url: None,
            account_name: None,
        }
    }

    fn call(action: ForgeAction, body: Option<&str>) -> ForgeCall {
        ForgeCall {
            action,
            target: target(
                ForgeProvider::GitHub,
                if action == ForgeAction::Close {
                    "issue"
                } else {
                    "pr"
                },
            ),
            body: body.map(str::to_string),
            method: None,
            head: None,
            version: None,
            round_id: None,
            checks: None,
            guaranteed: false,
            reason: None,
            why: String::new(),
            auto: false,
        }
    }

    #[test]
    fn the_key_is_how_the_call_names_its_item_and_a_comments_text_but_not_its_spacing() {
        let a = call_key(
            ForgeAction::Comment,
            &json!({ "project_id": 3, "number": "#12", "kind": "pr", "body": "Fixed  in\nabc" }),
        );
        let b = call_key(
            ForgeAction::Comment,
            &json!({ "project_id": 3, "number": 12, "kind": "pr", "body": "Fixed in abc" }),
        );
        let c = call_key(
            ForgeAction::Comment,
            &json!({ "project_id": 3, "number": 12, "kind": "pr", "body": "Something else" }),
        );
        assert_eq!(a, b);
        assert_ne!(a, c);
        let m = call_key(ForgeAction::Merge, &json!({ "task_id": 4 }));
        assert_ne!(m, call_key(ForgeAction::Merge, &json!({ "task_id": 5 })));
        assert_ne!(m, call_key(ForgeAction::Close, &json!({ "task_id": 4 })));
    }

    #[test]
    fn a_gitlab_merge_request_reads_with_a_bang() {
        assert_eq!(target(ForgeProvider::GitHub, "pr").label(), "Acme/App#12");
        assert_eq!(target(ForgeProvider::GitLab, "pr").label(), "Acme/App!12");
        assert_eq!(
            target(ForgeProvider::GitLab, "issue").label(),
            "Acme/App#12"
        );
    }

    #[test]
    fn a_dropped_connection_or_a_server_error_is_unknown_a_refusal_is_not() {
        assert!(matches!(
            exec_of_error(&ForgeError::Network("reset".into())),
            Exec::Unknown(_)
        ));
        assert!(matches!(
            exec_of_error(&ForgeError::Api {
                status: 502,
                message: "bad gateway".into()
            }),
            Exec::Unknown(_)
        ));
        assert!(matches!(
            exec_of_error(&ForgeError::Api {
                status: 405,
                message: "not mergeable".into()
            }),
            Exec::Refused(_)
        ));
        assert!(matches!(
            exec_of_error(&ForgeError::RateLimited { retry_after: None }),
            Exec::Refused(_)
        ));
    }

    #[test]
    fn a_call_reads_back_as_written() {
        let mut m = call(ForgeAction::Merge, None);
        m.method = Some(ForgeMergeMethod::Squash);
        m.head = Some("abc".into());
        let back: ForgeCall = serde_json::from_value(serde_json::to_value(&m).unwrap()).unwrap();
        assert_eq!(back.method, Some(ForgeMergeMethod::Squash));
        assert_eq!(back.target, m.target);
        assert_eq!(marker("pa-1"), "<!-- codeg-op:pa-1 -->");
    }
}
