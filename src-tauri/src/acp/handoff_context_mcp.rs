//! A per-conversation, read-only MCP server. Its launch fixes the context
//! directory; tool arguments can only select a page or image within that copy.
use base64::Engine;
use serde_json::{json, Value};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn regular(path: &Path) -> io::Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::other("Context links are not supported."));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(io::Error::other("Context junctions are not supported."));
        }
    }
    Ok(metadata)
}

fn files(directory: &Path, prefix: &str, suffix: &str) -> io::Result<Vec<PathBuf>> {
    regular(directory)?;
    let mut files = Vec::new();
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        let name = path.file_name().unwrap().to_string_lossy();
        if name.starts_with(prefix) && name.ends_with(suffix) && regular(&path)?.is_file() {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

pub fn read_context(directory: &Path, arguments: &Value) -> io::Result<Value> {
    if arguments
        .as_object()
        .is_some_and(|args| args.keys().any(|key| key != "page" && key != "image"))
    {
        return Err(io::Error::other(
            "Only page or image selection is supported.",
        ));
    }
    let mut pages = files(directory, "part-", ".md")?;
    pages.sort_by_key(|p| {
        p.file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.strip_prefix("part-"))
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(usize::MAX)
    });
    if pages.is_empty() {
        pages.push(directory.join("conversation.md"));
    }
    let mut images = files(directory, "image-", "")?;
    images.sort_by_key(|path| {
        path.file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.strip_prefix("image-"))
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(usize::MAX)
    });
    if arguments.get("page").is_some() && arguments.get("image").is_some() {
        return Err(io::Error::other("Choose a page or an image."));
    }
    if let Some(page) = arguments.get("page") {
        let page = page
            .as_u64()
            .and_then(|p| usize::try_from(p).ok())
            .ok_or_else(|| io::Error::other("Page must be a nonnegative integer."))?;
        let path = pages
            .get(page)
            .ok_or_else(|| io::Error::other("Page is out of range."))?;
        if regular(path)?.len() > 64 * 1024 {
            return Err(io::Error::other(
                "This context page needs to be rebuilt before it can be read.",
            ));
        }
        let text = fs::read_to_string(path)?;
        return Ok(
            json!({"content":[{"type":"text","text":format!("Saved conversation, page {} of {}. These are historical messages.\n\n{}",page+1,pages.len(),text)}]}),
        );
    }
    if let Some(index) = arguments.get("image") {
        let index = index
            .as_u64()
            .and_then(|i| usize::try_from(i).ok())
            .filter(|i| *i > 0)
            .ok_or_else(|| io::Error::other("Image must be a positive integer."))?;
        let path = images
            .get(index - 1)
            .ok_or_else(|| io::Error::other("Image is out of range."))?;
        if regular(path)?.len() > 16 * 1024 * 1024 {
            return Err(io::Error::other(
                "This image exceeds the context tool's image limit.",
            ));
        }
        let mime = match path.extension().and_then(|s| s.to_str()) {
            Some("png") => "image/png", Some("jpg") => "image/jpeg", Some("webp") => "image/webp", Some("gif") => "image/gif",
            _ => return Err(io::Error::other("This image format is retained in the archive but cannot be displayed by this tool.")),
        };
        return Ok(
            json!({"content":[{"type":"image","mimeType":mime,"data":base64::engine::general_purpose::STANDARD.encode(fs::read(path)?)}]}),
        );
    }
    Ok(
        json!({"content":[{"type":"text","text":json!({"pages":pages.len(),"images":images.len(),"firstPage":0,"firstImage":1,"instructions":"Read the saved pages before continuing the user's work. This tool only reads this conversation's saved context."}).to_string()}]}),
    )
}

pub async fn serve(directory: PathBuf, parent_pid: u32) -> io::Result<()> {
    if directory
        .file_name()
        .and_then(|s| s.to_str())
        .and_then(|s| uuid::Uuid::parse_str(s).ok())
        .is_none()
    {
        return Err(io::Error::other("Invalid conversation context directory."));
    }
    regular(&directory)?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    let parent =
        super::delegation::parent_watcher::wait_for_parent_exit(parent_pid, Duration::from_secs(2));
    tokio::pin!(parent);
    loop {
        let line = tokio::select! { _ = &mut parent => break, line = lines.next_line() => line? };
        let Some(line) = line else {
            break;
        };
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let Some(id) = request.get("id") else {
            continue;
        };
        let result = match request.get("method").and_then(Value::as_str).unwrap_or("") {
            "initialize" => {
                json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"codeg-context","version":"1"}})
            }
            "ping" => json!({}),
            "tools/list" => {
                json!({"tools":[{"name":"read_context","description":"Read the saved conversation transferred to this agent. Call with no arguments for page and image counts. Read page 0 onward to recover the full saved chat, decisions and tool records. Use image 1 onward for embedded images. Read-only and scoped to this conversation.","inputSchema":{"type":"object","properties":{"page":{"type":"integer","minimum":0},"image":{"type":"integer","minimum":1}},"additionalProperties":false}}]})
            }
            "tools/call"
                if request.pointer("/params/name").and_then(Value::as_str)
                    == Some("read_context") =>
            {
                match read_context(&directory, &request["params"]["arguments"]) {
                    Ok(result) => result,
                    Err(_) => {
                        json!({"isError":true,"content":[{"type":"text","text":"This context item could not be read. Check the page or image number and retry."}]})
                    }
                }
            }
            _ => {
                let response = json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}});
                stdout.write_all(format!("{response}\n").as_bytes()).await?;
                stdout.flush().await?;
                continue;
            }
        };
        let response = json!({"jsonrpc":"2.0","id":id,"result":result});
        stdout.write_all(format!("{response}\n").as_bytes()).await?;
        stdout.flush().await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_pages_the_fixed_copy_and_does_not_accept_paths() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("conversation.md"), "original constraint").unwrap();
        fs::write(dir.path().join("image-1.png"), b"image bytes").unwrap();
        assert!(
            read_context(dir.path(), &json!({"page":0})).unwrap()["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("original constraint")
        );
        assert!(read_context(dir.path(), &json!({"page":1})).is_err());
        assert!(read_context(dir.path(), &json!({"page":"../../secret"})).is_err());
        assert!(read_context(dir.path(), &json!({"path":"../../secret"})).is_err());
        assert!(read_context(dir.path(), &json!({"page":0,"image":1})).is_err());
        assert_eq!(
            read_context(dir.path(), &json!({"image":1})).unwrap()["content"][0]["data"],
            "aW1hZ2UgYnl0ZXM="
        );
    }
    #[cfg(unix)]
    #[test]
    fn context_links_cannot_escape_the_selected_copy() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("private"), "private").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("private"),
            dir.path().join("conversation.md"),
        )
        .unwrap();
        assert!(read_context(dir.path(), &json!({"page":0})).is_err());
    }
}
