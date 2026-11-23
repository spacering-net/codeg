//! The menu bar and the dock (10.10, 2.9; desktop only): codeg's tray icon
//! turns into the face of the assistant at work — blinking and glancing
//! about as an idle face does (10.6) — with the count of assistants with
//! something unread beside it and the five latest in its menu; the dock's
//! badge counts them too. Each has its switch (`menubar`, `dock_badge`):
//! off, it is as it always was.
//!
//! What it shows is read off what the pages are told: each assistant's
//! live state as it is pushed (`live`), and the roster's own (hidden, muted,
//! marked unread). The page draws the faces (`personal_agent_avatar_png`,
//! a strip of frames); a process with no tray draws nothing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use rand::Rng;

use super::host::EngineHost;
use crate::db::entities::personal_agent::{self as agent_entity, BotKind};
use crate::db::service::personal_agent_service as svc;
use crate::models::personal_agent_prefs::{OnOff, Prefs};
use crate::models::personal_agent_roster::{Attention, BotLive, WorkState};

/// The most assistants the menu lists.
pub const RECENT_MAX: usize = 5;
/// Changes this close together are drawn once.
const GATHER: Duration = Duration::from_millis(200);
/// The most frames a strip may have.
pub const FRAMES_MAX: u32 = 8;

/// What the menu bar knows of an assistant from its last pushed state.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct Seen {
    /// At work since then; `None`: not at work.
    pub(super) busy_since: Option<DateTime<Utc>>,
    /// Something it said the owner has not seen.
    pub(super) unread: bool,
    pub(super) last_activity_at: Option<DateTime<Utc>>,
}

/// An assistant in the menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayRow {
    pub id: i32,
    /// As the owner named it; empty: the page's default name.
    pub name: String,
    pub primary: bool,
    pub unread: bool,
}

/// What the menu bar and the dock show.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TrayView {
    /// Off: the tray as it always was — codeg's icon, its two items.
    pub menubar: bool,
    /// The assistant whose face is shown: the one at work that started
    /// last.
    pub face: Option<i32>,
    /// Assistants with something unread, the hidden and the muted aside.
    pub count: u32,
    /// The dock's badge (0: none).
    pub badge: u32,
    /// The latest assistants, the hidden aside, latest first.
    pub recent: Vec<TrayRow>,
    /// Bumped as faces are handed over: they are drawn anew.
    pub pictures: u64,
}

/// Where the menu bar and the dock are drawn: the desktop's tray, or a
/// test's record.
pub trait MenuBarSink: Send + Sync {
    fn show(&self, view: &TrayView);
}

#[derive(Default)]
struct Inner {
    seen: HashMap<i32, Seen>,
    /// A draw is due.
    pending: bool,
    pictures: u64,
    /// What was drawn last.
    last: Option<TrayView>,
}

/// The menu bar's state, on the host.
#[derive(Default)]
pub struct MenuBar {
    inner: std::sync::Mutex<Inner>,
    sink: OnceLock<Arc<dyn MenuBarSink>>,
    /// One draw at a time, so a later one never lands before an earlier.
    drawing: tokio::sync::Mutex<()>,
}

impl MenuBar {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Take in an assistant's pushed state.
    pub(super) fn saw(&self, live: &BotLive) {
        let now = Utc::now();
        let mut inner = self.lock();
        let prev = inner.seen.get(&live.bot_id).copied().unwrap_or_default();
        inner.seen.insert(live.bot_id, seen_of(live, prev, now));
    }

    /// Take in an assistant's state as read at the start — unless a push
    /// came in meanwhile, which is newer (review round 1).
    fn seed(&self, live: &BotLive) {
        let now = Utc::now();
        self.lock()
            .seen
            .entry(live.bot_id)
            .or_insert_with(|| seen_of(live, Seen::default(), now));
    }
}

/// What an assistant's pushed state says, after `prev`.
fn seen_of(live: &BotLive, prev: Seen, now: DateTime<Utc>) -> Seen {
    let busy = live.work == WorkState::Busy;
    Seen {
        busy_since: if busy {
            Some(prev.busy_since.unwrap_or(now))
        } else {
            None
        },
        unread: live.unread > 0 || live.attention == Attention::Unread,
        last_activity_at: live.last_activity_at,
    }
}

