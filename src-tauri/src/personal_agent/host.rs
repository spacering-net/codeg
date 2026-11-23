//! The engine host: one runtime per assistant, in the one process that runs
//! them (the holder of the work-task engine).
//!
//! - The primary's engine exists from the start (its row may not: it is
//!   looked up). A worker's engine is made at boot for every worker on the
//!   roster, and on demand for one made since — the first time anything
//!   asks for it (`engine_for`).
//! - The host subscribes to the event bus once and hands each event to the
//!   engine whose connection it is about: an assistant's own session or a
//!   conversation it dispatched. The engines run their own loops (the wake
//!   signal and the ticks), so turns of different assistants run at the
//!   same time; within one assistant they are serialized by its engine.
//! - A tool call is answered as the assistant whose current session the
//!   calling connection is (`engine_by_connection`); any other connection's
//!   call is nobody's and is refused.
//! - Only the page that is open sends its assistant's keepalive; every
//!   other assistant's session is left to the idle sweep, and resumed when
//!   the next thing for it arrives.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::sync::broadcast::error::RecvError;
use tokio::sync::Mutex;

use super::engine::PersonalAgentEngine;
use crate::acp::manager::ConnectionManager;
use crate::acp::InternalEventBus;
use crate::db::entities::personal_agent::BotKind;
use crate::db::service::personal_agent_service as svc;
use crate::db::AppDatabase;
use crate::web::event_bridge::EventEmitter;

static HOST: OnceLock<Arc<EngineHost>> = OnceLock::new();

/// The host of this process, when this process runs the assistants. `None`
/// everywhere else: the pages are then read-only.
pub fn host() -> Option<Arc<EngineHost>> {
    HOST.get().cloned()
}

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

/// The process's data directory, said once at startup (desktop and server
/// both) — what [`data_dir_hint`] reads where this process runs no host. A
/// test never says it, so nothing it runs writes under a real data dir.
pub fn pin_data_dir(dir: PathBuf) {
    let _ = DATA_DIR.set(dir);
}

/// The data directory the assistants' own directories are in: this
/// process's host's, else the one pinned at startup. `None` where neither
/// is there (a test).
pub fn data_dir_hint() -> Option<PathBuf> {
    if let Some(host) = host() {
        return Some(host.data_dir.clone());
    }
    DATA_DIR.get().cloned()
}

/// A worker's engine with the task driving it.
struct Running {
    engine: Arc<PersonalAgentEngine>,
    /// `None` until the host runs (engines made before are driven then).
    driver: Option<tokio::task::JoinHandle<()>>,
}

pub struct EngineHost {
    pub(super) db: AppDatabase,
    pub(super) manager: ConnectionManager,
    pub(super) emitter: EventEmitter,
    bus: Arc<InternalEventBus>,
    pub(super) data_dir: PathBuf,
    pub(super) primary: Arc<PersonalAgentEngine>,
    /// Workers' engines by assistant id. Made under this lock, so two asks
    /// for the same assistant get one engine.
    workers: Mutex<HashMap<i32, Running>>,
    /// The host runs: engines are booted and driven as they are made.
    running: AtomicBool,
    /// Itself, handed to each engine it makes.
    pub(super) me: std::sync::Weak<EngineHost>,
    /// The assistants' live states pushed to the pages (`live`).
    pub(super) live: super::live::LiveHub,
    /// What reaches the owner, and when (`reach`, 1.13).
    pub(super) reach: super::reach::Reach,
    /// When codeg's proposal rules look next (`rules`, 6.7).
    pub(super) rules: super::rules::RuleClock,
    /// The morning brief's and the wrap-up's look (`brief`, 6.4, 6.5).
    pub(super) briefs: super::brief::BriefClock,
    /// The nightly tidy-up's look (`tidy`, 7.7).
    pub(super) tidies: super::tidy::TidyClock,
    /// The look for work that went well, to learn a process from (`skills`,
    /// 7.8).
    pub(super) reflects: super::skills::ReflectClock,
    /// One night look at a time.
    pub(super) night_busy: AtomicBool,
    /// The menu bar and the dock (`menubar`, 10.10).
    pub(super) menubar: super::menubar::MenuBar,
    /// The time machine's readers (`history`, 8.2).
    pub(crate) history: super::history::HistoryIndex,
}

/// Build the host and publish it. Call ONLY where the work-task engine was
/// just built: owning that engine is what makes this the one process that
/// drives the assistants (and the tasks they dispatch) on this data dir.
pub fn build(
    db: AppDatabase,
    manager: ConnectionManager,
    emitter: EventEmitter,
    bus: Arc<InternalEventBus>,
    data_dir: PathBuf,
) -> Option<Arc<EngineHost>> {
    // Before anything can record work through it: what was recorded before
    // this moment is a gone process's (B1's start-up repairs).
    super::dispatch::booted_at();
    let host = EngineHost::new(db, manager, emitter, bus, data_dir);
    HOST.set(host.clone()).ok()?;
    Some(host)
}

