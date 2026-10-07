fn main() {
    fingerprint_helper_sources();
    #[cfg(feature = "tauri-runtime")]
    {
        ensure_sidecar_placeholder();
        place_helper_for_development();
        tauri_build::build();
    }
}

/// A fingerprint of the sources `codeg-computer-helper` is built from,
/// compiled into it and into codeg alike (`CODEG_COMPUTER_SOURCE`). A
/// development codeg refuses a helper whose fingerprint is not its own:
/// `pnpm tauri dev` builds the helper once, as it starts (not at all under
/// `CODEG_SKIP_SIDECAR=1`), and only codeg after that, so a helper left over
/// from before an edit would go on answering with the old code (see
/// `computer::local`). Changes elsewhere in the crate that the helper also
/// compiles in are not seen; they seldom touch it.
///
/// FNV-1a over each file's path and bytes, in path order — the same on every
/// toolchain, which `DefaultHasher` does not promise.
fn fingerprint_helper_sources() {
    use std::path::{Path, PathBuf};

    fn collect(path: &Path, files: &mut Vec<PathBuf>) {
        if path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.flatten() {
                    collect(&entry.path(), files);
                }
            }
        } else if path.is_file() {
            files.push(path.to_path_buf());
        }
    }

    let mut files = Vec::new();
    for source in ["src/computer", "src/bin/codeg_computer_helper.rs"] {
        println!("cargo:rerun-if-changed={source}");
        collect(Path::new(source), &mut files);
    }
    files.sort();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    for file in &files {
        feed(file.to_string_lossy().replace('\\', "/").as_bytes());
        feed(&[0]);
        feed(&std::fs::read(file).unwrap_or_default());
        feed(&[0]);
    }
    println!("cargo:rustc-env=CODEG_COMPUTER_SOURCE={hash:016x}");
}

/// Tauri's bundler validates that every `bundle.externalBin` path resolves
/// to an existing file at build.rs time. The real sidecars — `codeg-mcp` and
/// `codeg-computer-helper` — are produced by `pnpm tauri:prepare-sidecars`
/// (invoked from `beforeBuildCommand` / `beforeDevCommand` and the CI release
/// matrix) — but plain `cargo check --features tauri-runtime` doesn't go
/// through that path, so without a backstop every contributor would hit
/// `resource path ... doesn't exist` on first compile.
///
/// We write a zero-byte placeholder when a sidecar is missing so
/// `cargo check` / clippy / rust-analyzer succeed. Production paths
/// overwrite the placeholder with the real binary before Tauri bundles it:
///   * `pnpm tauri build`  → `beforeBuildCommand` → `prepare-sidecars.mjs`
///   * release.yml         → explicit "Stage sidecars" step
///   * `pnpm tauri dev`    → `beforeDevCommand` → `prepare-sidecars.mjs`
///
/// If you ever bypass those wrappers (e.g. invoking the Tauri CLI directly
/// without beforeBuildCommand) you'd ship the placeholder, so emit a
/// cargo:warning that surfaces in any compile log to make that loud.
#[cfg(feature = "tauri-runtime")]
fn ensure_sidecar_placeholder() {
    use std::fs;
    use std::path::PathBuf;

    let triple = std::env::var("TARGET").unwrap_or_default();
    if triple.is_empty() {
        return;
    }
    let ext = if triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let dir = PathBuf::from("binaries");

    for name in ["codeg-mcp", "codeg-computer-helper"] {
        let path = dir.join(format!("{name}-{triple}{ext}"));

        println!("cargo:rerun-if-changed={}", path.display());

        let needs_placeholder = match fs::metadata(&path) {
            Ok(meta) => meta.len() == 0,
            Err(_) => true,
        };

        if needs_placeholder {
            if let Err(e) = fs::create_dir_all(&dir) {
                panic!("failed to create {}: {e}", dir.display());
            }
            if let Err(e) = fs::write(&path, b"") {
                panic!(
                    "failed to write sidecar placeholder {}: {e}",
                    path.display()
                );
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o755));
            }
            println!(
                "cargo:warning={name} sidecar missing at {}; wrote 0-byte placeholder. \
                 Run `pnpm tauri:prepare-sidecars` before `tauri build` to ship a working binary.",
                path.display()
            );
        }
    }
}

/// On macOS the computer-use helper is no sidecar: a bundle carries it as an
/// app of its own (`tauri.macos.conf.json`), so Tauri no longer copies it
/// next to the build as it does `bundle.externalBin`. This does, for a
/// development codeg, which is not bundled and looks for the helper beside
/// itself. The staged file is already watched by `ensure_sidecar_placeholder`.
#[cfg(feature = "tauri-runtime")]
fn place_helper_for_development() {
    use std::path::PathBuf;

    let triple = std::env::var("TARGET").unwrap_or_default();
    if !triple.contains("apple-darwin") {
        return;
    }
    let staged = PathBuf::from(format!("binaries/codeg-computer-helper-{triple}"));
    // `target/[<triple>/]<profile>/build/<pkg>-<hash>/out`, as tauri-build
    // finds the same directory: there is no other way to it from here.
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").unwrap_or_default());
    let Some(profile_dir) = out_dir.ancestors().nth(3) else {
        return;
    };
    let placed = profile_dir.join("codeg-computer-helper");
    // Through a new file renamed into place: a helper still running from the
    // old one keeps its own, where writing over it would kill it.
    let incoming = profile_dir.join("codeg-computer-helper.incoming");
    if let Err(e) =
        std::fs::copy(&staged, &incoming).and_then(|_| std::fs::rename(&incoming, &placed))
    {
        let _ = std::fs::remove_file(&incoming);
        println!(
            "cargo:warning=could not place {} at {}: {e}",
            staged.display(),
            placed.display()
        );
    }
}
