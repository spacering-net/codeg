//! The single table of codeg-owned data sections a backup packs and a restore
//! swaps back in.
//!
//! Backup ([`super::core::create_backup_core`]) and restore
//! ([`super::restore::apply_pending_restore_with_paths`]) both iterate
//! [`MANAGED_SECTIONS`]. They used to keep separate hardcoded lists kept in
//! sync by hand, and they drifted: `~/.codeg/acp-transcripts` — the ONLY copy
//! of a custom ACP agent's conversation text, since the DB stores no duplicate
//! — was in neither list, so a backup/restore round-trip left the conversation
//! rows behind with every message gone. One table, two consumers, plus
//! `every_section_is_packed_and_swapped` so a new section that is added to the
//! table but not wired up fails loudly instead of silently losing data.
//!
//! This is an ALLOWLIST, not `~/.codeg` minus a denylist: a future
//! `~/.codeg/<secrets>` must not be swept into an archive just because nobody
//! remembered to exclude it. Deliberately out of the table: `logs/`
//! (diagnostics), `cache/` (refetchable), `npm-global/` (machine-bound
//! toolchain), `agents/` (no reader/writer in the current code) and the
//! `.codeg-*` scaffolding dirs.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Whether a section is a directory tree or a single file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SectionKind {
    Dir,
    File,
}

/// How the restore swap treats a section.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SectionPolicy {
    /// The archive's copy is authoritative: the live tree is replaced
    /// wholesale, so restoring a backup whose section was empty CLEARS it.
    /// Staging force-creates the directory so "empty" is representable.
    AlwaysReplace,
    /// Swapped in only when the archive actually carried it — a backup taken
    /// on a machine without `tokens.json` must not wipe this machine's.
    ReplaceIfPresent,
}

/// One codeg-owned data section.
pub struct ManagedSection {
    /// Archive path prefix, snapshot subdirectory, and the stable identifier
    /// recorded in the manifest and the pending-restore marker. Never rename:
    /// old archives and old markers are matched by this string.
    pub id: &'static str,
    pub kind: SectionKind,
    pub policy: SectionPolicy,
    /// Live location. `data_dir` is the only runtime input; everything else
    /// resolves through `paths::*` (which honor `CODEG_HOME` /
    /// `CODEG_DATA_DIR`).
    pub live_path: fn(data_dir: &Path) -> PathBuf,
}

/// Sections the *previous* archive format managed implicitly. An archive or a
/// marker written before `managedSections` existed is normalized to exactly
/// this set, so restoring an old backup can never clear a section that format
/// never knew about.
pub const LEGACY_SECTION_IDS: &[&str] = &["uploads", "tokens.json", "preferences.json"];

