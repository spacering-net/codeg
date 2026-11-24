//! Assistants made without the things a page or a tool makes with them: the
//! assistants of the collaboration settings converted on upgrade, and the
//! ones a sync package brings (§5, §6.2). They have no working directory
//! until one is first needed — the database migration has no data dir to
//! make one in, and an import writes in a transaction — and none has a
//! brain while there is no primary to copy one from.
//!
//! - [`ensure_worker_ready`] makes a worker's directory, with the persona it
//!   came with (`seed_persona`), once: built aside, renamed into place, and
//!   only then marked made — a copy of the persona the version it wrote,
//!   so one a sync package wrote meanwhile is not lost.
//! - [`fill_brains`] gives every assistant with no brain a copy of the
//!   primary's, only the brain: what its work runs on stays.
//!
//! Both are the same however often they run; the host runs them at every
//! start, the primary's first save and every import run them too.

use std::path::{Path, PathBuf};

use super::workdir;
use crate::db::entities::personal_agent::{self as agent_entity, BotKind};
use crate::db::service::personal_agent_service as svc;
use crate::db::AppDatabase;
use crate::models::personal_agent::PersonalAgentChange;
use crate::models::system::AppLocale;
use crate::web::event_bridge::EventEmitter;

/// The lock a worker's directory is made under, across processes:
/// `personal-agent-bots/<uid>.lock`.
fn lock_path(data_dir: &Path, uid: &str) -> PathBuf {
    data_dir.join(workdir::BOTS_DIR).join(format!("{uid}.lock"))
}

/// The prefix of the directories one is built in before it is renamed into
/// place: `personal-agent-bots/<uid>.staging-…`.
fn staging_prefix(uid: &str) -> String {
    format!("{uid}.staging-")
}

async fn lock(data_dir: &Path, uid: &str) -> Result<std::fs::File, String> {
    let path = lock_path(data_dir, uid);
    tokio::task::spawn_blocking(move || -> std::io::Result<std::fs::File> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        file.lock()?;
        Ok(file)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("its directory's lock could not be taken: {e}"))
}

/// The language a directory made now is written in: the account's.
async fn locale_now(db: &AppDatabase) -> AppLocale {
    if let Ok(Some(p)) = svc::primary_bot(&db.conn).await {
        if let Some(l) = super::engine::settings_of(&p).locale {
            return l;
        }
    }
    match crate::commands::system_settings::load_system_language_settings(&db.conn).await {
        Ok(s) if s.mode == crate::models::system::LanguageMode::Manual => s.language,
        _ => AppLocale::En,
    }
}

/// Whether `dir` is a whole working directory: its marker, and a history.
async fn whole(dir: &Path) -> bool {
    workdir::is_workdir(dir) && workdir::has_commit(dir).await
}

