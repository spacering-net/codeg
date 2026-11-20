//! The team as the assistants read it (§1.1, §4.2): one line per assistant —
//! its number, its name and the head of its persona, read from the first
//! line of the `SOUL.md` in its working directory as it is (a heading
//! included, line breaks folded into spaces), marked when it is the reader
//! itself, hidden, or has no persona written yet.
//!
//! The handoff card and the state card carry the list; a delivery whose
//! session was last given another list carries the new one whole
//! (`team-update`), told by the team's digest on the segment.

use super::engine::{text_digest, PersonalAgentEngine};
use super::messages::display_name;
use super::workdir;
use crate::db::entities::personal_agent::BotKind;
use crate::db::service::personal_agent_service as svc;

/// How much of a persona `bot_list` and `overview` show.
pub const HEAD_LIST_CHARS: usize = 300;
/// How much of a persona the team list in a handoff shows.
pub const HEAD_CARD_CHARS: usize = 200;

/// The head of a persona: from its first line on, as written, line breaks
/// and runs of spaces folded into one space, cut at `max` characters.
pub fn persona_head(soul: &str, max: usize) -> String {
    let folded = soul.split_whitespace().collect::<Vec<_>>().join(" ");
    if folded.chars().count() <= max {
        return folded;
    }
    let mut cut: String = folded.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// Whether a work assistant has no persona written yet: its file is the
/// one it started with (in any language), or none can be read. The
/// primary's own default says what it is.
pub fn unwritten(kind: BotKind, soul: &str) -> bool {
    kind == BotKind::Worker && super::templates::persona_unwritten(soul)
}

/// One assistant of the team.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub id: i32,
    pub name: String,
    pub hidden: bool,
    /// Its persona's head, `HEAD_CARD_CHARS` long.
    pub head: String,
    pub unwritten: bool,
}

/// The team's lines, in number order: the same team writes the same text.
pub fn team_text(members: &[Member], me: i32) -> String {
    let mut lines: Vec<String> = members
        .iter()
        .map(|m| {
            let mut marks = String::new();
            if m.id == me {
                marks.push_str(" (you)");
            }
            if m.hidden {
                marks.push_str(" (hidden)");
            }
            let about = if m.unwritten {
                "(persona not written yet)".to_string()
            } else {
                m.head.clone()
            };
            format!("- #{} {}{marks} — {about}", m.id, m.name)
        })
        .collect();
    if lines.is_empty() {
        lines.push("(nobody yet)".into());
    }
    format!(
        "Who does what is in each one's persona. Do what you can yourself; hand a piece of work \
to the one whose persona names it, or who did work like it lately (`bot_list`), with \
`bot_message` — to one assistant only, never to two at once. When two read alike, or none \
fits, ask the owner rather than guess.\n{}",
        lines.join("\n")
    )
}

/// What the team is, to the reader `me`, as a digest: everyone else's
/// number, name, hidden mark and persona head. Its own persona is the
/// persona digest's.
pub fn team_digest(members: &[Member], me: i32) -> String {
    let mut parts = Vec::new();
    for m in members.iter().filter(|m| m.id != me) {
        parts.push(format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
            m.id, m.name, m.hidden, m.unwritten, m.head
        ));
    }
    text_digest(&parts.join("\u{1e}"))
}

/// The card riding with a delivery after the team changed in the session.
pub fn team_update(text: &str) -> String {
    format!(
        "<codeg-context kind=\"team-update\">\nYour team changed. This list replaces the one you \
had: an assistant not on it was deleted — do not message it any more.\n{text}\n\
</codeg-context>"
    )
}

impl PersonalAgentEngine {
    /// Every assistant of the owner's, in number order, as the team list
    /// shows it.
    pub(super) async fn team(&self) -> Vec<Member> {
        let mut rows = svc::list_bots(&self.db.conn).await.unwrap_or_default();
        rows.sort_by_key(|b| b.id);
        rows.iter()
            .map(|b| {
                let soul = workdir::read_text(&self.workdir_of(b), workdir::SOUL_FILE);
                Member {
                    id: b.id,
                    name: display_name(b),
                    hidden: b.hidden,
                    head: persona_head(&soul, HEAD_CARD_CHARS),
                    unwritten: unwritten(b.kind, &soul),
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: i32, name: &str, head: &str) -> Member {
        Member {
            id,
            name: name.into(),
            hidden: false,
            head: head.into(),
            unwritten: false,
        }
    }

    #[test]
    fn a_persona_head_reads_from_the_first_line_folded_and_cut() {
        let soul = "# Persona\n\nYou fix   CI.\nNot releases.\n";
        assert_eq!(
            persona_head(soul, 300),
            "# Persona You fix CI. Not releases."
        );
        let cut = persona_head(&"a".repeat(400), 300);
        assert_eq!(cut.chars().count(), 300);
        assert!(cut.ends_with('…'));
        assert_eq!(persona_head("", 10), "");
    }

    #[test]
    fn the_team_text_marks_who_reads_it_and_the_unwritten_and_its_digest_leaves_the_reader_out() {
        let mut team = vec![
            member(1, "Nova", "# Persona The owner's primary."),
            member(4, "Dev", "# Persona You fix CI."),
        ];
        team[1].hidden = true;
        let text = team_text(&team, 1);
        assert!(
            text.contains("- #1 Nova (you) — # Persona The owner's primary."),
            "{text}"
        );
        assert!(
            text.contains("- #4 Dev (hidden) — # Persona You fix CI."),
            "{text}"
        );
        let digest = team_digest(&team, 1);
        // Its own persona is not in it.
        team[0].head = "# Persona Changed.".into();
        assert_eq!(team_digest(&team, 1), digest);
        // Another's is, and so is the mark of one not written yet.
        team[1].unwritten = true;
        assert_ne!(team_digest(&team, 1), digest);
        assert!(team_text(&team, 1).contains("#4 Dev (hidden) — (persona not written yet)"));
        team[1].unwritten = false;
        team.push(member(7, "QA", "x"));
        assert_ne!(team_digest(&team, 1), digest);
        assert!(team_update(&team_text(&team, 1)).contains("kind=\"team-update\""));
    }
}
