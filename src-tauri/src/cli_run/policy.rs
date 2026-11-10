//! How a headless `codeg-cli` run answers what the agent asks: permission
//! requests, `ask_user_question`-style questions and Grok plan approvals.
//!
//! Options are always chosen by the KIND `connection.rs` normalized them to
//! (`allow_once` / `allow_always` / `reject_once` / `reject_always`), never by
//! position: claude-agent-acp 0.91.0 leads with the rejection for a call the
//! Claude CLI marks `defaultToNo`. And never an `*_always` option — those write
//! a standing rule into the user's own agent settings.

use serde::{Deserialize, Serialize};

use crate::acp::types::PermissionOptionInfo;

/// The `--permissions` value of a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionPolicy {
    /// Refuse every request, once (the default).
    Deny,
    /// Allow a request whose tool kind is `read` or `search`; refuse the rest.
    Reads,
    /// Allow every request, once.
    Allow,
    /// Refuse, then end the run as `permission_required` (exit 5).
    Fail,
    /// Answer nothing; leave the card to a person in the Codeg UI.
    Wait,
}

impl PermissionPolicy {
    pub const ALL: [Self; 5] = [Self::Deny, Self::Reads, Self::Allow, Self::Fail, Self::Wait];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Deny => "deny",
            Self::Reads => "reads",
            Self::Allow => "allow",
            Self::Fail => "fail",
            Self::Wait => "wait",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.as_str() == value)
    }

    /// How much this policy lets through without a person: the only measure
    /// that decides whether a nested run may use it.
    fn breadth(self) -> u8 {
        match self {
            Self::Allow => 2,
            Self::Reads => 1,
            Self::Deny | Self::Fail | Self::Wait => 0,
        }
    }

    /// The policy a run nested under a run with `parent` actually gets: never
    /// wider than the parent's. A narrower or equally wide request is kept as
    /// asked (a `wait` under a `deny` stays `wait`).
    pub fn narrowed_to(self, parent: Self) -> Self {
        if self.breadth() > parent.breadth() {
            parent
        } else {
            self
        }
    }
}

/// What a policy does with one permission request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionDecision {
    /// Answer with this option.
    Answer { option_id: String, allowed: bool },
    /// Answer with this option (when there is one to answer with), then end
    /// the run as `permission_required`.
    AnswerThenFail { option_id: Option<String> },
    /// Leave it to a person.
    Leave,
}

/// Decide a permission request under `policy`. `tool_kind` is the request's
/// `tool_call.kind`, when it has one.
pub fn decide_permission(
    policy: PermissionPolicy,
    options: &[PermissionOptionInfo],
    tool_kind: Option<&str>,
) -> PermissionDecision {
    let reject_once = || PermissionOptionInfo::reject_once_in(options).map(|o| o.option_id.clone());
    let refuse = || match reject_once() {
        Some(option_id) => PermissionDecision::Answer {
            option_id,
            allowed: false,
        },
        // No way to say "no, just this once" that writes no rule: end the run
        // rather than fall back to a standing rejection or a positional pick.
        None => PermissionDecision::AnswerThenFail { option_id: None },
    };
    let allow = || match PermissionOptionInfo::allow_once_in(options) {
        Some(option) => PermissionDecision::Answer {
            option_id: option.option_id.clone(),
            allowed: true,
        },
        None => refuse(),
    };
    match policy {
        PermissionPolicy::Deny => refuse(),
        PermissionPolicy::Reads => {
            if matches!(tool_kind, Some("read" | "search")) {
                allow()
            } else {
                refuse()
            }
        }
        PermissionPolicy::Allow => allow(),
        PermissionPolicy::Fail => PermissionDecision::AnswerThenFail {
            option_id: reject_once(),
        },
        PermissionPolicy::Wait => PermissionDecision::Leave,
    }
}

/// A run's mark on a connection that belongs to it: its root connection, or a
/// delegation child that inherited the mark when it was spawned. Delegated
/// children answer by the same policy; a nested `codeg-cli` call made from
/// inside the connection takes its depth and its policy ceiling from here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliRunTag {
    pub run_id: String,
    pub policy: PermissionPolicy,
    /// 0 for a run started from outside any CLI run, the caller's depth + 1
    /// for a nested one.
    pub depth: u8,
}

/// What a run's root connection carries from the moment it exists, before its
/// agent starts: the run's tag, and the `--output-schema` its result is handed
/// in against — so the codeg-mcp the connection is given offers
/// `submit_result`. A delegated child inherits the tag alone.
#[derive(Debug, Clone)]
pub struct RootSeed {
    pub tag: CliRunTag,
    pub output_schema: Option<std::sync::Arc<super::output_schema::OutputSchema>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn option(id: &str, kind: &str) -> PermissionOptionInfo {
        PermissionOptionInfo {
            option_id: id.to_string(),
            name: id.to_string(),
            kind: kind.to_string(),
            meta: None,
        }
    }

