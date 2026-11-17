//! `skills_adopt`: move an agent's own skill into Codeg's store and put a
//! link in its place ("move into Codeg management"; the older "import from
//! agent" only copied, and the agent's cell then read "blocked by a real
//! folder").
//!
//! 1. Copy the skill into the store's staging and check the copy.
//! 2. Rename it into the store.
//! 3. Move the original into staging beside the agent's directory.
//! 4. Put a link in its place (a copy where no link can be made).
//! 5. Record it; only then delete the staged original.
//!
//! Any failure puts back what was done, in reverse; the original is never
//! deleted before the link is in place. Caller holds the skills lock.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::acp::types::AgentSkillLayout;
use crate::models::agent::AgentType;

use super::apply::Changed;
use super::copies;
use super::fsio::{copy_markdown_as_skill, copy_tree_durable, hash_skill_dir, op_id, rename};
use super::link::{self, inspect, LinkMode, RawEntry};
use super::model::{codes, AdoptOutcome, DirRole, SkillsAdoptResult, SkillsIssue};
use super::provenance::STAGING_DIR;
use super::record::{now, RecordEntry};
use super::world::World;
use super::SkillsCtx;

pub(crate) struct AdoptRequest {
    pub agent: AgentType,
    pub skill: String,
    /// Which of the agent's directories; the first that has it otherwise.
    pub dir: Option<PathBuf>,
}

fn result(request: &AdoptRequest, outcome: AdoptOutcome) -> SkillsAdoptResult {
    SkillsAdoptResult {
        outcome,
        ok: outcome == AdoptOutcome::Adopted,
        skill: request.skill.trim().to_string(),
        agent: request.agent,
        source: None,
        store_path: None,
        link_path: None,
        mode: None,
        restored: true,
        issues: Vec::new(),
    }
}

fn refuse(mut out: SkillsAdoptResult, issue: SkillsIssue) -> (SkillsAdoptResult, Changed) {
    out.outcome = AdoptOutcome::Invalid;
    out.ok = false;
    out.issues.push(issue);
    (out, Changed::default())
}

/// Where the agent's own skill `id` is: (its directory, the entry, layout).
fn locate(
    ctx: &SkillsCtx,
    agent: AgentType,
    id: &str,
    only: Option<&Path>,
) -> Result<(PathBuf, PathBuf, AgentSkillLayout), SkillsIssue> {
    let markdown = ctx.agent(agent).map(|a| a.markdown_files).unwrap_or(false);
    let mut dirs = ctx.dirs_of(agent);
    if let Some(only) = only {
        let Some(info) = ctx.dir_info(only) else {
            return Err(SkillsIssue::new(codes::PATH_OUTSIDE_AGENT_DIRS).path(only));
        };
        dirs.retain(|(d, _)| super::fsio::same_path(&d.key, &info.key));
        if dirs.is_empty() {
            return Err(SkillsIssue::new(codes::PATH_OUTSIDE_AGENT_DIRS).path(only));
        }
    }
    for (info, role) in dirs {
        let folder = info.path.join(id);
        let flat = info.path.join(format!("{id}.md"));
        let found = match inspect(&folder) {
            RawEntry::Dir if folder.join("SKILL.md").is_file() => {
                Some((folder.clone(), AgentSkillLayout::SkillDirectory))
            }
            RawEntry::Link { .. } => {
                return Err(SkillsIssue::new(codes::NOT_OWN_SKILL).path(&folder));
            }
            RawEntry::Unreadable(err) => {
                return Err(SkillsIssue::new(codes::IO_ERROR).path(&folder).detail(err));
            }
            _ if markdown && matches!(inspect(&flat), RawEntry::File) => {
                Some((flat.clone(), AgentSkillLayout::MarkdownFile))
            }
            _ => None,
        };
        if let Some((entry, layout)) = found {
            if role == DirRole::ReadOnly {
                return Err(SkillsIssue::new(codes::READ_ONLY_SKILL).path(&entry));
            }
            if layout == AgentSkillLayout::MarkdownFile && fs::symlink_metadata(&folder).is_ok() {
                return Err(SkillsIssue::new(codes::TARGET_OCCUPIED).path(&folder));
            }
            return Ok((info.path.clone(), entry, layout));
        }
    }
    Err(SkillsIssue::new(codes::NOT_FOUND))
}

