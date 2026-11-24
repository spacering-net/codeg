//! The plugin store, record, lock and journal, under one temp directory each
//! (`PluginsCtx::at`). Nothing here touches the real home or runs a host.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::ctx::{is_valid_install_name, InstallName, PluginsCtx};
use super::journal::{recover, Action, StepState, Tx};
use super::lock::{acquire_blocking_at, PluginsLockError};
use super::record::{
    self, HostEntry, HostMode, HostState, PluginEntry, Record, RecordFile, FORMAT,
};
use super::store::{self, gc, verify_revision, Mismatch};
use crate::harness::skills::package::PackageFile;
use crate::harness::types::FileEntry;

const NAME: &str = "superpowers";
const CLAUDE: &str = "claude_code";
const GEMINI: &str = "gemini";

fn setup() -> (tempfile::TempDir, PluginsCtx) {
    let dir = tempfile::tempdir().unwrap();
    let ctx = PluginsCtx::at(&dir.path().join("codeg"));
    (dir, ctx)
}

fn name() -> InstallName {
    InstallName::parse(NAME).unwrap()
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// A revision's listing and files: `(path, text, executable)`.
fn package(files: &[(&str, &str, bool)]) -> (Vec<FileEntry>, Vec<PackageFile>) {
    let listing = files
        .iter()
        .map(|(path, text, executable)| FileEntry {
            path: path.to_string(),
            sha256: sha(text.as_bytes()),
            size: text.len() as u64,
            executable: *executable,
        })
        .collect();
    let files = files
        .iter()
        .map(|(path, text, executable)| PackageFile {
            path: path.to_string(),
            bytes: text.as_bytes().to_vec(),
            executable: *executable,
        })
        .collect();
    (listing, files)
}

fn revision_package(revision: u64) -> (Vec<FileEntry>, Vec<PackageFile>) {
    let manifest = format!("{{\"name\":\"superpowers\",\"version\":\"7.0.{revision}\"}}");
    let skill = format!("---\nname: brainstorming\n---\nRevision {revision}.\n");
    package(&[
        (".claude-plugin/plugin.json", &manifest, false),
        ("skills/brainstorming/SKILL.md", &skill, false),
        ("hooks/session-start.sh", "#!/bin/sh\necho hi\n", true),
    ])
}

fn host(mode: HostMode) -> HostEntry {
    HostEntry {
        mode,
        state: HostState::Active,
        skills: if mode == HostMode::Skills {
            vec!["brainstorming".to_string()]
        } else {
            Vec::new()
        },
        host_name: None,
        experts: Vec::new(),
        repair: None,
        extra: Default::default(),
    }
}

fn entry(revision: u64, previous: Option<u64>) -> PluginEntry {
    let (listing, _) = revision_package(revision);
    PluginEntry {
        item_id: "0199b0aa-0000-7000-8000-0000000000cc".to_string(),
        item_ref: "obra/superpowers".to_string(),
        revision,
        version: Some(format!("7.0.{revision}")),
        archive_sha256: Some(sha(format!("archive {revision}").as_bytes())),
        source: None,
        files: listing.iter().map(RecordFile::from).collect(),
        exec_sha256: sha(b"exec"),
        autorun: Vec::new(),
        components: Vec::new(),
        state_sha256: sha(b"state"),
        consent: None,
        hosts: BTreeMap::from([
            (CLAUDE.to_string(), host(HostMode::Native)),
            (GEMINI.to_string(), host(HostMode::Skills)),
        ]),
        previous_revision: previous,
        held_revisions: Vec::new(),
        installed_at: "2026-11-19T09:30:00.000Z".to_string(),
        op: String::new(),
        extra: Default::default(),
    }
}

/// The whole operation, as step 8 will run it (host commands left out).
fn run(ctx: &PluginsCtx, action: Action, after: PluginEntry) -> std::io::Result<()> {
    let guard = ctx.lock_blocking().unwrap();
    let revision = after.revision;
    let (listing, files) = revision_package(revision);
    let mut tx = Tx::begin(ctx, &guard, action, &name(), Some(after))?;
    tx.stage(revision, &listing, &files)?;
    for agent in [CLAUDE, GEMINI] {
        let mode = if agent == CLAUDE {
            HostMode::Native
        } else {
            HostMode::Skills
        };
        let step = tx.step_planned(agent, mode, "install")?;
        tx.step_done(step)?;
    }
    tx.commit()?;
    tx.finish().map(|_| ())
}

fn current(ctx: &PluginsCtx) -> Option<PluginEntry> {
    record::load(ctx).unwrap().plugins.get(NAME).cloned()
}

fn names_in(dir: &Path) -> BTreeSet<String> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// Nothing of an operation is left: no journal, no staging, no trash.
fn assert_clean(ctx: &PluginsCtx) {
    for dir in [ctx.ops_dir(), ctx.staging_root(), ctx.trash_dir()] {
        assert!(
            names_in(&dir).is_empty(),
            "{} holds {:?}",
            dir.display(),
            names_in(&dir)
        );
    }
}

fn revisions_on_disk(ctx: &PluginsCtx) -> BTreeSet<String> {
    names_in(&ctx.plugin_dir(&name()))
}

fn assert_revision_whole(ctx: &PluginsCtx, revision: u64) {
    let (listing, _) = revision_package(revision);
    verify_revision(&ctx.revision_dir(&name(), revision), &listing)
        .unwrap_or_else(|problems| panic!("revision {revision}: {problems:?}"));
}

// ─── Install names ──────────────────────────────────────────────────────

#[test]
fn an_install_name_is_one_plain_segment_a_host_accepts() {
    for good in ["superpowers", "a", "A1._-x", "x.y", &"a".repeat(64)] {
        assert!(is_valid_install_name(good), "{good}");
    }
    for bad in [
        "",
        ".hidden",
        "-x",
        "_x",
        "a/b",
        "a\\b",
        "..",
        "a b",
        "a:b",
        "naïve",
        "x.",
        "con",
        "COM1",
        &"a".repeat(65),
    ] {
        assert!(!is_valid_install_name(bad), "{bad}");
        assert!(InstallName::parse(bad).is_none(), "{bad}");
    }
}

// ─── The store ──────────────────────────────────────────────────────────

#[test]
fn a_revision_is_staged_checked_and_renamed_into_place_with_its_modes() {
    let (_dir, ctx) = setup();
    let (listing, files) = revision_package(1);
    let staged = store::stage_revision(&ctx, "op1", &name(), 1, &listing, &files).unwrap();
    assert!(staged.created);
    assert_eq!(staged.path, ctx.revision_dir(&name(), 1));
    assert_revision_whole(&ctx, 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |rel: &str| {
            fs::metadata(staged.path.join(rel))
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(mode("hooks/session-start.sh"), 0o755);
        assert_eq!(mode("skills/brainstorming/SKILL.md"), 0o644);
    }
    assert!(names_in(&ctx.staging_root()).is_empty());
}

#[test]
fn a_file_that_is_not_the_listed_one_is_refused_and_nothing_is_placed() {
    let (_dir, ctx) = setup();
    let (listing, files) = revision_package(1);

    let mut wrong_hash = listing.clone();
    wrong_hash[1].sha256 = sha(b"something else");
    let error = store::stage_revision(&ctx, "op1", &name(), 1, &wrong_hash, &files).unwrap_err();
    assert!(
        error.to_string().contains("not the listed content"),
        "{error}"
    );

    let mut wrong_size = listing.clone();
    wrong_size[1].size += 1;
    store::stage_revision(&ctx, "op2", &name(), 1, &wrong_size, &files).unwrap_err();

    // One file more than listed, one fewer.
    let mut more = files.clone();
    more.push(PackageFile {
        path: "extra.txt".to_string(),
        bytes: b"x".to_vec(),
        executable: false,
    });
    store::stage_revision(&ctx, "op3", &name(), 1, &listing, &more).unwrap_err();
    store::stage_revision(&ctx, "op4", &name(), 1, &listing, &files[1..]).unwrap_err();

    assert!(fs::symlink_metadata(ctx.revision_dir(&name(), 1)).is_err());
}

#[test]
fn a_path_that_leaves_the_revision_is_refused() {
    let (dir, ctx) = setup();
    for bad in [
        "../escape.txt",
        "a/../../escape.txt",
        "/abs.txt",
        "a\\b.txt",
        "C:x.txt",
        "./x.txt",
        "a//b.txt",
        "",
    ] {
        let (listing, files) = package(&[(bad, "x", false)]);
        let error = store::stage_revision(&ctx, "op", &name(), 1, &listing, &files).unwrap_err();
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::InvalidInput,
            "{bad}: {error}"
        );
    }
    // Two paths that are one on a case-blind disk; a file in a folder's way.
    for pair in [
        [("A.txt", "1", false), ("a.txt", "2", false)],
        [("a", "1", false), ("a/b.txt", "2", false)],
    ] {
        let (listing, files) = package(&pair);
        store::stage_revision(&ctx, "op", &name(), 1, &listing, &files).unwrap_err();
    }
    assert!(!dir.path().join("escape.txt").exists());
    assert!(!dir.path().join("codeg").join("escape.txt").exists());
    assert!(fs::symlink_metadata(ctx.plugin_dir(&name())).is_err());
}

#[cfg(unix)]
#[test]
fn a_plugin_folder_that_is_a_link_out_of_the_store_is_never_used() {
    let (dir, ctx) = setup();
    let outside = dir.path().join("outside");
    fs::create_dir_all(outside.join("1")).unwrap();
    fs::write(outside.join("1").join("keep.txt"), "mine").unwrap();
    fs::create_dir_all(&ctx.root).unwrap();
    std::os::unix::fs::symlink(&outside, ctx.plugin_dir(&name())).unwrap();

    let (listing, files) = revision_package(2);
    store::stage_revision(&ctx, "op", &name(), 2, &listing, &files).unwrap_err();
    gc(&ctx, &name(), &[]).unwrap_err();
    store::remove_revision(&ctx, &name(), 1).unwrap_err();
    assert_eq!(
        fs::read_to_string(outside.join("1").join("keep.txt")).unwrap(),
        "mine"
    );
    assert!(!outside.join("2").exists());
}

#[test]
fn an_identical_revision_in_place_is_reused() {
    let (_dir, ctx) = setup();
    let (listing, files) = revision_package(1);
    store::stage_revision(&ctx, "op1", &name(), 1, &listing, &files).unwrap();
    let again = store::stage_revision(&ctx, "op2", &name(), 1, &listing, &files).unwrap();
    assert!(!again.created);
    assert_revision_whole(&ctx, 1);
    // Anything unlisted — even what the skills hash ignores — is not the
    // revision SRN vouched for.
    let cache = ctx
        .revision_dir(&name(), 1)
        .join("hooks")
        .join("__pycache__");
    fs::create_dir_all(&cache).unwrap();
    fs::write(cache.join("x.cpython-312.pyc"), "bytecode").unwrap();
    store::stage_revision(&ctx, "op3", &name(), 1, &listing, &files).unwrap_err();
}

#[test]
fn a_different_revision_folder_in_place_is_an_error_and_is_left_alone() {
    let (_dir, ctx) = setup();
    let (listing, files) = revision_package(1);
    store::stage_revision(&ctx, "op1", &name(), 1, &listing, &files).unwrap();
    let skill = ctx
        .revision_dir(&name(), 1)
        .join("skills/brainstorming/SKILL.md");
    fs::write(&skill, "edited").unwrap();
    let error = store::stage_revision(&ctx, "op2", &name(), 1, &listing, &files).unwrap_err();
    assert!(
        error.to_string().contains("not the revision listed"),
        "{error}"
    );
    assert_eq!(fs::read_to_string(&skill).unwrap(), "edited");
}

#[test]
fn verifying_a_revision_names_what_is_off() {
    let (_dir, ctx) = setup();
    let (listing, files) = revision_package(1);
    let dir = store::stage_revision(&ctx, "op", &name(), 1, &listing, &files)
        .unwrap()
        .path;
    fs::write(dir.join("notes.txt"), "extra").unwrap();
    fs::remove_file(dir.join(".claude-plugin/plugin.json")).unwrap();
    fs::write(dir.join("skills/brainstorming/SKILL.md"), "changed").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            dir.join("hooks/session-start.sh"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        std::os::unix::fs::symlink("/etc/hosts", dir.join("link")).unwrap();
    }
    let problems: BTreeSet<String> = verify_revision(&dir, &listing)
        .unwrap_err()
        .iter()
        .map(Mismatch::to_string)
        .collect();
    assert!(problems.contains("notes.txt: not listed"), "{problems:?}");
    assert!(
        problems.contains(".claude-plugin/plugin.json: missing"),
        "{problems:?}"
    );
    assert!(problems.contains("skills/brainstorming/SKILL.md: not the listed content"));
    #[cfg(unix)]
    {
        assert!(problems.contains("hooks/session-start.sh: not the listed executable bit"));
        assert!(problems.contains("link: not listed"), "{problems:?}");
    }
    assert_eq!(
        verify_revision(&ctx.revision_dir(&name(), 9), &listing).unwrap_err(),
        vec![Mismatch::NotAFolder]
    );
}

#[test]
fn gc_keeps_the_active_and_the_previous_revision() {
    let (_dir, ctx) = setup();
    for revision in 1..=3 {
        let (listing, files) = revision_package(revision);
        store::stage_revision(&ctx, "op", &name(), revision, &listing, &files).unwrap();
    }
    // Not a revision folder: left alone.
    fs::create_dir_all(ctx.plugin_dir(&name()).join("notes")).unwrap();
    fs::create_dir_all(ctx.plugin_dir(&name()).join("01")).unwrap();

    let removed = gc(&ctx, &name(), &entry(3, Some(2)).kept_revisions()).unwrap();
    assert_eq!(removed, vec![1]);
    assert_eq!(
        revisions_on_disk(&ctx),
        BTreeSet::from(["2", "3", "notes", "01"].map(String::from))
    );
    assert_revision_whole(&ctx, 2);
    assert_revision_whole(&ctx, 3);
    assert!(names_in(&ctx.trash_dir()).is_empty());

    // Nothing kept: every revision goes (the rest stays, so the folder too).
    assert_eq!(gc(&ctx, &name(), &[]).unwrap(), vec![2, 3]);
    fs::remove_dir(ctx.plugin_dir(&name()).join("notes")).unwrap();
    fs::remove_dir(ctx.plugin_dir(&name()).join("01")).unwrap();
    gc(&ctx, &name(), &[]).unwrap();
    assert!(fs::symlink_metadata(ctx.plugin_dir(&name())).is_err());
}

// ─── The record ─────────────────────────────────────────────────────────

#[test]
fn a_record_in_a_newer_format_is_never_rewritten() {
    let (_dir, ctx) = setup();
    fs::create_dir_all(ctx.record.parent().unwrap()).unwrap();
    let newer = format!(
        "{{\"format\": {}, \"plugins\": {{}}, \"later\": true}}\n",
        FORMAT + 1
    );
    fs::write(&ctx.record, &newer).unwrap();

    assert_eq!(
        record::load_for_write(&ctx).unwrap_err(),
        record::RecordError::Newer(FORMAT + 1)
    );
    record::save(&ctx, &Record::default()).unwrap_err();
    let guard = ctx.lock_blocking().unwrap();
    Tx::begin(&ctx, &guard, Action::Install, &name(), Some(entry(1, None))).unwrap_err();
    drop(guard);
    assert_eq!(fs::read_to_string(&ctx.record).unwrap(), newer);
    // Still read, as far as this Codeg understands it.
    assert_eq!(record::load(&ctx).unwrap().format, FORMAT + 1);
}

#[test]
fn fields_a_newer_codeg_added_survive_a_rewrite() {
    let (_dir, ctx) = setup();
    let mut written = serde_json::to_value(Record {
        plugins: BTreeMap::from([(NAME.to_string(), entry(1, None))]),
        ..Record::default()
    })
    .unwrap();
    written["top"] = json!({"x": 1});
    let plugin = &mut written["plugins"][NAME];
    plugin["later"] = json!("kept");
    plugin["consent"] = json!({"exec": sha(b"exec"), "at": "2026-11-19T00:00:00Z", "by": "user"});
    plugin["autorun"] = json!([{"host": "claude", "type": "widget", "path": "w.json", "more": 2}]);
    plugin["hosts"][CLAUDE]["since"] = json!(3);
    plugin["hosts"][GEMINI]["state"] = json!({"suspended": {"reason": "x", "by": "srn"}});
    plugin["files"][0]["mode"] = json!("0644");
    plugin["source"] =
        json!({"repository": "obra/superpowers", "commit": "c", "path": "", "tree": "t"});
    fs::create_dir_all(ctx.record.parent().unwrap()).unwrap();
    fs::write(&ctx.record, serde_json::to_vec(&written).unwrap()).unwrap();

    let loaded = record::load_for_write(&ctx).unwrap();
    record::save(&ctx, &loaded).unwrap();
    let back: Value = serde_json::from_slice(&fs::read(&ctx.record).unwrap()).unwrap();
    assert_eq!(back["top"], json!({"x": 1}));
    let plugin = &back["plugins"][NAME];
    assert_eq!(plugin["later"], "kept");
    assert_eq!(plugin["consent"]["by"], "user");
    assert_eq!(plugin["autorun"][0]["type"], "widget");
    assert_eq!(plugin["autorun"][0]["more"], 2);
    assert_eq!(plugin["hosts"][CLAUDE]["since"], 3);
    assert_eq!(plugin["ref"], "obra/superpowers");
    assert_eq!(plugin["hosts"][GEMINI]["mode"], "skills");
    assert_eq!(plugin["hosts"][GEMINI]["state"]["suspended"]["by"], "srn");
    assert_eq!(plugin["files"][0]["mode"], "0644");
    assert_eq!(plugin["source"]["tree"], "t");
    assert_eq!(plugin["hosts"][CLAUDE]["state"], "active");
}

#[test]
fn host_states_are_written_as_documented() {
    let states = [
        (HostState::Active, json!("active")),
        (HostState::DisabledByUser, json!("disabled_by_user")),
        (HostState::NeedsRepair, json!("needs_repair")),
        (
            HostState::suspended("revision_yanked"),
            json!({"suspended": {"reason": "revision_yanked"}}),
        ),
    ];
    for (state, wire) in states {
        assert_eq!(serde_json::to_value(&state).unwrap(), wire);
        assert_eq!(serde_json::from_value::<HostState>(wire).unwrap(), state);
    }
    // A state this Codeg does not know is not guessed at.
    serde_json::from_value::<HostState>(json!("paused")).unwrap_err();
}

#[cfg(unix)]
#[test]
fn the_record_and_the_journals_are_the_owners_alone() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, ctx) = setup();
    let guard = ctx.lock_blocking().unwrap();
    let tx = Tx::begin(&ctx, &guard, Action::Install, &name(), Some(entry(1, None))).unwrap();
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&ctx.journal_path(tx.op())), 0o600);
    record::save(&ctx, &Record::default()).unwrap();
    assert_eq!(mode(&ctx.record), 0o600);
}

