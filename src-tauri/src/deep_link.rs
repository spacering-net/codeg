//! OS-level `codeg://` URL scheme.
//!
//! In-app markdown already uses `codeg://session/<id>` and `codeg://agent/<type>`
//! as reference links. Those stay in-process badges. This module is the
//! **system** handler: a click in another app, `open codeg://…`, or a browser
//! custom-scheme navigation should bring the desktop workspace forward and
//! focus the named conversation, or open the named Harness item.
//!
//! Supported forms:
//!
//! - `codeg://session/<id>` — Codeg's numeric conversation PK, or an agent's
//!   `external_id` (Grok UUID, Codex thread id, …)
//! - `codeg://workspace?conversationId=<id>` — same lookup; `folderId` and
//!   `agent` are optional and filled from the row when omitted
//! - `codeg://harness/install?ref=<publisher>/<name>` — the SpaceRing
//!   website's "Open in Codeg": that item on the Harness page's Discover
//!   section. It only ever opens; installing is the user's decision, made in
//!   Codeg. Any other `codeg://harness` link, and a `ref` that is not an
//!   item's address, is `codeg://open`
//! - `codeg://open` / `codeg://` — just show the main window
//!
//! `codeg://agent/…`, `codeg://commit/…`, and `codeg://embedded/…` are
//! in-app mention badges, not OS navigation, and are ignored here.

use crate::db::service::conversation_service;
use crate::db::AppDatabase;
use crate::models::DbConversationSummary;

/// What a parsed `codeg://` URL wants the desktop app to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLink {
    /// Bring the workspace forward without targeting a conversation.
    Open,
    /// Focus a conversation looked up by `codeg://session/<ref>`.
    Session { session_ref: String },
    /// Explicit workspace query. `conversation_id` is required; folder and
    /// agent are filled from the database when omitted.
    Workspace {
        folder_id: Option<i32>,
        conversation_id: i32,
        agent: Option<String>,
    },
    /// Open a Harness item: `codeg://harness/install?ref=<publisher>/<name>`.
    /// `item_ref` has been checked, and is in its canonical lower-case form.
    Harness { item_ref: String },
}

/// A `codeg://` link resolved to a conversation the workspace can open.
///
/// Serializes as the payload of [`take_pending_deep_link`], in the same
/// camelCase shape as the `workspace://focus-conversation` event so both
/// arrive at `PetFocusBridge` looking alike.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusTarget {
    pub folder_id: i32,
    pub conversation_id: i32,
    pub agent: String,
}

impl FocusTarget {
    /// Path the main window should load on a cold start so
    /// `DeepLinkBootstrap` can open the tab after hydration.
    pub fn workspace_path(&self) -> String {
        format!(
            "workspace?folderId={}&conversationId={}&agent={}",
            self.folder_id,
            self.conversation_id,
            urlencoding::encode(&self.agent)
        )
    }

    fn from_summary(summary: DbConversationSummary) -> Self {
        Self {
            folder_id: summary.folder_id,
            conversation_id: summary.id,
            agent: summary.agent_type.as_wire().into_owned(),
        }
    }
}

/// Parse a `codeg:` / `codeg://` URL. Returns `None` for a different scheme
/// or for in-app mention badges that must not navigate the workspace.
pub fn parse_deep_link(raw: &str) -> Option<DeepLink> {
    let raw = raw.trim();
    let rest = raw
        .strip_prefix("codeg://")
        .or_else(|| raw.strip_prefix("codeg:"))?;
    let rest = rest.trim_start_matches('/');
    if rest.is_empty() {
        return Some(DeepLink::Open);
    }

    let (path, query) = split_path_query(rest);
    let path = path.trim_end_matches('/');
    if path.is_empty() || path.eq_ignore_ascii_case("open") {
        return Some(DeepLink::Open);
    }
    if path.eq_ignore_ascii_case("workspace") {
        return parse_workspace_query(query.unwrap_or(""));
    }
    // `session` is the URL's host component, which the `url` crate lower-cases
    // before we ever see it — but an argv-delivered link on Windows/Linux keeps
    // whatever case the caller typed, so match the segment case-insensitively
    // like `open`/`workspace` above. The ref itself stays case-sensitive: an
    // agent's `external_id` is an opaque, case-significant token.
    if let Some((head, session_ref)) = path.split_once('/') {
        if head.eq_ignore_ascii_case("session") {
            return parse_session_ref(session_ref);
        }
    }
    // A host component too, so matched the same way.
    let (head, action) = path.split_once('/').unwrap_or((path, ""));
    if head.eq_ignore_ascii_case("harness") {
        return Some(parse_harness_link(action, query.unwrap_or("")));
    }
    None
}

fn split_path_query(rest: &str) -> (&str, Option<&str>) {
    let without_fragment = rest.split('#').next().unwrap_or(rest);
    match without_fragment.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (without_fragment, None),
    }
}

fn parse_session_ref(raw: &str) -> Option<DeepLink> {
    let decoded = percent_decode(raw);
    let decoded = decoded.trim();
    if decoded.is_empty() || decoded.contains('/') || decoded.contains('\\') {
        return None;
    }
    if decoded.len() > 256 {
        return None;
    }
    Some(DeepLink::Session {
        session_ref: decoded.to_string(),
    })
}

