//! Which work items auto-processing picks up.
//!
//! Pure on purpose: every rule the settings dialog offers is decided here, on a
//! list row, with no forge and no database in sight — so each one is tested as
//! the user reads it ("only these labels", "never this author", "labels that
//! start with `area/`") rather than through a scan.
//!
//! The order of the checks is part of the contract, and it is the one a user
//! expects from a filter: what kind of item, whether it is still open, then
//! every EXCLUSION, then every INCLUSION. An exclusion therefore always wins —
//! "only `bug`, never `wontfix`" passes over a `bug` + `wontfix` issue — and the
//! reason reported for a skipped item is the first rule that ruled it out.

use serde::Serialize;

use crate::forge::settings::ForgeAutoSettings;
use crate::forge::ForgeIssueRow;

/// Why an item was passed over. Counted in the scan report, so the settings
/// dialog can tell "your rules left it out" apart from "it was never seen".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Skip {
    /// Its kind (issue / pull request) is not picked up.
    Kind,
    /// Not open — closed or merged since the listing, or a listing that
    /// returned one anyway.
    NotOpen,
    /// A draft pull / merge request, and drafts are left alone.
    Draft,
    /// Carries a label matching an exclude pattern.
    ExcludedLabel,
    /// Opened by an author matching an exclude pattern.
    ExcludedAuthor,
    /// Carries no label matching any include pattern.
    MissingLabel,
    /// Opened by an author matching no include pattern — or by an author the
    /// forge did not name, who cannot be on a list of anyone.
    AuthorNotIncluded,
}

/// Whether auto-processing picks `row` up under `rules`, and if not, why not.
pub fn evaluate(rules: &ForgeAutoSettings, row: &ForgeIssueRow) -> Result<(), Skip> {
    let wanted = if row.is_pr {
        rules.pull_requests
    } else {
        rules.issues
    };
    if !wanted {
        return Err(Skip::Kind);
    }
    if row.state != "open" {
        return Err(Skip::NotOpen);
    }
    if row.is_pr && row.draft && rules.skip_drafts {
        return Err(Skip::Draft);
    }

    let author = row
        .author
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty());

    // Exclusions first: whatever the include lists say, these win.
    if row
        .labels
        .iter()
        .any(|label| any_matches(&rules.exclude_labels, &label.name))
    {
        return Err(Skip::ExcludedLabel);
    }
    if author.is_some_and(|a| any_matches(&rules.exclude_authors, a)) {
        return Err(Skip::ExcludedAuthor);
    }

    if !rules.include_labels.is_empty()
        && !row
            .labels
            .iter()
            .any(|label| any_matches(&rules.include_labels, &label.name))
    {
        return Err(Skip::MissingLabel);
    }
    if !rules.include_authors.is_empty()
        && !author.is_some_and(|a| any_matches(&rules.include_authors, a))
    {
        return Err(Skip::AuthorNotIncluded);
    }
    Ok(())
}

/// Whether any of `patterns` matches `text`.
pub fn any_matches(patterns: &[String], text: &str) -> bool {
    patterns
        .iter()
        .any(|pattern| pattern_matches(pattern, text))
}

