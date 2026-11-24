//! The `/resolve` snapshot of a revision: what makes the item as a whole
//! uninstallable, what the user must confirm, and — when the fingerprint the
//! user confirmed is no longer the current one — what changed.
//!
//! The snapshot is the only source an install decides on (see
//! `harness::resolve`): never the install info, which comes through caches.
//! A value this Codeg does not know is the strictest case: an unknown status
//! blocks, an unknown verification blocks (`convert::package_reasons`).

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Mutex;

use serde::Serialize;

use crate::harness::types::{
    ItemStatus, Kind, PackageState, PermissionProfile, Permissions, Resolved, VersionState,
    VersionStatus,
};

use super::model::{codes, Reason};

/// An enumeration value as the API writes it.
pub(crate) fn wire<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Why the item as a whole cannot be installed now, by `/resolve`.
pub(super) fn item_blocking(resolved: &Resolved, revision: u64) -> Vec<Reason> {
    item_blocking_as(resolved, revision, Kind::Mcp, codes::NOT_AN_MCP_SERVER)
}

/// [`item_blocking`] for an item that must be of `kind` (`wrong_kind`, with
/// the `kind` it is, when it is not): the Harness skill install asks it too.
pub(crate) fn item_blocking_as(
    resolved: &Resolved,
    revision: u64,
    kind: Kind,
    wrong_kind: &str,
) -> Vec<Reason> {
    if !matches!(resolved.status, ItemStatus::Public | ItemStatus::Listed) {
        return vec![Reason::new(codes::ITEM_UNAVAILABLE).param("status", wire(&resolved.status))];
    }
    let mut out = Vec::new();
    if let Some(found) = resolved.kind.filter(|found| *found != kind) {
        out.push(Reason::new(wrong_kind).param("kind", wire(&found)));
    }
    let Some(state) = &resolved.installed else {
        out.push(Reason::new(codes::REVISION_UNAVAILABLE).param("revision", revision.to_string()));
        return out;
    };
    match state.status {
        VersionStatus::Ok | VersionStatus::Yanked => {}
        VersionStatus::Blocked => out.push(Reason::new(codes::VERSION_BLOCKED)),
        VersionStatus::Unknown => out.push(Reason::new(codes::VERSION_STATUS_UNKNOWN)),
    }
    for (field, absent) in [
        ("risk", state.risk.is_none()),
        ("reviewed", state.reviewed.is_none()),
        ("permissions", state.permissions.is_none()),
        ("checks", state.checks.is_none()),
        ("packages", state.packages.is_none()),
        ("stateSha256", state.state_sha256.is_none()),
    ] {
        if absent {
            out.push(Reason::new(codes::SNAPSHOT_INCOMPLETE).param("field", field));
        }
    }
    out
}

/// What the user must confirm in so many words.
pub(crate) fn confirmations(state: Option<&VersionState>) -> Vec<Reason> {
    match state {
        Some(state) if state.status == VersionStatus::Yanked => vec![Reason::new(codes::YANKED)],
        _ => Vec::new(),
    }
}

fn changed(code: &str, from: impl Into<String>, to: impl Into<String>) -> Reason {
    Reason::new(code).param("from", from).param("to", to)
}