/// What the menu bar and the dock show for these assistants.
pub(super) fn view_of(
    bots: &[(agent_entity::Model, Seen)],
    prefs: &Prefs,
    pictures: u64,
) -> TrayView {
    let unread = |(row, seen): &(agent_entity::Model, Seen)| seen.unread || row.unread_mark;
    let count = bots
        .iter()
        .filter(|b| !b.0.hidden && !b.0.muted && unread(b))
        .count() as u32;
    let badge = if prefs.dock_badge == OnOff::On {
        count
    } else {
        0
    };
    if prefs.menubar == OnOff::Off {
        return TrayView {
            badge,
            ..TrayView::default()
        };
    }
    let face = bots
        .iter()
        .filter(|(row, _)| !row.hidden)
        .filter_map(|(row, seen)| seen.busy_since.map(|at| (at, row.id)))
        .max()
        .map(|(_, id)| id);
    let mut shown: Vec<&(agent_entity::Model, Seen)> =
        bots.iter().filter(|b| !b.0.hidden).collect();
    // Latest first; never active last, the primary before the rest.
    shown.sort_by(|a, b| {
        b.1.last_activity_at
            .cmp(&a.1.last_activity_at)
            .then_with(|| (b.0.kind == BotKind::Primary).cmp(&(a.0.kind == BotKind::Primary)))
            .then_with(|| a.0.id.cmp(&b.0.id))
    });
    let recent = shown
        .into_iter()
        .take(RECENT_MAX)
        .map(|b| TrayRow {
            id: b.0.id,
            name: b.0.name.trim().to_string(),
            primary: b.0.kind == BotKind::Primary,
            unread: unread(b),
        })
        .collect();
    TrayView {
        menubar: true,
        face,
        count,
        badge,
        recent,
        pictures,
    }
}

impl EngineHost {
    /// Draw the menu bar and the dock on `sink` from now on (the desktop's
    /// tray), from what the database says to begin with.
    pub async fn menubar_start(self: &Arc<Self>, sink: Arc<dyn MenuBarSink>) {
        if self.menubar.sink.set(sink).is_err() {
            return;
        }
        // Pushes are taken in from now on: what is read here may be older.
        for (_, live) in super::live::roster_from_db(&self.db).await {
            self.menubar.seed(&live);
        }
        self.menubar_draw().await;
    }

    /// An assistant's state was pushed: the menu bar takes it in.
    pub(super) fn menubar_saw(self: &Arc<Self>, live: &BotLive) {
        if self.menubar.sink.get().is_none() {
            return;
        }
        self.menubar.saw(live);
        self.menubar_poke();
    }

    /// An assistant's face was handed over again: drawn anew.
    pub fn menubar_pictures(self: &Arc<Self>) {
        self.menubar.lock().pictures += 1;
        self.menubar_poke();
    }

    /// Something the menu bar shows may have changed: drawn shortly, with
    /// whatever else changes meanwhile.
    pub fn menubar_poke(self: &Arc<Self>) {
        if self.menubar.sink.get().is_none() {
            return;
        }
        {
            let mut inner = self.menubar.lock();
            if inner.pending {
                return;
            }
            inner.pending = true;
        }
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(GATHER).await;
            me.menubar.lock().pending = false;
            me.menubar_draw().await;
        });
    }

    async fn menubar_draw(&self) {
        let Some(sink) = self.menubar.sink.get().cloned() else {
            return;
        };
        let _one = self.menubar.drawing.lock().await;
        let Ok(rows) = svc::list_bots(&self.db.conn).await else {
            return;
        };
        let prefs = self.primary().prefs().await;
        let view = {
            let mut inner = self.menubar.lock();
            inner.seen.retain(|id, _| rows.iter().any(|r| r.id == *id));
            let bots: Vec<(agent_entity::Model, Seen)> = rows
                .into_iter()
                .map(|r| {
                    let seen = inner.seen.get(&r.id).copied().unwrap_or_default();
                    (r, seen)
                })
                .collect();
            let view = view_of(&bots, &prefs, inner.pictures);
            if inner.last.as_ref() == Some(&view) {
                return;
            }
            inner.last = Some(view.clone());
            view
        };
        // Drawing waits on the window system's thread.
        let _ = tokio::task::spawn_blocking(move || sink.show(&view)).await;
    }
}

