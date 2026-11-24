//! Harness plugins: an item installed whole with each host's own plugin
//! system, or as its skills only (docs/harness-plugins.md §7 on the
//! website).
//!
//! What is here so far:
//!
//! - [`switches`] — which hosts `/config` lets a plugin be installed into
//!   natively (`plugins.adapters`), held against the versions this Codeg's
//!   own adapters are built for. Anything missing or malformed leaves that
//!   host to skills only.
//! - [`ctx`] — where the store (`~/.codeg/plugins`), the record and the lock
//!   are; the install name every path is built from.
//! - [`record`] — `~/.codeg/harness/plugins.json`: each plugin's revision,
//!   files, consent and how every agent has it.
//! - [`store`] — revision folders `<root>/<name>/<revision>/`: staged,
//!   checked against the listing, renamed into place; removed through the
//!   trash.
//! - [`journal`] — one operation's journal, its commit, rollback and the
//!   startup recovery (never runs a host command).
//! - [`lock`] — the plugins lock, and the order the other locks are taken
//!   in under it.
//! - [`hosts`] — one adapter per host (Claude Code, Codex, OpenCode):
//!   detecting the host the agent's sessions run, and putting a plugin's
//!   revision folder into it, switching it, moving it and taking it out,
//!   through the host's own commands (or files).
//! - [`install`] — the install plan, the install and the uninstall: one
//!   revision for every agent, each agent as a plugin, its skills only or
//!   not at all ([`model`] has what they take and answer).
//! - [`update`] — an installed plugin moved to another revision on every
//!   agent at once, one agent's mode changed, switched off and on, and the
//!   agents an interrupted operation left repaired.
//! - [`guard`] — what runs on its own switched off (`Suspended`) when the
//!   update check's answer says SRN no longer vouches for the installed
//!   revision; never switched on.
//! - [`listing`] — the installed plugins as the installed list shows them
//!   (each host checked read-only), and Codex's hook trust on demand.
//!
//! The commands are `commands::harness_plugins` (and the Web handlers in
//! `web/handlers/harness_plugins.rs`); the startup recovery runs from
//! `skills::startup`, before the skills journals'; a backup restore marks
//! every agent for repair (`mark_restored`). The other kinds' install paths
//! still refuse [`Kind::Plugin`](super::types::Kind::Plugin) as an item of
//! another kind.

pub mod ctx;
// Called by the update check after a check that got an answer.
pub mod guard;
pub mod hosts;
pub mod install;
pub mod journal;
pub mod listing;
pub mod lock;
pub mod model;
pub mod record;
pub mod store;
pub mod switches;
pub mod update;

#[cfg(all(test, unix))]
mod install_tests;
#[cfg(test)]
mod tests;

pub use ctx::{InstallName, PluginsCtx};
pub use switches::{AdapterSwitches, BUILT_IN_MINIMUMS};