fn permission_lists(permissions: &Permissions) -> [(&'static str, &Vec<String>); 7] {
    [
        ("runsCode", &permissions.runs_code),
        ("installs", &permissions.installs),
        ("installScripts", &permissions.install_scripts),
        ("network", &permissions.network),
        ("secrets", &permissions.secrets),
        ("paths", &permissions.paths),
        ("tools", &permissions.tools),
    ]
}

fn permission_changes(old: &PermissionProfile, new: &PermissionProfile, out: &mut Vec<Reason>) {
    for (profile, before, after) in [
        ("declared", &old.declared, &new.declared),
        ("detected", &old.detected, &new.detected),
    ] {
        for ((field, was), (_, now)) in permission_lists(before)
            .into_iter()
            .zip(permission_lists(after))
        {
            let was: BTreeSet<&String> = was.iter().collect();
            let now: BTreeSet<&String> = now.iter().collect();
            for (code, values) in [
                (codes::PERMISSION_ADDED, now.difference(&was)),
                (codes::PERMISSION_REMOVED, was.difference(&now)),
            ] {
                for value in values {
                    out.push(
                        Reason::new(code)
                            .param("profile", profile)
                            .param("field", field)
                            .param("value", value.as_str()),
                    );
                }
            }
        }
    }
}

fn package_changes(old: &[PackageState], new: &[PackageState], out: &mut Vec<Reason>) {
    let by_name = |packages: &[PackageState]| -> BTreeMap<(String, String), PackageState> {
        packages
            .iter()
            .map(|package| {
                (
                    (package.registry_type.clone(), package.identifier.clone()),
                    package.clone(),
                )
            })
            .collect()
    };
    let (old, new) = (by_name(old), by_name(new));
    let named = |code: &str, (registry_type, identifier): &(String, String)| {
        Reason::new(code)
            .param("registry_type", registry_type.clone())
            .param("identifier", identifier.clone())
    };
    for (name, after) in &new {
        let Some(before) = old.get(name) else {
            out.push(named(codes::PACKAGE_ADDED, name));
            continue;
        };
        if before.version != after.version {
            out.push(
                named(codes::PACKAGE_VERSION_CHANGED, name)
                    .param("from", before.version.clone().unwrap_or_default())
                    .param("to", after.version.clone().unwrap_or_default()),
            );
        }
        if before.verified != after.verified {
            out.push(
                named(codes::VERIFICATION_CHANGED, name)
                    .param("from", wire(&before.verified))
                    .param("to", wire(&after.verified)),
            );
        }
        match (before.has_install_script, after.has_install_script) {
            (false, true) => out.push(named(codes::INSTALL_SCRIPT_ADDED, name)),
            (true, false) => out.push(named(codes::INSTALL_SCRIPT_REMOVED, name)),
            _ => {}
        }
    }
    for name in old.keys().filter(|name| !new.contains_key(*name)) {
        out.push(named(codes::PACKAGE_REMOVED, name));
    }
}

/// What differs between the state the user confirmed (`None`: this Codeg no
/// longer knows it) and the one `/resolve` gives now. Never empty: a
/// difference this Codeg cannot name is `state_changed`.
pub(crate) fn changes(old: Option<&VersionState>, new: &VersionState) -> Vec<Reason> {
    let Some(old) = old else {
        return vec![Reason::new(codes::STATE_CHANGED)];
    };
    let mut out = Vec::new();
    if old.status != new.status {
        out.push(changed(
            codes::STATUS_CHANGED,
            wire(&old.status),
            wire(&new.status),
        ));
    }
    if old.risk != new.risk {
        let risk = |risk: &Option<_>| risk.as_ref().map(wire).unwrap_or_default();
        out.push(changed(
            codes::RISK_CHANGED,
            risk(&old.risk),
            risk(&new.risk),
        ));
    }
    if old.reviewed != new.reviewed {
        let reviewed = |value: Option<bool>| value.map(|v| v.to_string()).unwrap_or_default();
        out.push(changed(
            codes::REVIEWED_CHANGED,
            reviewed(old.reviewed),
            reviewed(new.reviewed),
        ));
    }
    let empty = PermissionProfile::default();
    permission_changes(
        old.permissions.as_ref().unwrap_or(&empty),
        new.permissions.as_ref().unwrap_or(&empty),
        &mut out,
    );
    match (&old.checks, &new.checks) {
        (Some(before), Some(after)) => {
            for (severity, was, now) in [
                ("low", before.findings.low, after.findings.low),
                ("medium", before.findings.medium, after.findings.medium),
                ("high", before.findings.high, after.findings.high),
            ] {
                if was != now {
                    out.push(
                        changed(codes::FINDINGS_CHANGED, was.to_string(), now.to_string())
                            .param("severity", severity),
                    );
                }
            }
            if before.secrets != after.secrets {
                out.push(changed(
                    codes::SECRETS_FOUND_CHANGED,
                    before.secrets.to_string(),
                    after.secrets.to_string(),
                ));
            }
            if before.review != after.review {
                out.push(changed(
                    codes::REVIEW_CHANGED,
                    before.review.clone(),
                    after.review.clone(),
                ));
            }
        }
        (before, after) if before != after => out.push(Reason::new(codes::STATE_CHANGED)),
        _ => {}
    }
    package_changes(
        old.packages.as_deref().unwrap_or_default(),
        new.packages.as_deref().unwrap_or_default(),
        &mut out,
    );
    if out.is_empty() {
        out.push(Reason::new(codes::STATE_CHANGED));
    }
    out
}

/// How many snapshots a plan leaves behind for the install to compare with.
const REMEMBERED: usize = 64;

/// The snapshots plans showed, by fingerprint, so that an install whose
/// confirmed fingerprint is out of date can say what changed. Only for that
/// list: the decision is the fingerprint's alone.
static SHOWN: Mutex<VecDeque<VersionState>> = Mutex::new(VecDeque::new());

pub(crate) fn remember(state: &VersionState) {
    let Some(sha) = &state.state_sha256 else {
        return;
    };
    let mut shown = SHOWN.lock().unwrap_or_else(|e| e.into_inner());
    shown.retain(|kept| kept.state_sha256.as_ref() != Some(sha));
    shown.push_back(state.clone());
    while shown.len() > REMEMBERED {
        shown.pop_front();
    }
}

pub(crate) fn recall(sha: &str) -> Option<VersionState> {
    SHOWN
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .find(|kept| kept.state_sha256.as_deref() == Some(sha))
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(value: serde_json::Value) -> VersionState {
        serde_json::from_value(value).unwrap()
    }

    fn base() -> serde_json::Value {
        json!({
            "revision": 3, "status": "ok", "risk": "low", "reviewed": true,
            "permissions": { "declared": { "network": ["a.example"] },
                             "detected": { "runsCode": ["node"], "installs": ["npm:x@1.0.0"],
                                           "installScripts": [], "network": [], "secrets": [],
                                           "paths": [], "tools": [] } },
            "checks": { "findings": { "low": 1, "medium": 0, "high": 0 }, "secrets": 0, "review": "off" },
            "packages": [{ "registryType": "npm", "identifier": "x", "version": "1.0.0",
                           "verified": "pending", "hasInstallScript": false }],
            "stateSha256": "one"
        })
    }

    fn codes_of(reasons: &[Reason]) -> Vec<&str> {
        reasons.iter().map(|reason| reason.code.as_str()).collect()
    }

    #[test]
    fn every_change_a_person_agreed_to_is_named() {
        let old = state(base());
        let mut next = base();
        next["status"] = json!("yanked");
        next["risk"] = json!("high");
        next["reviewed"] = json!(false);
        next["permissions"]["detected"]["network"] = json!(["b.example"]);
        next["permissions"]["declared"]["network"] = json!([]);
        next["checks"]["findings"]["high"] = json!(2);
        next["checks"]["secrets"] = json!(1);
        next["checks"]["review"] = json!("done");
        next["packages"][0]["verified"] = json!("missing");
        next["packages"][0]["version"] = json!(null);
        next["packages"][0]["hasInstallScript"] = json!(true);
        next["packages"].as_array_mut().unwrap().push(json!({
            "registryType": "pypi", "identifier": "y", "version": "2.0",
            "verified": "ok", "hasInstallScript": false
        }));
        next["stateSha256"] = json!("two");
        let found = changes(Some(&old), &state(next));
        assert_eq!(
            codes_of(&found),
            [
                codes::STATUS_CHANGED,
                codes::RISK_CHANGED,
                codes::REVIEWED_CHANGED,
                codes::PERMISSION_REMOVED,
                codes::PERMISSION_ADDED,
                codes::FINDINGS_CHANGED,
                codes::SECRETS_FOUND_CHANGED,
                codes::REVIEW_CHANGED,
                codes::PACKAGE_VERSION_CHANGED,
                codes::VERIFICATION_CHANGED,
                codes::INSTALL_SCRIPT_ADDED,
                codes::PACKAGE_ADDED,
            ]
        );
        assert_eq!(found[0].params["from"], "ok");
        assert_eq!(found[0].params["to"], "yanked");
        assert_eq!(found[3].params["profile"], "declared");
        assert_eq!(found[4].params["field"], "network");
        assert_eq!(found[4].params["value"], "b.example");
        assert_eq!(found[5].params["severity"], "high");
        assert_eq!(found[9].params["to"], "missing");

        // the same content under another fingerprint, or a state no longer
        // known: still a change, just not a named one
        let mut same = base();
        same["stateSha256"] = json!("three");
        assert_eq!(
            codes_of(&changes(Some(&old), &state(same))),
            [codes::STATE_CHANGED]
        );
        assert_eq!(codes_of(&changes(None, &old)), [codes::STATE_CHANGED]);
    }

    #[test]
    fn what_blocks_the_item_as_a_whole() {
        let resolved =
            |value: serde_json::Value| -> Resolved { serde_json::from_value(value).unwrap() };
        let public = |installed: serde_json::Value| {
            resolved(
                json!({ "id": "i", "status": "public", "ref": "a/b", "kind": "mcp",
                             "latest": { "revision": 3, "version": null, "publishedAt": "p" },
                             "advisories": [], "installed": installed }),
            )
        };
        assert!(item_blocking(&public(base()), 3).is_empty());
        for (status, code) in [
            ("blocked", codes::VERSION_BLOCKED),
            ("quarantined", codes::VERSION_STATUS_UNKNOWN),
        ] {
            let mut blocked = base();
            blocked["status"] = json!(status);
            assert_eq!(codes_of(&item_blocking(&public(blocked), 3)), [code]);
        }
        let mut yanked = base();
        yanked["status"] = json!("yanked");
        assert!(item_blocking(&public(yanked.clone()), 3).is_empty());
        assert_eq!(
            codes_of(&confirmations(Some(&state(yanked)))),
            [codes::YANKED]
        );
        assert!(confirmations(Some(&state(base()))).is_empty());

        assert_eq!(
            codes_of(&item_blocking(&public(json!(null)), 3)),
            [codes::REVISION_UNAVAILABLE]
        );
        for status in ["retired", "removed", "unavailable", "archived"] {
            let found = item_blocking(&resolved(json!({ "id": "i", "status": status })), 3);
            assert_eq!(codes_of(&found), [codes::ITEM_UNAVAILABLE], "{status}");
        }
        assert_eq!(
            item_blocking(&resolved(json!({ "id": "i", "status": "archived" })), 3)[0].params
                ["status"],
            "unknown"
        );
        let mut partial = base();
        partial.as_object_mut().unwrap().remove("stateSha256");
        let found = item_blocking(&public(partial), 3);
        assert_eq!(codes_of(&found), [codes::SNAPSHOT_INCOMPLETE]);
        assert_eq!(found[0].params["field"], "stateSha256");
    }

    /// Nothing installs a plugin yet: neither the MCP nor the skill install
    /// takes one as its own kind.
    #[test]
    fn a_plugin_is_of_another_kind_to_every_install() {
        use crate::harness::skills::model::codes as skill_codes;
        let plugin: Resolved = serde_json::from_value(json!({
            "id": "i", "status": "public", "ref": "obra/superpowers", "kind": "plugin",
            "latest": { "revision": 3, "version": "7.0.2", "publishedAt": "p" },
            "advisories": [], "installed": base()
        }))
        .unwrap();
        for (kind, wrong) in [
            (Kind::Mcp, codes::NOT_AN_MCP_SERVER),
            (Kind::Skill, skill_codes::NOT_A_SKILL),
        ] {
            let found = item_blocking_as(&plugin, 3, kind, wrong);
            assert_eq!(codes_of(&found), [wrong]);
            assert_eq!(found[0].params["kind"], "plugin");
        }
    }

    #[test]
    fn a_shown_snapshot_is_found_by_its_fingerprint() {
        let mut shown = base();
        shown["stateSha256"] = json!("remembered-for-the-test");
        remember(&state(shown));
        assert_eq!(
            recall("remembered-for-the-test")
                .unwrap()
                .state_sha256
                .as_deref(),
            Some("remembered-for-the-test")
        );
        assert!(recall("never-shown").is_none());
    }
}
