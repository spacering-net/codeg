//! Live ACP session titles.
//!
//! Agents publish a session name through `session_info_update.title`. Codeg
//! used to ignore that field and only adopt a title the next time the
//! conversation was loaded from disk. These helpers extract a usable title
//! from the live notification so the lifecycle worker can write it immediately.
//!
//! Not every agent can push, and Claude Code could not until recently: through
//! claude-agent-acp 0.72.0 its adapter had no wire event for the generated
//! title — it read the name back out of the session file at turn-end — so
//! `acp::background_watch` reads the same `ai-title` / `custom-title` records
//! off the transcript it is already tailing and hands them to
//! [`publish_native_title`], which is the one place that decides whether a
//! title reaches the lifecycle worker.
//!
//! 0.73.0 adds the wire event (`session-titles.js`: Claude Code's own
//! auto-titling never arms under the Agent SDK, so the adapter now asks the CLI
//! via `generate_session_title` and publishes the result as
//! `session_info_update.title`). The CLI stores that title in the session file
//! as an `ai-title` record, which the watcher reads like any other.
//!
//! For Claude the wire is NOT a second producer while codeg can read the
//! transcript ([`accept_wire_title`], [`release_held_wire_title`]). The
//! adapter publishes what the Agent SDK reports for the session: its custom or
//! AI title when it has one, else its `summary`, which is the newest
//! `last-prompt` record (then a summary record, then the first prompt), every
//! value collapsed and cut by its `sanitizeTitle`. codeg's history parser,
//! on every detail fetch, titles an untitled session by its first prompt
//! (reference links folded), and neither it nor the transcript watcher
//! (`acp::background_watch`, which reads only `custom-title` and `ai-title`
//! records) collapses a stored title's spacing. So whenever the CLI cannot
//! generate a title, as through a gateway that refuses the title request,
//! adopting the wire title made it and the next detail fetch write different
//! names in turn: the sidebar row and a bound chat-channel topic flipped after
//! the first turn and again after a resume. (qqq) of the Claude Code entry in
//! `acp::registry` has the measurement. Every other title the wire reports is
//! a transcript record too (the CLI appends a custom title before it writes
//! its sidecar copy, and stores a generated one as an `ai-title` record), so
//! dropping the wire title loses nothing while the transcript can be read.
//!
//! Each connection therefore has one live title writer: the notification loop
//! for every other agent, the watcher's task for Claude (its transcript titles
//! and, while it reads no transcript, the held wire title).

use std::sync::Arc;

use tokio::sync::RwLock;

use crate::acp::session_state::SessionState;
use crate::acp::types::AcpEvent;
use crate::models::agent::AgentType;
use crate::web::event_bridge::{emit_with_state, EventEmitter};

/// Pull a usable session title out of ACP `session_info_update.title`.
///
/// `Undefined` (passed in as `None`) means the update did not touch the title
/// and is ignored. The schema also uses `Null` to mean "clear"; we treat that
/// the same as absent on purpose so an explicit clear cannot wipe the row
/// back to Untitled. Whitespace-only strings are ignored for the same reason.
///
/// The rest of the normalization is the transcript reader's
/// (`parsers::claude::displayed_session_title`, which also drops JetBrains
/// AIR's archive marker), so a title reads the same whichever producer
/// delivers it. For Claude that no longer keeps two live producers equal: its
/// wire title reaches the row only while no transcript reader titles the
/// session ([`accept_wire_title`]).
/// `parsers::codex::codex_thread_title` reads a codex thread name through
/// this function too, after collapsing it as codex-acp does, so a change here
/// moves both codex producers together.
pub(crate) fn native_title_from_session_info(title: Option<&str>) -> Option<String> {
    crate::parsers::claude::displayed_session_title(title?)
}

/// The title `agent_type` published in `session_info_update.title`, as codeg
/// shows it: [`native_title_from_session_info`], except for Kimi Code. Kimi's
/// history parser reads the same title off `state.json` and cuts off the
/// attachments Kimi wrote into it
/// (`parsers::kimi_code::displayed_session_title`). The wire copy has to be
/// cut the same way before it is shortened, or the row is renamed each time
/// one of the two writes it.
pub(crate) fn wire_title(agent_type: AgentType, title: Option<&str>) -> Option<String> {
    match agent_type {
        AgentType::KimiCode => crate::parsers::kimi_code::displayed_session_title(title?),
        _ => native_title_from_session_info(title),
    }
}

