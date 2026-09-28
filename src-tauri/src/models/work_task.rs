use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub use crate::db::entities::work_task::WorkTaskStatus;

/// One folder-bound work task. Wire form mirrors `src/lib/types.ts`
/// (`WorkTask`).
#[derive(Debug, Clone, Serialize)]
pub struct WorkTaskInfo {
    pub id: i32,
    pub folder_id: i32,
    pub title: String,
    /// Opaque `WorkTaskConfig` snapshot (prompt blocks + per-task overrides);
    /// replayed at launch, never queried.
    pub config: serde_json::Value,
    pub status: WorkTaskStatus,
    pub failure_reason: Option<String>,
    pub last_error: Option<String>,
    pub run_seq: i32,
    pub sort_order: i32,
    pub worktree_folder_id: Option<i32>,
    /// A worktree is recorded but unusable: its folder row was removed, or its
    /// directory is gone from disk. Stamped by the list/get commands (the row
    /// itself cannot know) — the board reads it to stop offering a merge that
    /// can only fail.
    #[serde(default)]
    pub worktree_missing: bool,
    /// Wire name of the agent that runs — or ran — this task, resolved with
    /// the engine's own layering. Stamped by the list/get commands (the row
    /// stores only an optional override; the inherited value lives in the
    /// folder's settings), so the board and the list can draw its mark beside
    /// the title without a lookup per card. `None` = nothing configured
    /// anywhere, which is also the one case the engine refuses to launch.
    #[serde(default)]
    pub agent_type: Option<String>,
    pub conversation_id: Option<i32>,
    /// Live ACP connection of the current generation — the transcript viewer
    /// attaches by it. Only meaningful while the task is running/awaiting;
    /// stale after a settle (gate on status client-side).
    pub connection_id: Option<String>,
    pub base_branch: Option<String>,
    pub base_sha: Option<String>,
    pub work_branch: Option<String>,
    pub cleanup_state: Option<String>,
    pub verdict: Option<String>,
    pub result_summary: Option<String>,
    pub files_changed: Option<i32>,
    pub additions: Option<i32>,
    pub deletions: Option<i32>,
    pub merge_commit: Option<String>,
    /// How a `done` task ended: 'merged' | 'delivered_pr' |
    /// 'accepted_without_merge'. `None` on live tasks and on rows that
    /// finished before the column existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_kind: Option<String>,
    /// `WorkTaskPreflight` snapshot (acceptance red/green light), if a
    /// preflight command ran for this review.
    pub preflight: Option<serde_json::Value>,
    /// The merge this reviewed task is waiting to run — the user clicked merge
    /// while another task of the same project was landing. `None` = not queued.
    /// Carries the options wholesale, not just the instant: the board ranks the
    /// queue by `queued_at`, and reopening the dialog on a queued task has to
    /// show the commit message and worktree choice already parked rather than
    /// silently replacing them with the defaults.
    pub merge_queued: Option<WorkTaskQueuedMerge>,
    pub archived_at: Option<DateTime<Utc>>,
    /// Planned start of a to-do task (`None` = no plan). Cleared the moment the
    /// task is claimed, by the scheduler or by hand.
    pub scheduled_at: Option<DateTime<Utc>>,
    /// Forge provenance ('forge_issue' | 'forge_pr'); `None` = not forge-sourced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<String>,
    /// Canonical source key (`forge::source_key` output), for board deep-links.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_key: Option<String>,
    /// Source snapshot (URL, title, account id …), parsed from the row's JSON.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_meta: Option<serde_json::Value>,
    /// Latest `agent_progress` milestone OF THIS GENERATION (filled by `list`
    /// for live tasks only — the card's realtime progress line). Scoped by
    /// `run_seq`: a retry, a follow-up and a merge each start a new one, and
    /// the previous round's last milestone is not this round's news.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_progress: Option<String>,
    /// This generation is parked on its pre-prompt context compaction — the
    /// agent is working, but on shrinking the session rather than on the task.
    /// Filled by `list` alongside `latest_progress`, and the only thing that
    /// explains a card sitting in `preparing`/`merging` for minutes.
    #[serde(default)]
    pub compacting: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub settled_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
}

