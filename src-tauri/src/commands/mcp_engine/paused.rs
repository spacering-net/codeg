//! Definitions removed from agent files by Codeg's soft disable switch.

use std::collections::BTreeMap;
use std::io;
use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::commands::mcp::McpAppType;

use super::fsio;
use super::model::{codes, McpDefinition, McpIssue};

const VERSION: u32 = 1;
pub(super) const FILE_NAME: &str = "mcp-paused.json";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(super) struct PausedEntry {
    pub definition: McpDefinition,
    pub paused_at: DateTime<Utc>,
    /// Native settings such as Cursor's `envFile` must survive a round trip.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

pub(super) type PausedEntries = BTreeMap<String, PausedEntry>;

#[derive(Deserialize, Serialize)]
struct Document {
    version: u32,
    entries: BTreeMap<McpAppType, PausedEntries>,
}

pub(super) struct PausedFile {
    document: Document,
    pub bytes: Option<Vec<u8>>,
}

impl PausedFile {
    pub fn read(path: &Path) -> io::Result<Self> {
        let bytes = fsio::read_bytes(path)?;
        let document = match &bytes {
            Some(bytes) => serde_json::from_slice::<Document>(bytes)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?,
            None => Document {
                version: VERSION,
                entries: BTreeMap::new(),
            },
        };
        if document.version != VERSION {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Unsupported MCP paused file version",
            ));
        }
        Ok(Self { document, bytes })
    }

    pub fn entries(&self, agent: McpAppType) -> Option<&PausedEntries> {
        self.document.entries.get(&agent)
    }

    /// Stage this agent's changes atop the shared document. The next agent
    /// stages against these same bytes so a batch cannot lose either edit.
    pub fn stage(&mut self, agent: McpAppType, entries: PausedEntries) -> io::Result<Vec<u8>> {
        if entries.is_empty() {
            self.document.entries.remove(&agent);
        } else {
            self.document.entries.insert(agent, entries);
        }
        let mut bytes = serde_json::to_vec_pretty(&self.document).map_err(io::Error::other)?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}

/// Keep the original basis for agents without paused entries. Otherwise
/// include only this agent's portion of the store in its concurrency token.
pub(super) fn basis(native: &str, entries: Option<&PausedEntries>) -> String {
    match entries.filter(|entries| !entries.is_empty()) {
        Some(entries) => fsio::sha256_hex(
            &serde_json::to_vec(&(native, entries)).expect("paused entries are JSON values"),
        ),
        None => native.to_owned(),
    }
}

pub(super) fn read_issue(path: &Path, error: &io::Error) -> McpIssue {
    McpIssue::new(codes::RELATED_FILE_UNREADABLE)
        .field(&path.display().to_string())
        .detail(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_unknown_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fsio::write_atomic(&path, br#"{"version":2,"entries":{}}"#).unwrap();
        assert_eq!(
            PausedFile::read(&path).err().unwrap().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