/// Take a title an agent published in `session_info_update.title`, already
/// normalized by [`native_title_from_session_info`].
///
/// Every agent but Claude Code has it published at once
/// ([`publish_native_title`]). Claude Code's is held on the session state
/// instead, a newer one replacing it, and the transcript watcher is woken to
/// settle it on an immediate poll ([`release_held_wire_title`]): while codeg
/// can read the transcript, the transcript is the title's only source (see
/// the module docs).
pub(crate) async fn accept_wire_title(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    agent_type: AgentType,
    title: String,
) {
    if agent_type == AgentType::ClaudeCode {
        let mut s = state.write().await;
        s.held_wire_title = Some(title);
        s.wire_title_wake.notify_one();
        return;
    }
    publish_native_title(state, emitter, title).await;
}

/// Settle the Claude title [`accept_wire_title`] held, after a poll of the
/// transcript watcher.
///
/// `reads_transcript`: the watcher has the session's transcript and its last
/// read of it succeeded. Its `custom-title` / `ai-title` records then title
/// the session, read by the watcher and by the history parser alike, and the
/// held title is dropped. Otherwise no transcript reader titles the session,
/// as when the agent writes to a Claude config dir set only in its own
/// environment, which codeg's readers never look in, or when the file cannot
/// be read. The held title is then published, once the row is bound: until
/// then it stays held, as the watcher's own titles do, since the adapter
/// publishes a title only when it changes.
pub(crate) async fn release_held_wire_title(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    reads_transcript: bool,
) {
    let (held, bound) = {
        let s = state.read().await;
        (s.held_wire_title.is_some(), s.conversation_id.is_some())
    };
    if !held || (!reads_transcript && !bound) {
        return;
    }
    let Some(title) = state.write().await.held_wire_title.take() else {
        return;
    };
    if !reads_transcript {
        publish_native_title(state, emitter, title).await;
    }
}