/// One timeline entry of a task (append-only; see `work_task_event`).
#[derive(Debug, Clone, Serialize)]
pub struct WorkTaskEventInfo {
    pub id: i32,
    pub task_id: i32,
    pub kind: String,
    pub actor: String,
    pub payload: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
}

/// Create/update payload — the editor loads the whole task and saves it back
/// wholesale (title + captured composer config).
///
/// Deliberately has NO source field: forge provenance can only be minted by
/// the forge trigger command (which validates repo ownership and builds the
/// untrusted-data envelope server-side). A client-supplied draft must never be
/// able to forge it — the service takes provenance as a separate internal
/// parameter instead.
#[derive(Debug, Clone, Deserialize)]
pub struct WorkTaskDraft {
    pub folder_id: i32,
    pub title: String,
    pub config: serde_json::Value,
}

/// Internal-only forge provenance handed to `work_task_service::create` by the
/// trigger command. Not a wire type: it never appears in any request DTO.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkTaskSource {
    /// 'forge_issue' | 'forge_pr'
    pub kind: String,
    /// Canonical key from `forge::source_key` — recomputed server-side.
    pub key: String,
    /// `ForgeSourceMeta` as JSON (URL, title, account id, PR head/base …).
    pub meta: serde_json::Value,
}

/// Wire DTO for a saved task template: a display name plus the title seed and
/// the same opaque `WorkTaskConfig` snapshot a task row stores.
#[derive(Debug, Clone, Serialize)]
pub struct WorkTaskTemplateInfo {
    pub id: i32,
    pub name: String,
    pub title: String,
    pub config: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Save payload for a template. Saving under an existing name updates that
/// template in place (upsert by exact name).
#[derive(Debug, Clone, Deserialize)]
pub struct WorkTaskTemplateDraft {
    pub name: String,
    pub title: String,
    pub config: serde_json::Value,
}

/// The structured shape stored inside `work_task.config`. Kept tolerant
/// (`#[serde(default)]`) so an older/newer snapshot still deserializes. Empty
/// optional fields inherit the folder's `WorkTaskFolderSettings` at launch —
/// the actually-effective values are recorded on a `config_effective` audit
/// event instead of being frozen here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkTaskConfig {
    #[serde(default)]
    pub prompt_blocks: Vec<serde_json::Value>,
    #[serde(default)]
    pub display_text: String,
    /// Per-task agent override. `None` = inherit folder settings.
    #[serde(default)]
    pub agent_type: Option<String>,
    #[serde(default)]
    pub mode_id: Option<String>,
    #[serde(default)]
    pub config_values: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub label_snapshot: Option<serde_json::Value>,
    /// What the task's original work order produces. `Some("report")` marks a
    /// task whose first turn delivers findings in the reply rather than code
    /// changes (forge "plan first" / "review only" scenarios);
    /// the engine swaps the worktree guard's commit licence to match. `None`
    /// or an unrecognized value reads as a normal change-producing task — a
    /// config written by a newer build must still launch here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deliverable: Option<String>,
    /// The branch this task is FOR: its worktree branches from that branch's
    /// tip, and the merge lands back onto it. `None` — every task created
    /// before this existed included — keeps the original behaviour: whatever
    /// the project folder is checked out on when the task is claimed. A
    /// pull-request task ignores it; its base comes from the pull request.
    ///
    /// Only the request lives here. The branch actually used is recorded on
    /// `work_task.base_branch` when the worktree is created, and everything
    /// downstream (merge, delivery, diff baseline) reads that column — so
    /// editing this afterwards cannot re-base a task that already ran.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
}

/// The one recognized [`WorkTaskConfig::deliverable`] value.
pub const DELIVERABLE_REPORT: &str = "report";