#[test]
fn a_test_run_never_uses_the_real_home() {
    let ctx = PluginsCtx::user();
    for path in [&ctx.root, &ctx.record, &ctx.lock_path] {
        assert!(path.starts_with(std::env::temp_dir()), "{}", path.display());
    }
}

// ─── The lock ───────────────────────────────────────────────────────────

#[test]
fn the_plugins_lock_lets_one_writer_in_at_a_time() {
    let (_dir, ctx) = setup();
    let first = ctx.lock_blocking().unwrap();
    assert_eq!(
        acquire_blocking_at(&ctx.lock_path, Duration::from_millis(80)).err(),
        Some(PluginsLockError::Busy)
    );
    // Another thread, as another task of this process would be.
    let path = ctx.lock_path.clone();
    let waited =
        std::thread::spawn(move || acquire_blocking_at(&path, Duration::from_millis(80)).err())
            .join()
            .unwrap();
    assert_eq!(waited, Some(PluginsLockError::Busy));
    drop(first);
    let _again = acquire_blocking_at(&ctx.lock_path, Duration::from_millis(500)).unwrap();
    assert!(ctx.lock_path.starts_with(_dir.path()));
}

#[tokio::test]
async fn a_second_handle_on_the_lock_file_keeps_the_plugins_lock_out() {
    let (_dir, ctx) = setup();
    fs::create_dir_all(ctx.lock_path.parent().unwrap()).unwrap();
    // An independent handle stands in for another process.
    let other = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&ctx.lock_path)
        .unwrap();
    other.try_lock().unwrap();
    assert!(
        super::lock::acquire_at(&ctx.lock_path, Duration::from_millis(120))
            .await
            .is_err()
    );
    other.unlock().unwrap();
    super::lock::acquire_at(&ctx.lock_path, Duration::from_millis(500))
        .await
        .unwrap();
}

