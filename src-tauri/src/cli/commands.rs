//! `agents`, `assistants`, `status`, `open`.

use std::time::Duration;

use serde_json::json;
use tokio::time::Instant;

use crate::cli_run::wire::{AgentEntry, AssistantEntry, RuntimeKind, Subtype};

use super::args::{GlobalArgs, ListArgs, OpenArgs, OutputFormat};
use super::connect::{self, Candidate, CandidateState, Env, Level};
use super::render::{Output, RunRef};
use super::Failure;

fn format(json: bool) -> OutputFormat {
    if json {
        OutputFormat::Json
    } else {
        OutputFormat::Text
    }
}

fn fail(out: &Output, failure: Failure) -> i32 {
    out.failure(&failure, &RunRef::default());
    failure.exit_code()
}

pub async fn agents(global: &GlobalArgs, list: &ListArgs, env: &Env) -> i32 {
    let out = Output::new(format(list.json), global);
    let (conn, _) = match connect::connect(global, env).await {
        Ok(c) => c,
        Err(f) => return fail(&out, f),
    };
    let agents: Vec<AgentEntry> = match conn
        .post("cli_agents", &json!({}), Duration::from_secs(60))
        .await
    {
        Ok(a) => a,
        Err(f) => return fail(&out, f),
    };
    if list.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&agents).expect("serializes")
        );
        return 0;
    }
    let width = agents
        .iter()
        .map(|a| a.slug.len())
        .max()
        .unwrap_or(4)
        .max(4);
    println!(
        "{:width$}  {:8}  {:9}  NAME",
        "SLUG", "ENABLED", "INSTALLED"
    );
    for a in &agents {
        println!(
            "{:width$}  {:8}  {:9}  {}",
            a.slug,
            if a.enabled { "yes" } else { "no" },
            if a.installed { "yes" } else { "no" },
            a.name
        );
    }
    let missing: Vec<&AgentEntry> = agents
        .iter()
        .filter(|a| a.enabled && !a.installed)
        .collect();
    if !missing.is_empty() {
        println!();
        for a in missing {
            if let Some(hint) = &a.install_hint {
                println!("{}: {hint}", a.slug);
            }
        }
    }
    0
}

pub async fn assistants(global: &GlobalArgs, list: &ListArgs, env: &Env) -> i32 {
    let out = Output::new(format(list.json), global);
    let (conn, _) = match connect::connect(global, env).await {
        Ok(c) => c,
        Err(f) => return fail(&out, f),
    };
    let assistants: Vec<AssistantEntry> = match conn
        .post("cli_assistants", &json!({}), Duration::from_secs(60))
        .await
    {
        Ok(a) => a,
        Err(f) => return fail(&out, f),
    };
    if list.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&assistants).expect("serializes")
        );
        return 0;
    }
    if assistants.is_empty() {
        println!("no assistants yet: create one in Codeg → Settings → Assistants");
        return 0;
    }
    let width = assistants
        .iter()
        .map(|a| a.name.len())
        .max()
        .unwrap_or(4)
        .max(4);
    println!(
        "{:>4}  {:width$}  {:12}  DESCRIPTION",
        "ID", "NAME", "AGENT"
    );
    for a in &assistants {
        println!(
            "{:>4}  {:width$}  {:12}  {}",
            a.id, a.name, a.agent, a.description
        );
    }
    0
}

fn candidate_json(c: &Candidate, chosen: bool) -> serde_json::Value {
    json!({
        "source": c.source,
        "state": c.state,
        "chosen": chosen,
        "runtime": c.hello.as_ref().map(|h| h.runtime).or(c.record.as_ref().map(|r| r.runtime)),
        "build": c.hello.as_ref().map(|h| h.build).or(c.record.as_ref().map(|r| r.build)),
        "version": c.hello.as_ref().map(|h| h.version.clone()).or(c.record.as_ref().map(|r| r.version.clone())),
        "pid": c.record.as_ref().map(|r| r.pid),
        "data_dir": c.record.as_ref().map(|r| r.data_dir.clone()),
        "capabilities": c.hello.as_ref().map(|h| h.capabilities.clone()),
        "detail": c.detail,
    })
}

/// One candidate as `status` shows it to a person: `*` marks the one a run
/// would use.
fn candidate_line(c: &Candidate, chosen: bool) -> String {
    let mark = if chosen { "*" } else { " " };
    let what = c
        .hello
        .as_ref()
        .map(|h| format!("{:?} {:?} {}", h.build, h.runtime, h.version))
        .unwrap_or_default();
    format!(
        "{mark} {:13} {} {}{}",
        c.state.name(),
        c.source,
        what,
        c.detail
            .as_deref()
            .map(|d| format!(" — {d}"))
            .unwrap_or_default()
    )
}

