//! Version-gated compatibility patch for Cursor ACP sessions that omit
//! `enableAgentRetries` from `agentClient.run` options (see `agent-session.ts`).
//!
//! Cursor's ACP entry point builds its run options WITHOUT the flag, while the
//! TUI/headless path sets it from `retry-helpers.ts`'s `w5(action.case)`. The
//! run loop reads it as `null!==(g=_.enableAgentRetries)&&void 0!==g&&g` and
//! gates EVERY retry branch on `enableAgentRetries || endlessRetries`, so an
//! ACP session gets `undefined` -> `false` -> zero retries: the first transport
//! blip, stall or retryable server error ends the turn outright, where the TUI
//! would retry it (10 transport attempts / 3 server attempts). There is no
//! CLI flag, config key or env var that reaches the flag from outside, which
//! is why this is a bundle patch rather than a launch-argument change.
//!
//! This is NOT a regression in one release — `2026.08.11-e8db854` omits the
//! flag too — but the patch stays pinned to versions a maintainer has actually
//! triaged ([`TRIAGED_AFFECTED_VERSIONS`], kept honest by
//! `pinned_cursor_version_is_triaged`).
//!
//! # Why the splice is derived instead of transcribed
//!
//! Cursor regenerates its minified identifiers on every build, and — this is
//! the part that cost us — **per platform archive of the SAME version**. In
//! `2026.09.15-d2fe57e` the two statements before the run options are
//!
//! ```text
//! darwin: …,b=(0,S.K)({modelDetails:m,requestedModel:g}),y=new c.ConversationAction({action:{case:"userMessageAction",value:d}}),M=Object.assign(…
//! linux : …,y=(0,S.K)({modelDetails:m,requestedModel:g}),b=new c.ConversationAction({action:{case:"userMessageAction",value:d}}),k=Object.assign(…
//! ```
//!
//! — `y` and `b` are swapped. The bytes this patch anchors on are identical on
//! both, so a table keyed on the version alone matched the Linux bundle and
//! spliced in `y.action.case`, where `y` is the model-request struct with no
//! `action` at all: every single Cursor turn on Linux died with
//! `TypeError: Cannot read properties of undefined (reading 'case')` before
//! the request ever left the process.
//!
//! `2026.09.18-9a7762b` rules out reading that as a two-way darwin/linux split:
//! its **windows/x64** archive takes the action local from one side and the
//! object-assign local from the other (`y=new …ConversationAction(…),k=Object
//! .assign(…`), where darwin is `y`/`M` and linux is `b`/`k`. The minifier
//! numbers each archive independently, so the only safe assumption is that
//! EVERY local is per-archive — which is what deriving them buys.
//!
//! So nothing about the splice is transcribed by hand any more:
//!
//!   * the anchor ([`RUN_OPTIONS_ANCHOR`]) is matched structurally, with the
//!     module-level identifiers it prints left as wildcards — one pattern now
//!     covers every generation, and the matched bytes are never rewritten,
//!     only inserted in front of;
//!   * the `ConversationAction` local the policy reads is looked up **in the
//!     very bundle being patched** ([`ACTION_LOCAL_DECL`]), so it cannot
//!     disagree with it;
//!   * and the injected expression is written so that reading the WRONG local
//!     still cannot throw ([`retry_policy_expression`]) — the worst case is
//!     upstream's policy not being consulted, never a dead session.
//!
//! [`repair_range`] additionally rewrites the earlier hand-transcribed splice
//! wherever it is already on disk: those installs answer "already fixed" to the
//! marker check, so without it a broken bundle would stay broken until the user
//! cleared the agent cache.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use regex::Regex;

use crate::acp::error::AcpError;

const CURSOR_AGENT_ID: &str = "cursor";

/// Cursor agent-cli versions whose ACP chunk was inspected and found to omit
/// `enableAgentRetries` from the `agentClient.run` options.
///
/// Versions only — the splice itself is derived from the bundle (see the module
/// docs), so an entry here says "a maintainer opened this release and the flag
/// really is missing", nothing more. Older entries stay: an install extracted
/// from one of those archives is still on disk and still needs patching.
const TRIAGED_AFFECTED_VERSIONS: &[&str] = &[
    "2026.09.02-c22c1a3",
    "2026.09.10-fd3934a",
    "2026.09.15-d2fe57e",
    "2026.09.18-9a7762b",
];

/// Cursor agent-cli versions whose bundle was inspected and found to already
/// pass `enableAgentRetries` on the ACP path (upstream fixed it, or the code
/// moved). Kept beside [`TRIAGED_AFFECTED_VERSIONS`] so the triage test can
/// tell "checked, nothing to do" apart from "nobody has looked at this pin
/// yet".
///
/// Read only by `pinned_cursor_version_is_triaged`, but it belongs next to
/// [`TRIAGED_AFFECTED_VERSIONS`] — that pair is the triage record a maintainer
/// bumping the Cursor pin has to update.
#[allow(dead_code)]
const UNAFFECTED_VERSIONS: &[&str] = &[];

const AGENT_SESSION_MODULE: &str = "\"./src/acp/agent-session.ts\"";

/// Opening bytes of the run-options tail, and the point the policy is inserted
/// at: the patch splices a property in front of `onConnectionStateChange`
/// without rewriting a single matched byte.
const RUN_OPTIONS_OPEN: &str = ")),{";

/// The `agentClient.run` options tail as it appears WITHOUT the flag.
///
/// Every identifier Cursor's minifier owns is a wildcard: the debug-log module
/// (`S` in the September 2 generation, `w` from September 15 on), the
/// `onErrorNotRetried` module (`P` → `I`) and its export. What is pinned is the
/// shape — two `debugLog` calls with Cursor's own connection-state strings, and
/// an `onErrorNotRetried` handler that forwards `this.sharedServices
/// .configProvider` — which is specific enough that it occurs exactly once in
/// the ACP chunk, and [`plan_splice`] refuses to touch a bundle where it does
/// not.
const RUN_OPTIONS_ANCHOR: &str = concat!(
    r#"\)\),\{onConnectionStateChange:e=>\{"reconnecting"===e\.state\?"#,
    r#"\(0,(\w+)\.debugLog\)\("Connection state: reconnecting"\):"#,
    r#""connected"===e\.state&&\(0,(\w+)\.debugLog\)\("Connection state: connected"\)\},"#,
    r#"onErrorNotRetried:e=>\{\(0,\w+\.\w+\)\(\{configProvider:this\.sharedServices\.configProvider,info:e\}\)\}\}\)"#,
);

