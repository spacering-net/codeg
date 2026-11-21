//! The answers an install is decided on, as Rust types: one version's install
//! info (`GET /items/{ref}/versions/{revision}`) and how installed items stand
//! now (`POST /resolve`). The API's Zod source is the website's
//! `api/harness/schemas.ts`.
//!
//! What the Discover section shows is not typed here: it passes through as
//! JSON, unchanged, and the frontend's types are generated from the API's
//! OpenAPI document.
//!
//! Written to outlive the API growing: a field this Codeg does not know is
//! ignored, and a value it does not know of an enumeration reads as that
//! enumeration's `Unknown` rather than failing the whole answer. **`Unknown`
//! is never the permissive case.** Code that decides on one of these must
//! treat it as the strictest: an unknown status is not `ok`, an unknown
//! verification is not `ok`, an unknown risk is not `low`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What an item is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Skill,
    Mcp,
    Prompt,
    Assistant,
    Connector,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Low,
    Medium,
    High,
    /// Treat as the highest.
    #[serde(other)]
    Unknown,
}

/// How a published version stands. Changes after publication.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VersionStatus {
    Ok,
    /// Withdrawn by its author: installs only after the user confirms.
    Yanked,
    /// Taken down by Harness: never installs.
    Blocked,
    /// Not installable.
    #[serde(other)]
    Unknown,
}

/// Whether a package's pinned version was found at its registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verified {
    Ok,
    /// Not at the registry: never installs.
    Missing,
    Unchecked,
    Pending,
    /// Not installable.
    #[serde(other)]
    Unknown,
}

/// How an item stands, as `/resolve` tells it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemStatus {
    Public,
    /// Reachable by its address, not browsed.
    Listed,
    /// Stopped by its author or its source.
    Retired,
    /// Taken down.
    Removed,
    /// Not out, private, or no such item: which is not told.
    Unavailable,
    /// Not installable.
    #[serde(other)]
    Unknown,
}

/// What clients do with installed copies an advisory applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdvisoryAction {
    Notify,
    Disable,
    Remove,
    #[serde(other)]
    Unknown,
}

/// Display text per language. Either may be missing: show the other.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Localized {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub en: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zh: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Permissions {
    pub runs_code: Vec<String>,
    pub installs: Vec<String>,
    pub install_scripts: Vec<String>,
    pub network: Vec<String>,
    pub secrets: Vec<String>,
    pub paths: Vec<String>,
    /// Agent tools it asks for; `["*"]` for all of them.
    pub tools: Vec<String>,
}

