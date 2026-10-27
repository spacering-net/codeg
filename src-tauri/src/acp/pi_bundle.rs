//! Fixed-source Pi ACP adapter, independent of global/custom adapter installs.
use sha2::{Digest, Sha256};
use std::path::PathBuf;

use super::error::AcpError;

pub const NODE_MIN: &str = "22.19.0";
const MANIFEST: &str = include_str!("pi-bundle/manifest.json");
const FILES: &[(&str, &[u8])] = &[
    ("adapter.mjs", include_bytes!("pi-bundle/adapter.mjs")),
    ("mcp-bridge.mjs", include_bytes!("pi-bundle/mcp-bridge.mjs")),
    ("LICENSE", include_bytes!("pi-bundle/LICENSE")),
    (
        "THIRD_PARTY_NOTICES",
        include_bytes!("pi-bundle/THIRD_PARTY_NOTICES"),
    ),
];

pub async fn node() -> Result<PathBuf, AcpError> {
    let node = crate::commands::acp::resolve_npx_command_for(crate::models::AgentType::Pi, "node")
        .await
        .ok_or_else(|| {
            AcpError::SdkNotInstalled(format!("Pi requires Node.js {NODE_MIN} or newer"))
        })?;
    let mut command = tokio::process::Command::new(&node);
    command.arg("--version").kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), command.output())
        .await
        .map_err(|_| AcpError::SpawnFailed("Node.js version check timed out".into()))?
        .map_err(|e| AcpError::SpawnFailed(e.to_string()))?;
    let version = String::from_utf8_lossy(&output.stdout);
    if !output.status.success()
        || semver::Version::parse(version.trim().trim_start_matches('v'))
            .ok()
            .is_none_or(|v| v < semver::Version::new(22, 19, 0))
    {
        return Err(AcpError::SdkNotInstalled(format!(
            "Pi requires Node.js {NODE_MIN} or newer"
        )));
    }
    Ok(node)
}

pub fn prepare() -> Result<PathBuf, AcpError> {
    let manifest: serde_json::Value =
        serde_json::from_str(MANIFEST).map_err(|e| AcpError::protocol(e.to_string()))?;
    let identity = format!("{:x}", Sha256::digest(MANIFEST.as_bytes()));
    let root = crate::acp::binary_cache::cache_dir()?
        .join("pi-bundled")
        .join(identity);
    std::fs::create_dir_all(&root).map_err(|e| AcpError::SpawnFailed(e.to_string()))?;
    for (name, bytes) in FILES {
        let digest = format!("{:x}", Sha256::digest(bytes));
        if manifest["sha256"][name] != digest {
            return Err(AcpError::protocol("Bundled Pi adapter digest mismatch"));
        }
        let path = root.join(name);
        if std::fs::read(&path)
            .ok()
            .is_some_and(|existing| existing == *bytes)
        {
            continue;
        }
        let temporary = root.join(format!("{name}.{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&temporary, bytes).map_err(|e| AcpError::SpawnFailed(e.to_string()))?;
        if let Err(error) = std::fs::rename(&temporary, &path) {
            let _ = std::fs::remove_file(&temporary);
            // Another launch can have installed identical immutable bytes.
            if !std::fs::read(&path)
                .ok()
                .is_some_and(|existing| existing == *bytes)
            {
                return Err(AcpError::SpawnFailed(error.to_string()));
            }
        }
    }
    Ok(root.join("adapter.mjs"))
}