// ─── The journal ────────────────────────────────────────────────────────

#[test]
fn an_operation_runs_through_and_cleans_up() {
    let (_dir, ctx) = setup();
    run(&ctx, Action::Install, entry(1, None)).unwrap();
    let installed = current(&ctx).unwrap();
    assert_eq!(installed.revision, 1);
    assert!(!installed.op.is_empty());
    assert_revision_whole(&ctx, 1);
    assert_clean(&ctx);

    run(&ctx, Action::Update, entry(2, Some(1))).unwrap();
    run(&ctx, Action::Update, entry(3, Some(2))).unwrap();
    assert_eq!(current(&ctx).unwrap().revision, 3);
    // The previous revision stays (a host may still have it loaded).
    assert_eq!(
        revisions_on_disk(&ctx),
        BTreeSet::from(["2", "3"].map(String::from))
    );
    assert_clean(&ctx);
}

#[test]
fn the_journal_is_on_disk_after_every_step() {
    let (_dir, ctx) = setup();
    let guard = ctx.lock_blocking().unwrap();
    let (listing, files) = revision_package(1);
    let mut tx = Tx::begin(&ctx, &guard, Action::Install, &name(), Some(entry(1, None))).unwrap();
    let on_disk = |ctx: &PluginsCtx, op: &str| -> Value {
        serde_json::from_slice(&fs::read(ctx.journal_path(op)).unwrap()).unwrap()
    };
    let op = tx.op().to_string();
    assert_eq!(on_disk(&ctx, &op)["after"]["op"], op.as_str());
    assert!(on_disk(&ctx, &op)["before"].is_null());
    tx.stage(1, &listing, &files).unwrap();
    assert_eq!(on_disk(&ctx, &op)["created"], json!([1]));
    let step = tx
        .step_planned(CLAUDE, HostMode::Native, "install")
        .unwrap();
    assert_eq!(on_disk(&ctx, &op)["steps"][0]["state"], "planned");
    tx.step_done(step).unwrap();
    assert_eq!(on_disk(&ctx, &op)["steps"][0]["state"], "done");
    assert_eq!(tx.journal().steps[0].state, StepState::Done);
    // A second operation on the plugin waits for this one.
    Tx::begin(
        &ctx,
        &guard,
        Action::Update,
        &name(),
        Some(entry(2, Some(1))),
    )
    .unwrap_err();
    tx.commit().unwrap();
    tx.finish().unwrap();
    assert_clean(&ctx);
}