fn parse_workspace_query(query: &str) -> Option<DeepLink> {
    let mut folder_id = None;
    let mut conversation_id = None;
    let mut agent = None;
    for pair in query.split('&') {
        let (key, value) = match pair.split_once('=') {
            Some(parts) => parts,
            None => continue,
        };
        let value = percent_decode(value);
        match key {
            "folderId" | "folder_id" => {
                folder_id = value.parse::<i32>().ok().filter(|id| *id > 0);
            }
            "conversationId" | "conversation_id" => {
                conversation_id = value.parse::<i32>().ok().filter(|id| *id > 0);
            }
            "agent" => {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    agent = Some(trimmed.to_string());
                }
            }
            _ => {}
        }
    }
    Some(DeepLink::Workspace {
        folder_id,
        conversation_id: conversation_id?,
        agent,
    })
}

fn percent_decode(raw: &str) -> String {
    match urlencoding::decode(raw) {
        Ok(decoded) => decoded.into_owned(),
        Err(_) => raw.to_string(),
    }
}

/// `harness/<action>?<query>`. The one action is `install`, whose `ref` is read
/// the way `URLSearchParams` reads it — the first `ref`, `+` as a space,
/// percent-escapes decoded — as the Web address's `?harness=` is read. Every
/// other parameter is ignored.
///
/// Anything else sent to the Harness — another action, no `ref`, a `ref` that
/// is not an item's address — is [`DeepLink::Open`]: the link was meant for
/// Codeg, so the workspace comes forward, and nothing more.
fn parse_harness_link(action: &str, query: &str) -> DeepLink {
    if !action.eq_ignore_ascii_case("install") {
        return DeepLink::Open;
    }
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "ref")
        .and_then(|(_, value)| parse_item_ref(&value))
        .map_or(DeepLink::Open, |item_ref| DeepLink::Harness { item_ref })
}

/// An item's address as `parseItemRef` (`src/lib/harness/item-ref.ts`) reads
/// it, taking and refusing exactly what it does: surrounding space trimmed as
/// JavaScript's `trim` trims it, lower-cased, then the catalog's own rules
/// ([`ItemRef::parse`](crate::harness::ItemRef::parse)) — publisher
/// `[a-z0-9][a-z0-9.-]{0,252}`, name `[a-z0-9-]{1,64}`, which also cap the
/// length. Returns the canonical `publisher/name`.
///
/// `str::to_lowercase` and JavaScript's `toLowerCase` both apply Unicode's
/// full default mapping, so they agree on everything that comes out in
/// `[a-z]`: the ASCII capitals, and the Kelvin sign, which becomes `k`.
fn parse_item_ref(input: &str) -> Option<String> {
    let text = input.trim_matches(is_js_trim_space).to_lowercase();
    crate::harness::ItemRef::parse(&text)
        .ok()
        .map(|item_ref| item_ref.to_string())
}

/// What JavaScript's `String.prototype.trim` strips: Unicode `White_Space`,
/// which `char::is_whitespace` tests, less U+0085 (NEL) and plus U+FEFF (the
/// byte-order mark).
fn is_js_trim_space(c: char) -> bool {
    c == '\u{feff}' || (c != '\u{85}' && c.is_whitespace())
}

/// Path the main window loads on a Windows/Linux cold start for a Harness
/// link: the Web address, `/workspace?harness=<ref>`, which
/// `HarnessLinkBootstrap` reads.
fn harness_workspace_path(item_ref: &str) -> String {
    format!("workspace?harness={}", urlencoding::encode(item_ref))
}

/// Look a parsed link up in the live conversation table.
pub async fn resolve_deep_link(
    db: &AppDatabase,
    link: &DeepLink,
) -> Result<Option<FocusTarget>, crate::db::error::DbError> {
    match link {
        // Neither names a conversation. A Harness link needs no lookup: its
        // callers park it, or point the startup path at it, as it is.
        DeepLink::Open | DeepLink::Harness { .. } => Ok(None),
        DeepLink::Session { session_ref } => {
            let summary =
                conversation_service::find_live_by_session_ref(&db.conn, session_ref).await?;
            Ok(summary.map(FocusTarget::from_summary))
        }
        DeepLink::Workspace {
            folder_id,
            conversation_id,
            agent,
        } => {
            let Some(summary) =
                conversation_service::find_live_by_session_ref(&db.conn, &conversation_id.to_string())
                    .await?
            else {
                return Ok(None);
            };
            if folder_id.is_some_and(|id| id != summary.folder_id) {
                return Ok(None);
            }
            if agent.as_ref().is_some_and(|wanted| {
                wanted != summary.agent_type.as_wire().as_ref()
            }) {
                return Ok(None);
            }
            Ok(Some(FocusTarget::from_summary(summary)))
        }
    }
}

/// Nudge telling the workspace that a deep link is waiting in
/// [`PENDING_FOCUS`] or [`PENDING_HARNESS_LINK`]. Deliberately carries no
/// payload — see [`PENDING_FOCUS`].
#[cfg(feature = "tauri-runtime")]
pub const PENDING_EVENT: &str = "workspace://deep-link-pending";