/// Declarator that binds the `ConversationAction` the run options are built
/// for. Its local is the one thing the injected policy has to name, so it is
/// read out of the bundle rather than remembered.
const ACTION_LOCAL_DECL: &str = r#"(\w+)=new \w+\.ConversationAction\(\{action:\{case:"userMessageAction""#;

/// codeg's own earlier splice, which named the local from a table instead of
/// from the bundle. Matched so the wrong-local installs it left behind can be
/// repaired in place; see [`repair_range`].
const LEGACY_CODEG_POLICY: &str = concat!(
    r#"enableAgentRetries:"shellCommandAction"!==(\w+)\.action\.case"#,
    r#"&&"backgroundTaskCompletionAction"!==(\w+)\.action\.case"#,
    r#"&&"goalContinuationAction"!==(\w+)\.action\.case,"#,
);

/// Marker written by this patch or upstream fixes.
const ENABLE_AGENT_RETRIES_MARKER: &str = "enableAgentRetries:";

/// How far back from the run options the `ConversationAction` declarator may
/// sit and still be believed to be the same statement list. It is 356 bytes in
/// every archive of every triaged build; the bound is loose enough to survive a
/// field being added between them and tight enough that a match from an
/// unrelated method cannot qualify.
const MAX_DECL_DISTANCE: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompatPatchStatus {
    NotApplicable,
    AlreadyFixed,
    Applied,
    /// An earlier codeg splice was found and rewritten against the local this
    /// bundle actually declares. Distinct from [`Self::Applied`] only so the
    /// log says which of the two happened.
    Repaired,
    PatternMismatch,
}

impl CompatPatchStatus {
    pub fn log_label(self) -> &'static str {
        match self {
            Self::NotApplicable => "NOT_APPLICABLE",
            Self::AlreadyFixed => "ALREADY_FIXED",
            Self::Applied => "APPLIED",
            Self::Repaired => "REPAIRED",
            Self::PatternMismatch => "PATTERN_MISMATCH",
        }
    }

    /// Outcomes that leave the bundle carrying a correct policy. Used by the
    /// memo to decide what is settled.
    fn is_success(self) -> bool {
        matches!(self, Self::Applied | Self::Repaired | Self::AlreadyFixed)
    }
}

fn run_options_anchor() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(RUN_OPTIONS_ANCHOR).expect("run-options anchor is a valid regex"))
}

fn action_local_decl() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(ACTION_LOCAL_DECL).expect("action-local pattern is a valid regex"))
}

fn legacy_codeg_policy() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(LEGACY_CODEG_POLICY).expect("legacy policy is a valid regex"))
}

/// The inlined equivalent of upstream's `w5(<action>.case)`, whose body in
/// these bundles is exactly
/// `function u(e){return"shellCommandAction"!==e&&"backgroundTaskCompletionAction"!==e&&"goalContinuationAction"!==e}`,
/// guarded so that it cannot throw.
///
/// `agent-session.ts` has a single `agentClient.run` call and it always builds
/// a `userMessageAction`, so today the policy is always `true`; it is written
/// out rather than as a bare `true` so that a bundle which later routes another
/// action through the same call site still gets upstream's answer.
///
/// The `!(l&&l.action)||…` guard is what keeps a misread local survivable. `l`
/// is always a declared binding — it is read off a declarator in the same
/// statement list, so it can never be a `ReferenceError` — and if it ever turns
/// out to be some other object, the expression falls back to `true` (retries
/// on, which is the TUI's answer for a user message) instead of dereferencing
/// `undefined`. That is the difference between "the policy was not consulted"
/// and the dead Linux sessions this guard exists to make impossible.
fn retry_policy_expression(action_local: &str) -> String {
    format!(
        "enableAgentRetries:!({action_local}&&{action_local}.action)\
         ||\"shellCommandAction\"!=={action_local}.action.case\
         &&\"backgroundTaskCompletionAction\"!=={action_local}.action.case\
         &&\"goalContinuationAction\"!=={action_local}.action.case,"
    )
}

/// What [`plan_splice`] worked out about a bundle: the byte range to replace
/// (empty for a plain insertion) and the local the policy must read.
#[derive(Debug, Clone, PartialEq, Eq)]
struct BundleSplice {
    range: std::ops::Range<usize>,
    action_local: String,
    /// True when `range` covers an earlier codeg splice being rewritten.
    repair: bool,
}

/// The local bound to the `ConversationAction`, and where it is declared.
///
/// Requires the declarator to be UNIQUE in the chunk — it is, in every
/// archive of every triaged build (one `agentClient.run` call site, one
/// action). Uniqueness is what turns "this is the local the run options are
/// built for" into a fact rather than a choice between candidates;
/// [`declaration_reaches`] then checks it actually reaches the splice point.
fn unique_action_local(content: &str) -> Option<(usize, String)> {
    let mut matches = action_local_decl().captures_iter(content);
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    let whole = first.get(0)?;
    // `(\w+)=` also matches the last segment of a member-expression target:
    // `this.action=new c.ConversationAction({…})` would hand back `action`,
    // which is not a binding at all. Naming it in the policy is the one misread
    // the injected guard cannot survive — an undeclared identifier throws
    // before `!(L&&L.action)` ever runs — so a leading `.` disqualifies it.
    if content.as_bytes()[..whole.start()].last() == Some(&b'.') {
        return None;
    }
    Some((whole.start(), first.get(1)?.as_str().to_string()))
}