#[test]
fn a_rollback_takes_out_only_what_the_operation_made() {
    let (_dir, ctx) = setup();
    run(&ctx, Action::Install, entry(1, None)).unwrap();
    let before = current(&ctx).unwrap();
    let guard = ctx.lock_blocking().unwrap();

    // An update that reuses revision 1 and makes revision 2.
    let mut tx = Tx::begin(
        &ctx,
        &guard,
        Action::Update,
        &name(),
        Some(entry(2, Some(1))),
    )
    .unwrap();
    let (listing, files) = revision_package(1);
    assert!(!tx.stage(1, &listing, &files).unwrap().created);
    let (listing, files) = revision_package(2);
    assert!(tx.stage(2, &listing, &files).unwrap().created);
    assert!(tx.rollback(&BTreeSet::new()).unwrap().is_empty());
    assert_eq!(current(&ctx).unwrap(), before);
    assert_eq!(revisions_on_disk(&ctx), BTreeSet::from(["1".to_string()]));
    assert_revision_whole(&ctx, 1);
    assert_clean(&ctx);

    // One whose host step could not be undone: that agent needs repair,
    // and no revision a host may load from is taken out.
    let mut tx = Tx::begin(
        &ctx,
        &guard,
        Action::Update,
        &name(),
        Some(entry(2, Some(1))),
    )
    .unwrap();
    tx.stage(2, &listing, &files).unwrap();
    tx.step_planned(CLAUDE, HostMode::Native, "update").unwrap();
    let marked = tx.rollback(&BTreeSet::from([CLAUDE.to_string()])).unwrap();
    assert_eq!(marked, vec![CLAUDE.to_string()]);
    let after = current(&ctx).unwrap();
    assert_eq!(after.revision, 1);
    assert_eq!(after.op, before.op);
    assert_eq!(after.hosts[CLAUDE].state, HostState::NeedsRepair);
    assert_eq!(after.hosts[GEMINI].state, HostState::Active);
    assert_eq!(
        revisions_on_disk(&ctx),
        BTreeSet::from(["1", "2"].map(String::from))
    );
    assert_clean(&ctx);
}