/// Per-folder defaults stored in `work_task_settings.config`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkTaskFolderSettings {
    /// `None` → fall back to `folder.default_agent_type`.
    #[serde(default)]
    pub default_agent_type: Option<String>,
    #[serde(default)]
    pub mode_id: Option<String>,
    #[serde(default)]
    pub config_values: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub label_snapshot: Option<serde_json::Value>,
    /// P1: the scheduler claims due todos automatically. Stored now, hidden in
    /// the P0 UI.
    #[serde(default)]
    pub auto_process: bool,
    /// Max concurrently active tasks per folder; 0 = unlimited.
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent: i32,
    /// "squash" (default) | "merge"
    #[serde(default = "default_merge_strategy")]
    pub merge_strategy: String,
    /// Land reviewed tasks automatically: when a task settles into review and
    /// is actually mergeable (something to land, live worktree, preflight —
    /// when configured — green, no earlier merge failure on the row), the
    /// engine dispatches the same merge a click on the button would, with the
    /// agent writing the commit message and `delete_worktree_default` deciding
    /// the worktree.
    #[serde(default)]
    pub auto_merge: bool,
    /// Merge dialog's "delete worktree after merge" default.
    #[serde(default = "default_true")]
    pub delete_worktree_default: bool,
    /// Directory new task worktrees are created IN — each one still gets its
    /// own `<repo>-task-<id>` directory under it. `None`/blank keeps the
    /// historical layout: right next to the project folder. `~` expands to the
    /// home directory and a relative path resolves against the project folder,
    /// so a typed value behaves like it reads.
    #[serde(default)]
    pub worktree_root: Option<String>,
    /// P2: `folder_command` id run in the worktree when a task settles into
    /// review — the acceptance red/green light. `None` = no preflight.
    #[serde(default)]
    pub preflight_command_id: Option<i32>,
    /// Free-form preflight shell line; takes precedence over
    /// `preflight_command_id` when non-empty.
    #[serde(default)]
    pub preflight_command: Option<String>,
    /// Shell line run inside a freshly created worktree before the agent
    /// starts (deps install, env seeding). Not re-run on reused worktrees.
    #[serde(default)]
    pub init_command: Option<String>,
    /// Context-window occupancy (percent, 0–100) at or above which a launch
    /// that RESUMES the task's session compacts before it prompts: the engine
    /// sends [`Self::compact_command`], waits for that turn to finish, and only
    /// then sends the round's own message. `0` (the default) disables the whole
    /// check — nothing is measured and no extra turn is ever sent.
    ///
    /// Only resumed launches (retry / follow-up / merge) are eligible: a fresh
    /// session starts empty, so there is nothing to compact.
    #[serde(default)]
    pub auto_compact_percent: i32,
    /// The command sent to compact, verbatim (e.g. `/compact`). Blank/`None`
    /// resolves per agent — see `work_task::compact::resolve_compact_command`
    /// — which is why this is an override rather than a required setting.
    #[serde(default)]
    pub compact_command: Option<String>,
    /// User-authored instructions appended *after* the built-in prompt of a
    /// launch stage — project conventions or personal preferences the standard
    /// wording can't cover. Keys are the stage identifiers the engine already
    /// stamps on its `round` events (`work` / `retry` / `return` / `merge`),
    /// plus the reserved key `all`, which is appended to every stage. Unknown
    /// keys are ignored, so a future stage needs no schema change.
    #[serde(default)]
    pub stage_prompts: std::collections::BTreeMap<String, String>,
}

impl Default for WorkTaskFolderSettings {
    fn default() -> Self {
        Self {
            default_agent_type: None,
            mode_id: None,
            config_values: Default::default(),
            label_snapshot: None,
            auto_process: false,
            max_concurrent: default_max_concurrent(),
            merge_strategy: default_merge_strategy(),
            auto_merge: false,
            delete_worktree_default: true,
            worktree_root: None,
            preflight_command_id: None,
            preflight_command: None,
            init_command: None,
            auto_compact_percent: 0,
            compact_command: None,
            stage_prompts: Default::default(),
        }
    }
}