/// Emit `title` as this connection's live session title, unless it is a repeat
/// of the last one emitted here.
///
/// Test and set under ONE write lock. Each connection has one live title
/// writer today (the notification loop, or for Claude the transcript watcher's
/// task; see the module docs), so the single critical section is defensive:
/// it keeps "only a CHANGED title gets through" true by construction, not by
/// callers that happen not to overlap, should a second writer ever publish
/// for the same connection. What it would not order is the `emit` after it:
/// two writers admitting different strings could broadcast in the opposite
/// order, which the next detail fetch (a re-resolve of the whole file)
/// repairs.
///
/// The other writer of `last_native_title` is the `ConversationLinked` arm,
/// which is emitted ONLY while the row is still unbound and therefore can never
/// race a title this admits.
///
/// A title published before the first prompt binds the row has nowhere to land
/// and is dropped WITHOUT being remembered, so the same string is still
/// accepted once the row exists.
///
/// The emitted `NativeSessionTitle` reaches `acp::lifecycle`, whose
/// `refresh_auto_title` write is itself a no-op on a user-renamed
/// (`title_locked`) row and on an unchanged value — so repeats that do get
/// past the skip-cache still cost nothing and can never overwrite a name the
/// user chose.
pub(crate) async fn publish_native_title(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    title: String,
) {
    let admit = {
        let mut s = state.write().await;
        let admit = s.conversation_id.is_some()
            && s.last_native_title.as_deref() != Some(title.as_str());
        if admit {
            s.last_native_title = Some(title.clone());
        }
        admit
    };
    if admit {
        emit_with_state(state, emitter, AcpEvent::NativeSessionTitle { title }).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        accept_wire_title, native_title_from_session_info, publish_native_title,
        release_held_wire_title, wire_title,
    };
    use crate::acp::session_state::SessionState;
    use crate::acp::types::AcpEvent;
    use crate::models::agent::AgentType;
    use crate::web::event_bridge::EventEmitter;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn title_state(conversation_id: Option<i32>) -> Arc<RwLock<SessionState>> {
        agent_title_state(AgentType::ClaudeCode, conversation_id)
    }

    fn agent_title_state(
        agent_type: AgentType,
        conversation_id: Option<i32>,
    ) -> Arc<RwLock<SessionState>> {
        let mut st = SessionState::new(
            "conn-title".to_string(),
            agent_type,
            None,
            "win".to_string(),
            None,
        );
        st.conversation_id = conversation_id;
        Arc::new(RwLock::new(st))
    }

    async fn held(state: &Arc<RwLock<SessionState>>) -> Option<String> {
        state.read().await.held_wire_title.clone()
    }

    /// `title` as claude-agent-acp would publish it on this connection.
    async fn claude_publishes(state: &Arc<RwLock<SessionState>>, title: &str) {
        accept_wire_title(
            state,
            &EventEmitter::Noop,
            AgentType::ClaudeCode,
            title.into(),
        )
        .await;
    }

    /// Titles emitted on this connection so far, oldest first.
    async fn emitted(state: &Arc<RwLock<SessionState>>) -> Vec<String> {
        state
            .read()
            .await
            .recent_events_after(0)
            .unwrap_or_default()
            .iter()
            .filter_map(|e| match &e.payload {
                AcpEvent::NativeSessionTitle { title } => Some(title.clone()),
                _ => None,
            })
            .collect()
    }

    /// Kimi's title carries the attachments codeg sent. Cut before it is
    /// shortened, the live title is the one Kimi's history parser reads off
    /// `state.json`; shortened first, it kept the start of the attachment.
    #[test]
    fn kimi_wire_title_is_cut_before_it_is_shortened() {
        let typed = "p".repeat(90);
        let published =
            format!("{typed} <resource uri=\"https://a.test/\">Captured from a web page");
        assert_eq!(
            wire_title(AgentType::KimiCode, Some(&published)).as_deref(),
            Some(typed.as_str())
        );
        assert_eq!(
            wire_title(AgentType::KimiCode, Some(&published)),
            crate::parsers::kimi_code::displayed_session_title(&published)
        );
        // Every other agent's title is read as before.
        assert_eq!(
            wire_title(AgentType::Codex, Some(&published)),
            native_title_from_session_info(Some(&published))
        );
        assert_eq!(wire_title(AgentType::KimiCode, None), None);
    }

    /// The skip-cache is what keeps repeats cheap: Claude Code
    /// re-emits its `ai-title` record throughout a session (228 identical
    /// copies in one observed transcript) and CodeBuddy re-pushes its fallback
    /// after every prompt. Only a CHANGED name may reach the lifecycle worker.
    #[tokio::test]
    async fn only_a_changed_title_is_emitted() {
        let state = title_state(Some(7));

        publish_native_title(&state, &EventEmitter::Noop, "Fix the login flow".into()).await;
        publish_native_title(&state, &EventEmitter::Noop, "Fix the login flow".into()).await;
        publish_native_title(&state, &EventEmitter::Noop, "Fix the signup flow".into()).await;

        assert_eq!(
            emitted(&state).await,
            vec![
                "Fix the login flow".to_string(),
                "Fix the signup flow".to_string()
            ]
        );
    }

    /// A title published before the first prompt binds the row has nowhere to
    /// land, so it is dropped — and deliberately NOT remembered, or the retry
    /// that follows `ConversationLinked` would be swallowed and the row would
    /// keep its fallback name for the rest of the connection.
    #[tokio::test]
    async fn a_title_dropped_while_unbound_does_not_poison_the_cache() {
        let state = title_state(None);

        publish_native_title(&state, &EventEmitter::Noop, "Fix the login flow".into()).await;
        assert!(emitted(&state).await.is_empty(), "no row to write to yet");
        assert!(
            state.read().await.last_native_title.is_none(),
            "a dropped title must not poison the skip-cache"
        );

        state
            .write()
            .await
            .apply_event(&AcpEvent::ConversationLinked {
                conversation_id: 7,
                folder_id: 1,
                parent_conversation_id: None,
                parent_tool_use_id: None,
            });

        publish_native_title(&state, &EventEmitter::Noop, "Fix the login flow".into()).await;
        assert_eq!(
            emitted(&state).await,
            vec!["Fix the login flow".to_string()],
            "the same title must be accepted once the row exists"
        );
    }

    /// What claude-agent-acp 0.89.1 published after the first turn of a
    /// session whose title the CLI could not generate: the session's
    /// `last-prompt` record, collapsed, link markup and all. The history parser
    /// reads that session's first prompt instead, so writing this would flip
    /// the row on every detail fetch. It is held, never written, and the
    /// newest one held replaces the last.
    #[tokio::test]
    async fn a_claude_wire_title_is_held_not_published() {
        let state = title_state(Some(7));
        let fallback = "Fix the login flow please look at [auth.ts](file:///tmp/auth.ts) first";

        claude_publishes(&state, fallback).await;
        assert!(emitted(&state).await.is_empty());
        assert_eq!(held(&state).await.as_deref(), Some(fallback));

        let after_resume = "and one more turn after resume";
        claude_publishes(&state, after_resume).await;
        assert!(emitted(&state).await.is_empty());
        assert_eq!(held(&state).await.as_deref(), Some(after_resume));
        assert!(state.read().await.last_native_title.is_none());
    }

    /// Only Claude Code's titles are held: every other agent's wire title is
    /// its only live one (none has a transcript watcher), so it is written at
    /// once.
    #[tokio::test]
    async fn another_agents_wire_title_is_published_at_once() {
        for agent_type in [AgentType::Codex, AgentType::CodeBuddy, AgentType::Qoder] {
            let state = agent_title_state(agent_type, Some(7));
            accept_wire_title(&state, &EventEmitter::Noop, agent_type, "Fix login".into()).await;
            assert_eq!(
                emitted(&state).await,
                vec!["Fix login".to_string()],
                "{agent_type:?}"
            );
            assert!(held(&state).await.is_none(), "{agent_type:?}");
        }
    }

    /// Holding a Claude title wakes the transcript watcher, which settles it
    /// on an immediate poll instead of up to a poll interval later. Nothing
    /// is held, and nothing woken, for any other agent.
    #[tokio::test]
    async fn holding_a_claude_title_wakes_the_watcher() {
        let wait = std::time::Duration::from_millis(200);

        let state = title_state(Some(7));
        let wake = Arc::clone(&state.read().await.wire_title_wake);
        claude_publishes(&state, "Fix").await;
        assert!(
            tokio::time::timeout(wait, wake.notified()).await.is_ok(),
            "the watcher must be woken"
        );

        let state = agent_title_state(AgentType::Codex, Some(7));
        let wake = Arc::clone(&state.read().await.wire_title_wake);
        accept_wire_title(&state, &EventEmitter::Noop, AgentType::Codex, "Fix".into()).await;
        assert!(tokio::time::timeout(wait, wake.notified()).await.is_err());
    }

    /// While the watcher reads the transcript, its records title the session,
    /// so a held wire title is dropped, bound row or not.
    #[tokio::test]
    async fn a_held_title_is_dropped_while_the_watcher_reads_the_transcript() {
        for conversation_id in [Some(7), None] {
            let state = title_state(conversation_id);
            claude_publishes(&state, "Fix").await;

            release_held_wire_title(&state, &EventEmitter::Noop, true).await;

            assert!(emitted(&state).await.is_empty(), "{conversation_id:?}");
            assert!(held(&state).await.is_none(), "{conversation_id:?}");
        }
    }

    /// With no transcript to read, the wire is the only title codeg gets, so
    /// the held one is published, once.
    #[tokio::test]
    async fn a_held_title_is_published_when_no_transcript_can_be_read() {
        let state = title_state(Some(7));
        claude_publishes(&state, "Fix").await;

        release_held_wire_title(&state, &EventEmitter::Noop, false).await;
        release_held_wire_title(&state, &EventEmitter::Noop, false).await;

        assert_eq!(emitted(&state).await, vec!["Fix".to_string()]);
        assert!(held(&state).await.is_none());
    }

    /// The adapter publishes a title only when it changes, so one that comes
    /// before the row is bound is kept until the row exists rather than lost.
    #[tokio::test]
    async fn a_held_title_waits_for_the_row_when_no_transcript_can_be_read() {
        let state = title_state(None);
        claude_publishes(&state, "Fix").await;

        release_held_wire_title(&state, &EventEmitter::Noop, false).await;
        assert!(emitted(&state).await.is_empty());
        assert_eq!(held(&state).await.as_deref(), Some("Fix"));

        state
            .write()
            .await
            .apply_event(&AcpEvent::ConversationLinked {
                conversation_id: 7,
                folder_id: 1,
                parent_conversation_id: None,
                parent_tool_use_id: None,
            });
        release_held_wire_title(&state, &EventEmitter::Noop, false).await;

        assert_eq!(emitted(&state).await, vec!["Fix".to_string()]);
        assert!(held(&state).await.is_none());
    }

    #[test]
    fn rejects_missing_and_blank() {
        assert_eq!(native_title_from_session_info(None), None);
        assert_eq!(native_title_from_session_info(Some("")), None);
        assert_eq!(native_title_from_session_info(Some("   ")), None);
        assert_eq!(native_title_from_session_info(Some("\n\t")), None);
    }

    #[test]
    fn trims_and_keeps_a_real_title() {
        assert_eq!(
            native_title_from_session_info(Some("  Fix login flow  ")).as_deref(),
            Some("Fix login flow")
        );
    }

    /// JetBrains AIR archives a Claude session by prefixing its stored title
    /// with `[archived] `; claude-agent-acp 0.89.0 drops one such marker from
    /// the title it publishes to codeg, and an older adapter does not. Either
    /// way codeg shows the title without any, by AIR's own rule.
    #[test]
    fn drops_the_air_archive_markers() {
        for (raw, shown) in [
            ("[archived] Fix login flow", "Fix login flow"),
            ("  [archived]\t\n Fix login flow ", "Fix login flow"),
            ("[archived] [archived] Fix login flow", "Fix login flow"),
            ("[archived] [archived]", "[archived]"),
            // Not a marker: nothing after it, or no white space before the title.
            ("[archived]", "[archived]"),
            ("[archived]   ", "[archived]"),
            ("[archived]Fix login flow", "[archived]Fix login flow"),
            ("Fix [archived] login flow", "Fix [archived] login flow"),
        ] {
            assert_eq!(
                native_title_from_session_info(Some(raw)).as_deref(),
                Some(shown),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn caps_at_parser_title_length() {
        let long = "a".repeat(150);
        let got = native_title_from_session_info(Some(&long)).unwrap();
        assert_eq!(got, crate::parsers::truncate_str(&long, 100));
        assert!(got.ends_with("..."));
    }

    /// The wire's normalization is the transcript reader's, so a title reads
    /// the same whichever producer delivers it.
    ///
    /// A Claude wire title no longer races the transcript readers to the row
    /// (it is held while they can read the transcript, see
    /// `a_claude_wire_title_is_held_not_published`), but the rule stays one:
    /// the held title published when no transcript can be read reads as the
    /// transcript would have, and codex's two producers
    /// (`parsers::codex::codex_thread_title`) share this function. Note that
    /// the same raw string goes to both sides here: what claude-agent-acp
    /// sends is its `sanitizeTitle` of the record, collapsed, which is why the
    /// wire cannot be a second Claude producer.
    ///
    /// Asserting against the transcript helper rather than a literal is the
    /// point — a future change to either cap has to change both.
    #[test]
    fn agrees_with_the_transcript_producer_on_normalization() {
        for raw in [
            "  Fix login flow  ",
            "a",
            &"b".repeat(100),
            &"c".repeat(101),
            &format!("  {}  ", "d".repeat(150)),
            "[archived] Fix login flow",
            "[archived] [archived] Fix login flow",
            "[archived]\u{3000}Fix login flow",
            "[archived] \u{3000}Fix login flow",
            &format!("[archived] {}", "e".repeat(150)),
        ] {
            for (record_type, field) in [("ai-title", "aiTitle"), ("custom-title", "customTitle")] {
                let record = serde_json::json!({ "type": record_type, field: raw });
                let (mut custom, mut ai) = (None, None);
                crate::parsers::claude::capture_title_record(
                    &record,
                    record_type,
                    &mut custom,
                    &mut ai,
                );
                assert_eq!(
                    native_title_from_session_info(Some(raw)),
                    custom.or(ai),
                    "wire and transcript producers disagree on {raw:?} ({record_type})"
                );
            }
        }
    }

    /// claude-agent-acp 0.89.0 removes one archive marker before it publishes,
    /// so the wire hands codeg the transcript's title minus that marker. A
    /// held wire title reads like the transcript's only if normalizing a
    /// normalized title changes nothing: the record keeps
    /// `[archived] [archived] X`, the wire carries `[archived] X`, and both
    /// must read `X`.
    #[test]
    fn a_title_the_adapter_already_unmarked_reads_the_same() {
        let record = serde_json::json!({
            "type": "custom-title",
            "customTitle": "[archived] [archived] Fix login flow",
        });
        let (mut custom, mut ai) = (None, None);
        crate::parsers::claude::capture_title_record(&record, "custom-title", &mut custom, &mut ai);
        let published_by_0_89 = "[archived] Fix login flow";
        assert_eq!(
            native_title_from_session_info(Some(published_by_0_89)),
            custom
        );
        assert_eq!(custom.as_deref(), Some("Fix login flow"));

        for raw in [
            "[archived] Fix login flow",
            "[archived] [archived] Fix login flow",
            "[archived]",
            "[archived] [archived]",
            "  [archived]\t\u{3000}Fix  ",
            &format!("[archived] {}", "f".repeat(150)),
        ] {
            let once = native_title_from_session_info(Some(raw)).expect("a title");
            assert_eq!(
                native_title_from_session_info(Some(&once)).as_deref(),
                Some(once.as_str()),
                "{raw:?}"
            );
        }
    }
}
