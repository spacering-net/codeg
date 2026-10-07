// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// rustc's asynchronous unwind tables keep most functions out of Apple's
// compact unwind format, so an unoptimized build of this binary carries more
// `__eh_frame` than the 16 MB ld can index, and every dev link on macOS warns
// "__eh_frame section too large". The only cost is slower unwinding in debug
// builds. Release builds stay far below the limit, so linker messages remain
// on there. Drop this once rustc files the message as informational
// (rust-lang/rust#159105).
#![cfg_attr(debug_assertions, allow(linker_messages))]

fn main() {
    // When called as a git credential helper, handle it immediately and exit.
    // This avoids starting the full Tauri GUI runtime.
    if std::env::args().any(|a| a == "--credential-helper") {
        // Subprocess mode, before the desktop logging init in `run()`: install a
        // stderr-only subscriber so helper diagnostics aren't dropped, while
        // stdout stays the git credential protocol channel.
        let _log_guard = codeg_lib::logging::init::init_stderr_only();
        codeg_lib::git_credential::run_credential_helper();
        return;
    }

    codeg_lib::run()
}
