use std::{fs, io::Write, path::Path};

use chrono::{DateTime, Utc};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::db::service::folder_service;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Note,
    Plan,
}

impl Kind {
    fn location(self) -> (&'static str, &'static str) {
        match self {
            Self::Note => ("notes", "txt"),
            Self::Plan => ("plans", "md"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    List {
        kind: Kind,
        query: Option<String>,
        offset: Option<usize>,
    },
    Read {
        kind: Kind,
        id: Uuid,
    },
    Save {
        kind: Kind,
        id: Option<Uuid>,
        title: Option<String>,
        body: String,
        expected: Option<String>,
    },
    Delete {
        kind: Kind,
        id: Uuid,
        expected: Option<String>,
    },
}

pub async fn run(
    db: &DatabaseConnection,
    data_dir: &Path,
    folder_id: i32,
    request: Request,
) -> Result<Value, String> {
    let folder = folder_service::get_folder_by_id(db, folder_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or("Project folder no longer exists")?;
    if folder.kind != crate::db::entities::folder::FolderKind::Regular {
        return Err("This conversation has no project folder".into());
    }
    let project_id = folder.parent_id.unwrap_or(folder.id);
    if project_id != folder.id {
        folder_service::get_folder_by_id(db, project_id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or("Project folder no longer exists")?;
    }
    let root = data_dir
        .join("project-knowledge")
        .join(project_id.to_string());
    tokio::task::spawn_blocking(move || execute(&root, request))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

fn execute(root: &Path, request: Request) -> std::io::Result<Value> {
    let kind = match &request {
        Request::List { kind, .. }
        | Request::Read { kind, .. }
        | Request::Save { kind, .. }
        | Request::Delete { kind, .. } => *kind,
    };
    let (name, extension) = kind.location();
    let directory = root.join(name);
    let file = |id: Uuid| directory.join(format!("{id}.{extension}"));
    let invalid = |message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message);
    match request {
        Request::List { query, offset, .. } => {
            let files = match fs::read_dir(&directory) {
                Ok(files) => files,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(json!({ "entries": [], "nextOffset": null }));
                }
                Err(error) => return Err(error),
            };
            let query = query.unwrap_or_default().trim().to_lowercase();
            let mut entries = Vec::new();
            for item in files {
                let item = item?;
                let path = item.path();
                if !item.file_type()?.is_file()
                    || path.extension().and_then(|e| e.to_str()) != Some(extension)
                {
                    continue;
                }
                let Some(id) = path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .and_then(|stem| Uuid::parse_str(stem).ok())
                else {
                    continue;
                };
                let (body, updated) = match read(&path) {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error),
                };
                if query.is_empty() || body.to_lowercase().contains(&query) {
                    entries.push((
                        id,
                        updated,
                        title(&body, kind).chars().take(160).collect::<String>(),
                    ));
                }
            }
            entries.sort_unstable_by_key(|(id, updated, _)| (std::cmp::Reverse(*updated), *id));
            let offset = offset.unwrap_or_default();
            let next = offset.saturating_add(50);
            let next_offset = (next < entries.len()).then_some(next);
            let entries: Vec<_> = entries.into_iter().skip(offset).take(50)
                .map(|(id, updated, title)| json!({ "id": id, "title": title, "updatedAt": updated }))
                .collect();
            Ok(json!({ "entries": entries, "nextOffset": next_offset }))
        }
        Request::Read { id, .. } => entry(&file(id), kind, id),
        Request::Save {
            id,
            title: requested_title,
            body,
            expected,
            ..
        } => {
            let body = match requested_title {
                Some(requested_title) => {
                    let requested_title = requested_title.trim();
                    if requested_title.is_empty()
                        || requested_title.contains(['\r', '\n'])
                        || requested_title.chars().count() > 160
                    {
                        return Err(invalid(
                            "Title must be one non-empty line of at most 160 characters",
                        ));
                    }
                    body_with_title(kind, requested_title, &body, expected.as_deref())
                }
                None => body,
            };
            if body.trim().is_empty() || body.len() > 128 * 1024 {
                return Err(invalid("Content must be non-empty and at most 128 KiB"));
            }
            let _guard = lock_project(root)?;
            let entry_id = id.unwrap_or_else(Uuid::new_v4);
            let path = file(entry_id);
            if id.is_some() {
                check_expected(&path, expected.as_deref())?;
            }
            fs::create_dir_all(&directory)?;
            let mut temp = tempfile::NamedTempFile::new_in(&directory)?;
            temp.write_all(body.as_bytes())?;
            temp.as_file().sync_all()?;
            temp.persist(&path).map_err(|error| error.error)?;
            entry(&path, kind, entry_id)
        }
        Request::Delete { id, expected, .. } => {
            let _guard = lock_project(root)?;
            let path = file(id);
            check_expected(&path, expected.as_deref())?;
            fs::remove_file(path)?;
            Ok(json!({ "deleted": true }))
        }
    }
}

fn lock_project(root: &Path) -> std::io::Result<fs::File> {
    fs::create_dir_all(root)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(".lock"))?;
    lock.lock()?;
    Ok(lock)
}

fn read(path: &Path) -> std::io::Result<(String, DateTime<Utc>)> {
    use std::io::Read;
    let file = fs::File::open(path)?;
    let updated = file.metadata()?.modified()?.into();
    let mut body = String::new();
    file.take(128 * 1024 + 1).read_to_string(&mut body)?;
    if body.len() > 128 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Project knowledge is larger than 128 KiB",
        ));
    }
    Ok((body, updated))
}