/// The host's driver: boot recovery for every assistant, each engine's own
/// loop, then one loop over the bus. Spawn once, next to `run_task_engine`.
pub async fn run(host: Arc<EngineHost>) {
    // Subscribed before anything else, so nothing a recovery step triggers is
    // missed.
    let mut rx = host.bus.subscribe();
    // The task engine fails every running task as "interrupted by restart" on
    // boot; a task dispatched before that ran would be failed with them.
    crate::work_task::wait_boot_reconciled(Duration::from_secs(60)).await;
    host.start().await;
    // A busy assistant's state is pushed again now and then, changed or
    // not: a page that stops hearing it lets it go stale (8.3).
    // What waits on the owner too long is told, and what was held for
    // them goes once its time has come (1.13).
    // The board and the sessions are read for what happened in the coding
    // work, and the pull requests delivered are watched (6.9, 7.4).
    host.prune_signals().await;
    let ticker = host.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(super::live::BUSY_REPUSH);
        loop {
            every.tick().await;
            ticker.repush_busy();
            ticker.reach_tick().await;
            ticker.board_tick().await;
            ticker.session_signals().await;
            // codeg's proposal rules (6.7) look, off this loop.
            ticker.spawn_rules_tick();
            // Reminders on a mention whose days are over go (6.8).
            ticker.mention_tick().await;
            // The morning brief and the wrap-up, and the computer kept
            // awake for tonight's work (6.4, 6.5), off this loop.
            ticker.spawn_brief_tick();
            // The nightly tidy-up, and the look back at work that went well
            // (7.7, 7.8), off this loop.
            ticker.spawn_night_tick();
        }
    });
    // The usage figures are caught up while nothing runs (8.1).
    tokio::spawn(host.clone().usage_sync_loop());
    // What the time machine searches is read as it changes (8.2).
    tokio::spawn(host.clone().history_loop());

    loop {
        match rx.recv().await {
            Ok(env) => host.route(&env).await,
            Err(RecvError::Lagged(n)) => {
                tracing::warn!(
                    "[personal_agent] event bus lagged: {n} events dropped; the ticks recover"
                );
                for engine in host.engines().await {
                    engine.on_lagged().await;
                }
            }
            Err(RecvError::Closed) => break,
        }
    }
}