pub(crate) fn adopt_blocking(
    ctx: &SkillsCtx,
    request: &AdoptRequest,
) -> (SkillsAdoptResult, Changed) {
    let mut out = result(request, AdoptOutcome::Adopted);
    let id = match crate::commands::acp::validate_skill_id(&request.skill) {
        Ok(id) => id,
        Err(err) => {
            return refuse(
                out,
                SkillsIssue::new(codes::SKILL_INVALID).detail(err.to_string()),
            )
        }
    };
    if ctx.agent(request.agent).is_none() {
        return refuse(out, SkillsIssue::new(codes::AGENT_UNSUPPORTED));
    }
    let (dir, source, layout) = match locate(ctx, request.agent, &id, request.dir.as_deref()) {
        Ok(found) => found,
        Err(issue) => return refuse(out, issue),
    };
    out.source = Some(source.to_string_lossy().into_owned());
    let central = ctx.skill_path(&id);
    if fs::symlink_metadata(&central).is_ok() {
        return refuse(out, SkillsIssue::new(codes::ID_TAKEN).path(&central));
    }
    let link_path = dir.join(&id);

    // `restored`: what could not be put back, with what was kept for it.
    let fail = |mut out: SkillsAdoptResult,
                issue: SkillsIssue,
                restored: Result<(), (String, Vec<PathBuf>)>| {
        out.outcome = AdoptOutcome::Failed;
        out.ok = false;
        out.issues.push(issue);
        if let Err((err, kept)) = restored {
            out.restored = false;
            out.issues.push(
                SkillsIssue::new(codes::ROLLBACK_FAILED)
                    .path(&dir)
                    .detail(err)
                    .kept(&kept),
            );
        }
        (out, Changed::default())
    };
    let issue = |code: &str, path: &Path, err: io::Error| {
        SkillsIssue::new(code).path(path).detail(err.to_string())
    };

    // 1. Copy into the store's staging, and check it.
    let store_op = ctx.store.join(STAGING_DIR).join(op_id());
    let staged_new = store_op.join("new");
    let drop_store_op = || {
        let _ = fs::remove_dir_all(&store_op);
        super::fsio::remove_if_empty(&ctx.store.join(STAGING_DIR));
    };
    let copied = (|| {
        fs::create_dir_all(&store_op)?;
        ctx.fault("adopt_copy")?;
        // Flushed to disk: the original is deleted once the link is in.
        match layout {
            AgentSkillLayout::SkillDirectory => copy_tree_durable(&source, &staged_new),
            AgentSkillLayout::MarkdownFile => copy_markdown_as_skill(&source, &staged_new),
        }
    })();
    if let Err(err) = copied {
        drop_store_op();
        return fail(out, issue(codes::COPY_FAILED, &source, err), Ok(()));
    }
    let verified = ctx.fault("adopt_verify").and_then(|()| match layout {
        AgentSkillLayout::SkillDirectory => {
            if hash_skill_dir(&source, &id)? == hash_skill_dir(&staged_new, &id)? {
                Ok(())
            } else {
                Err(io::Error::other("the copy does not match the original"))
            }
        }
        AgentSkillLayout::MarkdownFile => {
            if fs::read(&source)? == fs::read(staged_new.join("SKILL.md"))? {
                Ok(())
            } else {
                Err(io::Error::other("the copy does not match the original"))
            }
        }
    });
    if let Err(err) = verified {
        drop_store_op();
        return fail(out, issue(codes::VERIFY_FAILED, &source, err), Ok(()));
    }

    // 2. Into the store — its entry there flushed to disk, as the copy
    // itself was: the original is deleted once the link is in.
    if let Err(err) = ctx
        .fault("adopt_install")
        .and_then(|()| rename(&staged_new, &central))
    {
        drop_store_op();
        return fail(out, issue(codes::IO_ERROR, &central, err), Ok(()));
    }
    if let Err(err) = super::fsio::flush_dir(&ctx.store) {
        drop_store_op();
        let restored =
            fs::remove_dir_all(&central).map_err(|e| (e.to_string(), vec![central.clone()]));
        return fail(out, issue(codes::IO_ERROR, &ctx.store, err), restored);
    }
    drop_store_op();
    out.store_path = Some(central.to_string_lossy().into_owned());
    let drop_store_copy =
        || fs::remove_dir_all(&central).map_err(|e| (e.to_string(), vec![central.clone()]));

    // 3. The original into staging beside the agent's directory.
    let agent_op = match copies::start_adopt(&source, &link_path, &id) {
        Ok(op) => op,
        Err(err) => {
            let restored = drop_store_copy();
            return fail(out, issue(codes::IO_ERROR, &source, err), restored);
        }
    };
    let original = agent_op.join("old");
    if let Err(err) = ctx
        .fault("adopt_move")
        .and_then(|()| rename(&source, &original))
    {
        copies::commit(&agent_op);
        let restored = drop_store_copy();
        return fail(out, issue(codes::IO_ERROR, &source, err), restored);
    }
    // The original back in its place; only then does the store's copy go.
    // When the original cannot go back, nothing is deleted: it waits in
    // staging (its journal puts it back at the next start), and the store's
    // checked copy stays too.
    let put_back = || -> Result<(), (String, Vec<PathBuf>)> {
        if let Err(err) = ctx
            .fault("adopt_put_back")
            .and_then(|()| rename(&original, &source))
        {
            return Err((
                format!("the original is in {}: {err}", original.display()),
                vec![original.clone(), agent_op.clone(), central.clone()],
            ));
        }
        copies::commit(&agent_op);
        drop_store_copy()
    };

    // 4. The link (or, where none can be made and copies may stand in, a copy).
    let made = ctx.fault("adopt_link").and_then(|()| {
        if fs::symlink_metadata(&link_path).is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("{} already exists", link_path.display()),
            ));
        }
        match ctx.linker.link(&central, &link_path) {
            Ok(mode) => Ok((mode, None)),
            Err(link_err) if ctx.linker.copy_fallback() => {
                copies::clear_failed_link_leftover(&link_path);
                copies::create_copy(ctx, &central, &link_path, &id)
                    .map(|hash| (LinkMode::Copy, Some(hash)))
                    .map_err(|copy_err| {
                        io::Error::other(format!("link: {link_err}; copy: {copy_err}"))
                    })
            }
            Err(err) => Err(err),
        }
    });
    let (mode, copy_hash) = match made {
        Ok(made) => made,
        Err(err) => {
            let restored = put_back();
            return fail(out, issue(codes::LINK_FAILED, &link_path, err), restored);
        }
    };

    // 5. The record; then the staged original can go.
    let mut world = World::load(ctx);
    world.record.insert(RecordEntry {
        skill: id.clone(),
        dir: dir.to_string_lossy().into_owned(),
        path: link_path.to_string_lossy().into_owned(),
        mode,
        created_at: now(),
        copy_hash,
    });
    if let Err(err) = ctx
        .fault("adopt_record")
        .and_then(|()| world.record.save(&ctx.store))
    {
        let unlinked = match mode {
            LinkMode::Copy => fs::remove_dir_all(&link_path),
            _ => link::remove_entry(&link_path),
        }
        .map_err(|e| {
            (
                e.to_string(),
                vec![original.clone(), agent_op.clone(), central.clone()],
            )
        });
        let restored = unlinked.and_then(|()| put_back());
        return fail(
            out,
            issue(
                codes::RECORD_WRITE_FAILED,
                &super::record::record_path(&ctx.store),
                err,
            ),
            restored,
        );
    }
    copies::commit(&agent_op);
    out.link_path = Some(link_path.to_string_lossy().into_owned());
    out.mode = Some(mode.as_str().to_string());
    (out, Changed { dirs: vec![dir] })
}