/// Every place an operation can stop, for a first install and an update
/// from 2 to 3 (with 1 still on disk): after the crash and the recovery,
/// the record and the files agree, and nothing of the operation is left.
const FAULT_POINTS: &[&str] = &[
    "begin",
    "stage",
    "staged",
    "step",
    "commit",
    "record_save",
    "finish",
    "gc",
    "discarded",
];

#[test]
fn a_first_install_stopped_anywhere_is_recovered() {
    for point in FAULT_POINTS {
        let (_dir, ctx) = setup();
        ctx.arm_fault(point);
        let result = run(&ctx, Action::Install, entry(1, None));
        ctx.disarm_faults();
        // "gc"/"discarded" are not reached by a first install.
        if ["gc", "discarded"].contains(point) {
            result.unwrap();
        } else {
            result.unwrap_err();
        }
        let guard = ctx.lock_blocking().unwrap();
        let report = recover(&ctx, &guard);
        assert!(report.problems.is_empty(), "{point}: {:?}", report.problems);
        assert_clean(&ctx);
        match current(&ctx) {
            None => {
                assert!(
                    ["begin", "stage", "staged", "step"].contains(point),
                    "{point}"
                );
                assert!(revisions_on_disk(&ctx).is_empty(), "{point}");
            }
            Some(entry) => {
                assert_revision_whole(&ctx, 1);
                let states: Vec<&HostState> =
                    entry.hosts.values().map(|host| &host.state).collect();
                if ["commit", "record_save"].contains(point) {
                    // The hosts ran their steps; the record never got the
                    // entry: they are on record, needing repair.
                    assert_eq!(states, vec![&HostState::NeedsRepair; 2], "{point}");
                    assert_eq!(report.needs_repair.len(), 2);
                } else {
                    assert_eq!(states, vec![&HostState::Active; 2], "{point}");
                }
            }
        }
    }
}

#[test]
fn an_update_stopped_anywhere_is_recovered() {
    for point in FAULT_POINTS {
        let (_dir, ctx) = setup();
        run(&ctx, Action::Install, entry(1, None)).unwrap();
        run(&ctx, Action::Update, entry(2, Some(1))).unwrap();
        let before = current(&ctx).unwrap();
        ctx.arm_fault(point);
        let result = run(&ctx, Action::Update, entry(3, Some(2)));
        ctx.disarm_faults();
        // Old revisions that cannot be removed do not hold the operation
        // up: the next one removes them (or the recovery, from the trash).
        if ["gc", "discarded"].contains(point) {
            result.unwrap();
        } else {
            result.unwrap_err();
        }

        let guard = ctx.lock_blocking().unwrap();
        let report = recover(&ctx, &guard);
        assert!(report.problems.is_empty(), "{point}: {:?}", report.problems);
        assert_clean(&ctx);
        let now = current(&ctx).unwrap();
        let on_disk = revisions_on_disk(&ctx);
        match now.revision {
            2 => {
                assert_eq!(now.op, before.op, "{point}");
                assert_revision_whole(&ctx, 1);
                assert_revision_whole(&ctx, 2);
                if ["commit", "record_save"].contains(point) {
                    assert!(now
                        .hosts
                        .values()
                        .all(|host| host.state == HostState::NeedsRepair));
                    // A host may load revision 3 now: it stays until the
                    // next operation.
                    assert_revision_whole(&ctx, 3);
                } else {
                    assert_eq!(now, before, "{point}");
                    assert!(!on_disk.contains("3"), "{point}: {on_disk:?}");
                }
            }
            3 => {
                assert!(["finish", "gc", "discarded"].contains(point), "{point}");
                if *point == "gc" {
                    assert_eq!(on_disk, BTreeSet::from(["1", "2", "3"].map(String::from)));
                } else {
                    assert_eq!(on_disk, BTreeSet::from(["2", "3"].map(String::from)));
                }
                assert_revision_whole(&ctx, 2);
                assert_revision_whole(&ctx, 3);
                assert!(now
                    .hosts
                    .values()
                    .all(|host| host.state == HostState::Active));
            }
            other => panic!("{point}: revision {other}"),
        }
        drop(guard);
        // The next operation goes through.
        run(&ctx, Action::Update, entry(4, Some(now.revision))).unwrap();
        assert_eq!(
            revisions_on_disk(&ctx),
            BTreeSet::from([now.revision.to_string(), "4".to_string()])
        );
    }
}

#[test]
fn a_crash_between_planning_a_host_step_and_finishing_it_needs_repair() {
    let (_dir, ctx) = setup();
    run(&ctx, Action::Install, entry(1, None)).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    {
        let mut tx = Tx::begin(
            &ctx,
            &guard,
            Action::Update,
            &name(),
            Some(entry(2, Some(1))),
        )
        .unwrap();
        let (listing, files) = revision_package(2);
        tx.stage(2, &listing, &files).unwrap();
        tx.step_planned(CLAUDE, HostMode::Native, "update").unwrap();
        // Codeg dies here.
    }
    let report = recover(&ctx, &guard);
    assert_eq!(report.rolled_back, 1);
    assert_eq!(
        report.needs_repair,
        vec![(NAME.to_string(), CLAUDE.to_string())]
    );
    let now = current(&ctx).unwrap();
    assert_eq!(now.revision, 1);
    assert_eq!(now.hosts[CLAUDE].state, HostState::NeedsRepair);
    assert_eq!(now.hosts[GEMINI].state, HostState::Active);
    assert_clean(&ctx);
}

#[test]
fn an_uninstall_stopped_after_its_commit_is_finished() {
    let (_dir, ctx) = setup();
    run(&ctx, Action::Install, entry(1, None)).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    ctx.arm_fault("finish");
    {
        let mut tx = Tx::begin(&ctx, &guard, Action::Uninstall, &name(), None).unwrap();
        let step = tx
            .step_planned(CLAUDE, HostMode::Native, "uninstall")
            .unwrap();
        tx.step_done(step).unwrap();
        tx.commit().unwrap();
        tx.finish().unwrap_err();
    }
    ctx.disarm_faults();
    let report = recover(&ctx, &guard);
    assert_eq!(report.finished, 1);
    assert!(current(&ctx).is_none());
    assert!(fs::symlink_metadata(ctx.plugin_dir(&name())).is_err());
    assert_clean(&ctx);
}

