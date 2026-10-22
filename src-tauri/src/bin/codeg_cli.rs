//! `codeg-cli`: run a prompt through a running codeg from a script or CI.
//! Everything is in `codeg_lib::cli`; see `docs/cli.md`.

fn main() -> std::process::ExitCode {
    codeg_lib::cli::main()
}