/// What a version says it needs, and what the checks found it to need.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PermissionProfile {
    pub declared: Permissions,
    pub detected: Permissions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Advisory {
    pub id: String,
    pub severity: Risk,
    pub action: AdvisoryAction,
    /// The revisions it applies to; empty for all.
    #[serde(default)]
    pub revisions: Vec<u64>,
    #[serde(default)]
    pub summary: Localized,
    pub published_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestVersion {
    pub revision: u64,
    pub version: Option<String>,
    pub published_at: String,
}

// ─── GET /items/{ref}/versions/{revision} ───────────────────────────────

/// One version, with what it takes to install it.
///
/// Its files and hashes never change. Its `version.status`, `risk`,
/// `reviewed`, `permissions` and `packages[].verified` do, and this answer
/// comes through caches (Codeg's and the site's): take those from
/// [`VersionState`] instead, read right before installing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallInfo {
    pub item: InstallItem,
    pub version: InstallVersion,
    /// The whole package as one zip. `None` when its license does not let
    /// Harness hand out copies: fetch `files` from `source`.
    pub archive: Option<Archive>,
    #[serde(default)]
    pub files: Vec<FileEntry>,
    pub source: Option<Source>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<SkillInfo>,
    /// The registry's `server.json`, as published.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packages: Option<Vec<PinnedPackage>>,
    #[serde(default)]
    pub permissions: Permissions,
    pub risk: Risk,
    #[serde(default)]
    pub reviewed: bool,
    #[serde(default)]
    pub advisories: Vec<Advisory>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallItem {
    /// Stable; survives renames. What `/resolve` is asked by.
    pub id: String,
    /// `publisher/name`, as it is now.
    pub r#ref: String,
    pub kind: Kind,
    #[serde(default)]
    pub title: Localized,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallVersion {
    pub revision: u64,
    pub version: Option<String>,
    pub published_at: String,
    pub status: VersionStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Archive {
    /// Site-relative. Resolve it with [`super::Origin::join`] and nothing
    /// else: an address that names another host is refused there.
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub executable: bool,
}

/// Where to fetch the files from when there is no archive.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    /// GitHub `owner/repo`.
    pub repository: String,
    pub commit: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compatibility: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedPackage {
    pub registry_type: String,
    pub identifier: String,
    /// The exact version Harness pinned; `None` when it has none.
    pub version: Option<String>,
    pub verified: Verified,
    /// npm: the tarball's integrity (`sha512-…`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<PackageFile>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_install_script: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageFile {
    pub name: String,
    pub sha256: String,
    /// `wheel` or `sdist`.
    pub kind: String,
}

// ─── POST /resolve ──────────────────────────────────────────────────────

/// One installed item, as `/resolve` is asked about it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Installed {
    /// The item's id, as `item.id` gave it when it was installed.
    pub id: String,
    /// The revision that was installed.
    pub revision: u64,
}

/// How one installed item stands now.
///
/// The API answers one of three shapes by `status`; they are one struct here,
/// with what a shape lacks left `None`:
///
/// - `Public`, `Listed`: everything, `installed` being the revision asked
///   about as it stands now (`None` if the item has no such revision);
/// - `Retired`, `Removed`: `installed` with its `revision` and `status` only;
/// - `Unavailable`: nothing but the id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Resolved {
    pub id: String,
    pub status: ItemStatus,
    /// Its address now: a rename keeps the id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<Kind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest: Option<LatestVersion>,
    #[serde(default)]
    pub advisories: Vec<Advisory>,
    #[serde(default)]
    pub installed: Option<VersionState>,
}

/// What can change about a version after it is published, read fresh. The
/// only source an install or an update may decide on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionState {
    pub revision: u64,
    pub status: VersionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk: Option<Risk>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<PermissionProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks: Option<CheckSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packages: Option<Vec<PackageState>>,
    /// SHA-256 of the fields above as the API wrote them. Equal on two
    /// answers means nothing a person agreed to has changed in between.
    /// Compare it; do not recompute it from this struct.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckSummary {
    /// How many findings of each severity.
    #[serde(default)]
    pub findings: FindingCounts,
    /// Credentials found (where, never what).
    #[serde(default)]
    pub secrets: u64,
    /// The model review: `off`, `pending` or `done`.
    #[serde(default)]
    pub review: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FindingCounts {
    pub low: u64,
    pub medium: u64,
    pub high: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageState {
    pub registry_type: String,
    pub identifier: String,
    pub version: Option<String>,
    pub verified: Verified,
    #[serde(default)]
    pub has_install_script: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_value_this_codeg_does_not_know_reads_as_unknown() {
        assert_eq!(
            serde_json::from_value::<Kind>(json!("skill")).unwrap(),
            Kind::Skill
        );
        assert_eq!(
            serde_json::from_value::<Kind>(json!("workflow")).unwrap(),
            Kind::Unknown
        );
        assert_eq!(
            serde_json::from_value::<Risk>(json!("critical")).unwrap(),
            Risk::Unknown
        );
        assert_eq!(
            serde_json::from_value::<VersionStatus>(json!("quarantined")).unwrap(),
            VersionStatus::Unknown
        );
        assert_eq!(
            serde_json::from_value::<Verified>(json!("stale")).unwrap(),
            Verified::Unknown
        );
        assert_eq!(
            serde_json::from_value::<ItemStatus>(json!("archived")).unwrap(),
            ItemStatus::Unknown
        );
        assert_eq!(
            serde_json::from_value::<AdvisoryAction>(json!("quarantine")).unwrap(),
            AdvisoryAction::Unknown
        );
        // and never as the permissive value
        assert_ne!(
            serde_json::from_value::<VersionStatus>(json!("OK")).unwrap(),
            VersionStatus::Ok
        );
    }

    #[test]
    fn install_info_reads_a_skill_with_fields_it_does_not_know() {
        let info: InstallInfo = serde_json::from_value(json!({
            "item": { "id": "0199b0aa-0000-7000-8000-000000000001", "ref": "anthropics/pdf", "kind": "skill",
                      "title": { "en": "PDF" }, "somethingNew": true },
            "version": { "revision": 3, "version": "1.2.0", "publishedAt": "2026-10-20T08:00:00.000Z", "status": "ok" },
            "archive": { "url": "/api/harness/v1/archives/9f2c.zip", "sha256": "9f2c", "size": 48213 },
            "files": [{ "path": "SKILL.md", "sha256": "ab", "size": 2201, "executable": false },
                      { "path": "run.sh", "sha256": "cd", "size": 10, "executable": true }],
            "source": null,
            "skill": { "name": "pdf", "description": "Fill PDF forms", "allowedTools": ["Bash"] },
            "permissions": { "runsCode": ["python"], "network": [], "futureField": ["x"] },
            "risk": "low",
            "reviewed": true,
            "advisories": [],
            "tools": { "sha256": "5be1" }
        }))
        .unwrap();
        assert_eq!(info.item.r#ref, "anthropics/pdf");
        assert_eq!(info.item.kind, Kind::Skill);
        assert_eq!(info.version.revision, 3);
        assert_eq!(info.version.status, VersionStatus::Ok);
        assert_eq!(info.archive.as_ref().unwrap().size, 48213);
        assert_eq!(info.files.len(), 2);
        assert!(info.files[1].executable);
        assert_eq!(
            info.skill.as_ref().unwrap().allowed_tools.as_deref(),
            Some(&["Bash".to_string()][..])
        );
        assert_eq!(info.permissions.runs_code, ["python"]);
        assert!(info.permissions.tools.is_empty());
        assert_eq!(info.packages, None);
        assert_eq!(info.risk, Risk::Low);
    }

    #[test]
    fn install_info_reads_an_mcp_server_with_pinned_packages() {
        let info: InstallInfo = serde_json::from_value(json!({
            "item": { "id": "i", "ref": "example.com/notes", "kind": "mcp", "title": {} },
            "version": { "revision": 2, "version": null, "publishedAt": "2026-10-20T08:00:00.000Z", "status": "yanked" },
            "archive": null,
            "files": [],
            "source": { "repository": "example/notes", "commit": "abc", "path": "" },
            "server": { "name": "com.example/notes", "remotes": [{ "type": "streamable-http", "url": "https://mcp.example.com/mcp" }] },
            "packages": [
                { "registryType": "npm", "identifier": "@example/notes-mcp", "version": "1.2.3", "verified": "ok",
                  "integrity": "sha512-x", "hasInstallScript": false },
                { "registryType": "pypi", "identifier": "notes", "version": null, "verified": "reverified" }
            ],
            "permissions": {},
            "risk": "severe",
            "reviewed": false,
            "advisories": [{ "id": "a1", "severity": "high", "action": "disable", "revisions": [1, 2],
                             "summary": { "zh": "停用" }, "publishedAt": "2026-10-21T00:00:00.000Z" }]
        }))
        .unwrap();
        assert_eq!(info.version.status, VersionStatus::Yanked);
        assert_eq!(info.archive, None);
        assert_eq!(info.source.as_ref().unwrap().commit, "abc");
        assert_eq!(info.server.as_ref().unwrap()["name"], "com.example/notes");
        let packages = info.packages.as_ref().unwrap();
        assert_eq!(packages[0].version.as_deref(), Some("1.2.3"));
        assert_eq!(packages[0].verified, Verified::Ok);
        assert_eq!(packages[1].version, None);
        assert_eq!(packages[1].verified, Verified::Unknown);
        assert_eq!(info.risk, Risk::Unknown);
        assert_eq!(info.advisories[0].action, AdvisoryAction::Disable);
        assert_eq!(info.advisories[0].revisions, [1, 2]);
    }

    #[test]
    fn install_info_without_what_an_install_needs_is_refused() {
        // no item id
        assert!(serde_json::from_value::<InstallInfo>(json!({
            "item": { "ref": "a/b", "kind": "skill" },
            "version": { "revision": 1, "version": null, "publishedAt": "x", "status": "ok" },
            "archive": null, "source": null, "risk": "low"
        }))
        .is_err());
        // a file without its hash
        assert!(serde_json::from_value::<InstallInfo>(json!({
            "item": { "id": "i", "ref": "a/b", "kind": "skill" },
            "version": { "revision": 1, "version": null, "publishedAt": "x", "status": "ok" },
            "archive": null, "source": null, "risk": "low",
            "files": [{ "path": "SKILL.md", "size": 1 }]
        }))
        .is_err());
        // no status
        assert!(serde_json::from_value::<InstallInfo>(json!({
            "item": { "id": "i", "ref": "a/b", "kind": "skill" },
            "version": { "revision": 1, "version": null, "publishedAt": "x" },
            "archive": null, "source": null, "risk": "low"
        }))
        .is_err());
    }

    #[test]
    fn resolve_reads_each_of_the_three_shapes() {
        let items: Vec<Resolved> = serde_json::from_value(json!([
            {
                "id": "a", "status": "public", "ref": "anthropics/pdf", "kind": "skill",
                "latest": { "revision": 4, "version": "1.3.0", "publishedAt": "2026-11-01T00:00:00.000Z" },
                "advisories": [],
                "installed": {
                    "revision": 3, "status": "ok", "risk": "medium", "reviewed": true,
                    "permissions": { "declared": { "network": ["example.com"] },
                                     "detected": { "runsCode": ["python"], "installs": [], "installScripts": [],
                                                   "network": [], "secrets": [], "paths": [], "tools": [] } },
                    "checks": { "findings": { "low": 2, "medium": 1, "high": 0 }, "secrets": 0, "review": "off" },
                    "packages": [{ "registryType": "npm", "identifier": "x", "version": "1.0.0",
                                   "verified": "pending", "hasInstallScript": true }],
                    "stateSha256": "feed"
                }
            },
            { "id": "b", "status": "listed", "ref": "x/y", "kind": "mcp",
              "latest": { "revision": 1, "version": null, "publishedAt": "p" }, "advisories": [], "installed": null },
            { "id": "c", "status": "retired", "installed": { "revision": 2, "status": "blocked" } },
            { "id": "d", "status": "removed", "installed": null },
            { "id": "e", "status": "unavailable" },
            { "id": "f", "status": "embargoed", "note": "new" }
        ]))
        .unwrap();

        let a = &items[0];
        assert_eq!(a.status, ItemStatus::Public);
        assert_eq!(a.r#ref.as_deref(), Some("anthropics/pdf"));
        assert_eq!(a.latest.as_ref().unwrap().revision, 4);
        let state = a.installed.as_ref().unwrap();
        assert_eq!(state.status, VersionStatus::Ok);
        assert_eq!(state.risk, Some(Risk::Medium));
        assert_eq!(state.state_sha256.as_deref(), Some("feed"));
        let permissions = state.permissions.as_ref().unwrap();
        assert_eq!(permissions.declared.network, ["example.com"]);
        assert_eq!(permissions.detected.runs_code, ["python"]);
        assert_eq!(state.checks.as_ref().unwrap().findings.low, 2);
        let package = &state.packages.as_ref().unwrap()[0];
        assert_eq!(package.verified, Verified::Pending);
        assert!(package.has_install_script);

        assert_eq!(items[1].status, ItemStatus::Listed);
        assert_eq!(items[1].installed, None);

        let c = &items[2];
        assert_eq!(c.status, ItemStatus::Retired);
        assert_eq!(c.r#ref, None);
        let state = c.installed.as_ref().unwrap();
        assert_eq!(state.status, VersionStatus::Blocked);
        assert_eq!(state.risk, None);
        assert_eq!(state.state_sha256, None);

        assert_eq!(items[3].status, ItemStatus::Removed);
        assert_eq!(items[4].status, ItemStatus::Unavailable);
        assert_eq!(items[4].installed, None);
        assert_eq!(items[5].status, ItemStatus::Unknown);
    }
}
