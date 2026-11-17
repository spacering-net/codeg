//! The install name: the folder a Harness skill gets in Codeg's store, and
//! the skill's id everywhere after (plan §7.3, "安装名").
//!
//! It is a skill name by the Agent Skills rule (`[a-z0-9-]`, 1 to 64, no
//! leading, trailing or doubled `-`), so that `SKILL.md`'s `name` can be set
//! to it. The default is the skill's own name; when that is taken — a pack's
//! id, a Custom skill, another Harness item, anything in the store, a link of
//! Codeg's under that name that installing would bring back to life, or
//! something of that name in a target agent's skill directory — it is
//! `<name>-<publisher>` cut to 64, then that with `-2`, `-3`, …

use crate::harness::mcp::model::Reason;
use crate::models::agent::AgentType;
use crate::skills::model::SkillOrigin;
use crate::skills::provenance::UI_IDS;
use crate::skills::world::{Entry, World};

use super::manifest::Manifest;
use super::model::{codes, NameTaken, TakenBy};

pub(crate) const PATTERN: &str = "^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$";
const MAX: usize = 64;

/// Whether `name` follows [`PATTERN`].
pub(crate) fn is_valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `text` as a skill name: lowercase, every run of anything but `[a-z0-9]`
/// one `-`, no `-` at either end, cut to `max`.
fn slug(text: &str, max: usize) -> String {
    let mut out = String::new();
    for c in text.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.truncate(max);
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// The skill's own name as an install name (the item's name when it has
/// none that is one).
pub(crate) fn base_name(skill_name: Option<&str>, item_name: &str) -> String {
    match skill_name.filter(|name| is_valid(name)) {
        Some(name) => name.to_string(),
        None => {
            let name = slug(item_name, MAX);
            if name.is_empty() {
                "skill".to_string()
            } else {
                name
            }
        }
    }
}

/// The candidates, in order: `base`, `<base>-<publisher>`, then that with
/// `-2`, `-3`, … — the first `taken` does not refuse.
pub(crate) fn first_free(base: &str, publisher: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(base) {
        return base.to_string();
    }
    let with_publisher = slug(&format!("{base}-{publisher}"), MAX);
    if !taken(&with_publisher) {
        return with_publisher;
    }
    let mut number = 2u64;
    loop {
        let suffix = format!("-{number}");
        let candidate = format!("{}{suffix}", slug(&with_publisher, MAX - suffix.len()));
        if !taken(&candidate) {
            return candidate;
        }
        number += 1;
    }
}

/// The Codeg pack whose id `name` is, if it is one.
pub(crate) fn reserved(name: &str) -> Option<SkillOrigin> {
    let packs = [
        (
            SkillOrigin::Experts,
            crate::commands::experts::bundled_ids(),
        ),
        (
            SkillOrigin::Science,
            crate::commands::science::bundled_ids(),
        ),
        (
            SkillOrigin::Office,
            crate::commands::office_tools::bundled_skill_ids(),
        ),
        (
            SkillOrigin::Ui,
            UI_IDS.iter().map(|id| id.to_string()).collect(),
        ),
    ];
    packs
        .into_iter()
        .find(|(_, ids)| ids.iter().any(|id| id.eq_ignore_ascii_case(name)))
        .map(|(origin, _)| origin)
}

fn taken(name: &str, by: TakenBy) -> NameTaken {
    NameTaken {
        name: name.to_string(),
        by,
        pack: None,
        item_id: None,
        item_ref: None,
        path: None,
        agents: Vec::new(),
    }
}

/// Everything that holds `name`, for the item `item_id` (whose own install
/// under that name holds nothing), with `targets` the agents it would be
/// linked to.
pub(crate) fn holders(
    world: &World<'_>,
    manifest: &Manifest,
    name: &str,
    item_id: &str,
    targets: &[AgentType],
) -> Vec<NameTaken> {
    let ctx = world.ctx;
    let mut out = Vec::new();
    if let Some(pack) = reserved(name) {
        out.push(NameTaken {
            pack: Some(pack),
            ..taken(name, TakenBy::Reserved)
        });
    }
    let ours = manifest
        .skills
        .get(name)
        .is_some_and(|entry| entry.item_id == item_id);
    for (key, entry) in &manifest.skills {
        if key.eq_ignore_ascii_case(name) && entry.item_id != item_id {
            out.push(NameTaken {
                item_id: Some(entry.item_id.clone()),
                item_ref: Some(entry.item_ref.clone()),
                path: Some(ctx.skill_path(key).to_string_lossy().into_owned()),
                ..taken(name, TakenBy::Harness)
            });
        }
    }
    for child in crate::skills::fsio::child_names(&ctx.store) {
        if child.starts_with('.') || !child.eq_ignore_ascii_case(name) {
            continue;
        }
        if ours && child == name {
            continue;
        }
        if manifest.skills.contains_key(&child) {
            continue; // reported above
        }
        let path = ctx.skill_path(&child).to_string_lossy().into_owned();
        let found = match world.provenance.origin_of(&ctx.store, &child) {
            Some(SkillOrigin::Custom) => taken(name, TakenBy::Custom),
            Some(SkillOrigin::Harness) => taken(name, TakenBy::Harness),
            Some(pack) => NameTaken {
                pack: Some(pack),
                ..taken(name, TakenBy::Pack)
            },
            None => taken(name, TakenBy::Store),
        };
        out.push(NameTaken {
            path: Some(path),
            ..found
        });
    }
    if !ours {
        // A link (or copy) Codeg made under this name anywhere comes back to
        // life once the store has the name again: whoever reads it would see
        // this skill unasked.
        for dir in ctx.all_dirs() {
            let path = dir.join(name);
            let codeg = match world.entry(&path) {
                Entry::CodegLink { skill, .. } | Entry::CodegCopy { skill, .. } => {
                    skill.eq_ignore_ascii_case(name)
                }
                _ => false,
            };
            if codeg {
                out.push(NameTaken {
                    path: Some(path.to_string_lossy().into_owned()),
                    agents: ctx
                        .dir_info(&dir)
                        .map(|info| info.readers.clone())
                        .unwrap_or_default(),
                    ..taken(name, TakenBy::CodegLink)
                });
            }
        }
    }
    for agent in targets {
        for (path, _, _, entry) in world.entries_of(*agent, name) {
            if entry.is_codeg_of(name) && ours {
                continue;
            }
            if matches!(entry, Entry::CodegLink { .. } | Entry::CodegCopy { .. }) && !ours {
                continue; // reported above
            }
            let path = path.to_string_lossy().into_owned();
            match out
                .iter_mut()
                .find(|found| found.by == TakenBy::AgentDir && found.path.as_ref() == Some(&path))
            {
                Some(found) => found.agents.push(*agent),
                None => out.push(NameTaken {
                    path: Some(path),
                    agents: vec![*agent],
                    ..taken(name, TakenBy::AgentDir)
                }),
            }
        }
    }
    out
}

/// What of `holders` stops an install under the name (all but a target
/// agent's own entry, which only that agent's link is refused over).
pub(crate) fn refusals(holders: &[NameTaken]) -> Vec<Reason> {
    holders
        .iter()
        .filter(|holder| holder.by != TakenBy::AgentDir)
        .map(|holder| {
            if holder.by == TakenBy::Reserved {
                let pack = holder.pack.map(|pack| pack.as_str()).unwrap_or_default();
                return Reason::new(codes::NAME_RESERVED)
                    .param("name", holder.name.clone())
                    .param("pack", pack);
            }
            let by = serde_json::to_value(holder.by)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_default();
            let mut reason = Reason::new(codes::NAME_TAKEN)
                .param("name", holder.name.clone())
                .param("by", by);
            if let Some(path) = &holder.path {
                reason = reason.param("path", path.clone());
            }
            if let Some(item_ref) = &holder.item_ref {
                reason = reason.param("item_ref", item_ref.clone());
            }
            reason
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_a_skill_name() {
        for good in ["pdf", "pdf-tools", "a", "x1-2", &"a".repeat(64)] {
            assert!(is_valid(good), "{good}");
        }
        for bad in [
            "",
            "-pdf",
            "pdf-",
            "pdf--tools",
            "PDF",
            "pdf_tools",
            "pdf.tools",
            "pdf tools",
            &"a".repeat(65),
        ] {
            assert!(!is_valid(bad), "{bad}");
        }
    }

    #[test]
    fn the_candidates_go_name_then_publisher_then_numbers() {
        assert_eq!(first_free("pdf", "anthropics", |_| false), "pdf");
        assert_eq!(
            first_free("pdf", "acme.dev", |name| name == "pdf"),
            "pdf-acme-dev"
        );
        assert_eq!(
            first_free("pdf", "acme.dev", |name| name == "pdf"
                || name == "pdf-acme-dev"),
            "pdf-acme-dev-2"
        );
        let long = "a".repeat(60);
        let free = first_free(&long, "publisher", |name| !name.ends_with("-3"));
        assert!(
            free.len() <= 64 && free.ends_with("-3") && is_valid(&free),
            "{free}"
        );
        // a publisher that would double a dash
        assert_eq!(first_free("x", "a-.b", |name| name == "x"), "x-a-b");
        assert_eq!(base_name(Some("Not Valid"), "my-skill"), "my-skill");
        assert_eq!(base_name(None, "My_Skill.v2"), "my-skill-v2");
    }
}