/// Make worker `bot`'s working directory if it is not made yet. Nothing for
/// one made already, deleted, or in a directory the owner picked.
pub async fn ensure_worker_ready(
    db: &AppDatabase,
    data_dir: &Path,
    bot: i32,
) -> Result<(), String> {
    let Some(row) = svc::get_bot(&db.conn, bot).await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    if row.kind != BotKind::Worker || row.workdir_ready {
        return Ok(());
    }
    let Some(uid) = row.uid.clone().filter(|u| !u.trim().is_empty()) else {
        return Err("it has no uid to name its directory by".into());
    };
    // One at a time for this assistant, whichever process: a directory
    // being built is never taken for a leftover.
    let _held = lock(data_dir, &uid).await?;
    let Some(row) = svc::get_bot(&db.conn, bot).await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    if row.workdir_ready {
        return Ok(());
    }
    if let Some(custom) = row.workdir.as_deref().filter(|w| !w.trim().is_empty()) {
        // A directory the owner picked was made when they picked it (a move
        // makes this one first, so this is only a defence): the persona it
        // came with goes into it before it is marked made.
        let custom = Path::new(custom);
        if let (Some(persona), true) = (row.seed_persona.as_deref(), workdir::is_workdir(custom)) {
            let soul = super::templates::worker_soul(locale_now(db).await, Some(persona));
            workdir::write_file(custom, workdir::SOUL_FILE, &soul).map_err(|e| e.to_string())?;
            workdir::commit_only(custom, "codeg: the persona it was given", &[workdir::SOUL_FILE])
                .await;
        }
        return svc::mark_workdir_ready(&db.conn, bot, row.seed_version)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
    let bots = data_dir.join(workdir::BOTS_DIR);
    let dir = bots.join(&uid);
    // What a build cut short left: this lock's own, by its name.
    if let Ok(entries) = std::fs::read_dir(&bots) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with(&staging_prefix(&uid)) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    let locale = locale_now(db).await;
    if dir.exists() && !whole(&dir).await {
        // Renamed into place but never whole, or something else's: nothing
        // has run in it (a worker not made yet starts no session), so it
        // is made anew.
        let aside = bots.join(format!("{}{}", staging_prefix(&uid), uuid::Uuid::new_v4().simple()));
        std::fs::rename(&dir, &aside).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(&aside);
    }
    if !dir.exists() {
        let staging =
            bots.join(format!("{}{}", staging_prefix(&uid), uuid::Uuid::new_v4().simple()));
        let soul = super::templates::worker_soul(locale, row.seed_persona.as_deref());
        let rules = super::templates::worker_rules(locale);
        let built =
            workdir::build_role_workdir(&staging, locale, &soul, &rules, row.seed_version).await;
        if let Err(e) = built {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("its working directory could not be made: {e}"));
        }
        // Put in place in the hold every claim of a directory takes — a
        // delete removes the row and its directory in it — the row read
        // again there: one deleted while this was built gets none.
        let claim = workdir::WORKDIR_CLAIM.lock().await;
        let alive = svc::get_bot(&db.conn, bot)
            .await
            .map_err(|e| e.to_string())?
            .is_some();
        let placed = if alive {
            std::fs::rename(&staging, &dir).map_err(|e| e.to_string())
        } else {
            Ok(())
        };
        drop(claim);
        if !alive || placed.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        if !alive {
            return Err("this assistant was deleted".into());
        }
        placed.map_err(|e| format!("its working directory could not be put in place: {e}"))?;
    }
    // Marked made only with the persona the directory has: one a sync
    // package wrote since is put in first. In the claim's hold, the row and
    // the directory looked at in it each time: a delete (which removes both
    // in the same hold) is never undone by writing into a directory gone.
    let _claim = workdir::WORKDIR_CLAIM.lock().await;
    for _ in 0..8 {
        let Some(row) = svc::get_bot(&db.conn, bot).await.map_err(|e| e.to_string())? else {
            return Err("this assistant was deleted".into());
        };
        if !workdir::is_workdir(&dir) {
            return Err("its working directory is gone".into());
        }
        let written = workdir::marker_seed_version(&dir).unwrap_or(0);
        if row.seed_version != written {
            let soul = super::templates::worker_soul(locale, row.seed_persona.as_deref());
            if workdir::committed_text(&dir, workdir::SOUL_FILE).await.as_deref() != Some(&soul) {
                workdir::write_file(&dir, workdir::SOUL_FILE, &soul).map_err(|e| e.to_string())?;
                workdir::commit_only(&dir, "codeg: the persona it was given", &[workdir::SOUL_FILE])
                    .await;
                // "Nothing to commit" is as good as committed: what was to be
                // there is.
                if workdir::committed_text(&dir, workdir::SOUL_FILE).await.as_deref()
                    != Some(&soul)
                {
                    return Err("its persona could not be committed".into());
                }
            }
            workdir::set_marker_seed_version(&dir, row.seed_version).map_err(|e| e.to_string())?;
            continue;
        }
        if svc::mark_workdir_ready(&db.conn, bot, written)
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(());
        }
    }
    Err("its persona kept changing while its directory was made".into())
}

/// [`ensure_worker_ready`] for every worker not made yet. The ones that
/// could not be, with why.
pub async fn ensure_all_ready(db: &AppDatabase, data_dir: &Path) -> Vec<(agent_entity::Model, String)> {
    let mut failed = Vec::new();
    for row in svc::list_bots(&db.conn).await.unwrap_or_default() {
        if row.kind != BotKind::Worker || row.workdir_ready {
            continue;
        }
        if let Err(e) = ensure_worker_ready(db, data_dir, row.id).await {
            tracing::warn!("[personal-agent] bot #{}: {e}", row.id);
            failed.push((row, e));
        }
    }
    failed
}

/// Give every assistant with no brain a copy of the primary's (D3). Nothing
/// while there is no primary.
pub async fn fill_brains(db: &AppDatabase, emitter: &EventEmitter) {
    let Ok(Some(primary)) = svc::primary_bot(&db.conn).await else {
        return;
    };
    let Some(brain) = super::engine::brain_of(&primary) else {
        return;
    };
    match svc::fill_missing_brains(&db.conn, &svc::AgentColumns::of(&brain)).await {
        Ok(filled) => {
            for id in filled {
                crate::web::event_bridge::emit_event(
                    emitter,
                    super::engine::PERSONAL_AGENT_CHANGED_EVENT,
                    super::engine::change_payload(id, &PersonalAgentChange::Agent),
                );
            }
        }
        Err(e) => tracing::warn!("[personal-agent] brains not filled in: {e}"),
    }
}