/// Every runtime the applicable lookup level offers, what each turned out
/// to be, and which one a run would use. Exit 0 when one would be used.
pub async fn status(global: &GlobalArgs, list: &ListArgs, env: &Env) -> i32 {
    let out = Output::new(format(list.json), global);
    let level = match connect::level(global, env) {
        Ok(l) => l,
        Err(f) => return fail(&out, f),
    };
    let candidates = connect::examine(&level).await;
    let chosen = connect::choose(&level, &candidates, global.runtime);
    let chosen_source = chosen.as_ref().ok().map(|c| c.source.clone());
    if list.json {
        let value = json!({
            "lookup": level.describe(),
            "chosen": chosen_source,
            "candidates": candidates
                .iter()
                .map(|c| candidate_json(c, Some(&c.source) == chosen_source.as_ref()))
                .collect::<Vec<_>>(),
            "error": chosen.as_ref().err().map(|f| f.info()),
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&value).expect("serializes")
        );
        // stdout stays JSON-only; a person reads why on stderr.
        if let Err(f) = &chosen {
            out.stderr_line(&format!("codeg-cli: {}", f.message));
        }
    } else {
        println!("looking at {}", level.describe());
        if candidates.is_empty() {
            println!("  (no discovery files)");
        }
        for c in &candidates {
            println!(
                "{}",
                candidate_line(c, Some(&c.source) == chosen_source.as_ref())
            );
        }
        if let Err(f) = &chosen {
            println!("{}", f.message);
        }
    }
    match chosen {
        Ok(_) => 0,
        Err(f) => f.exit_code(),
    }
}

/// Start the desktop app (if no desktop answers yet) and wait until one does.
pub async fn open(global: &GlobalArgs, args: &OpenArgs, env: &Env) -> i32 {
    let out = Output::new(format(args.json), global);
    // One deadline for all of it: the first look, the opener, the polling.
    let deadline = Instant::now() + args.wait;
    if global.url.is_some() {
        return fail(
            &out,
            Failure::usage(
                "open_takes_no_url",
                "open starts the desktop app on this machine; it takes no --url",
            ),
        );
    }
    // A CODEG_URL in the environment says where runs go by default; it does
    // not stop `open` from looking for the desktop here.
    let local_env = Env {
        url: None,
        ..env.clone()
    };
    let level = match connect::level(global, &local_env) {
        Ok(l) => l,
        Err(f) => return fail(&out, f),
    };
    let desktop_ready = |cs: &[Candidate]| {
        cs.iter().any(|c| {
            c.state == CandidateState::Ready
                && c.hello.as_ref().map(|h| h.runtime) == Some(RuntimeKind::Desktop)
        })
    };
    let pinned = matches!(level, Level::EndpointFile(_));
    let candidates = connect::examine_by(&level, Some(deadline)).await;
    if desktop_ready(&candidates)
        || (pinned && candidates.iter().any(|c| c.state == CandidateState::Ready))
    {
        return report_open(&out, args.json, "already running");
    }
    if let Some(refused) = refused_by_the_os(&candidates, pinned) {
        return fail(&out, refused);
    }
    if pinned {
        // The runtime this terminal belongs to is the only one that counts;
        // another one is not opened in its place.
        return fail(
            &out,
            Failure::new(
                Subtype::ErrorRuntimeUnavailable,
                "runtime_unavailable",
                format!(
                    "the codeg that started this terminal ({}) is not running; open does not \
                     start another one in its place",
                    level.describe()
                ),
            ),
        );
    }
    if let Err(message) = open_url("codeg://open", global.verbose, &out, deadline).await {
        return fail(
            &out,
            Failure::new(Subtype::ErrorRuntimeUnavailable, "open_failed", message),
        );
    }
    loop {
        let candidates = connect::examine_by(&level, Some(deadline)).await;
        if desktop_ready(&candidates) {
            return report_open(&out, args.json, "started");
        }
        if let Some(refused) = refused_by_the_os(&candidates, pinned) {
            return fail(&out, refused);
        }
        if Instant::now() >= deadline {
            return fail(
                &out,
                Failure::new(
                    Subtype::ErrorRuntimeUnavailable,
                    "open_timeout",
                    format!(
                        "no desktop answered within {}s. On Linux this machine may have no \
                         codeg:// handler registered (only codeg-server installed, or an \
                         AppImage that was never started): open the desktop app once by hand.",
                        args.wait.as_secs()
                    ),
                ),
            );
        }
        tokio::time::sleep_until(deadline.min(Instant::now() + Duration::from_millis(500))).await;
    }
}

