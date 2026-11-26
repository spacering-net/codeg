//! What the owner is told when something they asked for is refused: an
//! English line for the brain, the logs and an older page, and the key
//! (under the page's `PersonalAgent` messages) and data the page shows it
//! in the owner's language with — the data only (times as RFC 3339, names),
//! never a sentence made here.
//!
//! It turns into and out of a `String`, so the engine's functions that
//! answer with plain words take it as they are; only those whose refusals
//! reach the owner keep the key to the page.

use std::collections::BTreeMap;
use std::fmt;

use chrono::{DateTime, Utc};

/// A refusal, in English and as a key the page words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub message: String,
    pub key: Option<&'static str>,
    pub params: BTreeMap<String, String>,
}

impl Refusal {
    /// A refusal the page words by `key` (`PersonalAgent.<key>`).
    pub fn new(key: &'static str, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            key: Some(key),
            params: BTreeMap::new(),
        }
    }

    /// With a piece of data the page's words take.
    pub fn with(mut self, name: &str, value: impl ToString) -> Self {
        self.params.insert(name.to_string(), value.to_string());
        self
    }

    /// With a time, which the page writes in the owner's zone and language.
    pub fn at(self, name: &str, when: DateTime<Utc>) -> Self {
        self.with(name, when.to_rfc3339())
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::ops::Deref for Refusal {
    type Target = str;

    fn deref(&self) -> &str {
        &self.message
    }
}

impl From<String> for Refusal {
    fn from(message: String) -> Self {
        Self {
            message,
            key: None,
            params: BTreeMap::new(),
        }
    }
}

impl From<&str> for Refusal {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

impl From<Refusal> for String {
    fn from(r: Refusal) -> Self {
        r.message
    }
}

/// The keys, under `PersonalAgent.matterErrors`.
pub mod keys {
    pub const GONE: &str = "matterErrors.gone";
    pub const SETTLED: &str = "matterErrors.settled";
    pub const CHANGED: &str = "matterErrors.changed";
    pub const WORK_RUNNING: &str = "matterErrors.workRunning";
    pub const WORK_NO_TIME: &str = "matterErrors.workNoTime";
    pub const MESSAGE_NO_TIME: &str = "matterErrors.messageNoTime";
    pub const MENTION_NO_TIME: &str = "matterErrors.mentionNoTime";
    pub const NOT_EARLIER: &str = "matterErrors.notEarlier";
    pub const HAS_TIME: &str = "matterErrors.hasTime";
    pub const IN_OTHER_HANDS: &str = "matterErrors.inOtherHands";
    pub const BAD_TIME: &str = "matterErrors.badTime";
    pub const UNDO_NONE: &str = "matterErrors.undoNone";
    pub const UNDO_EXPIRED: &str = "matterErrors.undoExpired";
    pub const UNDO_FIRED: &str = "matterErrors.undoFired";
    pub const UNDO_CHANGED: &str = "matterErrors.undoChanged";
    pub const UNDO_REPLIED: &str = "matterErrors.undoReplied";
    pub const UNDO_PEER_GONE: &str = "matterErrors.undoPeerGone";
    pub const UNDO_ANSWER_READ: &str = "matterErrors.undoAnswerRead";
    pub const ANSWER_CHANGED: &str = "matterErrors.answerChanged";
    pub const ANSWER_QUEUED: &str = "matterErrors.answerQueued";
    pub const REMINDER_ANSWERED: &str = "matterErrors.reminderAnswered";
}
