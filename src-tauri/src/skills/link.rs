//! Making and reading the links that put a skill in an agent's directory.
//!
//! On Unix a link is a symlink. On Windows it is a junction, and only where a
//! junction cannot be made does Codeg copy the skill instead — through a
//! staging folder and a rename, after checking that nothing is at the target
//! (`super::copies`). That decision is the engine's, not the platform's: the
//! [`LinkStrategy`] only makes a link or fails, and says whether a copy may
//! stand in. Tests inject one whose "junction" always fails, so the copy
//! logic runs on any machine; only the junction call itself is
//! `cfg(windows)`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// How a link Codeg made was made — and, in the record, `copy` for a copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkMode {
    Symlink,
    Junction,
    Copy,
}

impl LinkMode {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkMode::Symlink => "symlink",
            LinkMode::Junction => "junction",
            LinkMode::Copy => "copy",
        }
    }
}

/// Makes directory links. `link` never exists when it is called.
pub trait LinkStrategy: Send + Sync {
    fn link(&self, target: &Path, link: &Path) -> io::Result<LinkMode>;
    /// Whether a skill may be copied where no link can be made (Windows).
    fn copy_fallback(&self) -> bool;
}

/// The platform's links: symlinks on Unix, junctions on Windows (with the
/// copy fallback).
#[derive(Debug, Default, Clone, Copy)]
pub struct PlatformLinks;

impl LinkStrategy for PlatformLinks {
    fn link(&self, target: &Path, link: &Path) -> io::Result<LinkMode> {
        platform_link(target, link)
    }

    fn copy_fallback(&self) -> bool {
        cfg!(windows)
    }
}

/// A directory link at `link` to `target`, the platform's way, with no copy
/// to fall back to.
#[cfg(unix)]
pub fn platform_link(target: &Path, link: &Path) -> io::Result<LinkMode> {
    std::os::unix::fs::symlink(target, link).map(|()| LinkMode::Symlink)
}

#[cfg(windows)]
pub fn platform_link(target: &Path, link: &Path) -> io::Result<LinkMode> {
    junction::create(target, link).map(|()| LinkMode::Junction)
}

#[cfg(not(any(unix, windows)))]
pub fn platform_link(_target: &Path, _link: &Path) -> io::Result<LinkMode> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "directory links are not supported here",
    ))
}

/// On Windows a junction is a directory reparse point; `symlink_metadata`
/// may report it as a directory.
#[cfg(windows)]
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &fs::Metadata) -> bool {
    false
}

/// The link's target as it reads, made absolute against the link's
/// directory. Windows junctions through the `junction` crate.
pub fn read_target(path: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    let raw = junction::get_target(path)
        .ok()
        .or_else(|| fs::read_link(path).ok());
    #[cfg(not(windows))]
    let raw = fs::read_link(path).ok();
    let raw = raw?;
    let raw = super::fsio::strip_verbatim(&raw);
    Some(if raw.is_relative() {
        match path.parent() {
            Some(parent) => super::fsio::lexical(&parent.join(&raw)),
            None => raw,
        }
    } else {
        super::fsio::lexical(&raw)
    })
}

/// What is at a path, before anyone's ownership is considered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawEntry {
    Absent,
    /// A symlink or junction. `resolved`: where it leads, `None` when it
    /// dangles.
    Link {
        target: Option<PathBuf>,
        resolved: Option<PathBuf>,
    },
    Dir,
    File,
    Unreadable(String),
}

pub fn inspect(path: &Path) -> RawEntry {
    match fs::symlink_metadata(path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => RawEntry::Absent,
        Err(err) => RawEntry::Unreadable(err.to_string()),
        Ok(meta) => {
            if meta.file_type().is_symlink() || is_reparse_point(&meta) {
                RawEntry::Link {
                    target: read_target(path),
                    resolved: fs::canonicalize(path).ok(),
                }
            } else if meta.is_dir() {
                RawEntry::Dir
            } else {
                RawEntry::File
            }
        }
    }
}

/// Remove the entry at `path`: only the link when it is one, the whole tree
/// when it is a real folder.
pub fn remove_entry(path: &Path) -> io::Result<()> {
    crate::commands::acp::remove_skill_entry(path)
}