/// The OS refused the connection to the runtime `open` waits for (a
/// sandbox): opening codeg, or waiting longer, would not let this command
/// reach it. A pinned runtime is that runtime; otherwise only a desktop's
/// refusal counts — a server's port refused says nothing of the desktop's.
fn refused_by_the_os(candidates: &[Candidate], pinned: bool) -> Option<Failure> {
    candidates
        .iter()
        .find(|c| {
            c.state == CandidateState::AccessDenied
                && (pinned
                    || c.record
                        .as_ref()
                        .is_some_and(|r| r.runtime == RuntimeKind::Desktop))
        })
        .map(|denied| connect::access_denied(&denied.source))
}

fn report_open(out: &Output, json: bool, what: &str) -> i32 {
    if json {
        println!("{}", json!({ "status": "ready", "desktop": what }));
    } else {
        out.note(&format!("codeg-cli: the desktop app is {what}"));
    }
    0
}

/// Hand `url` to the system. Its result only reports failures early; whether
/// a desktop came up is decided by polling. An opener still busy at the
/// deadline is left to it (the polling then reports the timeout).
async fn open_url(url: &str, verbose: bool, out: &Output, deadline: Instant) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let opener = tokio::process::Command::new("open")
            .arg(url)
            .stdin(std::process::Stdio::null())
            .output();
        let _ = (verbose, out);
        match tokio::time::timeout_at(deadline, opener).await {
            Err(_) => Ok(()),
            Ok(Err(e)) => Err(format!("cannot run open: {e}")),
            Ok(Ok(done)) if !done.status.success() => Err(format!(
                "no application opens {url}: {}",
                String::from_utf8_lossy(&done.stderr).trim()
            )),
            Ok(Ok(_)) => Ok(()),
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // xdg-open may hand over to another opener and report success before
        // anything refused, or wait on the handler: its status proves nothing
        // either way.
        let opener = tokio::process::Command::new("xdg-open")
            .arg(url)
            .stdin(std::process::Stdio::null())
            .output();
        match tokio::time::timeout_at(deadline, opener).await {
            Err(_) => Ok(()),
            Ok(Err(e)) => Err(format!("cannot run xdg-open: {e}")),
            Ok(Ok(done)) => {
                if verbose {
                    out.stderr_line(&format!(
                        "xdg-open: {} {}",
                        String::from_utf8_lossy(&done.stdout).trim(),
                        String::from_utf8_lossy(&done.stderr).trim()
                    ));
                }
                Ok(())
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = (verbose, out);
        let url = url.to_string();
        let opener = tokio::task::spawn_blocking(move || windows_open(&url));
        match tokio::time::timeout_at(deadline, opener).await {
            Err(_) => Ok(()),
            Ok(Err(e)) => Err(format!("cannot open codeg://open: {e}")),
            Ok(Ok(result)) => result,
        }
    }
}

/// `ShellExecuteExW` with `SEE_MASK_FLAG_NO_UI`: with no handler registered it
/// fails instead of showing the "choose an app" dialog `start` would.
#[cfg(windows)]
fn windows_open(url: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let verb = wide("open");
    let file = wide(url);
    // SAFETY: zeroed SHELLEXECUTEINFOW is a valid "nothing set" value; every
    // pointer set below outlives the call.
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_FLAG_NO_UI;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.nShow = SW_SHOWNORMAL;
    // SAFETY: `info` is fully initialized for this call.
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        return Err(format!(
            "no application opens {url} (error {})",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(state: CandidateState) -> Candidate {
        Candidate {
            source: "/data/cli/endpoint-7.json".into(),
            record: None,
            state,
            detail: None,
            hello: None,
            url: String::new(),
            token: String::new(),
        }
    }

    /// A person reads the same state names `status --json` writes and
    /// docs/cli.md lists: `access_denied`, not `accessdenied`.
    #[test]
    fn status_lines_name_each_state_as_the_json_does() {
        let line = candidate_line(&candidate(CandidateState::AccessDenied), false);
        assert!(
            line.starts_with("  access_denied /data/cli/endpoint-7.json"),
            "{line}"
        );
        let line = candidate_line(&candidate(CandidateState::Ready), true);
        assert!(line.starts_with("* ready         /data"), "{line}");
    }
}