// ── the faces ───────────────────────────────────────────────────────────────

/// Where assistant `bot`'s strip of tray frames is kept: its face as the
/// page drew it, side by side — open, blinking, glancing left, right, up —
/// or one picture.
pub fn tray_png(data_dir: &Path, bot: i32) -> PathBuf {
    data_dir
        .join("personal-agent")
        .join("avatars")
        .join(format!("{bot}-tray.png"))
}

/// One frame, RGBA.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// A frame of a face's strip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Frame {
    Open = 0,
    Blink = 1,
    Left = 2,
    Right = 3,
    Up = 4,
}

/// The frames a face's strip has: all five, or one picture.
pub const FACE_FRAMES: usize = 5;

/// The frames of `png`: a strip of squares side by side.
pub fn frames_of(png: &[u8]) -> Option<Vec<Rgba>> {
    let strip = image::load_from_memory(png).ok()?.to_rgba8();
    let (w, h) = strip.dimensions();
    if h == 0 || w % h != 0 || w / h > FRAMES_MAX {
        return None;
    }
    Some(
        (0..w / h)
            .map(|i| {
                let frame = image::imageops::crop_imm(&strip, i * h, 0, h, h).to_image();
                Rgba {
                    width: h,
                    height: h,
                    data: frame.into_raw(),
                }
            })
            .collect(),
    )
}

/// Assistant `bot`'s frames: its strip, or else the picture its
/// notifications go under, as one frame of `size`.
pub fn load_frames(data_dir: &Path, bot: i32, size: u32) -> Option<Vec<Rgba>> {
    if let Some(frames) = std::fs::read(tray_png(data_dir, bot))
        .ok()
        .and_then(|b| frames_of(&b))
    {
        return Some(frames);
    }
    let png = std::fs::read(super::reach::avatar_png(data_dir, bot)).ok()?;
    let img = image::load_from_memory(&png).ok()?.to_rgba8();
    let small = image::imageops::resize(&img, size, size, image::imageops::FilterType::Lanczos3);
    Some(vec![Rgba {
        width: size,
        height: size,
        data: small.into_raw(),
    }])
}

/// `frame` scaled to `size` (a menu's row is smaller than the bar).
pub fn scaled(frame: &Rgba, size: u32) -> Rgba {
    if frame.width == size && frame.height == size {
        return frame.clone();
    }
    let Some(img) = image::RgbaImage::from_raw(frame.width, frame.height, frame.data.clone())
    else {
        return frame.clone();
    };
    let small = image::imageops::resize(&img, size, size, image::imageops::FilterType::Lanczos3);
    Rgba {
        width: size,
        height: size,
        data: small.into_raw(),
    }
}

/// An idle face's next move (10.6, the source report's 5.4 timing): after
/// 2.8–5.5 s, half the time a glance left, right or up held 0.5–0.9 s; else
/// a blink, twice in a row one time in seven or so. The frames to show and
/// how long each, then back to open.
pub fn idle_move(r: &mut impl Rng) -> (Duration, Vec<(Frame, Duration)>) {
    const BLINK: Duration = Duration::from_millis(120);
    let wait = Duration::from_millis(r.gen_range(2800..=5500));
    if r.gen_bool(0.5) {
        let dir = [Frame::Left, Frame::Right, Frame::Up][r.gen_range(0..3)];
        (
            wait,
            vec![(dir, Duration::from_millis(r.gen_range(500..=900)))],
        )
    } else if r.gen_bool(0.14) {
        (
            wait,
            vec![
                (Frame::Blink, BLINK),
                (Frame::Open, Duration::from_millis(140)),
                (Frame::Blink, BLINK),
            ],
        )
    } else {
        (wait, vec![(Frame::Blink, BLINK)])
    }
}

// ── the taskbar's number (Windows) ──────────────────────────────────────────