/// Whether a local declared at `decl_start` is still in scope, and still in the
/// same statement list, at `use_at`.
///
/// Three conditions, and the third is the one that matters. It is declared
/// before the use and close to it; the run-options object is being built out of
/// the same declarator list (`=Object.assign(` between the two); and no block
/// or call the declarator sits inside has CLOSED before the use
/// ([`no_enclosing_scope_closes`]). Without the last one a
/// `ConversationAction` built inside some nested callback would be accepted and
/// the policy would name a binding that does not exist at the splice point —
/// the one misread the injected expression's own guard cannot survive, because
/// an undeclared identifier throws before any of it runs.
fn declaration_reaches(content: &str, decl_start: usize, use_at: usize) -> bool {
    if decl_start >= use_at || use_at - decl_start > MAX_DECL_DISTANCE {
        return false;
    }
    let Some(between) = content.get(decl_start..use_at) else {
        return false;
    };
    between.contains("=Object.assign(") && no_enclosing_scope_closes(between)
}

/// True when nothing in `between` closes a brace or paren it did not open.
///
/// A running depth that dips below zero means the text walked out of a block
/// (or an argument list) that was already open at the declarator — i.e. the
/// declarator is nested inside something the insertion point is not. Contents
/// of string and template literals are skipped so a brace inside a message
/// cannot move the count.
///
/// Regular-expression literals are NOT tracked: telling `/` apart from division
/// needs a parser. Usually that only costs a refusal, but it is not a one-way
/// error — a regex holding an unpaired quote opens a bogus string state, and
/// every brace until the next matching quote then goes uncounted, which can
/// make this ACCEPT a declarator it should have rejected. What keeps that from
/// mattering is [`TRIAGED_AFFECTED_VERSIONS`]: no bundle reaches here until
/// someone has opened it and checked the shape by hand.
fn no_enclosing_scope_closes(between: &str) -> bool {
    let mut braces: i32 = 0;
    let mut parens: i32 = 0;
    let mut quote: Option<u8> = None;
    let mut escaped = false;
    for byte in between.bytes() {
        if let Some(open) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == open {
                quote = None;
            }
            continue;
        }
        match byte {
            b'"' | b'\'' | b'`' => quote = Some(byte),
            b'{' => braces += 1,
            b'}' => braces -= 1,
            b'(' => parens += 1,
            b')' => parens -= 1,
            _ => {}
        }
        if braces < 0 || parens < 0 {
            return false;
        }
    }
    true
}

/// The range of an earlier codeg splice, when the bundle carries one.
///
/// Matched by its exact shape rather than by the marker, so a splice upstream
/// wrote (`enableAgentRetries:(0,w5.w5)(…)`) is never mistaken for ours and
/// rewritten. Requires uniqueness for the same reason [`unique_action_local`]
/// does, and requires the three locals the old policy reads to agree — a
/// half-rewritten splice is not something to rewrite the rest of.
fn repair_range(content: &str) -> Option<std::ops::Range<usize>> {
    let mut matches = legacy_codeg_policy().captures_iter(content);
    let first = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    let (a, b, c) = (first.get(1)?, first.get(2)?, first.get(3)?);
    if a.as_str() != b.as_str() || b.as_str() != c.as_str() {
        return None;
    }
    let whole = first.get(0)?;
    Some(whole.start()..whole.end())
}

/// Where the policy goes and what it must name, or `None` when this is not a
/// bundle we recognise well enough to touch.
fn plan_splice(content: &str) -> Option<BundleSplice> {
    let (decl_start, action_local) = unique_action_local(content)?;

    // Repair first: an install carrying codeg's earlier splice no longer has
    // the bare anchor to insert at, and its marker would otherwise read as
    // "already fixed".
    if let Some(range) = repair_range(content) {
        if !declaration_reaches(content, decl_start, range.start) {
            return None;
        }
        return Some(BundleSplice {
            range,
            action_local,
            repair: true,
        });
    }

    let mut anchors = run_options_anchor().captures_iter(content);
    let anchor = anchors.next()?;
    if anchors.next().is_some() {
        return None;
    }
    // The two `debugLog` calls have to come from the same module binding; if
    // they do not, this is not the statement the pattern was written against.
    if anchor.get(1)?.as_str() != anchor.get(2)?.as_str() {
        return None;
    }
    let insert_at = anchor.get(0)?.start() + RUN_OPTIONS_OPEN.len();
    if !declaration_reaches(content, decl_start, insert_at) {
        return None;
    }
    Some(BundleSplice {
        range: insert_at..insert_at,
        action_local,
        repair: false,
    })
}