/// Reserved `stage_prompts` key whose text is appended to every launch stage.
pub const STAGE_PROMPT_ALL: &str = "all";

/// What the user means by a follow-up on a reviewed task. The board offers one
/// neutral "follow up" action; the intent picks the wording the agent actually
/// receives, because "have another look at this" and "why did you do it that
/// way?" call for opposite behaviour from the same text box.
///
/// Deliberately NOT a stored column: an intent only ever shapes one prompt, so
/// it lives in the launch mode and on the `user_action` / `round` timeline
/// events. `round_kind()` stays `"return"` for every intent, so the folder's
/// per-stage prompt settings keep their four stages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FollowUpIntent {
    /// Review feedback to act on — the historical "return" behaviour, and the
    /// default so an unlabelled follow-up keeps composing exactly as before.
    #[default]
    Revise,
    /// The work so far stands; extend it.
    Continue,
    /// A question about the work. Answering must not touch the worktree.
    Question,
    /// Re-check the work before acceptance. Complete on its own, so it is the
    /// one intent that may be sent without any text.
    Verify,
}

impl FollowUpIntent {
    pub fn as_str(self) -> &'static str {
        match self {
            FollowUpIntent::Revise => "revise",
            FollowUpIntent::Continue => "continue",
            FollowUpIntent::Question => "question",
            FollowUpIntent::Verify => "verify",
        }
    }

    /// Whether this intent is a complete instruction without user text.
    pub fn allows_empty(self) -> bool {
        matches!(self, FollowUpIntent::Verify)
    }

    /// Decode a wire value. Absent → `Revise` (older clients, and the value the
    /// historical behaviour corresponds to); an unrecognized string is an error
    /// rather than a silent fallback, so a typo surfaces instead of quietly
    /// composing the wrong prompt.
    pub fn from_wire(value: Option<&str>) -> Result<Self, String> {
        match value {
            None => Ok(FollowUpIntent::Revise),
            Some("revise") => Ok(FollowUpIntent::Revise),
            Some("continue") => Ok(FollowUpIntent::Continue),
            Some("question") => Ok(FollowUpIntent::Question),
            Some("verify") => Ok(FollowUpIntent::Verify),
            Some(other) => Err(format!("unknown follow-up intent: {other}")),
        }
    }
}

fn default_max_concurrent() -> i32 {
    2
}

fn default_merge_strategy() -> String {
    "squash".to_string()
}

fn default_true() -> bool {
    true
}

/// What a `merging` row is actually doing. The status is shared because both
/// operations are "in flight, not cancelable, settles by itself"; everything
/// past that differs, so recovery must read this before it touches any
/// operation-specific field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkTaskMergeOp {
    /// Land on the base branch, driven by the agent in its session. The
    /// historical (and still default) meaning of `merging`, which is why
    /// `#[default]` sits here: every merge state written before this field
    /// existed is a land.
    #[default]
    Land,
    /// Push the work branch to the source forge and open/adopt a pull request.
    /// Executed deterministically by the engine — no agent, no session.
    DeliverPr,
}