/// The one channel a resolved conversation target travels on. (A Harness item
/// has [`PENDING_HARNESS_LINK`], on the same terms.)
///
/// The obvious design — emit the target like the pet panel does — cannot work
/// here, in both directions. An emit reaches only webviews that *already*
/// registered a JS listener (Tauri's `emit_js_filter` skips the rest and
/// queues nothing), so a cold-start link is dropped: on macOS the launch URL
/// arrives as `RunEvent::Opened` after the setup hook, long before React
/// mounts `PetFocusBridge`. And an emitted target that is *also* parked can be
/// consumed twice — once from the payload, once from the slot — or linger and
/// re-open on a later mount.
///
/// So the target is only ever handed over by [`take_pending_deep_link`], which
/// is an atomic take: the mount-time drain and every nudge-driven drain
/// compete for one slot and exactly one of them wins. [`PENDING_EVENT`] is a
/// bare "come and get it" — dropping it during boot costs nothing because the
/// mount drain follows.
///
/// A single slot means a launch carrying several URLs focuses the last one
/// the frontend gets to, which is all a focus operation can mean anyway.
static PENDING_FOCUS: std::sync::Mutex<Option<FocusTarget>> = std::sync::Mutex::new(None);

/// Only the desktop URL handler parks targets; `codeg-server` compiles the
/// parser and the lookup but has no OS scheme to feed them.
#[cfg(any(feature = "tauri-runtime", test))]
fn set_pending_focus(target: FocusTarget) {
    if let Ok(mut slot) = PENDING_FOCUS.lock() {
        *slot = Some(target);
    }
}

/// Take the deep link the app was opened (or re-activated) with. Returns
/// `None` when there was none, or when another drain already claimed it.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn take_pending_deep_link() -> Option<FocusTarget> {
    PENDING_FOCUS.lock().ok().and_then(|mut slot| slot.take())
}

/// The Harness item a `codeg://harness/install` link asked for, waiting for
/// the local workspace window to claim it with [`take_pending_harness_link`].
///
/// A slot of its own beside [`PENDING_FOCUS`], so that neither kind can be
/// taken for the other, and handed over on the same terms: an atomic take,
/// announced by the payload-less [`PENDING_EVENT`]. One slot, holding the
/// newest link: one that arrives before the last was claimed names the item
/// the user is after now.
///
/// A Windows/Linux cold start never comes through here. Its link is in the
/// startup path ([`startup_workspace_path`]), and parked as well, the item
/// would open a second time.
static PENDING_HARNESS_LINK: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[cfg(any(feature = "tauri-runtime", test))]
fn set_pending_harness_link(item_ref: String) {
    if let Ok(mut slot) = PENDING_HARNESS_LINK.lock() {
        *slot = Some(item_ref);
    }
}

/// Park the Harness items `urls` ask for, in their order, so the last of them
/// is the one left waiting. Whether there was one.
#[cfg(any(feature = "tauri-runtime", test))]
fn park_harness_links(urls: &[String]) -> bool {
    let mut parked = false;
    for raw in urls {
        if let Some(DeepLink::Harness { item_ref }) = parse_deep_link(raw) {
            set_pending_harness_link(item_ref);
            parked = true;
        }
    }
    parked
}

/// Take the Harness item a link asked for, as its canonical `publisher/name`.
/// Returns `None` when there was none, or when another drain already claimed
/// it. Desktop only, like [`take_pending_deep_link`]: Codeg Web has
/// `/workspace?harness=` instead, and no OS scheme.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn take_pending_harness_link() -> Option<String> {
    PENDING_HARNESS_LINK
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
}

/// Collect `codeg:` URLs from a process argv (Windows / Linux second launch).
pub fn urls_from_argv(argv: &[impl AsRef<str>]) -> Vec<String> {
    argv.iter()
        .map(|arg| arg.as_ref().to_string())
        .filter(|arg| parse_deep_link(arg).is_some())
        .collect()
}

#[cfg(feature = "tauri-runtime")]
pub fn handle_raw_urls(app: &tauri::AppHandle, urls: &[String]) {
    use crate::commands::windows;
    use tauri::{Emitter, Manager};

    if urls.is_empty() {
        crate::commands::workspace_windows::activate_workspace(app);
        return;
    }

    // Harness links are parked here and now, not in the task below. They need
    // nothing from the database, so a database that is not ready yet does not
    // lose them; and they are parked in the order they came, so the newer of
    // two is the one left waiting, which tasks running side by side could not
    // promise. Then the nudge, as for a conversation: to the local main window
    // only.
    let harness_parked = park_harness_links(urls);
    if harness_parked {
        windows::show_main_window(app);
        if let Err(err) = app.emit_to("main", PENDING_EVENT, ()) {
            tracing::warn!("[deep-link] failed to signal main window: {err}");
        }
    }

    let Some(db) = app.try_state::<AppDatabase>() else {
        tracing::warn!(
            "[deep-link] database not ready; showing workspace for {} url(s)",
            urls.len()
        );
        windows::show_main_window(app);
        return;
    };
    let db = AppDatabase {
        conn: db.conn.clone(),
    };
    let app = app.clone();
    let urls = urls.to_vec();
    tauri::async_runtime::spawn(async move {
        let mut focused = harness_parked;
        for raw in &urls {
            let Some(link) = parse_deep_link(raw) else {
                continue;
            };
            if matches!(link, DeepLink::Harness { .. }) {
                continue; // parked above
            }
            match resolve_deep_link(&db, &link).await {
                Ok(Some(target)) => {
                    // Park, then nudge. The nudge never carries the target —
                    // see `PENDING_FOCUS` for why the slot has to be the only
                    // channel.
                    set_pending_focus(target);
                    windows::show_main_window(&app);
                    if let Err(err) = app.emit_to("main", PENDING_EVENT, ()) {
                        tracing::warn!("[deep-link] failed to signal main window: {err}");
                    }
                    focused = true;
                }
                Ok(None) => {
                    tracing::info!("[deep-link] no live conversation for {raw}");
                }
                Err(err) => {
                    tracing::warn!("[deep-link] {raw}: {err}");
                }
            }
        }
        if !focused {
            windows::show_main_window(&app);
        }
    });
}