pub const MANAGED_SECTIONS: &[ManagedSection] = &[
    ManagedSection {
        id: "uploads",
        kind: SectionKind::Dir,
        policy: SectionPolicy::AlwaysReplace,
        live_path: |_| crate::paths::codeg_uploads_root(),
    },
    ManagedSection {
        // The conversation text of every custom ACP agent. `acp_transcript.rs`
        // writes it, `parsers::acp_native` reads it back, and nothing else
        // holds a copy — losing this loses the conversations outright.
        id: "acp-transcripts",
        kind: SectionKind::Dir,
        policy: SectionPolicy::AlwaysReplace,
        live_path: |_| crate::paths::codeg_acp_transcripts_root(),
    },
    ManagedSection {
        // Per-turn wall-clock spans for agents whose native store has no
        // timestamps (Cursor). Without it a restored history shows no durations.
        id: "turn-timings",
        kind: SectionKind::Dir,
        policy: SectionPolicy::AlwaysReplace,
        live_path: |_| crate::paths::codeg_turn_timings_root(),
    },
    ManagedSection {
        // `preferences.json` records the chosen background by filename, so the
        // image has to travel with it.
        id: "backgrounds",
        kind: SectionKind::Dir,
        policy: SectionPolicy::AlwaysReplace,
        live_path: |_| crate::paths::codeg_backgrounds_root(),
    },
    ManagedSection {
        id: "pets",
        kind: SectionKind::Dir,
        policy: SectionPolicy::AlwaysReplace,
        live_path: |_| crate::paths::codeg_pets_root(),
    },
    ManagedSection {
        // Includes user-authored skills, which exist nowhere else. Built-in
        // packs re-extract by id at startup (`experts::ensure_central_experts_installed`,
        // id-scoped and never a wipe), so replacing the tree self-heals those;
        // what a replace can drop is a hand-made skill the backup predates —
        // the same semantics as `uploads`, and it survives in the safety
        // snapshot. Note `central_experts_dir()` resolves against the real home
        // and does NOT honor `CODEG_HOME`/`CODEG_DATA_DIR`; changing that would
        // relocate every existing user's skill library, so it stays as-is and
        // this entry is simply environment-independent.
        id: "skills",
        kind: SectionKind::Dir,
        policy: SectionPolicy::AlwaysReplace,
        live_path: |_| crate::commands::experts::central_experts_dir(),
    },
    ManagedSection {
        id: "tokens.json",
        kind: SectionKind::File,
        policy: SectionPolicy::ReplaceIfPresent,
        live_path: |data_dir| data_dir.join("tokens.json"),
    },
    ManagedSection {
        id: "preferences.json",
        kind: SectionKind::File,
        policy: SectionPolicy::ReplaceIfPresent,
        live_path: |_| crate::paths::codeg_home_dir().join("preferences.json"),
    },
];

/// `db/codeg.db` is deliberately NOT a managed section: its live filename
/// varies (`codeg-dev.db` on debug desktop builds) and it is captured with
/// `VACUUM INTO` rather than a file copy, so both sides handle it explicitly.
pub const DB_SECTION_PREFIX: &str = "db";

/// Archive path prefix for the optional external agent-CLI transcript trees.
pub const EXTERNAL_SECTION_PREFIX: &str = "external";

pub fn find_section(id: &str) -> Option<&'static ManagedSection> {
    MANAGED_SECTIONS.iter().find(|s| s.id == id)
}

/// Every section id, in table order — what a fresh archive declares it manages.
pub fn all_section_ids() -> Vec<String> {
    MANAGED_SECTIONS.iter().map(|s| s.id.to_string()).collect()
}

/// Keep only ids this binary knows, preserving table order so the result is
/// deterministic regardless of how the archive ordered them. Unknown ids (an
/// archive from a newer build) are dropped with a warning rather than guessed
/// at — this binary has no live path for them.
pub fn normalize_section_ids(declared: &[String]) -> Vec<String> {
    for id in declared {
        if find_section(id).is_none() {
            tracing::warn!("[RESTORE] ignoring unknown managed section '{id}' from backup");
        }
    }
    MANAGED_SECTIONS
        .iter()
        .filter(|s| declared.iter().any(|d| d == s.id))
        .map(|s| s.id.to_string())
        .collect()
}

/// Exclude codeg-internal scaffolding from any packed section: upload staging
/// (`uploads/.tmp/`) and any `.codeg-*` directory (restore staging / safety
/// snapshots), which must never be archived even if a data-dir layout ever
/// nests one inside a section root.
pub fn is_excluded_section_entry(rel: &Path) -> bool {
    rel.components().any(|c| match c {
        std::path::Component::Normal(s) => {
            let s = s.to_string_lossy();
            s == ".tmp" || s.starts_with(".codeg")
        }
        _ => false,
    })
}

/// Live location of every managed section, resolved once so backup and restore
/// agree and so tests can point the whole set at a temp dir instead of the
/// real `~/.codeg`.
#[derive(Debug, Clone)]
pub struct LiveRoots {
    paths: BTreeMap<&'static str, PathBuf>,
}

impl LiveRoots {
    /// Production resolution: run each section's `live_path` against `data_dir`.
    pub fn resolve(data_dir: &Path) -> Self {
        Self {
            paths: MANAGED_SECTIONS
                .iter()
                .map(|s| (s.id, (s.live_path)(data_dir)))
                .collect(),
        }
    }