fn body_with_title(kind: Kind, title: &str, body: &str, expected: Option<&str>) -> String {
    let prefix = if kind == Kind::Plan { "# " } else { "" };
    let heading = format!("{prefix}{title}");
    let (first, rest) = body
        .trim_start()
        .split_once('\n')
        .unwrap_or((body.trim_start(), ""));
    let has_previous_heading = expected.is_some_and(|previous| {
        let previous_first = previous.trim_start().lines().next().unwrap_or("");
        previous_first.trim() == first.trim() && previous_first.trim().starts_with(prefix)
    });
    let content = if first.trim() == heading || has_previous_heading {
        rest.strip_prefix("\r\n")
            .or_else(|| rest.strip_prefix('\n'))
            .unwrap_or(rest)
    } else {
        body
    };
    if content.trim().is_empty() {
        heading
    } else {
        format!("{heading}\n\n{content}")
    }
}

fn title(body: &str, kind: Kind) -> &str {
    let first = body
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim();
    if kind == Kind::Plan {
        first.strip_prefix("# ").unwrap_or(first)
    } else {
        first
    }
}

fn entry(path: &Path, kind: Kind, id: Uuid) -> std::io::Result<Value> {
    let (body, updated) = read(path)?;
    Ok(json!({ "id": id, "title": title(&body, kind), "body": body, "updatedAt": updated }))
}

fn check_expected(path: &Path, expected: Option<&str>) -> std::io::Result<()> {
    let (body, _) = read(path)?;
    if expected.is_some_and(|expected| expected != body) {
        return Err(std::io::Error::other(
            "This entry changed. Read the latest version before editing.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_titles_are_shared_by_save_read_and_list() {
        let directory = tempfile::tempdir().unwrap();
        for (kind, initial_body, renamed_body) in [
            (
                "note",
                "Recovery\n\nKeep the existing draft.",
                "Recovery checks\n\nKeep the existing draft.",
            ),
            (
                "plan",
                "# Recovery\n\nKeep the existing draft.",
                "# Recovery checks\n\nKeep the existing draft.",
            ),
        ] {
            let save = |arguments| {
                execute(directory.path(), serde_json::from_value(arguments).unwrap()).unwrap()
            };
            let entry = save(json!({
                "action": "save", "kind": kind, "title": "Recovery",
                "body": "Keep the existing draft."
            }));
            assert_eq!(entry["title"], "Recovery");
            assert_eq!(entry["body"], initial_body);

            let entry = save(json!({
                "action": "save", "kind": kind, "id": entry["id"],
                "title": "Recovery checks", "body": entry["body"], "expected": entry["body"]
            }));
            let read = save(json!({ "action": "read", "kind": kind, "id": entry["id"] }));
            assert_eq!(read["title"], "Recovery checks");
            assert_eq!(read["body"], renamed_body);

            let list = save(json!({ "action": "list", "kind": kind, "query": "Recovery checks" }));
            assert_eq!(list["entries"][0]["title"], "Recovery checks");
        }
    }

    #[test]
    fn plan_is_a_markdown_file_and_stale_edits_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("1");
        let second = directory.path().join("2");
        let body = "# Release plan\n\n- [ ] Verify offline recovery";
        let saved = execute(
            &first,
            Request::Save {
                kind: Kind::Plan,
                id: None,
                title: None,
                body: body.into(),
                expected: None,
            },
        )
        .unwrap();
        let id = saved["id"].as_str().unwrap().parse().unwrap();
        let file = first.join("plans").join(format!("{id}.md"));
        assert_eq!(fs::read_to_string(&file).unwrap(), body);
        assert!(execute(
            &second,
            Request::Read {
                kind: Kind::Plan,
                id
            }
        )
        .is_err());
        assert!(execute(
            &first,
            Request::Delete {
                kind: Kind::Plan,
                id,
                expected: Some("stale".into()),
            }
        )
        .is_err());
        execute(
            &first,
            Request::Delete {
                kind: Kind::Plan,
                id,
                expected: Some(body.into()),
            },
        )
        .unwrap();
        assert!(!file.exists());
    }
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn project_knowledge(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::AppDatabase>,
    folder_id: i32,
    request: Request,
) -> Result<Value, crate::app_error::AppCommandError> {
    use tauri::Manager;
    let fallback = app
        .path()
        .app_data_dir()
        .map_err(|error| crate::app_error::AppCommandError::invalid_input(error.to_string()))?;
    run(
        &db.conn,
        &crate::paths::resolve_effective_data_dir(&fallback),
        folder_id,
        request,
    )
    .await
    .map_err(crate::app_error::AppCommandError::invalid_input)
}