/// One rule pattern against one label name or login.
///
/// Case-insensitive — every forge treats both label names and logins as
/// case-insensitive identities, and a rule that missed `Bug` because it says
/// `bug` would read as broken. `*` matches any run of characters, including
/// none: `area/*` is "starts with `area/`", `*[bot]` is "ends with `[bot]`",
/// `*security*` is "contains". Nothing else is special — a `?` or a `[` is
/// itself, because label names are full of both and none of them is a regex.
pub fn pattern_matches(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.trim().to_lowercase().chars().collect();
    let text: Vec<char> = text.trim().to_lowercase().chars().collect();
    if pattern.is_empty() {
        // A blank pattern never survives a save; read one as matching
        // nothing rather than everything, should one ever get here.
        return false;
    }

    // Classic wildcard matching with single-star backtracking: linear in
    // practice, and with no recursion for a long pattern to blow the stack on.
    let (mut p, mut t) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut resume = 0usize;
    while t < text.len() {
        if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            resume = t;
            p += 1;
        } else if p < pattern.len() && pattern[p] == text[t] {
            p += 1;
            t += 1;
        } else if let Some(at) = star {
            // Let the last star swallow one more character and retry.
            p = at + 1;
            resume += 1;
            t = resume;
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|&c| c == '*')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::ForgeLabel;

    fn row(is_pr: bool, labels: &[&str], author: Option<&str>) -> ForgeIssueRow {
        ForgeIssueRow {
            number: 7,
            title: "Login times out".into(),
            body: None,
            state: "open".into(),
            draft: false,
            labels: labels
                .iter()
                .map(|name| ForgeLabel {
                    name: (*name).to_string(),
                    color: None,
                })
                .collect(),
            author: author.map(str::to_string),
            author_avatar: None,
            updated_at: None,
            html_url: String::new(),
            is_pr,
            comments: 0,
        }
    }

    fn rules() -> ForgeAutoSettings {
        ForgeAutoSettings {
            schedule: true,
            issues: true,
            pull_requests: true,
            ..Default::default()
        }
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn a_star_is_a_prefix_a_suffix_or_a_contains() {
        assert!(pattern_matches("area/*", "area/ui"));
        assert!(pattern_matches("area/*", "area/"));
        assert!(!pattern_matches("area/*", "the-area/ui"));
        assert!(pattern_matches("*[bot]", "dependabot[bot]"));
        assert!(!pattern_matches("*[bot]", "robot"));
        assert!(pattern_matches("*security*", "needs-security-review"));
        assert!(pattern_matches("*", "anything"));
        assert!(pattern_matches("a*b*c", "aXXbYYc"));
        assert!(!pattern_matches("a*b*c", "aXXbYY"));
        // Backtracking: the first `b` is not the one the pattern needs.
        assert!(pattern_matches("*bc", "abcbc"));
        assert!(pattern_matches("a**c", "abc"));
    }

    /// Exact unless a star says otherwise — `bug` is not "starts with bug".
    #[test]
    fn a_pattern_without_a_star_is_an_exact_match() {
        assert!(pattern_matches("bug", "bug"));
        assert!(!pattern_matches("bug", "bugfix"));
        assert!(!pattern_matches("bug", "debug"));
    }

    /// Label names and logins are case-insensitive identities on every forge.
    #[test]
    fn matching_ignores_case_and_surrounding_whitespace() {
        assert!(pattern_matches("Bug", "bug"));
        assert!(pattern_matches("AREA/*", "Area/UI"));
        assert!(pattern_matches("  alice ", "Alice"));
        assert!(pattern_matches("优先级/*", "优先级/高"));
    }

    /// Only `*` is special: label names are full of `?`, `[` and `.`.
    #[test]
    fn nothing_but_the_star_is_a_wildcard() {
        assert!(pattern_matches("good first issue?", "good first issue?"));
        assert!(!pattern_matches("v?", "v1"));
        assert!(pattern_matches("[bot]", "[bot]"));
        assert!(!pattern_matches("a.b", "aXb"));
    }

    #[test]
    fn a_blank_pattern_matches_nothing() {
        assert!(!pattern_matches("", "bug"));
        assert!(!pattern_matches("   ", ""));
    }

    #[test]
    fn the_kind_switches_decide_first() {
        let issues_only = ForgeAutoSettings {
            pull_requests: false,
            ..rules()
        };
        assert_eq!(evaluate(&issues_only, &row(false, &[], Some("a"))), Ok(()));
        assert_eq!(
            evaluate(&issues_only, &row(true, &[], Some("a"))),
            Err(Skip::Kind)
        );
        let prs_only = ForgeAutoSettings {
            issues: false,
            ..rules()
        };
        assert_eq!(
            evaluate(&prs_only, &row(false, &[], Some("a"))),
            Err(Skip::Kind)
        );
        assert_eq!(evaluate(&prs_only, &row(true, &[], Some("a"))), Ok(()));
    }

    #[test]
    fn closed_items_and_drafts_are_left_alone() {
        let mut closed = row(false, &[], Some("a"));
        closed.state = "closed".into();
        assert_eq!(evaluate(&rules(), &closed), Err(Skip::NotOpen));

        let mut draft = row(true, &[], Some("a"));
        draft.draft = true;
        assert_eq!(evaluate(&rules(), &draft), Err(Skip::Draft));
        let drafts_welcome = ForgeAutoSettings {
            skip_drafts: false,
            ..rules()
        };
        assert_eq!(evaluate(&drafts_welcome, &draft), Ok(()));
    }

    /// No rules at all is "every open item of the wanted kinds".
    #[test]
    fn empty_rule_lists_pick_everything_up() {
        assert_eq!(evaluate(&rules(), &row(false, &[], None)), Ok(()));
        assert_eq!(evaluate(&rules(), &row(false, &["x"], Some("a"))), Ok(()));
    }

    /// "Only these labels": at least ONE of the item's labels has to match
    /// at least one pattern — it is a filter, not a checklist.
    #[test]
    fn include_labels_need_one_matching_label() {
        let only = ForgeAutoSettings {
            include_labels: strings(&["bug", "codeg/*"]),
            ..rules()
        };
        assert_eq!(evaluate(&only, &row(false, &["bug"], None)), Ok(()));
        assert_eq!(
            evaluate(&only, &row(false, &["docs", "codeg/auto"], None)),
            Ok(())
        );
        assert_eq!(
            evaluate(&only, &row(false, &["docs"], None)),
            Err(Skip::MissingLabel)
        );
        assert_eq!(
            evaluate(&only, &row(false, &[], None)),
            Err(Skip::MissingLabel)
        );
    }

    /// "Never these labels" beats "only these labels".
    #[test]
    fn an_excluded_label_wins_over_an_included_one() {
        let rules = ForgeAutoSettings {
            include_labels: strings(&["bug"]),
            exclude_labels: strings(&["wontfix", "status/*"]),
            ..rules()
        };
        assert_eq!(evaluate(&rules, &row(false, &["bug"], None)), Ok(()));
        assert_eq!(
            evaluate(&rules, &row(false, &["bug", "wontfix"], None)),
            Err(Skip::ExcludedLabel)
        );
        assert_eq!(
            evaluate(&rules, &row(false, &["bug", "Status/Blocked"], None)),
            Err(Skip::ExcludedLabel)
        );
    }

    #[test]
    fn author_rules_include_and_exclude_by_login() {
        let trusted = ForgeAutoSettings {
            include_authors: strings(&["alice", "team-*"]),
            ..rules()
        };
        assert_eq!(evaluate(&trusted, &row(false, &[], Some("Alice"))), Ok(()));
        assert_eq!(
            evaluate(&trusted, &row(false, &[], Some("team-ops"))),
            Ok(())
        );
        assert_eq!(
            evaluate(&trusted, &row(false, &[], Some("mallory"))),
            Err(Skip::AuthorNotIncluded)
        );
        // An author the forge did not name is on nobody's list.
        assert_eq!(
            evaluate(&trusted, &row(false, &[], None)),
            Err(Skip::AuthorNotIncluded)
        );

        let no_bots = ForgeAutoSettings {
            exclude_authors: strings(&["*[bot]", "renovate"]),
            ..rules()
        };
        assert_eq!(
            evaluate(&no_bots, &row(true, &[], Some("dependabot[bot]"))),
            Err(Skip::ExcludedAuthor)
        );
        assert_eq!(evaluate(&no_bots, &row(true, &[], Some("bob"))), Ok(()));
        // An unnamed author cannot match an exclusion either.
        assert_eq!(evaluate(&no_bots, &row(true, &[], None)), Ok(()));
    }

    /// With both dimensions set, BOTH have to pass — labels say what, authors
    /// say who, and a rule set naming both means both.
    #[test]
    fn label_and_author_includes_must_both_hold() {
        let both = ForgeAutoSettings {
            include_labels: strings(&["bug"]),
            include_authors: strings(&["alice"]),
            ..rules()
        };
        assert_eq!(
            evaluate(&both, &row(false, &["bug"], Some("alice"))),
            Ok(())
        );
        assert_eq!(
            evaluate(&both, &row(false, &["bug"], Some("bob"))),
            Err(Skip::AuthorNotIncluded)
        );
        assert_eq!(
            evaluate(&both, &row(false, &["docs"], Some("alice"))),
            Err(Skip::MissingLabel)
        );
    }
}