    /// claude-agent-acp 0.91.0's two orders: the default leads with allow,
    /// a `defaultToNo` call leads with the rejection.
    fn claude_orders() -> [Vec<PermissionOptionInfo>; 2] {
        [
            vec![
                option("allow", "allow_once"),
                option("allow-always", "allow_always"),
                option("reject", "reject_once"),
            ],
            vec![
                option("reject", "reject_once"),
                option("allow", "allow_once"),
                option("allow-always", "allow_always"),
            ],
        ]
    }

    #[test]
    fn options_are_picked_by_kind_in_either_order() {
        for options in claude_orders() {
            assert_eq!(
                decide_permission(PermissionPolicy::Deny, &options, Some("execute")),
                PermissionDecision::Answer {
                    option_id: "reject".into(),
                    allowed: false
                }
            );
            assert_eq!(
                decide_permission(PermissionPolicy::Allow, &options, Some("execute")),
                PermissionDecision::Answer {
                    option_id: "allow".into(),
                    allowed: true
                }
            );
            assert_eq!(
                decide_permission(PermissionPolicy::Fail, &options, Some("execute")),
                PermissionDecision::AnswerThenFail {
                    option_id: Some("reject".into())
                }
            );
            assert_eq!(
                decide_permission(PermissionPolicy::Wait, &options, Some("execute")),
                PermissionDecision::Leave
            );
        }
    }

    #[test]
    fn reads_lets_only_read_and_search_through() {
        let [options, _] = claude_orders();
        for (kind, allowed) in [
            (Some("read"), true),
            (Some("search"), true),
            (Some("edit"), false),
            (Some("execute"), false),
            (None, false),
        ] {
            let decision = decide_permission(PermissionPolicy::Reads, &options, kind);
            let expected = if allowed { "allow" } else { "reject" };
            assert_eq!(
                decision,
                PermissionDecision::Answer {
                    option_id: expected.into(),
                    allowed
                },
                "{kind:?}"
            );
        }
    }

    #[test]
    fn an_always_option_is_never_chosen() {
        let only_always = vec![
            option("allow-always", "allow_always"),
            option("reject-always", "reject_always"),
        ];
        for policy in PermissionPolicy::ALL {
            let decision = decide_permission(policy, &only_always, Some("read"));
            if let PermissionDecision::Answer { option_id, .. }
            | PermissionDecision::AnswerThenFail {
                option_id: Some(option_id),
            } = &decision
            {
                panic!("{policy:?} chose {option_id}");
            }
        }
        // Allow with no allow-once falls back to a one-time refusal.
        let no_allow_once = vec![
            option("allow-always", "allow_always"),
            option("no", "reject_once"),
        ];
        assert_eq!(
            decide_permission(PermissionPolicy::Allow, &no_allow_once, Some("execute")),
            PermissionDecision::Answer {
                option_id: "no".into(),
                allowed: false
            }
        );
    }

    #[test]
    fn nothing_to_refuse_with_fails_the_run_instead_of_guessing() {
        for options in [vec![], vec![option("allow-always", "allow_always")]] {
            assert_eq!(
                decide_permission(PermissionPolicy::Deny, &options, Some("execute")),
                PermissionDecision::AnswerThenFail { option_id: None }
            );
            assert_eq!(
                decide_permission(PermissionPolicy::Fail, &options, Some("execute")),
                PermissionDecision::AnswerThenFail { option_id: None }
            );
        }
    }

    /// Every parent × request pair: a request is only ever changed when it is
    /// wider than its parent, and then to the parent.
    #[test]
    fn a_nested_policy_is_never_wider_than_its_parent() {
        for parent in PermissionPolicy::ALL {
            for requested in PermissionPolicy::ALL {
                let got = requested.narrowed_to(parent);
                if requested.breadth() > parent.breadth() {
                    assert_eq!(got, parent, "{requested:?} under {parent:?}");
                } else {
                    assert_eq!(got, requested, "{requested:?} under {parent:?}");
                }
                assert!(got.breadth() <= parent.breadth());
            }
        }
    }

    #[test]
    fn policies_round_trip_their_names() {
        for policy in PermissionPolicy::ALL {
            assert_eq!(PermissionPolicy::parse(policy.as_str()), Some(policy));
            assert_eq!(
                serde_json::to_value(policy).unwrap(),
                serde_json::json!(policy.as_str())
            );
        }
        assert_eq!(PermissionPolicy::parse("yolo"), None);
    }
}