/// The digits and "+", 3 × 5.
const GLYPHS: [(char, [u8; 5]); 11] = [
    ('0', [0b111, 0b101, 0b101, 0b101, 0b111]),
    ('1', [0b010, 0b110, 0b010, 0b010, 0b111]),
    ('2', [0b111, 0b001, 0b111, 0b100, 0b111]),
    ('3', [0b111, 0b001, 0b111, 0b001, 0b111]),
    ('4', [0b101, 0b101, 0b111, 0b001, 0b001]),
    ('5', [0b111, 0b100, 0b111, 0b001, 0b111]),
    ('6', [0b111, 0b100, 0b111, 0b101, 0b111]),
    ('7', [0b111, 0b001, 0b001, 0b001, 0b001]),
    ('8', [0b111, 0b101, 0b111, 0b101, 0b111]),
    ('9', [0b111, 0b101, 0b111, 0b001, 0b111]),
    ('+', [0b000, 0b010, 0b111, 0b010, 0b000]),
];

/// The size of the taskbar's overlay icon.
pub const BADGE_SIZE: u32 = 32;

/// The taskbar's overlay icon for `n` (Windows has no badge count): white
/// on a red disc, "9+" past nine.
pub fn badge_icon(n: u32) -> Rgba {
    let text = if n > 9 {
        "9+".to_string()
    } else {
        n.to_string()
    };
    let size = BADGE_SIZE;
    let mut data = vec![0u8; (size * size * 4) as usize];
    let c = (size as f32 - 1.0) / 2.0;
    for y in 0..size {
        for x in 0..size {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            let a = (c + 0.5 - d).clamp(0.0, 1.0);
            let i = ((y * size + x) * 4) as usize;
            data[i..i + 4].copy_from_slice(&[0xdc, 0x26, 0x26, (a * 255.0) as u8]);
        }
    }
    let scale: u32 = if text.len() == 1 { 4 } else { 3 };
    let gap = scale;
    let glyphs: Vec<[u8; 5]> = text
        .chars()
        .filter_map(|ch| GLYPHS.iter().find(|(g, _)| *g == ch).map(|(_, b)| *b))
        .collect();
    let width = glyphs.len() as u32 * 3 * scale + (glyphs.len() as u32).saturating_sub(1) * gap;
    let (x0, y0) = ((size - width) / 2, (size - 5 * scale) / 2);
    for (k, rows) in glyphs.iter().enumerate() {
        let gx = x0 + k as u32 * (3 * scale + gap);
        for (ry, bits) in rows.iter().enumerate() {
            for rx in 0..3u32 {
                if bits & (0b100 >> rx) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let (x, y) = (gx + rx * scale + dx, y0 + ry as u32 * scale + dy);
                        let i = ((y * size + x) * 4) as usize;
                        data[i..i + 4].copy_from_slice(&[0xff, 0xff, 0xff, 0xff]);
                    }
                }
            }
        }
    }
    Rgba {
        width: size,
        height: size,
        data,
    }
}

// ── the desktop's tray ──────────────────────────────────────────────────────

#[cfg(feature = "tauri-runtime")]
pub use desktop::TraySink;

#[cfg(feature = "tauri-runtime")]
mod desktop {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use rand::SeedableRng;
    use tokio::sync::watch;

    use super::{idle_move, load_frames, scaled, Frame, MenuBarSink, Rgba, TrayView, FACE_FRAMES};
    use crate::commands::windows::{self, TrayBotRow};
    use crate::web::event_bridge::RetainedAppHandle;

    /// The bar's frames are drawn this big (18 pt at 2×).
    const BAR_PX: u32 = 36;
    /// A menu row's picture: Windows draws it as it is; the others scale.
    const ROW_PX: u32 = if cfg!(target_os = "windows") {
        16
    } else {
        BAR_PX
    };

    type Frames = Arc<Vec<Rgba>>;

    #[derive(Default)]
    struct Drawn {
        last: Option<TrayView>,
        /// Each assistant's frames, as last read (cleared with each new
        /// picture).
        frames: HashMap<i32, Option<Frames>>,
    }

    /// The desktop's tray and dock.
    pub struct TraySink {
        // The process's one retained handle: this lives on worker threads,
        // where a bare `AppHandle` must not be cloned or dropped.
        app: RetainedAppHandle,
        data_dir: PathBuf,
        face: watch::Sender<Option<Frames>>,
        drawn: Mutex<Drawn>,
    }

    impl TraySink {
        /// The tray's sink, its face animated on its own task.
        pub fn new(app: RetainedAppHandle, data_dir: PathBuf) -> Arc<Self> {
            let (face, rx) = watch::channel(None);
            tokio::spawn(animate(app.clone(), rx));
            Arc::new(Self {
                app,
                data_dir,
                face,
                drawn: Mutex::new(Drawn::default()),
            })
        }