/// Apply the compatibility patch when `platform_dir` holds a managed Cursor
/// install for a known-affected version.
///
/// Idempotent, and best-effort by design: every way of not recognising the
/// bundle collapses to `PatternMismatch`, which leaves Cursor's bytes exactly
/// as shipped. Callers deliberately ignore the status — an unpatched agent is
/// the status quo (fewer retries), while refusing to launch over a failed
/// patch would turn a reliability nicety into an outage.
///
/// Re-reads the bundle on every call; the process-wide entry points
/// ([`maybe_apply_for_agent`] / [`apply_after_install_for_agent`]) are the ones
/// that bound that cost.
pub fn maybe_apply(platform_dir: &Path, version: &str) -> CompatPatchStatus {
    let normalized = normalize_version_label(version);
    if !TRIAGED_AFFECTED_VERSIONS.contains(&normalized.as_str()) {
        return CompatPatchStatus::NotApplicable;
    }

    let dist_package = platform_dir.join("dist-package");
    if !dist_package.is_dir() {
        log_status(CompatPatchStatus::PatternMismatch, &normalized, None);
        return CompatPatchStatus::PatternMismatch;
    }

    let bundle_path = match find_agent_session_bundle(&dist_package) {
        Some(path) => path,
        None => {
            log_status(CompatPatchStatus::PatternMismatch, &normalized, None);
            return CompatPatchStatus::PatternMismatch;
        }
    };

    let content = match std::fs::read_to_string(&bundle_path) {
        Ok(content) => content,
        Err(err) => {
            tracing::warn!(
                "Cursor ACP retry compatibility patch: read failed (version={}, bundle={}, err={})",
                normalized,
                bundle_path.display(),
                err
            );
            log_status(
                CompatPatchStatus::PatternMismatch,
                &normalized,
                Some(&bundle_path),
            );
            return CompatPatchStatus::PatternMismatch;
        }
    };

    if !content.contains(AGENT_SESSION_MODULE) {
        log_status(
            CompatPatchStatus::PatternMismatch,
            &normalized,
            Some(&bundle_path),
        );
        return CompatPatchStatus::PatternMismatch;
    }

    let Some(plan) = plan_splice(&content) else {
        // A flag that is already there and is not ours is upstream's: leave it.
        // Unless it IS ours and we simply could not plan the rewrite — then the
        // bundle is carrying the broken wrong-local splice, and calling that
        // "already fixed" would both log a lie and let the memo settle on it.
        // Report the mismatch instead, so it stays inside the attempt budget
        // and the log names something a maintainer can act on.
        let status = if legacy_codeg_policy().is_match(&content) {
            tracing::error!(
                "Cursor ACP retry compatibility patch: bundle carries codeg's earlier \
                 wrong-local splice but no repair could be planned \
                 (version={}, bundle={})",
                normalized,
                bundle_path.display()
            );
            CompatPatchStatus::PatternMismatch
        } else if content.contains(ENABLE_AGENT_RETRIES_MARKER) {
            CompatPatchStatus::AlreadyFixed
        } else {
            CompatPatchStatus::PatternMismatch
        };
        log_status(status, &normalized, Some(&bundle_path));
        return status;
    };

    let policy = retry_policy_expression(&plan.action_local);
    let patched = {
        let mut patched = String::with_capacity(content.len() + policy.len());
        patched.push_str(&content[..plan.range.start]);
        patched.push_str(&policy);
        patched.push_str(&content[plan.range.end..]);
        patched
    };
    if patched == content {
        log_status(
            CompatPatchStatus::PatternMismatch,
            &normalized,
            Some(&bundle_path),
        );
        return CompatPatchStatus::PatternMismatch;
    }

    if let Err(err) = write_atomically(&bundle_path, &patched) {
        tracing::warn!(
            "Cursor ACP retry compatibility patch: write failed (version={}, bundle={}, err={})",
            normalized,
            bundle_path.display(),
            err
        );
        log_status(
            CompatPatchStatus::PatternMismatch,
            &normalized,
            Some(&bundle_path),
        );
        return CompatPatchStatus::PatternMismatch;
    }

    let status = if plan.repair {
        CompatPatchStatus::Repaired
    } else {
        CompatPatchStatus::Applied
    };
    log_status(status, &normalized, Some(&bundle_path));
    status
}

/// How many times the same install may answer `PatternMismatch` before that is
/// taken as settled.
///
/// The successful outcomes are stable by construction and memoized on the
/// first pass, but `PatternMismatch` is also where every transient failure
/// lands — a read that lost a race with an antivirus scan, a `rename` the
/// filesystem refused. Memoizing the first of those would suppress the patch
/// for the rest of the process; retrying it forever would put the ~9 MB scan
/// back on a hot path. A few attempts is both.
const MAX_MISMATCH_ATTEMPTS: u32 = 3;

/// Outcomes already reached for a managed install in this process, with the
/// number of attempts behind each.
///
/// Resolving the bundle means reading every `*.index.js` chunk in
/// `dist-package` until the ACP one turns up (~9 MB across ~70 files for
/// Cursor), and the cache-hit hook runs on every connect, preflight and
/// diagnostics call — so without this the same megabytes are re-read, with
/// blocking I/O on an async worker, for the lifetime of the app. Locking it
/// also serializes patch attempts, so two callers never write the same bundle
/// at once.
fn attempted() -> &'static Mutex<HashMap<PathBuf, (CompatPatchStatus, u32)>> {
    static ATTEMPTED: OnceLock<Mutex<HashMap<PathBuf, (CompatPatchStatus, u32)>>> = OnceLock::new();
    ATTEMPTED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Patch a managed install that is being REUSED from the cache. At most one
/// bundle scan per install per process — see [`attempted`].
pub fn maybe_apply_for_agent(
    agent_id: &str,
    platform_dir: &Path,
    version: &str,
) -> CompatPatchStatus {
    apply_for_agent(agent_id, platform_dir, version, false)
}

/// Patch a managed install that was just downloaded and extracted.
///
/// Bypasses (and refreshes) the memo: a fresh extraction replaces the very
/// bytes an earlier outcome described, so a re-install after `clear_agent_cache`
/// must not inherit the previous install's "already handled".
pub fn apply_after_install_for_agent(
    agent_id: &str,
    platform_dir: &Path,
    version: &str,
) -> CompatPatchStatus {
    apply_for_agent(agent_id, platform_dir, version, true)
}

fn apply_for_agent(
    agent_id: &str,
    platform_dir: &Path,
    version: &str,
    force: bool,
) -> CompatPatchStatus {
    if agent_id != CURSOR_AGENT_ID {
        return CompatPatchStatus::NotApplicable;
    }
    // Held across the patch so a concurrent caller waits for the outcome
    // rather than racing it onto the same file.
    let Ok(mut attempted) = attempted().lock() else {
        // A poisoned lock means a previous attempt panicked mid-patch; do not
        // touch the bundle again on the strength of that.
        return CompatPatchStatus::PatternMismatch;
    };
    let previous = attempted.get(platform_dir).copied();
    if !force {
        if let Some((status, attempts)) = previous {
            if status.is_success() || attempts >= MAX_MISMATCH_ATTEMPTS {
                return status;
            }
        }
    }
    let status = maybe_apply(platform_dir, version);
    if status != CompatPatchStatus::NotApplicable {
        // A fresh install starts its own attempt budget: the bytes the earlier
        // mismatches were counted against are gone.
        let attempts = if force {
            1
        } else {
            previous.map_or(1, |(_, attempts)| attempts + 1)
        };
        attempted.insert(platform_dir.to_path_buf(), (status, attempts));
    }
    status
}