    pub fn path(&self, id: &str) -> Option<&Path> {
        self.paths.get(id).map(|p| p.as_path())
    }

    /// Every (id, live path) pair, in section-table order.
    pub fn iter(&self) -> impl Iterator<Item = (&'static str, &Path)> + '_ {
        MANAGED_SECTIONS
            .iter()
            .filter_map(move |s| self.paths.get(s.id).map(|p| (s.id, p.as_path())))
    }

    /// Point every section at `base/<id>` so a test exercises the real table
    /// without touching the user's home directory.
    #[cfg(test)]
    pub fn rooted_at(base: &Path) -> Self {
        Self {
            paths: MANAGED_SECTIONS
                .iter()
                .map(|s| (s.id, base.join(s.id)))
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn section_ids_are_unique_and_path_safe() {
        let mut seen = std::collections::HashSet::new();
        for s in MANAGED_SECTIONS {
            assert!(seen.insert(s.id), "duplicate section id: {}", s.id);
            assert!(!s.id.is_empty());
            assert!(
                !s.id.contains('/') && !s.id.contains('\\') && s.id != ".." && s.id != ".",
                "section id must be a single safe path component: {}",
                s.id
            );
            // `db`, `db-wal` and `db-shm` are the swap's own unit ids; a
            // section sharing one would collide in the swap-state directory
            // and in the snapshot manifest.
            for reserved in [DB_SECTION_PREFIX, EXTERNAL_SECTION_PREFIX] {
                assert_ne!(s.id, reserved, "reserved id: {reserved}");
            }
            for suffix in ["-wal", "-shm"] {
                assert_ne!(s.id, format!("{DB_SECTION_PREFIX}{suffix}"));
            }
        }
    }

    /// A section nested inside another would be packed twice and swapped twice,
    /// with the outer replace clobbering the inner one.
    #[test]
    fn no_live_root_is_nested_inside_another() {
        let dir = tempfile::tempdir().unwrap();
        let roots = LiveRoots::resolve(dir.path());
        let all: Vec<_> = roots.iter().collect();
        for (a_id, a) in &all {
            for (b_id, b) in &all {
                if a_id == b_id {
                    continue;
                }
                assert!(
                    !b.starts_with(a),
                    "section '{b_id}' ({}) is nested inside '{a_id}' ({})",
                    b.display(),
                    a.display()
                );
            }
        }
    }

    /// `restore::stage_restore_core` represents "the backup had nothing here"
    /// by force-creating an empty staged DIRECTORY. A file section can't
    /// express that, so `AlwaysReplace` on a file would silently degrade to
    /// `ReplaceIfPresent` instead of clearing the live file.
    #[test]
    fn always_replace_sections_are_directories() {
        for s in MANAGED_SECTIONS {
            if s.policy == SectionPolicy::AlwaysReplace {
                assert_eq!(
                    s.kind,
                    SectionKind::Dir,
                    "section '{}' is AlwaysReplace but not a directory",
                    s.id
                );
            }
        }
    }

    #[test]
    fn legacy_ids_are_all_real_sections() {
        for id in LEGACY_SECTION_IDS {
            assert!(find_section(id).is_some(), "unknown legacy section: {id}");
        }
    }

    #[test]
    fn normalize_drops_unknown_ids_and_restores_table_order() {
        let declared = vec![
            "preferences.json".to_string(),
            "from-the-future".to_string(),
            "uploads".to_string(),
        ];
        assert_eq!(
            normalize_section_ids(&declared),
            vec!["uploads".to_string(), "preferences.json".to_string()]
        );
    }

    #[test]
    fn excludes_scaffolding_entries() {
        assert!(is_excluded_section_entry(Path::new(".tmp/partial")));
        assert!(is_excluded_section_entry(Path::new(
            "a/.codeg-restore-staging/x"
        )));
        assert!(!is_excluded_section_entry(Path::new("a/b.png")));
    }
}
