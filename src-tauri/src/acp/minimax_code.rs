//! MiniMax Code's client-owned MCP overlay. Native login, provider config,
//! skills and session state remain owned by `mcode` and are never rewritten.

use std::path::PathBuf;

/// Codeg's MCP assignments, forwarded through ACP session/new/load. Keeping
/// them outside the CLI data directory also supports per-agent data-dir env
/// overrides without writing into the wrong native profile.
pub(crate) fn mcp_json_path() -> PathBuf {
    crate::paths::codeg_acp_transcripts_root()
        .with_file_name("mcp")
        .join("minimax_code.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimax_mcp_overlay_is_independent_of_native_profile_overrides() {
        let expected = mcp_json_path();
        assert!(expected.ends_with("mcp/minimax_code.json"));
        temp_env::with_vars(
            [
                ("MINIMAX_DATA_DIR", Some("/native/primary")),
                ("MAVIS_DATA_DIR", Some("/native/legacy")),
            ],
            || assert_eq!(mcp_json_path(), expected),
        );
    }
}