fn find_agent_session_bundle(dist_package: &Path) -> Option<PathBuf> {
    let mut chunks: Vec<PathBuf> = std::fs::read_dir(dist_package)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".index.js"))
                && path.is_file()
        })
        .collect();
    // `read_dir` yields in filesystem order, so sort: which chunk we inspect
    // first — and therefore what a malformed sibling can perturb — should not
    // depend on the machine.
    chunks.sort();

    for path in chunks {
        // A chunk we cannot read, or that is not UTF-8, is simply not ours.
        // Returning here instead would abandon the search for the ACP chunk
        // because of an unrelated file and leave the bundle unpatched.
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        if content.contains(AGENT_SESSION_MODULE) {
            return Some(path);
        }
    }
    None
}

fn write_atomically(path: &Path, content: &str) -> Result<(), AcpError> {
    static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

    let parent = path
        .parent()
        .ok_or_else(|| AcpError::DownloadFailed("bundle path has no parent".into()))?;
    // Per-writer name: a fixed one lets a second writer truncate the staging
    // file another is still filling, and the first `rename` then publishes a
    // half-written bundle over Cursor's chunk.
    let tmp = parent.join(format!(
        ".codeg-acp-retry-patch-{}-{}.tmp",
        std::process::id(),
        TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    if let Err(e) = std::fs::write(&tmp, content.as_bytes()) {
        let _ = std::fs::remove_file(&tmp);
        return Err(AcpError::DownloadFailed(format!(
            "write temp bundle patch: {e}"
        )));
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        // Never leave staging bytes inside the agent's own package dir.
        let _ = std::fs::remove_file(&tmp);
        return Err(AcpError::DownloadFailed(format!(
            "commit bundle patch: {e}"
        )));
    }
    Ok(())
}

fn normalize_version_label(version: &str) -> String {
    let trimmed = version.trim();
    if let Some(stripped) = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
    {
        stripped.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn log_status(status: CompatPatchStatus, version: &str, bundle: Option<&Path>) {
    match bundle {
        Some(path) => tracing::info!(
            "Cursor ACP retry compatibility patch: {} (version={}, bundle={})",
            status.log_label(),
            version,
            path.display()
        ),
        None => tracing::info!(
            "Cursor ACP retry compatibility patch: {} (version={})",
            status.log_label(),
            version
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_VERSION: &str = TRIAGED_AFFECTED_VERSIONS[0];

    /// The run-options statement exactly as `2026.09.15-d2fe57e` ships it on
    /// **darwin/arm64**, from `dist-package/2698.index.js`. Byte-identical in
    /// `2026.09.18-9a7762b` (`dist-package/1006.index.js`).
    const REAL_DARWIN_RUN_OPTIONS: &str = concat!(
        r#"y=new c.ConversationAction({action:{case:"userMessageAction",value:d}}),"#,
        r#"M=Object.assign(Object.assign({conversationId:this.agentStore.getId(),"#,
        r#"headers:(0,T.o)(this.agentStore),requestedModel:b.requestedModel},"#,
        r#"(0,S.U)({modelManager:this.sharedServices.modelManager,"#,
        r#"configProvider:this.sharedServices.configProvider,"#,
        r#"parentMaxMode:null==g?void 0:g.maxMode})),"#,
        r#"{onConnectionStateChange:e=>{"reconnecting"===e.state?"#,
        r#"(0,w.debugLog)("Connection state: reconnecting"):"connected"===e.state&&"#,
        r#"(0,w.debugLog)("Connection state: connected")},onErrorNotRetried:e=>{"#,
        r#"(0,I.Z)({configProvider:this.sharedServices.configProvider,info:e})}})"#,
    );

    /// The same statement from the same release's **linux/x64** archive
    /// (`dist-package/1699.index.js`). Byte-identical to the darwin one except
    /// that `y` and `b` are swapped — `y` is the model request here, and the
    /// `ConversationAction` is `b`. This pair is the whole reason the splice is
    /// derived; see the module docs. Byte-identical in `2026.09.18-9a7762b`
    /// (same chunk number).
    const REAL_LINUX_RUN_OPTIONS: &str = concat!(
        r#"b=new c.ConversationAction({action:{case:"userMessageAction",value:d}}),"#,
        r#"k=Object.assign(Object.assign({conversationId:this.agentStore.getId(),"#,
        r#"headers:(0,T.o)(this.agentStore),requestedModel:y.requestedModel},"#,
        r#"(0,S.U)({modelManager:this.sharedServices.modelManager,"#,
        r#"configProvider:this.sharedServices.configProvider,"#,
        r#"parentMaxMode:null==g?void 0:g.maxMode})),"#,
        r#"{onConnectionStateChange:e=>{"reconnecting"===e.state?"#,
        r#"(0,w.debugLog)("Connection state: reconnecting"):"connected"===e.state&&"#,
        r#"(0,w.debugLog)("Connection state: connected")},onErrorNotRetried:e=>{"#,
        r#"(0,I.Z)({configProvider:this.sharedServices.configProvider,info:e})}})"#,
    );

    /// `2026.09.18-9a7762b`'s **windows/x64** archive
    /// (`dist-package/5072.index.js`), which is neither of the above: it takes
    /// the action local from darwin (`y`) and the object-assign local from
    /// linux (`k`). Proof that the two locals vary independently, so "the
    /// darwin one" and "the linux one" are not two variants to choose between.
    const REAL_WINDOWS_RUN_OPTIONS: &str = concat!(
        r#"y=new c.ConversationAction({action:{case:"userMessageAction",value:d}}),"#,
        r#"k=Object.assign(Object.assign({conversationId:this.agentStore.getId(),"#,
        r#"headers:(0,T.o)(this.agentStore),requestedModel:b.requestedModel},"#,
        r#"(0,S.U)({modelManager:this.sharedServices.modelManager,"#,
        r#"configProvider:this.sharedServices.configProvider,"#,
        r#"parentMaxMode:null==g?void 0:g.maxMode})),"#,
        r#"{onConnectionStateChange:e=>{"reconnecting"===e.state?"#,
        r#"(0,w.debugLog)("Connection state: reconnecting"):"connected"===e.state&&"#,
        r#"(0,w.debugLog)("Connection state: connected")},onErrorNotRetried:e=>{"#,
        r#"(0,I.Z)({configProvider:this.sharedServices.configProvider,info:e})}})"#,
    );

    /// The earlier generation (`2026.09.02-c22c1a3` / `2026.09.10-fd3934a`),
    /// which binds the debug-log module to `S`, `onErrorNotRetried` to `P` and
    /// the action to `I`. One anchor has to cover this too.
    const OLD_GENERATION_RUN_OPTIONS: &str = concat!(
        r#"I=new c.ConversationAction({action:{case:"userMessageAction",value:d}}),"#,
        r#"M=Object.assign(Object.assign({conversationId:this.agentStore.getId()},"#,
        r#"(0,S.U)({modelManager:this.sharedServices.modelManager})),"#,
        r#"{onConnectionStateChange:e=>{"reconnecting"===e.state?"#,
        r#"(0,S.debugLog)("Connection state: reconnecting"):"connected"===e.state&&"#,
        r#"(0,S.debugLog)("Connection state: connected")},onErrorNotRetried:e=>{"#,
        r#"(0,P.Z)({configProvider:this.sharedServices.configProvider,info:e})}})"#,
    );

    fn chunk(run_options: &str) -> String {
        format!("exports.modules={{{AGENT_SESSION_MODULE}(e,t,o){{placeholder {run_options} end}}}}")
    }

    fn write_bundle(dir: &Path, content: &str) -> PathBuf {
        let dist = dir.join("dist-package");
        std::fs::create_dir_all(&dist).unwrap();
        let path = dist.join("2471.index.js");
        std::fs::write(&path, content).unwrap();
        path
    }

    fn patched_bundle(dir: &Path) -> String {
        let bundle = find_agent_session_bundle(&dir.join("dist-package")).unwrap();
        std::fs::read_to_string(bundle).unwrap()
    }

    #[test]
    fn unknown_version_is_not_applicable() {
        let tmp = tempfile::tempdir().unwrap();
        let status = maybe_apply(tmp.path(), "2026.08.11-e8db854");
        assert_eq!(status, CompatPatchStatus::NotApplicable);
    }

    #[test]
    fn affected_version_without_bundle_is_pattern_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        let status = maybe_apply(tmp.path(), SAMPLE_VERSION);
        assert_eq!(status, CompatPatchStatus::PatternMismatch);
    }

    // THE REGRESSION. Both archives of `2026.09.15-d2fe57e` carry the same
    // run-options bytes, and the previous patch — which remembered the darwin
    // local — spliced `y.action.case` into the Linux bundle, where `y` is
    // `{modelDetails,requestedModel}`. Every turn then died with
    // `TypeError: Cannot read properties of undefined (reading 'case')` before
    // the request left the process. The local has to come from the bundle.
    #[test]
    fn each_platform_archive_gets_its_own_action_local() {
        for (label, run_options, expected_local) in [
            ("darwin", REAL_DARWIN_RUN_OPTIONS, "y"),
            ("linux", REAL_LINUX_RUN_OPTIONS, "b"),
            ("windows", REAL_WINDOWS_RUN_OPTIONS, "y"),
            ("old-generation", OLD_GENERATION_RUN_OPTIONS, "I"),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            write_bundle(tmp.path(), &chunk(run_options));
            assert_eq!(
                maybe_apply(tmp.path(), SAMPLE_VERSION),
                CompatPatchStatus::Applied,
                "{label} archive did not patch"
            );
            let patched = patched_bundle(tmp.path());
            assert!(
                patched.contains(&retry_policy_expression(expected_local)),
                "{label} archive did not read its own ConversationAction local"
            );
            // The anchor's own bytes are never rewritten — the policy is
            // inserted in front of them.
            assert!(
                patched.contains(&format!("{RUN_OPTIONS_OPEN}enableAgentRetries:")),
                "{label} archive: policy is not at the head of the run options"
            );
            assert!(
                patched.contains("},onErrorNotRetried:e=>{"),
                "{label} archive: the matched tail was modified"
            );
        }
    }

    // The injected expression must be unable to throw even if the local it
    // names turns out to be the wrong object — that is the second, independent
    // guard against the failure above.
    #[test]
    fn the_policy_short_circuits_before_dereferencing_the_action() {
        let policy = retry_policy_expression("y");
        assert!(
            policy.starts_with("enableAgentRetries:!(y&&y.action)||"),
            "policy must test the action before reading it: {policy}"
        );
        assert!(policy.ends_with("\"goalContinuationAction\"!==y.action.case,"));
        // Upstream's three cases, all read off the same local.
        for case in [
            "shellCommandAction",
            "backgroundTaskCompletionAction",
            "goalContinuationAction",
        ] {
            assert!(policy.contains(&format!("\"{case}\"!==y.action.case")), "{case}");
        }
    }

    // Installs that already took the bad splice answer the marker check with
    // "already fixed", so the repair has to recognise codeg's own handiwork and
    // rewrite it against the local the bundle actually declares. Without this
    // every Linux install stays broken until its agent cache is cleared.
    #[test]
    fn a_wrong_local_from_the_previous_patch_is_repaired_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        // Exactly what the old table wrote into the Linux bundle.
        let broken = REAL_LINUX_RUN_OPTIONS.replace(
            "})),{onConnectionStateChange",
            "})),{enableAgentRetries:\"shellCommandAction\"!==y.action.case\
             &&\"backgroundTaskCompletionAction\"!==y.action.case\
             &&\"goalContinuationAction\"!==y.action.case,onConnectionStateChange",
        );
        assert!(broken.contains("enableAgentRetries:"), "fixture must be spliced");
        write_bundle(tmp.path(), &chunk(&broken));

        assert_eq!(
            maybe_apply(tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::Repaired
        );
        let patched = patched_bundle(tmp.path());
        assert!(patched.contains(&retry_policy_expression("b")));
        assert!(
            !patched.contains("\"shellCommandAction\"!==y.action.case"),
            "the wrong local must be gone, not merely joined"
        );
        assert_eq!(patched.matches(ENABLE_AGENT_RETRIES_MARKER).count(), 1);

        // And the repair settles: a second pass has nothing left to do.
        assert_eq!(
            maybe_apply(tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::AlreadyFixed
        );
    }

    #[test]
    fn second_application_is_already_fixed() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path(), &chunk(REAL_DARWIN_RUN_OPTIONS));
        assert_eq!(
            maybe_apply(tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::Applied
        );
        assert_eq!(
            maybe_apply(tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::AlreadyFixed
        );
    }

    #[test]
    fn upstream_fixed_bundle_is_already_fixed() {
        let tmp = tempfile::tempdir().unwrap();
        let content = chunk(&REAL_DARWIN_RUN_OPTIONS.replace(
            "})),{onConnectionStateChange",
            "})),{enableAgentRetries:(0,w5.w5)(y.action.case),onConnectionStateChange",
        ));
        write_bundle(tmp.path(), &content);
        assert_eq!(
            maybe_apply(tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::AlreadyFixed
        );
        assert!(
            patched_bundle(tmp.path()).contains("(0,w5.w5)(y.action.case)"),
            "upstream's own flag must be left alone"
        );
    }

    #[test]
    fn unexpected_bundle_structure_is_pattern_mismatch() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(
            tmp.path(),
            &format!("exports.modules={{{AGENT_SESSION_MODULE}(){{broken"),
        );
        assert_eq!(
            maybe_apply(tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::PatternMismatch
        );
    }

    // Deriving the local only answers anything if there is exactly one
    // candidate. Two `agentClient.run` call sites, or two run-options tails,
    // and "the one before the anchor" stops being a fact — leave the bundle
    // alone rather than pick.
    #[test]
    fn an_ambiguous_bundle_is_not_patched() {
        for run_options in [
            format!("{REAL_DARWIN_RUN_OPTIONS};{REAL_DARWIN_RUN_OPTIONS}"),
            format!(
                "x=new c.ConversationAction({{action:{{case:\"userMessageAction\",value:d}}}});\
                 {REAL_DARWIN_RUN_OPTIONS}"
            ),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            write_bundle(tmp.path(), &chunk(&run_options));
            assert_eq!(
                maybe_apply(tmp.path(), SAMPLE_VERSION),
                CompatPatchStatus::PatternMismatch
            );
        }
    }

    // The declarator has to be reachable from the insertion point, in the same
    // statement list. A `ConversationAction` built inside some other function
    // would be a name that is not in scope where the policy lands.
    #[test]
    fn a_declaration_from_another_scope_does_not_qualify() {
        let tmp = tempfile::tempdir().unwrap();
        let run_options = REAL_DARWIN_RUN_OPTIONS.replace(
            "y=new c.ConversationAction({action:{case:\"userMessageAction\",value:d}}),",
            "q=()=>{const y=new c.ConversationAction({action:{case:\"userMessageAction\",value:d}})},",
        );
        write_bundle(tmp.path(), &chunk(&run_options));
        assert_eq!(
            maybe_apply(tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::PatternMismatch
        );
    }

    // `(\w+)=` also fits the tail of a member-expression target. Adopting
    // `action` out of `this.action=new c.ConversationAction({…})` would name
    // something that is not a binding at all, and an undeclared identifier
    // throws before the injected `!(L&&L.action)` guard can absorb it — the one
    // misread this whole rewrite exists to rule out.
    #[test]
    fn a_member_expression_target_is_not_mistaken_for_a_binding() {
        let tmp = tempfile::tempdir().unwrap();
        let run_options = REAL_DARWIN_RUN_OPTIONS.replace(
            "y=new c.ConversationAction(",
            "this.action=new c.ConversationAction(",
        );
        write_bundle(tmp.path(), &chunk(&run_options));
        assert_eq!(
            maybe_apply(tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::PatternMismatch
        );
    }

    // A bundle still carrying the old wrong-local splice answers the
    // `enableAgentRetries:` marker check with "there is already a flag here".
    // If the repair cannot be planned, saying AlreadyFixed would log a lie AND
    // settle the memo on a bundle that crashes every prompt.
    #[test]
    fn an_unrepairable_broken_splice_is_not_reported_as_fixed() {
        let tmp = tempfile::tempdir().unwrap();
        // Legacy splice present, but the declarator was moved into a nested
        // scope, so `plan_splice` refuses.
        let broken = REAL_DARWIN_RUN_OPTIONS
            .replace(
                "y=new c.ConversationAction({action:{case:\"userMessageAction\",value:d}}),",
                "q=()=>{const y=new c.ConversationAction({action:{case:\"userMessageAction\",value:d}})},",
            )
            .replace(
                ")),{",
                &format!(
                    "{}{}",
                    ")),{",
                    concat!(
                        r#"enableAgentRetries:"shellCommandAction"!==y.action.case"#,
                        r#"&&"backgroundTaskCompletionAction"!==y.action.case"#,
                        r#"&&"goalContinuationAction"!==y.action.case,"#,
                    )
                ),
            );
        assert!(broken.contains("enableAgentRetries:"));
        write_bundle(tmp.path(), &chunk(&broken));
        assert_eq!(
            maybe_apply(tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::PatternMismatch
        );
    }

    // Cursor's `dist-package` holds ~70 webpack chunks. A chunk that is not
    // readable as UTF-8 (or that we simply cannot open) is not ours, and must
    // not abandon the scan for the one that is — otherwise the bundle is left
    // unpatched for a reason that has nothing to do with it.
    #[test]
    fn unreadable_sibling_chunk_does_not_abort_the_scan() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path(), &chunk(REAL_DARWIN_RUN_OPTIONS));
        // Sorts before the `2471.index.js` the fixture writes, so the scan
        // reaches it first on every filesystem.
        std::fs::write(
            tmp.path().join("dist-package").join("0001.index.js"),
            [0xff_u8, 0xfe, 0xfd],
        )
        .unwrap();
        assert_eq!(
            maybe_apply(tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::Applied
        );
    }

    #[test]
    fn non_cursor_agent_id_is_not_applicable() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            maybe_apply_for_agent("opencode", tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::NotApplicable
        );
    }

    // The cache-hit hook runs on every connect / preflight / diagnostics call,
    // so the ~9 MB chunk scan behind it must happen at most once per install.
    // Proven by removing the tree the answer came from: a second call that
    // still answers `Applied` cannot have gone back to disk.
    #[test]
    fn cache_hit_hook_resolves_each_install_once() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path(), &chunk(REAL_DARWIN_RUN_OPTIONS));
        assert_eq!(
            maybe_apply_for_agent(CURSOR_AGENT_ID, tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::Applied
        );

        std::fs::remove_dir_all(tmp.path().join("dist-package")).unwrap();
        assert_eq!(
            maybe_apply(tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::PatternMismatch,
            "the uncached path must see the tree is gone"
        );
        assert_eq!(
            maybe_apply_for_agent(CURSOR_AGENT_ID, tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::Applied,
            "the cache-hit hook must answer from the memo, not re-read the tree"
        );
    }

    // `clear_agent_cache` + re-download reuses the same platform dir, so the
    // post-install hook has to look at the NEW bytes. Inheriting the previous
    // install's outcome would leave a freshly extracted bundle unpatched.
    #[test]
    fn post_install_hook_ignores_the_previous_installs_outcome() {
        let tmp = tempfile::tempdir().unwrap();
        write_bundle(tmp.path(), &chunk(REAL_DARWIN_RUN_OPTIONS));
        assert_eq!(
            maybe_apply_for_agent(CURSOR_AGENT_ID, tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::Applied
        );

        // Re-extraction puts an unpatched bundle back under the same path.
        write_bundle(tmp.path(), &chunk(REAL_DARWIN_RUN_OPTIONS));
        assert_eq!(
            apply_after_install_for_agent(CURSOR_AGENT_ID, tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::Applied
        );
        assert!(patched_bundle(tmp.path()).contains(&retry_policy_expression("y")));
    }

    // Every transient failure lands on `PatternMismatch` too, so memoizing the
    // first one would let a momentary hiccup — a locked file, a refused rename
    // — leave the agent unpatched for the rest of the session.
    #[test]
    fn a_transient_mismatch_does_not_settle_the_install() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            maybe_apply_for_agent(CURSOR_AGENT_ID, tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::PatternMismatch
        );

        write_bundle(tmp.path(), &chunk(REAL_DARWIN_RUN_OPTIONS));
        assert_eq!(
            maybe_apply_for_agent(CURSOR_AGENT_ID, tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::Applied,
            "a later call must still be allowed to look"
        );
    }

    // ...but an install that keeps mismatching is an install whose bytes we do
    // not recognise, and re-reading its chunks on every connect / preflight /
    // diagnostics call would be pure waste.
    #[test]
    fn a_persistent_mismatch_stops_rescanning() {
        let tmp = tempfile::tempdir().unwrap();
        for _ in 0..MAX_MISMATCH_ATTEMPTS {
            assert_eq!(
                maybe_apply_for_agent(CURSOR_AGENT_ID, tmp.path(), SAMPLE_VERSION),
                CompatPatchStatus::PatternMismatch
            );
        }

        write_bundle(tmp.path(), &chunk(REAL_DARWIN_RUN_OPTIONS));
        assert_eq!(
            maybe_apply_for_agent(CURSOR_AGENT_ID, tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::PatternMismatch,
            "the budget is spent; the cache-hit hook stops looking"
        );
        assert_eq!(
            apply_after_install_for_agent(CURSOR_AGENT_ID, tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::Applied,
            "a re-install still gets a fresh look"
        );
    }

    // A repaired install must settle in the memo exactly like a patched one,
    // or the ~9 MB scan comes back on every connect for the rest of the run.
    #[test]
    fn a_repair_settles_the_install_too() {
        let tmp = tempfile::tempdir().unwrap();
        let broken = REAL_LINUX_RUN_OPTIONS.replace(
            "})),{onConnectionStateChange",
            "})),{enableAgentRetries:\"shellCommandAction\"!==y.action.case\
             &&\"backgroundTaskCompletionAction\"!==y.action.case\
             &&\"goalContinuationAction\"!==y.action.case,onConnectionStateChange",
        );
        write_bundle(tmp.path(), &chunk(&broken));
        assert_eq!(
            maybe_apply_for_agent(CURSOR_AGENT_ID, tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::Repaired
        );
        std::fs::remove_dir_all(tmp.path().join("dist-package")).unwrap();
        assert_eq!(
            maybe_apply_for_agent(CURSOR_AGENT_ID, tmp.path(), SAMPLE_VERSION),
            CompatPatchStatus::Repaired,
            "the outcome must come from the memo, not a re-read"
        );
    }

    // The patch only runs against versions somebody has opened, so it silently
    // stops doing anything the moment the registry pin moves. Fail here
    // instead: whoever bumps Cursor has to look at the new bundle and put the
    // version in one of the two lists.
    #[test]
    fn pinned_cursor_version_is_triaged() {
        let pinned = crate::acp::registry::get_agent_meta(crate::models::agent::AgentType::Cursor)
            .registry_version()
            .expect("Cursor pins a registry version");
        let pinned = normalize_version_label(pinned);
        assert!(
            TRIAGED_AFFECTED_VERSIONS.contains(&pinned.as_str())
                || UNAFFECTED_VERSIONS.contains(&pinned.as_str()),
            "cursor-agent {pinned} has not been checked for the ACP \
             `enableAgentRetries` omission. Inspect the ACP chunk \
             ({AGENT_SESSION_MODULE}) in its `dist-package`: if the \
             `agentClient.run` options still lack `enableAgentRetries`, add the \
             version to TRIAGED_AFFECTED_VERSIONS (the splice itself is derived \
             from the bundle, so there is nothing to transcribe — but do check \
             that `plan_splice` still recognises it); otherwise add it to \
             UNAFFECTED_VERSIONS."
        );
    }
}