#[cfg(feature = "tauri-runtime")]
pub fn handle_argv(app: &tauri::AppHandle, argv: &[String]) {
    handle_raw_urls(app, &urls_from_argv(argv));
}

/// Resolve the first startup URL that names something, so the main window
/// starts on it on a cold start. A live conversation is
/// `/workspace?folderId=…`, which `DeepLinkBootstrap` opens after folders/tabs
/// hydrate — an event emitted here would race the webview's subscription. A
/// Harness item is the Web address, `/workspace?harness=<ref>`, which
/// `HarnessLinkBootstrap` opens; it is not parked as well, since a slot
/// claimed after the address was read would open the item again.
///
/// This only fires where the plugin already knows the launch URL by the time
/// the setup hook runs, i.e. Windows/Linux (argv, parsed during plugin setup).
/// On macOS the URL arrives later as `RunEvent::Opened`, so `get_current()` is
/// empty here and the cold start is carried by the slots ([`PENDING_FOCUS`],
/// [`PENDING_HARNESS_LINK`]) instead. The
/// two paths are mutually exclusive: whichever delivery populated the plugin
/// before our `on_open_url` listener existed is the one that wins.
pub async fn startup_workspace_path(db: &AppDatabase, urls: &[String]) -> String {
    for raw in urls {
        let Some(link) = parse_deep_link(raw) else {
            continue;
        };
        match &link {
            DeepLink::Open => continue,
            DeepLink::Harness { item_ref } => return harness_workspace_path(item_ref),
            DeepLink::Session { .. } | DeepLink::Workspace { .. } => {}
        }
        match resolve_deep_link(db, &link).await {
            Ok(Some(target)) => return target.workspace_path(),
            Ok(None) => tracing::info!("[deep-link] startup url did not match a live session: {raw}"),
            Err(err) => tracing::warn!("[deep-link] startup {raw}: {err}"),
        }
    }
    "workspace".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::AgentType;
    use sea_orm::{ActiveModelTrait, EntityTrait, Set};

    /// Held by every test that parks or takes, for as long as it does: the
    /// slots are process-global, and tests run side by side. Both slots are
    /// empty when it is handed out.
    fn hold_slots() -> std::sync::MutexGuard<'static, ()> {
        static SLOTS: std::sync::Mutex<()> = std::sync::Mutex::new(());
        // A failing test poisons it on its way out; the slots are emptied
        // here regardless, so the next test can go ahead.
        let guard = SLOTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _ = take_pending_deep_link();
        let _ = take_pending_harness_link();
        guard
    }

    fn harness_link(item_ref: &str) -> Option<DeepLink> {
        Some(DeepLink::Harness {
            item_ref: item_ref.into(),
        })
    }

    /// `codeg://harness/install?<query>`, parsed.
    fn install_link(query: &str) -> Option<DeepLink> {
        parse_deep_link(&format!("codeg://harness/install?{query}"))
    }

    #[test]
    fn parses_session_numeric_id() {
        assert_eq!(
            parse_deep_link("codeg://session/214"),
            Some(DeepLink::Session {
                session_ref: "214".into()
            })
        );
        assert_eq!(
            parse_deep_link("codeg:session/214"),
            Some(DeepLink::Session {
                session_ref: "214".into()
            })
        );
        assert_eq!(
            parse_deep_link("codeg://session/214/"),
            Some(DeepLink::Session {
                session_ref: "214".into()
            })
        );
    }

    #[test]
    fn parses_session_external_id() {
        assert_eq!(
            parse_deep_link("codeg://session/0193c0de-aaaa-7bbb-8ccc-ddddeeeeffff"),
            Some(DeepLink::Session {
                session_ref: "0193c0de-aaaa-7bbb-8ccc-ddddeeeeffff".into()
            })
        );
        assert_eq!(
            parse_deep_link("codeg://session/codex_abc%20123"),
            Some(DeepLink::Session {
                session_ref: "codex_abc 123".into()
            })
        );
    }

    /// The `url` crate lower-cases a URL's host before `event.urls()` hands it
    /// over, but an argv-delivered link keeps the caller's casing, so the
    /// `session` segment must match either way. The ref after it must not — an
    /// `external_id` is an opaque token.
    #[test]
    fn session_segment_is_case_insensitive_but_the_ref_is_not() {
        for raw in [
            "codeg://SESSION/Codex_AbC",
            "codeg://Session/Codex_AbC",
            "codeg://sEsSiOn/Codex_AbC",
        ] {
            assert_eq!(
                parse_deep_link(raw),
                Some(DeepLink::Session {
                    session_ref: "Codex_AbC".into()
                }),
                "{raw}"
            );
        }
    }

    #[test]
    fn rejects_path_traversal_and_in_app_badges() {
        assert_eq!(parse_deep_link("codeg://session/../etc/passwd"), None);
        assert_eq!(parse_deep_link("codeg://session/"), None);
        assert_eq!(parse_deep_link("codeg://agent/grok"), None);
        assert_eq!(parse_deep_link("codeg://commit/abc"), None);
        assert_eq!(parse_deep_link("https://example.com/session/1"), None);
    }

    #[test]
    fn parses_open_and_workspace_query() {
        assert_eq!(parse_deep_link("codeg://"), Some(DeepLink::Open));
        assert_eq!(parse_deep_link("codeg://open"), Some(DeepLink::Open));
        assert_eq!(
            parse_deep_link("codeg://workspace?conversationId=9&folderId=3&agent=grok"),
            Some(DeepLink::Workspace {
                folder_id: Some(3),
                conversation_id: 9,
                agent: Some("grok".into()),
            })
        );
        assert_eq!(
            parse_deep_link("codeg://workspace?conversationId=9"),
            Some(DeepLink::Workspace {
                folder_id: None,
                conversation_id: 9,
                agent: None,
            })
        );
        assert_eq!(parse_deep_link("codeg://workspace"), None);
    }

    #[test]
    fn argv_keeps_only_codeg_urls() {
        let argv = [
            "/Applications/codeg.app/Contents/MacOS/codeg",
            "codeg://session/12",
            "--flag",
        ];
        assert_eq!(urls_from_argv(&argv), vec!["codeg://session/12".to_string()]);
    }

    #[tokio::test]
    async fn resolves_numeric_and_external_ids() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-deep-link").await;
        let id = seed_conversation(&db, folder, AgentType::Grok).await;

        let by_pk = resolve_deep_link(
            &db,
            &DeepLink::Session {
                session_ref: id.to_string(),
            },
        )
        .await
        .expect("lookup pk");
        assert_eq!(
            by_pk,
            Some(FocusTarget {
                folder_id: folder,
                conversation_id: id,
                agent: "grok".into(),
            })
        );

        let mut active: crate::db::entities::conversation::ActiveModel =
            crate::db::entities::conversation::Entity::find_by_id(id)
                .one(&db.conn)
                .await
                .expect("load")
                .expect("row")
                .into();
        active.external_id = Set(Some("grok-session-uuid".into()));
        active.update(&db.conn).await.expect("set external_id");

        let by_ext = resolve_deep_link(
            &db,
            &DeepLink::Session {
                session_ref: "grok-session-uuid".into(),
            },
        )
        .await
        .expect("lookup external");
        assert_eq!(by_ext.as_ref().map(|t| t.conversation_id), Some(id));

        let missing = resolve_deep_link(
            &db,
            &DeepLink::Session {
                session_ref: "999999".into(),
            },
        )
        .await
        .expect("missing");
        assert_eq!(missing, None);
    }

    /// Nothing stops an agent from issuing all-digit session ids, so an
    /// all-digit ref that matches no live primary key must still be tried as
    /// an `external_id` rather than reported as a dead link.
    #[tokio::test]
    async fn numeric_ref_falls_back_to_external_id() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-deep-link-numeric").await;
        let id = seed_conversation(&db, folder, AgentType::Codex).await;

        // An external id that can never collide with a live PK.
        let external = "90210";
        assert_ne!(external.parse::<i32>().ok(), Some(id));
        let mut active: crate::db::entities::conversation::ActiveModel =
            crate::db::entities::conversation::Entity::find_by_id(id)
                .one(&db.conn)
                .await
                .expect("load")
                .expect("row")
                .into();
        active.external_id = Set(Some(external.into()));
        active.update(&db.conn).await.expect("set external_id");

        let resolved = resolve_deep_link(
            &db,
            &DeepLink::Session {
                session_ref: external.into(),
            },
        )
        .await
        .expect("lookup numeric external");
        assert_eq!(resolved.as_ref().map(|t| t.conversation_id), Some(id));
    }

    /// The parked-target handoff that carries a macOS cold start, where the
    /// `workspace://focus-conversation` emit lands before the webview listens.
    /// Under [`hold_slots`]: `PENDING_FOCUS` is process-global.
    #[test]
    fn pending_focus_is_taken_exactly_once() {
        let _slots = hold_slots();
        assert_eq!(take_pending_deep_link(), None);
        let target = FocusTarget {
            folder_id: 3,
            conversation_id: 9,
            agent: "grok".into(),
        };
        set_pending_focus(target.clone());
        assert_eq!(take_pending_deep_link(), Some(target));
        assert_eq!(take_pending_deep_link(), None);
    }

    #[test]
    fn pending_focus_serializes_like_the_focus_event() {
        let json = serde_json::to_value(FocusTarget {
            folder_id: 3,
            conversation_id: 9,
            agent: "claude_code".into(),
        })
        .expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "folderId": 3,
                "conversationId": 9,
                "agent": "claude_code",
            })
        );
    }

    #[tokio::test]
    async fn startup_path_resolves_first_session_url_else_plain_workspace() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-deep-link-startup").await;
        let id = seed_conversation(&db, folder, AgentType::Grok).await;

        assert_eq!(startup_workspace_path(&db, &[]).await, "workspace");
        assert_eq!(
            startup_workspace_path(&db, &["codeg://open".into()]).await,
            "workspace"
        );
        assert_eq!(
            startup_workspace_path(&db, &["codeg://session/999999".into()]).await,
            "workspace"
        );
        assert_eq!(
            startup_workspace_path(
                &db,
                &[
                    "--some-flag".into(),
                    "codeg://open".into(),
                    format!("codeg://session/{id}"),
                ]
            )
            .await,
            format!("workspace?folderId={folder}&conversationId={id}&agent=grok")
        );
    }

    #[tokio::test]
    async fn workspace_query_fills_agent_and_rejects_mismatch() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-deep-link-ws").await;
        let id = seed_conversation(&db, folder, AgentType::Grok).await;

        let filled = resolve_deep_link(
            &db,
            &DeepLink::Workspace {
                folder_id: None,
                conversation_id: id,
                agent: None,
            },
        )
        .await
        .expect("fill");
        assert_eq!(filled.unwrap().agent, "grok");

        let mismatch = resolve_deep_link(
            &db,
            &DeepLink::Workspace {
                folder_id: None,
                conversation_id: id,
                agent: Some("codex".into()),
            },
        )
        .await
        .expect("mismatch");
        assert_eq!(mismatch, None);
    }

    #[test]
    fn workspace_path_encodes_query() {
        let path = FocusTarget {
            folder_id: 3,
            conversation_id: 9,
            agent: "claude_code".into(),
        }
        .workspace_path();
        assert_eq!(
            path,
            "workspace?folderId=3&conversationId=9&agent=claude_code"
        );
    }

    #[test]
    fn parses_a_harness_install_link() {
        for raw in [
            "codeg://harness/install?ref=acme/pdf-tools",
            "codeg:harness/install?ref=acme/pdf-tools",
            "codeg:///harness/install?ref=acme/pdf-tools",
            "codeg://harness/install/?ref=acme/pdf-tools",
            "codeg://harness/install?ref=acme/pdf-tools#readme",
            // The route is matched in any case, as `session` is.
            "codeg://HARNESS/Install?ref=acme/pdf-tools",
        ] {
            assert_eq!(
                parse_deep_link(raw),
                harness_link("acme/pdf-tools"),
                "{raw}"
            );
        }
        // After its first character a publisher may hold dots, as a domain
        // does; `a..` is one publisher, not a path segment.
        for good in ["a/b", "0x/1-2-3", "browser-use.com/browser-use", "a../b"] {
            assert_eq!(
                install_link(&format!("ref={good}")),
                harness_link(good),
                "{good}"
            );
        }
        let longest = format!("{}/{}", "a".repeat(253), "b".repeat(64));
        assert_eq!(
            install_link(&format!("ref={longest}")),
            harness_link(&longest)
        );
    }

    /// Case for case, `parseItemRef`'s own tests (`item-ref.test.ts`), and
    /// where `trim` differs between the two languages.
    #[test]
    fn an_item_address_is_read_as_parse_item_ref_reads_it() {
        for good in [
            "anthropics/pdf",
            "browser-use.com/browser-use",
            "a/b",
            "0x/1-2-3",
        ] {
            assert_eq!(parse_item_ref(good).as_deref(), Some(good));
        }
        assert_eq!(
            parse_item_ref("  Anthropics/PDF \n").as_deref(),
            Some("anthropics/pdf")
        );
        let longest = format!("{}/{}", "a".repeat(253), "b".repeat(64));
        assert_eq!(parse_item_ref(&longest).as_deref(), Some(longest.as_str()));

        let too_long_name = format!("anthropics/{}", "a".repeat(65));
        let too_long_publisher = format!("{}/pdf", "a".repeat(254));
        for bad in [
            "",
            "pdf",
            "/pdf",
            "anthropics/",
            "anthropics/pdf/extra",
            "anthropics/pdf tools",
            "anthropics/pdf_tools",
            "-anthropics/pdf",
            ".anthropics/pdf",
            "anthropics//pdf",
            "anthropics/pdf?x=1",
            "anthropics/pdf#top",
            "https://spacering.net/harness/anthropics/pdf",
            "../../other/name",
            too_long_name.as_str(),
            too_long_publisher.as_str(),
            "用户/技能",
        ] {
            assert_eq!(parse_item_ref(bad), None, "{bad:?}");
        }

        // JavaScript's `trim` takes the byte-order mark and leaves NEL, which
        // Rust's `trim` does the other way round.
        assert_eq!(
            parse_item_ref("\u{feff}anthropics/pdf\u{feff}").as_deref(),
            Some("anthropics/pdf")
        );
        assert_eq!(parse_item_ref("\u{85}anthropics/pdf"), None);
        assert_eq!(parse_item_ref("anthropics/pdf\u{85}"), None);
    }

    /// `ref` is a query value, decoded as `URLSearchParams` decodes the Web
    /// address's `?harness=`.
    #[test]
    fn a_harness_ref_is_decoded_like_a_query_value() {
        for query in [
            "ref=acme%2Fpdf-tools",
            "ref=%61cme%2fpdf%2Dtools",
            "r%65f=acme/pdf-tools",
            // `+` is a space, and surrounding space is forgiven as
            // `parseItemRef` forgives it.
            "ref=+acme/pdf-tools+",
            "ref=%20%09acme/pdf-tools%0A",
            "ref=%E2%80%83acme/pdf-tools%E3%80%80",
            "ref=%EF%BB%BFacme/pdf-tools",
        ] {
            assert_eq!(
                install_link(query),
                harness_link("acme/pdf-tools"),
                "{query}"
            );
        }
    }

    #[test]
    fn other_parameters_are_ignored() {
        for query in [
            "ref=acme/pdf-tools&intent=install",
            "utm_source=spacering&ref=acme/pdf-tools&utm_medium=web",
            "&ref=acme/pdf-tools&&",
            // The first `ref` is the one read, as `URLSearchParams.get` has it…
            "ref=acme/pdf-tools&ref=other/thing",
        ] {
            assert_eq!(
                install_link(query),
                harness_link("acme/pdf-tools"),
                "{query}"
            );
        }
        // …even when it is not an address.
        assert_eq!(
            install_link("ref=nothing&ref=acme/pdf-tools"),
            Some(DeepLink::Open)
        );
    }

    /// `parseItemRef` forgives capitals, so a link with them opens the item,
    /// under its canonical lower-case address: no other form is ever parked.
    /// Not forgiven: a capital that does not lower-case to ASCII, or the
    /// parameter's name in capitals (`URLSearchParams` is case-sensitive).
    #[test]
    fn capitals_in_a_harness_ref_come_out_lower_case() {
        for query in ["ref=Acme/PDF-Tools", "ref=ACME%2FPDF-TOOLS"] {
            assert_eq!(
                install_link(query),
                harness_link("acme/pdf-tools"),
                "{query}"
            );
        }
        // As in JavaScript, where `"\u212A".toLowerCase()` is `"k"`.
        assert_eq!(install_link("ref=%E2%84%AAit/x"), harness_link("kit/x"));
        for query in [
            "REF=acme/pdf-tools",
            "Ref=acme/pdf-tools",
            // Fullwidth `Ａ` lower-cases to fullwidth `ａ`, and `İ` to `i̇`.
            "ref=%EF%BC%A1cme/pdf-tools",
            "ref=%C4%B0cme/pdf-tools",
        ] {
            assert_eq!(install_link(query), Some(DeepLink::Open), "{query}");
        }
    }

    /// A Harness link that names no item only shows the workspace.
    #[test]
    fn a_harness_link_without_an_item_address_is_codeg_open() {
        let too_long_publisher = format!("ref={}/b", "a".repeat(254));
        let too_long_name = format!("ref=a/{}", "b".repeat(65));
        for query in [
            "",
            "ref",
            "ref=",
            "ref=+",
            "intent=install",
            "ref=acme",
            "ref=/",
            "ref=/pdf-tools",
            "ref=acme/",
            "ref=acme//pdf-tools",
            "ref=acme/pdf-tools/",
            "ref=acme/pdf-tools/extra",
            "ref=.acme/pdf-tools",
            "ref=-acme/pdf-tools",
            "ref=acme/pdf.tools",
            "ref=acme/pdf_tools",
            "ref=acme/pdf%20tools",
            "ref=acme/pdf+tools",
            "ref=acme/pdf-tools%00",
            "ref=ac%25me/pdf-tools",
            "ref=%FF/pdf-tools",
            "ref=acme/pdf-tools%3Fv%3D2",
            "ref=%C2%85acme/pdf-tools",
            "ref=https://spacering.net/harness/acme/pdf-tools",
            too_long_publisher.as_str(),
            too_long_name.as_str(),
        ] {
            assert_eq!(install_link(query), Some(DeepLink::Open), "{query:?}");
        }
        for raw in [
            "codeg://harness",
            "codeg://harness/",
            "codeg://harness/install",
            "codeg://harness/uninstall?ref=acme/pdf-tools",
            "codeg://harness/install/now?ref=acme/pdf-tools",
            "codeg://harness/acme/pdf-tools",
        ] {
            assert_eq!(parse_deep_link(raw), Some(DeepLink::Open), "{raw}");
        }
    }

    #[test]
    fn path_tricks_in_a_harness_ref_are_refused() {
        for query in [
            "ref=../pdf-tools",
            "ref=./pdf-tools",
            "ref=acme/..",
            "ref=acme/.",
            "ref=acme/../pdf-tools",
            "ref=acme/pdf-tools/../other",
            "ref=..%2F..%2Fetc%2Fpasswd",
            "ref=%2e%2e/pdf-tools",
            "ref=acme/%2E%2E",
            "ref=%2Facme/pdf-tools",
            "ref=acme%2F%2Fpdf-tools",
            "ref=acme%5Cpdf-tools",
            "ref=acme\\pdf-tools",
            "ref=acme/pdf-tools%5C..",
            "ref=~/pdf-tools",
            "ref=c:%5Cacme/pdf-tools",
            "ref=acme/pdf-tools%23readme",
        ] {
            assert_eq!(install_link(query), Some(DeepLink::Open), "{query}");
        }
    }

    /// A Windows/Linux second launch reaches the handler only through
    /// `urls_from_argv`, and whether a launch shows the local window is the
    /// same `parse_deep_link(..).is_some()` (`load_restore` in `lib.rs`). A
    /// Harness link must get through both, naming an item or not, or the main
    /// window would not come forward for it.
    #[test]
    fn harness_links_get_through_the_argv_and_restore_filters() {
        let valid = "codeg://harness/install?ref=acme/pdf-tools";
        let invalid = "codeg://harness/install?ref=not-an-address";
        let argv = [r"C:\Program Files\Codeg\codeg.exe", valid, "--flag"];
        assert_eq!(urls_from_argv(&argv), vec![valid.to_string()]);
        let argv = ["/usr/bin/codeg", invalid];
        assert_eq!(urls_from_argv(&argv), vec![invalid.to_string()]);
        assert!(parse_deep_link(valid).is_some());
        assert!(parse_deep_link(invalid).is_some());
    }

    #[test]
    fn the_harness_slot_is_claimed_once_and_the_newest_link_wins() {
        let _slots = hold_slots();
        assert_eq!(take_pending_harness_link(), None);

        assert!(park_harness_links(&[
            "codeg://harness/install?ref=Acme/PDF-Tools".into()
        ]));
        assert_eq!(
            take_pending_harness_link().as_deref(),
            Some("acme/pdf-tools")
        );
        assert_eq!(take_pending_harness_link(), None);

        // Two links in one delivery, then two deliveries one after the other.
        assert!(park_harness_links(&[
            "codeg://harness/install?ref=acme/first".into(),
            "codeg://harness/install?ref=acme/second".into(),
        ]));
        assert_eq!(take_pending_harness_link().as_deref(), Some("acme/second"));
        assert!(park_harness_links(&[
            "codeg://harness/install?ref=acme/first".into()
        ]));
        assert!(park_harness_links(&[
            "codeg://harness/install?ref=acme/second".into()
        ]));
        assert_eq!(take_pending_harness_link().as_deref(), Some("acme/second"));
        assert_eq!(take_pending_harness_link(), None);

        // A link that names no item parks nothing, and leaves a waiting one be.
        assert!(park_harness_links(&[
            "codeg://harness/install?ref=acme/waiting".into()
        ]));
        assert!(!park_harness_links(&[
            "codeg://harness/install?ref=../other".into(),
            "codeg://open".into(),
            "codeg://session/9".into(),
            "https://example.com/harness/install?ref=acme/other".into(),
        ]));
        assert_eq!(take_pending_harness_link().as_deref(), Some("acme/waiting"));
        assert_eq!(take_pending_harness_link(), None);
    }

    #[test]
    fn the_harness_slot_and_the_conversation_slot_are_apart() {
        let _slots = hold_slots();
        let target = FocusTarget {
            folder_id: 3,
            conversation_id: 9,
            agent: "grok".into(),
        };

        assert!(park_harness_links(&[
            "codeg://harness/install?ref=acme/pdf-tools".into()
        ]));
        assert_eq!(take_pending_deep_link(), None);
        set_pending_focus(target.clone());
        assert_eq!(
            take_pending_harness_link().as_deref(),
            Some("acme/pdf-tools")
        );
        assert_eq!(take_pending_harness_link(), None);
        assert_eq!(take_pending_deep_link(), Some(target.clone()));

        // The other way round: a parked conversation is no Harness link.
        set_pending_focus(target.clone());
        assert_eq!(take_pending_harness_link(), None);
        assert_eq!(take_pending_deep_link(), Some(target));
    }

    /// The Windows/Linux cold start: the window starts on the Web address,
    /// encoded so that `URLSearchParams` hands `HarnessLinkBootstrap` the ref
    /// back, and nothing is parked besides — a slot claimed after the address
    /// was read would open the item a second time.
    ///
    /// Not a `tokio::test`: the slots stay held across the awaits, and a lock
    /// held inside async code is what clippy's `await_holding_lock` refuses.
    /// Held out here, it is not.
    #[test]
    fn a_cold_start_harness_link_is_in_the_startup_path_only() {
        let _slots = hold_slots();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let (path, invalid, after_a_dead_session) = runtime.block_on(async {
            let db = fresh_in_memory_db().await;
            let path = startup_workspace_path(
                &db,
                &["codeg://harness/install?ref=Acme%2FPDF-Tools&utm_source=spacering".into()],
            )
            .await;
            let invalid =
                startup_workspace_path(&db, &["codeg://harness/install?ref=../other".into()]).await;
            let after_a_dead_session = startup_workspace_path(
                &db,
                &[
                    "codeg://session/999999".into(),
                    "codeg://harness/install?ref=acme/pdf-tools".into(),
                ],
            )
            .await;
            (path, invalid, after_a_dead_session)
        });

        assert_eq!(path, "workspace?harness=acme%2Fpdf-tools");
        let (_, query) = path.split_once('?').expect("a query");
        let read_back: Vec<String> = url::form_urlencoded::parse(query.as_bytes())
            .filter(|(key, _)| key == "harness")
            .map(|(_, value)| value.into_owned())
            .collect();
        assert_eq!(read_back, ["acme/pdf-tools"]);
        assert_eq!(
            harness_workspace_path("example.com/notes-mcp"),
            "workspace?harness=example.com%2Fnotes-mcp"
        );

        // Like `codeg://open`: the plain workspace.
        assert_eq!(invalid, "workspace");
        assert_eq!(after_a_dead_session, "workspace?harness=acme%2Fpdf-tools");

        assert_eq!(take_pending_harness_link(), None);
    }
}