        fn frames(&self, drawn: &mut Drawn, bot: i32) -> Option<Frames> {
            drawn
                .frames
                .entry(bot)
                .or_insert_with(|| load_frames(&self.data_dir, bot, BAR_PX).map(Arc::new))
                .clone()
        }
    }

    impl MenuBarSink for TraySink {
        fn show(&self, view: &TrayView) {
            let mut drawn = self.drawn.lock().unwrap_or_else(|e| e.into_inner());
            let prev = drawn.last.take().unwrap_or_default();
            if prev.pictures != view.pictures {
                drawn.frames.clear();
            }
            let pictures = prev.pictures != view.pictures;
            if prev.face != view.face || prev.menubar != view.menubar || pictures {
                let frames = view.face.and_then(|b| self.frames(&mut drawn, b));
                self.face.send_replace(frames);
            }
            if prev.count != view.count || prev.menubar != view.menubar {
                windows::set_tray_count(&self.app, view.count);
            }
            if prev.recent != view.recent || prev.menubar != view.menubar || pictures {
                let rows = view.menubar.then(|| {
                    view.recent
                        .iter()
                        .map(|r| TrayBotRow {
                            id: r.id,
                            name: r.name.clone(),
                            primary: r.primary,
                            unread: r.unread,
                            icon: self
                                .frames(&mut drawn, r.id)
                                .and_then(|f| f.first().map(|open| scaled(open, ROW_PX))),
                        })
                        .collect()
                });
                windows::set_tray_bots(&self.app, rows);
            }
            if prev.badge != view.badge {
                windows::set_dock_badge(&self.app, view.badge);
            }
            drawn.last = Some(view.clone());
        }
    }