/// The in-flight intent persisted (as JSON in `work_task.merge_state`) in the
/// same transaction as the review→merging CAS.
///
/// For `op = Land` the merge is performed by the agent in its session and the
/// engine settles from git truth against `pre_merge_head` (base advanced + work
/// content contained), never from the agent's word.
///
/// For `op = DeliverPr` the engine does the work itself and settles from the
/// forge's answer, anchored on `expected_head`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkTaskMergeState {
    /// Which operation is in flight. Absent in every row written before
    /// delivery existed — those are all lands, which is what the default says.
    #[serde(default)]
    pub op: WorkTaskMergeOp,
    /// Land only: project-folder HEAD right before the merge generation was
    /// dispatched. Empty on a delivery, which never touches the base branch —
    /// and an empty value can never be mistaken for a real HEAD, so a
    /// misrouted delivery reads as "did not land" and bounces to review.
    #[serde(default)]
    pub pre_merge_head: String,
    /// Land only: the commit message the agent is told to use ("" when
    /// auto-generated).
    #[serde(default)]
    pub message: String,
    /// Land only: "squash" | "merge"
    #[serde(default)]
    pub strategy: String,
    /// Whether the user asked to delete the worktree after landing — persisted
    /// so crash recovery can honor the choice when it back-fills `done`.
    #[serde(default)]
    pub delete_worktree: bool,
    /// The agent writes the commit message itself (`message` is empty then).
    #[serde(default)]
    pub auto_message: bool,
    /// Land only: free-form instructions the user typed for THIS landing (how
    /// to resolve conflicts, what else to touch on the way). Persisted with the
    /// rest of the dispatch so a merge generation relaunched from this row is
    /// told the same thing the first one was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// Delivery only: the branch name pushed to the source repository.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_branch: Option<String>,
    /// Delivery only: the work-branch commit OID recorded BEFORE the push —
    /// the anchor crash recovery matches a pull request against. Without it,
    /// recovery could adopt a same-named branch's unrelated PR.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_head: Option<String>,
    /// Delivery only: the title the user gave the pull request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_title: Option<String>,
    /// Delivery only: open the pull request as a draft.
    #[serde(default)]
    pub draft: bool,
}

/// A merge the user asked for while the folder's one merge slot was busy,
/// parked as JSON in `work_task.pending_merge` and dispatched by the folder's
/// merge pump when the slot frees. Merges into one base branch can only run one
/// at a time, so the queue is what lets a user accept a whole review column in
/// one pass instead of babysitting each landing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkTaskQueuedMerge {
    /// The commit message the user typed; `None` = the agent writes it.
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub delete_worktree: bool,
    /// Extra instructions for the merge agent, kept with the parked intent so a
    /// merge that waited its turn lands under the same directions the user gave
    /// when they queued it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    /// When the task took its place in line — the pump's ordering key, kept
    /// across a re-queue so changing the options doesn't jump the line.
    pub queued_at: DateTime<Utc>,
}

/// Outcome of the folder's preflight command for one review generation,
/// serialized into `work_task.preflight` (and mirrored on the wire verbatim).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkTaskPreflight {
    /// "running" | "passed" | "failed"
    pub status: String,
    /// Display name of the folder command that ran.
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// Trailing combined output (capped) — shown when the light is red.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tail: Option<String>,
}

/// Changed file of a task worktree vs. its recorded base (`git diff --numstat`).
#[derive(Debug, Clone, Serialize)]
pub struct WorkTaskChangedFile {
    pub file: String,
    pub additions: i32,
    pub deletions: i32,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Settings rows written before stage prompts existed must keep decoding —
    /// the column is one JSON blob, so a missing key is the migration.
    #[test]
    fn legacy_settings_json_decodes_without_stage_prompts() {
        let legacy = r#"{
            "default_agent_type": "claude_code",
            "mode_id": null,
            "config_values": {},
            "auto_process": true,
            "max_concurrent": 3,
            "merge_strategy": "merge",
            "delete_worktree_default": false,
            "init_command": "pnpm install",
            "forge_writeback": true
        }"#;
        // `forge_writeback` above is a RETIRED key: the write-back choice moved
        // onto each task's own source metadata (the trigger dialog asks per work
        // item). A folder configured while it existed must still decode, and the
        // stale value must not resurrect itself anywhere.
        let settings: WorkTaskFolderSettings =
            serde_json::from_str(legacy).expect("legacy settings decode");
        assert!(settings.stage_prompts.is_empty());
        assert!(!settings.auto_merge);
        assert_eq!(settings.max_concurrent, 3);
        assert_eq!(settings.merge_strategy, "merge");
        assert!(settings.auto_process);
        assert!(!settings.delete_worktree_default);
        assert_eq!(settings.init_command.as_deref(), Some("pnpm install"));
    }
}