impl EngineHost {
    fn new(
        db: AppDatabase,
        manager: ConnectionManager,
        emitter: EventEmitter,
        bus: Arc<InternalEventBus>,
        data_dir: PathBuf,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| {
            let primary = PersonalAgentEngine::new(
                AppDatabase {
                    conn: db.conn.clone(),
                },
                manager.clone_ref(),
                emitter.clone(),
                data_dir.clone(),
                None,
                me.clone(),
            );
            Self {
                db,
                manager,
                emitter,
                bus,
                data_dir,
                primary,
                workers: Mutex::new(HashMap::new()),
                running: AtomicBool::new(false),
                me: me.clone(),
                live: super::live::LiveHub::new(true),
                reach: super::reach::Reach::default(),
                rules: super::rules::RuleClock::default(),
                briefs: super::brief::BriefClock::default(),
                tidies: super::tidy::TidyClock::default(),
                reflects: super::skills::ReflectClock::default(),
                night_busy: AtomicBool::new(false),
                menubar: super::menubar::MenuBar::default(),
                history: super::history::HistoryIndex::default(),
            }
        })
    }

    /// Every tick: whether a tidy-up is due, and whether work went well
    /// enough to learn from — one look at a time, off the ticker's loop.
    fn spawn_night_tick(self: &Arc<Self>) {
        if self.night_busy.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            let now = super::clock::now();
            me.tidy_tick(now).await;
            me.reflect_tick(now).await;
            me.night_busy.store(false, Ordering::SeqCst);
        });
    }

    /// A host for tests: not published, its engines booted as they are made
    /// (no drivers: tests call the engines directly).
    #[cfg(test)]
    pub(crate) fn new_for_test(db: AppDatabase, data_dir: PathBuf) -> Arc<Self> {
        let bus = Arc::new(InternalEventBus::new(Arc::new(
            crate::acp::EventBusMetrics::default(),
        )));
        let host = Self::new(
            db,
            ConnectionManager::new(),
            EventEmitter::Noop,
            bus,
            data_dir,
        );
        host.running.store(true, Ordering::SeqCst);
        // Tests read the live states themselves.
        host.live.set_enabled(false);
        host
    }

    /// Boot every assistant on the roster and start their loops — those
    /// made before now (a page asked for one while the task engine was
    /// still reconciling) included.
    async fn start(self: &Arc<Self>) {
        // The assistants converted on upgrade or imported: a copy of the
        // primary's brain for each with none, where there is a primary, and
        // a directory for each not made yet (§5, §6.2). One that cannot be
        // made is tried again at the next start, and when it is first
        // needed — where why it cannot is said.
        super::ready::fill_brains(&self.db, &self.emitter).await;
        super::ready::ensure_all_ready(&self.db, &self.data_dir).await;
        self.primary.boot().await;
        self.running.store(true, Ordering::SeqCst);
        tokio::spawn(self.primary.clone().drive());
        let bots = svc::list_bots(&self.db.conn).await.unwrap_or_default();
        for bot in bots.into_iter().filter(|b| b.kind == BotKind::Worker) {
            self.ensure_worker(bot.id).await;
        }
        let waiting: Vec<Arc<PersonalAgentEngine>> = self
            .workers
            .lock()
            .await
            .values()
            .filter(|r| r.driver.is_none())
            .map(|r| r.engine.clone())
            .collect();
        for engine in waiting {
            engine.boot().await;
            let driver = tokio::spawn(engine.clone().drive());
            if let Some(r) = self
                .workers
                .lock()
                .await
                .values_mut()
                .find(|r| Arc::ptr_eq(&r.engine, &engine))
            {
                r.driver = Some(driver);
            } else {
                driver.abort();
            }
        }
        let primary = self.primary.clone();
        tokio::spawn(async move {
            // Getting to know the owner: one from before this version gets
            // what the assistants do on their own (5.4).
            primary.meet_on_start().await;
        });
        // The desktop's tray and dock show the assistants (10.10).
        #[cfg(feature = "tauri-runtime")]
        if let EventEmitter::Tauri(app) = &self.emitter {
            let sink = super::menubar::TraySink::new(app.clone(), self.data_dir.clone());
            self.menubar_start(sink).await;
        }
    }

    /// Whether an assistant's engine owns connection `conn_id`: its own
    /// session, or a conversation it dispatched.
    pub(super) async fn connection_engine(&self, conn_id: &str) -> bool {
        for engine in self.engines().await {
            if engine.owns_connection(conn_id).await {
                return true;
            }
        }
        false
    }

    /// codeg's data directory.
    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    /// Where assistant `bot`'s face is drawn for the system notifications
    /// the desktop posts.
    pub fn avatar_png(&self, bot: i32) -> PathBuf {
        super::reach::avatar_png(&self.data_dir, bot)
    }

    /// Hand one bus event to the engine whose connection it is about: an
    /// assistant's own session or a conversation it dispatched. Nobody's
    /// goes nowhere.
    pub async fn route(self: &Arc<Self>, env: &crate::acp::types::EventEnvelope) {
        let mut owned = false;
        for engine in self.engines().await {
            if engine.owns_connection(&env.connection_id).await {
                owned = true;
                engine.on_event(env).await;
                // Its session or its work moved: its live state may have.
                self.touch(engine.bot().await);
            }
        }
        // A task it handed out runs on a connection no engine routes: its
        // questions and plan approvals go to the assistant that dispatched
        // it (7.3.1).
        if !owned && is_ask_event(&env.payload) {
            if let Some((engine, d)) = self.task_dispatch_of(&env.connection_id).await {
                engine.on_ask_event(&d, env).await;
            }
        }
        if let Some(bot) = self.live.task_conn_owner(&env.connection_id) {
            self.touch(bot);
        }
    }

    /// The dispatch whose kanban task runs on `conn_id`, and the engine of
    /// the assistant that dispatched it.
    pub(super) async fn task_dispatch_of(
        &self,
        conn_id: &str,
    ) -> Option<(
        Arc<PersonalAgentEngine>,
        crate::db::entities::personal_agent_dispatch::Model,
    )> {
        use crate::db::entities::work_task;
        use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
        let task = work_task::Entity::find()
            .filter(work_task::Column::ConnectionId.eq(conn_id))
            .filter(work_task::Column::PersonalAgentDispatchId.is_not_null())
            .filter(work_task::Column::DeletedAt.is_null())
            .order_by_desc(work_task::Column::Id)
            .one(&self.db.conn)
            .await
            .ok()
            .flatten()?;
        let d = svc::get_dispatch(&self.db.conn, task.personal_agent_dispatch_id?)
            .await
            .ok()
            .flatten()?;
        if d.work_task_id != Some(task.id) {
            return None;
        }
        let engine = self.engine_for(d.bot_id).await?;
        Some((engine, d))
    }

    /// The kanban task `task_id` started a round on `conn_id`: when the
    /// task is an assistant's dispatch, its windows learn that the assistant
    /// answers its questions and plan approvals for the owner (7.3.1).
    pub async fn task_connection_opened(&self, conn_id: &str) {
        if let Some((engine, _)) = self.task_dispatch_of(conn_id).await {
            engine.delegate_asks(conn_id).await;
        }
    }

    /// The primary assistant's engine.
    pub fn primary(&self) -> Arc<PersonalAgentEngine> {
        self.primary.clone()
    }

    /// Every engine: the primary's first, then the workers'.
    pub async fn engines(&self) -> Vec<Arc<PersonalAgentEngine>> {
        let mut all = vec![self.primary.clone()];
        let workers = self.workers.lock().await;
        let mut ids: Vec<&i32> = workers.keys().collect();
        ids.sort_unstable();
        all.extend(ids.into_iter().map(|id| workers[id].engine.clone()));
        all
    }

    /// The engine running assistant `bot` (`None`: the primary). A worker's
    /// engine is made the first time it is asked for, when the worker exists
    /// (and is not deleted); a deleted or unknown id has none.
    pub async fn engine_for(&self, bot: Option<i32>) -> Option<Arc<PersonalAgentEngine>> {
        let Some(id) = bot else {
            return Some(self.primary.clone());
        };
        if self.primary.serves(id).await {
            return Some(self.primary.clone());
        }
        if let Some(r) = self.workers.lock().await.get(&id) {
            return Some(r.engine.clone());
        }
        let row = svc::get_bot(&self.db.conn, id).await.ok().flatten()?;
        if row.kind != BotKind::Worker {
            return None;
        }
        Some(self.ensure_worker(id).await)
    }

    /// Worker `id`'s engine when one is running — none is made for asking.
    pub async fn existing_worker(&self, id: i32) -> Option<Arc<PersonalAgentEngine>> {
        self.workers.lock().await.get(&id).map(|r| r.engine.clone())
    }

    /// The engine whose current session `conn_id` is, for a tool call made
    /// on it. Dispatched conversations do not count: their calls are the
    /// executor's, not an assistant's.
    pub async fn engine_by_connection(&self, conn_id: &str) -> Option<Arc<PersonalAgentEngine>> {
        for engine in self.engines().await {
            if engine.is_current_connection(conn_id).await {
                return Some(engine);
            }
        }
        None
    }

    /// The worker `id`'s engine, made (and, when the host runs, booted and
    /// driven) if it is not there yet.
    async fn ensure_worker(&self, id: i32) -> Arc<PersonalAgentEngine> {
        let mut workers = self.workers.lock().await;
        if let Some(r) = workers.get(&id) {
            return r.engine.clone();
        }
        let engine = PersonalAgentEngine::new(
            AppDatabase {
                conn: self.db.conn.clone(),
            },
            self.manager.clone_ref(),
            self.emitter.clone(),
            self.data_dir.clone(),
            Some(id),
            self.me.clone(),
        );
        // Before the host runs, the engine waits unbooted: `start` boots
        // and drives it with the rest. In tests nothing is driven: they
        // call the engines directly.
        let mut driver = None;
        if self.running.load(Ordering::SeqCst) {
            engine.boot().await;
            if !cfg!(test) {
                driver = Some(tokio::spawn(engine.clone().drive()));
            }
        }
        workers.insert(
            id,
            Running {
                engine: engine.clone(),
                driver,
            },
        );
        engine
    }

    /// The worker `id` is gone (deleted): stop its engine. Its dispatched
    /// work is the runtime's and goes on; its records stay, soft-deleted
    /// with it.
    pub async fn retire(&self, id: i32) {
        let removed = self.workers.lock().await.remove(&id);
        if let Some(r) = removed {
            if let Some(d) = r.driver {
                d.abort();
            }
            r.engine.shutdown().await;
        }
    }
}

/// The events about an executor's waits the assistants answer (7.3.1).
fn is_ask_event(payload: &crate::acp::types::AcpEvent) -> bool {
    use crate::acp::types::AcpEvent;
    matches!(
        payload,
        AcpEvent::QuestionRequest { .. }
            | AcpEvent::QuestionResolved { .. }
            | AcpEvent::PlanApprovalRequest { .. }
            | AcpEvent::PlanApprovalResolved { .. }
            | AcpEvent::PermissionRequest { .. }
            | AcpEvent::PermissionResolved { .. }
    )
}
