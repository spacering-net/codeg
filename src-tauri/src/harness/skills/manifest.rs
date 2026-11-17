//! `~/.codeg/skills/.manifest.harness.json`: which skills in Codeg's store
//! came from Harness, and exactly what was installed.
//!
//! The skills engine reads it to tell those skills apart (`origin:
//! "harness"`, with `ref` and `version`; `skills::provenance`): every key of
//! `skills` claims that store id. The shape is the engine's, extended:
//!
//! ```json
//! { "format": 1,
//!   "skills": {
//!     "pdf": { "item_id": "0199…", "ref": "anthropics/pdf", "revision": 3,
//!              "version": "1.2.0", "archive_sha256": "9f2c…", "source": null,
//!              "files": { "SKILL.md": "<sha256 as installed>", … },
//!              "rewrites": { "allowed_tools": "removed" },
//!              "state_sha256": "<the /resolve fingerprint confirmed>",
//!              "installed_at": "2026-11-17T09:30:00.000Z",
//!              "op": "<the operation that wrote it>" } } }
//! ```
//!
//! It sits beside the packs' manifests, inside the skills directory, so it
//! goes into Codeg's backup and comes back with it. Written whole (a temp
//! file renamed over it, the owner's alone) and only under the skills lock.
//! Fields a newer Codeg adds are kept when this one rewrites the file; a
//! newer `format` is read but never rewritten.
//!
//! [`load`] is also how the skills engine decides whether the file can be
//! read at all (`skills::provenance`): whatever it refuses leaves every
//! unclaimed store skill's owner unresolved.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::harness::types::Source;
use crate::skills::provenance::HARNESS_MANIFEST;

use super::model::Rewrites;

/// The manifest's format this Codeg writes.
pub(crate) const FORMAT: u64 = 1;

/// One installed skill, under its install name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ManifestEntry {
    pub item_id: String,
    #[serde(rename = "ref")]
    pub item_ref: String,
    pub revision: u64,
    #[serde(default)]
    pub version: Option<String>,
    /// The archive's SHA-256; `null` when the files came from `source`.
    #[serde(default)]
    pub archive_sha256: Option<String>,
    #[serde(default)]
    pub source: Option<Source>,
    /// Every file as installed (after the rewrites): path → SHA-256.
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    #[serde(default)]
    pub rewrites: Rewrites,
    #[serde(default)]
    pub state_sha256: String,
    #[serde(default)]
    pub installed_at: String,
    /// The operation that wrote this entry: how a journal tells whether its
    /// commit happened.
    #[serde(default)]
    pub op: String,
    /// What a newer Codeg added.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Manifest {
    pub format: u64,
    pub skills: BTreeMap<String, ManifestEntry>,
    /// Top-level fields this Codeg does not know.
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ManifestError {
    Unreadable {
        path: PathBuf,
        detail: String,
    },
    /// Written by a newer Codeg: read, never rewritten.
    Newer {
        path: PathBuf,
        format: u64,
    },
}

impl ManifestError {
    pub fn detail(&self) -> String {
        match self {
            ManifestError::Unreadable { path, detail } => format!("{}: {detail}", path.display()),
            ManifestError::Newer { path, format } => format!(
                "{} was written by a newer Codeg (format {format})",
                path.display()
            ),
        }
    }
}

pub(crate) fn path(store: &Path) -> PathBuf {
    store.join(HARNESS_MANIFEST)
}

impl Manifest {
    /// The item `item_id`'s entry: (install name, entry).
    pub fn find_item(&self, item_id: &str) -> Option<(&String, &ManifestEntry)> {
        self.skills
            .iter()
            .find(|(_, entry)| entry.item_id == item_id)
    }
}

/// The manifest as it is (an absent file is an empty one). A newer format
/// is read.
pub(crate) fn load(store: &Path) -> Result<Manifest, ManifestError> {
    let path = path(store);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Ok(Manifest {
                format: FORMAT,
                ..Manifest::default()
            })
        }
        Err(err) => {
            return Err(ManifestError::Unreadable {
                path,
                detail: err.to_string(),
            })
        }
    };
    let unreadable = |detail: String| ManifestError::Unreadable {
        path: path.clone(),
        detail,
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| unreadable(e.to_string()))?;
    let Value::Object(mut root) = value else {
        return Err(unreadable("not a JSON object".to_string()));
    };
    let format = match root.remove("format") {
        None => FORMAT,
        Some(value) => value
            .as_u64()
            .ok_or_else(|| unreadable("`format` is not a number".to_string()))?,
    };
    // Every manifest this step writes has `skills`; one without it (or with
    // `null`) is not one it wrote, and says nothing about whose a skill is.
    let skills = match root.remove("skills") {
        None | Some(Value::Null) => return Err(unreadable("no `skills`".to_string())),
        Some(value) => serde_json::from_value::<BTreeMap<String, ManifestEntry>>(value)
            .map_err(|e| unreadable(format!("`skills`: {e}")))?,
    };
    Ok(Manifest {
        format,
        skills,
        extra: root,
    })
}

/// [`load`], for a caller about to write: a newer format is refused.
pub(crate) fn load_for_write(store: &Path) -> Result<Manifest, ManifestError> {
    let manifest = load(store)?;
    if manifest.format > FORMAT {
        return Err(ManifestError::Newer {
            path: path(store),
            format: manifest.format,
        });
    }
    Ok(manifest)
}

/// Write it whole, atomically. Caller holds the skills lock.
pub(crate) fn save(store: &Path, manifest: &Manifest) -> io::Result<()> {
    let mut root = manifest.extra.clone();
    root.insert("format".into(), Value::from(FORMAT));
    root.insert(
        "skills".into(),
        serde_json::to_value(&manifest.skills).map_err(io::Error::other)?,
    );
    let bytes = serde_json::to_vec_pretty(&Value::Object(root)).map_err(io::Error::other)?;
    fs::create_dir_all(store)?;
    crate::skills::fsio::write_private_atomic(&path(store), &bytes)
}