    /// The tray's face while one is shown: open, and now and then a blink
    /// or a glance (a single picture stays as it is).
    async fn animate(app: RetainedAppHandle, mut rx: watch::Receiver<Option<Frames>>) {
        let mut rng = rand::rngs::StdRng::from_entropy();
        loop {
            let frames = rx.borrow_and_update().clone();
            match &frames {
                None => windows::set_tray_face(&app, None),
                Some(f) => {
                    let at = |frame: Frame| f.get(frame as usize).or_else(|| f.first());
                    windows::set_tray_face(&app, at(Frame::Open));
                    if f.len() >= FACE_FRAMES {
                        'moves: loop {
                            let (wait, steps) = idle_move(&mut rng);
                            match changed_within(&mut rx, wait).await {
                                Some(true) => break 'moves,
                                None => return,
                                Some(false) => {}
                            }
                            for (frame, hold) in steps {
                                windows::set_tray_face(&app, at(frame));
                                match changed_within(&mut rx, hold).await {
                                    Some(true) => break 'moves,
                                    None => return,
                                    Some(false) => {}
                                }
                            }
                            windows::set_tray_face(&app, at(Frame::Open));
                        }
                        continue;
                    }
                }
            }
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    /// Whether the face changes within `d` (`None`: the tray is gone).
    async fn changed_within(
        rx: &mut watch::Receiver<Option<Frames>>,
        d: std::time::Duration,
    ) -> Option<bool> {
        tokio::select! {
            r = rx.changed() => r.ok().map(|_| true),
            _ = tokio::time::sleep(d) => Some(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    fn bot(id: i32, kind: BotKind) -> agent_entity::Model {
        let now = Utc::now();
        agent_entity::Model {
            id,
            name: format!("bot{id}"),
            avatar: String::new(),
            agent_type: Some("claude_code".into()),
            agent_options: Some("{}".into()),
            label_snapshot: Some("{}".into()),
            settings: "{}".into(),
            workdir: None,
            folder_id: None,
            revision: 1,
            created_at: now,
            updated_at: now,
            kind,
            uid: None,
            sort_order: 0,
            pinned_at: None,
            section: None,
            hidden: false,
            muted: false,
            unread_mark: false,
            notify: true,
            deleted_at: None,
            work_agent_type: "claude_code".into(),
            work_agent_options: "{}".into(),
            work_label_snapshot: "{}".into(),
            work_instructions: None,
            seed_persona: None,
            seed_version: 0,
            workdir_ready: true,
            legacy_assistant_id: None,
            legacy_assistant_uid: None,
        }
    }

    fn live(bot_id: i32) -> BotLive {
        BotLive {
            bot_id,
            work: WorkState::Idle,
            attention: Attention::None,
            needs: None,
            unread: 0,
            activity: None,
            activity_known: true,
            work_on_hand: Vec::new(),
            awaiting: Vec::new(),
            face: crate::models::personal_agent_roster::FaceState::Idle,
            flash: None,
            connected: false,
            last_line: None,
            last_activity_at: None,
            updated_at: Utc::now(),
            expires_at: None,
        }
    }

    fn at(s: i64) -> Option<DateTime<Utc>> {
        Some(DateTime::<Utc>::from_timestamp(1_800_000_000 + s, 0).unwrap())
    }

    #[test]
    fn the_face_is_the_one_that_started_last_and_the_count_leaves_out_the_hidden_and_muted() {
        let mut hidden = bot(4, BotKind::Worker);
        hidden.hidden = true;
        let mut muted = bot(5, BotKind::Worker);
        muted.muted = true;
        let mut marked = bot(6, BotKind::Worker);
        marked.unread_mark = true;
        let bots = vec![
            (
                bot(1, BotKind::Primary),
                Seen {
                    busy_since: at(10),
                    unread: true,
                    last_activity_at: at(10),
                },
            ),
            (
                bot(2, BotKind::Worker),
                Seen {
                    busy_since: at(30),
                    unread: false,
                    last_activity_at: at(30),
                },
            ),
            (
                bot(3, BotKind::Worker),
                Seen {
                    busy_since: None,
                    unread: true,
                    last_activity_at: at(5),
                },
            ),
            (
                hidden,
                Seen {
                    busy_since: at(99),
                    unread: true,
                    last_activity_at: at(99),
                },
            ),
            (
                muted,
                Seen {
                    busy_since: None,
                    unread: true,
                    last_activity_at: at(50),
                },
            ),
            (
                marked,
                Seen {
                    busy_since: None,
                    unread: false,
                    last_activity_at: None,
                },
            ),
        ];
        let view = view_of(&bots, &Prefs::default(), 0);
        assert!(view.menubar);
        assert_eq!(
            view.face,
            Some(2),
            "the busy one that started last, the hidden aside"
        );
        assert_eq!(view.count, 3, "the primary, #3 and the one marked unread");
        assert_eq!(view.badge, 3);
        let ids: Vec<i32> = view.recent.iter().map(|r| r.id).collect();
        assert_eq!(
            ids,
            [5, 2, 1, 3, 6],
            "latest first, the hidden aside, five at most"
        );
        let unread: Vec<bool> = view.recent.iter().map(|r| r.unread).collect();
        assert_eq!(
            unread,
            [true, false, true, true, true],
            "a muted one still shows its unread"
        );
        assert!(view.recent[2].primary);
    }

    #[test]
    fn with_its_switches_off_the_tray_and_the_dock_are_as_they_were() {
        let bots = vec![(
            bot(1, BotKind::Primary),
            Seen {
                busy_since: at(1),
                unread: true,
                last_activity_at: at(1),
            },
        )];
        let prefs = Prefs {
            menubar: OnOff::Off,
            ..Prefs::default()
        };
        let view = view_of(&bots, &prefs, 3);
        assert_eq!(
            view,
            TrayView {
                badge: 1,
                ..TrayView::default()
            }
        );
        let prefs = Prefs {
            dock_badge: OnOff::Off,
            ..Prefs::default()
        };
        let view = view_of(&bots, &prefs, 0);
        assert_eq!((view.face, view.count, view.badge), (Some(1), 1, 0));
    }

    #[test]
    fn at_work_since_it_started_and_unread_as_its_state_says() {
        let mut live = live(7);
        live.work = WorkState::Busy;
        live.unread = 2;
        let first = seen_of(&live, Seen::default(), at(10).unwrap());
        assert_eq!(first.busy_since, at(10));
        assert!(first.unread);
        let later = seen_of(&live, first, at(40).unwrap());
        assert_eq!(later.busy_since, at(10), "still the time it started");
        live.work = WorkState::Idle;
        live.unread = 0;
        live.attention = Attention::Unread;
        let rest = seen_of(&live, later, at(50).unwrap());
        assert_eq!(rest.busy_since, None);
        assert!(rest.unread, "marked unread by its state");
    }

    #[test]
    fn a_push_while_the_start_reads_the_roster_is_not_overwritten_by_what_it_read() {
        let bar = MenuBar::default();
        let mut read = live(3);
        read.work = WorkState::Busy;
        read.unread = 1;
        // It finished and was read while the start was still reading.
        bar.saw(&live(3));
        bar.seed(&read);
        assert_eq!(bar.lock().seen[&3], Seen::default(), "the push stands");
        // One nothing was pushed for takes what was read.
        let mut other = read.clone();
        other.bot_id = 4;
        bar.seed(&other);
        let seen = bar.lock().seen[&4];
        assert!(seen.busy_since.is_some() && seen.unread);
    }

    #[test]
    fn an_idle_face_blinks_or_glances_now_and_then() {
        let mut r = rand::rngs::StdRng::seed_from_u64(7);
        let (mut glances, mut doubles) = (0, 0);
        for _ in 0..2000 {
            let (wait, steps) = idle_move(&mut r);
            assert!((2800..=5500).contains(&(wait.as_millis() as u64)));
            match steps.as_slice() {
                [(Frame::Left | Frame::Right | Frame::Up, hold)] => {
                    assert!((500..=900).contains(&(hold.as_millis() as u64)));
                    glances += 1;
                }
                [(Frame::Blink, b)] => assert_eq!(b.as_millis(), 120),
                [(Frame::Blink, _), (Frame::Open, gap), (Frame::Blink, _)] => {
                    assert_eq!(gap.as_millis(), 140);
                    doubles += 1;
                }
                other => panic!("{other:?}"),
            }
        }
        assert!((900..1100).contains(&glances), "half glance: {glances}");
        assert!(
            (90..190).contains(&doubles),
            "a double blink one blink in seven: {doubles}"
        );
    }

    #[test]
    fn a_strip_is_cut_into_its_frames() {
        let mut strip = image::RgbaImage::new(36 * 5, 36);
        for (i, x) in (0..5).map(|i| (i, i * 36 + 3)) {
            strip.put_pixel(x, 3, image::Rgba([i as u8 * 40, 0, 0, 255]));
        }
        let mut png = Vec::new();
        strip
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let frames = frames_of(&png).unwrap();
        assert_eq!(frames.len(), 5);
        for (i, f) in frames.iter().enumerate() {
            assert_eq!((f.width, f.height), (36, 36));
            let px = ((3 * 36 + 3) * 4) as usize;
            assert_eq!(f.data[px], i as u8 * 40, "frame {i} is its own square");
        }
        let mut not_square = Vec::new();
        image::RgbaImage::new(50, 36)
            .write_to(
                &mut std::io::Cursor::new(&mut not_square),
                image::ImageFormat::Png,
            )
            .unwrap();
        assert_eq!(frames_of(&not_square), None);
        assert_eq!(frames_of(b"junk"), None);
        assert_eq!(scaled(&frames[0], 16).data.len(), 16 * 16 * 4);
    }

    #[test]
    fn the_taskbar_number_is_white_on_red_and_nine_plus_past_nine() {
        let one = badge_icon(1);
        let many = badge_icon(12);
        assert_eq!(
            (one.width, one.height, one.data.len()),
            (32, 32, 32 * 32 * 4)
        );
        let px = |img: &Rgba, x: u32, y: u32| {
            let i = ((y * img.width + x) * 4) as usize;
            [
                img.data[i],
                img.data[i + 1],
                img.data[i + 2],
                img.data[i + 3],
            ]
        };
        assert_eq!(px(&one, 0, 0)[3], 0, "outside the disc: clear");
        assert_eq!(px(&one, 6, 16), [0xdc, 0x26, 0x26, 0xff], "the disc");
        let white = |img: &Rgba| {
            img.data
                .chunks(4)
                .filter(|p| p == &[0xff, 0xff, 0xff, 0xff])
                .count()
        };
        // "1": 8 cells of 4 × 4; "9+": 12 + 5 cells of 3 × 3.
        assert_eq!(white(&one), 8 * 16);
        assert_eq!(white(&many), (12 + 5) * 9);
        assert_ne!(badge_icon(9).data, many.data);
        assert_eq!(badge_icon(10).data, many.data);
    }
}