#[test]
fn a_journal_whose_record_was_restored_is_rolled_back_and_reported() {
    let (_dir, ctx) = setup();
    run(&ctx, Action::Install, entry(1, None)).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    {
        let mut tx = Tx::begin(
            &ctx,
            &guard,
            Action::Update,
            &name(),
            Some(entry(2, Some(1))),
        )
        .unwrap();
        let (listing, files) = revision_package(2);
        tx.stage(2, &listing, &files).unwrap();
        tx.step_planned(GEMINI, HostMode::Skills, "update").unwrap();
    }
    // A backup put back: the entry is another operation's.
    let mut restored = record::load(&ctx).unwrap();
    restored.plugins.get_mut(NAME).unwrap().op = "restored".to_string();
    record::save(&ctx, &restored).unwrap();

    let report = recover(&ctx, &guard);
    assert_eq!(report.rolled_back, 1);
    assert!(
        report.problems[0].contains("restored backup"),
        "{:?}",
        report.problems
    );
    let now = current(&ctx).unwrap();
    assert_eq!(now.op, "restored");
    assert_eq!(now.hosts[GEMINI].state, HostState::NeedsRepair);
    assert_clean(&ctx);
}

#[test]
fn a_journal_this_codeg_does_not_know_is_left_as_it_is() {
    let (_dir, ctx) = setup();
    fs::create_dir_all(ctx.ops_dir()).unwrap();
    fs::create_dir_all(ctx.staging_dir("later-op")).unwrap();
    fs::create_dir_all(ctx.staging_dir("orphan")).unwrap();
    let journal = ctx.journal_path("later-op");
    fs::write(&journal, r#"{"kind":"harness_plugin","format":99}"#).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    let report = recover(&ctx, &guard);
    assert_eq!(report.problems.len(), 1, "{:?}", report.problems);
    assert!(journal.exists());
    // Its staging waits with it; staging nobody owns is cleared.
    assert_eq!(
        names_in(&ctx.staging_root()),
        BTreeSet::from(["later-op".to_string()])
    );
    // And nothing new starts while it waits.
    Tx::begin(&ctx, &guard, Action::Install, &name(), Some(entry(1, None))).unwrap_err();
}

#[test]
fn a_journal_waits_while_the_record_is_in_a_newer_format() {
    let (_dir, ctx) = setup();
    run(&ctx, Action::Install, entry(1, None)).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    let op = {
        let mut tx = Tx::begin(
            &ctx,
            &guard,
            Action::Update,
            &name(),
            Some(entry(2, Some(1))),
        )
        .unwrap();
        let (listing, files) = revision_package(2);
        tx.stage(2, &listing, &files).unwrap();
        tx.op().to_string()
    };
    let mut newer: Value = serde_json::from_slice(&fs::read(&ctx.record).unwrap()).unwrap();
    newer["format"] = json!(FORMAT + 1);
    let newer = serde_json::to_vec(&newer).unwrap();
    fs::write(&ctx.record, &newer).unwrap();

    let report = recover(&ctx, &guard);
    assert_eq!(report.problems.len(), 1, "{:?}", report.problems);
    assert!(ctx.journal_path(&op).exists());
    assert_eq!(fs::read(&ctx.record).unwrap(), newer);
    assert_eq!(
        revisions_on_disk(&ctx),
        BTreeSet::from(["1", "2"].map(String::from))
    );
}

#[test]
fn install_names_that_differ_only_in_case_are_one_name() {
    let (_dir, ctx) = setup();
    run(&ctx, Action::Install, entry(1, None)).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    let alias = InstallName::parse("SuperPowers").unwrap();
    let error = Tx::begin(&ctx, &guard, Action::Install, &alias, Some(entry(2, None))).unwrap_err();
    assert!(error.to_string().contains("taken"), "{error}");
    // A pending journal under another spelling holds the name too.
    let _pending = Tx::begin(
        &ctx,
        &guard,
        Action::Update,
        &name(),
        Some(entry(2, Some(1))),
    )
    .unwrap();
    drop(_pending);
    let mut record = record::load(&ctx).unwrap();
    record.plugins.clear();
    record::save(&ctx, &record).unwrap();
    Tx::begin(&ctx, &guard, Action::Install, &alias, Some(entry(2, None))).unwrap_err();
}

#[test]
fn a_revision_a_host_needing_repair_may_load_is_kept() {
    let (_dir, ctx) = setup();
    run(&ctx, Action::Install, entry(1, None)).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    {
        let mut tx = Tx::begin(
            &ctx,
            &guard,
            Action::Update,
            &name(),
            Some(entry(2, Some(1))),
        )
        .unwrap();
        let (listing, files) = revision_package(2);
        tx.stage(2, &listing, &files).unwrap();
        tx.step_planned(CLAUDE, HostMode::Native, "update").unwrap();
    }
    recover(&ctx, &guard);
    let repaired = current(&ctx).unwrap();
    assert_eq!(repaired.revision, 1);
    assert_eq!(repaired.held_revisions, vec![2]);

    // A later change to another agent keeps revision 2 while Claude Code
    // still needs repair.
    let mut tx = Tx::begin(
        &ctx,
        &guard,
        Action::Change,
        &name(),
        Some(repaired.clone()),
    )
    .unwrap();
    let step = tx
        .step_planned(GEMINI, HostMode::Skills, "disable")
        .unwrap();
    tx.step_done(step).unwrap();
    tx.commit().unwrap();
    tx.finish().unwrap();
    assert_eq!(
        revisions_on_disk(&ctx),
        BTreeSet::from(["1", "2"].map(String::from))
    );

    // Once it is repaired, the next operation lets it go.
    let mut fixed = current(&ctx).unwrap();
    fixed.hosts.get_mut(CLAUDE).unwrap().state = HostState::Active;
    let mut tx = Tx::begin(&ctx, &guard, Action::Change, &name(), Some(fixed)).unwrap();
    tx.commit().unwrap();
    tx.finish().unwrap();
    assert_eq!(revisions_on_disk(&ctx), BTreeSet::from(["1".to_string()]));
}

#[test]
fn an_uninstall_not_committed_is_not_finished_when_the_record_lacks_the_plugin() {
    let (_dir, ctx) = setup();
    run(&ctx, Action::Install, entry(1, None)).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    {
        let mut tx = Tx::begin(&ctx, &guard, Action::Uninstall, &name(), None).unwrap();
        tx.step_planned(CLAUDE, HostMode::Native, "uninstall")
            .unwrap();
    }
    // A record restored from before the plugin was installed.
    record::save(&ctx, &Record::default()).unwrap();
    let report = recover(&ctx, &guard);
    assert_eq!(report.finished, 0);
    assert_eq!(report.rolled_back, 1);
    assert_revision_whole(&ctx, 1);
    let now = current(&ctx).unwrap();
    assert_eq!(now.hosts[CLAUDE].state, HostState::NeedsRepair);
    assert_eq!(now.hosts[GEMINI].state, HostState::Active);
    assert_clean(&ctx);
}

#[test]
fn an_interrupted_rollback_is_rolled_back_again() {
    let (_dir, ctx) = setup();
    ctx.arm_fault("commit");
    run(&ctx, Action::Install, entry(1, None)).unwrap_err();
    ctx.disarm_faults();
    let guard = ctx.lock_blocking().unwrap();
    // The recovery's rollback stops after it marked the journal.
    ctx.arm_fault("record_save");
    let report = recover(&ctx, &guard);
    assert_eq!(report.problems.len(), 1, "{:?}", report.problems);
    ctx.disarm_faults();
    let journal: Value = serde_json::from_slice(
        &fs::read(
            fs::read_dir(ctx.ops_dir())
                .unwrap()
                .flatten()
                .next()
                .unwrap()
                .path(),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(journal["rolling_back"], true);
    let report = recover(&ctx, &guard);
    assert_eq!(report.rolled_back, 1, "{report:?}");
    let now = current(&ctx).unwrap();
    assert!(now
        .hosts
        .values()
        .all(|host| host.state == HostState::NeedsRepair));
    assert_revision_whole(&ctx, 1);
    assert_clean(&ctx);
}

#[cfg(unix)]
#[test]
fn the_stores_own_folders_are_never_followed_through_a_link() {
    let (dir, ctx) = setup();
    let outside = dir.path().join("outside");
    fs::create_dir_all(outside.join("someone-else")).unwrap();
    fs::write(outside.join("someone-else").join("keep.txt"), "mine").unwrap();
    let untouched = |outside: &Path| {
        assert_eq!(
            names_in(outside),
            BTreeSet::from(["someone-else".to_string()])
        );
        assert_eq!(
            fs::read_to_string(outside.join("someone-else").join("keep.txt")).unwrap(),
            "mine"
        );
    };
    fs::create_dir_all(&ctx.root).unwrap();

    // Staging: neither cleared nor written through.
    std::os::unix::fs::symlink(&outside, ctx.staging_root()).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    assert!(!recover(&ctx, &guard).problems.is_empty());
    drop(guard);
    run(&ctx, Action::Install, entry(1, None)).unwrap_err();
    untouched(&outside);
    fs::remove_file(ctx.staging_root()).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    assert!(recover(&ctx, &guard).problems.is_empty());
    drop(guard);

    // The trash: neither emptied nor moved into.
    run(&ctx, Action::Install, entry(1, None)).unwrap();
    std::os::unix::fs::symlink(&outside, ctx.trash_dir()).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    assert!(!recover(&ctx, &guard).problems.is_empty());
    gc(&ctx, &name(), &[]).unwrap_err();
    untouched(&outside);
    assert_revision_whole(&ctx, 1);
}

#[cfg(unix)]
#[test]
fn journals_that_cannot_be_listed_stop_everything() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, ctx) = setup();
    fs::create_dir_all(ctx.ops_dir()).unwrap();
    fs::create_dir_all(ctx.staging_dir("someone")).unwrap();
    fs::set_permissions(ctx.ops_dir(), fs::Permissions::from_mode(0o300)).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    let report = recover(&ctx, &guard);
    let begun = Tx::begin(&ctx, &guard, Action::Install, &name(), Some(entry(1, None)));
    fs::set_permissions(ctx.ops_dir(), fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(report.problems.len(), 1, "{:?}", report.problems);
    assert!(ctx.staging_dir("someone").exists());
    begun.unwrap_err();
}

#[test]
fn a_reused_revision_a_host_needing_repair_may_load_is_held_too() {
    let (_dir, ctx) = setup();
    run(&ctx, Action::Install, entry(1, None)).unwrap();
    // Left on disk by an earlier operation whose clean-up failed.
    let (listing, files) = revision_package(5);
    store::stage_revision(&ctx, "earlier", &name(), 5, &listing, &files).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    {
        let mut tx = Tx::begin(
            &ctx,
            &guard,
            Action::Update,
            &name(),
            Some(entry(5, Some(1))),
        )
        .unwrap();
        assert!(!tx.stage(5, &listing, &files).unwrap().created);
        tx.step_planned(CLAUDE, HostMode::Native, "update").unwrap();
    }
    recover(&ctx, &guard);
    let now = current(&ctx).unwrap();
    assert_eq!(now.revision, 1);
    assert_eq!(now.held_revisions, vec![5]);
    let mut tx = Tx::begin(&ctx, &guard, Action::Change, &name(), Some(now)).unwrap();
    tx.commit().unwrap();
    tx.finish().unwrap();
    assert_revision_whole(&ctx, 5);
}

#[test]
fn a_resumed_rollback_marks_only_the_agents_the_caller_could_not_restore() {
    let (_dir, ctx) = setup();
    let guard = ctx.lock_blocking().unwrap();
    let mut tx = Tx::begin(&ctx, &guard, Action::Install, &name(), Some(entry(1, None))).unwrap();
    let (listing, files) = revision_package(1);
    tx.stage(1, &listing, &files).unwrap();
    for (agent, mode) in [(CLAUDE, HostMode::Native), (GEMINI, HostMode::Skills)] {
        let step = tx.step_planned(agent, mode, "install").unwrap();
        tx.step_done(step).unwrap();
    }
    // Gemini's skills were taken out again; Claude Code's could not be.
    ctx.arm_fault("record_save");
    tx.rollback(&BTreeSet::from([CLAUDE.to_string()]))
        .unwrap_err();
    ctx.disarm_faults();
    let report = recover(&ctx, &guard);
    assert_eq!(
        report.needs_repair,
        vec![(NAME.to_string(), CLAUDE.to_string())]
    );
    let now = current(&ctx).unwrap();
    assert_eq!(now.hosts.keys().collect::<Vec<_>>(), vec![CLAUDE]);
    assert_eq!(now.hosts[CLAUDE].state, HostState::NeedsRepair);
    assert_clean(&ctx);
}

#[test]
fn a_journal_waits_while_the_record_holds_another_spelling_of_its_name() {
    let (_dir, ctx) = setup();
    run(&ctx, Action::Install, entry(1, None)).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    let op = {
        let mut tx = Tx::begin(&ctx, &guard, Action::Uninstall, &name(), None).unwrap();
        tx.step_planned(CLAUDE, HostMode::Native, "uninstall")
            .unwrap();
        tx.op().to_string()
    };
    // A backup put back, from when the plugin had another spelling.
    let mut restored = record::load(&ctx).unwrap();
    let entry = restored.plugins.remove(NAME).unwrap();
    restored.plugins.insert("SuperPowers".to_string(), entry);
    record::save(&ctx, &restored).unwrap();

    let report = recover(&ctx, &guard);
    assert_eq!(report.problems.len(), 1, "{:?}", report.problems);
    assert!(ctx.journal_path(&op).exists());
    assert_eq!(record::load(&ctx).unwrap().plugins.len(), 1);
    assert_revision_whole(&ctx, 1);
}

#[test]
fn a_held_revision_outlives_the_previous_revision_moving_on() {
    let (_dir, ctx) = setup();
    run(&ctx, Action::Install, entry(1, None)).unwrap();
    run(&ctx, Action::Update, entry(2, Some(1))).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    {
        // Pointing Claude Code back at revision 1, cut short.
        let mut tx = Tx::begin(
            &ctx,
            &guard,
            Action::Change,
            &name(),
            Some(current(&ctx).unwrap()),
        )
        .unwrap();
        let (listing, files) = revision_package(1);
        tx.stage(1, &listing, &files).unwrap();
        tx.step_planned(CLAUDE, HostMode::Native, "update").unwrap();
    }
    recover(&ctx, &guard);
    let now = current(&ctx).unwrap();
    assert_eq!(now.held_revisions, vec![1]);
    // An update while Claude Code still needs repair, built from the entry.
    let mut after = now.clone();
    let (listing, files) = revision_package(3);
    after.revision = 3;
    after.previous_revision = Some(2);
    after.files = listing.iter().map(RecordFile::from).collect();
    let mut tx = Tx::begin(&ctx, &guard, Action::Update, &name(), Some(after)).unwrap();
    tx.stage(3, &listing, &files).unwrap();
    tx.commit().unwrap();
    tx.finish().unwrap();
    assert_eq!(
        revisions_on_disk(&ctx),
        BTreeSet::from(["1", "2", "3"].map(String::from))
    );
}

#[test]
fn an_uninstall_being_undone_is_never_finished() {
    let (_dir, ctx) = setup();
    run(&ctx, Action::Install, entry(1, None)).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    let op = {
        let mut tx = Tx::begin(&ctx, &guard, Action::Uninstall, &name(), None).unwrap();
        let step = tx
            .step_planned(CLAUDE, HostMode::Native, "uninstall")
            .unwrap();
        tx.step_done(step).unwrap();
        ctx.arm_fault("record_save");
        tx.commit().unwrap_err();
        ctx.disarm_faults();
        assert!(!tx.journal().committing);
        // The caller puts Claude Code's plugin back, and Codeg dies.
        tx.undoing().unwrap();
        tx.op().to_string()
    };
    let journal: Value = serde_json::from_slice(&fs::read(ctx.journal_path(&op)).unwrap()).unwrap();
    assert_eq!(journal["committing"], false);
    assert_eq!(journal["rolling_back"], true);
    // A record restored from before the plugin was installed.
    record::save(&ctx, &Record::default()).unwrap();
    let report = recover(&ctx, &guard);
    assert_eq!((report.finished, report.rolled_back), (0, 1));
    assert_revision_whole(&ctx, 1);
    assert_eq!(
        current(&ctx).unwrap().hosts[CLAUDE].state,
        HostState::NeedsRepair
    );
    assert_clean(&ctx);
}

#[test]
fn a_rollback_that_restored_every_host_is_resumed_without_marking_any() {
    let (_dir, ctx) = setup();
    let guard = ctx.lock_blocking().unwrap();
    let mut tx = Tx::begin(&ctx, &guard, Action::Install, &name(), Some(entry(1, None))).unwrap();
    let (listing, files) = revision_package(1);
    tx.stage(1, &listing, &files).unwrap();
    let step = tx
        .step_planned(CLAUDE, HostMode::Native, "install")
        .unwrap();
    tx.step_done(step).unwrap();
    tx.undoing().unwrap();
    // Every host restored; the rollback stops once the revision is in the
    // trash.
    ctx.arm_fault("discarded");
    tx.rollback(&BTreeSet::new()).unwrap_err();
    ctx.disarm_faults();
    let report = recover(&ctx, &guard);
    assert_eq!(report.rolled_back, 1);
    assert!(report.needs_repair.is_empty());
    assert!(current(&ctx).is_none());
    assert!(revisions_on_disk(&ctx).is_empty());
    assert_clean(&ctx);
}

#[test]
fn a_rollback_puts_back_the_entry_a_restored_record_lacks() {
    let (_dir, ctx) = setup();
    run(&ctx, Action::Install, entry(1, None)).unwrap();
    let before = current(&ctx).unwrap();
    let guard = ctx.lock_blocking().unwrap();
    let mut tx = Tx::begin(
        &ctx,
        &guard,
        Action::Update,
        &name(),
        Some(entry(2, Some(1))),
    )
    .unwrap();
    let (listing, files) = revision_package(2);
    tx.stage(2, &listing, &files).unwrap();
    let step = tx.step_planned(CLAUDE, HostMode::Native, "update").unwrap();
    tx.step_done(step).unwrap();
    tx.undoing().unwrap();
    // Every host back on revision 1; the rollback stops with revision 2 in
    // the trash, and a record without the plugin is restored.
    ctx.arm_fault("discarded");
    tx.rollback(&BTreeSet::new()).unwrap_err();
    ctx.disarm_faults();
    record::save(&ctx, &Record::default()).unwrap();

    let report = recover(&ctx, &guard);
    assert_eq!(report.rolled_back, 1);
    assert!(report.needs_repair.is_empty());
    assert_eq!(current(&ctx).unwrap(), before);
    assert_eq!(revisions_on_disk(&ctx), BTreeSet::from(["1".to_string()]));
    assert_clean(&ctx);
}
